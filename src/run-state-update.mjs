/**
 * Update assistant state after a successful build.
 *
 * Durable connector path (default for the daily routine): the agent loads the
 * newest Drive state through the connector into CONNECTOR_STATE_FILE. This step
 * merges the run into that copy and writes the next state to /tmp/next-state.json
 * — no network calls — which the agent then uploads with the connector. Nothing
 * here depends on the weekly-expiring personal token.
 *
 * OAuth path (when CONNECTOR_STATE_FILE is unset): read the fixed Drive state
 * file over a durable Workspace token and overwrite it in place.
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, writeState } from './drive-state.mjs';
import { pickDriveAccount } from './accounts.mjs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;
const statePayloadFile = process.env.STATE_PAYLOAD_FILE || '/tmp/briefing-state-full.json';
const nextStateFile = process.env.NEXT_STATE_FILE || '/tmp/next-state.json';

// Load the run payload written by run-full-briefing.mjs.
const payload = JSON.parse(fs.readFileSync(statePayloadFile, 'utf8'));
const runConversations = payload.conversations || [];
const todos = payload.briefing?.sections?.todos || [];

// Load the current state. Prefer the connector-read copy (durable); otherwise
// authenticate a durable Workspace account and read the fixed Drive file.
let currentState;
let driveToken;
let driveFileId;
if (connectorStateFile) {
  currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
} else {
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  driveFileId = process.env.DRIVE_STATE_FILE_ID;
  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
  currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
}

// Rebuild the conversations map from THIS run's active set only. The map
// accumulates one entry per conversation ever seen and would grow unbounded,
// which eventually overflows the durable connector upload — so prune to the
// conversations seen in this run (their prior data merged in), while
// ignored/snoozed conversations, tasks, people, prefs and recentRuns below are
// preserved in full. Entries are stored compactly: only the fields the gather
// pipeline reads back (status, latestRfcMessageId, subject, summary,
// accountsSeen, gmailThreadIdByAccount, todoAdded).
const priorConversations = currentState.conversations || {};
const newConversations = {};
for (const c of runConversations) {
  const key = c.conversationKey;
  const prior = priorConversations[key] || {};
  const entry = {
    status: c.status,
    latestRfcMessageId: c.latestRfcMessageId || prior.latestRfcMessageId,
    subject: c.latestSubject || prior.subject,
    accountsSeen: c.accountsSeen,
    gmailThreadIdByAccount: {
      ...(prior.gmailThreadIdByAccount || {}),
      ...(c.gmailThreadIdByAccount || {}),
      ...(c.sourceAccount && c.latestGmailThreadId ? { [c.sourceAccount]: c.latestGmailThreadId } : {})
    }
  };
  const summary = prior.summary || '';
  if (summary) entry.summary = summary;
  if (prior.from) entry.from = prior.from;
  if (prior.todoAdded) entry.todoAdded = prior.todoAdded;
  newConversations[key] = entry;
}
const keptKeys = new Set(Object.keys(newConversations));
const prunedCount = Object.keys(priorConversations).filter(k => !keptKeys.has(k)).length;

// Build open tasks from todos.
const openTasks = todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account,
  addedAt: now.toISOString()
}));

// Build recent runs (keep last 14).
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: runConversations.length,
  todos: todos.length
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

const updatedState = {
  ...currentState,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  openTasks,
  recentRuns,
  _meta: {
    compactedAt: now.toISOString(),
    reason: 'conversations pruned to this run active set for connector upload size; ignored/snoozed/tasks/people/prefs/recentRuns preserved in full',
    conversationsKept: keptKeys.size,
    conversationsPruned: prunedCount
  }
};

if (connectorStateFile) {
  // No network: hand the next state back to the agent for connector upload.
  fs.writeFileSync(nextStateFile, JSON.stringify(updatedState, null, 2));
  console.log(`Next state written to ${nextStateFile}. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
} else {
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: updatedState });
  console.log(`Drive state updated. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
}
