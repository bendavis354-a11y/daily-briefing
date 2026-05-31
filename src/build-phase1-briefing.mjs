/**
 * Phase 1 briefing builder.
 * Reads /tmp/phase1-output.json and writes briefing.json.
 */
import fs from 'node:fs';

const { assistantState, conversations, benEmails } = JSON.parse(fs.readFileSync('/tmp/phase1-output.json', 'utf8'));

const NOW = new Date();
const TODAY = '2026-05-31';
const TOMORROW = '2026-06-01';
const TIMEZONE = 'America/New_York';
const GITHUB_PAGES_URL = process.env.GITHUB_PAGES_URL || '';

const ignoredKeys = new Set(Object.keys(assistantState.ignoredConversations || {}));
const snoozedKeys = new Set(
  Object.entries(assistantState.snoozedConversations || {})
    .filter(([, until]) => until && new Date(until) > NOW)
    .map(([k]) => k)
);

const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]').map(a => ({
  email: a.email,
  label: a.label,
  type: a.type || 'Personal'
}));

// Calendar data (passed in from environment — see below)
const tomorrowSchedule = JSON.parse(process.env.TOMORROW_SCHEDULE || '[]');
const calendars = JSON.parse(process.env.CALENDARS_JSON || '[]');

// ── helpers ────────────────────────────────────────────────────────────────

