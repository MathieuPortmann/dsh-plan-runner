import { planDeny } from './tool-classes.js';

/** Plan runner — shared defaults (the Host config of the `plan-runner` row overrides them). */
export const DEFAULTS = {
  // Models a step may use: { <model id>: { provider, window, description? } }, window = context window
  // in tokens. Empty = every step runs with the model of the plan conversation (see withModels).
  models: {},
  defaultModel: '', // '' = the first configured model (or the plan conversation's own model)
  defaultWindow: 32768,     // assumed context window of the plan conversation's own model
  basePromptTokens: 9000,   // system prompt + tools of a step conversation (measured about 9-11k)
  outputReserve: 3000,      // tokens kept for the step's own reasoning and answer
  unknownFileTokens: 2000,  // a file that does not exist yet (made by an earlier step)
  itemOutputTokens: 600,    // a for_each result not written yet (.plan-<slug>/outputs/): short by design
  summaryTokens: 300,       // per earlier step summary
  ollamaUrl: 'http://127.0.0.1:11434',
  pauseOnBattery: false,
  commandTimeoutMs: 120000,
  loopRepeats: 3,           // the same tool call with the same arguments this many times = loop
  splitModel: '',           // proposes the finer split after two failures ('' = the step's own model)
  auditModel: '',           // reviewer of important steps; '' = the step's own model
};

/** Pseudo-model used when no model is configured: the step inherits the plan conversation's model. */
export const INHERIT = 'default';

/**
 * The effective settings: defaults, then the user's config. With no configured model a single
 * pseudo-model (no provider) stands for "the conversation's own model", so budgets still work.
 */
export function withModels(config = {}) {
  const cfg = { ...DEFAULTS, ...config, models: { ...(config.models ?? {}) } };
  if (!Object.keys(cfg.models).length) cfg.models[INHERIT] = { provider: null, window: cfg.defaultWindow };
  if (!cfg.models[cfg.defaultModel]) cfg.defaultModel = Object.keys(cfg.models)[0];
  if (cfg.splitModel && !cfg.models[cfg.splitModel]) cfg.splitModel = '';
  return cfg;
}

/** Tools removed from a step conversation for each access level (only names that exist are sent).
 *  A step never plans, never delegates, and only the levels above "read" may write or run commands. */
const deny = Object.fromEntries(['read', 'write', 'full'].map(l => [l, planDeny(l)]));
// "read-shell": read, plus bash limited to read-only commands (lib/read-shell.js).
deny['read-shell'] = deny.read.filter(n => n !== 'bash');
export const DENY = Object.freeze(deny);
