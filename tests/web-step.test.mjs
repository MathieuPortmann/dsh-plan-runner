import test from 'node:test';
import assert from 'node:assert/strict';
import { webCheck } from '../lib/runner.js';

const ok = { ok: true, results: [] };
test('a web research step without any web call fails', () => {
  const step = { title: 'Web research on Orchis themes', instructions: 'Find sources.' };
  const c = webCheck(step, { web: 0 }, ok);
  assert.equal(c.ok, false); assert.match(c.results[0].detail, /no web_search or web_read call/);
  assert.equal(webCheck(step, { web: 2 }, ok).ok, true);
  assert.equal(webCheck({ title: 'Write intro', instructions: 'Use notes.md' }, { web: 0 }, ok).ok, true);
});
