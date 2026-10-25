import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand } from '../lib/read-shell.js';

test('read-shell: inspection commands pass', () => {
  for (const c of ['ls -la ~', 'pacman -Qi linux | head -5', 'lsblk -f && df -h', 'systemctl --user status ollama', 'grep -r foo /etc 2>/dev/null', 'LC_ALL=C uname -a', 'pacman -Si firefox', 'git log --oneline'])
    assert.equal(isReadOnlyCommand(c), true, c);
});

test('read-shell: anything that changes the system is refused', () => {
  for (const c of ['rm -rf x', 'sudo pacman -Q', 'pacman -Syu', 'pacman -S foo', 'echo x > /etc/f', 'cat a >> b', 'sed -i s/a/b/ f', 'find . -delete', 'systemctl restart ollama', 'ls; touch x', 'echo $(rm x)', 'git commit -m x', 'cp a b', ''])
    assert.equal(isReadOnlyCommand(c), false, c);
});

test('read-shell: python/pip only for version and package listing', () => {
  for (const c of ['python3 --version 2>&1', 'python -V', 'pip3 list 2>/dev/null || pip list', 'python3 -m pip freeze', 'pip show numpy'])
    assert.equal(isReadOnlyCommand(c), true, c);
  for (const c of ['python3 -c "import os"', 'python3 x.py', 'pip install foo', 'pip3 uninstall foo', 'python -m pip install x'])
    assert.equal(isReadOnlyCommand(c), false, c);
});
