export function buildConversationKey(message) {
  if (message.references?.length) return message.references[0];
  if (message.inReplyTo) return message.inReplyTo;
  if (message.rfcMessageId) return message.rfcMessageId;
  return fallbackMessageKey(message);
}

export function dedupeMessages(messages) {
  const byKey = new Map();

  for (const msg of messages) {
    const key = msg.rfcMessageId || fallbackMessageKey(msg);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, msg);
      continue;
    }
    byKey.set(key, preferOriginal(existing, msg));
  }

  return [...byKey.values()];
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

function preferOriginal(a, b) {
  if (looksForwarded(a) && !looksForwarded(b)) return b;
  return a;
}

function looksForwarded(msg) {
  const delivered = `${msg.deliveredTo || ''} ${msg.originalTo || ''}`.toLowerCase();
  if (!delivered) return false;
  return !delivered.includes(String(msg.sourceAccount || '').toLowerCase());
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
