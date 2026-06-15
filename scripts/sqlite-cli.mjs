#!/usr/bin/env node
// Spike: invoke the SQLite-backed tools, mirroring mcp-cli.
//   node sqlite-cli.mjs <db> <tool> '<json-args>'
import { connect } from '../src/store/sqlite.js';
import * as Q from '../src/store/sqlite-query.js';

const [, , dbPath, tool, argsJson] = process.argv;
if (!dbPath || !tool) { console.error('usage: sqlite-cli.mjs <db> <tool> <json>'); process.exit(2); }
const a = argsJson ? JSON.parse(argsJson) : {};
const db = connect(dbPath, { readonly: true });
const project = db.prepare('SELECT project FROM symbols LIMIT 1').get()?.project;

const out = (() => {
  switch (tool) {
    case 'graph_stats': return Q.graphStats(db, project);
    case 'find_symbol': return Q.findSymbol(db, project, a.name, a.repo);
    case 'get_source': return Q.getSource(db, project, a.name, a.repo, a.file, a.context);
    case 'trace_callers': return Q.traceCallers(db, project, a.name, a.repo, a.file, a.depth, a.includeTests);
    case 'trace_callees': return Q.traceCallees(db, project, a.name, a.repo, a.file, a.depth, a.includeTests);
    case 'trace_contract': return Q.traceContract(db, project, a.contract, a.token, a.includeTests);
    case 'path_between': return Q.pathBetween(db, project, a.from, a.to, a.fromRepo, a.toRepo, a.maxHops);
    default: return `unknown tool: ${tool}`;
  }
})();
console.log(out);
db.close();
