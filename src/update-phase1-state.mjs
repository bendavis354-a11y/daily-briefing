/**
 * Updates Drive state after a successful build.
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { writeState, emptyState } from './drive-state.mjs';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const fileId = process.env.DRIVE_STATE_FILE_ID;
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');

const { assistantState, conversations } = JSON.parse(fs.readFileSync('/tmp/phase1-output.json', 'utf8'));
const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

const NOW = new Date();
const firstAccount = accounts[0];
const driveRefreshToken = process.env[firstAccount.refreshTokenEnv];
const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });

// Build updated conversations map
const updatedConversations = { ...assistantState.conversations };
for (const convo of conversations) {
  const { conversationKey, latestMessage: msg, status, accountsSeen } = convo;
  if (!msg) continue;

  const existing = updatedConversations[conversationKey] || {};
  updatedConversations[conversationKey] = {
    ...existing,
    conversationKey,
    status,
    accountsSeen,
    latestGmailThreadId: msg.gmailThreadId,
    latestRfcMessageId: msg.rfcMessageId,
    subject: msg.subject,
    latestSender: msg.from,
    lastSeenAt: NOW.toISOString(),
    summary: existing.summary || (msg.snippet ? msg.snippet.slice(0, 200) : undefined)
  };
}

// Build recent run entry
const thisRun = {
  runAt: NOW.toISOString(),
  date: '2026-05-31',
  emailsScanned: briefing.stats.emailsScanned,
  urgent: briefing.stats.urgent,
  eventsTomorrow: briefing.stats.eventsTomorrow,
  suggestedReplies: briefing.stats.suggestedReplies,
  todos: briefing.stats.todos,
  liveUrl: briefing.metadata.liveUrl
};

const recentRuns = [...(assistantState.recentRuns || []).filter(r => r && r.runAt), thisRun]
  .sort((a, b) => String(b.runAt).localeCompare(String(a.runAt)))
  .slice(0, 14);

// Build open tasks from briefing todos (excluding duplicates)
const newOpenTasks = briefing.sections.todos.map(t => ({
  account: t.account,
  priority: t.priority,
  text: t.text,
  conversationKey: t.conversationKey,
  addedAt: NOW.toISOString(),
  done: false
}));

const updatedState = {
  ...assistantState,
  version: 2,
  updatedAt: NOW.toISOString(),
  conversations: updatedConversations,
  openTasks: newOpenTasks,
  recentRuns
};

process.stderr.write(`[state] writing to Drive (${Object.keys(updatedConversations).length} conversations)...\n`);
await writeState({ accessToken: driveToken, fileId, state: updatedState });
process.stderr.write(`[state] Drive state updated successfully\n`);
