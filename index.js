/**
 * DSH plan runner — Host half.
 *
 * Runs an approved plan step by step, each step in a FRESH child conversation
 * started with DSH's native subagent service (ctx.subagents, provider 'spawn'):
 *   - its own model (agentOptions), its own access (toolFilter), a fixed report (outputSchema);
 *   - the conductor (lib/runner.js) verifies each step with mechanical checks, then a
 *     read-only reviewer for important steps; failure -> one retry -> split proposed to the user.
 * Children cannot ask for approval (DSH rejects such calls in a subagent), so a step only
 * does what the plan conversation's permission mode already allows without asking.
 *
 * Browser <-> host: authenticated Connection RPC channel /plan-runner-api (same envelope
 * and Connection.admit protection as dsh-edit-panel).
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { targetPaths } from './lib/scope.js';
import { createRunner } from './lib/runner.js';
import { WORKER_PERSONA as WORKER_PERSONA_TEXT } from './lib/texts.js';
import { makeStep, fill, budgetOf } from './lib/state.js';
import { runChecks, resolveItems, inputChars } from './lib/checks.js';
import { saveState, loadState, plansOf, allPlanFiles, statePath, planDir } from './lib/store.js';
import { withModels, DENY } from './lib/config.js';
import { isReadOnlyCommand } from './lib/read-shell.js';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const dshRequire = createRequire(realpathSync(process.argv[1]));
const { createUserMessage } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-llm')).href);
const PLAN_TOOLS = new Set(['plan_begin', 'plan_add_step', 'plan_show', 'exit_plan_mode', 'enter_plan_mode', 'plan_mode']);

export const name = 'plan-runner';
export const inject = ['agents', 'subagents', 'tools', 'connection', 'webServer'];

const CHANNEL = '/plan-runner-api';

/** Replaces the persona of the parent's preset (e.g. "You are the Plan agent") in every
 * step conversation (text: lib/texts.js). */
export const WORKER_PERSONA = WORKER_PERSONA_TEXT;

