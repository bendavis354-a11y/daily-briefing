/**
 * Cross-account conversation continuity + dedup.
 *
 * Messages arrive from two kinds of source:
 *   - OAuth mailboxes (Workspace): carry full RFC822 headers
 *     (rfcMessageId / references / inReplyTo). These key threading exactly.
 *   - Connector mailbox (personal gmail.com): read through the Gmail connector,
 *     which does NOT expose RFC822 headers. These carry a per-account Gmail
 *     thread id instead. They key threading by `gmailThreadId`, and merge with
 *     an OAuth copy of the same message via a tight content key.
 *
 * Because a single message can land in two of Ben's mailboxes (e.g. addressed
 * to both his personal and Heartspring addresses), dedup unions messages that
 * share EITHER an RFC Message-ID OR a tight content key. The surviving
 * representative prefers the header-ful copy, so downstream threading keeps
 * working on real Message-IDs while the personal copy's Gmail thread id is
 * preserved for "view in Gmail" links.
 */

export function buildConversationKey(message) {
  if (message.references?.length) return message.references[0];
  if (message.inReplyTo) return message.inReplyTo;
  if (message.rfcMessageId) return message.rfcMessageId;
  // Header-less (connector) message: keep the thread intact via Gmail's own
  // per-account thread id. Scoped by account so it never collides across
  // mailboxes.
  if (message.gmailThreadId) return `gthread:${clean(message.sourceAccount)}:${message.gmailThreadId}`;
  return fallbackMessageKey(message);
}

export function dedupeMessages(messages) {
  // Union-find over messages. Two messages are the same if they share an RFC
  // Message-ID or a tight content key (same normalized subject, participant set,
  // minute bucket, and snippet prefix). This collapses the personal-mailbox copy
  // and the Workspace copy of one message into a single representative.
  const parent = messages.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const byRfc = new Map();
  const byContent = new Map();

  messages.forEach((msg, i) => {
    if (msg.rfcMessageId) {
      if (byRfc.has(msg.rfcMessageId)) union(i, byRfc.get(msg.rfcMessageId));
      else byRfc.set(msg.rfcMessageId, i);
    }
    const ck = dedupContentKey(msg);
    if (ck) {
      if (byContent.has(ck)) union(i, byContent.get(ck));
      else byContent.set(ck, i);
    }
  });

  const clusters = new Map();
  messages.forEach((_, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  });

  const out = [];
  for (const idxs of clusters.values()) {
    const cluster = idxs.map(i => messages[i]);
    out.push(mergeCluster(cluster));
  }
  return out;
}

export function groupConversations(messages, benAccounts) {
  const conversations = new Map();

  for (const msg of messages) {
    const key = buildConversationKey(msg);
    if (!conversations.has(key)) {
      conversations.set(key, {
        conversationKey: key,
        accountsSeen: new Set(),
        messages: []
      });
    }

    const convo = conversations.get(key);
    convo.accountsSeen.add(msg.sourceAccount);
    convo.messages.push({
      ...msg,
      fromMe: isFromBen(msg.from, benAccounts)
    });
  }

  for (const convo of conversations.values()) {
    convo.accountsSeen = [...convo.accountsSeen];
    convo.messages.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));
    convo.latestMessage = convo.messages[convo.messages.length - 1];
    convo.status = inferStatus(convo);
  }

  return [...conversations.values()];
}

export function inferStatus(convo) {
  const latest = convo.messages[convo.messages.length - 1];
  if (!latest) return 'unknown';
  if (latest.fromMe) return 'waiting_on_other';
  if (looksNoReplyNeeded(latest)) return 'fyi';
  return 'waiting_on_ben';
}

function isFromBen(fromHeader, benAccounts) {
  const from = String(fromHeader || '').toLowerCase();
  return benAccounts.some(email => from.includes(email.toLowerCase()));
}

function looksNoReplyNeeded(msg) {
  const labels = msg.labelIds || [];
  const subject = String(msg.subject || '').toLowerCase();
  const from = String(msg.from || '').toLowerCase();
  return (
    labels.includes('CATEGORY_PROMOTIONS') ||
    labels.includes('CATEGORY_SOCIAL') ||
    subject.includes('newsletter') ||
    subject.includes('receipt') ||
    from.includes('no-reply') ||
    from.includes('noreply')
  );
}

/**
 * Merge a cluster of duplicate messages into one representative.
 * Prefers a non-forwarded, header-ful copy so RFC threading survives, while
 * preserving every mailbox's Gmail thread id for links.
 */
function mergeCluster(cluster) {
  const rep = cluster.reduce((best, msg) => preferOriginal(best, msg));

  // Preserve per-account Gmail thread ids from every copy in the cluster.
  const threadIds = { ...(rep.gmailThreadIdByAccount || {}) };
  for (const msg of cluster) {
    if (msg.sourceAccount && msg.gmailThreadId) threadIds[msg.sourceAccount] = msg.gmailThreadId;
  }

  // Backfill RFC identity from any copy that has it (connector copy may lack it).
  const withRfc = cluster.find(m => m.rfcMessageId);
  const withRefs = cluster.find(m => m.references?.length);

  return {
    ...rep,
    rfcMessageId: rep.rfcMessageId || withRfc?.rfcMessageId || '',
    references: rep.references?.length ? rep.references : (withRefs?.references || []),
    inReplyTo: rep.inReplyTo || cluster.find(m => m.inReplyTo)?.inReplyTo || '',
    gmailThreadIdByAccount: threadIds,
    accountsSeen: [...new Set(cluster.map(m => m.sourceAccount).filter(Boolean))]
  };
}

function preferOriginal(a, b) {
  // Prefer the copy delivered to its own mailbox over a forwarded copy.
  if (looksForwarded(a) && !looksForwarded(b)) return b;
  if (looksForwarded(b) && !looksForwarded(a)) return a;
  // Otherwise prefer the header-ful copy (real RFC Message-ID).
  if (a.rfcMessageId && !b.rfcMessageId) return a;
  if (b.rfcMessageId && !a.rfcMessageId) return b;
  return a;
}

function looksForwarded(msg) {
  const delivered = `${msg.deliveredTo || ''} ${msg.originalTo || ''}`.toLowerCase();
  if (!delivered) return false;
  return !delivered.includes(String(msg.sourceAccount || '').toLowerCase());
}

/**
 * Tight key for detecting the SAME message seen in two mailboxes.
 * Deliberately narrow (normalized subject + participant set + minute bucket +
 * snippet prefix) so it never collapses two distinct messages of one thread.
 */
function dedupContentKey(msg) {
  const subject = normalizeSubject(msg.subject);
  const participants = participantSet(msg);
  const minute = msg.internalDate ? Math.floor(Number(msg.internalDate) / 60000) : '';
  const snip = clean(msg.snippet).slice(0, 60);
  if (!subject && !participants && !snip) return '';
  return ['c', subject, participants, minute, snip].join('|');
}

function participantSet(msg) {
  const emails = new Set();
  for (const field of [msg.from, msg.to, msg.cc]) {
    for (const m of String(field || '').matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+/gi)) {
      emails.add(m[0].toLowerCase());
    }
  }
  return [...emails].sort().join(',');
}

function normalizeSubject(subject) {
  return clean(subject).replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim();
}

function fallbackMessageKey(msg) {
  const dateBucket = msg.internalDate ? Math.floor(msg.internalDate / 60000) : '';
  return [
    clean(msg.from),
    clean(msg.subject),
    dateBucket,
    clean(msg.snippet).slice(0, 120)
  ].join('|');
}

function clean(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
