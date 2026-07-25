/**
 * Merge the agent-written brief into briefing.json and carry item memory
 * into the state-update payload.
 *
 * The daily routine's analysis step writes /tmp/brief.json following the
 * `brief` block of schemas/briefing.schema.json (BLUF + numbered priority
 * items). This script:
 *   1. validates it (clear errors so the agent can self-correct and rerun),
 *   2. backfills thread links from the gathered sections by conversationKey,
 *   3. sets briefing.brief and rewrites briefing.json,
 *   4. appends each item's `memory` to /tmp/briefing-state-update.json so
 *      run-state-update.mjs persists storylines for tomorrow's run.
 *
 * No reply drafting: items link Ben to the source thread only.
 *
 * Usage: node src/merge-narrative.mjs [/tmp/brief.json]
 */
import fs from 'node:fs';

const briefPath = process.argv[2] || process.env.BRIEF_JSON || '/tmp/brief.json';
const briefingPath = process.env.BRIEFING_JSON || 'briefing.json';
const stateUpdatePath = '/tmp/briefing-state-update.json';

const fail = msg => { console.error(`BRIEF INVALID: ${msg}`); process.exit(1); };

let brief;
try {
  brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
} catch (err) {
  fail(`cannot read ${briefPath}: ${err.message}`);
}

// ── Structural validation (friendly errors for the agent) ────────────────────
if (!brief.bottomLine || typeof brief.bottomLine !== 'string') fail('missing "bottomLine" (1–3 sentence BLUF)');
if (brief.bottomLine.length > 400) fail('"bottomLine" over 400 chars — this is a BLUF, tighten it');
if (brief.keyPoints && (!Array.isArray(brief.keyPoints) || brief.keyPoints.length > 5)) fail('"keyPoints" must be an array of at most 5 strings');
if (!Array.isArray(brief.items) || brief.items.length === 0) fail('"items" must be a non-empty array (3–6 priority items)');
if (brief.items.length > 6) fail(`${brief.items.length} items — cap is 6; demote the extras to otherDevelopments`);

const STATUSES = ['action_required', 'awaiting_reply', 'monitoring', 'new', 'resolved'];
brief.items.forEach((item, i) => {
  const at = `items[${i}]`;
  if (!item.id) fail(`${at}: missing "id" (stable slug, e.g. "bda-abo-funds")`);
  if (!item.title) fail(`${at}: missing "title"`);
  if (!item.development) fail(`${at}: missing "development" (what changed since the last brief)`);
  if (!item.status) fail(`${at}: missing "status"`);
  if (!STATUSES.includes(item.status)) fail(`${at}: status "${item.status}" not one of ${STATUSES.join('/')}`);
  if (item.status === 'action_required' && !item.action) fail(`${at}: status is action_required but "action" is empty`);
  if (item.calendarSuggestion && !item.calendarSuggestion.title) fail(`${at}.calendarSuggestion: needs "title"`);
  // Hard rule: no drafted replies anywhere in the brief.
  if (item.actions || item.replyDraft || item.body) fail(`${at}: reply drafts / action buttons are not permitted — items link to the thread only`);
});

for (const [i, d] of (brief.otherDevelopments || []).entries()) {
  if (!d.text) fail(`otherDevelopments[${i}]: missing "text"`);
}

// ── Merge into briefing.json ─────────────────────────────────────────────────
const briefing = JSON.parse(fs.readFileSync(briefingPath, 'utf8'));

// Backfill thread links from gathered items so every brief item can deep-link.
const byKey = new Map();
for (const list of Object.values(briefing.sections || {})) {
  if (!Array.isArray(list)) continue;
  for (const item of list) {
    if (item?.conversationKey && !byKey.has(item.conversationKey)) byKey.set(item.conversationKey, item);
  }
}
for (const item of brief.items) {
  if (!item.viewThreadId) {
    const hit = (item.conversationKeys || []).map(k => byKey.get(k)).find(Boolean);
    if (hit) {
      item.viewThreadAccount = item.viewThreadAccount || hit.viewThreadAccount || hit.sourceAccount;
      item.viewThreadId = hit.viewThreadId || hit.gmailThreadId;
    }
  }
}

briefing.brief = brief;
delete briefing.narrative; // retire the old block if a stale one is present
fs.writeFileSync(briefingPath, JSON.stringify(briefing, null, 2));
console.log(`Brief merged into ${briefingPath} (${brief.items.length} items, ${(brief.otherDevelopments || []).length} other developments)`);

// ── Carry item memory into the state-update payload ──────────────────────────
try {
  const update = JSON.parse(fs.readFileSync(stateUpdatePath, 'utf8'));
  update.arcs = brief.items.map(it => ({
    id: it.id,
    title: it.title,
    account: it.account || '',
    status: it.status,
    priority: it.priority || 3,
    memory: it.memory || it.development || '',
    conversationKeys: it.conversationKeys || []
  }));
  fs.writeFileSync(stateUpdatePath, JSON.stringify(update, null, 2));
  console.log(`Item memory staged for state update (${update.arcs.length} storylines)`);
} catch (err) {
  console.warn(`Could not stage item memory (${err.message}) — run the gather step before merge-narrative.`);
}
