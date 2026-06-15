# codegraph

A Claude Code plugin that indexes a project's source into a **cross-repo
call/association graph** (in an **embedded SQLite file** — no daemon, no JVM) and
hands it to Claude as **MCP tools**. The point is tokens: once a project is
indexed and Claude is told to reach for the graph economically, code navigation /
audit / refactor / cross-repo questions cost **~40–60% fewer tokens than grep +
Read, at equal accuracy** — because Claude reads one function's body instead of a
whole file, and gets a whole call tree or wire seam in a single query instead of
fanning out across files.

That result is measured. Across a series of held-out A/B experiments (opus
subagents, with-graph vs grep/Read at equal accuracy) the win was largest on hard
C call-graph work (−58%) and cross-repo wire seams (−54%), with non-overlapping
token distributions, and it carries over to the SQLite/WASM backend unchanged
(the tool outputs are byte-identical to the original backend).

## The loop: install → init → use

1. **Install** the plugin (from your marketplace). `npm install` is **toolchain-
   free** — no daemon, no JDK, no C/C++ compiler, nothing running in the
   background. The SQLite store is `sql.js` (SQLite compiled to WebAssembly; the
   `.wasm` ships inside the package, so nothing is compiled or downloaded), and the
   `tree-sitter` parsers ship bundled prebuilt binaries for linux/mac/windows ×
   x64/arm64. A clean install is ~1 s and works on a bare machine with only Node.

2. **Init a project** inside Claude Code:

   ```
   /codegraph-init [dir]
   ```

   This installs deps (idempotent), builds the project's graph into
   `<project>/.codegraph/graph.db`, **installs the navigation directive** into the
   project's `CLAUDE.md` (with your consent — this directive is what produces the
   token win), seeds `<project>/.codegraph/state.json`, and turns on balanced
   auto-update.

3. **Use Claude normally.** Ask "where is X / what calls Y / how do these connect /
   what's the blast radius of changing Z" and Claude answers from the graph. The
   graph stays fresh on its own (see Auto-update); if a trace ever looks stale,
   Claude can refresh it mid-session by calling `update_graph`.

## MCP tools

| Tool | Use |
|---|---|
| `graph_stats` | node/edge/repo counts for the active project |
| `graph_status` | is the project indexed, is the graph stale vs git |
| `find_symbol` | locate definitions by exact name |
| `get_source` | return ONE symbol's body (cheaper than Read on a big file) |
| `trace_callees` | downward call tree (within a repo), whole chain in one call |
| `trace_callers` | upward call tree to entrypoints, whole chain in one call |
| `trace_contract` | which symbols/repos touch a contract's wire tokens (cross-repo seam) |
| `path_between` | shortest path across CALLS + contract REFERENCES (crosses repos) |
| `update_graph` | refresh this project's graph (incremental, or `full:true`) |
| `query_sql` | read-only raw SQL escape hatch over the graph schema |

Each project gets its own `graph.db`; every query is scoped to the **active
project** (`CLAUDE_PROJECT_DIR` or cwd). Override the db path with `$CODEGRAPH_DB`.

## Commands

- `/codegraph-init [dir]` — full setup (deps + build + directive + auto-update)
- `/codegraph-update` — incremental refresh (changed files only)
- `/codegraph-rebuild` — full from-scratch rebuild (correctness backstop)
- `/codegraph-status` — doctor: health, freshness, directive, posture
- `/codegraph-teardown` — soft: remove the directive + disable auto-update (keeps data for re-init)
- `/codegraph-remove` — hard uninstall: delete the graph db, `.codegraph/`, the directive, and the `.gitignore` entry; everything else untouched (`--dry-run` to preview)
- `/codegraph-build [dir]` — low-level graph build

## Auto-update (posture)

The plugin ships `SessionStart` + `PostToolUse` hooks that keep the graph current
cheaply. A per-project posture in `.codegraph/state.json` controls them:

| Posture | Behavior |
|---|---|
| `off` | hooks do nothing |
| `conservative` | SessionStart catch-up (git diff since last index) only |
| **`balanced`** (default) | + re-index each file Claude edits, in the background |
| `aggressive` | + (optional) repo git post-commit/post-merge hooks |

Change it with `node scripts/lib/state.mjs posture <project> <value>`. Background
re-indexes are surgical (one file) and preserve stable symbols' incoming edges;
the SessionStart catch-up and `/codegraph-rebuild` are the backstops.

## What it models

| Node | Meaning |
|---|---|
| `Repo` | a git repo under the project (nearest `.git` ancestor) |
| `File` | a source file, tagged with language |
| `Symbol` | a function/method/class (+ one synthetic `<module>` per file) |
| `Contract` | an AsyncAPI contract file (if a contracts dir is present) |

| Edge | Meaning | Evidence |
|---|---|---|
| `File → IN_REPO → Repo` | file belongs to repo | structural |
| `Symbol → DEFINED_IN → File` | definition location | structural |
| `Symbol → CALLS → Symbol` | resolved call, **within a repo** | `static` (name-based) |
| `Symbol → REFERENCES → Contract` | symbol mentions a wire token the contract defines | `contract-match` (heuristic) |
| `Symbol → WIRE → Symbol` | derived producer→consumer across repos | `wire-derived` (heuristic) |

Every node also carries a `project` property (namespacing). CALLS are within-repo
by design (C and TS don't share a namespace; a same-named match across repos would
be false) — genuine cross-repo links flow through `Contract` nodes.

## Blind spots (shared largely with the grep baseline)

The static graph is **blind to (a) function-pointer / callback dispatch, (b)
string literals** (JSON field names, route paths), and **(c) the C preprocessor** —
it counts call sites inside `#if 0` / disabled `#ifdef` blocks, so a C caller list
is an *upper bound*; verify compilation guards. The tool descriptions and the
installed directive both carry these caveats, so Claude reasons about indirect
paths itself and confirms exact wire fields/endpoints with a targeted query.

## Layout

```
src/extract/   walk.js, lang.js, parse.js (tree-sitter), resolve.js, contracts.js, index.js
src/store/     sqlite.js (schema + loader + per-file prune/incremental), sqlite-query.js (the tools), sqlite-export.js (gather for exports)
src/build.js   build pipeline (CLI + exported runBuild for in-process refresh)
src/mcp/       server.js (project-scoped MCP tools + graph_status/update_graph + query_sql)
src/export-*.js HTML (d3) + GEXF (Gephi) standalone visualizations
scripts/lib/   state.mjs (per-project state), git.mjs (change detection), claudemd.mjs (directive block)
scripts/hooks/ session-start.mjs, post-edit.mjs (dispatchers), refresh.mjs (background worker)
test/          run.mjs (`npm test`) — golden regression suite over a committed fixture
commands/      codegraph-{init,update,rebuild,status,teardown,remove,build}.md
hooks/         hooks.json (SessionStart + PostToolUse)
```

The whole graph for a project is the single SQLite file at
`<project>/.codegraph/graph.db` (gitignored). `node_modules/` is not part of the repo.

## Cross-platform

The store is `sql.js` (WASM) — pure JS + a bundled `.wasm`, identical on every
platform, no native build. The build also uses `tree-sitter`, which ships bundled
prebuilds for all six linux/mac/windows × x64/arm64 targets (loaded, not
compiled). So `npm install` needs no compiler and no daemon on any of them. To
validate on a new platform: `npm install --legacy-peer-deps`, then
`node src/build.js <project> --reset` and `node scripts/sqlite-cli.mjs
<project>/.codegraph/graph.db graph_stats '{}'` — expect identical counts to any
other platform built from the same source. `npm test` runs the regression suite.
