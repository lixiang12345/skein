import {performance} from 'node:perf_hooks';
import React from 'react';
import {renderToString} from 'ink';
import {
  composerCursorParts,
  composerViewport,
  nextWordBoundary,
  previousWordBoundary,
  splitComposerInput,
} from '../src/ui/composer.js';
import {Timeline, type TimelineItem} from '../src/ui/components.js';
import {displayWidth} from '../src/ui/text.js';
import {updateAssistantDelta} from '../src/ui/timeline-reducers.js';

export interface TerminalUiBenchmarkReport {
  fixtureVersion: 'terminal-ui-benchmark-v1';
  measurement: 'single-process-local-render';
  budgetsMs: {inputP95: number; streamingRenderP95: number};
  input: {samples: number; p50: number; p95: number; max: number};
  streamingRender: {samples: number; p50: number; p95: number; max: number};
  finalFrame: {width: number; widest: number; lines: number; containsFinalChunk: boolean};
}

const INPUT_SAMPLES = 120;
const STREAMING_SAMPLES = 40;
const INPUT_P95_BUDGET_MS = 25;
const STREAMING_P95_BUDGET_MS = 150;

if (process.argv[1]?.endsWith('benchmark-terminal-ui.ts')) {
  process.stdout.write(`${JSON.stringify(runTerminalUiBenchmark(), null, 2)}\n`);
}

export function runTerminalUiBenchmark(): TerminalUiBenchmarkReport {
  const draft = Array.from({length: 10}, (_, index) =>
    `第 ${index + 1} 行 🧪 inspect src/ui/tui.tsx and keep keyboard input responsive`).join('\n');
  for (let index = 0; index < 5; index += 1) runInputSample(draft, index);
  const inputDurations = Array.from({length: INPUT_SAMPLES}, (_, index) => {
    const startedAt = performance.now();
    runInputSample(draft, index);
    return performance.now() - startedAt;
  });

  let timeline: TimelineItem[] = Array.from({length: 36}, (_, index) => ({
    id: `notice-${index}`,
    kind: 'notice' as const,
    tone: index % 7 === 0 ? 'warning' as const : 'info' as const,
    text: `Evidence ${index + 1}: src/module-${index}.ts verified with 中文 and emoji 🧪`,
  }));
  let finalFrame = '';
  for (let index = 0; index < 4; index += 1) {
    timeline = updateAssistantDelta(timeline, 'stream', `warmup ${index}\n`);
    renderTimeline(timeline);
  }
  const streamingDurations = Array.from({length: STREAMING_SAMPLES}, (_, index) => {
    const startedAt = performance.now();
    const final = index === STREAMING_SAMPLES - 1 ? ' FINAL_CHUNK' : '';
    timeline = updateAssistantDelta(
      timeline,
      'stream',
      `chunk ${index + 1}: bounded streaming response with 中文 evidence.${final}\n`,
    );
    finalFrame = renderTimeline(timeline);
    return performance.now() - startedAt;
  });
  const lines = finalFrame.split('\n');
  const widest = Math.max(0, ...lines.map(displayWidth));
  return {
    fixtureVersion: 'terminal-ui-benchmark-v1',
    measurement: 'single-process-local-render',
    budgetsMs: {
      inputP95: INPUT_P95_BUDGET_MS,
      streamingRenderP95: STREAMING_P95_BUDGET_MS,
    },
    input: summarize(inputDurations),
    streamingRender: summarize(streamingDurations),
    finalFrame: {
      width: 80,
      widest,
      lines: lines.length,
      containsFinalChunk: finalFrame.includes('FINAL_CHUNK'),
    },
  };
}

function runInputSample(draft: string, index: number): void {
  const cursor = (index * 17) % Math.max(1, draft.length);
  splitComposerInput(`follow-up ${index}\rnext`);
  composerViewport(draft, cursor, 40 + (index % 3) * 20, 4);
  composerCursorParts(draft, cursor);
  previousWordBoundary(draft, cursor);
  nextWordBoundary(draft, cursor);
}

function renderTimeline(items: TimelineItem[]): string {
  return renderToString(React.createElement(Timeline, {
    items,
    width: 80,
    glyphMode: 'ascii',
    compact: true,
  }), {columns: 80});
}

function summarize(values: number[]): {samples: number; p50: number; p95: number; max: number} {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: round(Math.max(0, ...values)),
  };
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
