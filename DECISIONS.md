# codegraph — decision log

Architecture decisions for the storage backend, newest first. Each entry: the
decision, why, and what it costs. (The detailed evaluation logs that led here —
the Neo4j-vs-SQLite parity/perf/token experiments — are kept out of this repo.)

---

## D9 — WASM SQLite (`sql.js`) is the store, not `better-sqlite3` — 2026-06-15

**Decision.** Back the embedded store with `sql.js` (SQLite compiled to
WebAssembly), via a thin adapter that presents the slice of the better-sqlite3 API
the loader/query layer use.

**Why.** The target is "a bare machine with only Claude Code + Node." `better-sqlite3`
is a *native* module; it only has a prebuilt binary when a release matches the
exact Node version, and on the dev machine `npm install` fell back to **compiling
from source (~57 s, requires python3 + a C/C++ toolchain)** — which simply fails on
a machine without build tools. `sql.js` ships its `.wasm` inside the npm package,
so install compiles and downloads nothing: clean `npm install` dropped from 57 s to
~1 s with zero node-gyp. It reads/writes the standard SQLite on-disk format, so the
db file is unchanged and interoperable, and it loads the 5 MB test-workspace graph in
~2.4 ms (queries sub-ms) — perf is irrelevant at this graph size.

**Cost.** sql.js is in-memory: a writable connection must persist on `close()`
(export → temp file → atomic rename). Native better-sqlite3 would be faster on a
*much* larger graph, but ours is thousands of nodes. The adapter is the one place
that knows the store isn't better-sqlite3.

**Consequence.** The only remaining native dependency is `tree-sitter`, which ships
bundled prebuilds for all six linux/mac/windows × x64/arm64 targets (loaded, never
compiled). Install is therefore toolchain-free on any mainstream platform.

## D8 — Defer per-process adjacency caching — 2026-06-15

**Decision.** `trace_*` rebuilds the full CALLS adjacency map on each call
(~8 ms at a few-thousand-node scale). Leave it; add a code note.

**Why.** Negligible cost at our size; caching adds state/invalidation complexity
for no user-visible win. Revisit only if codegraph targets much larger graphs.

## D7 — One db file per project, not a shared multi-project file — 2026-06-15

**Decision.** Each project's graph lives at `<project>/.codegraph/graph.db`; the
server resolves it from `CLAUDE_PROJECT_DIR`.

**Why.** Clean isolation, trivial teardown (delete the folder), no cross-project
bleed risk. The `project` column still scopes every query (the schema supports
multiple projects in one file), but per-project files are simpler and match how
Neo4j was used in practice. `$CODEGRAPH_DB` overrides the path.

## D6 — Stamp a schema version + migrate on rebuild — 2026-06-15

**Decision.** Store `schema_version` in a `meta` table. The server refuses to query
a db whose version differs (prompts `/codegraph-rebuild`); a `--reset` build
migrates by dropping + recreating the tables.

**Why.** A future schema change must not silently return wrong answers against an
old-shape db. Cheap insurance.

## D5 — Keep a raw-query escape hatch as `query_sql`, not drop it — 2026-06-15

**Decision.** Replace the old Neo4j `cypher` tool with `query_sql`: a single
read-only `SELECT`/`WITH` over the schema; everything else rejected.

**Why.** The 7 structured tools covered every experiment, but a power-user escape
hatch for novel structural questions costs ~20 lines and avoids shipping new code
for one-off queries. Read-only by construction (regex guard + the db is opened
read-only in the server).

## D4 — Full replacement of Neo4j, no `CODEGRAPH_BACKEND` switch — 2026-06-15

**Decision.** Delete the Neo4j backend entirely rather than keep both behind a
runtime switch.

**Why.** The eval proved SQLite is at parity on answers and the token win, faster
per call, and ~570× smaller. Keeping Neo4j would mean maintaining two query layers
and the 2.7 GB JVM provisioning forever. One code path is simpler and is the whole
point. What's lost: the Neo4j Browser visual theme (the standalone d3/Gephi
exporters cover visualization) and raw Cypher (replaced by `query_sql`).

## D3 — Rewire the HTML/GEXF exporters to SQLite; drop the raw-Cypher mode — 2026-06-15

**Decision.** `export-html`/`export-gexf` gather from SQLite via a shared module;
`export-html`'s `--query <cypher>` mode is removed.

**Why.** The d3/Gephi rendering is backend-agnostic; only the data-gathering query
changed. The raw-Cypher mode can't exist without Neo4j and `query_sql` covers
ad-hoc needs. Added a `contract` column to `edges` so WIRE edges stay faithful for
the contract-scoped export.

## D2 — Golden-snapshot regression test, since there's no Neo4j to diff against — 2026-06-15

**Decision.** Add `test/` (`npm test`): build a committed synthetic fixture and
assert golden results through the query layer — symbol resolution, intra/cross-file
traces, get_source, an in-repo `path_between`, `query_sql` guards, schema migration,
and incremental idempotency. The fixture is self-contained (no external workspace).

**Why.** Parity was previously proven by diffing against Neo4j. With Neo4j gone, a
committed golden suite is what stops a future change from silently regressing — the
`path_between`/incremental bugs below are exactly what it guards.

## D1 — Embedded SQLite replaces the Neo4j server (not Kuzu) — 2026-06-13

**Decision.** Replace the Neo4j server backend with an embedded SQLite store.
Chose SQLite over Kuzu (the original "embedded graph DB" idea).

**Why.** Neo4j needed a 2.7 GB bundled JVM + a running daemon + a port, and its
setup bailed on anything but linux-x64 — a non-starter for cross-platform. Kuzu (the
embedded graph engine) was deprecated (npm "no longer supported"). The graph is
~2,700 nodes, so a graph *engine* isn't needed — an indexed store + in-JS BFS
traversals reproduce Neo4j's behavior exactly. Proven byte-identical on a real
multi-repo test workspace (45/45 parity battery) at ~570× smaller footprint.

---

## Bugs found during the migration (all fixed; guarded by `npm test`)

- **`path_between` crashed on cross-repo paths** that route through a Contract node
  (its label helper queried only the `symbols` table). The spike's parity check
  used an in-repo path and missed it. Fixed to resolve labels against contracts too,
  mirroring Neo4j's `coalesce` reconstruction.
- **Incremental dropped cross-file edges**: the loader's dangling-edge check
  validated endpoints against the in-memory batch only, so re-indexing one file lost
  its edges to symbols in files it didn't re-parse. Fixed to validate against the
  store (existing + just-inserted), exactly like Neo4j's MATCH-both-endpoints.
  Incremental re-index is now idempotent.
- **Incremental falsely tagged `~ambiguous`**: a re-indexed file's own symbols
  appeared in both the fresh graph and `loadProjectSymbols`, so same-file calls
  looked doubly-defined. Fixed by excluding the changed files from `extraDefs`;
  incremental now matches a full rebuild exactly.
