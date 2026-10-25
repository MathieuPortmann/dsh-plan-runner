import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../lib/runner.js';
import { newState, makeStep } from '../lib/state.js';

const models = { m: { provider: 'ollama', window: 32768 } };
const mk = (over = {}) => makeStep({ title: 'T', instructions: 'Do the thing well please.', checks: 'exists: x', model: 'm', ...over }, { models, defaultModel: 'm' }).step;

/** Fake world: script[i] = what the n-th child returns; checks pass when `files` holds the path. */
function world({ children = [], health = [], checksOk = () => true } = {}) {
  const calls = [];
  let n = 0;
  const deps = {
    save: () => {},
    snapshot: async () => {},
    health: async () => health.shift() ?? null,
    runChecks: async (cwd, lines, vars) => { const ok = checksOk(calls.length, vars); return { ok, results: lines.map(l => ({ line: l, ok, detail: ok ? 'ok' : 'missing' })) }; },
    resolveItems: (cwd, src) => src,
    validateStep: (args) => makeStep({ ...args, model: 'm' }, { models, defaultModel: 'm' }),
    startChild: async ({ prompt, schema, label, access }) => {
      const r = children[n] ?? { stopReason: 'completed', text: 'Done.\nSummary: ok\nFiles: x\nDecisions: none\nOpen questions: none' };
      n += 1;
      calls.push({ prompt, schema, label, access });
      return { sessionId: `child-${n}`, result: Promise.resolve(r), cancel() {} };
    },
  };
  return { deps, calls };
}

const plan = steps => { const s = newState({ slug: 'p', objective: 'OBJ', cwd: '/w', sessionId: 's' }); s.steps = steps; return s; };

test('runs all steps in fresh children, then done', async () => {
  const st = plan([mk({ title: 'A' }), mk({ title: 'B' })]);
  const w = world();
  await createRunner(st, w.deps).start();
  assert.equal(st.status, 'done');
  assert.deepEqual(st.steps.map(s => s.status), ['ok', 'ok']);
  assert.equal(w.calls.length, 2);
  assert.match(w.calls[1].prompt, /Step 1 \(A\): ok/);
});

test('stop point pauses after the step; start continues', async () => {
  const st = plan([mk({ title: 'A', stop: true }), mk({ title: 'B' })]);
  const w = world();
  const r = createRunner(st, w.deps);
  await r.start();
  assert.equal(st.status, 'paused');
  assert.equal(st.reason, 'stop-point');
  await r.start();
  assert.equal(st.status, 'done');
});

test('failure: one retry with the cause, then a split PROPOSED, nothing applied until accepted', async () => {
  const st = plan([mk({ title: 'A' })]);
  const split = { stopReason: 'completed', structured: { steps: [
    { title: 'A1', instructions: 'Do the first half of it.', checks: ['exists: a1'] },
    { title: 'A2', instructions: 'Do the second half of it.', checks: ['exists: a2'] },
  ] } };
  const w = world({ children: [undefined, undefined, split], checksOk: n => n > 3 });
  const r = createRunner(st, w.deps);
  await r.start();
  assert.match(w.calls[1].prompt, /previous attempt at this step failed/);
  assert.equal(w.calls[2].access, 'read');
  assert.equal(st.status, 'paused');
  assert.equal(st.reason, 'split');
  assert.equal(st.steps.length, 1);
  assert.equal(st.steps[0].split.length, 2);
  assert.ok(st.steps[0].split[1].checks.includes('exists: x')); // original check kept
  assert.equal(st.lessons.length, 1); // same cause twice = one lesson
  await r.acceptSplit();
  assert.deepEqual(st.steps.map(s => s.title), ['A1', 'A2']);
  assert.equal(st.status, 'done');
});

test('refusing the split stops the plan', async () => {
  const st = plan([mk()]);
  const split = { stopReason: 'completed', structured: { steps: [
    { title: 'A1', instructions: 'Do the first half of it.', checks: ['exists: a1'] },
    { title: 'A2', instructions: 'Do the second half of it.', checks: ['exists: a2'] },
  ] } };
  const w = world({ children: [undefined, undefined, split], checksOk: () => false });
  const r = createRunner(st, w.deps);
  await r.start();
  r.refuseSplit();
  assert.equal(st.status, 'stopped');
});

test('Ollama missing pauses without counting an attempt; resume continues', async () => {
  const st = plan([mk()]);
  const w = world({ children: [{ stopReason: 'error', text: 'TRANSPORT' }], health: [null, 'ollama'] });
  const r = createRunner(st, w.deps);
  await r.start();
  assert.equal(st.status, 'paused');
  assert.equal(st.reason, 'ollama');
  assert.equal(st.steps[0].attempts, 0);
  assert.equal(st.steps[0].status, 'todo');
  await r.start();
  assert.equal(st.status, 'done');
});

test('battery before a step pauses before starting it', async () => {
  const st = plan([mk()]);
  const w = world({ health: ['battery'] });
  await createRunner(st, w.deps).start();
  assert.equal(st.reason, 'battery');
  assert.equal(w.calls.length, 0);
});

test('a loop counts as a failure', async () => {
  const st = plan([mk()]);
  const w = world({ children: [{ stopReason: 'aborted', loop: true }] });
  await createRunner(st, w.deps).start();
  assert.match(st.lessons[0], /loop/);
});

test('important step: the reviewer can refuse it', async () => {
  const st = plan([mk({ important: true })]);
  const no = { stopReason: 'completed', text: 'I read it.\nVERDICT: PROBLEMS - section 2 is empty' };
  const w = world({ children: [undefined, no] });
  await createRunner(st, w.deps).start();
  assert.equal(w.calls[1].access, 'read');
  assert.match(st.lessons[0], /reviewer found: section 2 is empty/);
  assert.equal(st.status, 'done'); // the retry passed the review
});

test('for_each: one child per item, failed item retried once, synthetic summary', async () => {
  const st = plan([mk({ instructions: 'Summarise {{item}} into {{out}} now.', for_each: 'a.pdf\nb.pdf', checks: 'exists: {{out}}' }), mk({ title: 'Synthesis' })]);
  let bFails = 1;
  const w = world({ checksOk: (n, vars) => !(vars?.item === 'b.pdf' && bFails-- > 0) });
  await createRunner(st, w.deps).start();
  assert.equal(st.status, 'done');
  assert.deepEqual(st.steps[0].items.map(i => i.status), ['ok', 'ok']);
  assert.equal(w.calls.length, 4); // a, b (fails), b again, synthesis
  assert.match(w.calls[0].prompt, /Write your result to: \.plan-p\/outputs\/1-1\.md/);
  assert.match(w.calls[3].prompt, /Processed 2 items/);
});

test('a child that made no tool call gets one free new try with a nudge', async () => {
  const st = plan([mk({ title: 'A' })]);
  const w = world({ children: [{ stopReason: "completed", text: "I will read the file first.", calls: 1, writes: 0 }], checksOk: n => n > 1 });
  await createRunner(st, w.deps).start();
  assert.equal(st.status, 'done');
  assert.equal(st.steps[0].attempts, 0);
  assert.equal(w.calls.length, 2);
  assert.match(w.calls[1].prompt, /without writing anything/);
});

test('a declared output left from before the step fails it', async () => {
  const st = plan([mk({ title: 'A', outputs: 'x' })]);
  const w = world();
  let stale = 1;
  w.deps.unchanged = (cwd, paths) => (stale-- > 0 ? paths : []);
  await createRunner(st, w.deps).start();
  assert.equal(st.steps[0].attempts, 1);
  assert.match(st.lessons[0], /not written by this step/);
});
