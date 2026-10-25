/**
 * Plan runner: state files and the index of plans per conversation.
 *   <cwd>/.plan-<slug>/state.json        the plan state (also read by humans)
 *   <DSH_HOME>/plan-runner/index.json    { sessionId: [state.json paths] }
 * DSH_HOME defaults to ~/.dsh. Files are written atomically (temp file + rename), so a
 * crash never leaves a half-written state.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { STATE_VERSION } from './state.js';

/** dir + '/' + name, without normalising (the paths stored in the index keep their spelling). */
const joinPath = (dir, name) => (dir === '' ? name : dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const text = v => (typeof v === 'string' ? v : '');

export const dataDir = () => joinPath(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plan-runner');
export const planDir = (cwd, slug) => joinPath(text(cwd), `.plan-${text(slug)}`);
export const statePath = (cwd, slug) => joinPath(planDir(cwd, slug), 'state.json');

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function saveState(state) {
  writeAtomic(statePath(text(state.cwd), typeof state.slug === 'string' ? state.slug : 'plan'), `${JSON.stringify(state, null, 2)}\n`);
}

/** The state stored in `file`, or null when it is missing, unreadable or of another version. */
export function loadState(file) {
  try {
    // Strict UTF-8 and no BOM stripping: anything that is not plain JSON text is "not a state file".
    const s = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(String(file))));
    return s?.version === STATE_VERSION ? s : null;
  } catch { return null; }
}

/** The index as an object without prototype, so that any session id is a plain key. */
function readIndex() {
  const idx = Object.create(null);
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir(), 'index.json'), 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(idx, parsed);
  } catch { /* no index yet, or not readable: start empty */ }
  return idx;
}

export function indexPlan(sessionId, file) {
  const idx = readIndex();
  const id = String(sessionId);
  if (!(id in idx)) idx[id] = [];
  const list = idx[id];
  if (Array.isArray(list) && !list.includes(String(file))) list.push(String(file));
  writeAtomic(join(dataDir(), 'index.json'), `${JSON.stringify(idx, null, 2)}\n`);
}

/** Plans of a conversation, newest last. */
export function plansOf(sessionId) {
  const list = readIndex()[String(sessionId)];
  if (!Array.isArray(list)) return [];
  return list.filter(f => typeof f === 'string' && existsSync(f)).map(loadState).filter(Boolean);
}

export function allPlanFiles() {
  return Object.values(readIndex()).flatMap(l => (Array.isArray(l) ? l : [])).filter(f => typeof f === 'string' && existsSync(f));
}
