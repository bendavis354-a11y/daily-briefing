/**
 * Daily Briefing Gather — runs Steps 2–5
 * Loads Drive state, scans Gmail + Calendar, writes briefing.json
 */

import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, emptyState } from './drive-state.mjs';
import { scanConfiguredMailboxes } from './gmail-api.mjs';
import { dedupeMessages, groupConversations } from './continuity.mjs';
import { listTomorrowEventsForAccount, listCalendars } from './calendar-api.mjs';

// ── dates ────────────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const now = new Date();
const todayISO = localDate(now, TZ);
const tomorrowISO = (() => {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return localDate(d, TZ);
})();
const tomorrowMin = `${tomorrowISO}T00:00:00-04:00`;
const tomorrowMax = `${tomorrowISO}T23:59:59-04:00`;

console.log(`Date: today=${todayISO}  tomorrow=${tomorrowISO}`);

// ── credentials ──────────────────────────────────────────────────────────────
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;
const liveUrl = process.env.GITHUB_PAGES_URL || '';

if (!clientId || !clientSecret) throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');

// ── STEP 2: load Drive state ──────────────────────────────────────────────────
console.log('Loading Drive state…');
const driveAccount = accounts[0];
const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
let assistantState;
try {
  assistantState = await readState({ accessToken: driveToken, fileId: driveFileId });
  console.log(`Drive state loaded (version=${assistantState.version}, updatedAt=${assistantState.updatedAt})`);
} catch (err) {
  console.error('ERROR loading Drive state:', err.message);
  process.exit(1);
}

const priorConvos = assistantState.conversations || {};
const ignoredKeys = new Set(Object.keys(assistantState.ignoredConversations || {}));
const snoozedKeys = new Set(
  Object.entries(assistantState.snoozedConversations || {})
    .filter(([, v]) => v.until && v.until > todayISO)
    .map(([k]) => k)
);

// ── STEP 2.5: scan Gmail ──────────────────────────────────────────────────────
console.log('Scanning Gmail…');
const benEmails = accounts.map(a => a.email.toLowerCase());
let mailboxResults;
try {
  mailboxResults = await scanConfiguredMailboxes();
} catch (err) {
  console.error('ERROR scanning Gmail:', err.message);
  process.exit(1);
}

const accessTokensByAccount = Object.fromEntries(
  mailboxResults.map(r => [r.account.email, r.accessToken])
);

const allMessages = mailboxResults.flatMap(r => r.messages);
console.log(`Raw messages: ${allMessages.length}`);

const deduped = dedupeMessages(allMessages);
console.log(`After dedupe: ${deduped.length}`);

const conversations = groupConversations(deduped, benEmails);
console.log(`Conversations: ${conversations.length}`);

// Filter out ignored / snoozed
const activeConvos = conversations.filter(c => {
  if (ignoredKeys.has(c.conversationKey)) return false;
  if (snoozedKeys.has(c.conversationKey)) return false;
  return true;
});
console.log(`Active conversations: ${activeConvos.length}`);

// ── STEP 3: scan Calendar ────────────────────────────────────────────────────
console.log('Scanning calendar…');
const allCalendars = [];
const tomorrowEvents = [];

for (const account of accounts) {
  try {
    const result = await listTomorrowEventsForAccount({
      account,
      clientId,
      clientSecret,
      timeMinISO: tomorrowMin,
      timeMaxISO: tomorrowMax
    });

    for (const cal of result.calendars) {
      if (!allCalendars.find(c => c.id === cal.id)) {
        allCalendars.push({
          id: cal.id,
          name: cal.summary || cal.id,
          color: cal.backgroundColor || '#3A7556'
        });
      }
    }

    for (const ev of result.events) {
      if (!tomorrowEvents.find(e => e.title === ev.title && e.start === ev.start)) {
        tomorrowEvents.push(ev);
      }
    }
  } catch (err) {
    console.error(`Calendar scan error for ${account.email}: ${err.message}`);
  }
}

tomorrowEvents.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
console.log(`Calendar events tomorrow: ${tomorrowEvents.length}`);

// ── STEP 4: categorize emails ─────────────────────────────────────────────────
const urgent = [], business = [], personal = [], financial = [], newsletter = [], waiting = [], spam = [];
const calendarProposals = [], suggestedReplies = [], todos = [];

