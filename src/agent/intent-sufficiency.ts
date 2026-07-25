import {randomUUID} from 'node:crypto';
import type {
  IntentAssessment,
  PendingInput,
  PendingInputOption,
} from '../types.js';
import type {TurnIntent} from './prompt.js';

export interface IntentAssessmentContext {
  retrievalHits: number;
  complex: boolean;
}

export interface IntentAssessmentResult {
  assessment: IntentAssessment;
  pending?: PendingInput;
  directive: string;
}

export function assessIntentSufficiency(
  request: string,
  intent: TurnIntent,
  context: IntentAssessmentContext,
): IntentAssessmentResult {
  const assessedAt = new Date().toISOString();
  const uiChoice = explicitUiChoice(request);
  if (uiChoice) {
    const pending = clarification(
      request,
      assessedAt,
      'explicit_user_choice_missing',
      isChinese(request)
        ? '这个界面行为需要你的产品偏好，应采用哪一种？'
        : 'This UI behavior depends on your product preference. Which should be used?',
      uiChoice,
    );
    return {
      assessment: assessment('needs_input', 'explicit_user_choice_missing', assessedAt, context.retrievalHits),
      pending,
      directive: 'Pause before mutation and ask the single recorded clarification question.',
    };
  }

  if (publicApiCompatibilityMissing(request)) {
    const chinese = isChinese(request);
    const pending = clarification(
      request,
      assessedAt,
      'public_api_compatibility_missing',
      chinese
        ? '公共 API 的兼容策略尚未指定，应该采用哪一种？'
        : 'The public API compatibility policy is unspecified. Which policy should be used?',
      chinese ? [
        option('backward_compatible', '保持向后兼容', '保留旧接口并提供弃用或迁移路径；改动更稳妥但实现范围较大。', true),
        option('breaking_change', '允许破坏性变更', '直接采用新接口；范围更小，但调用方必须同步迁移。', false),
      ] : [
        option('backward_compatible', 'Preserve compatibility', 'Keep the old API with a deprecation or migration path; safer but broader.', true),
        option('breaking_change', 'Allow breaking change', 'Adopt the new API directly; smaller change but callers must migrate.', false),
      ],
    );
    return {
      assessment: assessment('needs_input', 'public_api_compatibility_missing', assessedAt, context.retrievalHits),
      pending,
      directive: 'Pause before mutation and ask the single recorded clarification question.',
    };
  }

  if (requiresRuntimePermission(request)) {
    return {
      assessment: assessment('permission_required', 'runtime_permission_separate', assessedAt, context.retrievalHits),
      directive: 'The objective is sufficiently clear. Continue, but keep runtime permission approval separate from clarification.',
    };
  }

  if (context.complex && shouldInspectWorkspace(request, intent)) {
    return {
      assessment: assessment('inspect_then_execute', 'workspace_inference_available', assessedAt, context.retrievalHits),
      directive: 'Do not ask the user for repository facts. Inspect the workspace and current evidence before the first mutation.',
    };
  }

  return {
    assessment: assessment('direct_execute', 'simple_explicit_request', assessedAt, context.retrievalHits),
    directive: 'The request is sufficiently clear. Execute without an extra clarification turn.',
  };
}

export function resolvePendingInput(pending: PendingInput, answer: string): {
  answer: string;
  decision: string;
} {
  const normalized = answer.trim();
  const byIndex = /^([1-3])(?:[.)、:]|$)/u.exec(normalized)?.[1];
  const selected = pending.options.find((candidate) =>
    candidate.id.toLocaleLowerCase() === normalized.toLocaleLowerCase() ||
    candidate.label.toLocaleLowerCase() === normalized.toLocaleLowerCase()) ??
    (byIndex ? pending.options[Number(byIndex) - 1] : undefined);
  const decision = selected
    ? `${selected.label}: ${selected.impact}`
    : compact(normalized, 2_000);
  return {answer: compact(normalized, 2_000), decision};
}

function assessment(
  route: IntentAssessment['route'],
  reason: IntentAssessment['reasons'][number],
  assessedAt: string,
  retrievalHits: number,
): IntentAssessment {
  return {version: 1, route, reasons: [reason], assessedAt, retrievalHits};
}

function clarification(
  originalRequest: string,
  createdAt: string,
  reason: PendingInput['reason'],
  question: string,
  options: PendingInputOption[],
): PendingInput {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    createdAt,
    originalRequest: originalRequest.slice(0, 120_000),
    question,
    options,
    reason,
  };
}

function explicitUiChoice(value: string): PendingInputOption[] | undefined {
  const terms = 'modal|dialog|drawer|popover|inline|new page|side panel|弹窗|模态框|抽屉|浮层|内联|页面内|侧边栏|新页面';
  const match = value.match(new RegExp(`\\b(${terms})\\b\\s*(?:or|versus|vs\\.?)\\s*\\b(${terms})\\b`, 'iu')) ??
    value.match(new RegExp(`(${terms})[，、\\s]*(?:还是|或者|或)[，、\\s]*(${terms})`, 'iu'));
  if (!match?.[1] || !match[2] || match[1].toLocaleLowerCase() === match[2].toLocaleLowerCase()) return;
  const chinese = isChinese(value);
  return [
    option('choice_1', compact(match[1], 80), chinese ? '采用请求中列出的第一种交互方式。' : 'Use the first interaction named in the request.', true),
    option('choice_2', compact(match[2], 80), chinese ? '采用请求中列出的第二种交互方式。' : 'Use the second interaction named in the request.', false),
  ];
}

function publicApiCompatibilityMissing(value: string): boolean {
  const api = /\b(?:public|external|exported)\s+(?:api|interface|contract)\b|公共\s*(?:api|接口)|公开\s*(?:api|接口)|对外接口/iu;
  const change = /\b(?:change|replace|remove|rename|migrate|redesign|refactor)\b|修改|替换|删除|移除|重命名|迁移|重构/iu;
  const policy = /\b(?:backward compatible|backwards compatible|breaking change|semver major|deprecat|compatibility shim|migration path)\b|向后兼容|保持兼容|允许破坏|破坏性变更|主版本|弃用|迁移路径/iu;
  return api.test(value) && change.test(value) && !policy.test(value);
}

function requiresRuntimePermission(value: string): boolean {
  return /\b(?:push|publish|deploy|release|delete|drop|reset|force[- ]push|send|upload)\b|推送|发布|部署|删除|清空|重置|发送|上传/iu.test(value);
}

function shouldInspectWorkspace(value: string, intent: TurnIntent): boolean {
  if (intent === 'debug' || intent === 'refactor' || intent === 'review') return true;
  const hasConcreteTarget = /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|`[^`]+`|\b[A-Za-z_$][\w$]*(?:\(\))?\b/u.test(value);
  return !hasConcreteTarget || /\b(?:existing|current|relevant|appropriate|best)\b|现有|当前|相关|合适|最适合|这个|那个/iu.test(value);
}

function option(id: string, label: string, impact: string, recommended: boolean): PendingInputOption {
  return {id, label, impact, recommended};
}

function isChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function compact(value: string, limit: number): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, limit);
}
