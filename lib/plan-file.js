/**
 * Plan agent: save every plan presented with exit_plan_mode as PLAN-<slug>.md
 * in the conversation's working directory, so the plan survives compaction and the
 * execution conversation can read it. The slug rule is shared with client.js (planSlug).
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'plan-file';
export const inject = ['tools'];

/** Slug from the plan's first heading: lowercase ASCII words joined by '-', max 40 characters. */
export function planSlug(markdown) {
  const heading = (/^\s*#+\s*(.+)$/m.exec(String(markdown)) ?? [null, 'plan'])[1];
  const slug = heading.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'plan';
}

export const START_NUDGE = 'The plan is approved. Tell the user to press "Run step by step" to start it; do not stop here.';

/** Append the start reminder to an accepted exit_plan_mode result; a refusal is left as it is. */
export function withStartNudge(result) {
  const text = typeof result === 'string' ? result : (result?.content ?? []).map(c => c?.text ?? '').join('\n');
  if (result?.isError || /\b(reject|refus|denied|declin|not approved|keep planning)/i.test(text)) return result;
  if (typeof result === 'string') return `${result}\n\n${START_NUDGE}`;
  if (Array.isArray(result?.content)) return { ...result, content: [...result.content, { type: 'text', text: START_NUDGE }] };
  return result;
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'exit_plan_mode') {
      const plan = exec.arguments?.plan;
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof plan === 'string' && plan.trim() && cwd && existsSync(cwd)) {
        try { writeFileSync(join(cwd, `PLAN-${planSlug(plan)}.md`), plan.endsWith('\n') ? plan : `${plan}\n`); }
        catch (err) { ctx.logger?.warn?.(`plan-file: could not save the plan: ${err.message}`); }
      }
      return withStartNudge(await next());
    }
    return next();
  });
}
