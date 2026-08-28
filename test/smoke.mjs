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
const { normalizeRateLimits, windowLabel } = require('../out/usage.js');
const { fetchUsage } = require('../out/usage.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (error) { failures++; console.log(`  FAIL ${name}\n       ${error.message}`); }
};

console.log('windowLabel');
check('300min vira 5h', () => assert.equal(windowLabel(300), '5h'));
check('10080min vira 7d', () => assert.equal(windowLabel(10080), '7d'));
check('43200min vira 30d', () => assert.equal(windowLabel(43200), '30d'));
check('nulo nao quebra', () => assert.equal(windowLabel(null), 'janela'));

console.log('\nnormalizeRateLimits (payload real capturado do app-server)');
const payload = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1788469831 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'pro' },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1788469831 }, secondary: null },
    codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787897021 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788483821 } },
  },
};
const snap = normalizeRateLimits(payload);
check('dois limites', () => assert.equal(snap.limits.length, 2));
check('"codex" vem primeiro', () => assert.equal(snap.limits[0].limitId, 'codex'));
check('spark traz 5h e 7d', () => assert.deepEqual(snap.limits[1].windows.map(w => w.label), ['5h', '7d']));
check('plano lido', () => assert.equal(snap.planType, 'pro'));
check('creditos lidos', () => assert.equal(snap.credits.balance, '0'));
check('sem erro', () => assert.equal(snap.error, undefined));
check('lixo nao quebra', () => assert.ok(normalizeRateLimits(null).error));
check('percentual fora da faixa e cortado', () => {
  const s = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 180, windowDurationMins: 300 } } });
  assert.equal(s.limits[0].windows[0].usedPercent, 100);
});

console.log('\nidentidade (auth.json real, somente leitura)');
const auth = readAuth();
check('auth.json encontrado em ' + resolveCodexHome(), () => assert.ok(auth));
check('auth utilizavel', () => assert.ok(isUsableAuth(auth)));
const identity = readIdentity(auth);
check('email extraido', () => assert.match(identity.email ?? '', /@/));
check('accountId extraido', () => assert.ok(identity.accountId));
check('plano extraido', () => assert.ok(identity.planType));
console.log(`       -> ${identity.email} | plano ${identity.planType} | conta ${identity.accountId?.slice(0, 8)}…`);

console.log('\nfetchUsage ponta a ponta (CODEX_HOME descartavel)');
const before = JSON.stringify(readAuth());
const { snapshot } = await fetchUsage(auth, '0.1.0');
check('sem erro', () => assert.equal(snapshot.error, undefined));
check('trouxe limites', () => assert.ok(snapshot.limits.length > 0));
check('~/.codex/auth.json NAO foi tocado', () => assert.equal(JSON.stringify(readAuth()), before));
for (const limit of snapshot.limits) {
  console.log(`       ${limit.limitName ?? limit.limitId}: ` + limit.windows.map(w => `${w.label} ${w.usedPercent}%`).join(' | '));
}

console.log(failures === 0 ? '\nTUDO OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
