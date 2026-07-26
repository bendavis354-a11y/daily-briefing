/**
 * Durable assistant memory, stored as an encrypted file in the git repo.
 *
 * Why: no durable Google token can read the personal Drive (the Workspace
 * tokens lack Drive scope; the personal token dies weekly), and connector tool
 * results cannot reach disk without the agent re-typing them — unacceptable for
 * a file of any size. The repo is the one store the pipeline already reads and
 * writes durably, so memory lives there as `state.enc` on the deploy branch
 * (claude/briefing), AES-256-GCM encrypted — same posture as the published
 * briefing page.
 *
 * Format: "BAS1" | salt(16) | iv(12) | ciphertext | authTag(16)
 * Key: PBKDF2-SHA256, 250k iterations, from STATE_ENCRYPTION_KEY or
 * BRIEFING_PASSWORD.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { emptyState } from './drive-state.mjs';

const MAGIC = Buffer.from('BAS1');
const ITERATIONS = 250000;
export const STATE_BRANCH = 'claude/briefing';
export const STATE_FILE = 'state.enc';

export function statePassword() {
  const pw = process.env.STATE_ENCRYPTION_KEY || process.env.BRIEFING_PASSWORD;
  if (!pw) throw new Error('No STATE_ENCRYPTION_KEY or BRIEFING_PASSWORD set — cannot encrypt/decrypt state.');
  return pw;
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
}

export function encryptState(state, password = statePassword()) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(state, null, 2), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, ct, cipher.getAuthTag()]);
}

export function decryptState(buf, password = statePassword()) {
  if (!Buffer.isBuffer(buf) || buf.length < 48 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('state.enc is not a valid BAS1 blob');
  }
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(32, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** Write the encrypted state next to the repo root for the deploy commit. */
export function saveStateLocal(state, file = STATE_FILE) {
  fs.writeFileSync(file, encryptState(state));
  return file;
}

/**
 * Load durable state. Precedence:
 *   1. CONNECTOR_STATE_FILE (plain JSON handed in externally; kept for tests)
 *   2. local state.enc (already fetched/written this run)
 *   3. state.enc on origin/claude/briefing (git fetch + git show)
 * A missing file means first run → empty state (loud log). A file that exists
 * but fails to decrypt is a hard error: wrong key must never silently reset
 * memory.
 */
export function loadDurableState({ cwd = process.cwd() } = {}) {
  const connectorFile = process.env.CONNECTOR_STATE_FILE;
  if (connectorFile) {
    const state = JSON.parse(fs.readFileSync(connectorFile, 'utf8'));
    console.log(`State loaded from ${connectorFile}`);
    return state;
  }

  if (fs.existsSync(STATE_FILE)) {
    const state = decryptState(fs.readFileSync(STATE_FILE));
    console.log(`State loaded from local ${STATE_FILE}`);
    return state;
  }

  try {
    execFileSync('git', ['fetch', 'origin', STATE_BRANCH], { cwd, stdio: 'pipe' });
  } catch (err) {
    console.warn(`git fetch ${STATE_BRANCH} failed: ${err.message}`);
  }
  let buf;
  try {
    buf = execFileSync('git', ['show', `origin/${STATE_BRANCH}:${STATE_FILE}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    console.warn(`No ${STATE_FILE} on origin/${STATE_BRANCH} — starting with EMPTY state (first run).`);
    return emptyState();
  }
  const state = decryptState(buf); // throws on wrong key — intentional
  console.log(`State loaded from origin/${STATE_BRANCH}:${STATE_FILE} (updatedAt=${state.updatedAt})`);
  return state;
}
