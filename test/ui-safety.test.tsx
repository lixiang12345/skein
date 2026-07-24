import React from 'react';
import {renderToString} from 'ink';
import {describe, expect, it} from 'vitest';
import {
  ActivityLine,
  CommandPalette,
  ContextInspector,
  Footer,
  Header,
  ListPanel,
  PermissionCard,
  PromptBar,
  TaskRail,
  TeamCockpit,
  TeamWorkbench,
  Timeline,
} from '../src/ui/components.js';
import type {MosaicConfig, ToolCall} from '../src/types.js';

const config: MosaicConfig = {
  model: {provider: 'compatible', model: 'local'},
  workspaceRoots: ['/tmp/workspace'],
  context: {maxTokens: 12_000, topK: 12},
  permissions: {
    read: 'allow', write: 'ask', shell: 'ask', git: 'ask', network: 'ask',
    allowCommands: [], denyCommands: [],
  },
  hooks: {},
  agent: {maxTurns: 24, maxSessionTokens: 250_000, autoVerify: true, verifyCommands: [], checkpointBeforeWrite: true},
  ui: {color: true, compact: false},
};

function untrusted(value: string): string {
  return `\u001B[31m${value}\u001B[0m\u0007\u007F`;
}

describe('terminal display safety', () => {
  it('sanitizes every untrusted single-line surface before width measurement and rendering', () => {
    const call: ToolCall = {
      id: 'permission-call',
      name: untrusted('permission-tool-clean'),
      arguments: {
        command: untrusted('command-clean'),
        cwd: `/tmp/${untrusted('cwd-clean')}`,
      },
    };
    const output = renderToString(
      <>
        <Header
          config={{
            ...config,
            model: {...config.model, model: untrusted('model-clean')},
            workspaceRoots: [`/tmp/${untrusted('repo-clean')}`],
          }}
          askMode={false}
          width={120}
        />
        <Timeline
          width={120}
          items={[
            {id: 'user', kind: 'user', text: untrusted('user-clean')},
            {id: 'tool', kind: 'tool', name: untrusted('tool-clean'), detail: untrusted('detail-clean'), state: 'ok'},
            {id: 'agent', kind: 'agent', profile: untrusted('profile-clean'), task: untrusted('agent-task-clean'), summary: untrusted('agent-summary-clean'), state: 'ok'},
            {id: 'skill', kind: 'skill', name: untrusted('skill-clean'), description: untrusted('skill-description-clean')},
            {id: 'workflow', kind: 'workflow', name: untrusted('workflow-clean'), step: untrusted('workflow-step-clean'), status: 'in_progress'},
            {id: 'theme', kind: 'theme', name: untrusted('timeline-theme-clean')},
          ]}
        />
        <TaskRail tasks={[{id: 'task', title: untrusted('task-title-clean'), status: 'in_progress'}]} width={120} />
        <PermissionCard call={call} category="shell" width={120} />
        <CommandPalette
          width={120}
          title={untrusted('palette-title-clean')}
          hint={untrusted('palette-hint-clean')}
          suggestions={[{value: '/safe', label: untrusted('suggestion-label-clean'), description: untrusted('suggestion-description-clean')}]}
        />
        <ListPanel
          width={120}
          title={untrusted('list-title-clean')}
          entries={[{label: untrusted('list-label-clean'), detail: untrusted('list-detail-clean')}]}
        />
        <ActivityLine activity={{label: untrusted('activity-label-clean'), startedAt: Date.now()}} frame={untrusted('frame-clean')} width={120} />
        <Footer busy tokens={100} maxTokens={1_000} changedFiles={0} frame={untrusted('footer-frame-clean')} themeName={untrusted('footer-theme-clean')} width={120} />
      </>,
      {columns: 120},
    );

    for (const value of [
      'model-clean', 'repo-clean', 'user-clean', 'tool-clean', 'detail-clean',
      'profile-clean', 'agent-task-clean', 'agent-summary-clean', 'skill-clean',
      'task-title-clean', 'permission-tool-clean', 'command-clean', 'cwd-clean',
      'palette-title-clean', 'suggestion-label-clean', 'suggestion-description-clean',
      'list-title-clean', 'list-label-clean', 'list-detail-clean', 'activity-label-clean',
      'frame-clean', 'footer-frame-clean', 'footer-theme-clean',
    ]) {
      expect(output).toContain(value);
    }
    expect(output).not.toMatch(/[\u001B\u0007\u007F]/u);
  });

  it('keeps generated terminal chrome entirely ASCII when the ASCII glyph mode is selected', () => {
    const previous = process.env.SKEIN_GLYPHS;
    process.env.SKEIN_GLYPHS = 'ascii';
    try {
      const output = renderToString(
        <>
          <Header config={config} askMode glyphMode="ascii" width={80} />
          <Timeline glyphMode="ascii" width={80} items={[
            {id: 'context', kind: 'context', engine: 'local', hits: 2, tokens: 1200},
            {id: 'tool', kind: 'tool', name: 'read_file', detail: 'src/app.ts', state: 'ok', output: 'done'},
            {id: 'agent', kind: 'agent', profile: 'reviewer', task: 'inspect output', state: 'running'},
          ]} />
          <ContextInspector
            glyphMode="ascii"
            width={80}
            summary={undefined}
            status={{pressure: 0.25, messageCount: 3, activeTokens: 1200, summaryTokens: 0, toolTokens: 40, compactedMessages: 0}}
            working={{goal: 'verify fallback', focus: 'ASCII only', constraints: ['no unicode chrome'], decisions: [], openQuestions: [], relevantFiles: ['src/app.ts'], lastUpdatedAt: new Date().toISOString()}}
            memory="enabled"
            connections="4 tools"
          />
          <PermissionCard call={{id: 'permission', name: 'shell', arguments: {command: 'npm test'}}} category="shell" glyphMode="ascii" width={80} />
          <PromptBar busy={false} value="" placeholder="Type a request" glyphMode="ascii" width={80}><></></PromptBar>
          <Footer busy tokens={1200} maxTokens={10_000} changedFiles={1} glyphMode="ascii" width={80} themeName="graphite" />
          <TeamCockpit glyphMode="ascii" width={40} items={[
            {id: 'a1', kind: 'agent', profile: 'reviewer', task: 'inspect', state: 'running', phase: 'review', provider: 'openai', model: 'gpt', inputTokens: 100, outputTokens: 50, toolCalls: 2},
            {id: 'm1', kind: 'agent-message', from: 'reviewer', to: 'lead', text: 'handoff ready'},
          ]} />
          <TeamWorkbench glyphMode="ascii" width={80} view="agents" selectedIndex={0} expanded items={[
            {id: 'a1', kind: 'agent', profile: 'reviewer', task: 'inspect', state: 'running', phase: 'review', provider: 'openai', model: 'gpt', inputTokens: 100, outputTokens: 50, toolCalls: 2, summary: 'looks good'},
          ]} tasks={[{id: 't1', title: 'Run tests', status: 'in_progress'}]} run={{id: 'run-1', objective: 'ship it', startedAt: Date.now(), reviewRounds: 1}} notice="review pending" />
        </>,
        {columns: 80},
      );
      expect(output).toMatch(/\* SKEIN/u);
      expect(output).not.toMatch(/[^\x00-\x7F]/u);
    } finally {
      if (previous === undefined) delete process.env.SKEIN_GLYPHS;
      else process.env.SKEIN_GLYPHS = previous;
    }
  });
});
