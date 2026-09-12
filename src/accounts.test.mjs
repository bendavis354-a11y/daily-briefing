/**
 * Checks for reading the account list out of the environment, including the
 * paste error that broke the fact-refresh workflow on its very first run.
 * Run: node src/accounts.test.mjs
 */
import assert from 'node:assert';
import { loadAccounts, pickDriveAccount, isConnectorAccount } from './accounts.mjs';

const REAL = '[{"email":"a@x.com","label":"Personal","auth":"connector"},' +
             '{"email":"b@y.org","label":"Work","refreshTokenEnv":"TOK_B"}]';
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

check('parses a normal value', () => {
  const a = loadAccounts(REAL);
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].email, 'a@x.com');
});

check('an unset or empty value is an empty list, not a crash', () => {
  // Passing undefined would fall through to the default argument and read the
  // real environment, so clear the variable to test what "unset" actually does.
  const saved = process.env.GMAIL_ACCOUNTS_JSON;
  delete process.env.GMAIL_ACCOUNTS_JSON;
  try {
    assert.deepStrictEqual(loadAccounts(), []);
    assert.deepStrictEqual(loadAccounts(''), []);
    assert.deepStrictEqual(loadAccounts('   '), []);
  } finally {
    if (saved !== undefined) process.env.GMAIL_ACCOUNTS_JSON = saved;
  }
});

check('with no argument it reads the environment', () => {
  const saved = process.env.GMAIL_ACCOUNTS_JSON;
  process.env.GMAIL_ACCOUNTS_JSON = REAL;
  try {
    assert.strictEqual(loadAccounts().length, 2);
  } finally {
    if (saved === undefined) delete process.env.GMAIL_ACCOUNTS_JSON;
    else process.env.GMAIL_ACCOUNTS_JSON = saved;
  }
});

// Regression: the secret was saved with the shell quotes still wrapped around
// it. JSON.parse answered with an unexpected-token error that named neither
// the variable at fault nor anything the operator could act on.
check('survives the value being wrapped in single quotes', () => {
  assert.strictEqual(loadAccounts("'" + REAL + "'").length, 2);
});

check('survives the value being wrapped in double quotes', () => {
  assert.strictEqual(loadAccounts('"' + REAL + '"').length, 2);
});

check('surrounding whitespace is harmless', () => {
  assert.strictEqual(loadAccounts('\n  ' + REAL + '  \n').length, 2);
});

check('genuinely broken JSON still fails, naming the variable', () => {
  assert.throws(() => loadAccounts('[{"email": }]'), /GMAIL_ACCOUNTS_JSON is not valid JSON/);
});

check('a JSON value that is not a list is rejected', () => {
  assert.throws(() => loadAccounts('{"email":"a@x.com"}'), /must be a JSON array/);
});

check('a quoted plain string is not mistaken for a list', () => {
  assert.throws(() => loadAccounts('"not an account list"'), /GMAIL_ACCOUNTS_JSON/);
});

// The roles the rest of the pipeline reads off the parsed list.
check('connector accounts are recognised, and never chosen for Drive work', () => {
  const a = loadAccounts(REAL);
  assert.strictEqual(isConnectorAccount(a[0]), true);
  assert.strictEqual(isConnectorAccount(a[1]), false);
  assert.strictEqual(pickDriveAccount(a).email, 'b@y.org');
});

console.log(`\n${passed} checks passed.`);
