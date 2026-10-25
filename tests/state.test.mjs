import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheck, makeStep, budgetOf, newState, stepMessage, compactSummary, addLesson, MAX_LESSONS, listOf, slugOf } from '../lib/state.js';
import { runChecks, resolveItems, globFiles } from '../lib/checks.js';

const models = { 'qwen3.5-lowtemp:9b': { provider: 'ollama', window: 32768 }, 'qwen3.6-8go:35b-a3b': { provider: 'ollama', window: 131072 } };
const base = { models, defaultModel: 'qwen3.5-lowtemp:9b' };
const good = { title: 'Write intro', instructions: 'Write the introduction of the article in intro.md.', checks: 'exists: intro.md\nwords: intro.md >= 200' };

test('slug and lists', () => {
  assert.equal(slugOf('Réécrire l’article — v2'), 'reecrire-l-article-v2');
  assert.deepEqual(listOf('a.md\n- b.md; c.md'), ['a.md', 'b.md', 'c.md']);
});

test('parseCheck accepts the five kinds and rejects others', () => {
  assert.deepEqual(parseCheck('exists: a.md'), { kind: 'exists', path: 'a.md' });
  assert.deepEqual(parseCheck('contains: a.md :: Hello world'), { kind: 'contains', path: 'a.md', text: 'Hello world' });
  assert.deepEqual(parseCheck('count: notes/*.md >= 3'), { kind: 'count', glob: 'notes/*.md', min: 3 });
  assert.deepEqual(parseCheck('words: a.md >= 200'), { kind: 'words', path: 'a.md', min: 200 });
  assert.deepEqual(parseCheck('command: node --test'), { kind: 'command', command: 'node --test' });
  assert.ok(parseCheck('looks good').error);
  assert.ok(parseCheck('contains: a.md').error);
  assert.ok(parseCheck('magic: x').error);
});

test('makeStep validates', () => {
  assert.ok(makeStep(good, base).step);
  assert.match(makeStep({ ...good, checks: '' }, base).error, /at least one check/);
  assert.match(makeStep({ ...good, model: 'gpt' }, base).error, /unknown model/);
  assert.match(makeStep({ ...good, access: 'root' }, base).error, /access/);
  assert.match(makeStep({ ...good, for_each: 'pdfs/*.pdf' }, base).error, /\{\{item\}\}/);
  const s = makeStep({ ...good, instructions: 'Summarise {{item}} into {{out}}.', for_each: 'pdfs/*.pdf', checks: 'exists: {{out}}' }, base).step;
  assert.deepEqual(s.forEach.source, ['pdfs/*.pdf']);
  assert.equal(s.access, 'read');
});

test('budget refuses a step whose inputs are too big for the 9B', () => {
  const st = newState({ slug: 'x', objective: 'Write an article', cwd: '/tmp', sessionId: 's' });
  const step = makeStep({ ...good, inputs: 'big.txt' }, base).step;
  const opts = { window: 32768, basePrompt: 9000, outputReserve: 3000, unknownFile: 2000, summaryTokens: 300 };
  assert.equal(budgetOf(st, step, { ...opts, fileChars: () => 10_000 }).ok, true);
  const b = budgetOf(st, step, { ...opts, fileChars: () => 60_000 });
  assert.equal(b.ok, false);
  assert.equal(b.limit, 19660);
  assert.equal(budgetOf(st, step, { ...opts, window: 131072, fileChars: () => 60_000 }).ok, true);
});

test('step message: objective and checks at the start and at the end; summaries; lessons; retry cause', () => {
  const st = newState({ slug: 'x', objective: 'OBJECTIVE-123', cwd: '/w', sessionId: 's' });
  st.steps.push({ ...makeStep(good, base).step, status: 'ok', summary: compactSummary({ summary: 'Did A', files: ['a.md'], decisions: ['use APA'], open_questions: [] }) });
  st.steps.push(makeStep({ ...good, title: 'Second' }, base).step);
  addLesson(st, 'Never invent references');
  const m = stepMessage(st, 1, { retryCause: 'checks not met' });
  assert.ok(m.indexOf('OBJECTIVE-123') < 200);
  assert.ok(m.lastIndexOf('OBJECTIVE-123') > m.length - 300);
  assert.ok(m.lastIndexOf('words: intro.md >= 200') > m.length - 100);
  assert.match(m, /Step 1 \(Write intro\): Did A/);
  assert.match(m, /Decisions: use APA/);
  assert.match(m, /Never invent references/);
  assert.match(m, /previous attempt at this step failed: checks not met/);
});

test('lessons are capped and deduplicated', () => {
  const st = newState({ slug: 'x', objective: 'o', cwd: '/w', sessionId: 's' });
  for (let i = 0; i < 15; i++) addLesson(st, `lesson ${i}`);
  addLesson(st, 'lesson 14');
  assert.equal(st.lessons.length, MAX_LESSONS);
  assert.equal(st.lessons.at(-1), 'lesson 14');
});

test('summary fallback when the model gave no report', () => {
  assert.equal(compactSummary(undefined, 'x'.repeat(2000)).summary.length, 600);
});

