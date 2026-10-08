import { TomlError } from './error.ts';
import { resolveMaxDepth } from './parse.ts';
import type { StringifyOptions } from './types.ts';

type PlainObject = Record<string, unknown>;

/**
 * Convert an object to a TOML string.
 * - Supports strings, numbers, bigint, booleans, Date, arrays, and nested objects
 * - A non-empty array whose elements are all objects is written as an [[array of tables]]
 * - Properties set to undefined are omitted. null, functions, Symbol, etc. are errors
 */
export function stringify(value: unknown, options: StringifyOptions = {}): string {
  if (!isPlainObject(value)) {
    throw new TypeError('stringify expects a plain object');
  }
  return new Serializer(resolveMaxDepth(options.maxDepth)).document(value);
}

function isPlainObject(v: unknown): v is PlainObject {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isTableArray(v: unknown): v is PlainObject[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  // every() skips holes in sparse arrays, so check every element by index
  for (let i = 0; i < v.length; i++) if (!isPlainObject(v[i])) return false;
  return true;
}

function isBareKey(key: string): boolean {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d;
    if (!ok) return false;
  }
  return true;
}

function formatKey(key: string): string {
  return isBareKey(key) ? key : formatString(key);
}

function formatString(s: string): string {
  let out = '"';
  let chunk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | null = null;
    switch (c) {
      case 0x22: esc = '\\"'; break;
      case 0x5c: esc = '\\\\'; break;
      case 0x08: esc = '\\b'; break;
      case 0x09: esc = '\\t'; break;
      case 0x0a: esc = '\\n'; break;
      case 0x0c: esc = '\\f'; break;
      case 0x0d: esc = '\\r'; break;
      default:
        if (c < 0x20 || c === 0x7f) esc = '\\u' + c.toString(16).padStart(4, '0');
    }
    if (esc !== null) {
      out += s.slice(chunk, i) + esc;
      chunk = i + 1;
    }
  }
  return out + s.slice(chunk) + '"';
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  // An integer 0 loses the sign, so write negative zero as a float
  if (Object.is(n, -0)) return '-0.0';
  // Write large integers that cannot be read back as 64-bit integers in float notation
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return n.toExponential();
  return String(n);
}

class Serializer {
  private readonly maxDepth: number;
  /** For detecting circular references */
  private readonly stack = new Set<object>();
  private readonly lines: string[] = [];

  constructor(maxDepth: number) {
    this.maxDepth = maxDepth;
  }

  document(root: PlainObject): string {
    this.table(root, [], 0);
    return this.lines.length > 0 ? this.lines.join('\n') + '\n' : '';
  }

  private enter(obj: object, depth: number): void {
    if (depth > this.maxDepth) throw new TomlError(`Nesting is too deep (max depth ${this.maxDepth})`);
    if (this.stack.has(obj)) throw new TomlError('Cannot stringify a circular structure');
    this.stack.add(obj);
  }

  private header(text: string): void {
    if (this.lines.length > 0) this.lines.push('');
    this.lines.push(text);
  }

  /** Write the contents of a table. The caller writes the header */
  private table(obj: PlainObject, path: string[], depth: number): void {
    this.enter(obj, depth);
    const tables: [string, PlainObject][] = [];
    const tableArrays: [string, PlainObject[]][] = [];
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === undefined) continue;
      if (isPlainObject(v)) {
        tables.push([key, v]);
      } else if (isTableArray(v)) {
        tableArrays.push([key, v]);
      } else {
        this.lines.push(`${formatKey(key)} = ${this.value(v, depth + 1)}`);
      }
    }
    for (const [key, sub] of tables) {
      const p = [...path, formatKey(key)];
      // Omit the header for tables with no direct values (only sub-tables)
      if (!hasOnlySubtables(sub)) this.header(`[${p.join('.')}]`);
      this.table(sub, p, depth + 1);
    }
    for (const [key, arr] of tableArrays) {
      const p = [...path, formatKey(key)];
      this.enter(arr, depth + 1);
      for (const elem of arr) {
        this.header(`[[${p.join('.')}]]`);
        this.table(elem, p, depth + 2);
      }
      this.stack.delete(arr);
    }
    this.stack.delete(obj);
  }

  /** A value that can be written inline */
  private value(v: unknown, depth: number): string {
    switch (typeof v) {
      case 'string':
        return formatString(v);
      case 'number':
        return formatNumber(v);
      case 'bigint':
        if (v > 0x7fffffffffffffffn || v < -0x8000000000000000n) {
          throw new TomlError('BigInt is out of 64-bit range');
        }
        return v.toString();
      case 'boolean':
        return v ? 'true' : 'false';
    }
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) throw new TomlError('Invalid Date cannot be stringified');
      // TOML dates only allow 4-digit years. Outside that range toISOString() returns +010000-… or -000001-…, which cannot be read back
      const year = v.getUTCFullYear();
      if (year < 0 || year > 9999) throw new TomlError(`Date year ${year} is out of range (0000-9999)`);
      return v.toISOString();
    }
    if (Array.isArray(v)) {
      this.enter(v, depth);
      // map() skips holes in sparse arrays, so iterate by index and detect holes as undefined
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const item: unknown = v[i];
        if (item === undefined) throw new TomlError('Array cannot contain undefined or empty slots');
        items.push(this.value(item, depth + 1));
      }
      this.stack.delete(v);
      return `[${items.join(', ')}]`;
    }
    if (isPlainObject(v)) {
      this.enter(v, depth);
      const items: string[] = [];
      for (const key of Object.keys(v)) {
        const item = v[key];
        if (item === undefined) continue;
        items.push(`${formatKey(key)} = ${this.value(item, depth + 1)}`);
      }
      this.stack.delete(v);
      return items.length > 0 ? `{ ${items.join(', ')} }` : '{}';
    }
    const kind = v === null ? 'null' : typeof v === 'object' ? (v.constructor?.name ?? 'object') : typeof v;
    throw new TomlError(`Cannot stringify a value of type ${kind}`);
  }
}

/** Whether the table is non-empty and holds only sub-tables (or arrays of tables) */
function hasOnlySubtables(obj: PlainObject): boolean {
  let count = 0;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === undefined) continue;
    if (!isPlainObject(v) && !isTableArray(v)) return false;
    count++;
  }
  return count > 0;
}
