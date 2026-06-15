// Embedded SQLite backend — a daemon-free, ZERO-NATIVE-BUILD, cross-platform
// alternative to the Neo4j server. Backed by sql.js (SQLite compiled to WASM):
// the .wasm ships inside the npm package, so install needs no prebuilt-binary
// match and no C/C++ toolchain — it works on a bare machine with only Node. The
// graph is small (thousands of nodes), so a single .db file (standard SQLite
// format) loaded into memory + in-JS traversals matches Neo4j's behavior with no
// JVM, no server, no port. Every row carries `project` so one file can hold many
// projects' graphs (namespaced), exactly like the Neo4j backend.
//
// A thin adapter below presents the small slice of the better-sqlite3 API the
// store uses (prepare().run/get/all, exec, transaction, close) on top of sql.js,
// so the query + loader code is backend-agnostic. sql.js is in-memory: a writable
// connection persists on close() by exporting the db and atomically replacing the
// file; a readonly connection just frees memory.

import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
// Resolve the bundled wasm next to the sql.js package (no network, no compile).
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });

// Bump when the on-disk schema changes shape. A .db stamped with an older version
// is reported stale (server turns this into "run /codegraph-rebuild") rather than
// queried with the wrong assumptions.
export const SCHEMA_VERSION = 1;

// better-sqlite3 binds a single object arg as NAMED params (SQL `@key` <- obj.key)
// and any other args as POSITIONAL (`?`). sql.js wants the `@` sigil in the keys
// for named, and an array for positional — translate here.
function normParams(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const o = {};
    for (const k of Object.keys(args[0])) o['@' + k] = args[0][k];
    return o;
  }
  return args.length ? args : undefined;
}

class Stmt {
  constructor(raw) { this.raw = raw; }
  run(...a) { const p = normParams(a); p === undefined ? this.raw.run() : this.raw.run(p); return this; }
  get(...a) { const p = normParams(a); this.raw.reset(); if (p !== undefined) this.raw.bind(p); const got = this.raw.step() ? this.raw.getAsObject() : undefined; this.raw.reset(); return got; }
  all(...a) { const p = normParams(a); this.raw.reset(); if (p !== undefined) this.raw.bind(p); const out = []; while (this.raw.step()) out.push(this.raw.getAsObject()); this.raw.reset(); return out; }
}

class DB {
  constructor(db, path, readonly) { this._db = db; this._path = path; this._readonly = readonly; }
  prepare(sql) { return new Stmt(this._db.prepare(sql)); }
  exec(sql) { this._db.exec(sql); return this; }
  pragma() { /* no-op: in-memory WASM db, no WAL/journal to set */ return this; }
  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try { const r = fn(...args); this._db.exec('COMMIT'); return r; }
      catch (e) { try { this._db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    };
  }
  close() {
    if (!this._readonly) {
      const tmp = this._path + '.tmp';
      writeFileSync(tmp, Buffer.from(this._db.export()));
      renameSync(tmp, this._path); // atomic replace, so a concurrent reader never sees a torn file
    }
    this._db.close();
  }
}

export function connect(dbPath, { readonly = false } = {}) {
  if (!readonly) mkdirSync(dirname(dbPath), { recursive: true });
  const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
  return new DB(db, dbPath, readonly);
}

