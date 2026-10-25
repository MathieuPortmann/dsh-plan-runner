/**
 * Plan runner — the conductor. Plain code, no model: it runs the steps of one plan,
 * each in a FRESH child conversation, verifies them, and decides what comes next.
 *
 * Failure rule: 1 new attempt with the cause -> a re-split is PROPOSED to the user
 * (nothing changes without their click) -> stop.
 * Pauses: stop points, Ollama missing, laptop on battery, user "Pause", DSH restart.
 *
 * Every dependency is injected so the logic is tested without DSH (tests/runner.test.mjs).
 *   deps.save(state)
 *   deps.startChild({ state, index, prompt, model, access, schema?, label, out?, item? }) -> { sessionId, result: Promise<{ stopReason, structured, text, loop }>, cancel() }
 *     (schema only for the split proposal: small models seldom call structured_output, so steps
 *      and the reviewer answer in a fixed text format instead)
 *   deps.health(model) -> Promise<null | 'ollama' | 'battery'>
 *   deps.runChecks(cwd, lines, vars) -> Promise<{ ok, results[] }>
 *   deps.resolveItems(cwd, sources) -> string[]
 *   deps.snapshot(state, index) -> Promise<void>
 *   deps.unchanged(cwd, paths, sinceMs) -> paths that exist but were not written since sinceMs
 *   deps.validateStep(args, base) -> { step } | { error }
 */
import { fill, stepMessage, compactSummary, parseReport, parseVerdict, addLesson, log, nextIndex, parseSplit, promptOf } from './state.js';
import { NUDGE } from './texts.js';

export const MAX_ATTEMPTS = 2; // first try + one new attempt
// The text sent to a step that wrote nothing lives with the other model texts (lib/texts.js).
export { NUDGE };
/** A child that wrote nothing (it only read and announced its work): one free new try per step or item. */
const idle = (r, holder) => (r.writes ?? r.calls) === 0 && !r.loop && !holder.nudged;

/** Adds a failed result for every declared output left as it was before the child started. */
function stale(deps, cwd, paths, since, checks) {
  const old = (deps.unchanged?.(cwd, paths.filter(p => !p.includes('{{')), since) ?? []);
  if (!old.length) return checks;
  const results = [...checks.results, ...old.map(p => ({ line: `written: ${p}`, ok: false, detail: 'not written by this step (the file is still the one from before)' }))];
  return { ok: false, results };
}

/** A step that asks for web research but made no web_search/web_read call fails. */
export const WEB_STEP = /\bweb[- ](research|search|sources?)\b|\bsearch the web\b|\brecherche (web|sur (le )?(web|internet))\b/i;
export function webCheck(step, r, checks) {
  if (!WEB_STEP.test(`${step.title}\n${step.instructions ?? ''}`) || (r.web ?? 1) > 0) return checks;
  return { ok: false, results: [...checks.results, { line: 'web research', ok: false, detail: 'this step asks for web research but made no web_search or web_read call: search the web, do not answer from memory' }] };
}

const describe = results => results.filter(r => !r.ok).map(r => `${r.line} -> ${r.detail}`).join('; ');

