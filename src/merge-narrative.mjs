/**
 * Merge the agent-written narrative into briefing.json and carry arc memory
 * into the state-update payload.
 *
 * The daily routine's synthesis step (the agent acting as chief of staff)
 * writes /tmp/narrative.json. This script:
 *   1. validates it (clear errors so the agent can self-correct and rerun),
 *   2. backfills thread links from the gathered sections by conversationKey,
 *   3. sets briefing.narrative and rewrites briefing.json,
 *   4. appends each arc's `memory` to /tmp/briefing-state-update.json so
 *      run-state-update.mjs persists storylines for tomorrow's run.
 *
 * Usage: node src/merge-narrative.mjs [/tmp/narrative.json]
 */
import fs from 'node:fs';

const narrativePath = process.argv[2] || process.env.NARRATIVE_JSON || '/tmp/narrative.json';
const briefingPath = process.env.BRIEFING_JSON || 'briefing.json';
const stateUpdatePath = '/tmp/briefing-state-update.json';

const fail = msg => { console.error(`NARRATIVE INVALID: ${msg}`); process.exit(1); };

let narrative;
try {
  narrative = JSON.parse(fs.readFileSync(narrativePath, 'utf8'));
} catch (err) {
  fail(`cannot read ${narrativePath}: ${err.message}`);
}

// ── Structural validation (friendly errors for the agent) ────────────────────
if (!narrative.headline || typeof narrative.headline !== 'string') fail('missing "headline" (one-line string)');
if (narrative.headline.length > 160) fail('"headline" over 160 chars — tighten it');
if (!narrative.story || typeof narrative.story !== 'string') fail('missing "story" (short paragraphs, \\n\\n separated)');
if (!Array.isArray(narrative.arcs) || narrative.arcs.length === 0) fail('"arcs" must be a non-empty array (3–6 storylines)');
if (narrative.arcs.length > 6) fail(`${narrative.arcs.length} arcs — cap is 6; merge or demote the extras to quickHits`);

const TRENDS = ['rising', 'steady', 'waiting', 'stalling', 'closing', 'new'];
narrative.arcs.forEach((arc, i) => {
  const at = `arcs[${i}]`;
  if (!arc.id) fail(`${at}: missing "id" (stable slug, e.g. "bda-abo-funds")`);
  if (!arc.title) fail(`${at}: missing "title"`);
  if (!arc.today) fail(`${at}: missing "today" (what changed today)`);
  if (arc.trend && !TRENDS.includes(arc.trend)) fail(`${at}: trend "${arc.trend}" not one of ${TRENDS.join('/')}`);
  for (const [j, a] of (arc.actions || []).entries()) {
    if (!a.type || !a.label) fail(`${at}.actions[${j}]: needs "type" and "label"`);
    if (a.type === 'reply' && !a.to) fail(`${at}.actions[${j}]: reply action needs "to"`);
    if (a.type === 'open' && !(a.threadId || arc.viewThreadId)) fail(`${at}.actions[${j}]: open action needs a threadId (or arc.viewThreadId)`);
    if (a.type === 'calendar' && !a.title) fail(`${at}.actions[${j}]: calendar action needs "title"`);
  }
});

for (const [i, d] of (narrative.decisions || []).entries()) {
  if (!d.question) fail(`decisions[${i}]: missing "question"`);
}
for (const [i, q] of (narrative.quickHits || []).entries()) {
  if (!q.text) fail(`quickHits[${i}]: missing "text"`);
}

// ── Merge into briefing.json ─────────────────────────────────────────────────
const briefing = JSON.parse(fs.readFileSync(briefingPath, 'utf8'));

// Backfill thread links from gathered items so every arc can deep-link.
const byKey = new Map();
for (const list of Object.values(briefing.sections || {})) {
  if (!Array.isArray(list)) continue;
  for (const item of list) {
    if (item?.conversationKey && !byKey.has(item.conversationKey)) byKey.set(item.conversationKey, item);
  }
}
for (const arc of narrative.arcs) {
  if (!arc.viewThreadId) {
    const hit = (arc.conversationKeys || []).map(k => byKey.get(k)).find(Boolean);
    if (hit) {
      arc.viewThreadAccount = arc.viewThreadAccount || hit.viewThreadAccount || hit.sourceAccount;
      arc.viewThreadId = hit.viewThreadId || hit.gmailThreadId;
    }
  }
}

briefing.narrative = narrative;
fs.writeFileSync(briefingPath, JSON.stringify(briefing, null, 2));
console.log(`Narrative merged into ${briefingPath} (${narrative.arcs.length} arcs, ${(narrative.decisions || []).length} decisions)`);

// ── Carry arc memory into the state-update payload ───────────────────────────
try {
  const update = JSON.parse(fs.readFileSync(stateUpdatePath, 'utf8'));
  update.arcs = narrative.arcs.map(a => ({
    id: a.id,
    title: a.title,
    account: a.account || '',
    trend: a.trend || 'steady',
    stakes: a.stakes || '',
    importance: a.importance || 3,
    memory: a.memory || a.today || '',
    conversationKeys: a.conversationKeys || []
  }));
  fs.writeFileSync(stateUpdatePath, JSON.stringify(update, null, 2));
  console.log(`Arc memory staged for state update (${update.arcs.length} storylines)`);
} catch (err) {
  console.warn(`Could not stage arc memory (${err.message}) — run the gather step before merge-narrative.`);
}
