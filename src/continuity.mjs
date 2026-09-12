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
      fromMe: isFromBen(msg.from, benAccounts),
      toMeOnly: isToMeOnly(msg, benAccounts),
      namesMe: greetingNamesBen(msg.snippet)
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

/** Distinct addresses across a conversation's From, To and Cc. */
function participantCount(convo) {
  const seen = new Set();
  for (const m of convo.messages || []) {
    for (const match of String(`${m.from || ''} ${m.to || ''} ${m.cc || ''}`)
      .matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+/gi)) {
      seen.add(match[0].toLowerCase());
    }
  }
  return seen.size;
}

/**
 * Where a conversation stands.
 *
 * The subtlety is `thread_continued`. "The newest message is not Ben's" is a
 * sound test for a two-person exchange and a bad one for a committee: he votes,
 * two colleagues then reply to each other, and the thread reads as though it
 * were waiting on him. That is why the work accounts looked broken while the
 * personal one looked fine — nothing differed but the mail. He participates in
 * most work threads and few personal ones, and this only misfires on threads he
 * has already spoken in.
 *
 * The committee test looks at the whole thread's participants, which is the
 * wrong lens for the newest message: a thread that began with an introducer
 * copied in and has since become a two-way exchange was reading as "continued
 * without you" while its latest message was a question put to Ben alone. So
 * a message addressed to him individually — he is the only To recipient, or
 * its greeting names him — waits on him whatever the thread's history.
 *
 * Deliberately narrow otherwise. Two-party threads keep reading as waiting on
 * Ben even when the last word was an acknowledgement, because "thanks, will
 * do" and "so can you send it?" are not reliably distinguishable, and the cost
 * of wrongly hiding a real ask is much higher than the cost of listing one he
 * can ignore.
 */
export function inferStatus(convo) {
  const messages = convo.messages || [];
  const latest = messages[messages.length - 1];
  if (!latest) return 'unknown';
  if (latest.fromMe) return 'waiting_on_other';
  if (looksNoReplyNeeded(latest)) return 'fyi';
  if (directedAtMe(latest)) return 'waiting_on_ben';
  if (messages.some(m => m.fromMe) && participantCount(convo) > 2) return 'thread_continued';
  return 'waiting_on_ben';
}

/** The message was put to Ben individually, not to a group he is part of. */
export function directedAtMe(msg) {
  return Boolean(msg && (msg.toMeOnly || msg.namesMe));
}

function addressesIn(header) {
  return [...String(header || '').matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+/gi)].map(m => m[0].toLowerCase());
}

// The message went to Ben and no one else: every To address is his and nobody
// is copied. Reply-all in a committee thread puts the previous sender alone in
// To with the rest in Cc, so a Cc list or a plural greeting ("Hey everyone",
// "Dear all") means the message is to the group, whatever To says.
const PLURAL_GREETING = /\b(everyone|everybody|all|friends|folks|team|guys|colleagues|board)\b/i;
function isToMeOnly(msg, benAccounts) {
  const to = addressesIn(msg.to);
  if (!to.length) return false;
  const mine = (benAccounts || []).map(e => String(e).toLowerCase());
  if (!to.every(a => mine.includes(a))) return false;
  if (addressesIn(msg.cc).some(a => !mine.includes(a))) return false;
  return !PLURAL_GREETING.test(String(msg.snippet || '').slice(0, 40));
}

// "Hi Ben", "Morning Ben -", "Dear Marc, Jean-David and Ben": the opening of
// the message names him. Only the opening is read, since quoted text further
// down carries his name on every reply.
function greetingNamesBen(snippet) {
  return /\bben\b/i.test(String(snippet || '').slice(0, 60));
}

/**
 * Reconcile one thread's status across the mailboxes it landed in.
 *
 * A message reaching both a Workspace mailbox and the personal one can survive
 * dedupe as two conversations — the copies carry different Gmail ids and no
 * shared Message-ID. When Ben then answers from the Workspace address, only
 * that copy holds his reply; the personal copy still looks unanswered and keeps
 * asking him to do what he has already done.
 *
 * So evidence is pooled per thread: if he has demonstrably spoken on it in any
 * mailbox, no copy of it may read as awaiting his first reply. Only ever
 * downgrades a nag, never promotes a thread to needing attention, so the worst
 * case is a thread listed one rank calmer than it might deserve.
 *
 * One exception: a copy whose latest message was put to him individually and
 * postdates his last word anywhere is a fresh ask, and stays waiting on him.
 * His earlier reply is not an answer to a question asked after it.
 *
 * Matched on normalized subject, since the participant sets legitimately differ
 * between copies (his two addresses). Short subjects are skipped, as "Hi" or
 * "Thanks" collide across unrelated threads.
 */
export function reconcileThreadStatus(convos) {
  const bySubject = new Map();
  for (const c of convos) {
    const subject = normalizeSubject(c.latestMessage?.subject);
    if (subject.length < 8) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(c);
  }

  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    const benSpoke = group.some(c =>
      (c.messages || []).some(m => m.fromMe) || c.status === 'waiting_on_other'
    );
    if (!benSpoke) continue;
    const benLastAt = Math.max(0, ...group.flatMap(c =>
      (c.messages || []).filter(m => m.fromMe).map(m => m.internalDate || 0)));
    for (const c of group) {
      if (c.status !== 'waiting_on_ben') continue;
      const latest = c.latestMessage || {};
      if (directedAtMe(latest) && (latest.internalDate || 0) > benLastAt) continue;
      c.status = 'thread_continued';
    }
  }
  return convos;
}

function isFromBen(fromHeader, benAccounts) {
  const from = String(fromHeader || '').toLowerCase();
  return benAccounts.some(email => from.includes(email.toLowerCase()));
}

// Machine mail: nothing here awaits a reply. Calendar responses ("Accepted:
// ABO Working Group"), Drive shares and invoice notifications had been landing
// in the correspondence queue as if a person had written.
const NOTIFICATION_SENDER = /no-?_?reply|donotreply|do-not-reply|notification|mailer-daemon|calendar-notification|drive-shares|docs\.google\.com/;
const NOTIFICATION_SUBJECT = /^(accepted|declined|tentatively accepted|tentative|invitation|updated invitation|cancell?ed event|reminder):/;

function looksNoReplyNeeded(msg) {
  const labels = msg.labelIds || [];
  const subject = String(msg.subject || '').toLowerCase();
  const from = String(msg.from || '').toLowerCase();
  return (
    labels.includes('CATEGORY_PROMOTIONS') ||
    labels.includes('CATEGORY_SOCIAL') ||
    subject.includes('newsletter') ||
    subject.includes('receipt') ||
    NOTIFICATION_SUBJECT.test(subject) ||
    NOTIFICATION_SENDER.test(from)
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
