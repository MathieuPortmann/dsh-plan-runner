import test from 'node:test';
import assert from 'node:assert/strict';

// plan-tools.js imports the dsh runtime; test its regex on a copy of the source.
const src = (await import('node:fs')).readFileSync(new URL('../lib/plan-tools.js', import.meta.url), 'utf8');
const READ_ONLY = eval(/const READ_ONLY = (\/.*\/i);/.exec(src)[1]);

test('read-only wording is recognised', () => {
  for (const t of ['Nothing may be modified on this PC.', 'nothing must be changed', 'Do it read only', 'read-only audit', 'Rien ne doit être modifié', 'lecture seule'])
    assert.ok(READ_ONLY.test(t), t);
  assert.ok(!READ_ONLY.test('Please modify the config'));
});
