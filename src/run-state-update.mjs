/**
 * Update Drive assistant state after a successful build.
 *
 * Two modes:
 *   - Connector (durable, used by the daily routine): set CONNECTOR_STATE_FILE
 *     to the state file the agent downloaded through the Drive connector. The
 *     current state is read from that file and the merged next state is written
 *     to /tmp/next-state.json for the agent to upload with the durable connector
 *     (which can create files but not overwrite them). No network calls are made,
 *     so nothing here depends on a Drive-scoped OAuth token.
 *   - OAuth (single fixed file): run WITHOUT CONNECTOR_STATE_FILE. The current
 *     state is read from DRIVE_STATE_FILE_ID and the merged state is written back
 *     over that same file via a durable Workspace account that has Drive scope.
 *
 * This run's payload comes from /tmp/briefing-state-full.json (written by
 * run-full-briefing.mjs); its todos live in briefing.sections.todos. The legacy
 * flat /tmp/briefing-state-update.json is used only as a fallback.
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, writeState } from './drive-state.mjs';
import { pickDriveAccount } from './accounts.mjs';

const now = new Date();
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;

// ── Load this run's update data ───────────────────────────────────────────────
let updateData;
if (fs.existsSync('/tmp/briefing-state-full.json')) {
  const full = JSON.parse(fs.readFileSync('/tmp/briefing-state-full.json', 'utf8'));
  updateData = {
    conversations: full.conversations || [],
    todos: (full.briefing && full.briefing.sections && full.briefing.sections.todos) || []
  };
} else {
  updateData = JSON.parse(fs.readFileSync('/tmp/briefing-state-update.json', 'utf8'));
}

// ── Load current state (connector file, or OAuth Drive read) ───────────────────
let currentState;
let driveToken = null;
if (connectorStateFile) {
  currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
} else {
  // Re-authenticate for Drive write on the durable Workspace account (never the
  // weekly-expiring consumer token).
  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
  currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
}

// Rebuild conversations map
const newConversations = { ...(currentState.conversations || {}) };
for (const c of updateData.conversations) {
  const key = c.conversationKey;
  const prior = (currentState.conversations && currentState.conversations[key]) || {};
  newConversations[key] = {
    conversationKey: key,
    status: c.status,
    accountsSeen: c.accountsSeen,
    latestRfcMessageId: c.latestRfcMessageId || prior.latestRfcMessageId,
    subject: c.latestSubject || prior.subject,
    from: prior.from,
    gmailThreadIdByAccount: {
      ...(prior.gmailThreadIdByAccount || {}),
      ...(c.gmailThreadIdByAccount || {}),
      ...(c.sourceAccount && c.latestGmailThreadId ? { [c.sourceAccount]: c.latestGmailThreadId } : {})
    },
    lastSeenAt: now.toISOString(),
    summary: prior.summary || '',
    gmailThreadIds: prior.gmailThreadIds || []
  };
}

// Build open tasks from todos
const openTasks = updateData.todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account,
  addedAt: now.toISOString()
}));

// Build recent runs (keep last 14)
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: updateData.conversations.length,
  todos: updateData.todos.length
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

const updatedState = {
  ...currentState,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  openTasks,
  recentRuns
};

/**
 * The Drive connector can only upload state inline (create_file textContent),
 * and the agent can only reliably reproduce a bounded amount of text. Left
 * unchecked, `conversations` grows without bound (mostly one-way promotional
 * gthread entries), eventually exceeding what can be uploaded. Compact to a
 * byte budget by dropping the least-valuable conversations while preserving
 * every Workspace (RFC-keyed) thread, every two-way (waiting_on_other)
 * conversation, and all metadata (openTasks/recentRuns/people/prefs/…). Dropped
 * one-way personal mail re-derives from each run's rolling 2-day scan.
 */
function compactForConnectorUpload(state, budgetBytes = 40000) {
  if (JSON.stringify(state).length <= budgetBytes) return state;
  const runTs = state.updatedAt;
  const isPromoSubject = s =>
    /sale|% off|\bdeal|save|rewards|prequalified|preapproved|pre-qualified|\brate\b|\bloan\b|credit card|mortgage|insurance|receipt|statement|subscription|digest|e-edition|newsletter|coupon|discount|\boffer\b|cashback|fico|price alert|\bfares?\b|liquidation|clearance|final day|ends (tomorrow|friday|soon)|limited time|photo order|don.t miss/i.test(s || '');
  // Priority: 0 keep always (Workspace or two-way); 1 personal one-way seen this
  // run; 2 everything else (stale / promotional one-way). Drop highest tier
  // first, then oldest, until under budget.
  const entries = Object.entries(state.conversations || {}).map(([k, c]) => {
    let tier = 2;
    if (!k.startsWith('gthread:') || c.status === 'waiting_on_other') tier = 0;
    else if (c.lastSeenAt === runTs && !isPromoSubject(c.subject)) tier = 1;
    return { k, c, tier, seen: c.lastSeenAt || '' };
  });
  entries.sort((a, b) => (a.tier - b.tier) || (a.seen < b.seen ? -1 : 1));
  const kept = {};
  let approx = JSON.stringify({ ...state, conversations: {} }).length;
  let pruned = 0;
  for (const e of entries) {
    const cost = JSON.stringify(e.c).length + e.k.length + 4;
    if (e.tier > 0 && approx + cost > budgetBytes) { pruned++; continue; }
    kept[e.k] = e.c;
    approx += cost;
  }
  const total = entries.length;
  return {
    ...state,
    conversations: kept,
    _meta: {
      ...(state._meta || {}),
      compactedAt: runTs,
      reducedForConnectorUpload: true,
      reason: 'conversations compacted to fit the connector inline-upload budget; Workspace threads, two-way conversations, and all metadata preserved',
      fullConversationCount: total,
      conversationsKept: total - pruned,
      keptConversationCount: total - pruned,
      conversationsPruned: pruned
    }
  };
}

// ── Persist ────────────────────────────────────────────────────────────────────
if (connectorStateFile) {
  const toWrite = compactForConnectorUpload(updatedState);
  fs.writeFileSync('/tmp/next-state.json', JSON.stringify(toWrite, null, 2));
  const kept = Object.keys(toWrite.conversations).length;
  const pruned = toWrite._meta?.conversationsPruned || 0;
  console.log(
    `Next state written to /tmp/next-state.json. Conversations kept: ${kept}${pruned ? ` (pruned ${pruned} low-value one-way entries to fit upload budget)` : ''}. Tasks: ${openTasks.length}. Upload it with the Drive connector.`
  );
} else {
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: updatedState });
  console.log(`Drive state updated. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
}
