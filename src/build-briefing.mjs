/**
 * Reads /tmp/gather-output.json, applies business logic, writes briefing.json
 */
import fs from 'node:fs';

const { assistantState, conversations, benEmails } = JSON.parse(
  fs.readFileSync('/tmp/gather-output.json', 'utf8')
);

const today = '2026-05-31';
const tomorrow = '2026-06-01';
const now = new Date().toISOString();

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(msg) {
  const d = msg.internalDate ? new Date(msg.internalDate) : new Date(msg.date || 0);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

const BEN_EMAILS = new Set(benEmails.map(e => e.toLowerCase()));

function isBen(from) {
  return BEN_EMAILS.has((from || '').toLowerCase().match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase() || '');
}

function emailOfFrom(from) {
  return (from || '').match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase() || '';
}

function nameOfFrom(from) {
  const match = from?.match(/^"?([^"<]+?)"?\s*</);
  return match ? match[1].trim() : emailOfFrom(from);
}

// Label helpers
function hasLabel(msg, label) {
  return (msg.labelIds || []).includes(label);
}

function isInbox(msg) {
  return hasLabel(msg, 'INBOX');
}

function isSpam(msg) {
  return hasLabel(msg, 'SPAM') || hasLabel(msg, 'CATEGORY_PROMOTIONS') || hasLabel(msg, 'JUNK');
}

function isPromotion(msg) {
  return hasLabel(msg, 'CATEGORY_PROMOTIONS');
}

function isSocial(msg) {
  return hasLabel(msg, 'CATEGORY_SOCIAL');
}

function isSent(msg) {
  return hasLabel(msg, 'SENT');
}

function isTrash(msg) {
  return hasLabel(msg, 'TRASH');
}

function isNewsletter(msg) {
  const subject = (msg.subject || '').toLowerCase();
  const from = (msg.from || '').toLowerCase();
  return (
    isPromotion(msg) ||
    subject.includes('newsletter') ||
    subject.includes('digest') ||
    subject.includes('weekly') ||
    subject.includes('update') ||
    from.includes('no-reply') ||
    from.includes('noreply') ||
    from.includes('newsletter') ||
    from.includes('mailer') ||
    from.includes('info@')
  );
}

function isAutomatedSender(from) {
  const f = (from || '').toLowerCase();
  return (
    f.includes('no-reply') ||
    f.includes('noreply') ||
    f.includes('donotreply') ||
    f.includes('do-not-reply') ||
    f.includes('notification') ||
    f.includes('notifications@') ||
    f.includes('alert@') ||
    f.includes('alerts@') ||
    f.includes('auto@') ||
    f.includes('automatic') ||
    f.includes('support@') ||
    f.includes('hello@') ||
    f.includes('team@') ||
    f.includes('service@') ||
    f.includes('billing@') ||
    f.includes('mailer') ||
    f.includes('bot@') ||
    f.includes('system@') ||
    f.includes('newsletter')
  );
}

function isConversational(convo) {
  const latest = convo.latestMessage;
  if (!latest) return false;
  if (isAutomatedSender(latest.from)) return false;
  // Require an actual back-and-forth: Ben has replied at least once
  const hasBenReply = convo.messages.some(m => isBen(m.from));
  const hasOtherMsg = convo.messages.some(m => !isBen(m.from));
  return hasBenReply && hasOtherMsg;
}

// ── Filter conversations ──────────────────────────────────────────────────────

const ignored = new Set(Object.keys(assistantState.ignoredConversations || {}));
const now_ms = Date.now();

function isSnoozed(convo) {
  const entry = (assistantState.snoozedConversations || {})[convo.conversationKey];
  if (!entry) return false;
  return new Date(entry.until || 0).getTime() > now_ms;
}

function wasHandled(convo) {
  const prev = (assistantState.conversations || {})[convo.conversationKey];
  if (!prev) return false;
  // If previously handled and no new messages, skip
  if (prev.status === 'done' || prev.status === 'ignored') return true;
  return false;
}

// Find account index for Gmail link (0-based)
const accountList = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const accountIndex = {};
accountList.forEach((a, i) => { accountIndex[a.email] = i; });

