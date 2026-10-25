/**
 * Plan runner — read-only shell commands (access "read-shell").
 * A step of a task where "nothing may be modified" may still inspect the system
 * (pacman -Q, lsblk, systemctl status…). Every command of the line must be in the
 * allow list; redirections to files, sudo and command substitution are refused.
 */
const ALLOWED = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'stat', 'file', 'du', 'df', 'free',
  'uname', 'hostname', 'whoami', 'id', 'date', 'uptime', 'lsblk', 'lscpu', 'lspci', 'lsusb',
  'lsmod', 'findmnt', 'mount', 'ps', 'pgrep', 'which', 'whereis', 'type', 'echo', 'printf',
  'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'diff', 'cmp', 'md5sum', 'sha256sum', 'readlink',
  'realpath', 'basename', 'dirname', 'env', 'printenv', 'locale', 'journalctl', 'dmesg',
  'nvidia-smi', 'sensors', 'ip', 'ss', 'pwd', 'true', 'test', 'jq', 'tree', 'column', 'less',
]);
/** Commands allowed only with these sub-commands / options. */
const SUB = {
  pacman: a => /^-(Q|S[si]|F)[a-z]*$/.test(a[0] ?? '') && !/^-S[a-z]*[uy]/.test(a[0]),
  apt: a => ['list', 'show', 'search', 'policy'].includes(a[0]),
  dpkg: a => ['-l', '-L', '-s', '-S', '--list', '--status'].includes(a[0]),
  systemctl: a => ['status', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'show', 'cat'].includes(a.find(x => !x.startsWith('-'))),
  flatpak: a => ['list', 'info'].includes(a[0]),
  git: a => ['status', 'log', 'diff', 'show', 'branch', 'remote'].includes(a[0]),
  sed: a => !a.some(x => /^-[a-z]*i/.test(x) || x === '--in-place'),
  find: a => !a.some(x => ['-delete', '-exec', '-execdir', '-ok', '-fprint'].includes(x)),
  python: a => ['--version', '-V'].includes(a[0]) || (a[0] === '-m' && a[1] === 'pip' && ['list', 'show', 'freeze', '--version'].includes(a[2])),
  pip: a => ['list', 'show', 'freeze', '--version'].includes(a[0]),
  awk: a => !a.some(x => /system\s*\(|>\s*"/.test(x)),
};
SUB.python3 = SUB.python;
SUB.pip3 = SUB.pip;

/** True when every command of the shell line only reads. */
export function isReadOnlyCommand(line) {
  const cmd = String(line ?? '').trim();
  if (!cmd || /`|\$\(|<\(|>\(|(^|[^0-9&])>{1,2}(?!&)|\bsudo\b|\bdoas\b/.test(cmd.replace(/\d?>\s*\/dev\/null|2>&1/g, ''))) return false;
  for (const part of cmd.split(/&&|\|\||[|;\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // LC_ALL=C ls
    if (!words.length) continue;
    const [head, ...args] = words;
    const name = head.split('/').pop();
    if (SUB[name] ? !SUB[name](args) : !ALLOWED.has(name)) return false;
  }
  return true;
}
