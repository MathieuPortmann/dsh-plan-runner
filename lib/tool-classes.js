/**
 * Tool classes: which tools a plan step may not use, per access level.
 *
 * A step conversation never plans and never delegates (the runner is the only
 * conductor), and only the levels above "read" may write files or run commands.
 * Tools are compared by base name (without an "mcp__<server>__" prefix). Names of
 * companion plugins (Logseq, Zotero...) may be listed even when they are not
 * installed: a name that does not exist is harmless.
 */

/** Tool groups. A tool that is in none of them is allowed at every level. */
export const GROUPS = Object.freeze({
  // Tools that change files or notes (including the editor panel's write tools).
  write: [
    'write', 'edit', 'str_replace_editor', 'apply_patch', 'notebook_edit',
    'logseq_write', 'logseq_create_page', 'logseq_append', 'logseq_add_block', 'logseq_add_task',
    'zotero_write', 'memory_save', 'memory_delete',
    'edit_begin', 'edit_write_section', 'edit_finish',
  ],
  shell: ['bash', 'pwsh', 'job_kill'],
  // Tools that start other conversations or install code.
  delegate: ['plugin_manager', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'interrupt_agent'],
  planning: ['create_goal', 'update_goal', 'plan_begin', 'plan_add_step', 'plan_show', 'exit_plan_mode', 'enter_plan_mode', 'plan_mode'],
});

/** Groups removed from a step conversation, per access level. */
const PLAN_DENY = Object.freeze({
  read: ['write', 'shell', 'delegate', 'planning'],
  write: ['shell', 'delegate', 'planning'],
  full: ['delegate', 'planning'],
});

/**
 * Tool names removed from a step conversation for an access level ('read' | 'write' | 'full').
 * An unknown level returns an empty list. A fresh array is returned on every call.
 */
export function planDeny(level) {
  const names = [];
  for (const group of Object.hasOwn(PLAN_DENY, level) ? PLAN_DENY[level] : []) {
    for (const name of GROUPS[group]) if (!names.includes(name)) names.push(name);
  }
  return names;
}
