/**
 * Meeting-proposal detection for text conversations.
 *
 * A proposal is raised only when the other party has asked to meet and Ben has
 * not yet answered: the message must sit in the unanswered tail of the chat
 * (after Ben's last message), and it must itself carry both an invitation
 * ("can we", "want to", "come over", "are you around"…) and a time reference
 * ("Tuesday", "tomorrow afternoon", "3:30"). Ben's own messages never raise
 * one — he knows what he offered — and once he has replied the thread is his
 * to drive. Email uses the same message-level test on the latest message's
 * subject and snippet, gated on the thread still waiting on Ben.
 *
 * The previous detector pooled every message in the chat, Ben's included, and
 * fired on any meeting word near any time word across the whole pool, which
 * proposed a "Meet with…" for chats whose last message was "Cool".
 */

// An invitation must be fresh to be actionable: the time it names has passed
// or been settled long before a week is out.
export const PROPOSAL_MAX_AGE_DAYS = 7;

// An invitation, as opposed to a mention: a question or offer directed at Ben.
// A modal needs a meeting verb after it — "could you do 3pm", "should I swing
// by" — so "would you like some peaches" does not count.
const INVITE = new RegExp([
  String.raw`\b(can|could|shall|should|would|will)\s+(we|you|i|u)\s+(please\s+)?(meet|do|come|make|join|be|have|talk|call|get|grab|stop|swing|drop|visit|chat|zoom|see|catch|hop|find|schedule|set|pick|plan|try)\b`,
  String.raw`\b(want|wanna|like)\s+to\b`,
  String.raw`\bare\s+you\s+(free|around|available|up\s+for|at|in\s+town|home)\b`,
  String.raw`\b(let'?s|lets)\b`,
  String.raw`\b(how|what)\s+about\b`,
  String.raw`\bwork(s)?\s+for\s+you\b`,
  String.raw`\b(come|coming|stop|stopping|swing|swinging|drop|dropping)\s+(over|by)\b`,
  String.raw`\b(get|getting)\s+together\b`,
  String.raw`\b(meet|meeting|catch)\s+(up|you|with|for|at)\b`,
  String.raw`\b(grab|have)\s+(a\s+)?(coffee|lunch|dinner|drink|bite|call|chat)\b`,
  String.raw`\b(call|zoom|facetime)\s+(you|me|tomorrow|tonight|later|at|on|this|next)\b`,
  String.raw`\bvisit\b`,
  // "I'm available Tuesday 3-5" / "here's my availability": an offer of
  // windows is an invitation to pick one.
  String.raw`\bavailab(le|ility)\b`
].join('|'), 'i');

// Something that pins the invitation to a time: a day, a part of a day, a
// clock time or a date.
const TIME_REF = new RegExp([
  String.raw`\b(mon|tues?|wed(nes)?|thurs?|fri|sat(ur)?|sun)(day)?\b`,
  String.raw`\b(tomorrow|tonight|today|this\s+(week|weekend|afternoon|evening|morning)|next\s+(week|weekend|month|mon|tue|wed|thu|fri|sat|sun)\w*)\b`,
  String.raw`\b(morning|afternoon|evening|noon|midday|lunchtime)\b`,
  String.raw`\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b`,
  String.raw`\b(at|after|before|around|by)\s+\d{1,2}(:\d{2})?\b`,
  String.raw`\b\d{1,2}/\d{1,2}\b`,
  String.raw`\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b`,
  String.raw`\bthe\s+\d{1,2}(st|nd|rd|th)\b`
].join('|'), 'i');

function textOf(m) {
  return String(m?.text || m?.body || '');
}

/**
 * True when this one message both invites and names a time. The invitation
 * must be in the message body; the time may also come from `heading` (an
 * email subject such as "Lunch Thursday?"). A subject alone never invites:
 * an old thread's subject keeps naming a meeting long after it happened.
 */
export function isMeetingProposalText(text, heading = '') {
  const t = String(text || '');
  return INVITE.test(t) && (TIME_REF.test(t) || TIME_REF.test(String(heading || '')));
}

/**
 * The messages after Ben's last one, oldest first — what he has not answered.
 * Returns [] when the latest message is his.
 */
export function unansweredTail(chatMsgs) {
  const msgs = [...(chatMsgs || [])].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  let lastMine = -1;
  msgs.forEach((m, i) => { if (m.is_from_me || m.fromMe) lastMine = i; });
  return msgs.slice(lastMine + 1);
}

/** True when the message is recent enough for its invitation to still stand. */
export function isFresh(dateLike, now = new Date(), maxAgeDays = PROPOSAL_MAX_AGE_DAYS) {
  const t = typeof dateLike === 'number' ? dateLike : Date.parse(dateLike || '');
  if (!t) return false;
  return now - t <= maxAgeDays * 86400000;
}

/**
 * The message that proposes a meeting Ben has not yet answered, or null.
 * The most recent qualifying message wins, so the proposal reflects the
 * latest version of the ask. Messages older than a week are ignored.
 */
export function findMeetingProposal(chatMsgs, { now = new Date() } = {}) {
  const tail = unansweredTail(chatMsgs);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    if (!isFresh(m.date || m.timestamp, now)) continue;
    if (isMeetingProposalText(textOf(m))) return m;
  }
  return null;
}
