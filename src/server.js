import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Cooldowns } from './cooldown.js';
import { createRouter, AllProvidersFailedError, UnknownModelError } from './router.js';
import { createLogger, silentLog } from './log.js';

const MAX_BODY_BYTES = 20 * 1024 * 1024; // room for base64 images

class HttpError extends Error {
  constructor(status, message, type) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// OpenAI-style error body, so OpenAI clients (including n8n) show the message.
function sendError(res, status, message, type, extra = {}) {
  sendJSON(res, status, { error: { message, type, ...extra } });
}

const digest = value => createHash('sha256').update(value).digest();

function isAuthorized(req, gatewayKey) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return Boolean(match) && timingSafeEqual(digest(match[1]), digest(gatewayKey));
}

async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large', 'invalid_request_error');
    chunks.push(chunk);
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes: size };
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'invalid_request_error');
  }
}

function validateChatBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object', 'invalid_request_error');
  }
  if (typeof body.model !== 'string' || !body.model) {
    throw new HttpError(400, '"model" is required (an alias such as "smart", or a model name)', 'invalid_request_error');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new HttpError(400, '"messages" must be a non-empty array', 'invalid_request_error');
  }
  if (body.stream) {
    throw new HttpError(400, 'Streaming is not supported yet; send "stream": false', 'invalid_request_error');
  }
}

// Sends an error the gateway decided on itself, and logs why.
function reject(res, rlog, status, message, type, extra = {}) {
  rlog.warn('request rejected', { status, reason: message });
  sendError(res, status, message, type, extra);
}

async function chatCompletions(req, res, router, rlog) {
  const { body, bytes } = await readJSON(req);
  rlog.info('body parsed', {
    model: body?.model, stream: body?.stream ?? false, messages: body?.messages?.length,
    tools: body?.tools?.length ?? 0, bytes,
  });
  validateChatBody(body);
  try {
    const result = await router.complete(body, rlog);
    sendJSON(res, 200, result.json, { 'x-llm-provider': result.provider, 'x-llm-model': result.model });
  } catch (err) {
    if (err instanceof UnknownModelError) return reject(res, rlog, 400, err.message, 'invalid_request_error', { code: 'model_not_found' });
    if (err instanceof AllProvidersFailedError) {
      return reject(res, rlog, err.status, err.message, 'all_providers_failed', { attempts: err.attempts });
    }
    throw err;
  }
}

export function createServer({ gatewayKey, router, log = silentLog }) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/health') return sendJSON(res, 200, { status: 'ok' });

    // One id per request, on every log line and in the x-request-id response header.
    const requestId = randomUUID().slice(0, 8);
    const rlog = log.child({ requestId });
    const started = Date.now();
    res.setHeader('x-request-id', requestId);
    rlog.info('request received', {
      method: req.method, path: pathname, userAgent: req.headers['user-agent'], contentLength: req.headers['content-length'],
    });
    res.on('finish', () => rlog.info('response sent', { status: res.statusCode, ms: Date.now() - started }));
    // The client gave up (Roo cancelled or timed out) before we answered.
    res.on('close', () => {
      if (!res.writableFinished) rlog.warn('client disconnected before response', { ms: Date.now() - started });
    });

    try {
      if (pathname.startsWith('/v1/') && !isAuthorized(req, gatewayKey)) {
        return reject(res, rlog, 401, 'Missing or invalid gateway API key', 'authentication_error');
      }
      if (req.method === 'POST' && pathname === '/v1/chat/completions') return await chatCompletions(req, res, router, rlog);

      reject(res, rlog, 404, `No route for ${req.method} ${pathname}`, 'not_found');
    } catch (err) {
      if (err instanceof HttpError) return reject(res, rlog, err.status, err.message, err.type);
      rlog.error('unhandled error', { error: err.stack });
      if (!res.headersSent) sendError(res, 500, 'Internal gateway error', 'internal_error');
      else res.end();
    }
  });
}

function main() {
  // LOG_FILE, if set, gets a copy of every log line (appended), alongside stdout.
  const logFile = process.env.LOG_FILE;
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  const log = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    write: line => {
      process.stdout.write(line + '\n');
      if (logFile) appendFileSync(logFile, line + '\n');
    },
  });
  const config = loadConfig();
  if (!config.providers.length) log.warn('no providers have API keys set; every request will fail', { skipped: config.skipped });

  const router = createRouter({ providers: config.providers, strategy: config.strategy, cooldowns: new Cooldowns(), log });
  const server = createServer({ gatewayKey: config.gatewayKey, router, log });
  server.listen(config.port, config.host, () => {
    log.info('llm-gateway listening', {
      host: config.host, port: config.port, strategy: config.strategy,
      providers: config.providers.map(p => p.name), skipped: config.skipped,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