// ── Categorize each conversation ─────────────────────────────────────────────

const sections = {
  urgent: [],
  business: [],
  personal: [],
  financial: [],
  waiting: [],
  newsletter: [],
  spam: [],
  tomorrowSchedule: [],
  calendarProposals: [],
  suggestedReplies: [],
  todos: []
};

function accountIdx(email) {
  return accountIndex[email] ?? 0;
}

function makeEmailItem(convo) {
  const msg = convo.latestMessage;
  const srcAccount = msg.sourceAccount || convo.accountsSeen?.[0] || '';
  const fromEmail = emailOfFrom(msg.from);
  const fromName = nameOfFrom(msg.from);
  const gmailIdx = accountIdx(srcAccount);

  return {
    conversationKey: convo.conversationKey,
    sourceAccount: srcAccount,
    account: srcAccount,
    gmailThreadId: msg.gmailThreadId,
    gmailAccountIndex: gmailIdx,
    sender: fromName || fromEmail || 'Unknown',
    senderName: fromName,
    senderEmail: fromEmail,
    subject: msg.subject || '(no subject)',
    summary: msg.snippet || '',
    snippet: msg.snippet || '',
    status: convo.status,
    date: new Date(msg.internalDate || 0).toISOString()
  };
}

// Build keyword checks
function isFinancialSubject(subject) {
  const s = subject.toLowerCase();
  return s.includes('invoice') || s.includes('payment') || s.includes('receipt') ||
    s.includes('bill') || s.includes('statement') || s.includes('tax') ||
    s.includes('refund') || s.includes('transaction') || s.includes('order') ||
    s.includes('purchase') || s.includes('subscription') || s.includes('charge') ||
    s.includes('bank') || s.includes('account balance') || s.includes('donation');
}

function isBusinessDomain(from) {
  const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'icloud.com', 'me.com', 'outlook.com'];
  const domain = (from || '').split('@')[1]?.toLowerCase() || '';
  return domain && !personalDomains.includes(domain);
}

function isUrgent(convo, msg) {
  const subject = (msg.subject || '').toLowerCase();
  const snippet = (msg.snippet || '').toLowerCase();
  // Only flag explicitly urgent language — IMPORTANT label is too broad in Gmail
  return (
    subject.includes('urgent') ||
    subject.includes('action required') ||
    subject.includes('immediate action') ||
    subject.includes('deadline') ||
    (subject.includes('overdue') && !isNewsletter(msg)) ||
    (snippet.includes('urgent') && snippet.includes('respond')) ||
    snippet.includes('action required')
  );
}

let emailsScanned = 0;
const calendarProposalKeywords = ['meeting', 'call', 'appointment', 'interview', 'conference', 'session', 'webinar', 'visit', 'event', 'dinner', 'lunch', 'coffee'];