const textOf = blocks => (blocks ?? []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n').trim();

/** True when the laptop runs on battery (a Mains supply exists and none is online). */
export function onBattery(root = '/sys/class/power_supply') {
  let mains = 0, online = 0;
  for (const d of (() => { try { return readdirSync(root); } catch { return []; } })()) {
    const read = f => { try { return readFileSync(join(root, d, f), 'utf8').trim(); } catch { return ''; } };
    if (read('type') !== 'Mains') continue;
    mains += 1;
    if (read('online') === '1') online += 1;
  }
  return mains > 0 && online === 0;
}

export function apply(ctx, config = {}) {
  const cfg = withModels(config);
  const runners = new Map(); // state.json path -> runner
  const watched = new Map(); // child session id -> { counts, loop, abort }

  // --- Loop detector: the same tool call with the same arguments N times in a step = loop.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const w = watched.get(exec.agent?.session?.id);
    if (w) {
      let args;
      try { args = JSON.stringify(exec.arguments ?? {}); } catch { args = '?'; }
      w.calls += 1;
      if (['web_search', 'web_read', 'web_fetch', 'web'].includes(exec.name)) w.web += 1;
      if (['write', 'edit', 'bash', 'pwsh'].includes(exec.name)) {
        w.writes += 1;
        // The files changed: re-reading them is not a loop (identical writes still count).
        for (const k of [...w.counts.keys()]) if (!/^(write|edit|bash|pwsh)\u0000/.test(k)) w.counts.delete(k);
      }
      const key = `${exec.name}\u0000${args}`;
      const n = (w.counts.get(key) ?? 0) + 1;
      w.counts.set(key, n);
      if (n >= cfg.loopRepeats && !w.loop) { w.loop = true; ctx.logger?.warn?.(`plan-runner: loop in ${exec.agent.session.id} (${exec.name})`); w.abort(); }
    }
    return next();
  });

  // --- Scope guard: a step may only write the files the plan gave it (and its own outputs folder).
  // Every tool of the "write" group is checked, not only write/edit (editing and patch tools
  // could otherwise write outside the plan). A step with no declared output stays inside its folder.
  const WRITE_TOOLS = new Set(DENY.read.filter(n => !DENY.write.includes(n)));
  ctx.effect(() => ctx.tools.guard(execution => {
    const w = watched.get(execution.agent?.session?.id);
    if (!w?.writes_ok || !WRITE_TOOLS.has(execution.name)) return undefined;
    let args = execution.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const paths = targetPaths(args);
    for (const p of paths) {
      const abs = resolve(w.cwd, p.replace(/^~(?=\/|$)/, homedir()));
      if (w.allowed ? w.allowed.has(abs) : abs.startsWith(w.cwd + '/')) continue;
      if (w.allowedDirs.some(d => abs.startsWith(d))) continue;
      return w.allowed
        ? `Refused by the plan: this step may only write ${[...w.allowed].map(a => relative(w.cwd, a)).join(', ') || 'its result file'}. ${relative(w.cwd, abs)} belongs to another step: do not write it.`
        : `Refused by the plan: this step may only write inside ${w.cwd}. ${abs} is outside: do not write it.`;
    }
    return undefined;
  }), 'plan-runner: scope guard');

  // --- read-shell steps: bash only for read-only commands (lib/read-shell.js).
  ctx.effect(() => ctx.tools.guard(execution => {
    const w = watched.get(execution.agent?.session?.id);
    if (!w?.readShell || !['bash', 'pwsh'].includes(execution.name)) return undefined;
    let args = execution.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const cmd = args?.command ?? args?.cmd ?? '';
    return isReadOnlyCommand(cmd) ? undefined
      : `Refused by the plan: this step is read-only, so only read-only commands may run (ls, cat, grep, pacman -Q, lsblk, systemctl status…). "${String(cmd).slice(0, 120)}" could change the system: do not run it.`;
  }), 'plan-runner: read-shell guard');

  // --- Plan mode is plan only (a capable model otherwise skips the plan and runs the task).
  // In a Plan-preset conversation (not its step conversations, watched above) nothing that changes
  // files or starts other agents runs, bash runs only read-only commands, and a turn that ends
  // without exit_plan_mode or a question gets one reminder.
  const isPlanAgent = agent => {
    if (!agent || watched.has(agent.session?.id)) return false;
    try { return agent.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx) === 'plan'; } catch { return false; }
  };
  const PLAN_BLOCKED = new Set(DENY.read.filter(n => !['bash', 'pwsh', 'create_goal', 'update_goal'].includes(n) && !PLAN_TOOLS.has(n)));
  const planTurn = new Map(); // Plan session id -> { closed, nudged } for the current turn
  ctx.effect(() => ctx.tools.guard(execution => {
    if (!isPlanAgent(execution.agent)) return undefined;
    const t = planTurn.get(execution.agent.session.id) ?? { closed: false, nudged: false };
    planTurn.set(execution.agent.session.id, t);
    if (['exit_plan_mode', 'ask_user_question'].includes(execution.name)) t.closed = true;
    if (PLAN_BLOCKED.has(execution.name)) return `Refused in Plan mode: you only plan here, ${execution.name} would change something. Record the work as plan steps (plan_begin, plan_add_step) and finish with exit_plan_mode; the steps run after the user approves.`;
    if (!['bash', 'pwsh'].includes(execution.name)) return undefined;
    let args = execution.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const cmd = args?.command ?? args?.cmd ?? '';
    return isReadOnlyCommand(cmd) ? undefined
      : `Refused in Plan mode: only read-only commands may run while planning (ls, cat, grep, pacman -Q, lsblk, systemctl status…). "${String(cmd).slice(0, 120)}" could change the system: put it in a plan step instead.`;
  }), 'plan-runner: plan mode guard');

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!isPlanAgent(agent)) return;
    const t = planTurn.get(agent.session.id) ?? { closed: false, nudged: false };
    if (t.closed || t.nudged) { planTurn.delete(agent.session.id); return; }
    t.nudged = true;
    planTurn.set(agent.session.id, t);
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'Plan mode: this turn ends without a plan. Do not do the task yourself. Call plan_begin, then plan_add_step once per step, then exit_plan_mode with the plan. If a choice belongs to the user, ask it with ask_user_question instead.' }],
      source: { kind: 'plan-runner', form: 'notice', summary: 'plan mode: plan required' },
    }));
  });

  async function health(model) {
    if (cfg.pauseOnBattery && onBattery()) return 'battery';
    if (cfg.models[model]?.provider === 'ollama') {
      try {
        const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return 'ollama';
      } catch { return 'ollama'; }
    }
    return null;
  }

  async function startChild({ state, index, prompt, model, access, schema, label, out, item }) {
    const parent = ctx.agents.get(state.sessionId);
    if (!parent) throw new Error('parent-closed');
    const m = cfg.models[model];
    if (!m) throw new Error(`unknown model ${model}`);
    // The step is created under the parent's preset. The whole deny list is passed; names dsh
    // refuses as unknown global tools (scope-local ones such as the native `subagent` tool since
    // dsh 0.2.0-rc.2, or tools of a plugin that is off) are dropped and the start is retried.
    // Never pre-filter with ctx.tools.get(): its scope is not the child's, so it emptied the list
    // and read-only steps could write.
    let deny = [...(DENY[access] ?? DENY.read)];
    if (out) { try { unlinkSync(resolve(state.cwd, out)); } catch { /* none yet */ } } // plan-owned result of an earlier try
    const ac = new AbortController();
    let run;
    for (let tries = 0; ; tries++) {
      try {
        run = await ctx.subagents.start('spawn', {
          label, parent, signal: ac.signal,
          prompt: [{ type: 'text', text: prompt }],
          // No provider = the pseudo-model "default": inherit the plan conversation's model.
          ...(m.provider ? { agentOptions: { provider: m.provider, model } } : {}),
          ...(schema ? { outputSchema: schema } : {}),
          persona: WORKER_PERSONA,
          ...(deny.length ? { toolFilter: { deny } } : {}),
        });
        break;
      } catch (e) {
        const msg = String(e?.message ?? e);
        const bad = /unknown global tools? (.*?); known/.exec(msg)?.[1]?.match(/"([^"]+)"/g)?.map(x => x.slice(1, -1));
        if (!bad?.length || tries > 2) throw e;
        deny = deny.filter(n => !bad.includes(n));
      }
    }
    const step = state.steps[index];
    // A for_each item may write its result file and the outputs declared with {{item}} (in-place edits).
    const outputs = [...(out ? [out] : []), ...(step?.outputs ?? [])].map(o => fill(o, { out, item })).filter(o => !o.includes('{{'));
    const w = {
      counts: new Map(), calls: 0, writes: 0, web: 0, loop: false, abort: () => ac.abort(), cwd: state.cwd,
      // No declared output (or the reviewer/split, read only): no scope limit beyond the access level.
      writes_ok: !access.startsWith('read'), readShell: access === 'read-shell',
      allowed: !access.startsWith('read') && outputs.length ? new Set(outputs.map(o => resolve(state.cwd, o))) : null,
      allowedDirs: [join(planDir(state.cwd, state.slug), 'outputs') + '/'],
    };
    watched.set(run.id, w);
    const result = run.result
      .then(r => ({ stopReason: r.stopReason, structured: r.structured, text: [textOf(r.output), r.diagnostic].filter(Boolean).join('\n'), loop: w.loop, calls: w.calls, writes: w.writes, web: w.web }))
      .catch(e => ({ stopReason: 'error', text: String(e?.message ?? e), loop: w.loop }))
      .finally(() => { watched.delete(run.id); run.dispose().catch(() => {}); });
    return { sessionId: run.id, result, cancel: () => ac.abort() };
  }

  /** Copy the step's existing output files before it runs (undo by hand if needed). */
  async function snapshot(state, index) {
    const step = state.steps[index];
    const dest = join(planDir(state.cwd, state.slug), 'backups', `step-${index + 1}-try-${step.attempts + 1}`);
    // Outputs written in place by a for_each step ({{item}}) are copied for every item.
    const items = step.forEach ? resolveItems(state.cwd, step.forEach.source) : [];
    const paths = step.outputs.flatMap(o => o.includes('{{item}}') ? items.map(item => fill(o, { item })) : [fill(o, {})]);
    const inputs = new Set(step.inputs.map(i => fill(i, {})));
    state.preexisting ??= {};
    for (const p of paths) {
      if (p.includes('{{')) continue;
      const abs = isAbsolute(p) ? p : resolve(state.cwd, p);
      if (!(p in state.preexisting)) state.preexisting[p] = existsSync(abs); // seen for the first time: the user's file or not
      const rel = relative(state.cwd, abs);
      if (rel.startsWith('..') || !existsSync(abs) || !statSync(abs).isFile()) continue;
      try { mkdirSync(dirname(join(dest, rel)), { recursive: true }); copyFileSync(abs, join(dest, rel)); } catch { continue; /* not backed up: keep it */ }
      // A file this plan made (not the user's, not read by this step) is removed after its backup, so the
      // new attempt can create it again: DSH asks approval to overwrite a file, and a step cannot ask.
      const keptByDoneStep = state.steps.some(s => s.status === 'ok' && s.outputs.some(o => fill(o, {}) === p));
      if (!step.forEach && state.preexisting?.[p] === false && !inputs.has(p) && !keptByDoneStep) { try { unlinkSync(abs); } catch { /* keep */ } }
    }
  }

  const deps = {
    save: saveState, health, startChild, snapshot,
    unchanged: (cwd, paths, since) => paths.filter(p => { try { return statSync(resolve(cwd, p)).mtimeMs < since - 1000; } catch { return false; } }),
    runChecks: (cwd, lines, vars) => runChecks(cwd, lines, vars, { commandTimeoutMs: cfg.commandTimeoutMs }),
    resolveItems,
    validateStep: (args, base) => makeStep({ ...args, model: base.model, access: base.access }, cfg),
    splitModel: () => cfg.splitModel,
    biggerModel: (state, step) => {
      for (const [model, m] of Object.entries(cfg.models).filter(([, m]) => m.provider === 'ollama').sort((a, b) => a[1].window - b[1].window)) {
        const budget = deps.budget(state, { ...step, model });
        if (budget.ok) return { model, budget };
      }
      return null;
    },
    budget: (state, step) => budgetOf(state, step, { window: cfg.models[step.model]?.window ?? cfg.defaultWindow, basePrompt: cfg.basePromptTokens, outputReserve: cfg.outputReserve, unknownFile: cfg.unknownFileTokens, summaryTokens: cfg.summaryTokens, fileChars: p => inputChars(state.cwd, p, { itemOutputChars: Math.round(cfg.itemOutputTokens * 3.5) }) }),
    auditModel: () => cfg.auditModel,
  };

  function runnerOf(file) {
    let r = runners.get(file);
    if (!r) {
      const st = loadState(file);
      if (!st) throw new Error('plan not found');
      r = createRunner(st, deps);
      runners.set(file, r);
    }
    return r;
  }

  // A plan that was running when DSH stopped is paused: the user resumes it.
  for (const f of allPlanFiles()) {
    const st = loadState(f);
    if (st?.status !== 'running') continue;
    st.status = 'paused';
    st.reason = 'restart';
    for (const s of st.steps) if (s.status === 'running') s.status = 'todo';
    saveState(st);
  }

  const view = st => ({
    slug: st.slug, objective: st.objective, cwd: st.cwd, status: st.status, reason: st.reason, current: st.current,
    lessons: st.lessons, log: st.log.slice(-25),
    steps: st.steps.map(s => ({
      title: s.title, status: s.status, model: s.model, access: s.access, stop: s.stop, important: s.important,
      attempts: s.attempts, failure: s.failure, sessions: s.sessions, budget: s.budget, checks: s.checks,
      summary: s.summary?.summary ?? null,
      items: s.items ? { total: s.items.length, ok: s.items.filter(i => i.status === 'ok').length, failed: s.items.filter(i => i.status === 'failed').length } : (s.forEach ? { total: s.forEach.count ?? 0, ok: 0, failed: 0 } : null),
      split: s.split ? s.split.map(x => ({ title: x.title, instructions: x.instructions, checks: x.checks })) : null,
    })),
  });

  const fileOf = (sessionId, slug) => {
    const st = plansOf(String(sessionId ?? '')).find(s => s.slug === slug);
    if (!st) throw new Error('plan not found');
    return statePath(st.cwd, st.slug);
  };
  const live = file => runners.get(file)?.state ?? loadState(file);

  const handlers = {
    list: ({ sessionId }) => plansOf(String(sessionId ?? '')).map(st => view(live(statePath(st.cwd, st.slug)) ?? st)),
    action: async ({ sessionId, slug, action, fromReview }) => {
      const file = slug ? fileOf(sessionId, slug) : (() => {
        const st = plansOf(String(sessionId ?? '')).filter(s => s.status === 'ready').at(-1);
        if (!st) throw new Error('no plan split into steps in this conversation (plan_add_step was not used)');
        return statePath(st.cwd, st.slug);
      })();
      const r = runnerOf(file);
      const parent = ctx.agents.get(r.state.sessionId);
      if (['start', 'acceptSplit', 'retryStep'].includes(action) && !parent) throw new Error('parent-closed');
      // From the plan review card: end the Plan agent's wait (it stays in plan mode and
      // does nothing itself), then the steps run in their own conversations.
      if (fromReview && parent?.status === 'running') {
        parent.cancel({ kind: 'hook', reason: 'The user runs this plan step by step in separate conversations.' });
        for (let i = 0; i < 100 && parent.status === 'running'; i++) await new Promise(res => setTimeout(res, 100));
      }
      if (action === 'start') { r.start(); }
      else if (action === 'pause') r.pause();
      else if (action === 'stop') r.stop();
      else if (action === 'acceptSplit') { r.acceptSplit(); }
      else if (action === 'refuseSplit') r.refuseSplit();
      else if (action === 'retryStep') { r.retryStep(); }
      else throw new Error(`unknown action ${action}`);
      return view(r.state);
    },
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: CHANNEL,
    handler: async (req, res) => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const admission = ctx.connection.admit(req);
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
      const endpoint = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1));
      if (req.method !== 'POST' || !endpoint) { res.writeHead(404); res.end('not found'); return; }
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') { res.writeHead(415); res.end('content type must be application/json'); return; }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1 << 20) { res.writeHead(413); res.end('too large'); return; } }
      let msg;
      try { msg = JSON.parse(raw); } catch { res.writeHead(400); res.end('body is not JSON'); return; }
      const rpcId = typeof msg?.rpcId === 'string' ? msg.rpcId : '';
      if (msg?.method !== endpoint) return send(200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: {} } } });
      const h = handlers[endpoint];
      if (!h) return send(200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'not-found', message: `unknown endpoint ${endpoint}`, details: {} } } });
      try { send(200, { type: 'server-response', rpcId, result: { ok: true, value: await h(msg.payload ?? {}) } }); }
      catch (e) { send(200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'failed', message: String(e?.message ?? e), details: {} } } }); }
    },
  }), 'plan-runner: channel');

  // Stop every running conductor when the plugin unloads (hot reload, shutdown): the plan pauses.
  ctx.effect(() => () => {
    for (const r of runners.values()) if (r.state.status === 'running') { r.state.status = 'paused'; r.state.reason = 'restart'; for (const s of r.state.steps) if (s.status === 'running') s.status = 'todo'; saveState(r.state); }
    for (const w of watched.values()) w.abort();
  }, 'plan-runner: pause on unload');
}
