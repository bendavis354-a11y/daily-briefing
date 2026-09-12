/**
 * iMessage export transport.
 *
 * Why not Google Drive (the old path): the cloud tokens hold the `drive.file`
 * scope, which only ever sees files the *same OAuth client* created. The Mac
 * exporter uploaded as bendavis354@gmail.com while the pipeline reads as
 * ben@heartspringgardens.org, so the export was invisible — a 404, not a 403,
 * and sharing the file would not have helped. On top of that the personal
 * refresh token is a consumer-account token that Google expires every 7 days,
 * so the upload half died weekly by construction.
 *
 * Durable memory hit the same wall and was moved into the repo (see
 * state-store.mjs). The export now rides the same rails: `imessages.enc` on the
 * deploy branch, AES-256-GCM, same BAS1 container as state.enc. Git is the one
 * transport both ends already hold durable credentials for.
 *
 * The Mac writes it (mac/export-imessages.py, via the GitHub contents API);
 * this module only reads.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decryptState } from './state-store.mjs';

export const IMESSAGE_BRANCH = 'claude/briefing';
export const IMESSAGE_FILE = 'imessages.enc';

/** Exports older than this are reported but never processed. */
export const STALE_AFTER_HOURS = 6;

/** Start warning about the GitHub token this many days before it lapses. */
export const TOKEN_WARN_DAYS = 21;

/** The one command Ben runs when any part of this chain fails. */
export const REPAIR_COMMAND = 'bash ~/daily-briefing/mac/diagnose.sh --fix';

/**
 * Days until the exporter's GitHub token expires, or null when unknown.
 *
 * The exporter records what GitHub reports on each authenticated response.
 * Without this the first sign of expiry is the export simply stopping, months
 * after anyone remembers setting the token up.
 */
export function tokenExpiryWarning(data, now = new Date()) {
  const raw = String(data?.tokenExpiresAt || '').trim();
  if (!raw) return null;
  const expires = Date.parse(raw);
  if (Number.isNaN(expires)) return null;
  const daysLeft = Math.floor((expires - now.getTime()) / 86400000);
  if (daysLeft > TOKEN_WARN_DAYS) return null;
  return { daysLeft, expiresAt: new Date(expires).toISOString() };
}

function classify(data, now) {
  const exportedAt = data?.exportedAt ? new Date(data.exportedAt) : null;
  if (!exportedAt || Number.isNaN(exportedAt.getTime())) {
    return { status: 'stale', ageHours: null };
  }
  const ageHours = (now - exportedAt) / 3600000;
  return { status: ageHours > STALE_AFTER_HOURS ? 'stale' : 'fresh', ageHours };
}

/**
 * Load the newest iMessage export. Precedence:
 *   1. IMESSAGE_EXPORT_FILE (plain JSON handed in externally; tests + manual runs)
 *   2. local imessages.enc (already fetched this run)
 *   3. imessages.enc on origin/claude/briefing
 *
 * Never throws: a missing export degrades the brief, it does not fail the run.
 * A file that exists but will not decrypt IS surfaced as an error status, since
 * a wrong key is a real fault and must not read as "the Mac is asleep".
 */
export function loadImessageExport({ cwd = process.cwd(), now = new Date() } = {}) {
  const plainFile = process.env.IMESSAGE_EXPORT_FILE;
  if (plainFile) {
    try {
      const data = JSON.parse(fs.readFileSync(plainFile, 'utf8'));
      return { data, source: plainFile, ...classify(data, now) };
    } catch (err) {
      return { data: null, status: 'missing', ageHours: null, source: plainFile, error: err.message };
    }
  }

  let buf = null;
  let source = null;

  if (fs.existsSync(IMESSAGE_FILE)) {
    buf = fs.readFileSync(IMESSAGE_FILE);
    source = `local ${IMESSAGE_FILE}`;
  } else {
    try {
      execFileSync('git', ['fetch', 'origin', IMESSAGE_BRANCH], { cwd, stdio: 'pipe' });
    } catch (err) {
      console.warn(`git fetch ${IMESSAGE_BRANCH} failed: ${err.message}`);
    }
    try {
      buf = execFileSync('git', ['show', `origin/${IMESSAGE_BRANCH}:${IMESSAGE_FILE}`], {
        cwd, maxBuffer: 64 * 1024 * 1024
      });
      source = `origin/${IMESSAGE_BRANCH}:${IMESSAGE_FILE}`;
    } catch {
      return {
        data: null, status: 'missing', ageHours: null, source: null,
        error: `no ${IMESSAGE_FILE} on origin/${IMESSAGE_BRANCH}`
      };
    }
  }

  let data;
  try {
    data = decryptState(buf, undefined, IMESSAGE_FILE);
  } catch (err) {
    return { data: null, status: 'error', ageHours: null, source, error: err.message };
  }
  return { data, source, ...classify(data, now) };
}