for (const convo of conversations) {
  const msg = convo.latestMessage;
  if (!msg) continue;

  // Skip trash
  if (isTrash(msg)) continue;

  // Skip conversations with only sent messages and no inbox presence
  const hasInboxMsg = convo.messages.some(m => isInbox(m));
  const hasSentMsg = convo.messages.some(m => isSent(m));
  const allFromBen = convo.messages.every(m => isBen(m.from));

  // Skip sent-only that didn't land in inbox (outbound only)
  if (allFromBen && !hasInboxMsg) continue;

  emailsScanned++;

  // Skip ignored/snoozed
  if (ignored.has(convo.conversationKey)) continue;
  if (isSnoozed(convo)) continue;

  const subject = msg.subject || '(no subject)';
  const snippet = msg.snippet || '';
  const from = msg.from || '';
  const fromEmail = emailOfFrom(from);
  const srcAccount = msg.sourceAccount || convo.accountsSeen?.[0] || '';

  const item = makeEmailItem(convo);

  // SPAM / JUNK
  if (isSpam(msg) || hasLabel(msg, 'JUNK')) {
    sections.spam.push({ ...item, summary: snippet || subject });
    continue;
  }

  // NEWSLETTER / PROMOTIONS
  if (isNewsletter(msg) && !isUrgent(convo, msg)) {
    sections.newsletter.push(item);
    continue;
  }

  // Waiting/FYI - already handled, just tracking
  if (convo.status === 'waiting_on_other') {
    // Check if previously in state
    const prevState = (assistantState.conversations || {})[convo.conversationKey];
    if (prevState && prevState.status === 'waiting_on_other') {
      // No new activity from them, keep in waiting
      sections.waiting.push({ ...item, summary: `Waiting for response. ${snippet}`.trim() });
      continue;
    }
  }

  // Skip purely social/promotional
  if (isSocial(msg) && !isUrgent(convo, msg)) {
    sections.newsletter.push(item);
    continue;
  }

  // FINANCIAL
  if (isFinancialSubject(subject)) {
    sections.financial.push(item);
    // Check for todos
    if (subject.toLowerCase().includes('invoice') || subject.toLowerCase().includes('action required') || subject.toLowerCase().includes('payment due')) {
      sections.todos.push({
        account: srcAccount,
        priority: 'medium',
        text: `Review: ${subject} from ${nameOfFrom(from) || fromEmail}`
      });
    }
    continue;
  }

  // URGENT check
  if (isUrgent(convo, msg)) {
    sections.urgent.push(item);

    // Suggest reply if waiting on Ben
    if (convo.status === 'waiting_on_ben') {
      sections.suggestedReplies.push({
        account: srcAccount,
        gmailAccountIndex: accountIdx(srcAccount),
        sender: nameOfFrom(from) || fromEmail,
        senderEmail: fromEmail,
        to: fromEmail,
        subject: `Re: ${subject}`,
        title: `Reply to urgent: ${subject}`,
        detail: `Urgent message from ${nameOfFrom(from) || fromEmail} needs your response.`,
        body: `Hi ${nameOfFrom(from) || fromEmail.split('@')[0]},\n\nThank you for reaching out.\n\n`,
        gmailThreadId: msg.gmailThreadId,
        conversationKey: convo.conversationKey
      });
    }

    sections.todos.push({
      account: srcAccount,
      priority: 'high',
      text: `URGENT: Respond to "${subject}" from ${nameOfFrom(from) || fromEmail}`
    });
    continue;
  }

  // CALENDAR PROPOSAL detection
  const subjectLower = subject.toLowerCase();
  if (calendarProposalKeywords.some(k => subjectLower.includes(k)) &&
      convo.status === 'waiting_on_ben' &&
      !isBen(from)) {
    // Propose calendar event
    const proposalId = `proposal-${Buffer.from(convo.conversationKey).toString('base64').slice(0, 12)}`;
    sections.calendarProposals.push({
      id: proposalId,
      account: srcAccount,
      title: subject.replace(/^(re:|fwd?):\s*/i, '').trim(),
      start: `${tomorrow}T10:00:00`,
      end: `${tomorrow}T11:00:00`,
      location: '',
      detail: snippet,
      context: `Proposed from email: ${snippet.slice(0, 120)}`,
      sourceSender: nameOfFrom(from) || fromEmail,
      sourceSubject: subject,
      calendarId: srcAccount === 'ben@heartspringgardens.org' ? 'ben@heartspringgardens.org' : 'bendavis354@gmail.com'
    });
  }

  // WAITING / FYI
  if (convo.status === 'waiting_on_other' || convo.status === 'fyi') {
    sections.waiting.push(item);
    continue;
  }

  // PERSONAL vs BUSINESS
  const fromBizDomain = isBusinessDomain(fromEmail);

  // Determine category
  if (fromBizDomain || srcAccount === 'benjamin@biodynamics.com' || srcAccount === 'ben@heartspringgardens.org') {
    sections.business.push(item);

    if (convo.status === 'waiting_on_ben' && isConversational(convo)) {
      sections.suggestedReplies.push({
        account: srcAccount,
        gmailAccountIndex: accountIdx(srcAccount),
        sender: nameOfFrom(from) || fromEmail,
        senderEmail: fromEmail,
        to: fromEmail,
        subject: `Re: ${subject}`,
        title: `Reply to ${nameOfFrom(from) || fromEmail}`,
        detail: `Business email needs your attention.`,
        body: `Hi ${nameOfFrom(from) || fromEmail.split('@')[0]},\n\nThank you for your email.\n\n`,
        gmailThreadId: msg.gmailThreadId,
        conversationKey: convo.conversationKey
      });

      sections.todos.push({
        account: srcAccount,
        priority: 'medium',
        text: `Reply to ${nameOfFrom(from) || fromEmail}: "${subject}"`
      });
    }
  } else {
    sections.personal.push(item);

    if (convo.status === 'waiting_on_ben' && isConversational(convo)) {
      sections.suggestedReplies.push({
        account: srcAccount,
        gmailAccountIndex: accountIdx(srcAccount),
        sender: nameOfFrom(from) || fromEmail,
        senderEmail: fromEmail,
        to: fromEmail,
        subject: `Re: ${subject}`,
        title: `Reply to ${nameOfFrom(from) || fromEmail}`,
        detail: `Personal email needs your attention.`,
        body: `Hi ${nameOfFrom(from) || fromEmail.split('@')[0]},\n\nThanks for reaching out.\n\n`,
        gmailThreadId: msg.gmailThreadId,
        conversationKey: convo.conversationKey
      });
    }
  }
}

