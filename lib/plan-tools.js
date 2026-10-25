/**
 * Plan runner — tools of the Plan agent (mounted inside the Plan preset only).
 *   plan_begin     start (or restart) the step list of this conversation's plan
 *   plan_add_step  add ONE step; the harness refuses a step that is too big for its model
 *   plan_show      show the steps recorded so far
 * Flat parameters (one step per call): easier for small models than one big JSON.
 * Nothing of the task itself is done here: only <cwd>/.plan-<slug>/state.json is written.
 */
import { createRequire } from 'node:module';
import { realpathSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { newState, makeStep, budgetOf, slugOf, log } from './state.js';
import { fileChars, inputChars, resolveItems } from './checks.js';
import { saveState, loadState, statePath, indexPlan, plansOf } from './store.js';
import { withModels } from './config.js';
import { folderRefusal } from './out-folder.js';

const dshRequire = createRequire(realpathSync(process.argv[1]));
const { defineTool } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-tools')).href);

export const name = 'plan-tools';
export const inject = ['tools'];

const textOutput = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] };

/** The draft plan of a conversation (newest not yet finished). */
function draftOf(sessionId) {
  return plansOf(sessionId).filter(s => ['draft', 'ready'].includes(s.status)).at(-1);
}

export function describeStep(s, i) {
  return [`${i + 1}. ${s.title} [model ${s.model}, access ${s.access}${s.stop ? ', stop point' : ''}${s.important ? ', reviewed' : ''}${s.forEach ? `, for each of ${s.forEach.count ?? '?'} items` : ''}; budget ${s.budget?.total ?? '?'}/${s.budget?.limit ?? '?'} tokens]`,
    `   checks: ${s.checks.join(' | ')}`].join('\n');
}

const READ_ONLY = /nothing (on the system )?(may|must|can|should) be (modified|changed|touched)|never install, remove, write|read[- ]only|ne (change|modifie|touche) rien|rien ne doit (être|etre) modifi|lecture seule/i;
/** The user's messages (and commands) of this conversation, oldest first. */
function userTexts(session) {
  const out = [];
  try {
    for (const seq of session.surface.nodes) {
      const e = session.eventAt(seq);
      const c = e?.type === 'user/message' ? e.data?.content : e?.type === 'command/run' ? e.data?.rawInput : null;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text ?? '').join('\n') : '';
      if (text) out.push(text);
    }
  } catch { /* no history */ }
  return out;
}

/** True when the user's messages in this conversation forbid changes to the system. */
export function readOnlyTask(session) {
  return userTexts(session).some(t => READ_ONLY.test(t));
}

