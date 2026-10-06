const DEFAULTS = {
  rateLimitBaseMs: 60_000,
  rateLimitMaxMs: 15 * 60_000,
  serverErrorMs: 30_000,
  // A Retry-After is honoured as given, but never beyond a day.
  retryAfterMaxMs: 24 * 60 * 60_000,
};

// Cooldowns are per "provider:model" (a rate-limited vision model shouldn't bench
// the same provider's text model). Disabling takes either a provider name (bad key: every
// model is broken) or a "provider:model" key (that model alone is forbidden).
export class Cooldowns {
  #entries = new Map();
  #disabled = new Map();

  constructor({ now = Date.now, ...options } = {}) {
    this.now = now;
    this.options = { ...DEFAULTS, ...options };
  }

  isCooling(key) {
    return this.coolingUntil(key) > this.now();
  }

  coolingUntil(key) {
    return this.#entries.get(key)?.until ?? 0;
  }

  // Returns the cooldown applied, in ms. Without Retry-After: 60s, 120s, 240s… capped at 15 min.
  rateLimited(key, retryAfterMs) {
    const entry = this.#entry(key);
    entry.strikes += 1;
    const { rateLimitBaseMs, rateLimitMaxMs, retryAfterMaxMs } = this.options;
    const ms = retryAfterMs != null
      ? Math.min(retryAfterMs, retryAfterMaxMs)
      : Math.min(rateLimitBaseMs * 2 ** (entry.strikes - 1), rateLimitMaxMs);
    entry.until = this.now() + ms;
    return ms;
  }

  serverError(key) {
    const ms = this.options.serverErrorMs;
    this.#entry(key).until = this.now() + ms;
    return ms;
  }

  success(key) {
    this.#entries.delete(key);
  }

  disable(provider, reason) {
    this.#disabled.set(provider, reason);
  }

  isDisabled(provider) {
    return this.#disabled.has(provider);
  }

  disabledReason(provider) {
    return this.#disabled.get(provider);
  }

  #entry(key) {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { until: 0, strikes: 0 };
      this.#entries.set(key, entry);
    }
    return entry;
  }
}
