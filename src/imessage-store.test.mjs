/**
 * Checks for the iMessage export loader: freshness classification, and the
 * three failure modes the brief must tell apart (never exported / stale Mac /
 * wrong key). Run: node src/imessage-store.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptState } from './state-store.mjs';
import { loadImessageExport, STALE_AFTER_HOURS } from './imessage-store.mjs';

process.env.STATE_ENCRYPTION_KEY = 'test-key-for-imessage-store';

const NOW = new Date('2026-09-12T12:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-store-'));
const cwd = process.cwd();

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

/** Run body inside an empty dir so the git fallback finds nothing. */
function inScratch(fn) {
  const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
  process.chdir(dir);
  try { return fn(dir); } finally { process.chdir(cwd); }
}

const payload = exportedAt => ({
  version: 1,
  exportedAt,
  windowHours: 48,
  messages: [{ chat_id: 'c1', sender_name: 'Valeska', is_from_me: false, text: 'call me' }]
});

// ── freshness ────────────────────────────────────────────────────────────────
check('a recent export reads as fresh', () => {
  inScratch(() => {
    fs.writeFileSync('imessages.enc', encryptState(payload(hoursAgo(2))));
    const r = loadImessageExport({ now: NOW });
    assert.equal(r.status, 'fresh');
    assert.equal(r.data.messages.length, 1);
    assert.ok(r.ageHours > 1.9 && r.ageHours < 2.1, `ageHours=${r.ageHours}`);
  });
});

check('an export past the staleness limit reads as stale', () => {
  inScratch(() => {
    fs.writeFileSync('imessages.enc', encryptState(payload(hoursAgo(STALE_AFTER_HOURS + 1))));
    const r = loadImessageExport({ now: NOW });
    assert.equal(r.status, 'stale');
    // Stale data is still returned so the notice can name the upload time.
    assert.ok(r.data.exportedAt);
  });
});

check('an export with no exportedAt is stale, not fresh', () => {
  inScratch(() => {
    fs.writeFileSync('imessages.enc', encryptState({ version: 1, messages: [] }));
    const r = loadImessageExport({ now: NOW });
    assert.equal(r.status, 'stale');
    assert.equal(r.ageHours, null);
  });
});

// ── failure modes stay distinguishable ───────────────────────────────────────
check('no export anywhere reports missing, not error', () => {
  inScratch(() => {
    const r = loadImessageExport({ now: NOW });
    assert.equal(r.status, 'missing');
    assert.equal(r.data, null);
    assert.match(r.error, /imessages\.enc/);
  });
});

check('a wrong key reports error, not missing', () => {
  inScratch(() => {
    const blob = encryptState(payload(hoursAgo(1)), 'a-different-key');
    fs.writeFileSync('imessages.enc', blob);
    const r = loadImessageExport({ now: NOW });
    assert.equal(r.status, 'error');
    assert.equal(r.data, null);
  });
});

check('a truncated blob reports error and names the file', () => {
  inScratch(() => {
    fs.writeFileSync('imessages.enc', Buffer.from('not a BAS1 container'));
    const r = loadImessageExport({ now: NOW });
    assert.equal(r.status, 'error');
    assert.match(r.error, /imessages\.enc is not a valid BAS1 blob/);
  });
});

// ── plaintext override (tests + manual runs) ─────────────────────────────────
check('IMESSAGE_EXPORT_FILE takes precedence over the repo copy', () => {
  inScratch(dir => {
    fs.writeFileSync('imessages.enc', encryptState(payload(hoursAgo(99))));
    const plain = path.join(dir, 'plain.json');
    fs.writeFileSync(plain, JSON.stringify(payload(hoursAgo(1))));
    process.env.IMESSAGE_EXPORT_FILE = plain;
    try {
      const r = loadImessageExport({ now: NOW });
      assert.equal(r.status, 'fresh');
      assert.equal(r.source, plain);
    } finally {
      delete process.env.IMESSAGE_EXPORT_FILE;
    }
  });
});

check('a malformed override degrades to missing without throwing', () => {
  inScratch(dir => {
    const plain = path.join(dir, 'bad.json');
    fs.writeFileSync(plain, '{ not json');
    process.env.IMESSAGE_EXPORT_FILE = plain;
    try {
      const r = loadImessageExport({ now: NOW });
      assert.equal(r.status, 'missing');
    } finally {
      delete process.env.IMESSAGE_EXPORT_FILE;
    }
  });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed.`);