test('mechanical checks on real files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-runner-'));
  writeFileSync(join(dir, 'a.md'), 'Hello world, this is a test of three plus words.');
  mkdirSync(join(dir, 'notes'));
  for (const n of ['1', '2']) writeFileSync(join(dir, 'notes', `${n}.md`), 'x');
  const r = await runChecks(dir, ['exists: a.md', 'contains: a.md :: HELLO', 'words: a.md >= 5', 'count: notes/*.md >= 2', 'command: test -f a.md'], {});
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const bad = await runChecks(dir, ['exists: missing.md', 'count: notes/*.md >= 3', 'command: exit 3', 'exists: ../../etc/passwd'], {});
  assert.deepEqual(bad.results.map(x => x.ok), [false, false, false, false]);
  assert.match(bad.results[3].detail, /outside/);
  assert.deepEqual(resolveItems(dir, ['notes/*.md', 'extra']), ['notes/1.md', 'notes/2.md', 'extra']);
  assert.equal(globFiles(dir, '**/*.md').length, 3);
  const vars = await runChecks(dir, ['exists: {{out}}'], { out: 'a.md' });
  assert.equal(vars.ok, true);
});

test('checks joined with | are split; an unsplittable joined line is refused; for_each checks must use {{out}}', async () => {
  const { checkLines } = await import('../lib/state.js');
  assert.deepEqual(checkLines('exists: a.md | words: a.md >= 80'), ['exists: a.md', 'words: a.md >= 80']);
  assert.ok(parseCheck('exists: a.md words: b.md').error);
  assert.match(makeStep({ ...good, instructions: 'Summarise {{item}} into {{out}}.', for_each: 'a\nb', checks: 'exists: all.md' }, base).error, /\{\{out\}\}/);
  assert.ok(makeStep({ ...good, instructions: 'Summarise {{item}} into {{out}}.', for_each: 'a\nb', checks: 'exists: {{out}}\nwords: {{out}} >= 40' }, base).step);
});

test('words check refuses a degenerate text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-runner-'));
  writeFileSync(join(dir, 'bad.md'), `Le cacao. ${'mot '.repeat(120)}`);
  writeFileSync(join(dir, 'good.md'), 'Phrase courte. '.repeat(40));
  const r = await runChecks(dir, ['words: bad.md >= 50', 'words: good.md >= 50'], {});
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].detail, /degenerate/);
  assert.equal(r.results[1].ok, true);
});

test('text report and verdict parsing', async () => {
  const { parseReport, parseVerdict } = await import('../lib/state.js');
  const r = parseReport('Bla bla.\n**Summary:** Wrote three files.\nThey are short.\n- Files: a.md, b.md\nDecisions: none\nOpen questions: aucune');
  assert.equal(r.summary, 'Wrote three files. They are short.');
  assert.deepEqual(r.files, ['a.md', 'b.md']);
  assert.deepEqual(r.decisions, []);
  assert.deepEqual(r.open_questions, []);
  assert.equal(parseReport('no labels here'), null);
  assert.deepEqual(parseVerdict('ok\nVERDICT: OK'), { ok: true });
  assert.equal(parseVerdict('VERDICT: PROBLEMS - missing section').problems, 'missing section');
  assert.equal(parseVerdict('looks fine'), null);
});

test('report labels with extra words (French variants)', async () => {
  const { parseReport } = await import('../lib/state.js');
  const r = parseReport("Résumé de l'étape : J'ai écrit la synthèse.\n**Fichiers créés/modifiés:** longtask/synthese.md\n**Décisions:** Aucune");
  assert.equal(r.summary, "J'ai écrit la synthèse.");
  assert.deepEqual(r.files, ['longtask/synthese.md']);
  assert.deepEqual(r.decisions, []);
});

test('budget inputs: globs sum their files, future for_each results count as short', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { inputChars } = await import('../lib/checks.js');
  const d = mkdtempSync(join(tmpdir(), 'pr-'));
  mkdirSync(join(d, 'n'));
  writeFileSync(join(d, 'n', 'a.md'), 'x'.repeat(100));
  writeFileSync(join(d, 'n', 'b.md'), 'x'.repeat(50));
  assert.equal(inputChars(d, 'n/*.md'), 150);
  assert.equal(inputChars(d, 'n/none-*.md'), undefined);
  assert.equal(inputChars(d, '.plan-x/outputs/1-3.md', { itemOutputChars: 700 }), 700);
  assert.equal(inputChars(d, 'later.md'), undefined);
});

test('contains ignores case and spacing', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runCheck } = await import('../lib/checks.js');
  const d = mkdtempSync(join(tmpdir(), 'pr-'));
  writeFileSync(join(d, 'a.md'), 'They make up 87% of the lakes.');
  assert.equal((await runCheck(d, 'contains: a.md :: 87 %', {})).ok, true);
  assert.equal((await runCheck(d, 'contains: a.md :: 88 %', {})).ok, false);
});

test('parseSplit reads a json block, a bare array, or an array passed as a string', async () => {
  const { parseSplit } = await import('../lib/state.js');
  const one = '[{"title":"A","instructions":"x","checks":["exists: a"]},{"title":"B","instructions":"y","checks":["exists: b"]}]';
  assert.equal(parseSplit({ text: 'Here:\n```json\n' + one + '\n```' }).length, 2);
  assert.equal(parseSplit({ text: 'Plan: ' + one }).length, 2);
  assert.equal(parseSplit({ structured: { steps: one } }).length, 2);
  assert.equal(parseSplit({ text: 'no json' }).length, 0);
});
