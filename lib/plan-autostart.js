/**
 * Plan agent: start every NEW conversation of this preset in plan mode, so the
 * user does not have to type /plan. Mounted inside the preset's planning group
 * (same isolated planMode service).
 *
 * Choosing "Plan" in a blank conversation rebuilds the agent with source
 * 'resume' (the blank conversation was created under the default preset), so
 * the source alone is not enough: a conversation is "new" while no request has
 * been sent to the model yet (no request header folded into the plan state).
 * A conversation that already talked to the model keeps its own state, e.g.
 * after "Approve here" it stays in execution mode across restarts.
 *
 * The Web UI creates the conversation only when the first message
 * is sent, already under the Plan preset, and this preset-scoped listener no
 * longer sees that agent/created. So the check runs again when the first message
 * is claimed (still before any request), once per agent. Subagents (the step
 * conversations of the plan runner) are created under the same preset and
 * are never put in plan mode.
 */
export const name = 'plan-autostart';
export const inject = ['planMode', 'sessionProjections'];

/** True when the session never sent a request to the model. */
export function isNewConversation(planState) {
  return planState !== undefined && planState.activeAtLastHeader === null && planState.active === false;
}

export function apply(ctx) {
  const checked = new WeakSet();
  const start = (agent, fresh) => {
    if (checked.has(agent)) return;
    checked.add(agent);
    // A step conversation started by the plan runner (a subagent) must not plan.
    const header = agent.session?.header;
    if (header?.origin === 'subagent' || header?.parentSession) return;
    let state;
    try { state = ctx.sessionProjections.stateOf(agent.session, 'plan'); } catch { state = undefined; }
    if (fresh || isNewConversation(state)) {
      const outcome = ctx.planMode.set(agent, true);
      if (outcome !== 'committed' && outcome !== 'noop') ctx.logger?.warn?.('plan-autostart: plan mode not started (%s)', outcome);
    }
  };
  ctx.on('agent/created', ({ agent, source }) => {
    if (source === 'compact') { checked.add(agent); return; }
    start(agent, source === 'startup');
  });
  ctx.on('agent/inbox/claimed', ({ agent }) => start(agent, false));
}
