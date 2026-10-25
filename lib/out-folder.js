/**
 * Plan runner — folder imposed by the user for the results.
 * "save everything in the folder ~/x": every output and every file check of a step must be
 * under ~/x, otherwise plan_add_step refuses the step.
 */
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';

// A folder word (English or French) near a path: "in the folder ~/x", "dans le dossier /tmp/y".
const FOLDER_WORD = /\b(dossier|folder|directory|r[ée]pertoire|save (it |them |everything )?(in|into|to)|enregistre|sauvegarde|mets?[- ]les? dans)\b/i;
const PATH_RE = /(?:~|\/(?:home|tmp|mnt|media|srv|opt|data))(?:\/[^\s"'`,;:()<>]*)?/g;

/** The folder the user imposed for the results, or '' (needs a path AND a folder word). */
export function imposedFolder(text, home = homedir()) {
  const t = String(text ?? '');
  const kw = FOLDER_WORD.exec(t);
  if (!kw) return '';
  const paths = [...t.matchAll(PATH_RE)].filter(m => m[0].length > 1);
  if (!paths.length) return '';
  const pick = paths.find(m => m.index > kw.index) ?? paths[0];
  return resolve(pick[0].replace(/[.)\]]+$/, '').replace(/^~(?=\/|$)/, home));
}

/** Paths (relative to cwd, or absolute / ~) that are not inside folder. */
export function outsideFolder(paths, folder, cwd, home = homedir()) {
  if (!folder) return [];
  return paths.filter(Boolean).filter(p => {
    const abs = resolve(cwd, String(p).replace(/^~(?=\/|$)/, home));
    return abs !== folder && !abs.startsWith(folder + sep);
  });
}

/** Paths a step writes or checks: its outputs and the path of each file check. */
export function stepPaths(args) {
  const lines = s => String(s ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const checked = lines(args.checks).map(l => /^(exists|contains|words):\s*(.+?)(\s*(::|>=).*)?$/.exec(l)?.[2]).filter(Boolean);
  return [...lines(args.outputs), ...checked].filter(p => !p.includes('{{'));
}

/** Refusal text when a step writes outside the folder the user imposed, else ''. */
export function folderRefusal(texts, args, cwd) {
  const folder = texts.map(t => imposedFolder(t)).filter(Boolean).at(-1);
  const bad = outsideFolder(stepPaths(args), folder, cwd);
  return bad.length ? `REFUSED: the user asked for the results in ${folder}. ${bad.join(', ')} is outside it: write outputs and checks under ${folder} (e.g. "exists: ${folder}/report.md").` : '';
}