// The schema version stored in the db (0 if absent / pre-versioning). Safe on a
// readonly connection and on a db built before the meta table existed.
export function schemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch {
    return 0; // meta table doesn't exist yet
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS repos    (id TEXT PRIMARY KEY, project TEXT, name TEXT, root TEXT);
CREATE TABLE IF NOT EXISTS files    (id TEXT PRIMARY KEY, project TEXT, repo TEXT, path TEXT, lang TEXT);
CREATE TABLE IF NOT EXISTS symbols  (id TEXT PRIMARY KEY, project TEXT, repo TEXT, file TEXT, name TEXT, kind TEXT, lang TEXT, startLine INTEGER, endLine INTEGER);
CREATE TABLE IF NOT EXISTS contracts(id TEXT PRIMARY KEY, project TEXT, name TEXT, file TEXT);
CREATE TABLE IF NOT EXISTS edges    (type TEXT, src TEXT, dst TEXT, project TEXT, token TEXT, cnt INTEGER, resolution TEXT, evidence TEXT, direction TEXT, contract TEXT);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(project, name);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(project, repo, file);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(project, type, src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(project, type, dst);
CREATE INDEX IF NOT EXISTS idx_edges_proj ON edges(project, type);
`;

const TABLES = ['repos', 'files', 'symbols', 'contracts', 'edges', 'meta'];

export function loadGraph(db, graph, { reset = false, log = () => {} } = {}) {
  const project = graph.project;
  // If an existing db was written by a different schema version, a full --reset
  // build migrates it by dropping + recreating the tables (the db is per-project,
  // so this is the rebuild path; incremental against a stale schema is refused by
  // the server, which prompts /codegraph-rebuild). A fresh file reports version 0
  // and is harmlessly (re)created here too.
  const priorVersion = schemaVersion(db);
  if (reset && priorVersion !== SCHEMA_VERSION) {
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    if (priorVersion) log(`  migrating store schema v${priorVersion} -> v${SCHEMA_VERSION} (recreate)`);
  }
  db.exec(SCHEMA);

  if (reset) {
    if (!project) throw new Error('sqlite loadGraph --reset requires graph.project');
    for (const t of ['repos', 'files', 'symbols', 'contracts', 'edges']) {
      db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project);
    }
    log(`  reset project ${project}`);
  }

  const insRepo = db.prepare('INSERT OR REPLACE INTO repos (id,project,name,root) VALUES (@id,@project,@name,@root)');
  const insFile = db.prepare('INSERT OR REPLACE INTO files (id,project,repo,path,lang) VALUES (@id,@project,@repo,@path,@lang)');
  const insSym = db.prepare('INSERT OR REPLACE INTO symbols (id,project,repo,file,name,kind,lang,startLine,endLine) VALUES (@id,@project,@repo,@file,@name,@kind,@lang,@startLine,@endLine)');
  const insCon = db.prepare('INSERT OR REPLACE INTO contracts (id,project,name,file) VALUES (@id,@project,@name,@file)');
  const insEdge = db.prepare('INSERT INTO edges (type,src,dst,project,token,cnt,resolution,evidence,direction,contract) VALUES (@type,@src,@dst,@project,@token,@cnt,@resolution,@evidence,@direction,@contract)');

  db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));

  const tx = db.transaction(() => {
    for (const r of graph.repos.values()) insRepo.run(r);
    for (const f of graph.files.values()) insFile.run(f);
    for (const s of graph.symbols.values()) insSym.run({ lang: null, ...s });
    for (const c of graph.contracts.values()) insCon.run({ file: null, ...c });
    // Match Neo4j's load semantics exactly:
    //  (a) it MATCHes both endpoints against nodes ALREADY IN THE STORE, so an
    //      edge is kept iff both endpoints exist there now (just-inserted above
    //      OR pre-existing). Computing valid ids from the DB — not just this
    //      graph batch — is what lets an incremental reload of one file keep its
    //      cross-file edges to symbols in files we didn't re-parse; it also still
    //      drops genuine orphans (endpoint in no file).
    //  (b) MERGE dedups on (type, src, dst) (+ token for REFERENCES/WIRE).
    const nodeIds = new Set();
    for (const t of ['repos', 'files', 'symbols', 'contracts'])
      for (const r of db.prepare(`SELECT id FROM ${t} WHERE project = ?`).all(project)) nodeIds.add(r.id);
    const seen = new Set();
    for (const e of graph.edges) {
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue; // drop dangling
      const tok = e.props?.token ?? null;
      const key = (e.type === 'REFERENCES' || e.type === 'WIRE')
        ? `${e.type}\0${e.from}\0${e.to}\0${tok}`
        : `${e.type}\0${e.from}\0${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      insEdge.run({
        type: e.type, src: e.from, dst: e.to, project,
        token: tok, cnt: e.props?.count ?? null,
        resolution: e.props?.resolution ?? null, evidence: e.props?.evidence ?? null,
        direction: e.props?.direction ?? null, contract: e.props?.contract ?? null,
      });
    }
  });
  tx();
  const n = graph.stats();
  log(`  loaded ${n.symbols} symbols, ${n.files} files, ${n.edges} edges into sqlite`);
}

// Read this project's existing symbol definitions (for incremental call
// resolution): a changed file's outgoing calls resolve against the whole project,
// not just the re-parsed file. Mirrors neo4j.js loadProjectSymbols.
export function loadProjectSymbols(db, project) {
  return db.prepare(
    "SELECT id, repo, file, name, kind FROM symbols WHERE project = ? AND kind <> 'module'",
  ).all(project);
}

// Surgical per-file prune for incremental rebuilds, mirroring neo4j.js pruneFile.
// Symbol ids are content-stable (repo:file:name:line), so a symbol that survives
// an edit keeps the SAME id and therefore its INCOMING edges from unchanged files.
//   - delete this file's symbols whose id is NOT in keepIds, with all their edges;
//   - for surviving symbols, clear their OUTGOING edges (CALLS/REFERENCES AND
//     DEFINED_IN), keeping incoming, so the reload recreates exactly one of each
//     (Neo4j's MERGE deduped these implicitly; SQLite's INSERT is additive, so we
//     must clear everything the re-extraction will re-add for this file);
//   - clear the file's IN_REPO edge for the same reason;
//   - if keepIds is empty (file deleted on disk), also drop the File node.
export function pruneFile(db, project, repo, relPath, keepIds, log = () => {}) {
  const keep = new Set(keepIds);
  const existing = db.prepare(
    'SELECT id FROM symbols WHERE project = ? AND repo = ? AND file = ?',
  ).all(project, repo, relPath).map((r) => r.id);
  const toDelete = existing.filter((id) => !keep.has(id));

  const delEdgesOf = db.prepare('DELETE FROM edges WHERE project = ? AND (src = ? OR dst = ?)');
  const delSym = db.prepare('DELETE FROM symbols WHERE id = ?');
  const delOutgoing = db.prepare(
    "DELETE FROM edges WHERE project = ? AND src = ? AND type IN ('CALLS','REFERENCES','DEFINED_IN')",
  );

  const tx = db.transaction(() => {
    for (const id of toDelete) { delEdgesOf.run(project, id, id); delSym.run(id); }
    for (const id of keepIds) delOutgoing.run(project, id);
    // The file node's IN_REPO edge is re-added on reload too — clear it (and, if
    // the file is gone, the File node itself; its symbols + DEFINED_IN already went).
    const f = db.prepare('SELECT id FROM files WHERE project = ? AND repo = ? AND path = ?').get(project, repo, relPath);
    if (f) {
      db.prepare("DELETE FROM edges WHERE project = ? AND type = 'IN_REPO' AND src = ?").run(project, f.id);
      if (!keepIds.length) db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    }
  });
  tx();
  if (!keepIds.length) log(`  pruned deleted file ${repo}/${relPath}`);
  else log(`  pruned ${repo}/${relPath} (kept ${keepIds.length} stable symbols' incoming edges)`);
}