function extractEmail(value) {
  return String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

function extractName(from) {
  const s = String(from || '');
  const m = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return m ? m[1].trim() : (s.includes('@') ? extractEmail(s) : s.trim());
}

function hasLabel(msg, label) {
  return (msg.labelIds || []).includes(label);
}

function isNewsletterOrPromo(msg) {
  const labels = msg.labelIds || [];
  const subject = String(msg.subject || '').toLowerCase();
  const from = String(msg.from || '').toLowerCase();
  return (
    labels.includes('CATEGORY_PROMOTIONS') ||
    labels.includes('CATEGORY_SOCIAL') ||
    subject.includes('unsubscribe') ||
    subject.includes('newsletter') ||
    subject.includes('digest') ||
    from.includes('no-reply') ||
    from.includes('noreply') ||
    from.includes('donotreply') ||
    from.includes('notifications@') ||
    from.includes('hello@') ||
    from.includes('info@') ||
    from.includes('updates@') ||
    from.includes('daily-ish') ||
    from.includes('substack') ||
    from.includes('mailchimp') ||
    from.includes('constantcontact') ||
    from.includes('sendgrid') ||
    from.includes('list-') ||
    subject.includes('weekly') ||
    subject.includes('monthly') ||
    (from.includes('permies') && !from.includes('@')) ||
    from.endsWith('.substack.com>')
  );
}

function isSpam(msg) {
  return (msg.labelIds || []).includes('SPAM');
}

function isTrash(msg) {
  return (msg.labelIds || []).includes('TRASH');
}

function isInSent(msg) {
  return (msg.labelIds || []).includes('SENT');
}

function daysSinceDate(dateMs) {
  return (NOW.getTime() - dateMs) / (1000 * 60 * 60 * 24);
}

function formatSnippet(snippet) {
  return String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function gmailAccountIndex(email) {
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const idx = accounts.findIndex(a => a.email === email);
  return idx >= 0 ? idx : 0;
}

function accountLabel(email) {
  const found = accounts.find(a => a.email === email);
  return found?.label || email;
}

// ── categorize each conversation ───────────────────────────────────────────

const sections = {
  urgent: [],
  tomorrowSchedule,
  calendarProposals: [],
  suggestedReplies: [],
  todos: [],
  business: [],
  personal: [],
  financial: [],
  waiting: [],
  newsletter: [],
  spam: []
};

let emailsScanned = 0;

for (const convo of conversations) {
  const { conversationKey, latestMessage: msg, status, accountsSeen } = convo;

  // Skip if no message
  if (!msg) continue;

  // Skip ignored
  if (ignoredKeys.has(conversationKey)) continue;

  // Skip snoozed
  if (snoozedKeys.has(conversationKey)) continue;

  // Skip trash
  if (isTrash(msg)) continue;

  // Skip Google Calendar notification emails
  const fromLower = String(msg.from || '').toLowerCase();
  if (fromLower.includes('calendar-notification@google.com') || fromLower.includes('calendar@google.com')) continue;

  // Skip spam
  if (isSpam(msg)) {
    emailsScanned++;
    sections.spam.push({
      conversationKey,
      sourceAccount: msg.sourceAccount,
      account: msg.sourceAccount,
      sender: extractName(msg.from),
      senderName: extractName(msg.from),
      senderEmail: extractEmail(msg.from),
      subject: msg.subject,
      summary: formatSnippet(msg.snippet),
      gmailThreadId: msg.gmailThreadId
    });
    continue;
  }

  emailsScanned++;

  const priorState = (assistantState.conversations || {})[conversationKey] || {};

  const senderName = extractName(msg.from);
  const senderEmail = extractEmail(msg.from);
  const subject = String(msg.subject || '').trim();
  const snippet = formatSnippet(msg.snippet);
  const summary = priorState.summary || snippet;
  const account = msg.sourceAccount;
  const threadId = msg.gmailThreadId;
  const accountIdx = gmailAccountIndex(account);

  // Base item shape
  const item = {
    conversationKey,
    account,
    sourceAccount: account,
    sender: senderName || senderEmail,
    senderName,
    senderEmail,
    subject,
    summary,
    snippet,
    gmailThreadId: threadId,
    gmailAccountIndex: accountIdx,
    status
  };

  // Is it from Ben (sent)?
  const fromBen = benEmails.some(e => String(msg.from || '').toLowerCase().includes(e.toLowerCase()));

  // Newsletter / promo
  if (isNewsletterOrPromo(msg)) {
    sections.newsletter.push(item);
    continue;
  }

  // Already waiting on other (Ben replied last) — put in waiting/fyi unless urgent
  if (status === 'waiting_on_other') {
    sections.waiting.push(item);
    continue;
  }

  // FYI / no reply needed
  if (status === 'fyi') {
    // Still bucket by category
    const s = subject.toLowerCase();
    if (isFinancial(s, msg.from)) {
      sections.financial.push(item);
    } else if (isBusiness(s, account, msg.from)) {
      sections.business.push(item);
    } else {
      sections.waiting.push(item);
    }
    continue;
  }

  // waiting_on_ben or unknown — needs attention
  const ageHours = msg.internalDate ? (NOW.getTime() - msg.internalDate) / (1000 * 60 * 60) : 0;
  const subjectLower = subject.toLowerCase();

  // Urgency check
  const urgent = (
    subjectLower.includes('urgent') ||
    subjectLower.includes('asap') ||
    subjectLower.includes('action required') ||
    subjectLower.includes('deadline') ||
    subjectLower.includes('overdue') ||
    subjectLower.includes('past due') ||
    subjectLower.includes('immediately') ||
    (ageHours > 48 && status === 'waiting_on_ben' && !isNewsletterOrPromo(msg))
  );

  if (urgent && !fromBen) {
    sections.urgent.push({ ...item, deadline: ageHours > 48 ? `${Math.floor(ageHours)}h old` : undefined });
    // Also suggest a reply
    const replyBody = buildReplyBody(senderName, subject, priorState.summary || snippet);
    if (replyBody) {
      sections.suggestedReplies.push({
        account,
        sourceAccount: account,
        sender: senderName,
        senderEmail,
        to: senderEmail,
        subject: `Re: ${subject}`,
        title: `Reply to: ${subject}`,
        detail: `This message needs a response (${Math.floor(ageHours)}h old)`,
        body: replyBody,
        gmailThreadId: threadId
      });
    }
    continue;
  }

  // Financial
  if (isFinancial(subjectLower, msg.from)) {
    sections.financial.push(item);
    // Add a todo if it looks like it needs action (not newsletters)
    if (status === 'waiting_on_ben' && !fromBen && !isNewsletterOrPromo(msg) && looksLikeRealPerson(msg.from)) {
      sections.todos.push({
        account,
        priority: 'medium',
        text: `Review: ${subject}`,
        conversationKey
      });
    }
    continue;
  }

  // Business
  if (isBusiness(subjectLower, account, msg.from)) {
    sections.business.push(item);
    if (status === 'waiting_on_ben' && !fromBen && !isNewsletterOrPromo(msg) && looksLikeRealPerson(msg.from)) {
      // Suggest reply for business emails needing response
      const replyBody = buildReplyBody(senderName, subject, snippet);
      if (replyBody && ageHours < 120) {
        sections.suggestedReplies.push({
          account,
          sourceAccount: account,
          sender: senderName,
          senderEmail,
          to: senderEmail,
          subject: `Re: ${subject}`,
          title: `Reply to: ${subject}`,
          detail: `Business email awaiting reply`,
          body: replyBody,
          gmailThreadId: threadId
        });
      }
    }
    continue;
  }

  // Calendar proposals — detect date/time mentions in subject or snippet
  if (looksLikeMeetingProposal(subjectLower, snippet) && status === 'waiting_on_ben') {
    const proposal = buildCalendarProposal(item, subject, snippet);
    if (proposal) {
      sections.calendarProposals.push(proposal);
    }
  }

  // Personal
  sections.personal.push(item);

  // Suggest reply for personal emails waiting on Ben
  if (status === 'waiting_on_ben' && !fromBen && looksLikeRealPerson(msg.from)) {
    const replyBody = buildReplyBody(senderName, subject, snippet);
    if (replyBody && ageHours < 96) {
      sections.suggestedReplies.push({
        account,
        sourceAccount: account,
        sender: senderName,
        senderEmail,
        to: senderEmail,
        subject: `Re: ${subject}`,
        title: `Reply to: ${subject}`,
        detail: `Personal email awaiting reply`,
        body: replyBody,
        gmailThreadId: threadId
      });
    }
  }
}

// ── helpers for categorization ─────────────────────────────────────────────

function isFinancial(subjectLower, from) {
  const f = String(from || '').toLowerCase();
  return (
    subjectLower.includes('invoice') ||
    subjectLower.includes('payment') ||
    subjectLower.includes('receipt') ||
    subjectLower.includes('billing') ||
    subjectLower.includes('bank') ||
    subjectLower.includes('statement') ||
    subjectLower.includes('transaction') ||
    subjectLower.includes('tax') ||
    subjectLower.includes('refund') ||
    subjectLower.includes('order') ||
    subjectLower.includes('purchase') ||
    f.includes('bank') ||
    f.includes('paypal') ||
    f.includes('stripe') ||
    f.includes('quickbooks') ||
    f.includes('venmo')
  );
}

function isBusiness(subjectLower, account, from) {
  const f = String(from || '').toLowerCase();
  const isBusinessAccount = account === 'ben@heartspringgardens.org' || account === 'benjamin@biodynamics.com';
  return (
    isBusinessAccount ||
    subjectLower.includes('meeting') ||
    subjectLower.includes('proposal') ||
    subjectLower.includes('contract') ||
    subjectLower.includes('project') ||
    subjectLower.includes('schedule') ||
    subjectLower.includes('appointment') ||
    subjectLower.includes('inquiry') ||
    subjectLower.includes('question about') ||
    subjectLower.includes('follow up') ||
    subjectLower.includes('follow-up')
  );
}

function looksLikeMeetingProposal(subjectLower, snippet) {
  const text = `${subjectLower} ${String(snippet || '').toLowerCase()}`;
  // Require explicit scheduling intent, not just keywords in newsletters
  return (
    text.includes('let\'s meet') ||
    text.includes('call on') ||
    text.includes('schedule a call') ||
    text.includes('schedule a meeting') ||
    text.includes('available for a call') ||
    text.includes('can we meet') ||
    text.includes('would you be available') ||
    text.includes('set up a time')
  );
}

function buildCalendarProposal(item, subject, snippet) {
  return {
    id: `proposal-${item.conversationKey?.slice(0, 8) || Date.now()}`,
    account: item.account,
    title: subject,
    start: TOMORROW + 'T09:00:00-04:00',
    end: TOMORROW + 'T10:00:00-04:00',
    location: '',
    detail: snippet,
    context: `From email: ${item.senderName || item.sender}`,
    sourceSender: item.senderName || item.sender,
    sourceSubject: subject,
    calendarId: item.account || 'primary'
  };
}

function buildReplyBody(senderName, subject, context) {
  const firstName = (senderName || '').split(' ')[0] || 'there';
  return `Hi ${firstName},\n\nThank you for your email regarding "${subject}".\n\n[Your response here]\n\nBest,\nBen`;
}

function looksLikeRealPerson(from) {
  const email = extractEmail(from);
  if (!email) return false;
  const emailLower = email.toLowerCase();
  const local = emailLower.split('@')[0];
  // Likely automated sender patterns
  if (
    local.includes('no-reply') ||
    local.includes('noreply') ||
    local.includes('donotreply') ||
    local.includes('notification') ||
    local.includes('newsletter') ||
    local.includes('mailer') ||
    local.includes('digest') ||
    local.includes('support') ||
    local.includes('hello') ||
    local.includes('info') ||
    local.includes('updates') ||
    local.includes('billing') ||
    local.includes('invoice') ||
    local.includes('estatement') ||
    local.includes('statement') ||
    local.includes('receipt') ||
    local.includes('order') ||
    local.includes('payment') ||
    local.includes('alert') ||
    local.includes('admin') ||
    local.includes('postmaster') ||
    local.includes('bounce') ||
    local.includes('automated') ||
    local.includes('robot') ||
    local.includes('daemon') ||
    local.includes('calendar-notification') ||
    emailLower.includes('calendar-notification') ||
    emailLower.includes('google.com') ||
    emailLower.includes('googlecalendar')
  ) return false;
  return true;
}

// ── deduplicate suggested replies (cap at 5) ───────────────────────────────
sections.suggestedReplies = sections.suggestedReplies.slice(0, 5);
sections.calendarProposals = sections.calendarProposals.slice(0, 3);

// ── deduplicate financial by subject+sender ────────────────────────────────
const seenFinancial = new Set();
sections.financial = sections.financial.filter(item => {
  const key = `${item.senderEmail}|${item.subject}`;
  if (seenFinancial.has(key)) return false;
  seenFinancial.add(key);
  return true;
});

// ── add open tasks from assistant state ───────────────────────────────────
const openTasks = (assistantState.openTasks || []).filter(t => {
  if (t.done) return false;
  const text = (t.text || t.title || '').toLowerCase();
  // Skip newsletter-style tasks carried forward
  const newsletterSenders = ['permies daily-ish', 'substack', 'newsletter', 'digest', 'mailchimp'];
  if (newsletterSenders.some(kw => text.includes(kw))) return false;
  return true;
});
for (const task of openTasks.slice(0, 5)) {
  sections.todos.push({
    account: task.account || accounts[0]?.email || '',
    priority: task.priority || 'medium',
    text: task.text || task.title || '',
    conversationKey: task.conversationKey
  });
}

// Remove duplicates in todos
const seenTodos = new Set();
sections.todos = sections.todos.filter(t => {
  const key = `${t.account}|${t.text}`;
  if (seenTodos.has(key)) return false;
  seenTodos.add(key);
  return true;
}).slice(0, 10);

// ── stats ──────────────────────────────────────────────────────────────────
const stats = {
  emailsScanned,
  urgent: sections.urgent.length,
  eventsTomorrow: tomorrowSchedule.length,
  proposedEvents: sections.calendarProposals.length,
  suggestedReplies: sections.suggestedReplies.length,
  todos: sections.todos.length
};

// ── assemble briefing ──────────────────────────────────────────────────────
const briefing = {
  metadata: {
    generatedAt: NOW.toISOString(),
    date: TODAY,
    timezone: TIMEZONE,
    lastSuccessfulBuildAt: assistantState.updatedAt || NOW.toISOString(),
    dataFreshThrough: NOW.toISOString(),
    liveUrl: GITHUB_PAGES_URL,
    todayLabel: 'Sunday, May 31, 2026',
    tomorrowLabel: 'Monday, June 1, 2026'
  },
  stats,
  accounts,
  calendars,
  sections
};

fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));
process.stderr.write(`[briefing] wrote briefing.json\n`);
process.stderr.write(`[briefing] ${JSON.stringify(stats)}\n`);