export function apply(ctx, config = {}) {
  const cfg = withModels(config);
  const modelHelp = Object.entries(cfg.models).map(([id, m]) => `${id}${m.description ? `: ${m.description}` : ''} (${m.window} tokens)`).join('; ');

  ctx.tools.register(defineTool({
    name: 'plan_begin',
    description: 'Start the step list of the plan (call it once, before plan_add_step). Each step will later run in its OWN fresh conversation that only sees the objective, its instructions, short summaries of earlier steps and the files you list, so every step must stand alone. Calling it again replaces the draft.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short name of the plan (a few words).' },
      objective: { type: 'string', required: true, description: 'The overall goal in 2 to 4 sentences, with what "finished" means.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const session = exec.agent?.session;
      const cwd = session?.header?.cwd;
      if (!session || !cwd || !existsSync(cwd)) return 'REFUSED: this conversation has no working folder.';
      const objective = String(args.objective ?? '').trim();
      if (objective.length < 20) return 'REFUSED: the objective is too short; say what must exist at the end.';
      const slug = slugOf(args.name);
      const old = loadState(statePath(cwd, slug));
      if (old && !['draft', 'ready', 'done', 'stopped'].includes(old.status)) return `REFUSED: a plan named "${slug}" is ${old.status} in this folder; choose another name.`;
      const st = newState({ slug, objective, cwd, sessionId: session.id });
      log(st, 'plan started by the Plan agent');
      saveState(st);
      indexPlan(session.id, statePath(cwd, slug));
      return `Plan "${slug}" started. Now call plan_add_step once per step, in order. Keep each step small: it must fit in 60% of its model's context window (a 32k window leaves about 19k tokens, including the step's system prompt), so list only the files that step really needs.`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'plan_add_step',
    description: 'Add ONE step at the end of the plan. The harness checks the step: it is refused if a check is not in a valid form or if its input files are too big for its model; then split it or pick the bigger model. A step is only marked done when ALL its checks pass, so write checks that prove the work, e.g. "exists: draft/intro.md", "words: draft/intro.md >= 400", "contains: refs.bib :: Smith2020", "count: notes/*.md >= 12", "command: python -m pytest -q".',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title.' },
      instructions: { type: 'string', required: true, description: 'Exactly what to do and what to produce, so that a fresh conversation can do it alone. For a for_each step use {{item}} (the current item) and {{out}} (the file where its result goes).' },
      checks: { type: 'string', required: true, description: 'One check per line, each line in one of these forms:\nexists: <path>\ncontains: <path> :: <text>\nwords: <path> >= <n>\ncount: <glob> >= <n>\ncommand: <shell command, exit 0 = ok>\nPaths are relative to the working folder. In a for_each step every check must use {{out}} or {{item}}.' },
      inputs: { type: 'string', description: 'Files this step must read, one per line (only those).' },
      outputs: { type: 'string', description: 'Files this step creates or changes, one per line.' },
      model: { type: 'string', enum: Object.keys(cfg.models), description: `Model for this step. If the user named a model for the steps, use exactly that one. Default ${cfg.defaultModel}. Available: ${modelHelp}. A cloud model may be used only if the user agreed to send this data out.` },
      access: { type: 'string', enum: ['read', 'read-shell', 'write', 'full'], description: 'read = read files only; read-shell = read files and run read-only shell commands (ls, cat, grep, --version, systemctl status…; anything that changes the system is refused); write = create and edit files (no shell); full = also run shell commands. Choose the smallest that works.' },
      stop: { type: 'boolean', description: 'true = pause after this step so the user checks the result before the next one.' },
      important: { type: 'boolean', description: 'true = a second, read-only reviewer checks the result after the mechanical checks.' },
      for_each: { type: 'string', description: 'Batch step: one line per item or a glob (e.g. "papers/*.pdf"). The step then runs once per item, each in its own short conversation, and writes one result file per item ({{out}}). Its checks run per item and must use {{out}}, e.g. "exists: {{out}}". Follow it with a synthesis step that reads .plan-<name>/outputs/*.md.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const session = exec.agent?.session;
      if (!session) return 'REFUSED: no conversation.';
      const st = draftOf(session.id);
      if (!st) return 'REFUSED: call plan_begin first.';
      // "full" runs shell commands without asking. Only when the user's own
      // messages allow changes to the system (not in a read-only task).
      if (args.access === 'full' && readOnlyTask(session)) return 'REFUSED: the user said nothing on the system may be changed, so a step may not have access "full". Use "read-shell" to inspect the system with read-only commands, "write" (files only, limited to its outputs) or "read".';
      const outside = folderRefusal(userTexts(session), args, st.cwd);
      if (outside) return outside;
      const v = makeStep(args, cfg);
      if (v.error) return `REFUSED: ${v.error}.`;
      const step = v.step;
      if (step.forEach) {
        const items = resolveItems(st.cwd, step.forEach.source);
        if (!items.length) return 'REFUSED: for_each matches no file; check the path or glob.';
        step.forEach.count = items.length;
        step.forEach.sampleItem = items.map(i => ({ i, c: fileChars(st.cwd, i) ?? 0 })).sort((a, b) => b.c - a.c)[0].i;
      }
      const budget = budgetOf(st, step, {
        window: cfg.models[step.model].window, basePrompt: cfg.basePromptTokens, outputReserve: cfg.outputReserve,
        unknownFile: cfg.unknownFileTokens, summaryTokens: cfg.summaryTokens, fileChars: p => inputChars(st.cwd, p, { itemOutputChars: Math.round(cfg.itemOutputTokens * 3.5) }),
      });
      step.budget = budget;
      if (!budget.ok) {
        const bigger = Object.entries(cfg.models).filter(([, m]) => Math.floor(0.6 * m.window) >= budget.total).map(([k]) => k);
        return `REFUSED: this step needs about ${budget.total} tokens but ${step.model} allows ${budget.limit} (60% of its window). Split it into smaller steps (fewer input files each, or a for_each step per file)${bigger.length ? `, or use model ${bigger.join(' or ')}` : ''}.`;
      }
      st.steps.push(step);
      st.status = 'ready';
      saveState(st);
      return `Step ${st.steps.length} added (about ${budget.total}/${budget.limit} tokens${step.forEach ? `, ${step.forEach.count} items` : ''}).`;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'plan_show',
    description: 'Show the steps recorded so far for this conversation\'s plan.',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      const st = exec.agent?.session && draftOf(exec.agent.session.id);
      if (!st) return 'No plan started: call plan_begin.';
      return [`Plan "${st.slug}": ${st.objective}`, ...st.steps.map(describeStep)].join('\n') || 'No step yet.';
    },
  }));
}