export function createRunner(state, deps) {
  let loop = null;      // promise of the running loop
  let active = null;    // child currently running
  const save = () => deps.save(state);

  function setStatus(status, reason = '') {
    state.status = status;
    state.reason = reason;
    log(state, `${status}${reason ? ` (${reason})` : ''}`);
    save();
  }

  async function healthy(model) {
    const why = await deps.health(model);
    if (why) { setStatus('paused', why); return false; }
    return true;
  }

  async function runChild(index, prompt, { model, access, schema, label, out, item }) {
    const child = await deps.startChild({ state, index, prompt, model, access, schema, label, out, item });
    state.steps[index].sessions.push(child.sessionId);
    save();
    active = child;
    try { return await child.result; } finally { active = null; }
  }

  /** Runs the read-only auditor on an important step; returns null when fine, else the problems. */
  async function audit(index, vars) {
    const step = state.steps[index];
    const prompt = promptOf('audit', state, index);
    const r = await runChild(index, prompt, { model: deps.auditModel?.(step) || step.model, access: 'read', label: `Review ${index + 1}` });
    const v = parseVerdict(r.text);
    if (!v) { log(state, `step ${index + 1}: the reviewer gave no verdict (mechanical checks stand)`); return null; }
    return v.ok ? null : v.problems;
  }

  async function fail(index, cause) {
    const step = state.steps[index];
    step.attempts += 1;
    step.failure = cause;
    addLesson(state, `Step ${index + 1} "${step.title}" failed: ${cause}`);
    log(state, `step ${index + 1} failed (attempt ${step.attempts}): ${cause}`);
    if (step.attempts < MAX_ATTEMPTS) { step.status = 'todo'; save(); return; }
    step.status = 'failed';
    save();
    // Ask for a smaller split, shown to the user before anything changes.
    if (!(await healthy(step.model))) return;
    const prompt = promptOf('split', state, index, cause);
    let r;
    try { r = await runChild(index, prompt, { model: deps.splitModel?.(step) || step.model, access: 'read', label: `Split ${index + 1}` }); }
    catch (e) { r = { stopReason: 'error', text: String(e?.message ?? e) }; }
    const proposed = [];
    for (const s of parseSplit(r)) {
      const v = deps.validateStep({ ...s, model: step.model, access: step.access, important: step.important }, step);
      if (v.step && deps.budget) v.step.budget = deps.budget(state, v.step);
      if (v.step && v.step.budget && !v.step.budget.ok) {
        const bigger = deps.biggerModel?.(state, v.step);
        if (!bigger) { log(state, `split refused: part "${v.step.title}" needs about ${v.step.budget.total} tokens, more than any model allows`); proposed.length = 0; break; }
        Object.assign(v.step, bigger);
        log(state, `split part "${v.step.title}" moved to ${bigger.model} (too big for the first model)`);
      }
      if (v.step) proposed.push(v.step);
    }
    if (proposed.length >= 2) {
      // A split may never weaken the goal: the last part keeps every check of the failed step.
      const last = proposed[proposed.length - 1];
      // A for_each step's checks name {{item}}/{{out}}: a plain part checks every item instead.
      const inherited = last.forEach ? step.checks : expandItemChecks(step);
      last.checks = [...new Set([...last.checks, ...inherited])];
      for (const p of proposed) if (!p.forEach) p.checks = p.checks.filter(c => !/\{\{(item|out)\}\}/.test(c));
      last.outputs = [...new Set([...last.outputs, ...step.outputs])];
      step.split = proposed;
      setStatus('paused', 'split');
    }
    else setStatus('stopped', 'failed');
  }

  async function runItems(index) {
    const step = state.steps[index];
    if (!step.items) {
      step.items = deps.resolveItems(state.cwd, step.forEach.source).map((item, k) => ({
        item, out: `.plan-${state.slug}/outputs/${index + 1}-${k + 1}.md`, status: 'todo', attempts: 0, session: null,
      }));
      save();
    }
    if (!step.items.length) return fail(index, 'for_each found no item');
    for (const it of step.items) if (it.status === 'failed') { it.status = 'todo'; it.attempts = 0; }
    for (const it of step.items) {
      while (it.status === 'todo' && state.status === 'running') {
        if (!(await healthy(step.model))) return 'paused';
        const vars = { item: it.item, out: it.out, index: String(index + 1) };
        const t0 = Date.now();
        const r = await runChild(index, stepMessage(state, index, { item: it.item, out: it.out, retryCause: it.failure }), { model: step.model, access: step.access, out: it.out, item: it.item, label: `${index + 1}.${step.items.indexOf(it) + 1} ${it.item}`.slice(0, 80) });
        it.session = step.sessions.at(-1);
        if (state.status !== 'running') return 'paused';
        const why = r.stopReason === 'error' ? await deps.health(step.model) : null;
        if (why) { setStatus('paused', why); return 'paused'; }
        const declared = step.outputs.length ? step.outputs.map(o => fill(o, vars)) : [it.out];
        const checks = webCheck(step, r, stale(deps, state.cwd, declared, t0, await deps.runChecks(state.cwd, step.checks, vars)));
        if (checks.ok && !r.loop) { it.status = 'ok'; it.failure = null; }
        else if (idle(r, it)) { it.nudged = true; it.failure = NUDGE; log(state, `step ${index + 1}, item ${it.item}: nothing written, new try (not counted)`); }
        else {
          it.attempts += 1;
          it.failure = r.loop ? 'it repeated the same tool call in a loop' : describe(checks.results);
          if (it.attempts >= MAX_ATTEMPTS) it.status = 'failed';
        }
        save();
      }
    }
    const failed = step.items.filter(i => i.status === 'failed');
    if (failed.length) return fail(index, `${failed.length} of ${step.items.length} items failed (${failed.slice(0, 3).map(f => `${f.item}: ${f.failure}`).join(' | ')})`);
    step.status = 'ok';
    step.failure = null;
    step.summary = { summary: `Processed ${step.items.length} items one by one; one result file per item in .plan-${state.slug}/outputs/ (${index + 1}-<n>.md, n = item order).`, files: step.items.map(i => i.out).slice(0, 12), decisions: [], open_questions: [] };
    return 'ok';
  }

  async function runStep(index) {
    const step = state.steps[index];
    if (!(await healthy(step.model))) return;
    step.status = 'running';
    log(state, `step ${index + 1} started (attempt ${step.attempts + 1}, model ${step.model}, access ${step.access})`);
    save();
    await deps.snapshot(state, index);
    if (step.forEach) {
      const r = await runItems(index);
      if (r === 'paused' && step.status === 'running') { step.status = 'todo'; save(); }
      if (r === 'ok') { log(state, `step ${index + 1} verified`); save(); if (step.stop && nextIndex(state) >= 0) setStatus('paused', 'stop-point'); }
      return;
    }
    let r;
    const t0 = Date.now();
    try { r = await runChild(index, stepMessage(state, index, { retryCause: step.failure }), { model: step.model, access: step.access, label: `${index + 1}. ${step.title}`.slice(0, 80) }); }
    catch (e) { r = { stopReason: 'error', text: String(e?.message ?? e), startFailed: true }; }
    if (state.status !== 'running') { step.status = 'todo'; save(); return; } // paused or stopped meanwhile
    if (r.startFailed) { setStatus('paused', `start: ${r.text}`); step.status = 'todo'; save(); return; }
    if (r.stopReason === 'error') {
      const why = await deps.health(step.model);
      if (why) { step.status = 'todo'; setStatus('paused', why); return; } // not the step's fault
    }
    if (r.loop) return fail(index, 'it repeated the same tool call in a loop and was stopped');
    const checks = webCheck(step, r, stale(deps, state.cwd, step.outputs.map(o => fill(o, {})), t0, await deps.runChecks(state.cwd, step.checks, {})));
    if (!checks.ok && idle(r, step)) {
      step.nudged = true; step.failure = NUDGE; step.status = 'todo';
      log(state, `step ${index + 1}: nothing written, new try (not counted)`); save(); return;
    }
    if (!checks.ok) return fail(index, `checks not met: ${describe(checks.results)}${r.stopReason !== 'completed' ? ` (the conversation ended with ${r.stopReason})` : ''}`);
    if (step.important) {
      const problems = await audit(index, {});
      if (state.status !== 'running') { step.status = 'todo'; save(); return; }
      if (problems) return fail(index, `the reviewer found: ${problems}`);
    }
    step.status = 'ok';
    step.failure = null;
    step.summary = compactSummary(parseReport(r.text), r.text);
    log(state, `step ${index + 1} verified`);
    save();
    if (step.stop && nextIndex(state) >= 0) setStatus('paused', 'stop-point');
  }

  async function run() {
    while (state.status === 'running') {
      const i = nextIndex(state);
      if (i < 0) { setStatus('done'); return; }
      state.current = i;
      if (state.steps[i].status === 'failed') { setStatus('stopped', 'failed'); return; }
      await runStep(i);
    }
  }

  function kick() {
    if (loop) return loop;
    loop = run().catch(e => setStatus('paused', `error: ${String(e?.message ?? e)}`)).finally(() => { loop = null; });
    return loop;
  }

  return {
    state,
    get running() { return loop !== null; },
    start() {
      if (state.status === 'running') return kick();
      if (!['draft', 'ready', 'paused'].includes(state.status)) throw new Error(`cannot start a plan that is ${state.status}`);
      if (state.status === 'paused' && state.reason === 'split') throw new Error('accept or refuse the proposed split first');
      setStatus('running');
      return kick();
    },
    pause() {
      if (state.status !== 'running') return;
      setStatus('paused', 'user');
      active?.cancel?.();
    },
    stop() {
      if (['done', 'stopped'].includes(state.status)) return;
      setStatus('stopped', 'user');
      active?.cancel?.();
    },
    acceptSplit() {
      const i = state.steps.findIndex(s => s.split);
      if (i < 0) throw new Error('no split to accept');
      const parts = state.steps[i].split.map(s => ({ ...s, stop: false }));
      parts[parts.length - 1].stop = state.steps[i].stop;
      state.steps.splice(i, 1, ...parts);
      log(state, `step ${i + 1} replaced by ${parts.length} smaller steps (accepted by the user)`);
      setStatus('running');
      return kick();
    },
    refuseSplit() {
      const i = state.steps.findIndex(s => s.split);
      if (i >= 0) state.steps[i].split = null;
      setStatus('stopped', 'failed');
    },
    retryStep() {
      // After a stop on failure, the user may simply try the failed step again.
      const i = state.steps.findIndex(s => s.status === 'failed');
      if (i < 0) throw new Error('no failed step');
      Object.assign(state.steps[i], { status: 'todo', attempts: 0, split: null });
      setStatus('running');
      return kick();
    },
  };
}

// {{item}} checks of a for_each step, written out once per item ({{out}} checks are dropped:
// a plain step has no per-item output file).
export function expandItemChecks(step) {
  const items = (step.items ?? []).map(i => i.item);
  return step.checks.flatMap(c => /\{\{out\}\}/.test(c) ? []
    : /\{\{item\}\}/.test(c) ? items.map(it => c.replaceAll('{{item}}', it)) : [c]);
}
