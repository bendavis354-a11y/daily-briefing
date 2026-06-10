/**
 * Daily Briefing Runner — 4:30 PM daily run
 * Loads Drive state, iMessage, Gmail, Calendar → writes briefing.json
 */

import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState } from './drive-state.mjs';
import { scanConfiguredMailboxes } from './gmail-api.mjs';
import { dedupeMessages, groupConversations } from './continuity.mjs';
import { listTomorrowEventsForAccount } from './calendar-api.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function localDate(date, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${o.year}-${o.month}-${o.day}`;
}

function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d;
}

function formatLabel(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).format(date);
}

function getTzOffset(date, tz) {
  // Compute UTC offset by comparing local vs UTC component representations
  const toObj = (parts) => Object.fromEntries(parts.map(p => [p.type, p.value]));
  const fmt = (tzName) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tzName, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const utc = toObj(fmt('UTC'));
  const local = toObj(fmt(tz));
  const utcMs = Date.UTC(+utc.year, +utc.month - 1, +utc.day, +utc.hour, +utc.minute, +utc.second);
  const locMs = Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour, +local.minute, +local.second);
  const diffMin = Math.round((locMs - utcMs) / 60000);
  const sign = diffMin >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(diffMin) / 60);
  const m = Math.abs(diffMin) % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseSender(from) {
  const m = String(from || '').match(/^"?([^"<]+?)"?\s*<([^>]+)>/) ||
            String(from || '').match(/^([^@\s]+@[^\s]+)$/);
  if (m?.[2]) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  if (m?.[1]) return { name: '', email: m[1].trim().toLowerCase() };
  return { name: '', email: String(from || '') };
}

function isUrgent(msg) {
  const s = String(msg.subject || '').toLowerCase();
  return s.includes('urgent') || s.includes('asap') || s.includes('action required') ||
         s.includes('time sensitive') || s.includes('deadline') || s.includes('overdue') ||
         s.includes('past due') || s.includes('final notice') || s.includes('immediate action');
}

function isAutoReply(msg) {
  const s = String(msg.subject || '').toLowerCase();
  return s.includes('auto-reply') || s.includes('automatic reply') || s.includes('out of office');
}

function isNewsletter(msg) {
  const labels = msg.labelIds || [];
  const s = String(msg.subject || '').toLowerCase();
  const f = String(msg.from || '').toLowerCase();
  return labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL') ||
         s.includes('newsletter') || s.includes('unsubscribe') || s.includes('digest') ||
         f.includes('no-reply') || f.includes('noreply') || f.includes('newsletter') ||
         f.includes('updates@') || f.includes('notifications@') || f.includes('do-not-reply') ||
         f.includes('donotreply');
}

function isFinancial(msg) {
  const s = String(msg.subject || '').toLowerCase();
  const f = String(msg.from || '').toLowerCase();
  return s.includes('invoice') || s.includes('payment') || s.includes('receipt') ||
         s.includes('billing') || s.includes('statement') || s.includes('bank') ||
         s.includes('payroll') || s.includes('tax') || s.includes('refund') ||
         s.includes('subscription') || s.includes('order') || s.includes('charge') ||
         s.includes('donation') || f.includes('stripe') || f.includes('quickbooks') || f.includes('paypal');
}

function isBusinessEmail(msg, accounts) {
  const acct = String(msg.sourceAccount || '');
  if (acct.includes('heartspring') || acct.includes('biodynamics')) return true;
  const accObj = accounts.find(a => a.email === acct);
  if (accObj?.type === 'business') return true;
  const f = String(msg.from || '').toLowerCase();
  const domainMatch = f.match(/@([^>\s]+)/);
  const domain = domainMatch ? domainMatch[1] : '';
  const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'aol.com'];
  if (domain && !personalDomains.some(d => domain.endsWith(d))) return true;
  return false;
}

function looksLikeMeeting(msg) {
  const s = String(msg.subject || '').toLowerCase();
  const sn = String(msg.snippet || '').toLowerCase();
  return s.includes('meeting') || s.includes('call') || s.includes('schedule') ||
         s.includes('appointment') || s.includes('zoom') || s.includes('conference') ||
         sn.includes('availability') || sn.includes('are you free') || sn.includes("let's schedule") ||
         sn.includes('can we meet');
}

