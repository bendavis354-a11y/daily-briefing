/**
 * Update the Ben-assistant state after a successful build.
 *
 * Two modes, selected by whether CONNECTOR_STATE_FILE is set:
 *
 *   Durable connector mode (CONNECTOR_STATE_FILE set) — the default for the
 *   scheduled routine. Reads the base state from the connector copy on disk,
 *   merges this run into it, and writes the next state to /tmp/next-state.json.
 *   Makes NO network calls; the agent then uploads /tmp/next-state.json to
 *   Drive with the durable Workspace connector. This path never depends on the
 *   weekly-expiring personal Drive token.
 *
 *   Legacy Drive-write mode (CONNECTOR_STATE_FILE unset) — reads and writes a
 *   single fixed Drive file over OAuth on the durable Workspace account. Use
 *   this only once a Workspace account is authorized with a Drive scope.
 *
 * Run data comes from /tmp/briefing-state-full.json, written by
 * src/run-full-briefing.mjs.
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, writeState } from './drive-state.mjs';
import { pickDriveAccount } from './accounts.mjs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;
const runDataFile = process.env.BRIEFING_STATE_FILE || '/tmp/briefing-state-full.json';
const nextStateFile = process.env.NEXT_STATE_FILE || '/tmp/next-state.json';

// This run's gathered data (conversations, rendered briefing, prior state).
const runData = JSON.parse(fs.readFileSync(runDataFile, 'utf8'));

// ── Load the base state ───────────────────────────────────────────────────────
let currentState;
let driveToken = null;
let driveFileId = process.env.DRIVE_STATE_FILE_ID || runData.driveFileId;

if (connectorStateFile) {
  // Durable path: base state is the connector copy the agent downloaded.
  currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
} else {
  // Legacy path: read the base state from Drive over OAuth.
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
  currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
}

// ── Merge this run's conversations into the state map ──────────────────────────
// Persisted conversations are stored slim: the map key already IS the
// conversationKey, and readers (run-full-briefing, this script) look everything
// up by key and default any absent field. So we drop the redundant inner key and
// omit empty carry-forward fields. This keeps the state file small enough to
// upload through the connector in a single call (its content is inlined) and
// bounds unbounded growth.
const conversations = runData.conversations || [];
const newConversations = { ...(currentState.conversations || {}) };
for (const c of conversations) {
  const key = c.conversationKey;
  if (!key) continue;
  const prior = currentState.conversations?.[key] || {};
  const threadIds = {
    ...(prior.gmailThreadIdByAccount || {}),
    ...(c.gmailThreadIdByAccount || {}),
    ...(c.sourceAccount && c.latestGmailThreadId ? { [c.sourceAccount]: c.latestGmailThreadId } : {})
  };
  const conv = {
    status: c.status,
    accountsSeen: c.accountsSeen || prior.accountsSeen || [],
    lastSeenAt: now.toISOString()
  };
  const latestRfcMessageId = c.latestRfcMessageId || prior.latestRfcMessageId;
  const subject = c.latestSubject || prior.subject;
  if (latestRfcMessageId) conv.latestRfcMessageId = latestRfcMessageId;
  if (subject) conv.subject = subject;
  if (prior.from) conv.from = prior.from;
  if (Object.keys(threadIds).length) conv.gmailThreadIdByAccount = threadIds;
  if (prior.summary) conv.summary = prior.summary;
  if (Array.isArray(prior.gmailThreadIds) ? prior.gmailThreadIds.length
      : prior.gmailThreadIds && Object.keys(prior.gmailThreadIds).length) {
    conv.gmailThreadIds = prior.gmailThreadIds;
  }
  newConversations[key] = conv;
}

// Compact the conversations map to this run's active set. The state file is
// uploaded to Drive as inlined connector content, so it must stay small and
// bounded — prior runs did the same (see _meta below). The active set is every
// conversation this run actually gathered; carried-over conversations not seen
// this run are dropped. They simply get re-evaluated fresh next run if still in
// the scan window (newer_than:2d / in:sent newer_than:14d) — no correctness
// loss, only a dropped carried-forward summary. User-curated maps
// (ignored/snoozed) and tasks/people/prefs/recentRuns/imessageActions are
// preserved in full elsewhere and never touched here.
const activeKeys = new Set(conversations.map(c => c.conversationKey).filter(Boolean));
const beforeCount = Object.keys(newConversations).length;
for (const key of Object.keys(newConversations)) {
  if (!activeKeys.has(key)) delete newConversations[key];
}
const keptCount = Object.keys(newConversations).length;
const pruned = beforeCount - keptCount;

// ── Rebuild open tasks from this run's todos ───────────────────────────────────
const todos = runData.briefing?.sections?.todos
  || runData.briefing?.actions?.todos
  || runData.todos
  || [];
const openTasks = todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account || t.sourceAccount,
  addedAt: now.toISOString()
}));

// ── Recent runs (keep last 14) ────────────────────────────────────────────────
const stats = runData.briefing?.stats || {};
const meta = runData.briefing?.metadata || {};
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: conversations.length,
  urgent: stats.urgent,
  eventsTomorrow: meta.eventsTomorrow ?? stats.eventsTomorrow,
  eventsThisWeek: meta.eventsThisWeek ?? stats.eventsThisWeek,
  suggestedReplies: stats.replies ?? stats.suggestedReplies,
  todos: todos.length
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

// ── Assemble the next state, preserving everything we don't touch ──────────────
const updatedState = {
  ...currentState,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  openTasks,
  recentRuns,
  _meta: {
    compactedAt: now.toISOString(),
    reason: 'conversations pruned to this run active set for connector upload size; ignored/snoozed/tasks/people/prefs/recentRuns/imessageActions preserved in full',
    conversationsKept: keptCount,
    conversationsPruned: pruned
  }
};

// ── Persist ────────────────────────────────────────────────────────────────────
if (connectorStateFile) {
  fs.writeFileSync(nextStateFile, JSON.stringify(updatedState, null, 2));
  console.log(`Next state written to ${nextStateFile}. Conversations: ${Object.keys(newConversations).length} (pruned ${pruned}). Tasks: ${openTasks.length}.`);
} else {
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: updatedState });
  console.log(`Drive state updated. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
}
