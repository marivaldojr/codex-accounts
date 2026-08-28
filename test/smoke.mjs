import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const stub = path.resolve('test/vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? stub : originalResolve.call(this, request, ...rest);
};

const { readIdentity, isUsableAuth } = require('../out/identity.js');
const { readAuth, resolveCodexHome } = require('../out/codex-home.js');
const { normalizeRateLimits, windowLabel, fetchUsage, describeFailure } = require('../out/usage.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (error) { failures++; console.log(`  FAIL ${name}\n       ${error.message}`); }
};

console.log('windowLabel');
check('300min becomes 5h', () => assert.equal(windowLabel(300), '5h'));
check('10080min becomes 7d', () => assert.equal(windowLabel(10080), '7d'));
check('43200min becomes 30d', () => assert.equal(windowLabel(43200), '30d'));
check('null does not throw', () => assert.equal(windowLabel(null), 'window'));

console.log('\nnormalizeRateLimits (real payload captured from the app-server)');
const payload = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1788469831 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'pro' },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1788469831 }, secondary: null },
    codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787897021 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788483821 } },
  },
};
const snap = normalizeRateLimits(payload);
check('two limits', () => assert.equal(snap.limits.length, 2));
check('"codex" comes first', () => assert.equal(snap.limits[0].limitId, 'codex'));
check('spark reports 5h and 7d', () => assert.deepEqual(snap.limits[1].windows.map(w => w.label), ['5h', '7d']));
check('plan parsed', () => assert.equal(snap.planType, 'pro'));
check('credits parsed', () => assert.equal(snap.credits.balance, '0'));
check('no error', () => assert.equal(snap.error, undefined));
check('garbage does not throw', () => assert.ok(normalizeRateLimits(null).error));
check('out-of-range percent is clamped', () => {
  const s = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 180, windowDurationMins: 300 } } });
  assert.equal(s.limits[0].windows[0].usedPercent, 100);
});

console.log('\ndescribeFailure (classifying what the app-server reports)');
const revoked = 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Encountered invalidated oauth token for user, failing request", "type": null, "code": "token_revoked", "param": null }, "status": 401 }';
check('a revoked token is an auth failure', () => assert.equal(describeFailure(revoked).errorKind, 'auth'));
check('and says so in one line', () => assert.equal(describeFailure(revoked).error, 'Signed out — this account needs to log in again.'));
check('keeping the raw text for the tooltip', () => assert.equal(describeFailure(revoked).errorDetail, revoked));
check('a missing CLI is not an auth failure', () => {
  const d = describeFailure('could not start codex app-server: spawn codex ENOENT');
  assert.equal(d.errorKind, 'other');
  assert.match(d.error, /Codex CLI not found/);
});
check('a timeout is not an auth failure', () => assert.equal(describeFailure('timed out waiting for initialize.').errorKind, 'other'));
check('an unreachable host is not an auth failure', () => assert.equal(describeFailure('getaddrinfo EAI_AGAIN chatgpt.com').errorKind, 'other'));
check('anything unrecognised still gets a message', () => assert.ok(describeFailure('kaboom').error));

console.log('\nidentity (real auth.json, read-only)');
const auth = readAuth();
check('auth.json found at ' + resolveCodexHome(), () => assert.ok(auth));
check('auth is usable', () => assert.ok(isUsableAuth(auth)));
const identity = readIdentity(auth);
check('email parsed', () => assert.match(identity.email ?? '', /@/));
check('accountId parsed', () => assert.ok(identity.accountId));
check('plan parsed', () => assert.ok(identity.planType));
console.log(`       -> ${identity.email} | plan ${identity.planType} | account ${identity.accountId?.slice(0, 8)}…`);

console.log('\nfetchUsage end to end (throwaway CODEX_HOME)');
const before = JSON.stringify(readAuth());
const { snapshot } = await fetchUsage(auth, '0.1.0');
check('no error', () => assert.equal(snapshot.error, undefined));
check('limits returned', () => assert.ok(snapshot.limits.length > 0));
check('~/.codex/auth.json was NOT touched', () => assert.equal(JSON.stringify(readAuth()), before));
for (const limit of snapshot.limits) {
  console.log(`       ${limit.limitName ?? limit.limitId}: ` + limit.windows.map(w => `${w.label} ${w.usedPercent}%`).join(' | '));
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
