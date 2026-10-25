/**
 * Plan runner: pure helpers (parsing, validation, budgets, the messages sent to the models).
 * No I/O here: file sizes are injected, the texts live in lib/texts.js.
 *
 * State file: <cwd>/.plan-<slug>/state.json
 *   { version, slug, objective, cwd, sessionId, status, reason, current, steps[], lessons[], log[] }
 * A step stays 'todo' until the HARNESS verified it ('ok'): the model never marks a step done.
 *
 * The state is plain JSON that humans and other code also read and edit, so every helper
 * tolerates missing or oddly typed fields instead of throwing, and keeps unknown fields.
 */
import { REPORT_FORMAT, STEP_RULES, AUDIT, SPLIT } from './texts.js';

export { REPORT_FORMAT };

export const STATE_VERSION = 1;
export const ACCESS = ['read', 'read-shell', 'write', 'full'];
export const CHECK_KINDS = ['exists', 'contains', 'count', 'words', 'command'];
export const MAX_LESSONS = 10;
export const CHARS_PER_TOKEN = 3.5;

export const tokensOf = chars => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

// --- small value helpers ---------------------------------------------------------------

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** v[key] when v is an object (or array), else undefined: reads state fields without throwing. */
const field = (v, key) => (v !== null && typeof v === 'object' ? v[key] : undefined);
/** JSON-ish String(v): null stays "null", objects become compact JSON. */
const asText = v => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'null'));
/** Like asText, but a missing value is the empty string. */
const textOf = v => (v === undefined || v === null ? '' : asText(v));
/** Array of strings from an array of anything; anything that is not an array gives []. */
const textsOf = v => (Array.isArray(v) ? v.map(asText) : []);
const bullets = list => list.map(x => `- ${x}`).join('\n');

/** First n UTF-16 units of s, never cutting a surrogate pair in half. */
export function head(s, n) {
  if (s.length <= n) return s;
  let end = n;
  const a = s.charCodeAt(end - 1);
  const b = s.charCodeAt(end);
  if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) end -= 1;
  return s.slice(0, end);
}

/** Last n UTF-16 units of s, never cutting a surrogate pair in half. */
export function tail(s, n) {
  if (s.length <= n) return s;
  let start = s.length - n;
  const a = s.charCodeAt(start - 1);
  const b = s.charCodeAt(start);
  if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) start += 1;
  return s.slice(start);
}

/** Trimmed, and cut to n characters with an ellipsis. */
const clip = (s, n) => { const x = String(s ?? '').trim(); return x.length > n ? `${head(x, n - 1)}…` : x; };

// --- text parsing ----------------------------------------------------------------------

/** Lowercase ASCII words joined by '-', max 40 characters ('plan' when nothing is left). */
export function slugOf(text) {
  const slug = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'plan';
}

