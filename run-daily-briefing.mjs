/**
 * Daily briefing runner — 4:30 PM America/New_York
 * Steps: dates → memory → iMessage → Gmail → calendar → classify → write → build → state → deploy → summary
 */

import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { getAccessToken } from './src/google-auth.mjs';
import { readState, writeState, emptyState } from './src/drive-state.mjs';
import { scanConfiguredMailboxes } from './src/gmail-api.mjs';
import { dedupeMessages, groupConversations } from './src/continuity.mjs';
import { listTomorrowEventsForAccount, listCalendars } from './src/calendar-api.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function nowET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function etDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

function labelDate(d) {
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
}

function isoRange(dateStr, tz = 'America/New_York') {
  const start = new Date(`${dateStr}T00:00:00`);
  const end   = new Date(`${dateStr}T23:59:59`);
  // convert to UTC ISO
  const toUTC = (local) => {
    const utc = new Date(local.toLocaleString('en-US', { timeZone: tz }));
    const diff = local - utc;
    return new Date(local.getTime() + diff);
  };
  return {
    timeMin: new Date(`${dateStr}T00:00:00`).toISOString(),
    timeMax: new Date(`${dateStr}T23:59:59`).toISOString()
  };
}

function safeId(prefix, idx) {
  return `${prefix}-${idx}`;
}

function parseSenderName(fromHeader) {
  const m = String(fromHeader || '').match(/^([^<]+)</);
  return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : fromHeader || '';
}

function parseSenderEmail(fromHeader) {
  const m = String(fromHeader || '').match(/<([^>]+)>/);
  return m ? m[1].trim().toLowerCase() : String(fromHeader || '').trim().toLowerCase();
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// ─── STEP 1: dates ───────────────────────────────────────────────────────────

const now      = new Date();
const nowIso   = now.toISOString();

const todayET  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const todayStr = etDateStr(todayET);

const tomorrowET  = addDays(todayET, 1);
const tomorrowStr = etDateStr(tomorrowET);

const weekEndET  = addDays(todayET, 6);
const weekEndStr = etDateStr(weekEndET);

console.log(`[briefing] date=${todayStr} tomorrow=${tomorrowStr} weekEnd=${weekEndStr}`);

// ─── STEP 2: load assistant memory ──────────────────────────────────────────

const accounts      = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId      = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret  = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId   = process.env.DRIVE_STATE_FILE_ID;
const imessageFileId = process.env.DRIVE_IMESSAGE_FILE_ID;
const pagesUrl      = process.env.GITHUB_PAGES_URL || '';

if (!accounts.length) throw new Error('GMAIL_ACCOUNTS_JSON is empty or unset.');

const primaryAccount = accounts[0];
const primaryRefreshToken = process.env[primaryAccount.refreshTokenEnv];

console.log(`[briefing] getting Drive access token for ${primaryAccount.email}`);
const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: primaryRefreshToken });

console.log('[briefing] reading assistant memory from Drive');
let assistantState;
try {
  assistantState = await readState({ accessToken: driveToken, fileId: driveFileId });
  if (!assistantState || !assistantState.version) assistantState = emptyState();
  console.log(`[briefing] state loaded (version=${assistantState.version}, conversations=${Object.keys(assistantState.conversations || {}).length})`);
} catch (err) {
  console.error('[briefing] ERROR reading Drive state:', err.message);
  throw err;
}

const ignoredConvos  = assistantState.ignoredConversations || {};
const snoozedConvos  = assistantState.snoozedConversations || {};
const priorConvos    = assistantState.conversations || {};

// ─── STEP 2B: load iMessage export ──────────────────────────────────────────

let imessageData = null;
let imessageStatus = 'missing';
let imessagesScanned = 0;
let imessagesActionable = 0;

if (imessageFileId) {
  try {
    const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
    const res = await fetch(`${DRIVE_BASE}/files/${imessageFileId}?alt=media`, {
      headers: { authorization: `Bearer ${driveToken}` }
    });
    if (!res.ok) throw new Error(`Drive iMessage read failed: ${res.status}`);
    imessageData = await res.json();

    const exportedAt = new Date(imessageData.exportedAt || 0);
    const ageHours   = (now - exportedAt) / 36e5;
    imessageStatus   = ageHours > 6 ? 'stale' : 'fresh';
    console.log(`[briefing] iMessage export loaded, age=${ageHours.toFixed(1)}h, status=${imessageStatus}`);
  } catch (err) {
    console.log(`[briefing] iMessage export unavailable: ${err.message}`);
    imessageStatus = 'missing';
  }
}

