import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolAllowed, writeTool } from './assistant-policy.ts';
import { PRESETS } from './ai.ts';
test('assistant permission levels expose only the requested Git operations', () => {
  for (const name of ['status', 'diff', 'log', 'show_file', 'branches']) {
    assert.equal(toolAllowed(name, 'read-only'), true); assert.equal(writeTool(name), false);
  }
  for (const name of ['stage', 'commit', 'create_branch', 'switch_branch', 'stash']) {
    assert.equal(toolAllowed(name, 'read-only'), false); assert.equal(writeTool(name), true);
    assert.equal(toolAllowed(name, 'everything'), true);
  }
  assert.equal(toolAllowed('commit', 'commits'), true);
  assert.equal(toolAllowed('switch_branch', 'commits'), false);
  assert.equal(toolAllowed('shell', 'everything'), false);
});
test('provider presets have usable defaults without duplicate endpoints or commands', () => {
  const requested = ['gemini', 'openai', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'ollama', 'lmstudio'];
  assert.equal(new Set(requested.map(key => PRESETS[key].provider.baseUrl)).size, requested.length);
  for (const key of requested) { assert.ok(PRESETS[key].provider.model); assert.equal(PRESETS[key].provider.apiKey, ''); }
  for (const key of ['claudecode', 'codex', 'geminicli']) assert.equal(PRESETS[key].provider.kind, 'command');
});
