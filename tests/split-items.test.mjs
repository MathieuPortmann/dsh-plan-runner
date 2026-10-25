import test from 'node:test';
import assert from 'node:assert/strict';
import { expandItemChecks } from '../lib/runner.js';

test('split: {{item}} checks are written out per item, {{out}} dropped', () => {
  const step = { checks: ['contains: {{item}} :: tags::', 'exists: {{out}}', 'exists: Index.md'],
    items: [{ item: 'a.md' }, { item: 'b.md' }] };
  assert.deepEqual(expandItemChecks(step), ['contains: a.md :: tags::', 'contains: b.md :: tags::', 'exists: Index.md']);
});
