import { readFileSync } from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { oauthAccounts } from './accounts.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HEADERS = [
  'Message-ID',
  'References',
  'In-Reply-To',
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'Delivered-To',
  'X-Original-To',
  'Reply-To'
];

export async function scanConfiguredMailboxes() {
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const results = [];

  // Only OAuth mailboxes are scanned here. Connector accounts (consumer gmail.com
  // with a weekly-expiring token) are read by the agent and merged separately via
  // loadConnectorMessages(), so a dead personal token can never halt the scan.
  for (const account of oauthAccounts(accounts)) {
    results.push(await scanMailbox({ account, clientId, clientSecret }));
  }

  return results;
}

/**
 * Load personal-mailbox messages the agent fetched through the Gmail connector
 * and dumped to a JSON file (path in CONNECTOR_MESSAGES_FILE). Normalizes the
 * connector's field names to the pipeline message shape. Connector messages have
 * no RFC822 headers, so rfcMessageId/references/inReplyTo are empty and
 * continuity falls back to Gmail thread ids + content keys.
 *
 * Expected file: { sourceAccount, messages: [ { id, threadId, sender,
 * toRecipients, ccRecipients, subject, snippet, date, labelIds } ] }
 * or a bare array of such messages.
 */
export function loadConnectorMessages(filePath = process.env.CONNECTOR_MESSAGES_FILE) {
  if (!filePath) return [];

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`Connector messages unavailable (${filePath}): ${err.message}`);
    return [];
  }

  const defaultAccount = raw.sourceAccount || '';
  const list = Array.isArray(raw) ? raw : (raw.messages || []);
  return list.map(m => normalizeConnectorMessage(m, defaultAccount));
}

export function normalizeConnectorMessage(m, defaultAccount = '') {
  const list = v => (Array.isArray(v) ? v.join(', ') : String(v || ''));
  const ms = m.internalDate
    ? Number(m.internalDate)
    : (m.date ? Date.parse(m.date) || null : null);

  return {
    sourceAccount: (m.sourceAccount || defaultAccount || '').toLowerCase(),
    gmailMessageId: m.id || m.gmailMessageId || '',
    gmailThreadId: m.threadId || m.gmailThreadId || '',
    labelIds: m.labelIds || [],
    snippet: m.snippet || '',
    internalDate: ms,
    // Connector never exposes RFC822 headers.
    rfcMessageId: '',
    references: [],
    inReplyTo: '',
    from: m.from || m.sender || '',
    to: m.to || list(m.toRecipients),
    cc: m.cc || list(m.ccRecipients),
    subject: m.subject || '',
    date: m.date || '',
    deliveredTo: '',
    originalTo: '',
    replyTo: ''
  };
}

export async function scanMailbox({ account, clientId, clientSecret }) {
  const refreshToken = process.env[account.refreshTokenEnv];
  const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  const ids = new Map();

  for (const query of ['newer_than:2d', 'in:sent newer_than:14d']) {
    for (const msg of await listMessageIds({ accessToken, query, max: 250 })) {
      ids.set(msg.id, msg);
    }
  }

  const messages = [];
  for (const id of ids.keys()) {
    messages.push(await getMessageMetadata({ accessToken, id, sourceAccount: account.email }));
  }

  return { account, accessToken, messages };
}

export async function listMessageIds({ accessToken, query, max = 250 }) {
  const out = [];
  let pageToken;

  while (out.length < max) {
    const url = new URL(`${GMAIL}/messages`);
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(Math.min(100, max - out.length)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Gmail list failed: ${res.status} ${await res.text()}`);

    const json = await res.json();
    out.push(...(json.messages || []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return out;
}

export async function getMessageMetadata({ accessToken, id, sourceAccount }) {
  const url = new URL(`${GMAIL}/messages/${id}`);
  url.searchParams.set('format', 'metadata');
  for (const header of HEADERS) url.searchParams.append('metadataHeaders', header);

  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail get metadata failed: ${res.status} ${await res.text()}`);

  const msg = await res.json();
  const headers = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));

  return {
    sourceAccount,
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId,
    labelIds: msg.labelIds || [],
    snippet: msg.snippet || '',
    internalDate: msg.internalDate ? Number(msg.internalDate) : null,
    rfcMessageId: normalizeMessageId(headers['message-id']),
    references: parseReferences(headers.references),
    inReplyTo: normalizeMessageId(headers['in-reply-to']),
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    subject: headers.subject || '',
    date: headers.date || '',
    deliveredTo: headers['delivered-to'] || '',
    originalTo: headers['x-original-to'] || '',
    replyTo: headers['reply-to'] || ''
  };
}

export async function getMessageBody({ accessToken, id, maxChars = 4000 }) {
  const url = new URL(`${GMAIL}/messages/${id}`);
  url.searchParams.set('format', 'full');

  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail get body failed: ${res.status} ${await res.text()}`);

  const msg = await res.json();
  return extractPlainText(msg.payload).slice(0, maxChars);
}

function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBody(part.body.data);
  if (part.parts) {
    const direct = part.parts.find(p => p.mimeType === 'text/plain');
    if (direct?.body?.data) return decodeBody(direct.body.data);
    for (const child of part.parts) {
      const text = extractPlainText(child);
      if (text) return text;
    }
  }
  return '';
}

function decodeBody(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function normalizeMessageId(value) {
  if (!value) return '';
  const match = String(value).match(/<[^>]+>/);
  return (match ? match[0] : value).trim().toLowerCase();
}

function parseReferences(value) {
  if (!value) return [];
  return [...String(value).matchAll(/<[^>]+>/g)].map(m => m[0].toLowerCase());
}
