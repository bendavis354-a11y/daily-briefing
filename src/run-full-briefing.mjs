/**
 * Full daily briefing gather — Steps 1–6 + iMessage + weekSchedule
 * Writes briefing.json and /tmp/briefing-state.json for the state update step.
 */

import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, emptyState } from './drive-state.mjs';
import { scanConfiguredMailboxes, loadConnectorMessages } from './gmail-api.mjs';
import { dedupeMessages, groupConversations } from './continuity.mjs';
import { pickDriveAccount, isConnectorAccount } from './accounts.mjs';
import { listTomorrowEventsForAccount, listCalendars, listEvents } from './calendar-api.mjs';

// ── STEP 1: Dates ─────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const now = new Date();

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

// Detect current NY offset (EDT = -4, EST = -5)
function nyOffset(date) {
  const utcHour = date.getUTCHours();
  const nyDate = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  const diff = Math.round((nyDate - date) / 3600000);
  return diff >= 0 ? `+0${diff}:00` : `-0${Math.abs(diff)}:00`;
}

const todayISO = localDate(now, TZ);
const tomorrowISO = localDate(addDays(now, 1), TZ);
const offset = (() => {
  // Check if EDT (-4) or EST (-5)
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const janOffset = -jan.getTimezoneOffset();
  const nyDate = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const diffH = Math.round((nyDate.getTime() - now.getTime()) / 3600000);
  return diffH >= 0 ? `+0${diffH}:00` : `-0${Math.abs(diffH)}:00`;
})();

// Use -04:00 for June (EDT)
const NY_OFFSET = '-04:00';

const tomorrowMin = `${tomorrowISO}T00:00:00${NY_OFFSET}`;
const tomorrowMax = `${tomorrowISO}T23:59:59${NY_OFFSET}`;
const weekMin = `${todayISO}T00:00:00${NY_OFFSET}`;
const weekMax = `${localDate(addDays(now, 6), TZ)}T23:59:59${NY_OFFSET}`;

console.log(`STEP 1: today=${todayISO}  tomorrow=${tomorrowISO}  week window=${weekMin} to ${weekMax}`);

// ── Credentials ───────────────────────────────────────────────────────────────
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;
const driveImessageFileId = process.env.DRIVE_IMESSAGE_FILE_ID;
const liveUrl = process.env.GITHUB_PAGES_URL || '';

if (!clientId || !clientSecret) throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');
if (!accounts.length) throw new Error('GMAIL_ACCOUNTS_JSON is empty');

// ── STEP 2: Load Drive state ──────────────────────────────────────────────────
// State I/O rides a durable Workspace account (never the weekly-expiring
// consumer token). The agent can also hand in a connector-read copy of the state
// file via CONNECTOR_STATE_FILE, which is used in preference to a direct read.
console.log('STEP 2: Loading Drive state…');
const driveAccount = pickDriveAccount(accounts);
const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
console.log(`Drive account: ${driveAccount.email}`);

