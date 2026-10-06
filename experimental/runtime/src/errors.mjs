export class RuntimeError extends Error {
  constructor(code, message) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
export function check(condition, code, message) {
  if (!condition) throw new RuntimeError(code, message);
}
export function abortError() { return new RuntimeError('CANCELLED', 'Job was cancelled'); }
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
export function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { finish(); reject(abortError()); };
    const timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
export function cloneJson(value, { maxBytes = 2_000_000, code = 'INVALID_JSON' } = {}) {
  const text = JSON.stringify(value);
  check(text !== undefined && Buffer.byteLength(text) <= maxBytes, code, `Expected JSON data no larger than ${maxBytes} bytes`);
  return JSON.parse(text);
}