/** "a\nb; c" -> ['a', 'b', 'c']; arrays are accepted as they are (trimmed, empty ones dropped). */
export function listOf(value) {
  if (Array.isArray(value)) return value.map(v => asText(v).trim()).filter(Boolean);
  return textOf(value).split(/\n|;/).map(s => s.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
}

/**
 * Check lines: one per line; ';' and ' | ' also separate (small models join them), but a
 * ' | ' only splits when what follows looks like "<kind>:" so a shell pipe stays in place.
 */
export function checkLines(value) {
  const out = [];
  for (const line of listOf(value)) {
    let from = 0;
    const pieces = [];
    for (const m of line.matchAll(/\s+\|\s+/g)) {
      if (/^[a-z]+\s*:/iu.test(line.slice(m.index + m[0].length))) {
        pieces.push(line.slice(from, m.index));
        from = m.index + m[0].length;
      }
    }
    pieces.push(line.slice(from));
    out.push(...pieces.map(p => p.trim()).filter(Boolean));
  }
  return out;
}

/**
 * One check line -> { kind, ... } or { error }.
 *   exists: <path>
 *   contains: <path> :: <text>
 *   count: <glob> >= <n>
 *   words: <path> >= <n>
 *   command: <shell command>        (exit code 0, run in the working folder)
 */
export function parseCheck(line) {
  const text = String(line ?? '');
  const m = /^\s*([a-z]+)\s*:\s*([^\n\r\u2028\u2029]+)$/iu.exec(text);
  if (!m) return { error: `"${text}" is not "<kind>: <value>"` };
  const kind = m[1].toLowerCase();
  const rest = m[2].trim();
  if (kind === 'exists') return /\s[a-z]+\s*:/iu.test(rest) ? { error: `"${rest}" holds several checks: put one check per line` } : { kind, path: rest };
  if (kind === 'command') return { kind, command: rest };
  if (kind === 'contains') {
    const i = rest.indexOf('::');
    if (i < 0) return { error: `contains needs "<path> :: <text>" (got "${rest}")` };
    return { kind, path: rest.slice(0, i).trim(), text: rest.slice(i + 2).trim() };
  }
  if (kind === 'count' || kind === 'words') {
    const c = /^(.+?)\s*>=\s*([0-9]+)$/.exec(rest);
    if (!c) return { error: `${kind} needs "<${kind === 'count' ? 'glob' : 'path'}> >= <number>" (got "${rest}")` };
    return kind === 'count' ? { kind, glob: c[1].trim(), min: Number(c[2]) } : { kind, path: c[1].trim(), min: Number(c[2]) };
  }
  return { error: `unknown check kind "${kind}" (use ${CHECK_KINDS.join(', ')})` };
}

/** Replaces {{item}}, {{out}} and {{index}}; a variable that is not given keeps its placeholder. */
export const fill = (text, vars) => String(text ?? '').replace(/\{\{(item|out|index)\}\}/g, (all, k) => {
  const v = field(vars, k);
  return v === undefined || v === null ? all : asText(v);
});

// --- plan state ------------------------------------------------------------------------

export function newState({ slug, objective, cwd, sessionId }) {
  return {
    version: STATE_VERSION, slug: textOf(slug), objective: String(objective).trim(), cwd: textOf(cwd), sessionId: textOf(sessionId),
    status: 'draft', reason: '', current: 0, steps: [], lessons: [], log: [],
  };
}

/** Index of the next step to run, or -1 when all are ok. */
export function nextIndex(state) {
  const steps = field(state, 'steps');
  return Array.isArray(steps) ? steps.findIndex(s => field(s, 'status') !== 'ok') : -1;
}

/** Adds a lesson (clipped, no duplicate, the newest MAX_LESSONS kept). */
export function addLesson(state, text) {
  const lessons = Array.isArray(state.lessons) ? [...state.lessons] : [];
  const l = clip(text, 220);
  if (l && !lessons.includes(l)) {
    lessons.push(l);
    lessons.splice(0, Math.max(0, lessons.length - MAX_LESSONS));
  }
  state.lessons = lessons;
}

/** Adds a log line "YYYY-MM-DD HH:MM:SS text" (local time); the 200 newest are kept. */
export function log(state, text, now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  const lines = Array.isArray(state.log) ? [...state.log] : [];
  lines.push(`${stamp} ${String(text)}`);
  lines.splice(0, Math.max(0, lines.length - 200));
  state.log = lines;
}

// --- steps -----------------------------------------------------------------------------

/**
 * Validates a step proposed by the planner. Returns { step } or { error }, the error being
 * an English sentence addressed to the model. `models` = { <model id>: { provider, window } }.
 */
export function makeStep(args, { models, defaultModel }) {
  const a = isObject(args) ? args : {};
  const known = isObject(models) ? models : {};
  const title = textOf(a.title).trim();
  const instructions = textOf(a.instructions).trim();
  if (!title) return { error: 'title is empty' };
  if (instructions.length < 20) return { error: 'instructions are too short: say exactly what to do and what to produce' };
  const checks = checkLines(a.checks);
  if (!checks.length) return { error: 'give at least one check (exists:, contains:, count:, words: or command:) so the harness can verify the step' };
  for (const c of checks) { const p = parseCheck(c); if (p.error) return { error: `check ${p.error}` }; }
  const model = textOf(a.model).trim() || defaultModel;
  if (!Object.hasOwn(known, model)) return { error: `unknown model "${model}"; use one of: ${Object.keys(known).join(', ')}` };
  const access = a.access === undefined || a.access === null ? 'read' : textOf(a.access).trim();
  if (!ACCESS.includes(access)) return { error: `access must be ${ACCESS.join(', ')}` };
  const forEachList = listOf(a.for_each);
  const forEach = forEachList.length ? { source: forEachList } : null;
  if (forEach && !instructions.includes('{{item}}')) return { error: 'a for_each step must use {{item}} in its instructions (and write its result to {{out}})' };
  if (forEach && !checks.every(c => /\{\{(item|out)\}\}/.test(c))) return { error: 'the checks of a for_each step run once per item, so each check must use {{out}} (the result file of the current item) or {{item}}, e.g. "exists: {{out}}" and "words: {{out}} >= 40". Check the whole set in a later synthesis step' };
  const flag = v => v === true || v === 'true';
  return {
    step: {
      title, instructions, checks, model, access,
      inputs: listOf(a.inputs), outputs: listOf(a.outputs),
      stop: flag(a.stop), important: flag(a.important),
      forEach, status: 'todo', attempts: 0, budget: null, summary: null, sessions: [], failure: null, items: null, split: null,
    },
  };
}

/**
 * Steps of a split proposal: the structured output, or else the last JSON array of the
 * answer (a ```json block or a bare array). An array given as a string is parsed too.
 */
export function parseSplit(r) {
  const asList = v => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
    if (isObject(v)) {
      if (Array.isArray(v.steps)) v = v.steps;
      else if (typeof v.steps === 'string') return asList(v.steps);
    }
    return Array.isArray(v) ? v.filter(x => x !== null && typeof x === 'object') : [];
  };
  const structured = asList(field(r, 'structured'));
  if (structured.length) return structured;
  const text = textOf(field(r, 'text'));
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const start = text.lastIndexOf('[{');
  if (start >= 0) blocks.push(text.slice(start, text.lastIndexOf(']') + 1));
  for (const b of blocks.reverse()) { const l = asList(b.trim()); if (l.length) return l; }
  return [];
}