// gmail account index lookup for direct links
const accountIndex = Object.fromEntries(accounts.map((a, i) => [a.email, i]));

for (const convo of activeConvos) {
  const latest = convo.latestMessage;
  if (!latest) continue;

  const labels = latest.labelIds || [];
  const subject = String(latest.subject || '').toLowerCase();
  const from = String(latest.from || '').toLowerCase();
  const snippet = String(latest.snippet || '');
  const sender = parseSender(latest.from || '');
  const prior = priorConvos[convo.conversationKey];

  // Check for new activity vs prior state
  const priorStatus = prior?.status;
  const latestMsgId = latest.rfcMessageId;
  const priorLatestMsgId = prior?.latestRfcMessageId;
  const hasNewActivity = !prior || latestMsgId !== priorLatestMsgId;

  // Skip if already handled and no new activity (unless urgent)
  if (priorStatus === 'done' && !hasNewActivity) continue;
  if ((priorStatus === 'ignored') && !hasNewActivity) continue;

  const item = {
    conversationKey: convo.conversationKey,
    sourceAccount: latest.sourceAccount,
    account: latest.sourceAccount,
    gmailThreadId: latest.gmailThreadId,
    gmailAccountIndex: accountIndex[latest.sourceAccount] ?? 0,
    sender: latest.from || '',
    senderName: sender.name,
    senderEmail: sender.email,
    subject: latest.subject || '(no subject)',
    snippet: snippet,
    summary: prior?.summary || snippet,
    date: latest.date || '',
    status: convo.status
  };

  // Spam / Promotions
  if (labels.includes('SPAM') || labels.includes('TRASH')) {
    spam.push({ ...item, summary: snippet.slice(0, 100) });
    continue;
  }
  if (labels.includes('CATEGORY_PROMOTIONS')) {
    newsletter.push({ ...item, summary: snippet.slice(0, 100) });
    continue;
  }
  if (labels.includes('CATEGORY_SOCIAL')) {
    newsletter.push({ ...item, summary: snippet.slice(0, 100) });
    continue;
  }

  // Newsletter / digest detection
  if (
    subject.includes('newsletter') ||
    subject.includes('unsubscribe') ||
    subject.includes('digest') ||
    from.includes('no-reply') ||
    from.includes('noreply') ||
    from.includes('newsletter') ||
    from.includes('mailchimp') ||
    from.includes('updates@') ||
    from.includes('notifications@') ||
    from.includes('do-not-reply') ||
    from.includes('donotreply') ||
    subject.includes('weekly update') ||
    subject.includes('monthly update')
  ) {
    newsletter.push({ ...item, summary: snippet.slice(0, 100) });
    continue;
  }

  // Financial — categorize first so it's separate from business/personal
  const isFinancial =
    subject.includes('invoice') ||
    subject.includes('payment') ||
    subject.includes('receipt') ||
    subject.includes('billing') ||
    subject.includes('statement') ||
    subject.includes('bank') ||
    subject.includes('payroll') ||
    subject.includes('tax') ||
    subject.includes('refund') ||
    from.includes('stripe') ||
    from.includes('quickbooks') ||
    from.includes('paypal');

  // Urgent detection (subject-line only)
  if (isUrgent(latest)) {
    urgent.push({ ...item, summary: snippet });
    if (convo.status === 'waiting_on_ben' && hasNewActivity && !isAutoReply(latest)) {
      suggestedReplies.push({
        account: item.account,
        sender: latest.from,
        senderEmail: sender.email,
        to: sender.email,
        subject: latest.subject,
        title: `Reply to: ${latest.subject}`,
        detail: `Urgent message from ${sender.name || sender.email}`,
        body: '',
        gmailThreadId: latest.gmailThreadId
      });
    }
    continue;
  }

  if (isFinancial) {
    financial.push(item);
    if (convo.status === 'waiting_on_ben') {
      todos.push({ account: item.account, priority: 'medium', text: `Review: ${latest.subject}`, conversationKey: convo.conversationKey });
    }
    continue;
  }

  // Business or personal (determine category)
  const isBusiness = isBusinessEmail(latest, accounts);

  // Waiting/FYI — these go in the waiting bucket even if business/personal
  if (convo.status === 'waiting_on_other') {
    waiting.push(item);
    continue;
  }
  if (labels.includes('CATEGORY_UPDATES') && convo.status !== 'waiting_on_ben') {
    waiting.push(item);
    continue;
  }

  if (isBusiness) {
    business.push(item);
  } else {
    personal.push(item);
  }

  // Suggest replies for conversations where Ben still owes a response.
  // Include both new messages and ongoing waiting_on_ben (not yet replied).
  if (convo.status === 'waiting_on_ben' && !latest.fromMe && !isAutoReply(latest)) {
    const isNew = hasNewActivity;
    const wasAlsoWaiting = prior?.status === 'waiting_on_ben';
    // Prioritize new messages; also include previously pending (score for sorting)
    suggestedReplies.push({
      account: item.account,
      sender: latest.from,
      senderEmail: sender.email,
      to: sender.email,
      subject: latest.subject,
      title: `Reply to: ${latest.subject}`,
      detail: isNew
        ? `New message from ${sender.name || sender.email}`
        : `Awaiting your reply — from ${sender.name || sender.email}`,
      body: '',
      gmailThreadId: latest.gmailThreadId,
      _isNew: isNew
    });
  }

  // Calendar proposals — look for scheduling keywords
  if (looksLikeMeeting(latest) && !prior?.calendarProposalSeen) {
    const proposal = extractCalendarProposal(latest, item);
    if (proposal) calendarProposals.push(proposal);
  }

  // To-dos
  if (needsTodo(latest, convo.status, prior)) {
    todos.push({
      account: item.account,
      priority: isUrgent(latest) ? 'high' : 'medium',
      text: `Follow up: ${latest.subject}`,
      conversationKey: convo.conversationKey
    });
  }
}

