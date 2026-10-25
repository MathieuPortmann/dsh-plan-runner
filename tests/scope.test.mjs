import test from 'node:test';
import assert from 'node:assert/strict';
import { targetPaths } from '../lib/scope.js';

test('targetPaths: file_path, path, paths', () => {
  assert.deepEqual(targetPaths({ file_path: 'a.md' }), ['a.md']);
  assert.deepEqual(targetPaths({ path: '~/x.docx' }), ['~/x.docx']);
  assert.deepEqual(targetPaths({ paths: ['a', 1, 'b'] }), ['a', 'b']);
  assert.deepEqual(targetPaths({}), []);
});

test('targetPaths: apply_patch names every file', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: /etc/evil\n+z\n*** Delete File: b.txt\n*** Move to: c.txt\n*** End Patch';
  assert.deepEqual(targetPaths({ patch }), ['src/a.js', '/etc/evil', 'b.txt', 'c.txt']);
  assert.deepEqual(targetPaths({ input: '*** Update File: q.md' }), ['q.md']);
});
