#!/usr/bin/env node
// codegraph regression test — locks the SQLite query layer's behavior so a future
// change can't silently diverge (there is no Neo4j to diff against anymore).
// Runs a committed synthetic fixture through build + every tool, then asserts
// golden results: symbol resolution, intra/cross-file traces, get_source, an
// in-repo path_between, query_sql guards, schema versioning + migration, and
// incremental idempotency. Self-contained — no external workspace needed.

import { mkdtempSync, cpSync, appendFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runBuild } from '../src/build.js';
import { connect, schemaVersion, SCHEMA_VERSION } from '../src/store/sqlite.js';
import * as Q from '../src/store/sqlite-query.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function has(haystack, needle, msg) { ok(String(haystack).includes(needle), `${msg} — missing "${needle}" in:\n${haystack}`); }
function edgeCounts(db, project) {
  const r = {};
  for (const e of db.prepare('SELECT type, count(*) n FROM edges WHERE project=? GROUP BY type').all(project)) r[e.type] = e.n;
  return r;
}

async function fixtureTests() {
  const work = mkdtempSync(join(tmpdir(), 'cg-test-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  await runBuild({ target: src, project, db, reset: true });
  let conn = connect(db, { readonly: true });

  // schema version stamped
  eq(schemaVersion(conn), SCHEMA_VERSION, 'schema_version stamped');

  // find_symbol: unique + ambiguous
  has(Q.findSymbol(conn, project, 'a_main'), 'a.c', 'find_symbol a_main locates a.c');
  has(Q.findSymbol(conn, project, 'dup'), '2 match', 'find_symbol dup is ambiguous (2)');

  // get_source returns the body, not the whole file
  has(Q.getSource(conn, project, 'a_helper'), 'return n + 1', 'get_source a_helper body');

  // trace_callees: intra-file + cross-file + transitive leaf
  const callees = Q.traceCallees(conn, project, 'a_main');
  has(callees, 'a_helper', 'callees include intra-file a_helper');
  has(callees, 'a_util', 'callees include cross-file a_util');
  has(callees, 'leaf', 'callees reach transitive leaf');

  // trace_callers: leaf <- a_util <- a_main
  const callers = Q.traceCallers(conn, project, 'leaf');
  has(callers, 'a_util', 'callers of leaf include a_util');
  has(callers, 'a_main', 'callers of leaf reach a_main');

  // path_between: a_main -> a_util -> leaf (cross-file CALLS chain), exercises the
  // BFS + node-label reconstruction.
  const path = Q.pathBetween(conn, project, 'a_main', 'leaf');
  has(path, 'a_util', 'path_between routes a_main -> leaf through a_util');
  has(path, 'leaf', 'path_between reaches the target');

  // query_sql: valid SELECT + guards
  has(Q.querySql(conn, "SELECT name FROM symbols WHERE name='a_main'"), 'a_main', 'query_sql SELECT works');
  has(Q.querySql(conn, 'DELETE FROM symbols'), 'Refused', 'query_sql rejects DELETE');
  has(Q.querySql(conn, 'SELECT 1; DROP TABLE symbols'), 'Refused', 'query_sql rejects multi-statement');

  const base = edgeCounts(conn, project);
  conn.close();

  // incremental idempotency: re-index an unchanged file → identical edge counts
  await runBuild({ target: src, project, db, files: ['util.c'] });
  conn = connect(db, { readonly: true });
  const after = edgeCounts(conn, project);
  eq(JSON.stringify(after), JSON.stringify(base), 'incremental re-index of unchanged file is idempotent');
  conn.close();

  // incremental reflects a real change: add a function that calls a_helper
  appendFileSync(join(src, 'a.c'), '\nint added_fn(int n) { return a_helper(n); }\n');
  await runBuild({ target: src, project, db, files: ['a.c'] });
  conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'added_fn'), 'a.c', 'incremental picks up a new symbol');
  has(Q.traceCallees(conn, project, 'added_fn'), 'a_helper', 'new symbol resolves its cross-file call');
  conn.close();

  // schema migration: tamper version, full rebuild must migrate (drop+recreate)
  const w = connect(db); // writable
  w.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version','0')").run();
  w.close(); // persists the tampered version

  await runBuild({ target: src, project, db, reset: true });
  conn = connect(db, { readonly: true });
  eq(schemaVersion(conn), SCHEMA_VERSION, 'reset migrates a stale-version db back to current');
  has(Q.findSymbol(conn, project, 'a_main'), 'a.c', 'queries work after migration');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

console.log('codegraph regression test');
await fixtureTests();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
