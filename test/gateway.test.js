import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider, startGateway, okBody, ask, GATEWAY_KEY } from './helpers.js';

let a, b, c, gw;

beforeEach(async () => {
  [a, b, c] = await Promise.all(['a', 'b', 'c'].map(startFakeProvider));
});

afterEach(async () => {
  await Promise.all([a, b, c, gw].filter(Boolean).map(x => x.close()));
  gw = undefined;
});

// ----- basics -----

test('answers from the first provider, resolving the alias and forwarding the key', async () => {
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask({ temperature: 0.2 }));
  assert.equal(res.status, 200);
  assert.equal(res.json.choices[0].message.content, 'hello from a');
  assert.equal(res.headers.get('x-llm-provider'), 'a');
  assert.equal(res.headers.get('x-llm-model'), 'a-smart');
  assert.equal(a.calls[0].body.model, 'a-smart');
  assert.equal(a.calls[0].body.temperature, 0.2);
  assert.equal(a.calls[0].headers.authorization, 'Bearer key-a');
  assert.equal(a.calls[0].url, '/v1/chat/completions');
  assert.equal(b.calls.length, 0);
});

test('a real model name goes only to providers that list it', async () => {
  gw = await startGateway({ fakes: [a, b], models: { a: { smart: 'llama-x' }, b: { smart: 'qwen-y' } } });
  const res = await gw.chat(ask({ model: 'qwen-y' }));
  assert.equal(res.headers.get('x-llm-provider'), 'b');
  assert.equal(b.calls[0].body.model, 'qwen-y');
  assert.equal(a.calls.length, 0);
});

test('no providers configured is a 503 that says so', async () => {
  gw = await startGateway({ fakes: [] });
  const res = await gw.chat(ask());
  assert.equal(res.status, 503);
  assert.match(res.json.error.message, /No providers configured/);
});

test('unknown model is a 400', async () => {
  gw = await startGateway({ fakes: [a] });
  const res = await gw.chat(ask({ model: 'vision' }));
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'model_not_found');
});

// ----- failure table -----

test('429 with Retry-After: fails over and cools down for exactly that long', async () => {
  a.respond({ status: 429, headers: { 'Retry-After': '20' }, body: { error: { message: 'slow down' } } });
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask());
  assert.equal(res.headers.get('x-llm-provider'), 'b');
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 20_000);
});

test('429 without Retry-After: backoff 60s, then 120s', async () => {
  a.respond({ status: 429, body: {} });
  b.respond({ status: 429, body: {} });
  c.respond({ status: 200, body: okBody('ok') });
  gw = await startGateway({ fakes: [a, b, c] });
  await gw.chat(ask());
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 60_000);
  gw.clock.advance(60_000);
  await gw.chat(ask());
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 120_000);
});

test('5xx: fails over with a 30s cooldown', async () => {
  a.respond({ status: 502, body: 'bad gateway' });
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask());
  assert.equal(res.headers.get('x-llm-provider'), 'b');
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 30_000);
});

test('timeout: fails over with a 30s cooldown', async () => {
  a.respond({ hang: true });
  gw = await startGateway({ fakes: [a, b], timeoutMs: 200 });
  const res = await gw.chat(ask());
  assert.equal(res.headers.get('x-llm-provider'), 'b');
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 30_000);
});

test('network error (provider down): fails over with a 30s cooldown', async () => {
  await a.close();
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask());
  assert.equal(res.headers.get('x-llm-provider'), 'b');
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 30_000);
});

test('401: the whole provider is disabled and never tried again, even as a last resort', async () => {
  a.respond({ status: 401, body: { error: { message: 'invalid key' } } });
  gw = await startGateway({ fakes: [a], models: { a: { smart: 'a-smart', fast: 'a-fast' } } });
  const first = await gw.chat(ask());
  assert.equal(first.status, 503);
  assert.equal(gw.cooldowns.isDisabled('a'), true);

  // A different model on the same provider is disabled too: the key is bad.
  const second = await gw.chat(ask({ model: 'fast' }));
  assert.equal(second.status, 503);
  assert.match(second.json.error.message, /every provider for this model is disabled/);
  assert.equal(a.calls.length, 1);
});

test('403: only that provider+model is disabled; the provider\'s other models keep working', async () => {
  a.respond(body => (body.model === 'a-smart'
    ? { status: 403, body: { error: { message: 'model only available on agentic harnesses' } } }
    : { status: 200, body: okBody('fast works') }));
  gw = await startGateway({ fakes: [a, b], models: { a: { smart: 'a-smart', fast: 'a-fast' }, b: { smart: 'b-smart' } } });

  const first = await gw.chat(ask());
  assert.equal(first.headers.get('x-llm-provider'), 'b');
  assert.equal(gw.cooldowns.isDisabled('a:a-smart'), true);
  assert.equal(gw.cooldowns.isDisabled('a'), false);

  await gw.chat(ask()); // a-smart is skipped now
  assert.equal(a.calls.filter(c => c.body.model === 'a-smart').length, 1);

  const fast = await gw.chat(ask({ model: 'fast' }));
  assert.equal(fast.headers.get('x-llm-provider'), 'a');
  assert.equal(fast.json.choices[0].message.content, 'fast works');
});

test('400/413/422: fails over without any cooldown', async () => {
  for (const status of [400, 413, 422]) {
    a.respond({ status, body: { error: { message: 'unsupported parameter' } } });
    gw = await startGateway({ fakes: [a, b] });
    const res = await gw.chat(ask());
    assert.equal(res.headers.get('x-llm-provider'), 'b', `status ${status}`);
    assert.equal(gw.cooldowns.isCooling('a:a-smart'), false, `status ${status}`);
    await gw.close();
    gw = undefined;
  }
});

