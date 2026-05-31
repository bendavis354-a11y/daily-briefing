import { writeState } from './drive-state.mjs';
import { readFileSync } from 'fs';

const payload = JSON.parse(readFileSync('/tmp/briefing-state.json', 'utf8'));
const { driveAccessToken, driveFileId, conversations, briefing, assistantState } = payload;

const NOW = new Date();

// Build updated conversation map (compact, no full bodies)
const updatedConversations = { ...assistantState.conversations };
for (const convo of conversations) {
  const key = convo.conversationKey;
  const latest = convo.latestMessage;
  const prior = updatedConversations[key] || {};

  updatedConversations[key] = {
    conversationKey: key,
    status: convo.status,
    accountsSeen: convo.accountsSeen,
    latestRfcMessageId: latest.rfcMessageId || prior.latestRfcMessageId || '',
    subject: latest.subject || prior.subject || '',
    from: latest.from || prior.from || '',
    gmailThreadIdByAccount: {
      ...(prior.gmailThreadIdByAccount || {}),
      ...(latest.sourceAccount ? { [latest.sourceAccount]: latest.gmailThreadId } : {})
    },
    lastSeenAt: latest.internalDate ? new Date(latest.internalDate).toISOString() : prior.lastSeenAt,
    summary: prior.summary || (latest.snippet || '').slice(0, 200)
  };
}

// Build open tasks from briefing todos
const openTasks = briefing.sections.todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account,
  createdAt: NOW.toISOString()
}));

// Keep last 14 runs
const recentRuns = [
  ...(assistantState.recentRuns || []).slice(-13),
  {
    completedAt: NOW.toISOString(),
    emailsScanned: briefing.stats.emailsScanned,
    urgent: briefing.stats.urgent,
    eventsTomorrow: briefing.stats.eventsTomorrow
  }
];

const newState = {
  ...assistantState,
  version: 2,
  updatedAt: NOW.toISOString(),
  conversations: updatedConversations,
  openTasks,
  recentRuns,
  ignoredConversations: assistantState.ignoredConversations || {},
  snoozedConversations: assistantState.snoozedConversations || {}
};

await writeState({ accessToken: driveAccessToken, fileId: driveFileId, state: newState });
console.log('Drive state updated successfully');
