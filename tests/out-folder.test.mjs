import test from 'node:test';
import assert from 'node:assert/strict';
import { stepPaths, folderRefusal } from '../lib/out-folder.js';

test('stepPaths: outputs and file checks', () => {
  assert.deepEqual(stepPaths({ outputs: 'a.md', checks: 'exists: b.md\ncontains: c.md :: x\nwords: d.md >= 3\ncommand: true\nexists: {{out}}' }), ['a.md', 'b.md', 'c.md', 'd.md']);
});

test('plan_add_step refuses outputs outside the imposed folder', () => {
  const texts = ['Audit the PC and save the report in the folder /home/m/rapports'];
  assert.match(folderRefusal(texts, { outputs: 'report.md', checks: 'exists: report.md' }, '/home/m'), /REFUSED.*\/home\/m\/rapports/);
  assert.equal(folderRefusal(texts, { outputs: 'rapports/r.md', checks: 'exists: /home/m/rapports/r.md' }, '/home/m'), '');
  assert.equal(folderRefusal(['just do it'], { outputs: '/tmp/x' }, '/home/m'), '');
});