// Sort: new messages first, then oldest pending; cap at 5
suggestedReplies.sort((a, b) => (b._isNew ? 1 : 0) - (a._isNew ? 1 : 0));
const trimmedReplies = suggestedReplies.slice(0, 5).map(r => { delete r._isNew; return r; });

// ── STEP 5: write briefing.json ───────────────────────────────────────────────
const generatedAt = now.toISOString();
const dataFreshThrough = now.toISOString();
const lastSuccessfulBuildAt = assistantState.recentRuns?.find(r => r.success)?.completedAt || generatedAt;

const briefing = {
  metadata: {
    generatedAt,
    date: todayISO,
    timezone: TZ,
    lastSuccessfulBuildAt,
    dataFreshThrough,
    liveUrl,
    todayLabel: formatDateLabel(now, TZ),
    tomorrowLabel: formatDateLabel(addDays(now, 1), TZ)
  },
  stats: {
    emailsScanned: deduped.length,
    urgent: urgent.length,
    eventsTomorrow: tomorrowEvents.length,
    proposedEvents: calendarProposals.length,
    suggestedReplies: trimmedReplies.length,
    todos: todos.length
  },
  accounts: accounts.map(a => ({ email: a.email, label: a.label, type: a.type || 'Personal' })),
  calendars: allCalendars.length ? allCalendars : [{ id: 'primary', name: 'Primary Calendar', color: '#3A7556' }],
  sections: {
    urgent,
    tomorrowSchedule: tomorrowEvents,
    calendarProposals,
    suggestedReplies: trimmedReplies,
    todos,
    business,
    personal,
    financial,
    waiting,
    newsletter,
    spam
  }
};

fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));
console.log('Wrote briefing.json');
console.log(`Stats: urgent=${urgent.length} business=${business.length} personal=${personal.length} financial=${financial.length} waiting=${waiting.length} newsletter=${newsletter.length} spam=${spam.length}`);
console.log(`Actions: replies=${trimmedReplies.length} todos=${todos.length} calProposals=${calendarProposals.length}`);