// ── Tomorrow's schedule ───────────────────────────────────────────────────────

sections.tomorrowSchedule = [
  {
    title: 'Phoenix Lower Grades Class Play: Rainbow Crow',
    start: '2026-06-01T11:30:00-04:00',
    end: '2026-06-01T12:30:00-04:00',
    allDay: false,
    location: 'Mettabee Farm',
    calendarName: 'Personal (bendavis354)',
    calendarId: 'bendavis354@gmail.com',
    htmlLink: 'https://www.google.com/calendar/event?eid=M2Z2N25pY2ttaDVxZHVjNGwwMDdvYmg2YjIgYmVuZGF2aXMzNTRAbQ&ctz=America/New_York',
    color: '#3A7556'
  }
];

// Cap sections to reasonable sizes
sections.suggestedReplies = sections.suggestedReplies.slice(0, 8);
sections.todos = sections.todos.slice(0, 15);
sections.calendarProposals = sections.calendarProposals.slice(0, 5);

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = {
  emailsScanned,
  urgent: sections.urgent.length,
  eventsTomorrow: sections.tomorrowSchedule.length,
  proposedEvents: sections.calendarProposals.length,
  suggestedReplies: sections.suggestedReplies.length,
  todos: sections.todos.length
};

// ── Calendars ─────────────────────────────────────────────────────────────────

const calendars = [
  { id: 'bendavis354@gmail.com', name: 'Personal (bendavis354)', color: '#3A7556' },
  { id: 'ben@heartspringgardens.org', name: 'Heartspring', color: '#3D5DAA' }
];

// ── Accounts ─────────────────────────────────────────────────────────────────

const briefingAccounts = accountList.map(a => ({
  email: a.email,
  label: a.label || a.email,
  type: a.type || (a.email.includes('gmail.com') ? 'Personal' : 'Business')
}));

// ── Get last successful build from state ─────────────────────────────────────

const lastRunAt = (assistantState.recentRuns || [])
  .filter(r => r.status === 'success')
  .sort((a, b) => new Date(b.at) - new Date(a.at))[0]?.at || now;

const liveUrl = 'https://bendavis354-a11y.github.io/daily-briefing/';

// ── Build briefing.json ───────────────────────────────────────────────────────

const briefing = {
  metadata: {
    generatedAt: now,
    date: today,
    timezone: 'America/New_York',
    lastSuccessfulBuildAt: lastRunAt,
    dataFreshThrough: now,
    liveUrl,
    todayLabel: 'Sunday, May 31, 2026',
    tomorrowLabel: 'Monday, June 1, 2026'
  },
  stats,
  accounts: briefingAccounts,
  calendars,
  sections
};

fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));
console.log('briefing.json written');
console.log('Stats:', JSON.stringify(stats));