export const SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, instructions: { type: 'string' },
          inputs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', items: { type: 'string' } },
          checks: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'instructions', 'checks'],
        additionalProperties: false,
      },
    },
  },
  required: ['steps'],
  additionalProperties: false,
};

// --- budget ----------------------------------------------------------------------------

/** The input files that count in a step's budget: a for_each step counts its fixed inputs and one sample item. */
export function budgetPaths(step) {
  const inputs = textsOf(field(step, 'inputs'));
  const forEach = field(step, 'forEach');
  if (forEach === undefined || forEach === null) return inputs;
  const paths = inputs.filter(p => !p.includes('{{item}}'));
  const sample = field(forEach, 'sampleItem');
  if (sample !== undefined && sample !== null && asText(sample) !== '') paths.push(asText(sample));
  return paths;
}

/**
 * Budget of one step, in tokens: base prompt + message (objective twice, instructions,
 * checks, lessons, earlier summaries) + input files + expected output. A step fits when it
 * stays under 60 % of the model's window. `fileChars(path)` -> number | undefined
 * (undefined: the file does not exist yet).
 */
export function budgetOf(state, step, { window, basePrompt, outputReserve, unknownFile, summaryTokens, fileChars }) {
  const num = (v, fallback) => (typeof v === 'number' ? v : fallback);
  const win = num(window, 32768);
  const steps = field(state, 'steps');
  const done = Array.isArray(steps) ? steps.filter(s => field(s, 'status') === 'ok').length : 0;
  const text = 2 * textOf(field(state, 'objective')).length
    + textOf(field(step, 'instructions')).length
    + textsOf(field(step, 'checks')).join('\n').length
    + textsOf(field(state, 'lessons')).join('\n').length;
  let inputs = 0;
  for (const p of budgetPaths(step)) {
    const c = fileChars(p) ?? null;
    inputs += c === null ? num(unknownFile, 2000) : tokensOf(c);
  }
  const total = num(basePrompt, 9000) + tokensOf(text) + done * num(summaryTokens, 300) + inputs + num(outputReserve, 3000);
  const limit = Math.floor(0.6 * win);
  return { total: Math.trunc(total), limit, ok: total <= limit };
}

