/**
 * Which text conversations actually await a reply from Ben.
 *
 * "The newest message is not his" was the whole test, and it raised a "Reply
 * to iMessage" item for a thumbs-up tapback on his own message, for "Perfect
 * we're here" after he said he was on his way, for a family-group question
 * put to someone else, and for the auto-reply his own phone sends while he
 * drives. Each rule below removes one of those:
 *
 *   - Reactions (Liked "…", Loved "…") are not messages; they are skipped when
 *     finding the newest thing anyone said.
 *   - His phone's driving auto-reply is not his reply.
 *   - A short acknowledgement from them straight after his message — "OK will
 *     do", "Perfect we're here", "Ok thank you." — closes the exchange.
 *   - In a group chat, only a message that names him is his to answer.
 *
 * Long or substantive messages from the other party still count, so a real
 * question is never hidden by these rules; they only clear what plainly needs
 * nothing.
 */

const REACTION = /^(liked|loved|laughed at|emphasi[sz]ed|questioned|disliked|reacted\s.+?\sto)\s+[“"']/i;
const AUTO_REPLY = /driving with focus turned on|see your message when i get where i'?m going/i;
const ACK = /^(ok(ay)?|kk?|perfect|great|cool|awesome|nice|sounds (good|great|like a plan)|will do|got it|sure|yes|yep|yup|yeah|no problem|np|thanks?|thank you|thx|ty|see you( (then|there|soon|tomorrow))?|on my way|omw|all good|done|👍|👌|🙏|❤️|we'?re here|i'?m here)(?=[\s!.,]|$)/iu;

/** The message text without the placeholder Apple leaves for an attachment. */
export function cleanText(m) {
  return String(m?.text || m?.body || '').replace(/￼/g, '').trim();
}

export function isReaction(text) { return REACTION.test(String(text || '').trim()); }
export function isAutoReply(text) { return AUTO_REPLY.test(String(text || '')); }

/** A short closing acknowledgement: nothing in it asks for anything. */
export function isAcknowledgement(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return false;
  if (t.split(' ').length > 8) return false;
  return ACK.test(t);
}

/**
 * Group chats carry an iMessage "chat…" identifier rather than a bare handle;
 * a second distinct sender is the other tell when the export lacks one.
 */
export function isGroupChat(chatKey, msgs) {
  if (/^chat\d/i.test(String(chatKey || ''))) return true;
  const senders = new Set((msgs || []).filter(m => !m.is_from_me).map(m => m.sender_name || m.handle || ''));
  return senders.size > 1;
}

/**
 * Decide one chat. Returns the newest substantive message (reactions and
 * auto-replies skipped), whether it awaits Ben, why, and the excerpt worth
 * showing — the newest unanswered message that has any text.
 */
export function triageChat(chatKey, chatMsgs) {
  const msgs = [...(chatMsgs || [])].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const substantive = msgs.filter(m => !isReaction(cleanText(m)) && !isAutoReply(cleanText(m)));
  const latest = substantive[substantive.length - 1] || msgs[msgs.length - 1] || null;
  const group = isGroupChat(chatKey, msgs);
  const base = { latest, group, excerpt: '' };
  if (!latest) return { ...base, needsReply: false, reason: 'empty' };
  if (latest.is_from_me) return { ...base, needsReply: false, reason: 'ben spoke last' };

  let lastMine = -1;
  substantive.forEach((m, i) => { if (m.is_from_me) lastMine = i; });
  const tail = substantive.slice(lastMine + 1);
  const excerpt = [...tail].reverse().map(cleanText).find(Boolean) || '';
  const text = cleanText(latest);
  const prev = substantive[substantive.length - 2];

  if (!group && isAcknowledgement(text) && prev?.is_from_me) {
    return { ...base, excerpt, needsReply: false, reason: 'acknowledgement' };
  }
  if (group && !/\bben\b/i.test(excerpt)) {
    return { ...base, excerpt, needsReply: false, reason: 'group, not addressed to ben' };
  }
  return { ...base, excerpt, needsReply: true, reason: group ? 'group, names ben' : 'unanswered' };
}
