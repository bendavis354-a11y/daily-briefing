/**
 * Merge this run's results into the assistant state and write the encrypted
 * state.enc for the deploy step to commit to claude/briefing. Reads the current
 * state from the same repo store (see state-store.mjs); no Google credentials
 * are involved anywhere in state persistence.
 */
import fs from 'node:fs';
import { retainTasks, updatePatterns } from './tasks.mjs';
import { loadDurableState, saveStateLocal, STATE_FILE } from './state-store.mjs';

const now = new Date();
const nextStateOut = process.env.NEXT_STATE_FILE || '/tmp/next-state.json';

// Load cached state update data (conversations + todos) from the gather step.
const updateData = JSON.parse(fs.readFileSync('/tmp/briefing-state-update.json', 'utf8'));

// Load the current state to merge onto (encrypted repo store; see state-store.mjs).
const currentState = loadDurableState();

// Rebuild conversations map (durable memory for ignore/snooze/done + continuity).
const newConversations = { ...currentState.conversations };
for (const c of updateData.conversations) {
  const key = c.conversationKey;
  const prior = currentState.conversations[key] || {};
  newConversations[key] = {
    conversationKey: key,
    status: c.status,
    accountsSeen: c.accountsSeen,
    latestRfcMessageId: c.latestRfcMessageId || prior.latestRfcMessageId,
    subject: c.latestSubject || prior.subject,
    from: prior.from,
    gmailThreadIdByAccount: {
      ...(prior.gmailThreadIdByAccount || {}),
      ...(c.sourceAccount && c.latestGmailThreadId ? { [c.sourceAccount]: c.latestGmailThreadId } : {})
    },
    lastSeenAt: now.toISOString(),
    summary: prior.summary || '',
    gmailThreadIds: prior.gmailThreadIds || []
  };
}

// Persist storylines — the narrative memory that lets tomorrow's briefing tell
// a continuing story instead of starting cold. Each arc carries a compact
// `memory` line ("what to remember for tomorrow"). Keep arcs briefed within the
// last 45 days; stale storylines age out.
const CUTOFF_MS = 45 * 24 * 3600 * 1000;
const storylines = {};
for (const [id, s] of Object.entries(currentState.storylines || {})) {
  const last = Date.parse(s.lastBriefedAt || 0);
  if (last && now - last < CUTOFF_MS) storylines[id] = s;
}
for (const arc of updateData.arcs || []) {
  const prior = storylines[arc.id] || {};
  storylines[arc.id] = {
    ...prior,
    id: arc.id,
    title: arc.title,
    account: arc.account || prior.account || '',
    status: arc.status,
    priority: arc.priority,
    memory: arc.memory,
    // Rolling history of the last few briefed beats, oldest → newest.
    history: [...(prior.history || []), `${now.toISOString().slice(0, 10)}: ${arc.memory}`].slice(-7),
    conversationKeys: [...new Set([...(prior.conversationKeys || []), ...(arc.conversationKeys || [])])].slice(-20),
    lastBriefedAt: now.toISOString()
  };
  // Stamp member conversations with their arc so continuity survives re-keying.
  for (const key of arc.conversationKeys || []) {
    if (newConversations[key]) newConversations[key].arcId = arc.id;
  }
}

// Build the action-item set. Items accumulate rather than being replaced: an
// item stays in memory until completed, so it keeps appearing in the briefing
// across days. Completion state from the gather step (auto-completed when the
// sent-mail scan shows Ben replied) is preserved; completed items linger one
// day past detection, open items age out after 45 days (retainTasks).
const tasksById = new Map();
for (const prior of currentState.openTasks || []) {
  if (prior.id) tasksById.set(prior.id, prior);
}
for (const t of updateData.todos || []) {
  const id = t.id || `task-${t.account || ''}-${t.text || ''}`;
  const prior = tasksById.get(id);
  tasksById.set(id, {
    id,
    text: t.text || prior?.text || '',
    priority: t.priority || prior?.priority || 'medium',
    account: t.account || prior?.account || '',
    conversationKey: t.conversationKey || prior?.conversationKey || '',
    origin: t.origin || prior?.origin || 'email',
    addedAt: t.addedAt || prior?.addedAt || now.toISOString(),
    lastSeenAt: now.toISOString(),
    ...(t.status === 'completed' || prior?.status === 'completed'
      ? {
          status: 'completed',
          completedAt: t.completedAt || prior?.completedAt,
          completedBy: t.completedBy || prior?.completedBy || 'reply',
          detectedAt: t.detectedAt || prior?.detectedAt
        }
      : {})
  });
}
const openTasks = retainTasks([...tasksById.values()], now);

// Fold observed Ben-replies into the per-correspondent habit profile. The
// lastReplyAt guard inside updatePatterns keeps re-observed replies (sent mail
// stays in the scan window for 14 days) from double-counting.
const patterns = updatePatterns(currentState.patterns, updateData.replyObservations || [], now);

// Build recent runs (keep last 14)
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: updateData.conversations.length,
  todos: (updateData.todos || []).length
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

const updatedState = {
  ...currentState,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  storylines,
  openTasks,
  patterns,
  recentRuns
};

// Persist: encrypted state file at the repo root, committed to claude/briefing
// by the deploy step. A plaintext copy goes to /tmp for inspection only.
saveStateLocal(updatedState);
fs.writeFileSync(nextStateOut, JSON.stringify(updatedState, null, 2));
console.log(`State written to ${STATE_FILE} (conversations=${Object.keys(newConversations).length}, ` +
  `storylines=${Object.keys(storylines).length}, tasks=${openTasks.length}). Deploy step commits it.`);
