/**
 * Plan runner: mechanical checks, run by the harness (never by the model).
 * Every path is resolved inside the working folder; a check that points outside fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseCheck, fill, tail } from './state.js';

export const MAX_RUN = 80;

// --- paths -----------------------------------------------------------------------------
// Plain string handling (no path.resolve / path.join): '..' is resolved lexically, never
// through the file system, and a glob result keeps the exact spelling of the working folder.

/** Components of a path: whether it starts at the root, then the names ('.' and empty ones dropped). */
function split(p) {
  const root = p.startsWith('/');
  const parts = [];
  p.split('/').forEach((s, i) => {
    if (s === '' || (s === '.' && (root || i > 0))) return;
    parts.push(s);
  });
  return { root, parts };
}

/** Lexical normalisation: '.' dropped, '..' removes the previous name (and stops at the root). */
function normalize(p) {
  const { root, parts } = split(p);
  const out = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s !== '.') out.push(s);
  }
  return { root, parts: out };
}

const render = ({ root, parts }) => (root ? '/' : '') + parts.join('/');

/** dir + '/' + name, without normalising anything (an absolute name wins). */
function joinPath(dir, name) {
  if (name.startsWith('/') || dir === '') return name;
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/** True when path `f` starts with the folder `base` (both as returned by split / normalize). */
function startsWith(f, base) {
  const sameRoot = f.root === base.root || (!base.root && base.parts.length === 0);
  return sameRoot && f.parts.length >= base.parts.length && base.parts.every((s, i) => f.parts[i] === s);
}

/** The absolute path of `p` when it is inside `cwd`, else null. */
function inside(cwd, p) {
  const base = normalize(cwd);
  const abs = normalize(p.startsWith('/') ? p : joinPath(render(base), p));
  return startsWith(abs, base) ? render(abs) : null;
}

/**
 * `file` relative to `cwd` when it is below it, else `file` unchanged. The rest of the path
 * keeps its own spelling ("a/./b" stays), only the leading separators and "." are dropped.
 */
function relativeTo(cwd, file) {
  const base = normalize(cwd);
  if (!startsWith(split(file), base)) return file;
  const segs = file.split('/');
  let names = 0, i = 0;
  for (; i < segs.length && names < base.parts.length; i++) {
    if (segs[i] !== '' && !(segs[i] === '.' && (file.startsWith('/') || i > 0))) names++;
  }
  while (i < segs.length && (segs[i] === '' || segs[i] === '.')) i++;
  return segs.slice(i).join('/');
}

// --- glob ------------------------------------------------------------------------------

const segmentRegex = seg => {
  let re = '^';
  for (const c of seg) re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  return new RegExp(`${re}$`, 'u');
};

function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

const isFile = f => { try { return statSync(f).isFile(); } catch { return false; } };

/** Plain code-point order of the paths (the order of their UTF-8 bytes). */
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Minimal glob: '*' and '?' inside one path segment, '**' for any depth (hidden folders are
 * skipped by '**'; links to folders are not followed). Returns the sorted files that match.
 */
export function globFiles(cwd, pattern) {
  const parts = String(pattern).split(/[\\/]/).filter(Boolean);
  const found = new Set();
  const walk = (dir, i) => {
    if (i === parts.length) { found.add(dir); return; }
    const part = parts[i];
    if (part === '**') {
      walk(dir, i + 1);
      for (const e of entries(dir)) if (e.isDirectory() && !e.name.startsWith('.')) walk(joinPath(dir, e.name), i);
      return;
    }
    if (!/[*?]/.test(part)) {
      const next = joinPath(dir, part);
      try { statSync(next); } catch { return; }
      walk(next, i + 1);
      return;
    }
    const re = segmentRegex(part);
    for (const e of entries(dir)) if (re.test(e.name)) walk(joinPath(dir, e.name), i + 1);
  };
  walk(String(pattern).startsWith('/') ? '/' : String(cwd), 0);
  return [...found].filter(isFile).sort(byBytes);
}

// --- checks ----------------------------------------------------------------------------

/** Case and spacing do not matter for contains: "87%" matches "87 %". */
const squash = s => s.toLowerCase().replace(/\s+/g, '');

const words = text => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Longest run of words with no sentence punctuation or line break (a degenerate small-model output). */
function longestRun(text) {
  let best = 0;
  for (const chunk of text.split(/[.!?;:\n]+/)) best = Math.max(best, words(chunk));
  return best;
}

const KEY_LINE = /error|exception|assert|fail|traceback|expected|not found/iu;
const OUTPUT_CAP = 1 << 20; // bytes kept per output stream; the rest is read and dropped

/** Runs `sh -c command` in cwd -> { ok, detail }. Exit code 0 is success; a timeout kills the command. */
function runCommand(cwd, command, timeoutMs) {
  return new Promise(resolve => {
    const chunks = { out: [], err: [] };
    const sizes = { out: 0, err: 0 };
    let timedOut = false, failedToStart = false, settled = false, timer;
    const keep = key => data => {
      const room = OUTPUT_CAP - sizes[key];
      if (room > 0) { chunks[key].push(data.subarray(0, room)); sizes[key] += Math.min(room, data.length); }
    };
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && !timedOut && !failedToStart) return resolve({ ok: true, detail: 'exit 0' });
      // The useful part of a failure: the error lines (tracebacks, assertions), then the last lines.
      const all = Buffer.concat([...chunks.out, ...chunks.err]).toString('utf8');
      const lines = all.trim().split('\n').filter(l => l.trim() && !/^-{10,}$/.test(l.trim()));
      const key = lines.filter(l => KEY_LINE.test(l)).slice(-6);
      const excerpt = tail([...new Set([...key, ...lines.slice(-2)])].join('\n'), 900);
      const shown = timedOut ? 'SIGTERM' : code ?? '?';
      resolve({ ok: false, detail: `exit ${shown}${excerpt ? `: ${excerpt}` : ''}` });
    };
    let child;
    try {
      // Own process group, so that a timeout also stops what the command started.
      child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch { failedToStart = true; finish(null); return; }
    child.stdout.on('data', keep('out'));
    child.stderr.on('data', keep('err'));
    child.on('error', () => { if (child.pid === undefined) { failedToStart = true; finish(null); } });
    child.on('close', code => finish(code));
    timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
  });
}

