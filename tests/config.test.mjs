import test from 'node:test';
import assert from 'node:assert/strict';
import { withModels, INHERIT, DENY } from '../lib/config.js';

test('no configured model: a single pseudo-model without provider (inherit the conversation model)', () => {
  const cfg = withModels({});
  assert.deepEqual(Object.keys(cfg.models), [INHERIT]);
  assert.equal(cfg.models[INHERIT].provider, null);
  assert.equal(cfg.defaultModel, INHERIT);
});

test('configured models: the first one is the default unless defaultModel names another', () => {
  const models = { a: { provider: 'ollama', window: 32768 }, b: { provider: 'ollama', window: 131072 } };
  assert.equal(withModels({ models }).defaultModel, 'a');
  assert.equal(withModels({ models, defaultModel: 'b' }).defaultModel, 'b');
  assert.equal(withModels({ models, defaultModel: 'missing' }).defaultModel, 'a');
  assert.equal(withModels({ models, splitModel: 'missing' }).splitModel, '');
});

test('access levels: read denies more than write, read-shell only frees the shell', () => {
  assert.ok(DENY.read.includes('write') && DENY.read.includes('bash'));
  assert.ok(!DENY.write.includes('write'));
  assert.ok(!DENY['read-shell'].includes('bash') && DENY['read-shell'].includes('write'));
});