test('bad JSON when JSON was requested: fails over without a cooldown', async () => {
  a.respond({ status: 200, body: okBody('I cannot do JSON today') });
  b.respond({ status: 200, body: okBody('{"ok":true}') });
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask({ response_format: { type: 'json_object' } }));
  assert.equal(res.headers.get('x-llm-provider'), 'b');
  assert.equal(res.json.choices[0].message.content, '{"ok":true}');
  assert.equal(gw.cooldowns.isCooling('a:a-smart'), false);
});

test('fenced JSON is cleaned up instead of failing over', async () => {
  a.respond({ status: 200, body: okBody('```json\n{"post":"hi"}\n```') });
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask({ response_format: { type: 'json_object' } }));
  assert.equal(res.headers.get('x-llm-provider'), 'a');
  assert.equal(res.json.choices[0].message.content, '{"post":"hi"}');
});

test('non-JSON text is passed through untouched when JSON was not requested', async () => {
  a.respond({ status: 200, body: okBody('just text') });
  gw = await startGateway({ fakes: [a] });
  const res = await gw.chat(ask());
  assert.equal(res.json.choices[0].message.content, 'just text');
});

test('HTTP 200 carrying an error object is classified by its code', async () => {
  a.respond({ status: 200, body: { error: { code: 429, message: 'upstream rate limited' } } });
  b.respond({ status: 200, body: { error: { message: 'upstream exploded' } } });
  gw = await startGateway({ fakes: [a, b, c] });
  const res = await gw.chat(ask());
  assert.equal(res.headers.get('x-llm-provider'), 'c');
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 60_000);
  assert.equal(gw.cooldowns.coolingUntil('b:b-smart'), gw.clock.t + 30_000);
});

test('a success resets the backoff for that provider', async () => {
  a.respond((_, n) => (n === 1 ? { status: 429, body: {} } : { status: 200, body: okBody('back') }));
  gw = await startGateway({ fakes: [a, b] });
  await gw.chat(ask());
  gw.clock.advance(60_000);
  const res = await gw.chat(ask());
  assert.equal(res.headers.get('x-llm-provider'), 'a');
  assert.equal(gw.cooldowns.isCooling('a:a-smart'), false);
  a.respond({ status: 429, body: {} });
  await gw.chat(ask());
  assert.equal(gw.cooldowns.coolingUntil('a:a-smart'), gw.clock.t + 60_000);
});

// ----- ordering -----

test('cooling providers are tried last, not skipped', async () => {
  a.respond({ status: 429, body: {} });
  gw = await startGateway({ fakes: [a, b] });
  await gw.chat(ask()); // a now cooling, b answered

  a.respond({ status: 200, body: okBody('a recovered') });
  b.respond({ status: 500, body: 'down' });
  const res = await gw.chat(ask()); // order is b (ready) then a (cooling)
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-llm-provider'), 'a');
  assert.equal(b.calls.length, 2);
});

test('when everything fails: 503 listing every attempt', async () => {
  a.respond({ status: 500, body: 'x' });
  b.respond({ status: 429, body: {} });
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask());
  assert.equal(res.status, 503);
  assert.equal(res.json.error.type, 'all_providers_failed');
  assert.deepEqual(res.json.error.attempts.map(x => [x.provider, x.kind]), [['a', 'server'], ['b', 'rate_limit']]);
});

test('when every provider rejects the request itself: 400', async () => {
  a.respond({ status: 400, body: { error: { message: 'bad' } } });
  b.respond({ status: 422, body: { error: { message: 'bad' } } });
  gw = await startGateway({ fakes: [a, b] });
  const res = await gw.chat(ask());
  assert.equal(res.status, 400);
});

test('round-robin rotates the starting provider', async () => {
  gw = await startGateway({ fakes: [a, b, c], strategy: 'round-robin' });
  const order = [];
  for (let i = 0; i < 4; i++) order.push((await gw.chat(ask())).headers.get('x-llm-provider'));
  assert.deepEqual(order, ['a', 'b', 'c', 'a']);
});

// ----- HTTP surface -----

test('gateway key is required on /v1, but not on /health', async () => {
  gw = await startGateway({ fakes: [a] });
  assert.equal((await gw.chat(ask(), { key: null })).status, 401);
  assert.equal((await gw.chat(ask(), { key: 'wrong' })).status, 401);
  assert.equal((await gw.chat(ask(), { key: GATEWAY_KEY })).status, 200);
  const health = await fetch(`${gw.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(a.calls.length, 1);
});

test('request validation', async () => {
  gw = await startGateway({ fakes: [a] });
  assert.equal((await gw.chat('{not json')).status, 400);
  assert.equal((await gw.chat({ messages: [{ role: 'user', content: 'x' }] })).status, 400);
  assert.equal((await gw.chat({ model: 'smart', messages: [] })).status, 400);
  const streaming = await gw.chat(ask({ stream: true }));
  assert.equal(streaming.status, 400);
  assert.match(streaming.json.error.message, /Streaming is not supported yet/);
  assert.equal(a.calls.length, 0);
});

test('unknown route is a 404', async () => {
  gw = await startGateway({ fakes: [a] });
  const res = await fetch(`${gw.url}/v1/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${GATEWAY_KEY}` } });
  assert.equal(res.status, 404);
});
