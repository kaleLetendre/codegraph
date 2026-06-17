#!/usr/bin/env node
// PreToolUse hook on Grep|Glob. The token win is gated on Claude actually
// reaching for the graph, and the CLAUDE.md directive (loaded once at session
// start) decays as context grows — so on an indexed project the model drifts
// back to its grep/Read priors and codegraph goes unused until asked.
//
// This puts the nudge at the decision point: when Claude is about to grep/glob
// for code, inject a one-line reminder (additionalContext) to prefer the graph.
// It NEVER blocks — it just reminds, and Claude still chooses. To stay true to
// codegraph's "fewer tokens" promise it is rate-limited to NUDGE_CAP times per
// session (counter kept under .codegraph/nudges/), and it stays silent unless
// the project is indexed with a non-'off' posture.

import { realpathSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readState, codegraphDir } from '../lib/state.mjs';

const NUDGE_CAP = 3;

function readStdin() {
  return new Promise((res) => {
    let buf = '';
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => res(buf));
    process.stdin.on('error', () => res(buf));
  });
}

// Silent exit: emit nothing, let the tool call proceed untouched.
function quiet() {
  process.exit(0);
}

function nudge(ctx) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx },
  }));
  process.exit(0);
}

function project(payload) {
  const raw = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  try { return realpathSync(raw); } catch { return raw; }
}

// Per-session nudge counter under .codegraph/nudges/<session>. Returns the count
// BEFORE this call (0 on first grep of the session); bumps it on the way out.
function bumpCount(proj, sessionId) {
  const dir = join(codegraphDir(proj), 'nudges');
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const file = join(dir, safe);
  let n = 0;
  try { n = parseInt(readFileSync(file, 'utf8'), 10) || 0; } catch { /* first time */ }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, String(n + 1));
  } catch { /* best-effort; a write failure just means we may re-nudge */ }
  return n;
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* tolerate empty */ }

  const proj = project(payload);
  const state = readState(proj);

  // Not indexed, or the user opted all the way out → say nothing.
  if (!state || state.autoUpdate === 'off') quiet();

  const seen = bumpCount(proj, payload?.session_id);
  if (seen >= NUDGE_CAP) quiet();

  nudge(
    'codegraph is indexed for this project — prefer its MCP tools over grep/Read ' +
    'for code navigation: find_symbol (locate a symbol), get_source (read one ' +
    "function's body), trace_callers/trace_callees/path_between (whole call chains " +
    'in one call). They cost ~50% fewer tokens. Fall back to grep/Read for string ' +
    'literals, callback/function-pointer edges, or non-code files.'
  );
}

main().catch(() => process.exit(0));