// ─── STEP 3: scan Gmail ──────────────────────────────────────────────────────

console.log('[briefing] scanning Gmail mailboxes...');
const mailboxResults = await scanConfiguredMailboxes();

const benEmails = accounts.map(a => a.email.toLowerCase());

// Flatten all messages
const allMessages = mailboxResults.flatMap(r => r.messages || []);
console.log(`[briefing] raw messages fetched: ${allMessages.length}`);

const deduped = dedupeMessages(allMessages);
console.log(`[briefing] after dedupe: ${deduped.length}`);

const conversations = groupConversations(deduped, benEmails);
console.log(`[briefing] conversations grouped: ${conversations.length}`);

// Build a helper: for a conversation, find the best gmail link
function buildGmailLinks(convo) {
  const linksByAccount = new Map();
  for (const msg of convo.messages) {
    if (!linksByAccount.has(msg.sourceAccount)) {
      linksByAccount.set(msg.sourceAccount, msg.gmailThreadId);
    }
  }
  return [...linksByAccount.entries()].map(([acct, tid]) => ({ sourceAccount: acct, gmailThreadId: tid }));
}

function getViewThread(convo) {
  const mainAccount = 'bendavis354@gmail.com';
  const mainMsg = convo.messages.find(m => m.sourceAccount === mainAccount);
  if (mainMsg) return { viewThreadAccount: mainAccount, viewThreadId: mainMsg.gmailThreadId };
  const lm = convo.latestMessage;
  return { viewThreadAccount: lm?.sourceAccount, viewThreadId: lm?.gmailThreadId };
}

// ─── STEP 4: scan calendar ───────────────────────────────────────────────────

console.log('[briefing] scanning calendar...');

// Use primary account for calendar
const calendarAccount = accounts[0];
const calRefreshToken = process.env[calendarAccount.refreshTokenEnv];
const calToken = await getAccessToken({ clientId, clientSecret, refreshToken: calRefreshToken });

// List calendars
let calendarList = [];
try {
  calendarList = await listCalendars({ accessToken: calToken });
} catch (err) {
  console.log(`[briefing] calendar list warning: ${err.message}`);
}

// Tomorrow events
const tmrMin = `${tomorrowStr}T00:00:00-04:00`;
const tmrMax = `${tomorrowStr}T23:59:59-04:00`;

let tomorrowEvents = [];
try {
  const res = await listTomorrowEventsForAccount({
    account: calendarAccount,
    clientId, clientSecret,
    timeMinISO: tmrMin,
    timeMaxISO: tmrMax
  });
  tomorrowEvents = res.events;
} catch (err) {
  console.log(`[briefing] tomorrow calendar warning: ${err.message}`);
}

// Week events
const weekMin = `${todayStr}T00:00:00-04:00`;
const weekMax = `${weekEndStr}T23:59:59-04:00`;

let weekEvents = [];
try {
  const res = await listTomorrowEventsForAccount({
    account: calendarAccount,
    clientId, clientSecret,
    timeMinISO: weekMin,
    timeMaxISO: weekMax
  });
  weekEvents = res.events;
} catch (err) {
  console.log(`[briefing] week calendar warning: ${err.message}`);
}

console.log(`[briefing] tomorrow events: ${tomorrowEvents.length}, week events: ${weekEvents.length}`);

