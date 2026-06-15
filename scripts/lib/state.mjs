// Per-project codegraph footprint: a single hidden, gitignored folder
//   <project>/.codegraph/
//     graph.db     — the embedded SQLite call/association graph for this project
//     state.json   — this state file
//     refresh.log  — background-refresh log
//
// Keeping everything under one dot-folder makes the footprint obvious, hidden in
// folder views, and trivial to gitignore (one line). /codegraph-init creates it
// and adds it to the project's .gitignore. The state file drives incremental
// refresh (reposLastSha), the SessionStart catch-up, the auto-update posture, and
// the status doctor.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const POSTURES = ['off', 'conservative', 'balanced', 'aggressive'];
export const GITIGNORE_LINE = '.codegraph/';

// The one hidden folder that holds all per-project codegraph data.
export function codegraphDir(project) {
  return join(project, '.codegraph');
}

export function stateFilePath(project) {
  return join(codegraphDir(project), 'state.json');
}

export function refreshLogPath(project) {
  return join(codegraphDir(project), 'refresh.log');
}

// Ensure the project's .gitignore excludes the .codegraph/ folder. Idempotent:
// no-op if already present. Creates .gitignore if missing. Returns 'added' |
// 'present' | 'no-git' (no .git here, so nothing to do).
export function ensureGitignore(project) {
  if (!existsSync(join(project, '.git'))) return 'no-git';
  const gi = join(project, '.gitignore');
  let cur = '';
  if (existsSync(gi)) cur = readFileSync(gi, 'utf8');
  const has = cur.split('\n').some((l) => l.trim() === GITIGNORE_LINE || l.trim() === '/.codegraph/');
  if (has) return 'present';
  const block = `\n# codegraph: indexed graph runtime + machine-local state (never commit)\n${GITIGNORE_LINE}\n`;
  writeFileSync(gi, (cur.replace(/\n*$/, '') || '') + block);
  return 'added';
}

export function defaultState(project, pluginVersion = null) {
  return {
    project,
    indexedRoots: [project],
    reposLastSha: {},
    lastFullBuild: null,
    pluginVersion,
    autoUpdate: 'balanced',
    contractsDir: null,
  };
}

export function readState(project) {
  const p = stateFilePath(project);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(project, state) {
  const p = stateFilePath(project);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return p;
}

// Merge updates into existing (or default) state and persist.
export function updateState(project, patch, pluginVersion = null) {
  const cur = readState(project) || defaultState(project, pluginVersion);
  const next = { ...cur, ...patch };
  writeState(project, next);
  return next;
}

// --- CLI (used by /codegraph-init to seed/refresh the state after a full build,
//     and by /codegraph-status as a quick reader) -----------------------------
async function main(argv) {
  const [cmd, projectArg, extra] = argv;
  if (!cmd || !projectArg) {
    process.stderr.write('usage: state.mjs <seed|show|posture|gitignore> <project> [posture-value]\n');
    process.exit(2);
  }
  let project = projectArg;
  try { project = realpathSync(projectArg); } catch { /* keep as-is */ }

  if (cmd === 'seed') {
    // Seed/refresh after a full build: set lastFullBuild + current per-repo shas,
    // keep any existing posture (default balanced). Also create .codegraph/ and
    // make sure it's gitignored — the standard init footprint.
    const { projectRepos } = await import('./git.mjs');
    const newShas = {};
    for (const r of projectRepos(project)) if (r.head) newShas[r.root] = r.head;
    const next = updateState(project, { lastFullBuild: new Date().toISOString(), reposLastSha: newShas });
    const gi = ensureGitignore(project);
    process.stdout.write(`Seeded ${stateFilePath(project)} (posture: ${next.autoUpdate}, ${Object.keys(newShas).length} repos).\n`);
    process.stdout.write(`.gitignore: ${gi === 'added' ? 'added .codegraph/' : gi === 'present' ? '.codegraph/ already ignored' : 'no .git here — skipped'}.\n`);
    return;
  }
  if (cmd === 'gitignore') {
    const gi = ensureGitignore(project);
    process.stdout.write(`.gitignore: ${gi === 'added' ? 'added .codegraph/' : gi === 'present' ? 'already ignored' : 'no .git here — skipped'}.\n`);
    return;
  }
  if (cmd === 'show') {
    const s = readState(project);
    process.stdout.write(s ? JSON.stringify(s, null, 2) + '\n' : `No state at ${stateFilePath(project)}.\n`);
    return;
  }
  if (cmd === 'posture') {
    if (!POSTURES.includes(extra)) { process.stderr.write(`posture must be one of: ${POSTURES.join(', ')}\n`); process.exit(2); }
    updateState(project, { autoUpdate: extra });
    process.stdout.write(`Set autoUpdate posture to "${extra}" for ${project}.\n`);
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exit(2);
}

const isCli = process.argv[1] && process.argv[1].endsWith('state.mjs');
if (isCli) main(process.argv.slice(2));