/** One check -> { line, ok, detail }. */
async function check(cwd, line, vars, commandTimeoutMs) {
  const filled = fill(line, vars);
  const c = parseCheck(filled);
  const res = (ok, detail) => ({ line: filled, ok, detail });
  if (c.error) return res(false, c.error);
  if (c.kind === 'command') {
    const r = await runCommand(cwd, c.command, commandTimeoutMs);
    return res(r.ok, r.detail);
  }
  if (c.kind === 'count') {
    const n = globFiles(cwd, c.glob).filter(f => inside(cwd, f)).length;
    return res(n >= c.min, `${n} file(s)`);
  }
  const abs = inside(cwd, c.path);
  if (!abs) return res(false, 'path is outside the working folder');
  let size;
  try { const st = statSync(abs); size = st.isFile() ? st.size : undefined; } catch { /* missing */ }
  if (size === undefined) return res(false, 'file missing');
  if (c.kind === 'exists') return res(size > 0, size > 0 ? 'present' : 'empty file');
  let text = '';
  try { text = readFileSync(abs).toString('utf8'); } catch { /* unreadable: counts as empty */ }
  if (c.kind === 'contains') {
    const ok = squash(text).includes(squash(c.text));
    return res(ok, ok ? 'found' : 'text not found');
  }
  const n = words(text);
  const run = longestRun(text);
  if (run > MAX_RUN) return res(false, `${n} words, but ${run} words in a row without punctuation: the text looks degenerate`);
  return res(n >= c.min, `${n} words`);
}

/** All the checks of a step -> { ok, results: [{ line, ok, detail }] }. Commands run one after the other. */
export async function runChecks(cwd, lines, vars, { commandTimeoutMs = 120_000 } = {}) {
  const results = [];
  for (const line of lines) results.push(await check(String(cwd), String(line), vars ?? {}, commandTimeoutMs));
  return { ok: results.every(r => r.ok), results };
}

/** One check -> { line, ok, detail }. */
export async function runCheck(cwd, line, vars, opts) {
  return (await runChecks(cwd, [line], vars, opts)).results[0];
}

/** Items of a for_each step: each source line is a glob (if it has * or ?) or a plain path/value. */
export function resolveItems(cwd, sources) {
  const items = [];
  for (const s of sources.map(String)) {
    if (/[*?]/.test(s)) items.push(...globFiles(cwd, s).map(f => relativeTo(String(cwd), f)));
    else items.push(s);
  }
  return [...new Set(items)];
}

/** Size in bytes of a file inside cwd, or undefined (missing, not a file, or outside cwd). */
export function fileChars(cwd, p) {
  const abs = inside(String(cwd), String(p));
  if (!abs) return undefined;
  try { const st = statSync(abs); return st.isFile() ? st.size : undefined; } catch { return undefined; }
}

/**
 * Size estimate of a step input for the budget: a glob counts all the files it matches; a
 * not-yet-written result of a for_each step (in .plan-<slug>/outputs/) counts as a short result.
 */
export function inputChars(cwd, p, { itemOutputChars = 2100 } = {}) {
  if (/[*?]/.test(p)) {
    const files = globFiles(cwd, p);
    return files.length ? files.reduce((a, f) => a + (fileChars(cwd, f) ?? 0), 0) : undefined;
  }
  const c = fileChars(cwd, p);
  if (c === undefined && /(^|\/)\.plan-[^/]+\/outputs\//.test(p)) return itemOutputChars;
  return c;
}