function needsTodo(msg, status, prior) {
  if (status !== 'waiting_on_ben') return false;
  if (prior?.todoAdded) return false;
  const s = String(msg.subject || '').toLowerCase();
  return s.includes('follow up') || s.includes('action') || s.includes('please') ||
         s.includes('can you') || s.includes('request') || s.includes('reminder');
}

function makeGmailLinks(convo) {
  const seen = new Set();
  return (convo.messages || []).reduce((acc, m) => {
    if (m.gmailThreadId && m.sourceAccount && !seen.has(m.sourceAccount)) {
      seen.add(m.sourceAccount);
      acc.push({ sourceAccount: m.sourceAccount, gmailThreadId: m.gmailThreadId });
    }
    return acc;
  }, []);
}

// ─── STEP 1: Dates ────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const now = new Date();
const todayISO = localDate(now, TZ);
const tomorrowISO = localDate(addDays(now, 1), TZ);
const weekEndISO = localDate(addDays(now, 6), TZ);
const tzOffset = getTzOffset(now, TZ);

const tomorrowMin = `${tomorrowISO}T00:00:00${tzOffset}`;
const tomorrowMax = `${tomorrowISO}T23:59:59${tzOffset}`;
const weekMin = `${todayISO}T00:00:00${tzOffset}`;
const weekMax = `${weekEndISO}T23:59:59${tzOffset}`;

console.log(`today=${todayISO} tomorrow=${tomorrowISO} weekEnd=${weekEndISO} tzOffset=${tzOffset}`);

// ─── Credentials ─────────────────────────────────────────────────────────────
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;
const imessageFileId = process.env.DRIVE_IMESSAGE_FILE_ID;
const liveUrl = process.env.GITHUB_PAGES_URL || '';

if (!clientId || !clientSecret) throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');
if (!accounts.length) throw new Error('GMAIL_ACCOUNTS_JSON is empty');

// ─── STEP 2: Drive state ──────────────────────────────────────────────────────
console.log('Loading Drive state…');
const driveAccount = accounts[0];
const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });

let assistantState;
try {
  assistantState = await readState({ accessToken: driveToken, fileId: driveFileId });
  console.log(`Drive state: v${assistantState.version} updated=${assistantState.updatedAt}`);
} catch (err) {
  console.error('FATAL: Drive state load failed:', err.message);
  process.exit(1);
}

const priorConvos = assistantState.conversations || {};
const ignoredKeys = new Set(Object.keys(assistantState.ignoredConversations || {}));
const snoozedKeys = new Set(
  Object.entries(assistantState.snoozedConversations || {})
    .filter(([, v]) => v.until && v.until > todayISO)
    .map(([k]) => k)
);

// ─── STEP 2B: iMessage export ─────────────────────────────────────────────────
let imessageData = null;
let imessageStatus = 'missing';
let imessageNote = null;

