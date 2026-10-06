import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';
import { Cooldowns } from '../src/cooldown.js';
import { classifyStatus, extractJSON, parseRetryAfter } from '../src/provider.js';
import { fakeClock } from './helpers.js';

const provider = (name, extra = {}) => ({ name, baseUrl: `https://${name}.example/v1/`, keyEnv: `${name.toUpperCase()}_KEY`, models: { smart: 'm' }, ...extra });

test('config keeps only providers with a key, in order, and strips trailing slashes', () => {
  const config = buildConfig(
    { providers: [provider('a'), provider('b'), provider('c')] },
    { GATEWAY_API_KEY: 'g', A_KEY: 'ka', C_KEY: 'kc' },
  );
  assert.deepEqual(config.providers.map(p => p.name), ['a', 'c']);
  assert.deepEqual(config.skipped, ['b']);
  assert.equal(config.providers[0].baseUrl, 'https://a.example/v1');
  assert.equal(config.providers[0].key, 'ka');
  assert.equal(config.providers[0].timeoutMs, 30_000);
  assert.equal(config.strategy, 'priority');
});

test('config rejects bad input', () => {
  const env = { GATEWAY_API_KEY: 'g' };
  assert.throws(() => buildConfig({ providers: [] }, {}), /GATEWAY_API_KEY/);
  assert.throws(() => buildConfig({ strategy: 'random', providers: [] }, env), /strategy/);
  assert.throws(() => buildConfig({ providers: [provider('a'), provider('a')] }, env), /duplicate/);
  assert.throws(() => buildConfig({ providers: [provider('a', { baseUrl: '' })] }, env), /baseUrl/);
  assert.throws(() => buildConfig({ providers: [provider('a', { models: { smart: 1 } })] }, env), /models/);
  assert.throws(() => buildConfig({ providers: [provider('a', { timeoutMs: -1 })] }, env), /timeoutMs/);
});

test('rate-limit backoff doubles from 60s and caps at 15 minutes', () => {
  const clock = fakeClock();
  const cd = new Cooldowns({ now: clock.now });
  const applied = Array.from({ length: 6 }, () => cd.rateLimited('p:m'));
  assert.deepEqual(applied, [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  assert.equal(cd.coolingUntil('p:m'), clock.t + 900_000);
});

test('Retry-After overrides backoff (capped at a day); success resets strikes', () => {
  const clock = fakeClock();
  const cd = new Cooldowns({ now: clock.now });
  assert.equal(cd.rateLimited('p:m', 5_000), 5_000);
  assert.equal(cd.rateLimited('p:m', 3 * 86_400_000), 86_400_000);
  cd.success('p:m');
  assert.equal(cd.isCooling('p:m'), false);
  assert.equal(cd.rateLimited('p:m'), 60_000);
});

test('cooldowns expire with time; disabling is per provider', () => {
  const clock = fakeClock();
  const cd = new Cooldowns({ now: clock.now });
  cd.serverError('p:m');
  assert.equal(cd.isCooling('p:m'), true);
  clock.advance(30_000);
  assert.equal(cd.isCooling('p:m'), false);
  cd.disable('p', 'bad key');
  assert.equal(cd.isDisabled('p'), true);
  assert.equal(cd.disabledReason('p'), 'bad key');
  assert.equal(cd.isDisabled('q'), false);
});

test('classifyStatus maps HTTP status to failure kind', () => {
  assert.equal(classifyStatus(429), 'rate_limit');
  assert.equal(classifyStatus(401), 'auth');
  assert.equal(classifyStatus(403), 'auth');
  assert.equal(classifyStatus(500), 'server');
  assert.equal(classifyStatus(503), 'server');
  for (const status of [400, 404, 413, 422]) assert.equal(classifyStatus(status), 'request');
});

test('parseRetryAfter handles seconds, HTTP dates and junk', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(parseRetryAfter('12', now), 12_000);
  assert.equal(parseRetryAfter('Thu, 01 Oct 2026 00:01:00 GMT', now), 60_000);
  assert.equal(parseRetryAfter('Wed, 30 Sep 2026 00:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

test('extractJSON accepts clean, fenced and chatty JSON; rejects non-JSON', () => {
  assert.equal(extractJSON(' {"a":1} '), '{"a":1}');
  assert.equal(extractJSON('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJSON('Sure! Here it is: {"a":{"b":2}} Hope that helps.'), '{"a":{"b":2}}');
  assert.equal(extractJSON('[1,2]'), '[1,2]');
  assert.equal(extractJSON('no json here'), undefined);
  assert.equal(extractJSON('{broken'), undefined);
  assert.equal(extractJSON(null), undefined);
});