// Export state update data for later use
const stateUpdate = {
  driveToken,
  conversations: activeConvos,
  allMessages: deduped,
  urgent,
  todos
};
fs.writeFileSync('/tmp/briefing-state-update.json', JSON.stringify({
  conversations: activeConvos.map(c => ({
    conversationKey: c.conversationKey,
    status: c.status,
    accountsSeen: c.accountsSeen,
    latestRfcMessageId: c.latestMessage?.rfcMessageId,
    latestGmailThreadId: c.latestMessage?.gmailThreadId,
    latestSubject: c.latestMessage?.subject,
    latestDate: c.latestMessage?.date,
    sourceAccount: c.latestMessage?.sourceAccount
  })),
  todos,
  generatedAt
}, null, 2));
console.log('State update data cached for writeState step.');

// ── helpers ──────────────────────────────────────────────────────────────────
function localDate(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function formatDateLabel(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).format(date);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function parseSender(from) {
  const match = String(from || '').match(/^"?([^"<]+?)"?\s*<([^>]+)>/) ||
                String(from || '').match(/^([^@\s]+@[^\s]+)$/);
  if (match && match[2]) return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
  if (match && match[1]) return { name: '', email: match[1].trim().toLowerCase() };
  return { name: '', email: from || '' };
}

function isUrgent(msg) {
  // Only use subject-line keywords — IMPORTANT is a Gmail auto-label and not truly urgent
  const subject = String(msg.subject || '').toLowerCase();
  return (
    subject.includes('urgent') ||
    subject.includes('asap') ||
    subject.includes('action required') ||
    subject.includes('time sensitive') ||
    subject.includes('deadline') ||
    subject.includes('overdue') ||
    subject.includes('past due') ||
    subject.includes('final notice')
  );
}

function isAutoReply(msg) {
  const subject = String(msg.subject || '').toLowerCase();
  return (
    subject.startsWith('re: out of office') ||
    subject.includes('auto-reply') ||
    subject.includes('automatic reply') ||
    subject.includes('out of office')
  );
}

function isBusinessEmail(msg, accounts) {
  const accountEmail = String(msg.sourceAccount || '');
  const acct = accounts.find(a => a.email === accountEmail);
  if (acct?.type === 'business') return true;
  // Heartspring and Biodynamics are business accounts
  if (accountEmail.includes('heartspring') || accountEmail.includes('biodynamics')) return true;
  const from = String(msg.from || '').toLowerCase();
  // Heuristic: if from a domain that's not gmail/yahoo/hotmail etc, business
  const domainMatch = from.match(/@([^>]+)>/);
  const domain = domainMatch ? domainMatch[1] : '';
  const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'aol.com'];
  if (domain && !personalDomains.some(d => domain.endsWith(d))) return true;
  return false;
}

function looksLikeMeeting(msg) {
  const subject = String(msg.subject || '').toLowerCase();
  const snippet = String(msg.snippet || '').toLowerCase();
  return (
    subject.includes('meeting') ||
    subject.includes('call') ||
    subject.includes('schedule') ||
    subject.includes('appointment') ||
    subject.includes('zoom') ||
    subject.includes('conference') ||
    snippet.includes('let\'s schedule') ||
    snippet.includes('can we meet') ||
    snippet.includes('availability') ||
    snippet.includes('are you free') ||
    snippet.includes('pick a time') ||
    snippet.includes('calendar invite')
  );
}

function extractCalendarProposal(msg, item) {
  const subject = String(msg.subject || '');
  const snippet = String(msg.snippet || '');
  // Simple extraction — no date parsing, just surface the suggestion
  const tomorrowStr = tomorrowISO + 'T09:00:00';
  return {
    id: `proposal-${item.conversationKey?.slice(0, 8) || Date.now()}`,
    account: item.account,
    title: subject.replace(/^(re:|fwd:|fw:)\s*/i, '').trim() || 'Meeting',
    start: tomorrowStr,
    end: tomorrowISO + 'T10:00:00',
    location: '',
    detail: snippet.slice(0, 120),
    context: `From: ${item.senderName || item.senderEmail}`,
    sourceSender: item.sender,
    sourceSubject: subject,
    calendarId: 'primary'
  };
}

function needsTodo(msg, status, prior) {
  if (status !== 'waiting_on_ben') return false;
  if (prior?.todoAdded) return false;
  const subject = String(msg.subject || '').toLowerCase();
  return (
    subject.includes('follow up') ||
    subject.includes('action') ||
    subject.includes('please') ||
    subject.includes('can you') ||
    subject.includes('request') ||
    subject.includes('reminder')
  );
}
