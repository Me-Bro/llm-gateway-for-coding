// JSON-lines logger. Never pass API keys or prompt content in `fields`.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// `child(fields)` returns a logger that adds `fields` (e.g. a request id) to every line.
export function createLogger({ level = 'info', write = line => process.stdout.write(line + '\n'), base = {} } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = lvl => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, ...base, msg, ...fields }));
  };
  return {
    debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'),
    child: fields => createLogger({ level, write, base: { ...base, ...fields } }),
  };
}

export const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLog };
