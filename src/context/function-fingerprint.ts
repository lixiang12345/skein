import {createHash} from 'node:crypto';
import {extname} from 'node:path';
import type {FunctionFingerprint} from '../types.js';

const SUPPORTED = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MIN_FUNCTION_TOKENS = 40;
const SHINGLE_SIZE = 10;
const WINDOW_SIZE = 6;

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'undefined', 'var', 'while', 'yield',
]);

export interface ExtractedFunction extends FunctionFingerprint {
  normalizedTokens: string[];
}

export interface FunctionFingerprintReport {
  functions: ExtractedFunction[];
  skippedSmallFunctions: number;
}

export function supportsFunctionFingerprintPath(path: string): boolean {
  return SUPPORTED.has(extname(path).toLocaleLowerCase()) && !isNoisePath(path);
}

/** Lightweight deterministic extraction for ordinary TS/JS declarations. */
export function extractFunctionFingerprints(path: string, content: string): ExtractedFunction[] {
  return extractFunctionFingerprintReport(path, content).functions;
}

export function extractFunctionFingerprintReport(path: string, content: string): FunctionFingerprintReport {
  if (!supportsFunctionFingerprintPath(path)) return {functions: [], skippedSmallFunctions: 0};
  const masked = maskCommentsAndStrings(content);
  const lineOffsets = lineStartOffsets(content);
  const declarations = findDeclarations(masked);
  const functions: ExtractedFunction[] = [];
  let skippedSmallFunctions = 0;
  for (const declaration of declarations) {
    const open = declaration.open;
    const close = matchingBrace(masked, open);
    if (close < 0) continue;
    const body = content.slice(open + 1, close);
    const normalizedTokens = normalizeFunctionTokens(body);
    if (normalizedTokens.length < MIN_FUNCTION_TOKENS) {
      skippedSmallFunctions += 1;
      continue;
    }
    const startLine = lineAtOffset(lineOffsets, declaration.start);
    const endLine = lineAtOffset(lineOffsets, close);
    functions.push({
      path,
      symbol: declaration.symbol,
      startLine,
      endLine,
      tokenCount: normalizedTokens.length,
      exactHash: hash(normalizedTokens.join(' ')),
      fingerprints: winnow(normalizedTokens),
      normalizedTokens,
    });
  }
  return {functions, skippedSmallFunctions};
}

export function fingerprintSimilarity(left: FunctionFingerprint, right: FunctionFingerprint): number {
  if (left.exactHash === right.exactHash) return 1;
  const a = new Set(left.fingerprints);
  const b = new Set(right.fingerprints);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function findDeclarations(masked: string): Array<{symbol: string; start: number; open: number}> {
  const output: Array<{symbol: string; start: number; open: number}> = [];
  const classBodies = findClassBodies(masked);
  const patterns: Array<{kind: 'function' | 'arrow' | 'method'; pattern: RegExp}> = [
    {
      kind: 'function',
      pattern: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)(?:\s*<[^>{}\n]+>)?\s*\([^)]*\)\s*(?::\s*[^{}\n=]+)?\s*\{/g,
    },
    {
      kind: 'arrow',
      pattern: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=\n]+)?\s*=\s*(?:async\s*)?(?:<[^>{}\n]+>\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^={}\n]+)?=>\s*\{/g,
    },
    {
      kind: 'method',
      pattern: /(?:^|\n)\s*(?:(?:public|private|protected|static|readonly|abstract|override|get|set|async)\s+)*\*?\s*([A-Za-z_$][\w$]*)(?:\s*<[^>{}\n]+>)?\s*\([^)]*\)\s*(?::\s*[^{}\n=]+)?\s*\{/g,
    },
  ];
  for (const {kind, pattern} of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const symbol = match[1];
      if (!symbol || match.index === undefined) continue;
      if (KEYWORDS.has(symbol) || symbol === 'constructor') continue;
      const start = match.index + match[0].indexOf(symbol);
      if (kind === 'method' && !isDirectClassMember(masked, start, classBodies)) continue;
      output.push({
        symbol,
        start,
        open: match.index + match[0].lastIndexOf('{'),
      });
    }
  }
  return output.sort((left, right) => left.start - right.start);
}

function findClassBodies(masked: string): Array<{open: number; close: number}> {
  const output: Array<{open: number; close: number}> = [];
  const pattern = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class(?:\s+[A-Za-z_$][\w$]*)?[^\n{]*\{/g;
  for (const match of masked.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf('{');
    const close = matchingBrace(masked, open);
    if (close >= 0) output.push({open, close});
  }
  return output.sort((left, right) => (left.close - left.open) - (right.close - right.open));
}

function isDirectClassMember(
  masked: string,
  start: number,
  classBodies: Array<{open: number; close: number}>,
): boolean {
  for (const body of classBodies) {
    if (start <= body.open || start >= body.close) continue;
    let depth = 1;
    for (let index = body.open + 1; index < start; index += 1) {
      if (masked[index] === '{') depth += 1;
      else if (masked[index] === '}') depth -= 1;
    }
    if (depth === 1) return true;
  }
  return false;
}

function normalizeFunctionTokens(content: string): string[] {
  const masked = maskCommentsAndStrings(content, true);
  const raw = masked.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|\?\?|\?\.|[{}()[\].,;:+\-*/%<>=!?&|^~]/g) ?? [];
  return raw.map((token) => {
    if (token === 'LIT') return token;
    if (/^[A-Za-z_$]/.test(token)) return KEYWORDS.has(token) ? token : 'ID';
    if (/^\d/.test(token)) return 'LIT';
    return token;
  });
}

function winnow(tokens: string[]): string[] {
  if (tokens.length < SHINGLE_SIZE) return [];
  const shingles = Array.from({length: tokens.length - SHINGLE_SIZE + 1}, (_, index) =>
    hash(tokens.slice(index, index + SHINGLE_SIZE).join(' ')).slice(0, 16));
  if (shingles.length <= WINDOW_SIZE) return [minimum(shingles)];
  const selected = new Set<string>();
  for (let index = 0; index <= shingles.length - WINDOW_SIZE; index += 1) {
    selected.add(minimum(shingles.slice(index, index + WINDOW_SIZE)));
  }
  return [...selected].sort();
}

function minimum(values: string[]): string {
  return values.reduce((smallest, value) => value < smallest ? value : smallest);
}

function maskCommentsAndStrings(content: string, preserveLiterals = false): string {
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;
  let output = '';
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? '';
    const next = content[index + 1] ?? '';
    if (state === 'code') {
      if (character === '/' && next === '/') { state = 'line'; output += '  '; index += 1; continue; }
      if (character === '/' && next === '*') { state = 'block'; output += '  '; index += 1; continue; }
      if (character === "'") state = 'single';
      else if (character === '"') state = 'double';
      else if (character === '`') state = 'template';
      output += state === 'code' ? character : preserveLiterals ? ' LIT ' : character === '\n' ? '\n' : ' ';
      escaped = false;
      continue;
    }
    if (state === 'line') {
      if (character === '\n') { state = 'code'; output += '\n'; } else output += ' ';
      continue;
    }
    if (state === 'block') {
      if (character === '*' && next === '/') { state = 'code'; output += '  '; index += 1; }
      else output += character === '\n' ? '\n' : ' ';
      continue;
    }
    output += character === '\n' ? '\n' : ' ';
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if ((state === 'single' && character === "'") ||
      (state === 'double' && character === '"') ||
      (state === 'template' && character === '`')) state = 'code';
  }
  return output;
}

function matchingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    else if (masked[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function lineAtOffset(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function isNoisePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLocaleLowerCase();
  return /(^|\/)(test|tests|__tests__|fixtures|fixture|generated|vendor|dist|build)(\/|$)/.test(normalized) ||
    /(?:\.d|\.generated|\.min)\.[cm]?[jt]sx?$/.test(normalized);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
