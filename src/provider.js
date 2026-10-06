// One adapter for every OpenAI-compatible provider.

// kind: 'rate_limit' | 'server' | 'auth' | 'request' | 'bad_json' (see the failure table in the plan)
export class ProviderError extends Error {
  constructor(kind, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function classifyStatus(status) {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  return 'request';
}

// Retry-After is either delay-seconds or an HTTP date.
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// Models sometimes wrap JSON in ```json fences or add chatter. Returns the JSON text, or undefined.
export function extractJSON(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function wantsJSON(body) {
  return ['json_object', 'json_schema'].includes(body.response_format?.type);
}

export async function callProvider(provider, model, body, { fetchImpl = fetch, now = Date.now } = {}) {
  let res;
  let text;
  try {
    res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(provider.timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    const reason = err.name === 'TimeoutError'
      ? `timed out after ${provider.timeoutMs}ms`
      : err.cause?.code ?? err.message;
    throw new ProviderError('server', reason);
  }

  if (!res.ok) {
    throw new ProviderError(classifyStatus(res.status), `HTTP ${res.status}: ${text.slice(0, 300)}`, {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), now()),
    });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError('server', `response body is not JSON: ${text.slice(0, 200)}`);
  }

  // Some providers (e.g. OpenRouter) report upstream failures as HTTP 200 with an error object.
  if (json.error) {
    const code = Number(json.error.code);
    const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : undefined;
    throw new ProviderError(status ? classifyStatus(status) : 'server', `error in 200 response: ${JSON.stringify(json.error).slice(0, 300)}`, { status });
  }

  const message = json.choices?.[0]?.message;
  if (!message) throw new ProviderError('server', 'response has no choices[0].message');

  if (wantsJSON(body)) {
    const extracted = extractJSON(message.content);
    if (extracted === undefined) {
      throw new ProviderError('bad_json', `asked for JSON but got: ${String(message.content).slice(0, 200)}`);
    }
    message.content = extracted;
  }

  return json;
}