// --- reports and verdicts --------------------------------------------------------------

/** Labels of the final text report (English or French), see REPORT_FORMAT. */
const LABELS = [
  ['summary', /^(summary|r[ée]sum[ée])[^:]{0,25}:/iu],
  ['files', /^(files|fichiers)[^:]{0,25}:/iu],
  ['decisions', /^(decisions|d[ée]cisions)[^:]{0,25}:/iu],
  ['open_questions', /^(open questions|questions)[^:]{0,25}:/iu],
];

/** Parses the fixed-format final report of a step's last message; null when absent. */
export function parseReport(text) {
  const out = { summary: '', files: [], decisions: [], open_questions: [] };
  const add = (k, v) => {
    if (k === 'summary') out.summary = out.summary ? `${out.summary} ${v}` : v;
    else out[k].push(...v.split(/,\s*|;\s*/).map(x => x.trim()).filter(x => x && !/^(none|aucune?|rien|n\/a|-)$/iu.test(x)));
  };
  let key = null, found = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/^[\s>*#-]+/, '').replace(/\*\*/g, '').trim();
    const label = LABELS.find(([, re]) => re.test(line));
    if (label) {
      [key] = label;
      found = true;
      const v = line.replace(label[1], '').trim();
      if (v) add(key, v);
      continue;
    }
    if (key && line) add(key, line);
  }
  return found && out.summary ? out : null;
}

/** Reviewer verdict: { ok: true } | { ok: false, problems } | null when absent. */
export function parseVerdict(text) {
  const m = /VERDICT\s*:\s*(OK|PROBLEMS?)\b[\s:-]*([\s\S]*)$/i.exec(String(text ?? ''));
  if (!m) return null;
  return /^ok$/i.test(m[1]) ? { ok: true } : { ok: false, problems: head(m[2].trim(), 600) || 'the reviewer found problems' };
}

/** Short, fixed-format summary kept for the later steps (about 300 tokens at most). */
export function compactSummary(report, fallbackText) {
  if (report && typeof report.summary === 'string') {
    const list = (k, max, n) => textsOf(report[k]).slice(0, max).map(x => clip(x, n));
    return {
      summary: clip(report.summary, 600),
      files: list('files', 12, 120),
      decisions: list('decisions', 6, 160),
      open_questions: list('open_questions', 4, 160),
    };
  }
  const t = String(fallbackText ?? '').trim();
  return { summary: t ? (t.length > 600 ? `…${tail(t, 599)}` : t) : '(no report)', files: [], decisions: [], open_questions: [] };
}

// --- messages sent to the models --------------------------------------------------------

function summaryLines(steps) {
  const lines = [];
  steps.forEach((s, i) => {
    const r = field(s, 'summary');
    if (field(s, 'status') !== 'ok' || r === undefined || r === null) return;
    const files = textsOf(field(r, 'files'));
    const decisions = textsOf(field(r, 'decisions'));
    lines.push([
      `Step ${i + 1} (${textOf(field(s, 'title'))}): ${textOf(field(r, 'summary'))}`,
      files.length ? `  Files: ${files.join(', ')}` : '',
      decisions.length ? `  Decisions: ${decisions.join(' | ')}` : '',
    ].filter(Boolean).join('\n'));
  });
  return lines;
}

/**
 * The only message a step conversation receives. The objective and the checks come
 * first AND again at the end ("lost in the middle" also hits small models).
 * opts: { item, out, retryCause } (strings; anything else is ignored).
 */
