/**
 * Gather all data for the daily briefing:
 * - Load Drive state
 * - Scan Gmail
 * - Scan Calendar
 * - Categorize and write briefing.json
 */

import { getAccessToken } from './google-auth.mjs';
import { readState } from './drive-state.mjs';
import { scanConfiguredMailboxes } from './gmail-api.mjs';
import { dedupeMessages, groupConversations } from './continuity.mjs';
import { listTomorrowEventsForAccount } from './calendar-api.mjs';
import { writeFileSync } from 'fs';

const NOW = new Date();
const TODAY_ISO = new Date(NOW.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const todayStr = TODAY_ISO.toISOString().slice(0, 10);

// Tomorrow in America/New_York
const tomorrowDate = new Date(TODAY_ISO);
tomorrowDate.setDate(tomorrowDate.getDate() + 1);
const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);
const timeMinISO = `${tomorrowStr}T00:00:00-04:00`;
const timeMaxISO = `${tomorrowStr}T23:59:59-04:00`;

console.log(`TODAY: ${todayStr}, TOMORROW: ${tomorrowStr}`);

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const driveFileId = process.env.DRIVE_STATE_FILE_ID;

// --- STEP 2: Load assistant memory ---
const driveAccount = accounts[0];
const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
const driveAccessToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });

let assistantState;
try {
  assistantState = await readState({ accessToken: driveAccessToken, fileId: driveFileId });
  console.log(`Loaded assistant state (version ${assistantState.version || 'unknown'})`);
} catch (err) {
  console.error('FATAL: Could not load Drive state:', err.message);
  process.exit(1);
}

// --- STEP 2.5: Scan Gmail ---
console.log('Scanning Gmail...');
const mailboxResults = await scanConfiguredMailboxes();
const allMessages = mailboxResults.flatMap(r => r.messages);
const deduped = dedupeMessages(allMessages);
const benEmails = accounts.map(a => a.email);
const conversations = groupConversations(deduped, benEmails);

console.log(`Scanned ${allMessages.length} raw messages → ${deduped.length} deduped → ${conversations.length} conversations`);

// --- STEP 3: Scan Calendar ---
console.log(`Scanning calendar for ${tomorrowStr}...`);
const allEvents = [];
const allCalendars = [];
const seenCalendarIds = new Set();

for (const account of accounts) {
  try {
    const { calendars, events } = await listTomorrowEventsForAccount({
      account, clientId, clientSecret, timeMinISO, timeMaxISO
    });
    for (const cal of calendars) {
      if (!seenCalendarIds.has(cal.id)) {
        seenCalendarIds.add(cal.id);
        allCalendars.push({
          id: cal.id,
          name: cal.summary || cal.id,
          color: cal.backgroundColor || ''
        });
      }
    }
    allEvents.push(...events);
  } catch (err) {
    console.warn(`Calendar scan failed for ${account.email}: ${err.message}`);
  }
}

// Dedupe events by title+start
const seenEventKeys = new Set();
const tomorrowSchedule = [];
for (const evt of allEvents) {
  const key = `${evt.title}|${evt.start}`;
  if (!seenEventKeys.has(key)) {
    seenEventKeys.add(key);
    tomorrowSchedule.push(evt);
  }
}
tomorrowSchedule.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
console.log(`Calendar: ${tomorrowSchedule.length} unique events tomorrow`);

// --- STEP 4: Categorize emails ---
const ignored = assistantState.ignoredConversations || {};
const snoozed = assistantState.snoozedConversations || {};
const priorConvos = assistantState.conversations || {};

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

function parseSenderName(from) {
  if (!from) return { senderName: '', senderEmail: '' };
  const match = from.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) return { senderName: match[1].trim(), senderEmail: match[2].trim().toLowerCase() };
  const emailOnly = from.match(/<([^>]+)>/);
  if (emailOnly) return { senderName: '', senderEmail: emailOnly[1].toLowerCase() };
  return { senderName: '', senderEmail: from.trim().toLowerCase() };
}