if (imessageFileId) {
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${imessageFileId}?alt=media`, {
      headers: { authorization: `Bearer ${driveToken}` }
    });
    if (res.ok) {
      const raw = await res.json();
      const exportedAt = raw.exportedAt ? new Date(raw.exportedAt) : null;
      const ageHours = exportedAt ? (now.getTime() - exportedAt.getTime()) / 3600000 : Infinity;
      if (ageHours > 6) {
        imessageStatus = 'stale';
        imessageNote = `iMessage export is stale (${ageHours.toFixed(1)}h old) — iMessage data skipped.`;
        console.log(`iMessage: ${imessageStatus} (${ageHours.toFixed(1)}h old)`);
      } else {
        imessageData = raw;
        imessageStatus = 'fresh';
        console.log(`iMessage: ${(raw.messages || []).length} messages, ${ageHours.toFixed(1)}h old`);
      }
    } else {
      imessageStatus = 'missing';
      imessageNote = `iMessage export unavailable (${res.status}).`;
      console.log(`iMessage: not found (${res.status})`);
    }
  } catch (err) {
    imessageStatus = 'missing';
    imessageNote = `iMessage export error: ${err.message}`;
    console.log(`iMessage: error loading`);
  }
}

// ─── STEP 3: Gmail ────────────────────────────────────────────────────────────
console.log('Scanning Gmail…');
const benEmails = accounts.map(a => a.email.toLowerCase());
let mailboxResults;
try {
  mailboxResults = await scanConfiguredMailboxes();
} catch (err) {
  console.error('FATAL: Gmail scan failed:', err.message);
  process.exit(1);
}

const allMessages = mailboxResults.flatMap(r => r.messages);
console.log(`Raw messages: ${allMessages.length}`);
const deduped = dedupeMessages(allMessages);
console.log(`After dedupe: ${deduped.length}`);
const conversations = groupConversations(deduped, benEmails);
console.log(`Conversations: ${conversations.length}`);

const activeConvos = conversations.filter(c =>
  !ignoredKeys.has(c.conversationKey) && !snoozedKeys.has(c.conversationKey)
);
console.log(`Active (non-ignored/snoozed): ${activeConvos.length}`);

// ─── STEP 4: Calendar ─────────────────────────────────────────────────────────
console.log('Scanning calendar…');
const allCalendars = [];
const seenCalIds = new Set();
const tomorrowEventMap = new Map();
const weekEventMap = new Map();

for (const account of accounts) {
  try {
    const r = await listTomorrowEventsForAccount({
      account, clientId, clientSecret,
      timeMinISO: tomorrowMin, timeMaxISO: tomorrowMax
    });
    for (const cal of r.calendars) {
      if (!seenCalIds.has(cal.id)) {
        seenCalIds.add(cal.id);
        allCalendars.push({ id: cal.id, name: cal.summary || cal.id, color: cal.backgroundColor || '#3A7556' });
      }
    }
    for (const ev of r.events) {
      const key = `${ev.title}|${ev.start}`;
      if (!tomorrowEventMap.has(key)) tomorrowEventMap.set(key, ev);
    }
  } catch (err) {
    console.error(`Calendar error (tomorrow, ${account.email}): ${err.message}`);
  }

  try {
    const r = await listTomorrowEventsForAccount({
      account, clientId, clientSecret,
      timeMinISO: weekMin, timeMaxISO: weekMax
    });
    for (const ev of r.events) {
      const key = `${ev.title}|${ev.start}`;
      if (!weekEventMap.has(key)) weekEventMap.set(key, ev);
    }
  } catch (err) {
    console.error(`Calendar error (week, ${account.email}): ${err.message}`);
  }
}

const tomorrowEvents = [...tomorrowEventMap.values()].sort((a, b) =>
  String(a.start || '').localeCompare(String(b.start || ''))
);
const weekEvents = [...weekEventMap.values()].sort((a, b) =>
  String(a.start || '').localeCompare(String(b.start || ''))
);

console.log(`Calendar: ${tomorrowEvents.length} tomorrow, ${weekEvents.length} this week`);

// ─── STEP 5: Classify emails ──────────────────────────────────────────────────
const urgent = [], business = [], personal = [], financial = [];
const newsletter = [], waiting = [], spam = [];
const calendarProposals = [], suggestedReplies = [], todos = [];
let emailsClassified = 0;

for (const convo of activeConvos) {
  const latest = convo.latestMessage;
  if (!latest) continue;

  const labels = latest.labelIds || [];
  const sender = parseSender(latest.from || '');
  const prior = priorConvos[convo.conversationKey];
  const hasNewActivity = !prior || latest.rfcMessageId !== prior.latestRfcMessageId;

  if (prior?.status === 'done' && !hasNewActivity) continue;

  emailsClassified++;

  const item = {
    id: `email-${(convo.conversationKey || '').slice(0, 20) || Date.now()}`,
    conversationKey: convo.conversationKey,
    sourceAccount: latest.sourceAccount,
    account: latest.sourceAccount,
    gmailThreadId: latest.gmailThreadId,
    gmailMessageId: latest.gmailMessageId,
    sender: latest.from || '',
    senderName: sender.name,
    senderEmail: sender.email,
    subject: latest.subject || '(no subject)',
    snippet: String(latest.snippet || '').slice(0, 200),
    summary: prior?.summary || String(latest.snippet || '').slice(0, 200),
    date: latest.date || '',
    status: convo.status,
    gmailLinks: makeGmailLinks(convo)
  };

  if (labels.includes('SPAM') || labels.includes('TRASH')) { spam.push(item); continue; }
  if (isNewsletter(latest)) { newsletter.push(item); continue; }

  if (isUrgent(latest)) {
    urgent.push(item);
    if (convo.status === 'waiting_on_ben' && hasNewActivity && !isAutoReply(latest)) {
      suggestedReplies.push({
        id: `reply-${(convo.conversationKey || '').slice(0, 20)}`,
        conversationKey: convo.conversationKey,
        account: item.account, sourceAccount: item.sourceAccount,
        sender: latest.from || '', senderEmail: sender.email, to: sender.email,
        subject: latest.subject || '', title: `Reply to: ${latest.subject}`,
        detail: `Urgent message from ${sender.name || sender.email}`,
        body: '', gmailThreadId: latest.gmailThreadId, gmailLinks: item.gmailLinks,
        _isNew: hasNewActivity
      });
    }
    continue;
  }

  if (isFinancial(latest)) {
    financial.push(item);
    if (convo.status === 'waiting_on_ben') {
      todos.push({
        id: `todo-fin-${(convo.conversationKey || '').slice(0, 12)}`,
        conversationKey: convo.conversationKey,
        account: item.account, sourceAccount: item.sourceAccount,
        priority: 'medium', text: `Review: ${latest.subject}`, status: 'open', origin: 'email'
      });
    }
    continue;
  }

  if (convo.status === 'waiting_on_other' || convo.status === 'fyi') { waiting.push(item); continue; }
  if (labels.includes('CATEGORY_UPDATES') && convo.status !== 'waiting_on_ben') { waiting.push(item); continue; }

  if (isBusinessEmail(latest, accounts)) {
    business.push(item);
  } else {
    personal.push(item);
  }

  if (convo.status === 'waiting_on_ben' && !latest.fromMe && !isAutoReply(latest)) {
    suggestedReplies.push({
      id: `reply-${(convo.conversationKey || '').slice(0, 20)}`,
      conversationKey: convo.conversationKey,
      account: item.account, sourceAccount: item.sourceAccount,
      sender: latest.from || '', senderEmail: sender.email, to: sender.email,
      subject: latest.subject || '', title: `Reply to: ${latest.subject}`,
      detail: hasNewActivity
        ? `New message from ${sender.name || sender.email}`
        : `Awaiting reply — from ${sender.name || sender.email}`,
      body: '', gmailThreadId: latest.gmailThreadId, gmailLinks: item.gmailLinks,
      _isNew: hasNewActivity
    });
  }

  if (looksLikeMeeting(latest) && !prior?.calendarProposalSeen) {
    calendarProposals.push({
      id: `proposal-${(convo.conversationKey || '').slice(0, 12)}`,
      conversationKey: convo.conversationKey,
      account: item.account, sourceAccount: item.sourceAccount,
      title: (latest.subject || 'Meeting').replace(/^(re:|fwd?:)\s*/i, '').trim(),
      start: `${tomorrowISO}T09:00:00`, end: `${tomorrowISO}T10:00:00`,
      location: '', detail: String(latest.snippet || '').slice(0, 120),
      context: `From: ${sender.name || sender.email}`,
      sourceSender: latest.from || '', sourceSubject: latest.subject || '',
      calendarId: 'primary'
    });
  }

  if (needsTodo(latest, convo.status, prior)) {
    todos.push({
      id: `todo-${(convo.conversationKey || '').slice(0, 12)}`,
      conversationKey: convo.conversationKey,
      account: item.account, sourceAccount: item.sourceAccount,
      priority: 'medium', text: `Follow up: ${latest.subject}`, status: 'open', origin: 'email'
    });
  }
}

suggestedReplies.sort((a, b) => (b._isNew ? 1 : 0) - (a._isNew ? 1 : 0));
const trimmedReplies = suggestedReplies.slice(0, 8).map(r => { delete r._isNew; return r; });

console.log(`Classified: urgent=${urgent.length} biz=${business.length} personal=${personal.length} fin=${financial.length} waiting=${waiting.length} news=${newsletter.length} spam=${spam.length}`);
console.log(`Actions: replies=${trimmedReplies.length} todos=${todos.length} proposals=${calendarProposals.length}`);

// ─── Process iMessages ────────────────────────────────────────────────────────
const imessageItems = [];
let imessagesActionable = 0;

if (imessageData?.messages?.length) {
  const msgs = imessageData.messages;
  // Group by chat identifier
  const chats = new Map();
  for (const msg of msgs) {
    const key = msg.chat_identifier || msg.chat || msg.handle_id || msg.handle || 'unknown';
    if (!chats.has(key)) chats.set(key, []);
    chats.get(key).push(msg);
  }

  for (const [chatKey, chatMsgs] of chats.entries()) {
    chatMsgs.sort((a, b) => {
      const da = a.date || a.dateRead || '';
      const db = b.date || b.dateRead || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
    const latest = chatMsgs[chatMsgs.length - 1];
    const isFromMe = !!(latest.is_from_me || latest.fromMe);
    const needsReply = !isFromMe;

    const allText = chatMsgs.map(m => (m.text || m.body || '')).join(' ').toLowerCase();
    const hasAction = allText.includes('can you') || allText.includes('please') ||
                      allText.includes("don't forget") || allText.includes('need to') ||
                      allText.includes('remind') || allText.includes('follow up');

    if (needsReply || hasAction) imessagesActionable++;

    const dateVal = latest.date || latest.dateRead || '';
    const chatLabel = chatKey.startsWith('+') ? 'phone' : (chatKey.includes('@') ? 'contact' : 'chat');

    imessageItems.push({
      id: `imessage-${chatKey.replace(/[^a-z0-9]/gi, '').slice(0, 12)}-${chatMsgs.length}`,
      chat: chatLabel,
      date: dateVal,
      summary: `${needsReply ? 'Needs reply' : (hasAction ? 'Action mentioned' : 'FYI')} — ${chatMsgs.length} message${chatMsgs.length !== 1 ? 's' : ''}`,
      priority: needsReply ? 'high' : (hasAction ? 'medium' : 'low'),
      needsReply,
      todoText: hasAction ? `Check iMessage action item` : undefined
    });
  }
}

if (imessageNote) {
  todos.push({
    id: 'todo-imessage-fyi',
    account: accounts[0]?.email || '',
    priority: 'low',
    text: `FYI: ${imessageNote}`,
    status: 'info',
    origin: 'manual'
  });
}

// ─── STEP 6: Write briefing.json ──────────────────────────────────────────────
const generatedAt = now.toISOString();
const lastSuccessfulBuildAt = (assistantState.recentRuns || []).find(r => r.success)?.completedAt || generatedAt;

const briefing = {
  metadata: {
    generatedAt,
    date: todayISO,
    timezone: TZ,
    lastSuccessfulBuildAt,
    dataFreshThrough: generatedAt,
    liveUrl,
    todayLabel: formatLabel(now, TZ),
    tomorrowLabel: formatLabel(addDays(now, 1), TZ)
  },
  stats: {
    emailsScanned: deduped.length,
    urgent: urgent.length,
    eventsTomorrow: tomorrowEvents.length,
    eventsThisWeek: weekEvents.length,
    proposedEvents: calendarProposals.length,
    suggestedReplies: trimmedReplies.length,
    todos: todos.length,
    imessagesScanned: imessageData?.messages?.length || 0,
    imessagesActionable
  },
  accounts: accounts.map(a => ({ email: a.email, label: a.label || a.email, type: a.type || 'Personal' })),
  calendars: allCalendars.length
    ? allCalendars
    : [{ id: 'primary', name: 'Primary Calendar', color: '#3A7556' }],
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
    imessage: imessageItems
  }
};

fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));
console.log('Wrote briefing.json');

// Export state payload for run-state-update.mjs
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
console.log('State payload cached for run-state-update.mjs');