let assistantState;
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;
try {
  if (connectorStateFile) {
    assistantState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
    console.log(`Drive state loaded from connector file (version=${assistantState.version}, updatedAt=${assistantState.updatedAt})`);
  } else {
    assistantState = await readState({ accessToken: driveToken, fileId: driveFileId });
    console.log(`Drive state loaded (version=${assistantState.version}, updatedAt=${assistantState.updatedAt})`);
  }
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

// ── STEP 2B: Load iMessage export ─────────────────────────────────────────────
console.log('STEP 2B: Loading iMessage export…');
let imessageData = null;
let imessageStatus = 'missing';

if (driveImessageFileId) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveImessageFileId}?alt=media`,
      { headers: { authorization: `Bearer ${driveToken}` } }
    );
    if (!res.ok) {
      console.log(`iMessage Drive read failed: ${res.status} — continuing without iMessages`);
      imessageStatus = 'missing';
    } else {
      imessageData = await res.json();
      const exportedAt = new Date(imessageData.exportedAt || 0);
      const ageHours = (now - exportedAt) / 3600000;
      if (ageHours > 6) {
        console.log(`iMessage export is stale (${ageHours.toFixed(1)}h old, exported at ${imessageData.exportedAt})`);
        imessageStatus = 'stale';
      } else {
        imessageStatus = 'fresh';
        console.log(`iMessage export loaded: ${imessageData.messages?.length || 0} messages, exported ${imessageData.exportedAt}`);
      }
    }
  } catch (err) {
    console.log(`iMessage load error: ${err.message} — continuing without iMessages`);
    imessageStatus = 'missing';
  }
}

// ── STEP 3: Scan Gmail ────────────────────────────────────────────────────────
console.log('STEP 3: Scanning Gmail…');
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

const oauthMessages = mailboxResults.flatMap(r => r.messages);
const connectorMessages = loadConnectorMessages();
const allMessages = [...oauthMessages, ...connectorMessages];
console.log(`Raw messages: ${allMessages.length} (oauth=${oauthMessages.length}, connector=${connectorMessages.length})`);

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

// ── STEP 4: Scan Calendar ─────────────────────────────────────────────────────
console.log('STEP 4: Scanning calendar…');
const allCalendars = [];
const tomorrowEvents = [];
const weekEvents = [];
const seenCalIds = new Set();

for (const account of accounts) {
  // Connector accounts have no usable OAuth token; their calendar (if needed) is
  // supplied by the agent through the Calendar connector, not scanned here.
  if (isConnectorAccount(account)) {
    console.log(`Skipping OAuth calendar scan for connector account ${account.email}`);
    continue;
  }
  const refreshToken = process.env[account.refreshTokenEnv];
  let accessToken;
  try {
    accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  } catch (err) {
    console.error(`Calendar auth error for ${account.email}: ${err.message}`);
    continue;
  }

  try {
    const cals = await listCalendars({ accessToken });
    for (const cal of cals) {
      if (!seenCalIds.has(cal.id)) {
        seenCalIds.add(cal.id);
        allCalendars.push({ id: cal.id, name: cal.summary || cal.id, color: cal.backgroundColor || '#3A7556' });
      }
    }

    // Tomorrow events
    for (const cal of cals) {
      try {
        const evts = await listEvents({ accessToken, calendarId: cal.id, timeMinISO: tomorrowMin, timeMaxISO: tomorrowMax });
        for (const ev of evts) {
          const key = `${ev.summary}|${ev.start?.dateTime || ev.start?.date}`;
          if (!tomorrowEvents.find(e => `${e.title}|${e.start}` === key)) {
            tomorrowEvents.push(buildEvent(ev, cal));
          }
        }
      } catch (_) {}
    }

    // Week events
    for (const cal of cals) {
      try {
        const evts = await listEvents({ accessToken, calendarId: cal.id, timeMinISO: weekMin, timeMaxISO: weekMax });
        for (const ev of evts) {
          const key = `${ev.summary}|${ev.start?.dateTime || ev.start?.date}`;
          if (!weekEvents.find(e => `${e.title}|${e.start}` === key)) {
            weekEvents.push(buildEvent(ev, cal));
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error(`Calendar scan error for ${account.email}: ${err.message}`);
  }
}

tomorrowEvents.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
weekEvents.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
console.log(`Calendar: ${tomorrowEvents.length} events tomorrow, ${weekEvents.length} this week`);

function buildEvent(ev, cal) {
  return {
    title: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    allDay: Boolean(ev.start?.date),
    location: ev.location || '',
    calendarName: cal.summary || cal.id,
    calendarId: cal.id,
    color: cal.backgroundColor || '',
    htmlLink: ev.htmlLink || '',
    attendees: (ev.attendees || []).map(a => a.email).filter(Boolean)
  };
}

// ── STEP 5: Classify emails ───────────────────────────────────────────────────
console.log('STEP 5: Classifying emails…');

const urgent = [], business = [], personal = [], financial = [], newsletter = [], waiting = [], spam = [];
const calendarProposals = [], suggestedReplies = [], todos = [];

const accountIndex = Object.fromEntries(accounts.map((a, i) => [a.email, i]));

// Build gmailLinks for a conversation's latest message. Cross-account duplicates
// are merged during dedup, so per-account thread ids live on
// latestMessage.gmailThreadIdByAccount as well as on individual messages.
function threadIdsByAccount(convo) {
  const byAccount = {};
  for (const msg of convo.messages) {
    for (const [acct, tid] of Object.entries(msg.gmailThreadIdByAccount || {})) {
      if (acct && tid && !byAccount[acct]) byAccount[acct] = tid;
    }
    if (msg.sourceAccount && msg.gmailThreadId && !byAccount[msg.sourceAccount]) {
      byAccount[msg.sourceAccount] = msg.gmailThreadId;
    }
  }
  return byAccount;
}

function buildGmailLinks(convo) {
  return Object.entries(threadIdsByAccount(convo))
    .map(([sourceAccount, gmailThreadId]) => ({ sourceAccount, gmailThreadId }));
}

function mainGmailLink(convo) {
  // Prefer bendavis354@gmail.com copy for View Thread links
  const mainAccount = 'bendavis354@gmail.com';
  const byAccount = threadIdsByAccount(convo);
  if (byAccount[mainAccount]) return { viewThreadAccount: mainAccount, viewThreadId: byAccount[mainAccount] };
  const latest = convo.latestMessage;
  return { viewThreadAccount: latest.sourceAccount, viewThreadId: latest.gmailThreadId };
}

for (const convo of activeConvos) {
  const latest = convo.latestMessage;
  if (!latest) continue;

  const labels = latest.labelIds || [];
  const subject = String(latest.subject || '').toLowerCase();
  const from = String(latest.from || '').toLowerCase();
  const snippet = String(latest.snippet || '');
  const sender = parseSender(latest.from || '');
  const prior = priorConvos[convo.conversationKey];

  const latestMsgId = latest.rfcMessageId;
  const priorLatestMsgId = prior?.latestRfcMessageId;
  const hasNewActivity = !prior || latestMsgId !== priorLatestMsgId;

  if (prior?.status === 'done' && !hasNewActivity) continue;
  if (prior?.status === 'ignored' && !hasNewActivity) continue;

  const gmailLinks = buildGmailLinks(convo);
  const { viewThreadAccount, viewThreadId } = mainGmailLink(convo);

  const item = {
    id: convo.conversationKey,
    conversationKey: convo.conversationKey,
    sourceAccount: latest.sourceAccount,
    account: latest.sourceAccount,
    gmailThreadId: latest.gmailThreadId,
    gmailMessageId: latest.gmailMessageId,
    gmailLinks,
    viewThreadAccount,
    viewThreadId,
    sender: latest.from || '',
    senderName: sender.name,
    senderEmail: sender.email,
    subject: latest.subject || '(no subject)',
    snippet: snippet.slice(0, 200),
    summary: prior?.summary || snippet.slice(0, 200),
    date: latest.date || '',
    status: convo.status
  };

  // Spam / Trash
  if (labels.includes('SPAM') || labels.includes('TRASH')) {
    spam.push(item);
    continue;
  }

  // Promotions / Social → newsletter
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL')) {
    newsletter.push(item);
    continue;
  }

  // Newsletter heuristics
  if (
    subject.includes('newsletter') || subject.includes('unsubscribe') || subject.includes('digest') ||
    from.includes('no-reply') || from.includes('noreply') || from.includes('newsletter') ||
    from.includes('mailchimp') || from.includes('do-not-reply') || from.includes('donotreply') ||
    from.includes('updates@') || from.includes('notifications@') ||
    subject.includes('weekly update') || subject.includes('monthly update')
  ) {
    newsletter.push(item);
    continue;
  }

  // Financial
  const isFinancial =
    subject.includes('invoice') || subject.includes('payment') || subject.includes('receipt') ||
    subject.includes('billing') || subject.includes('statement') || subject.includes('bank') ||
    subject.includes('payroll') || subject.includes('tax') || subject.includes('refund') ||
    subject.includes('donation') || subject.includes('order confirmation') ||
    from.includes('stripe') || from.includes('quickbooks') || from.includes('paypal') ||
    from.includes('venmo') || from.includes('zelle');

  // Urgent
  const isUrgentEmail = isUrgent(latest);
  if (isUrgentEmail) {
    urgent.push(item);
    if (convo.status === 'waiting_on_ben' && hasNewActivity && !isAutoReply(latest)) {
      suggestedReplies.push({
        id: `reply-${convo.conversationKey}`,
        conversationKey: convo.conversationKey,
        account: item.account,
        sourceAccount: item.sourceAccount,
        sender: latest.from,
        senderName: sender.name,
        senderEmail: sender.email,
        to: sender.email,
        subject: latest.subject,
        title: `Reply to: ${latest.subject}`,
        detail: `Urgent message from ${sender.name || sender.email}`,
        body: buildReplyBody(sender.name, latest.subject),
        gmailThreadId: latest.gmailThreadId,
        gmailLinks,
        viewThreadAccount,
        viewThreadId
      });
    }
    continue;
  }

  if (isFinancial) {
    financial.push(item);
    if (convo.status === 'waiting_on_ben') {
      todos.push({
        id: `todo-fin-${convo.conversationKey}`,
        conversationKey: convo.conversationKey,
        account: item.account,
        sourceAccount: item.sourceAccount,
        priority: 'medium',
        text: `Review: ${latest.subject}`,
        status: 'open',
        origin: 'email'
      });
    }
    continue;
  }

  // Waiting on other
  if (convo.status === 'waiting_on_other') {
    waiting.push(item);
    continue;
  }
  if (labels.includes('CATEGORY_UPDATES') && convo.status !== 'waiting_on_ben') {
    waiting.push(item);
    continue;
  }

  // Business vs personal
  const isBusiness = isBusinessEmail(latest, accounts);
  if (isBusiness) {
    business.push(item);
  } else {
    personal.push(item);
  }

  // Suggested replies (waiting_on_ben)
  if (convo.status === 'waiting_on_ben' && !isAutoReply(latest) && !latest.fromMe) {
    if (!sender.email.includes('no-reply') && !sender.email.includes('noreply') && sender.email) {
      suggestedReplies.push({
        id: `reply-${convo.conversationKey}`,
        conversationKey: convo.conversationKey,
        account: item.account,
        sourceAccount: item.sourceAccount,
        sender: latest.from,
        senderName: sender.name,
        senderEmail: sender.email,
        to: sender.email,
        subject: latest.subject,
        title: `Reply to: ${latest.subject}`,
        detail: hasNewActivity
          ? `New message from ${sender.name || sender.email}`
          : `Awaiting your reply — from ${sender.name || sender.email}`,
        body: buildReplyBody(sender.name, latest.subject),
        gmailThreadId: latest.gmailThreadId,
        gmailLinks,
        viewThreadAccount,
        viewThreadId,
        _isNew: hasNewActivity
      });
    }
  }

  // Calendar proposals
  if (looksLikeMeeting(latest)) {
    calendarProposals.push({
      id: `proposal-${convo.conversationKey}`,
      conversationKey: convo.conversationKey,
      account: item.account,
      sourceAccount: item.sourceAccount,
      title: (latest.subject || 'Meeting').replace(/^(re:|fwd:|fw:)\s*/i, '').trim(),
      start: null,
      end: null,
      location: '',
      detail: snippet.slice(0, 200),
      context: `From: ${sender.name || sender.email}`,
      sourceSender: latest.from,
      sourceSubject: latest.subject,
      calendarId: 'primary'
    });
  }

  // Todos
  if (needsTodo(latest, convo.status, prior)) {
    todos.push({
      id: `todo-${convo.conversationKey}`,
      conversationKey: convo.conversationKey,
      account: item.account,
      sourceAccount: item.sourceAccount,
      priority: 'medium',
      text: `Follow up: ${latest.subject}`,
      status: 'open',
      origin: 'email'
    });
  }
}

// Sort and cap suggested replies
suggestedReplies.sort((a, b) => (b._isNew ? 1 : 0) - (a._isNew ? 1 : 0));
const trimmedReplies = suggestedReplies.slice(0, 8).map(r => { delete r._isNew; return r; });

// ── STEP 5B: Process iMessages ────────────────────────────────────────────────
const imessageSection = [];
let imessagesScanned = 0;
let imessagesActionable = 0;

if (imessageData && imessageStatus !== 'missing') {
  const messages = imessageData.messages || [];
  imessagesScanned = messages.length;
  console.log(`Processing ${imessagesScanned} iMessages…`);

  // Group by chat
  const chatMap = new Map();
  for (const msg of messages) {
    const chatKey = msg.chat_id || msg.handle || 'unknown';
    if (!chatMap.has(chatKey)) chatMap.set(chatKey, []);
    chatMap.get(chatKey).push(msg);
  }

  for (const [chatKey, chatMsgs] of chatMap.entries()) {
    chatMsgs.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    const latest = chatMsgs[chatMsgs.length - 1];
    const isFromMe = latest.is_from_me || false;
    const needsReply = !isFromMe;
    const msgDate = latest.date || latest.timestamp || '';
    const senderName = latest.sender_name || latest.handle || chatKey;

    // Determine priority
    const text = String(latest.text || latest.body || '').toLowerCase();
    const isUrgentMsg =
      text.includes('urgent') || text.includes('asap') || text.includes('emergency') ||
      text.includes('help') || text.includes('call me') || text.includes('right away');
    const priority = isUrgentMsg ? 'high' : (needsReply ? 'medium' : 'low');

    // Check for scheduling language across the whole conversation
    const fullText = chatMsgs.map(m => String(m.text || m.body || '')).join(' ');
    const hasMeetingProposal = looksLikeMeetingText(fullText);

    let isActionable = needsReply || isUrgentMsg || hasMeetingProposal;
    if (isActionable) imessagesActionable++;

    // Build todo if needs reply
    let todoText = null;
    if (needsReply && !isFromMe) {
      todoText = `Reply to iMessage from ${senderName}`;
    }

    imessageSection.push({
      id: `imsg-${chatKey}`,
      sender: senderName,
      handle: latest.handle || chatKey,
      chat: chatKey,
      date: msgDate,
      summary: String(latest.text || latest.body || `${chatMsgs.length} messages`).slice(0, 160),
      priority,
      needsReply,
      todoText
    });

    // iMessage-derived todo
    if (todoText) {
      todos.push({
        id: `todo-imsg-${chatKey}`,
        priority,
        text: todoText,
        status: 'open',
        origin: 'imessage'
      });
    }

    // iMessage-derived calendar proposal
    if (hasMeetingProposal) {
      calendarProposals.push({
        id: `proposal-imsg-${chatKey}`,
        title: `Meet with ${senderName}`,
        start: null,
        end: null,
        location: '',
        detail: String(latest.text || latest.body || '').slice(0, 200),
        context: `Detected scheduling language in iMessage conversation`,
        sourceSender: senderName,
        sourceSubject: `iMessage from ${senderName}`,
        calendarId: 'primary'
      });
    }
  }
} else if (imessageStatus === 'stale') {
  imessageSection.push({
    id: 'imsg-stale-notice',
    sender: 'System',
    handle: '',
    chat: 'system',
    date: now.toISOString(),
    summary: `iMessage export is stale (exported ${imessageData?.exportedAt || 'unknown'}). Fresh data unavailable.`,
    priority: 'low',
    needsReply: false,
    todoText: null
  });
} else {
  imessageSection.push({
    id: 'imsg-missing-notice',
    sender: 'System',
    handle: '',
    chat: 'system',
    date: now.toISOString(),
    summary: 'iMessage export was unavailable for this run.',
    priority: 'low',
    needsReply: false,
    todoText: null
  });
}

console.log(`iMessages: scanned=${imessagesScanned}, actionable=${imessagesActionable}`);

// ── STEP 5C: Carry forward open action items ─────────────────────────────────
// An action item raised on a previous day must keep appearing until it is
// completed — otherwise it disappears silently once its source message ages out
// of the scan window. Prior open tasks are merged in ahead of today's, oldest
// first, so long-outstanding work stays visible.
const todoIds = new Set(todos.map(t => t.id).filter(Boolean));
const carried = [];
for (const prior of assistantState.openTasks || []) {
  if (!prior.id || todoIds.has(prior.id)) continue;
  todoIds.add(prior.id);
  carried.push({ ...prior, carriedForward: true });
}
carried.sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')));
todos.unshift(...carried);
console.log(`Action items: ${todos.length} total (${carried.length} carried forward from prior runs)`);

// ── STEP 6: Write briefing.json ───────────────────────────────────────────────
console.log('STEP 6: Writing briefing.json…');

const generatedAt = now.toISOString();
const lastSuccessfulBuildAt = assistantState.recentRuns?.find(r => r.success)?.completedAt ||
  assistantState.recentRuns?.slice(-1)[0]?.completedAt || generatedAt;

const briefing = {
  metadata: {
    generatedAt,
    date: todayISO,
    timezone: TZ,
    lastSuccessfulBuildAt,
    dataFreshThrough: generatedAt,
    liveUrl,
    todayLabel: formatDateLabel(now, TZ),
    tomorrowLabel: formatDateLabel(addDays(now, 1), TZ)
  },
  stats: {
    emailsScanned: deduped.length,
    urgent: urgent.length,
    eventsTomorrow: tomorrowEvents.length,
    eventsThisWeek: weekEvents.length,
    proposedEvents: calendarProposals.length,
    suggestedReplies: trimmedReplies.length,
    todos: todos.length,
    imessagesScanned,
    imessagesActionable
  },
  accounts: accounts.map(a => ({ email: a.email, label: a.label || a.email, type: a.type || 'Personal' })),
  calendars: allCalendars.length ? allCalendars : [{ id: 'primary', name: 'Primary Calendar', color: '#3A7556' }],
  sections: {
    urgent,
    tomorrowSchedule: tomorrowEvents,
    weekSchedule: weekEvents,
    calendarProposals,
    suggestedReplies: trimmedReplies,
    todos,
    business,
    personal,
    financial,
    waiting,
    newsletter,
    spam,
    imessage: imessageSection
  }
};

fs.writeFileSync(new URL('../briefing.json', import.meta.url), JSON.stringify(briefing, null, 2));
console.log('briefing.json written');
console.log(`Stats: urgent=${urgent.length} business=${business.length} personal=${personal.length} financial=${financial.length} waiting=${waiting.length} newsletter=${newsletter.length} spam=${spam.length}`);
console.log(`Actions: replies=${trimmedReplies.length} todos=${todos.length} calProposals=${calendarProposals.length}`);

// Export state payload for update step
const statePayload = {
  driveAccessToken: driveToken,
  driveFileId,
  conversations: activeConvos.map(c => ({
    conversationKey: c.conversationKey,
    status: c.status,
    accountsSeen: c.accountsSeen,
    latestRfcMessageId: c.latestMessage?.rfcMessageId || '',
    latestGmailThreadId: c.latestMessage?.gmailThreadId || '',
    latestSubject: c.latestMessage?.subject || '',
    latestDate: c.latestMessage?.date || '',
    sourceAccount: c.latestMessage?.sourceAccount || '',
    gmailThreadIdByAccount: Object.fromEntries(
      c.messages.map(m => [m.sourceAccount, m.gmailThreadId]).filter(([a, t]) => a && t)
    )
  })),
  briefing,
  assistantState,
  imessageStatus
};
fs.writeFileSync('/tmp/briefing-state-full.json', JSON.stringify(statePayload, null, 2));
console.log('State payload written to /tmp/briefing-state-full.json');

// run-state-update.mjs consumes this exact filename and shape (conversations + todos).
fs.writeFileSync('/tmp/briefing-state-update.json', JSON.stringify({
  conversations: statePayload.conversations,
  todos
}, null, 2));
console.log('State update payload written to /tmp/briefing-state-update.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseSender(from) {
  const match = String(from || '').match(/^"?([^"<]+?)"?\s*<([^>]+)>/) ||
                String(from || '').match(/^([^@\s]+@[^\s]+)$/);
  if (match && match[2]) return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
  if (match && match[1]) return { name: '', email: match[1].trim().toLowerCase() };
  return { name: '', email: from || '' };
}

function isUrgent(msg) {
  const subject = String(msg.subject || '').toLowerCase();
  return (
    subject.includes('urgent') || subject.includes('asap') || subject.includes('action required') ||
    subject.includes('time sensitive') || subject.includes('deadline') || subject.includes('overdue') ||
    subject.includes('past due') || subject.includes('final notice') || subject.includes('immediately')
  );
}

function isAutoReply(msg) {
  const subject = String(msg.subject || '').toLowerCase();
  return (
    subject.startsWith('re: out of office') || subject.includes('auto-reply') ||
    subject.includes('automatic reply') || subject.includes('out of office')
  );
}

function isBusinessEmail(msg, accounts) {
  const acct = accounts.find(a => a.email === msg.sourceAccount);
  if (acct?.type === 'business') return true;
  const acctEmail = String(msg.sourceAccount || '');
  if (acctEmail.includes('heartspring') || acctEmail.includes('biodynamics')) return true;
  const from = String(msg.from || '').toLowerCase();
  const domainMatch = from.match(/@([a-z0-9.-]+)(?:>|$)/);
  const domain = domainMatch ? domainMatch[1] : '';
  const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com'];
  if (domain && !personalDomains.some(d => domain.endsWith(d))) return true;
  return false;
}

function looksLikeMeeting(msg) {
  const subject = String(msg.subject || '').toLowerCase();
  const snippet = String(msg.snippet || '').toLowerCase();
  return (
    (subject.includes('meeting') || subject.includes('call') || subject.includes('schedule') ||
     subject.includes('appointment') || subject.includes('zoom') || subject.includes('conference')) &&
    (snippet.includes('availability') || snippet.includes('are you free') || snippet.includes('pick a time') ||
     snippet.includes('calendar') || snippet.includes('when') || snippet.includes('schedule'))
  );
}

function needsTodo(msg, status, prior) {
  if (status !== 'waiting_on_ben') return false;
  if (prior?.todoAdded) return false;
  const subject = String(msg.subject || '').toLowerCase();
  return (
    subject.includes('follow up') || subject.includes('action') || subject.includes('please') ||
    subject.includes('can you') || subject.includes('request') || subject.includes('reminder')
  );
}

function buildReplyBody(senderName, subject) {
  const greeting = senderName ? `Hi ${senderName.split(' ')[0]},` : 'Hi,';
  return `${greeting}\n\nThank you for your message regarding "${subject}".\n\n[Add your response here.]\n\nBest,\nBen`;
}

function looksLikeMeetingText(text) {
  const t = String(text || '').toLowerCase();
  const meetingWord = /\b(meet|meeting|call|zoom|facetime|lunch|dinner|coffee|hang out|come over|get together|visit|schedule|appointment|catch up)\b/.test(t);
  const timeRef = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|this week|weekend|\d{1,2}(:\d{2})?\s*(am|pm)|morning|afternoon|evening)\b/i.test(t);
  return meetingWord && timeRef;
}