function detectCategory(convo) {
  const latest = convo.latestMessage;
  const subject = String(latest.subject || '').toLowerCase();
  const from = String(latest.from || '').toLowerCase();
  const labels = latest.labelIds || [];

  if (labels.includes('SPAM') || labels.includes('CATEGORY_SPAM')) return 'spam';
  if (
    labels.includes('CATEGORY_PROMOTIONS') ||
    from.includes('no-reply') ||
    from.includes('noreply') ||
    from.includes('newsletter') ||
    subject.includes('newsletter') ||
    subject.includes('unsubscribe') ||
    labels.includes('CATEGORY_SOCIAL')
  ) return 'newsletter';

  const financialKeywords = ['invoice', 'payment', 'receipt', 'bill', 'statement', 'bank', 'transaction',
    'charge', 'subscription', 'stripe', 'paypal', 'venmo', 'quickbooks', 'donation', 'order confirmation',
    'your order', 'refund', 'tax', 'payroll', 'deposit'];
  if (financialKeywords.some(k => subject.includes(k) || from.includes(k))) return 'financial';

  const urgentKeywords = ['urgent', 'asap', 'emergency', 'critical', 'immediately', 'time sensitive',
    'deadline', 'expiring', 'overdue', 'past due', 'action required', 'important notice'];
  if (urgentKeywords.some(k => subject.includes(k))) return 'urgent';

  const businessKeywords = ['contract', 'proposal', 'client', 'vendor', 'agreement', 'meeting',
    'schedule', 'project', 'invoice', 'quote', 'partnership', 'biodynamics', 'heartspring'];
  const fromDomains = ['heartspringgardens', 'biodynamics'];
  if (
    businessKeywords.some(k => subject.includes(k)) ||
    fromDomains.some(d => from.includes(d)) ||
    labels.includes('CATEGORY_PERSONAL')
  ) return 'business';

  if (convo.status === 'fyi' || convo.status === 'waiting_on_other') return 'waiting';
  if (labels.includes('CATEGORY_UPDATES')) return 'business';

  return 'personal';
}

function buildCalendarProposal(convo) {
  const latest = convo.latestMessage;
  const subject = String(latest.subject || '').toLowerCase();
  const snippet = String(latest.snippet || '').toLowerCase();
  const datePatterns = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
    /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
    /\b(next week|this week|tomorrow)\b/
  ];
  const timePatterns = [/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i, /\b\d{1,2}:\d{2}\b/];
  const meetingKeywords = ['meeting', 'call', 'zoom', 'appointment', 'schedule', 'get together',
    'lunch', 'dinner', 'coffee', 'visit', 'tour', 'demo', 'interview'];

  const hasMeetingKeyword = meetingKeywords.some(k => subject.includes(k) || snippet.includes(k));
  const hasDate = datePatterns.some(p => p.test(subject) || p.test(snippet));
  const hasTime = timePatterns.some(p => p.test(subject) || p.test(snippet));

  if (hasMeetingKeyword && (hasDate || hasTime)) return true;
  return false;
}

function buildSuggestedReply(convo) {
  const latest = convo.latestMessage;
  if (convo.status !== 'waiting_on_ben') return null;
  const from = String(latest.from || '');
  const { senderName, senderEmail } = parseSenderName(from);
  if (!senderEmail || senderEmail.includes('no-reply') || senderEmail.includes('noreply')) return null;

  const subject = latest.subject || '';
  const snippet = String(latest.snippet || '').slice(0, 200);
  const greeting = senderName ? `Hi ${senderName.split(' ')[0]},` : 'Hi,';

  return {
    account: convo.latestMessage.sourceAccount,
    sender: from,
    senderName,
    senderEmail,
    subject,
    title: `Reply to: ${subject}`,
    detail: snippet,
    body: `${greeting}\n\nThank you for reaching out. [Add your response here.]\n\nBest,\nBen`,
    gmailThreadId: latest.gmailThreadId
  };
}

let emailsScanned = 0;
const suggestedRepliesAdded = new Set();

