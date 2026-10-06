import http from 'node:http';
import { createServer } from '../src/server.js';
import { createRouter } from '../src/router.js';
import { Cooldowns } from '../src/cooldown.js';

export const GATEWAY_KEY = 'test-gateway-key';

export const okBody = (content, model = 'fake-model') => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

// A fake OpenAI-compatible provider. `respond` takes { status, headers, body } or { hang: true },
// or a function (requestBody, callNumber) returning one.
export async function startFakeProvider(name) {
  const calls = [];
  let responder = () => ({ status: 200, body: okBody(`hello from ${name}`) });

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ body, headers: req.headers, url: req.url });
    const reply = await responder(body, calls.length);
    if (reply.hang) return; // never answer, to trigger the gateway's timeout
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
  const port = await listen(server);

  return {
    name,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    respond(reply) {
      responder = typeof reply === 'function' ? reply : () => reply;
    },
    close: () => close(server),
  };
}

export function fakeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, advance: ms => { clock.t += ms; } };
  return clock;
}

// Starts the real gateway server in front of fake providers.
export async function startGateway({ fakes, strategy = 'priority', clock = fakeClock(), timeoutMs = 2_000, models } = {}) {
  const providers = fakes.map(f => ({
    name: f.name,
    baseUrl: f.baseUrl,
    key: `key-${f.name}`,
    models: models?.[f.name] ?? { smart: `${f.name}-smart` },
    timeoutMs,
  }));
  const cooldowns = new Cooldowns({ now: clock.now });
  const router = createRouter({ providers, strategy, cooldowns });
  const server = createServer({ gatewayKey: GATEWAY_KEY, router });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;

  async function chat(body, { key = GATEWAY_KEY } = {}) {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: await res.json() };
  }

  return { url, cooldowns, clock, router, chat, close: () => close(server) };
}

export const ask = (extra = {}) => ({ model: 'smart', messages: [{ role: 'user', content: 'hi' }], ...extra });
