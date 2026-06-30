// Contract INFERENCE: turn cross-repo communication signals observed in code —
// HTTP routes and message topics today — into a draft AsyncAPI 3.0 spec, so
// wiregraph builds the cross-service graph without hand-written contracts. The
// synthesized spec is consumed by the EXISTING pipeline unchanged (loadContracts
// -> matchContracts -> buildWireEdges in src/extract/contracts.js).
//
// Detectors (src/extract/parse.js) emit candidates { kind, token, role, label };
// here we cluster the distinctive tokens shared by >= 2 repos into seams and
// synthesize one AsyncAPI channel per seam. CRITICAL round-trip: the channel
// `address` is what collectTokens reads back (a path is {param}-trimmed to a
// prefix; a non-path topic is matched literally), so the inferred spec lights up
// REFERENCES edges from every repo that mentions the token. Drafts are PROPOSED,
// evidence-tagged, never silently written — direction is heuristic, the shared
// token is the real signal.

import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { walkSources } from '../extract/walk.js';
import { parseSource } from '../extract/parse.js';
import { isDistinctive } from '../extract/contracts.js';

// --- 1. extract contract candidates across the workspace --------------------
// Mirrors extractCode's walk loop, collecting the `candidates` parseSource now
// returns. fileFilter (optional Set of abs paths) restricts the scan.
export function extractCandidates(root, fileFilter = null) {
  const out = [];
  for (const f of walkSources(root)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    let src;
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseSource(src, f.lang, f.variant); } catch { continue; }
    for (const c of parsed.candidates || []) {
      out.push({ kind: c.kind, token: c.token, role: c.role, label: c.label, repo: f.repo, file: f.relPath, line: c.line });
    }
  }
  return out;
}

// --- 2. cluster shared tokens into cross-repo seams -------------------------
// HTTP path -> AsyncAPI address form (`:id`/`<id>` -> `{id}`) so variants group
// and collectTokens' {param}-trim applies; message topics are kept verbatim.
export function toAsyncApiPath(p) {
  return '/' + String(p).split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) return `{${seg.slice(1)}}`;
    if (seg.startsWith('{') && seg.endsWith('}')) return seg;
    if (seg.startsWith('<') && seg.endsWith('>')) return `{${seg.slice(1, -1)}}`;
    return seg;
  }).join('/');
}

function normToken(kind, token) {
  return kind === 'wire' ? toAsyncApiPath(token) : token;
}

function channelKey(kind, token) {
  const base = token.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}-${base || 'x'}`.toLowerCase();
}

// Group candidates by (kind, normalized token); keep tokens that are distinctive
// AND span >= 2 distinct repos (the cross-repo seam — a single-repo token is not
// a contract). Returns [{ kind, token, repos, inRepos, outRepos, labels }].
export function clusterSeams(candidates) {
  const groups = new Map(); // key -> { kind, token, repos: Map(repo->Set(role)), labels: Set }
  for (const c of candidates) {
    const tok = normToken(c.kind, c.token);
    if (!isDistinctive(tok)) continue;
    const key = `${c.kind}\0${tok}`;
    if (!groups.has(key)) groups.set(key, { kind: c.kind, token: tok, repos: new Map(), labels: new Set() });
    const g = groups.get(key);
    if (!g.repos.has(c.repo)) g.repos.set(c.repo, new Set());
    g.repos.get(c.repo).add(c.role);
    if (c.label) g.labels.add(c.label);
  }
  const seams = [];
  for (const g of groups.values()) {
    if (g.repos.size < 2) continue;
    const inRepos = [...g.repos].filter(([, roles]) => roles.has('in')).map(([r]) => r).sort();
    const outRepos = [...g.repos].filter(([, roles]) => roles.has('out')).map(([r]) => r).sort();
    seams.push({ kind: g.kind, token: g.token, repos: [...g.repos.keys()].sort(), inRepos, outRepos, labels: [...g.labels].sort() });
  }
  return seams.sort((a, b) => (a.kind + a.token).localeCompare(b.kind + b.token));
}

// --- 3. synthesize a draft AsyncAPI 3.0 doc ---------------------------------
// One channel per seam, address = the token (path or topic). A server-perspective
// `receive` operation per channel; the cross-repo REFERENCES link the seam creates
// doesn't depend on exact direction.
export function synthesizeAsyncApi(seams, title = 'wiregraph-inferred') {
  const channels = {};
  const operations = {};
  for (const s of seams) {
    const key = channelKey(s.kind, s.token);
    channels[key] = { address: s.token, messages: { request: { payload: { type: 'object', properties: {} } } } };
    operations[`receive-${key}`] = {
      action: 'receive',
      channel: { $ref: `#/channels/${key}` },
      messages: [{ $ref: `#/channels/${key}/messages/request` }],
    };
  }
  return YAML.stringify({ asyncapi: '3.0.0', info: { title, version: '0.1.0' }, channels, operations });
}

// One-shot: candidates for a root -> seams. Convenience for the CLI/tests.
export function inferSeams(root, fileFilter = null) {
  return clusterSeams(extractCandidates(root, fileFilter));
}

// Human-readable summary of what was found (for the command output).
export function formatSeams(seams) {
  if (!seams.length) {
    return [
      'No cross-repo contract seams to infer. That is often expected — common reasons:',
      '  • you already have hand-written AsyncAPI contracts: those are matched directly,',
      '    so there is nothing left to infer (see the contract count in /wiregraph-status);',
      '  • comms use a mechanism the scan does not pair yet (dynamic URLs, in-process',
      '    calls), rather than a literal route/topic string shared across repos;',
      '  • the related repos are not indexed together in one workspace.',
    ].join('\n');
  }
  const lines = [`Found ${seams.length} cross-repo seam(s):`, ''];
  for (const s of seams) {
    const head = s.kind === 'wire'
      ? `  [wire] ${(s.labels.join('/') || 'http').toUpperCase()} ${s.token}`
      : `  [${s.kind}] ${s.token}`;
    lines.push(head);
    const dir = [];
    if (s.inRepos.length) dir.push(`in: ${s.inRepos.join(', ')}`);
    if (s.outRepos.length) dir.push(`out: ${s.outRepos.join(', ')}`);
    lines.push(`      repos: ${s.repos.join(', ')}${dir.length ? ' — ' + dir.join('; ') : ''}`);
  }
  return lines.join('\n');
}
