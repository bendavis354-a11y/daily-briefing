/**
 * Update assistant state after a successful build.
 *
 * Two modes, mirroring the durability model in prompts/routine-prompt.md:
 *
 *   1. Connector mode (CONNECTOR_STATE_FILE set) — the agent has already read
 *      the newest state file through the durable Drive connector and dropped it
 *      on disk. This step reads that copy, merges this run into it, and writes
 *      the result to /tmp/next-state.json. It makes NO network calls; the agent
 *      uploads /tmp/next-state.json back to Drive with the connector. This path
 *      does not depend on any Drive-scoped OAuth token, so the weekly-expiring
 *      personal token can never halt the write-back.
 *
 *   2. OAuth mode (no CONNECTOR_STATE_FILE) — re-read the fixed state file over
 *      the durable Workspace Drive token and overwrite it in place. Use this
 *      only when a Workspace account carries Drive scope (DRIVE_STATE_ACCOUNT).
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, writeState } from './drive-state.mjs';
import { pickDriveAccount } from './accounts.mjs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;
const nextStateFile = process.env.NEXT_STATE_FILE || '/tmp/next-state.json';

// Cached gather output written by run-full-briefing.mjs.
const payloadPath = process.env.BRIEFING_STATE_FILE || '/tmp/briefing-state-full.json';
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const scannedConversations = payload.conversations || [];
const todos = payload.briefing?.sections?.todos || [];
const stats = payload.briefing?.stats || {};

// ── Load current state ────────────────────────────────────────────────────────
let currentState;
let driveToken = null;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;

if (connectorStateFile) {
  currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
  console.log(`State loaded from connector file (version=${currentState.version}, updatedAt=${currentState.updatedAt})`);
} else {
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
  currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
  console.log(`State loaded over Drive OAuth as ${driveAccount.email} (version=${currentState.version})`);
}

// ── Merge conversations (prior map + this run's active conversations) ──────────
const newConversations = { ...(currentState.conversations || {}) };
for (const c of scannedConversations) {
  const key = c.conversationKey;
  const prior = currentState.conversations?.[key] || {};
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

// ── Open tasks from this run's todos ──────────────────────────────────────────
const openTasks = todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account,
  addedAt: now.toISOString()
}));

// ── Recent runs (keep last 14) ────────────────────────────────────────────────
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: stats.emailsScanned ?? scannedConversations.length,
  urgent: stats.urgent ?? 0,
  eventsTomorrow: stats.eventsTomorrow ?? 0,
  eventsThisWeek: stats.eventsThisWeek ?? 0,
  suggestedReplies: stats.suggestedReplies ?? 0,
  todos: todos.length,
  imessageStatus: payload.imessageStatus || 'missing'
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

// ── Assemble next state, preserving durable fields; clear pending actions ──────
const nextState = {
  ...currentState,
  version: currentState.version || 2,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  openTasks,
  ignoredConversations: currentState.ignoredConversations || {},
  snoozedConversations: currentState.snoozedConversations || {},
  people: currentState.people || {},
  preferences: currentState.preferences || { timezone: 'America/New_York', replyStyle: 'warm, concise, practical' },
  recentRuns,
  imessageActions: currentState.imessageActions || [],
  pendingActions: []
};

// ── Persist ───────────────────────────────────────────────────────────────────
if (connectorStateFile) {
  fs.writeFileSync(nextStateFile, JSON.stringify(nextState, null, 2));
  console.log(`Next state written to ${nextStateFile}. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
  console.log('Upload this file to Drive with the connector (create_file) so tomorrow\'s run reads it.');
} else {
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: nextState });
  console.log(`Drive state updated over OAuth. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
}
