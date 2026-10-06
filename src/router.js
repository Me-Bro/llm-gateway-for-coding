import { callProvider, ProviderError } from './provider.js';
import { silentLog } from './log.js';

export class UnknownModelError extends Error {
  constructor(model) {
    super(`No configured provider offers model "${model}"`);
    this.name = 'UnknownModelError';
  }
}

export class AllProvidersFailedError extends Error {
  constructor(attempts, message) {
    super(message ?? (attempts.length
      ? `All providers failed: ${attempts.map(a => `${a.provider}: ${a.message}`).join(' | ')}`
      : 'No providers available: every provider for this model is disabled'));
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
  }

  // If every provider rejected the request itself, it's the caller's problem, not an outage.
  get status() {
    return this.attempts.length && this.attempts.every(a => a.kind === 'request') ? 400 : 503;
  }
}

const cooldownKey = c => `${c.provider.name}:${c.model}`;

export function createRouter({ providers, strategy = 'priority', cooldowns, call = callProvider, log = silentLog }) {
  let turn = 0;

  // An alias resolves to the provider's own model; a real model name goes only to providers that list it.
  function resolveModel(provider, requested) {
    if (Object.hasOwn(provider.models, requested)) return provider.models[requested];
    if (Object.values(provider.models).includes(requested)) return requested;
    return null;
  }

  // Ready candidates first, then cooling ones (better a retry than a failure). Disabled ones are skipped.
  function plan(requested) {
    if (!providers.length) {
      throw new AllProvidersFailedError([], 'No providers configured: set at least one provider API key in .env');
    }
    let candidates = providers
      .map(provider => ({ provider, model: resolveModel(provider, requested) }))
      .filter(c => c.model);
    if (!candidates.length) throw new UnknownModelError(requested);

    if (strategy === 'round-robin') {
      const start = turn++ % candidates.length;
      candidates = [...candidates.slice(start), ...candidates.slice(0, start)];
    }

    const usable = candidates.filter(c => !cooldowns.isDisabled(c.provider.name) && !cooldowns.isDisabled(cooldownKey(c)));
    return [
      ...usable.filter(c => !cooldowns.isCooling(cooldownKey(c))),
      ...usable.filter(c => cooldowns.isCooling(cooldownKey(c))),
    ];
  }

  function applyFailure(candidate, err) {
    const key = cooldownKey(candidate);
    switch (err.kind) {
      case 'rate_limit': return { cooldownMs: cooldowns.rateLimited(key, err.retryAfterMs) };
      case 'server': return { cooldownMs: cooldowns.serverError(key) };
      // 401 means the key is bad: every model is affected. 403 can be model-specific
      // (OpenRouter uses it for restricted models), so only that model is disabled.
      case 'auth':
        if (err.status === 403) {
          cooldowns.disable(key, err.message);
          return { disabled: key };
        }
        cooldowns.disable(candidate.provider.name, err.message);
        return { disabled: candidate.provider.name };
      default: return {}; // 'request' and 'bad_json': about this request, not the provider
    }
  }

  // `reqLog` carries the request id; defaults to the router's own logger.
  async function complete(body, reqLog = log) {
    const attempts = [];
    const candidates = plan(body.model);
    const disabled = providers
      .map(provider => ({ provider, model: resolveModel(provider, body.model) }))
      .filter(c => c.model && (cooldowns.isDisabled(c.provider.name) || cooldowns.isDisabled(cooldownKey(c))))
      .map(c => c.provider.name);
    reqLog.info('routing', {
      model: body.model,
      order: candidates.map(c => c.provider.name + (cooldowns.isCooling(cooldownKey(c)) ? ' (cooling)' : '')),
      disabled,
    });
    for (const [i, candidate] of candidates.entries()) {
      const { provider, model } = candidate;
      const started = Date.now();
      reqLog.info('llm attempt', { attempt: i + 1, of: candidates.length, provider: provider.name, model, timeoutMs: provider.timeoutMs });
      try {
        const json = await call(provider, model, body);
        cooldowns.success(cooldownKey(candidate));
        reqLog.info('llm ok', {
          provider: provider.name, model, ms: Date.now() - started,
          finish: json.choices?.[0]?.finish_reason, toolCalls: json.choices?.[0]?.message?.tool_calls?.length ?? 0,
          promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens,
        });
        return { provider: provider.name, model, json };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        const effect = applyFailure(candidate, err);
        attempts.push({ provider: provider.name, model, kind: err.kind, status: err.status, message: err.message });
        reqLog.warn('llm provider failed', {
          provider: provider.name, model, ms: Date.now() - started, kind: err.kind, status: err.status, error: err.message, ...effect,
        });
      }
    }
    reqLog.error('llm all providers failed', { model: body.model, attempts: attempts.length });
    throw new AllProvidersFailedError(attempts);
  }

  return { complete, plan };
}