// Dedupe calendar items (same title/start from multiple calendars)
function dedupeEvents(events) {
  const seen = new Set();
  return events.filter(ev => {
    const key = `${ev.title}|${ev.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const tomorrowSchedule = dedupeEvents(tomorrowEvents);
const weekSchedule     = dedupeEvents(weekEvents);

// ─── STEP 5: classify emails and messages ────────────────────────────────────

// Label sets
const SPAM_LABELS   = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM']);
const URGENT_WORDS  = /urgent|asap|immediately|deadline|overdue|time.sensitive|action required/i;
const FINANCIAL_WORDS = /invoice|payment|bill|receipt|bank|statement|tax|irs|payroll|check|wire|ach|balance|due|amount/i;

function classifyConvo(convo) {
  const lm = convo.latestMessage;
  const subject = lm?.subject || '';
  const from    = lm?.from || '';
  const labels  = lm?.labelIds || [];
  const snippet = lm?.snippet || '';

  if (labels.some(l => SPAM_LABELS.has(l))) return 'spam';
  if (URGENT_WORDS.test(subject) || URGENT_WORDS.test(snippet)) return 'urgent';
  if (FINANCIAL_WORDS.test(subject) || FINANCIAL_WORDS.test(snippet)) return 'financial';
  if (convo.status === 'waiting_on_other' || convo.status === 'fyi') return 'waiting';

  const fromLower = from.toLowerCase();
  const heartspring = accounts.find(a => a.label?.toLowerCase().includes('heartspring') || a.email?.includes('heartspring'));
  const biodynamics = accounts.find(a => a.label?.toLowerCase().includes('biodynamic') || a.email?.includes('biodynamic'));

  if (heartspring && lm?.sourceAccount === heartspring.email) return 'business';
  if (biodynamics && lm?.sourceAccount === biodynamics.email) return 'business';

  // newsletters
  if (
    labels.includes('CATEGORY_UPDATES') ||
    /newsletter|digest|unsubscribe|weekly|monthly/i.test(subject) ||
    /no-?reply|newsletter|digest|donotreply/i.test(fromLower)
  ) return 'newsletter';

  return 'business';
}

// Build sections
const sectionsMap = {
  urgent: [],
  tomorrowSchedule: tomorrowSchedule,
  weekSchedule: weekSchedule,
  calendarProposals: [],
  suggestedReplies: [],
  todos: [],
  business: [],
  personal: [],
  financial: [],
  waiting: [],
  newsletter: [],
  spam: [],
  imessage: []
};

// Load prior open tasks into todos if still open
const priorOpenTasks = (assistantState.openTasks || []).filter(t => t.status !== 'done');

// Process conversations
let urgentCount = 0;
let suggestedRepliesCount = 0;
let calProposalCount = 0;
let todosCount = 0;

for (let idx = 0; idx < conversations.length; idx++) {
  const convo = conversations[idx];
  const lm    = convo.latestMessage;
  if (!lm) continue;

  // Skip ignored
  if (ignoredConvos[convo.conversationKey]) continue;

  const bucket   = classifyConvo(convo);
  const gmailLinks = buildGmailLinks(convo);
  const { viewThreadAccount, viewThreadId } = getViewThread(convo);

  const item = {
    id: safeId('conv', idx),
    conversationKey: convo.conversationKey,
    account:         lm.sourceAccount,
    sourceAccount:   lm.sourceAccount,
    sender:          lm.from,
    senderName:      parseSenderName(lm.from),
    senderEmail:     parseSenderEmail(lm.from),
    subject:         lm.subject,
    summary:         lm.snippet?.slice(0, 200) || '',
    snippet:         lm.snippet?.slice(0, 200) || '',
    gmailThreadId:   lm.gmailThreadId,
    gmailMessageId:  lm.gmailMessageId,
    gmailLinks,
    viewThreadAccount,
    viewThreadId,
    status:          convo.status,
    accountsSeen:    convo.accountsSeen,
    date:            lm.date
  };

  if (bucket === 'urgent') urgentCount++;
  if (bucket === 'spam') { sectionsMap.spam.push(item); continue; }

  sectionsMap[bucket === 'waiting' ? 'waiting' : bucket]?.push(item) || sectionsMap.business.push(item);

  // Suggest reply when waiting_on_ben and not spam/newsletter
  if (convo.status === 'waiting_on_ben' && !['spam','newsletter'].includes(bucket)) {
    const replyItem = {
      id: safeId('reply', idx),
      conversationKey: convo.conversationKey,
      account:         lm.sourceAccount,
      sourceAccount:   lm.sourceAccount,
      sender:          lm.from,
      senderEmail:     parseSenderEmail(lm.from),
      subject:         lm.subject,
      title:           `Reply to: ${lm.subject}`,
      detail:          lm.snippet?.slice(0, 300) || '',
      body:            '',
      gmailThreadId:   lm.gmailThreadId,
      gmailLinks,
      viewThreadAccount,
      viewThreadId
    };
    sectionsMap.suggestedReplies.push(replyItem);
    suggestedRepliesCount++;
  }

  // Calendar proposals — detect scheduling language
  const scheduleWords = /schedule|meet|call|appointment|available|zoom|when.*work|time.*work|set.*up/i;
  if (scheduleWords.test(lm.subject) || scheduleWords.test(lm.snippet || '')) {
    sectionsMap.calendarProposals.push({
      id:             safeId('cal', idx),
      conversationKey: convo.conversationKey,
      account:         lm.sourceAccount,
      sourceAccount:   lm.sourceAccount,
      title:           `Meeting: ${parseSenderName(lm.from)}`,
      start:           null,
      end:             null,
      location:        '',
      detail:          lm.snippet?.slice(0, 200) || '',
      context:         lm.subject,
      sourceSender:    lm.from,
      sourceSubject:   lm.subject,
      calendarId:      'primary'
    });
    calProposalCount++;
  }
}

// Carry forward unresolved prior open tasks
for (const task of priorOpenTasks) {
  sectionsMap.todos.push({
    id:            task.id || safeId('task', Math.random()),
    conversationKey: task.conversationKey,
    account:       task.account,
    sourceAccount: task.sourceAccount,
    priority:      task.priority || 'medium',
    text:          task.text,
    status:        task.status || 'open',
    origin:        task.origin || 'manual'
  });
  todosCount++;
}

// ─── iMessage processing ─────────────────────────────────────────────────────

const imessageItems = [];

if (imessageData && imessageStatus === 'fresh' && Array.isArray(imessageData.messages)) {
  const msgs = imessageData.messages;
  imessagesScanned = msgs.length;

  const urgentWords  = /urgent|asap|911|emergency|help|call me|call back|important/i;
  const replyNeeded  = /\?|please|can you|could you|let me know|thoughts|lmk|fyi/i;
  const todoWords    = /pick up|buy|remind|don't forget|call|book|schedule|check on/i;

  const processed = new Set();

  for (const msg of msgs) {
    if (msg.is_from_me) continue; // skip outbound
    const id = msg.guid || `imsg-${msgs.indexOf(msg)}`;
    if (processed.has(id)) continue;
    processed.add(id);

    const body = msg.text || '';
    if (!body.trim()) continue;

    const isUrgent     = urgentWords.test(body);
    const needsReply   = replyNeeded.test(body);
    const hasTodo      = todoWords.test(body);
    const isActionable = isUrgent || needsReply || hasTodo;

    if (!isActionable) continue;

    imessagesActionable++;

    const imsgItem = {
      id,
      sender:     msg.handle_id || msg.sender || 'unknown',
      chat:       msg.chat_identifier || '',
      date:       msg.date || imessageData.exportedAt,
      summary:    body.length > 140 ? body.slice(0, 140) + '…' : body,
      priority:   isUrgent ? 'high' : needsReply ? 'medium' : 'low',
      needsReply: needsReply || isUrgent,
      todoText:   hasTodo ? body.slice(0, 100) : null
    };

    imessageItems.push(imsgItem);

    if (hasTodo) {
      sectionsMap.todos.push({
        id:       `imsg-todo-${id}`,
        priority: isUrgent ? 'high' : 'medium',
        text:     body.slice(0, 120),
        status:   'open',
        origin:   'imessage'
      });
      todosCount++;
    }
  }
}

if (imessageStatus !== 'fresh') {
  imessageItems.push({
    id:         'imsg-status',
    sender:     'system',
    chat:       '',
    date:       now.toISOString(),
    summary:    `iMessage data ${imessageStatus === 'stale' ? 'is stale (>6h old)' : 'unavailable'} — check Mac export.`,
    priority:   'low',
    needsReply: false,
    todoText:   null
  });
}

sectionsMap.imessage = imessageItems;

// ─── STEP 6: write briefing.json ──────────────────────────────────────────────

const generatedAt   = now.toISOString();
const dataFreshAt   = now.toISOString();

const accountsMeta = accounts.map(a => ({
  email: a.email,
  label: a.label || a.email,
  type:  a.type || 'Business'
}));

const calendarsMeta = calendarList.map(c => ({
  id:    c.id,
  name:  c.summary || c.id,
  color: c.backgroundColor || ''
}));

const briefing = {
  metadata: {
    generatedAt,
    date:                todayStr,
    timezone:            'America/New_York',
    lastSuccessfulBuildAt: generatedAt,
    dataFreshThrough:    dataFreshAt,
    liveUrl:             pagesUrl,
    todayLabel:          labelDate(todayET),
    tomorrowLabel:       labelDate(tomorrowET)
  },
  stats: {
    emailsScanned:       deduped.length,
    urgent:              urgentCount,
    eventsTomorrow:      tomorrowSchedule.length,
    eventsThisWeek:      weekSchedule.length,
    proposedEvents:      calProposalCount,
    suggestedReplies:    suggestedRepliesCount,
    todos:               todosCount,
    imessagesScanned,
    imessagesActionable
  },
  accounts:  accountsMeta,
  calendars: calendarsMeta,
  sections:  sectionsMap
};

writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));
console.log('[briefing] briefing.json written');

// ─── STEP 7: build ────────────────────────────────────────────────────────────

console.log('[briefing] running npm install && npm run build...');
try {
  execSync('npm install --silent', { stdio: 'inherit' });
  execSync('npm run build', { stdio: 'inherit' });
  console.log('[briefing] build succeeded');
} catch (err) {
  console.error('[briefing] BUILD FAILED:', err.message);
  process.exit(1);
}

// ─── STEP 8: update assistant memory ─────────────────────────────────────────

console.log('[briefing] updating Drive state...');

// Build compact conversation summaries
const updatedConversations = { ...priorConvos };
for (const convo of conversations) {
  const lm = convo.latestMessage;
  if (!lm) continue;
  const key = convo.conversationKey;
  updatedConversations[key] = {
    conversationKey:    key,
    subject:            lm.subject,
    status:             convo.status,
    accountsSeen:       convo.accountsSeen,
    latestRfcMessageId: lm.rfcMessageId,
    gmailLinks:         buildGmailLinks(convo),
    updatedAt:          now.toISOString()
  };
}

// Collect open todos for state
const openTasksForState = sectionsMap.todos
  .filter(t => t.status !== 'done')
  .map(t => ({
    id:              t.id,
    conversationKey: t.conversationKey,
    account:         t.account,
    sourceAccount:   t.sourceAccount,
    priority:        t.priority,
    text:            t.text,
    status:          t.status || 'open',
    origin:          t.origin
  }));

// Add this run to recentRuns
const recentRuns = [
  ...(assistantState.recentRuns || []).slice(-13),
  {
    runAt:            now.toISOString(),
    emailsScanned:    deduped.length,
    conversations:    conversations.length,
    urgent:           urgentCount,
    suggestedReplies: suggestedRepliesCount,
    todos:            todosCount,
    imessageStatus
  }
];

const newState = {
  ...assistantState,
  version:              2,
  updatedAt:            now.toISOString(),
  conversations:        updatedConversations,
  openTasks:            openTasksForState,
  ignoredConversations: ignoredConvos,
  snoozedConversations: snoozedConvos,
  preferences:          assistantState.preferences || { timezone: 'America/New_York', replyStyle: 'warm, concise, practical' },
  recentRuns
};

let stateUpdated = false;
try {
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: newState });
  stateUpdated = true;
  console.log('[briefing] Drive state updated');
} catch (err) {
  console.error('[briefing] Drive state update failed:', err.message);
}

// ─── STEP 9: deploy ───────────────────────────────────────────────────────────

console.log('[briefing] deploying to claude/briefing...');
try {
  execSync(`git checkout -B claude/briefing`, { stdio: 'inherit' });
  execSync(`git add index.html .nojekyll`, { stdio: 'inherit' });
  execSync(`git commit -m "Briefing ${todayStr}" || true`, { stdio: 'inherit', shell: true });
  execSync(`git push origin claude/briefing --force-with-lease`, { stdio: 'inherit' });
  console.log('[briefing] deployed successfully');
} catch (err) {
  console.error('[briefing] deploy error:', err.message);
}

// ─── STEP 10: summary ────────────────────────────────────────────────────────

const accountLabels = accountsMeta.map(a => a.label).join(', ');

console.log(`
---
BRIEFING SUMMARY
Date: ${todayStr} (${labelDate(todayET)})
Emails scanned: ${deduped.length}
Accounts scanned: ${accountLabels}
Conversations after dedupe: ${conversations.length}
iMessages scanned: ${imessagesScanned}
iMessages actionable: ${imessagesActionable}
Urgent: ${urgentCount}
Calendar events tomorrow: ${tomorrowSchedule.length}
Calendar events this week: ${weekSchedule.length}
Proposed new events: ${calProposalCount}
Suggested replies: ${suggestedRepliesCount}
To-dos: ${todosCount}
State updated: ${stateUpdated ? 'yes' : 'no'}
iMessage export: ${imessageStatus}
Live at: ${pagesUrl}
---
`);
