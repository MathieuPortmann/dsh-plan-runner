/** Paths a write tool call targets: file_path/path/paths, and the files named in an apply_patch text. */
export function targetPaths(args) {
  const out = [];
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof args?.[k] === 'string') out.push(args[k]);
  if (Array.isArray(args?.paths)) out.push(...args.paths.filter(p => typeof p === 'string'));
  const patch = typeof args?.patch === 'string' ? args.patch : typeof args?.input === 'string' ? args.input : '';
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2]).trim());
  return out;
}
