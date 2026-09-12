/**
 * Full daily briefing gather — Steps 1–6 + iMessage + weekSchedule
 * Writes briefing.json and /tmp/briefing-state.json for the state update step.
 */

import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { emptyState } from './drive-state.mjs';
import { loadDurableState } from './state-store.mjs';
import { scanConfiguredMailboxes, loadConnectorMessages } from './gmail-api.mjs';
import { dedupeMessages, groupConversations, reconcileThreadStatus } from './continuity.mjs';
import { isConnectorAccount, loadAccounts } from './accounts.mjs';
import { loadImessageExport, tokenExpiryWarning, REPAIR_COMMAND } from './imessage-store.mjs';
import { findMeetingProposal, isMeetingProposalText, isFresh } from './meeting-detect.mjs';
import { triageChat, cleanText } from './imessage-triage.mjs';
import { carryForwardTasks, applyReplyCompletions, retainTasks, dedupeTasks, dropSettledTasks, extractReplyObservations } from './tasks.mjs';
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
const NY_OFFSET = nyOffset(now);

// The brief is written at 5pm for an evening read, so section 5 covers
// TOMORROW — by the time he opens it, today's commitments are behind him. It
// covered today while the run was at 7am. The briefing JSON keys stay
// `tomorrowSchedule` / `eventsTomorrow` / `tomorrowLabel` throughout, because
// the schema and five other consumers read those names; only the day they
// describe has moved. BRIEFING_SCHEDULE_DAY=today restores the morning
// behaviour without a code change.
const scheduleISO = process.env.BRIEFING_SCHEDULE_DAY === 'today' ? todayISO : tomorrowISO;
const scheduleMin = `${scheduleISO}T00:00:00${NY_OFFSET}`;
const scheduleMax = `${scheduleISO}T23:59:59${NY_OFFSET}`;
const weekMin = `${todayISO}T00:00:00${NY_OFFSET}`;  // the week always starts today
const weekMax = `${localDate(addDays(now, 6), TZ)}T23:59:59${NY_OFFSET}`;

console.log(`STEP 1: today=${todayISO}  schedule day=${scheduleISO}  offset=${NY_OFFSET}  week window=${weekMin} to ${weekMax}`);

// ── Credentials ───────────────────────────────────────────────────────────────
const accounts = loadAccounts();
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const liveUrl = process.env.GITHUB_PAGES_URL || '';

if (!clientId || !clientSecret) throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');
if (!accounts.length) throw new Error('GMAIL_ACCOUNTS_JSON is empty');

// ── STEP 2: Load durable state ────────────────────────────────────────────────
// Memory lives encrypted in the repo (state.enc on claude/briefing) — no Google
// token or connector involved. See state-store.mjs for the precedence order.
console.log('STEP 2: Loading state…');
let assistantState;
try {
  assistantState = loadDurableState();
} catch (err) {
  console.error('ERROR loading state:', err.message);
  process.exit(1);
}
// Plaintext copy for the agent's analysis step (storylines, patterns, tasks).
fs.writeFileSync('/tmp/current-state.json', JSON.stringify(assistantState, null, 2));

// No Drive token is minted any more: memory lives in state.enc and the iMessage
// export in imessages.enc, both on the deploy branch. Nothing else read Drive.

const priorConvos = assistantState.conversations || {};
const ignoredKeys = new Set(Object.keys(assistantState.ignoredConversations || {}));
const snoozedKeys = new Set(
  Object.entries(assistantState.snoozedConversations || {})
    .filter(([, v]) => v.until && v.until > todayISO)
    .map(([k]) => k)
);

// ── STEP 2B: Load iMessage export ─────────────────────────────────────────────
// Read from the repo (imessages.enc on the deploy branch), not Drive. See
// imessage-store.mjs for why the Drive path could never have worked.
console.log('STEP 2B: Loading iMessage export…');
const imessageResult = loadImessageExport({ now });
const imessageData = imessageResult.data;
const imessageStatus = imessageResult.status;
const imessageAgeHours = imessageResult.ageHours;

