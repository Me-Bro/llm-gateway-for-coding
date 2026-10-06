import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STRATEGIES = ['priority', 'round-robin'];
const DEFAULT_TIMEOUT_MS = 30_000;

export function loadConfig({ env = process.env, file } = {}) {
  const path = file ?? env.PROVIDERS_FILE ?? fileURLToPath(new URL('../providers.json', import.meta.url));
  return buildConfig(JSON.parse(readFileSync(path, 'utf8')), env);
}

// Validates every provider entry, then keeps only those whose API key is set.
export function buildConfig(raw, env) {
  if (!env.GATEWAY_API_KEY) throw new Error('GATEWAY_API_KEY is not set');

  const strategy = raw.strategy ?? 'priority';
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`strategy must be one of ${STRATEGIES.join(', ')}, got "${strategy}"`);
  }
  if (!Array.isArray(raw.providers)) throw new Error('"providers" must be an array');

  const seen = new Set();
  for (const p of raw.providers) {
    for (const field of ['name', 'baseUrl', 'keyEnv']) {
      if (typeof p[field] !== 'string' || !p[field]) {
        throw new Error(`provider ${JSON.stringify(p.name ?? p)}: "${field}" must be a non-empty string`);
      }
    }
    if (seen.has(p.name)) throw new Error(`duplicate provider name "${p.name}"`);
    seen.add(p.name);
    const models = p.models ?? {};
    if (typeof models !== 'object' || Array.isArray(models) || Object.values(models).some(m => typeof m !== 'string')) {
      throw new Error(`provider "${p.name}": "models" must map alias names to model name strings`);
    }
    if (p.timeoutMs !== undefined && !(Number.isInteger(p.timeoutMs) && p.timeoutMs > 0)) {
      throw new Error(`provider "${p.name}": "timeoutMs" must be a positive integer`);
    }
  }

  const providers = raw.providers
    .filter(p => env[p.keyEnv])
    .map(p => ({
      name: p.name,
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      key: env[p.keyEnv],
      models: { ...p.models },
      timeoutMs: p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }));

  return {
    strategy,
    gatewayKey: env.GATEWAY_API_KEY,
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 18181),
    providers,
    skipped: raw.providers.filter(p => !env[p.keyEnv]).map(p => p.name),
  };
}