for (const convo of conversations) {
  const key = convo.conversationKey;
  const latest = convo.latestMessage;

  // Skip ignored
  if (ignored[key]) continue;

  // Skip snoozed
  if (snoozed[key]) {
    const snoozeUntil = new Date(snoozed[key].until);
    if (NOW < snoozeUntil) continue;
  }

  emailsScanned++;

  const { senderName, senderEmail } = parseSenderName(latest.from || '');
  const item = {
    account: latest.sourceAccount,
    sender: latest.from || '',
    senderName,
    senderEmail,
    subject: latest.subject || '',
    summary: latest.snippet || '',
    snippet: (latest.snippet || '').slice(0, 200),
    gmailThreadId: latest.gmailThreadId,
    conversationKey: key,
    status: convo.status
  };

  const category = detectCategory(convo);

  if (category === 'spam') {
    sections.spam.push(item);
    continue;
  }
  if (category === 'newsletter') {
    sections.newsletter.push(item);
    continue;
  }
  if (category === 'urgent') {
    sections.urgent.push(item);
  }

  if (category === 'financial') {
    sections.financial.push(item);
  } else if (category === 'business') {
    sections.business.push(item);
  } else if (category === 'waiting') {
    sections.waiting.push(item);
  } else if (category !== 'urgent' && category !== 'spam' && category !== 'newsletter' && category !== 'financial') {
    sections.personal.push(item);
  }

  // Calendar proposal detection
  if (buildCalendarProposal(convo)) {
    sections.calendarProposals.push({
      id: key,
      account: latest.sourceAccount,
      title: `Possible event: ${latest.subject || 'Meeting'}`,
      start: null,
      end: null,
      location: '',
      detail: (latest.snippet || '').slice(0, 200),
      context: 'Detected scheduling language in email',
      sourceSender: latest.from || '',
      sourceSubject: latest.subject || '',
      calendarId: ''
    });
  }

  // Suggested replies
  if (convo.status === 'waiting_on_ben' && !suggestedRepliesAdded.has(key)) {
    const reply = buildSuggestedReply(convo);
    if (reply) {
      sections.suggestedReplies.push(reply);
      suggestedRepliesAdded.add(key);
    }
  }
}

// Build todos from urgent + waiting_on_ben
for (const item of [...sections.urgent, ...sections.business]) {
  if (item.status === 'waiting_on_ben') {
    sections.todos.push({
      account: item.account,
      priority: sections.urgent.includes(item) ? 'high' : 'medium',
      text: `Reply to ${item.senderName || item.senderEmail || item.sender}: ${item.subject}`
    });
  }
}

// --- STEP 5: Write briefing.json ---
const generatedAt = NOW.toISOString();

const briefing = {
  metadata: {
    generatedAt,
    date: todayStr,
    timezone: 'America/New_York',
    lastSuccessfulBuildAt: assistantState.recentRuns?.slice(-1)[0]?.completedAt || generatedAt,
    dataFreshThrough: generatedAt,
    liveUrl: 'https://bendavis354-a11y.github.io/daily-briefing/',
    todayLabel: `Sunday, May 31, 2026`,
    tomorrowLabel: `Monday, June 1, 2026`
  },
  stats: {
    emailsScanned,
    urgent: sections.urgent.length,
    eventsTomorrow: tomorrowSchedule.length,
    proposedEvents: sections.calendarProposals.length,
    suggestedReplies: sections.suggestedReplies.length,
    todos: sections.todos.length
  },
  accounts: accounts.map(a => ({
    email: a.email,
    label: a.label || a.email,
    type: a.type || 'Personal'
  })),
  calendars: allCalendars,
  sections
};

writeFileSync('/home/user/daily-briefing/briefing.json', JSON.stringify(briefing, null, 2));
console.log('briefing.json written');

// Export state for memory update
const statePayload = {
  driveAccessToken,
  driveFileId,
  conversations,
  briefing,
  assistantState
};
writeFileSync('/tmp/briefing-state.json', JSON.stringify(statePayload, null, 2));
console.log('State payload written to /tmp/briefing-state.json');