export function stepMessage(state, index, opts = {}) {
  const steps = field(state, 'steps');
  if (!Array.isArray(steps) || !Number.isInteger(index) || index < 0 || index >= steps.length) return '';
  const step = steps[index];
  const str = v => (typeof v === 'string' ? v : undefined);
  const item = str(field(opts, 'item'));
  const out = str(field(opts, 'out'));
  const retryCause = str(field(opts, 'retryCause'));
  const vars = { item, out, index: String(index + 1) };
  const objective = textOf(field(state, 'objective'));
  const cwd = textOf(field(state, 'cwd'));
  const checkList = textsOf(field(step, 'checks'));
  const checks = checkList.map(c => `- ${fill(c, vars)}`).join('\n');
  const prev = summaryLines(steps);
  const inputs = textsOf(field(step, 'inputs')).map(p => fill(p, vars));
  const outputs = textsOf(field(step, 'outputs'));
  const lessons = textsOf(field(state, 'lessons'));
  const commands = checkList.map(c => fill(c, vars)).filter(c => c.startsWith('command:'))
    .map(c => c.replace(/^command:\s*/, () => `cd ${cwd} && `));
  const parts = [
    `# Step ${index + 1} of ${steps.length}: ${textOf(field(step, 'title'))}`,
    `Overall objective: ${objective}`,
    `This step is done when the harness verifies:\n${checks}`,
    lessons.length ? `Lessons from earlier failures (follow them):\n${bullets(lessons)}` : '',
    retryCause ? `Your previous attempt at this step failed: ${retryCause}\nDo not repeat what failed.` : '',
    prev.length ? `What earlier steps did (files are the source of truth):\n${prev.join('\n')}` : 'This is the first step.',
    `## Your task\n${fill(textOf(field(step, 'instructions')), vars)}`,
    inputs.length ? `Read only these files (they are in the working folder ${cwd}); open them when you need them:\n${bullets(inputs)}` : `Working folder: ${cwd}`,
    out ? `Write your result to: ${out}` : '',
    outputs.length ? `Expected outputs:\n${bullets(outputs.map(p => fill(p, vars)))}` : '',
    field(step, 'access') === 'full' && commands.length ? `You can run these check commands yourself with the shell tool to test your work, and fix it until they pass:\n${bullets(commands)}` : '',
    STEP_RULES.replaceAll('{report_format}', () => REPORT_FORMAT),
    `Reminder - objective: ${objective}\nReminder - done when:\n${checks}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Prompts of the reviewer (kind 'audit') and of the split proposal ('split'): the
 * paragraphs of lib/texts.js with their {placeholders} filled, one blank line apart.
 */
export function promptOf(kind, state, index, cause) {
  const step = field(field(state, 'steps'), index);
  const objective = textOf(field(state, 'objective'));
  const cwd = textOf(field(state, 'cwd'));
  const title = textOf(field(step, 'title'));
  const instructions = textOf(field(step, 'instructions'));
  // Filled one placeholder after the other, like a chain of replaceAll calls.
  const fillAll = (paragraph, values) => values.reduce((acc, [name, value]) => acc.replaceAll(name, () => value), paragraph);
  if (kind === 'audit') {
    const outputs = textsOf(field(step, 'outputs'));
    return AUDIT
      .filter(l => !(l.includes('{outputs}') && !outputs.length))
      .map(l => fillAll(l, [['{objective}', objective], ['{title}', title], ['{instructions}', instructions], ['{outputs}', outputs.join(', ')], ['{cwd}', cwd]]))
      .join('\n\n');
  }
  if (kind === 'split') {
    const why = cause === undefined || cause === null ? '' : String(cause);
    return SPLIT
      .map(l => fillAll(l, [
        ['{objective}', objective], ['{title}', title], ['{instructions}', instructions],
        ['{checks}', bullets(textsOf(field(step, 'checks')))], ['{cause}', why],
        ['{lessons}', bullets(textsOf(field(state, 'lessons')))], ['{cwd}', cwd],
      ]))
      .join('\n\n');
  }
  throw new Error(`unknown prompt ${kind}`);
}
