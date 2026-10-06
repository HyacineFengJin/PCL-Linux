// A bounded JSON parser rejects duplicate keys before they can be overwritten.
// Error text deliberately excludes untrusted input and local file paths.
export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function fail(code, message) { throw new ContractError(code, message); }

export const MAX_MANIFEST_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function parseJson(source) {
  if (typeof source !== 'string') fail('JSON_TYPE', 'Manifest input must be UTF-8 JSON text.');
  if (!source.length || new TextEncoder().encode(source).length > MAX_MANIFEST_BYTES)
    fail('JSON_SIZE', 'Manifest must be nonempty and no larger than 64 KiB.');
  let cursor = 0, nodes = 0;
  const syntax = () => fail('JSON_SYNTAX', 'Manifest is not valid strict JSON.');
  const space = () => { while (/[\x20\t\r\n]/.test(source[cursor] ?? '\0')) cursor++; };
  function string() {
    const start = cursor++;
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === '\\') { cursor++; continue; }
      if (source[cursor] === '"') {
        cursor++;
        try { return JSON.parse(source.slice(start, cursor)); } catch { syntax(); }
      }
    }
    syntax();
  }
  function value(depth) {
    if (depth > 12 || ++nodes > 2048) fail('JSON_COMPLEXITY', 'Manifest nesting or item count exceeds limits.');
    space();
    const next = source[cursor];
    if (next === '"') return string();
    if (next === '{') {
      cursor++; space();
      const result = Object.create(null), seen = new Set();
      if (source[cursor] === '}') { cursor++; return result; }
      while (cursor < source.length) {
        space();
        if (source[cursor] !== '"') syntax();
        const key = string();
        if (seen.has(key)) fail('JSON_DUPLICATE_KEY', 'Duplicate object keys are forbidden.');
        if (FORBIDDEN_KEYS.has(key)) fail('JSON_FORBIDDEN_KEY', 'Reserved object keys are forbidden.');
        if (seen.size >= 64) fail('JSON_COMPLEXITY', 'Object property count exceeds limits.');
        seen.add(key); space();
        if (source[cursor++] !== ':') syntax();
        result[key] = value(depth + 1); space();
        if (source[cursor] === '}') { cursor++; return result; }
        if (source[cursor++] !== ',') syntax();
      }
      syntax();
    }
    if (next === '[') {
      cursor++; space();
      const result = [];
      if (source[cursor] === ']') { cursor++; return result; }
      while (cursor < source.length) {
        if (result.length >= 128) fail('JSON_COMPLEXITY', 'Array length exceeds limits.');
        result.push(value(depth + 1)); space();
        if (source[cursor] === ']') { cursor++; return result; }
        if (source[cursor++] !== ',') syntax();
      }
      syntax();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return result; }
    }
    const number = source.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      cursor += number[0].length;
      const result = Number(number[0]);
      if (!Number.isFinite(result)) fail('JSON_NUMBER', 'JSON numbers must be finite.');
      return result;
    }
    syntax();
  }
  const result = value(0);
  space();
  if (cursor !== source.length) syntax();
  return result;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
