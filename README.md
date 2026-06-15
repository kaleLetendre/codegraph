# codegraph

**Answer questions about your code while reading far less of it.** A Claude Code
plugin that indexes a project into a queryable graph of its symbols and how they
connect, then hands Claude tools to find and read exactly the right code instead
of grepping and opening whole files. On real codebases this cuts the tokens spent
on navigation / comprehension / audit / refactor / debugging / review work by
**~40–60% at equal accuracy** — measured across held-out A/B tests vs grep+Read.

It's an embedded **WASM SQLite** file — no daemon, no server, no JVM, and a
**toolchain-free install** (nothing compiles). One graph per project.

## Why it saves tokens

Most of the cost of answering a code question isn't the answer — it's *finding and
reading* the relevant code. codegraph makes that part cheap:

- **`find_symbol`** — jump to a definition by name instead of grepping the tree.
- **`get_source`** — read *one* function's body (e.g. 70 lines) instead of opening
  the 800-line file it lives in.
- **`trace_callers` / `trace_callees`** — get the whole call tree (who calls this /
  what this calls) in a single query instead of fanning out across files.
- **`trace_contract` / `path_between`** — follow how code connects *across repos*
  through shared API/wire contracts.
- **`query_sql`** — a read-only SQL escape hatch for anything the above don't cover.

The win grows with how large or unfamiliar the codebase is, and it does **not**
change correctness for a capable model — it just gets there reading less.

## Install → init → use

1. **Install** the plugin from your marketplace. Nothing compiles; deps are vendored.
   ```
   /plugin marketplace add <owner>/codegraph
   /plugin install codegraph@codegraph
   /reload-plugins
   ```
2. **Index a project** (run inside it):
   ```
   /codegraph-init
   ```
   Builds the graph at `<project>/.codegraph/graph.db` and (with your consent) adds
   a short directive to the project's `CLAUDE.md` that tells Claude to reach for the
   tools — this is what produces the token win.
3. **Use Claude normally.** Ask "where is X / what calls Y / what would changing Z
   break / how does A reach B" and Claude answers from the graph. It stays fresh
   automatically; if a trace looks stale, Claude refreshes it with `update_graph`.

## Tools

| Tool | What it answers |
|---|---|
| `find_symbol` | where a function/class/method is defined |
| `get_source` | the exact body of one symbol (cheaper than Read) |
| `trace_callees` | what this calls, transitively (one call) |
| `trace_callers` | who calls this, up to entrypoints (one call) |
| `trace_contract` | which code across repos touches a shared contract |
| `path_between` | how two symbols connect (crosses repos via contracts) |
| `graph_stats` / `graph_status` | size, and is the graph indexed / fresh |
| `update_graph` | refresh after edits (incremental, or `full:true`) |
| `query_sql` | read-only SQL over the graph for anything else |

## Commands

`/codegraph-init` · `/codegraph-update` (incremental refresh) ·
`/codegraph-rebuild` (full) · `/codegraph-status` (doctor) ·
`/codegraph-teardown` (disable, keep data) · `/codegraph-remove` (delete everything) ·
`/codegraph-build` (low-level build)

## Languages

Indexes **C** and **TypeScript / JavaScript** today. Adding a language is small —
roughly: add the tree-sitter grammar, map its file extensions, and write two short
functions saying *what counts as a definition* and *what counts as a call* in that
grammar. Everything downstream (the graph, the store, every tool) is
language-agnostic. See `src/extract/lang.js` and `src/extract/parse.js`.

## How it works

Tree-sitter parses each file into symbols (functions/methods/classes) and call
sites. Calls resolve by name within a repo (same file first, then same repo) —
cross-repo links aren't guessed by name; they flow through **Contract** nodes when
an AsyncAPI `*-contracts` / `asyncapi` dir is present. Symbol ids are content-stable,
so edits re-index one file at a time and the graph stays current via SessionStart +
on-edit hooks (posture: `off` / `conservative` / `balanced` (default) / `aggressive`).

## Blind spots

The graph is static and name-based, so it's blind to **function-pointer / callback
dispatch**, **string literals** (route paths, JSON field names), and the **C
preprocessor** (a C caller list is an upper bound — it includes `#if 0` sites). The
tool descriptions carry these caveats so Claude verifies indirect paths itself. Call
resolution is heuristic (no type inference), so heavily-overloaded or dynamic code
yields some ambiguous edges, flagged as such.

## Stack

`sql.js` (WASM SQLite) + `tree-sitter` parsers — both ship as portable, prebuilt /
WASM artifacts, vendored in the repo, so a clean install needs only Node. The whole
graph for a project is the single file at `<project>/.codegraph/graph.db`
(gitignored). `npm test` runs a golden regression suite over a synthetic fixture.
See `DECISIONS.md` for the architecture rationale.