if (imessageStatus === 'fresh') {
  console.log(`iMessage export loaded from ${imessageResult.source}: ${imessageData.messages?.length || 0} messages, exported ${imessageData.exportedAt}`);
} else if (imessageStatus === 'stale') {
  const age = imessageAgeHours != null ? `${imessageAgeHours.toFixed(1)}h old` : 'undated';
  console.log(`iMessage export is stale (${age}, exported at ${imessageData?.exportedAt || 'unknown'})`);
} else if (imessageStatus === 'error') {
  console.error(`iMessage export failed to decrypt: ${imessageResult.error}`);
} else {
  console.log(`iMessage export unavailable (${imessageResult.error || 'not found'}) — continuing without iMessages`);
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

const conversations = reconcileThreadStatus(groupConversations(deduped, benEmails));
console.log(`Conversations: ${conversations.length}`);
const continued = conversations.filter(c => c.status === 'thread_continued').length;
console.log(`Already answered by Ben (thread continued without him): ${continued}`);

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
const scheduleEvents = [];
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
        const evts = await listEvents({ accessToken, calendarId: cal.id, timeMinISO: scheduleMin, timeMaxISO: scheduleMax });
        for (const ev of evts) {
          const key = `${ev.summary}|${ev.start?.dateTime || ev.start?.date}`;
          if (!scheduleEvents.find(e => `${e.title}|${e.start}` === key)) {
            scheduleEvents.push(buildEvent(ev, cal));
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

scheduleEvents.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
weekEvents.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
console.log(`Calendar: ${scheduleEvents.length} events on ${scheduleISO}, ${weekEvents.length} this week`);

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
        text: `Review: ${latest.subject} — from ${sender.name || sender.email}`,
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

  // Calendar proposals — the same test texts get: the latest message must
  // itself invite and name a time, come from a real correspondent, and the
  // thread must still be waiting on Ben. The subject may supply the day
  // ("Lunch Thursday?") but never the invitation: an old thread's subject
  // keeps naming a meeting long after it happened.
  // Both statuses mean the latest message is theirs and unanswered: either he
  // never replied in the thread, or he did and they have written since.
  const realSender = sender.email && !sender.email.includes('no-reply') && !sender.email.includes('noreply');
  const awaitingBen = convo.status === 'waiting_on_ben' || convo.status === 'thread_continued';
  const latestAt = Number(latest.internalDate) || Date.parse(latest.date || '') || 0;
  // Gmail snippets arrive HTML-encoded ("I&#39;m"); decode before matching so
  // "let's" is seen as written, and before quoting so the page shows prose.
  const snippetText = decodeEntities(snippet);
  if (awaitingBen && !latest.fromMe && realSender && !isAutoReply(latest) && isFresh(latestAt, now) &&
      isMeetingProposalText(snippetText, latest.subject)) {
    const askText = snippetText.replace(/\s+/g, ' ').trim();
    calendarProposals.push({
      id: `proposal-${convo.conversationKey}`,
      conversationKey: convo.conversationKey,
      account: item.account,
      sourceAccount: item.sourceAccount,
      title: (latest.subject || 'Meeting').replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim(),
      start: null,
      end: null,
      location: '',
      detail: askText.slice(0, 200),
      context: `${sender.name || sender.email} wrote: “${askText.slice(0, 140)}${askText.length > 140 ? '…' : ''}”`,
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
// Chat-shaped records handed to the reply detector alongside email
// conversations; populated only from a FRESH export, never a stale one.
const imessageConversations = [];
// Chats the export shows and this run judged as needing no reply: a text item
// carried forward for one of these was raised in error and is dropped below.
const settledTextChats = new Set();
let imessagesScanned = 0;
let imessagesActionable = 0;

// Only a fresh export is processed. A stale one used to fall into this branch
// too (the stale else-if below was unreachable), so a dead Mac exporter kept
// resurfacing weeks-old chats as new todos and meeting proposals every day.
if (imessageData && imessageStatus === 'fresh') {
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
    // Reactions and the driving auto-reply are skipped, acknowledgements close
    // an exchange, and group chats need his name; see imessage-triage.mjs.
    const triage = triageChat(chatKey, chatMsgs);
    const latest = triage.latest || chatMsgs[chatMsgs.length - 1];
    const isFromMe = !!latest.is_from_me;
    const needsReply = triage.needsReply;
    if (!needsReply) settledTextChats.add(`imsg:${chatKey}`);
    const msgDate = latest.date || latest.timestamp || '';
    const counterpart = chatMsgs.find(m => !m.is_from_me);
    const senderName = counterpart?.sender_name || latest.sender_name || latest.handle || chatKey;

    // Determine priority
    const text = String(latest.text || latest.body || '').toLowerCase();
    const isUrgentMsg =
      text.includes('urgent') || text.includes('asap') || text.includes('emergency') ||
      text.includes('help') || text.includes('call me') || text.includes('right away');
    const priority = isUrgentMsg ? 'high' : (needsReply ? 'medium' : 'low');

    // An invitation naming a time, from the other party, that Ben has not yet
    // answered. Ben's own messages never count, and an answered ask is his to
    // drive; see meeting-detect.mjs.
    const meetingAsk = findMeetingProposal(chatMsgs, { now });
    const hasMeetingProposal = Boolean(meetingAsk);

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
      summary: (triage.excerpt || cleanText(latest) || `${chatMsgs.length} messages`).slice(0, 160),
      priority,
      needsReply,
      todoText
    });

    // A pseudo-conversation per chat, shaped like an email conversation, so the
    // reply detector in STEP 5C can close text items the same way it closes
    // email ones. The export carries Ben's own outgoing messages, so "he
    // answered" is observable here — it just needs to be expressed in the shape
    // applyReplyCompletions already understands.
    imessageConversations.push({
      conversationKey: `imsg:${chatKey}`,
      latestMessage: {
        fromMe: isFromMe,
        internalDate: Date.parse(msgDate) || null
      }
    });

    // iMessage-derived todo. The conversationKey is what lets it auto-complete;
    // the context excerpt is what keeps it meaningful once the message itself
    // drops out of the export's rolling window (48h by default) while the item
    // lives on for up to 45 days.
    if (todoText) {
      const excerpt = triage.excerpt;
      todos.push({
        id: `todo-imsg-${chatKey}`,
        conversationKey: `imsg:${chatKey}`,
        priority,
        text: todoText,
        context: excerpt ? excerpt.slice(0, 140) : '(no text — attachment or image)',
        status: 'open',
        origin: 'imessage'
      });
    }

    // iMessage-derived calendar proposal, carrying the ask itself so the page
    // shows what was actually said rather than a generic label.
    if (meetingAsk) {
      const askText = String(meetingAsk.text || meetingAsk.body || '').replace(/\s+/g, ' ').trim();
      calendarProposals.push({
        id: `proposal-imsg-${chatKey}`,
        title: `Meet with ${senderName}`,
        start: null,
        end: null,
        location: '',
        detail: askText.slice(0, 200),
        context: `${senderName} texted: “${askText.slice(0, 140)}${askText.length > 140 ? '…' : ''}”`,
        sourceSender: senderName,
        sourceSubject: `iMessage from ${senderName}`,
        calendarId: 'primary'
      });
    }
  }
} else if (imessageStatus === 'stale') {
  const ageDays = imessageAgeHours != null ? (imessageAgeHours / 24).toFixed(1) : '?';
  imessageSection.push({
    id: 'imsg-stale-notice',
    sender: 'System',
    handle: '',
    chat: 'system',
    date: now.toISOString(),
    summary: `iMessage export is stale — last upload ${imessageData?.exportedAt || 'unknown'} (${ageDays} days ago). ` +
      `The Mac exporter has stopped. On the Mac, run: ${REPAIR_COMMAND}`,
    priority: imessageAgeHours != null && imessageAgeHours > 48 ? 'high' : 'low',
    needsReply: false,
    todoText: null
  });
} else if (imessageStatus === 'error') {
  imessageSection.push({
    id: 'imsg-error-notice',
    sender: 'System',
    handle: '',
    chat: 'system',
    date: now.toISOString(),
    summary: `iMessage export could not be decrypted (${imessageResult.error}). ` +
      `The Mac exporter is running, but its encryption_key does not match this ` +
      `environment's key (STATE_ENCRYPTION_KEY, or BRIEFING_PASSWORD when unset). ` +
      `On the Mac, run: ${REPAIR_COMMAND}`,
    priority: 'high',
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
    summary: `No iMessage export found on the deploy branch (${imessageResult.error || 'not found'}). ` +
      `Either the Mac exporter has never run or it cannot push. On the Mac, run: ${REPAIR_COMMAND}`,
    priority: 'low',
    needsReply: false,
    todoText: null
  });
}

// Token expiry is the likeliest scheduled failure in the whole chain, and the
// only one that can be caught BEFORE it bites. Warned on any export that
// carries the date, stale ones included, and raised as an action item so it
// lands on the checklist rather than only in the texts section.
const tokenWarning = tokenExpiryWarning(imessageData, now);
if (tokenWarning) {
  const { daysLeft } = tokenWarning;
  const overdue = daysLeft <= 0;
  imessageSection.unshift({
    id: 'imsg-token-expiry',
    sender: 'System',
    handle: '',
    chat: 'system',
    date: now.toISOString(),
    summary: overdue
      ? `The Mac exporter's GitHub token has EXPIRED. Texts have stopped. On the Mac, run: ${REPAIR_COMMAND}`
      : `The Mac exporter's GitHub token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. ` +
        `Mint a replacement with Contents: Read and write, then set it as github_token ` +
        `in ~/.config/ben-briefing/imessage-export.json.`,
    priority: daysLeft <= 7 ? 'high' : 'medium',
    needsReply: false,
    todoText: null
  });
  todos.push({
    id: 'todo-imsg-token-expiry',
    priority: daysLeft <= 7 ? 'high' : 'medium',
    text: overdue
      ? 'Renew the expired GitHub token for the Mac iMessage exporter'
      : `Renew the Mac iMessage exporter's GitHub token (${daysLeft} days left)`,
    context: 'Without it the Mac stops publishing texts and the briefing loses them silently.',
    status: 'open',
    origin: 'imessage'
  });
  console.log(`Token expiry warning: ${daysLeft} days left`);
}

console.log(`iMessages: scanned=${imessagesScanned}, actionable=${imessagesActionable}`);

// ── STEP 5C: Action item lifecycle ───────────────────────────────────────────
// Carry prior tasks forward (open items keep appearing until completed, even
// after their source message ages out of the scan window), then auto-complete
// any task whose conversation shows Ben replied after it was raised — the
// sent-mail scan is the evidence. Auto-completed items linger one day on the
// page under "Recently completed". Detection uses the full conversation list
// (pre-ignore/snooze) so a reply on a snoozed thread still completes its task.
const merged = dropSettledTasks(carryForwardTasks(todos, assistantState.openTasks || []), settledTextChats);
// Email conversations plus the text chats, so a reply by either medium closes
// its item. extractReplyObservations below deliberately sees only the email
// list: the habit profile is built from addressed correspondence.
applyReplyCompletions(merged, [...conversations, ...imessageConversations], now);
todos.length = 0;
todos.push(...dedupeTasks(retainTasks(merged, now)));
const completedNow = todos.filter(t => t.status === 'completed').length;
console.log(`Action items: ${todos.length} total, ${completedNow} auto-completed by replies`);

// Observed Ben-replies (correspondent + latency) for the habit profile.
const replyObservations = extractReplyObservations(conversations);
console.log(`Reply observations: ${replyObservations.length}`);

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
    tomorrowLabel: formatDateLabel(scheduleISO === todayISO ? now : addDays(now, 1), TZ)
  },
  stats: {
    emailsScanned: deduped.length,
    urgent: urgent.length,
    eventsTomorrow: scheduleEvents.length,
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
    tomorrowSchedule: scheduleEvents,
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
  imessageStatus,
  replyObservations
};
fs.writeFileSync('/tmp/briefing-state-full.json', JSON.stringify(statePayload, null, 2));
console.log('State payload written to /tmp/briefing-state-full.json');

// run-state-update.mjs consumes this exact filename and shape (conversations + todos).
fs.writeFileSync('/tmp/briefing-state-update.json', JSON.stringify({
  conversations: statePayload.conversations,
  todos,
  replyObservations
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

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
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

