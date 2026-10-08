import { TomlError } from './error.ts';
import type { ParseOptions, TomlArray, TomlTable, TomlValue } from './types.ts';

/*
 * Design (DoS protection)
 * - The input is scanned once from start to end. Nothing re-reads the input behind the current position.
 * - No regular expressions; characters are checked by character code.
 * - Nesting of arrays, inline tables, and keys is cut off at maxDepth, so recursion never exhausts the stack.
 * - Line numbers are counted once, only when an error occurs (zero cost on success).
 */

export const DEFAULT_MAX_DEPTH = 100;

/**
 * Validate the maxDepth option. Allowing NaN or Infinity would make the depth comparison always false,
 * disabling the limit and exhausting the stack, so only finite non-negative integers are accepted.
 */
export function resolveMaxDepth(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_DEPTH;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`maxDepth must be a finite non-negative integer: ${String(value)}`);
  }
  return value;
}

// How a table was created. Used to decide whether it may be redefined or extended.
const IMPLICIT = 1; // Created implicitly along a header path, like `a` in [a.b]
const EXPLICIT = 2; // Defined by [a]
const DOTTED = 3; // Created by a dotted key such as a.b = 1
const INLINE = 4; // Inline table (cannot be extended later)
const AOT_ELEMENT = 5; // Element of [[a]]
type TableKind = typeof IMPLICIT | typeof EXPLICIT | typeof DOTTED | typeof INLINE | typeof AOT_ELEMENT;

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_DQUOTE = 0x22;
const CH_HASH = 0x23;
const CH_SQUOTE = 0x27;
const CH_PLUS = 0x2b;
const CH_COMMA = 0x2c;
const CH_MINUS = 0x2d;
const CH_DOT = 0x2e;
const CH_COLON = 0x3a;
const CH_EQUAL = 0x3d;
const CH_LBRACKET = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACKET = 0x5d;
const CH_UNDERSCORE = 0x5f;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;

const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;
/** Maximum number of digits needed for a 64-bit integer, per radix */
const MAX_INT64_DIGITS: Record<number, number> = { 2: 64, 8: 22, 10: 19, 16: 16 };

/** Parse a TOML string and return an object */
export function parse(src: string, options: ParseOptions = {}): TomlTable {
  if (typeof src !== 'string') {
    throw new TypeError('TOML source must be a string');
  }
  return new Parser(src, options).parseDocument();
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function isBareKeyChar(c: number): boolean {
  return (
    isDigit(c) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === CH_UNDERSCORE ||
    c === CH_MINUS
  );
}

/** Characters that can appear in a number or date-time token */
function isTokenChar(c: number): boolean {
  return isBareKeyChar(c) || c === CH_PLUS || c === CH_DOT || c === CH_COLON;
}

/** Control characters other than tab (forbidden in strings and comments) */
function isForbiddenControl(c: number): boolean {
  return (c < 0x20 && c !== CH_TAB) || c === 0x7f;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

class Parser {
  private readonly src: string;
  private readonly len: number;
  private readonly maxDepth: number;
  private pos = 0;
  /** Current nesting depth */
  private depth = 0;
  /** How each table was created */
  private readonly kinds = new WeakMap<TomlTable, TableKind>();
  /** Arrays created by [[...]] (no other arrays can be appended to) */
  private readonly tableArrays = new WeakSet<TomlArray>();
  /** Tables created inside the inline table being parsed (marked INLINE when it closes) */
  private inlineCreated: TomlTable[] | null = null;

  constructor(src: string, options: ParseOptions) {
    this.src = src;
    this.len = src.length;
    this.maxDepth = resolveMaxDepth(options.maxDepth);
  }

  // ---- Errors and basic operations ----

  private error(message: string, pos = this.pos): TomlError {
    return TomlError.at(this.src, pos, message);
  }

  private code(pos = this.pos): number {
    return pos < this.len ? this.src.charCodeAt(pos) : -1;
  }

  private enterDepth(amount: number, pos = this.pos): void {
    this.depth += amount;
    if (this.depth > this.maxDepth) {
      throw this.error(`Nesting is too deep (max depth ${this.maxDepth})`, pos);
    }
  }

  private skipWhitespace(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c !== CH_SPACE && c !== CH_TAB) break;
      this.pos++;
    }
  }

  /** Skip a newline (LF / CRLF) and return true if present. A bare CR is an error */
  private skipNewline(): boolean {
    const c = this.code();
    if (c === CH_LF) {
      this.pos++;
      return true;
    }
    if (c === CH_CR) {
      if (this.code(this.pos + 1) !== CH_LF) throw this.error('Bare carriage return is not allowed');
      this.pos += 2;
      return true;
    }
    return false;
  }

  /** Skip from # to the end of the line (the newline itself is not consumed) */
  private skipComment(): void {
    if (this.code() !== CH_HASH) return;
    this.pos++;
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c === CH_LF) return;
      if (c === CH_CR && this.code(this.pos + 1) === CH_LF) return;
      if (isForbiddenControl(c)) throw this.error('Control character is not allowed in comment');
      this.pos++;
    }
  }

  /** Skip whitespace, newlines, and comments */
  private skipBlank(): void {
    for (;;) {
      this.skipWhitespace();
      this.skipComment();
      if (!this.skipNewline()) return;
    }
  }

  /** Require the end of a line (newline or EOF after whitespace and comments) */
  private expectLineEnd(): void {
    this.skipWhitespace();
    this.skipComment();
    if (this.pos >= this.len) return;
    if (!this.skipNewline()) throw this.error('Expected end of line');
  }

  // ---- Table operations ----

  private newTable(kind: TableKind): TomlTable {
    const table: TomlTable = {};
    this.kinds.set(table, kind);
    if (this.inlineCreated) this.inlineCreated.push(table);
    return table;
  }

  private isTable(v: TomlValue | undefined): v is TomlTable {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && this.kinds.has(v);
  }

  /** Set as an own property without touching the prototype, even for keys like "__proto__" */
  private static define(table: TomlTable, key: string, value: TomlValue): void {
    if (key === '__proto__') {
      Object.defineProperty(table, key, { value, writable: true, enumerable: true, configurable: true });
    } else {
      table[key] = value;
    }
  }

  private static get(table: TomlTable, key: string): TomlValue | undefined {
    return Object.hasOwn(table, key) ? table[key] : undefined;
  }

  /** One step while walking the keys of a header */
  private descendHeader(table: TomlTable, key: string, pos: number): TomlTable {
    const v = Parser.get(table, key);
    if (v === undefined) {
      const t = this.newTable(IMPLICIT);
      Parser.define(table, key, t);
      return t;
    }
    if (Array.isArray(v) && this.tableArrays.has(v)) {
      // Entering an array element, so the array adds one more level on top of the table
      this.enterDepth(1, pos);
      return v[v.length - 1] as TomlTable;
    }
    if (this.isTable(v) && this.kinds.get(v) !== INLINE) return v;
    throw this.error(`Key "${key}" is already defined as a non-table value`, pos);
  }

  /** [a.b.c] */
  private openTable(root: TomlTable, keys: string[], pos: number): TomlTable {
    let t = root;
    for (let i = 0; i < keys.length - 1; i++) t = this.descendHeader(t, keys[i]!, pos);
    const last = keys[keys.length - 1]!;
    const v = Parser.get(t, last);
    if (v === undefined) {
      const nt = this.newTable(EXPLICIT);
      Parser.define(t, last, nt);
      return nt;
    }
    if (this.isTable(v) && this.kinds.get(v) === IMPLICIT) {
      this.kinds.set(v, EXPLICIT);
      return v;
    }
    throw this.error(`Table "${keys.join('.')}" is already defined`, pos);
  }

  /** [[a.b.c]] */
  private openArrayTable(root: TomlTable, keys: string[], pos: number): TomlTable {
    let t = root;
    for (let i = 0; i < keys.length - 1; i++) t = this.descendHeader(t, keys[i]!, pos);
    const last = keys[keys.length - 1]!;
    let arr = Parser.get(t, last);
    if (arr === undefined) {
      arr = [];
      this.tableArrays.add(arr);
      Parser.define(t, last, arr);
    } else if (!Array.isArray(arr) || !this.tableArrays.has(arr)) {
      throw this.error(`Key "${keys.join('.')}" is already defined and is not an array of tables`, pos);
    }
    const elem = this.newTable(AOT_ELEMENT);
    arr.push(elem);
    return elem;
  }

  // ---- Document ----

  parseDocument(): TomlTable {
    const root = this.newTable(EXPLICIT);
    let current = root;
    if (this.code() === 0xfeff) this.pos++; // BOM
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.len) break;
      const start = this.pos;
      if (this.code() === CH_LBRACKET) {
        const isArray = this.code(this.pos + 1) === CH_LBRACKET;
        this.pos += isArray ? 2 : 1;
        this.skipWhitespace();
        const keys = this.parseKey();
        this.skipWhitespace();
        if (this.code() !== CH_RBRACKET || (isArray && this.code(this.pos + 1) !== CH_RBRACKET)) {
          throw this.error(isArray ? 'Expected "]]"' : 'Expected "]"');
        }
        this.pos += isArray ? 2 : 1;
        // Header depth = number of keys (+1 for the array itself with [[ ]]).
        // Arrays of tables traversed along the way are added in descendHeader
        this.depth = 0;
        this.enterDepth(keys.length + (isArray ? 1 : 0), start);
        current = isArray ? this.openArrayTable(root, keys, start) : this.openTable(root, keys, start);
      } else {
        this.parseKeyValue(current);
      }
      this.expectLineEnd();
    }
    return root;
  }

  // ---- Keys ----

  private parseKey(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipWhitespace();
      keys.push(this.parseSimpleKey());
      // n keys means n - 1 tables. The exact check happens when handling the value or header; this is just an early cutoff
      if (keys.length > this.maxDepth + 1) {
        throw this.error(`Dotted key is too deep (max depth ${this.maxDepth})`);
      }
      this.skipWhitespace();
      if (this.code() !== CH_DOT) return keys;
      this.pos++;
    }
  }

  private parseSimpleKey(): string {
    const c = this.code();
    if (c === CH_DQUOTE) {
      if (this.src.startsWith('"""', this.pos)) throw this.error('Multi-line string cannot be used as a key');
      return this.parseBasicString();
    }
    if (c === CH_SQUOTE) {
      if (this.src.startsWith("'''", this.pos)) throw this.error('Multi-line string cannot be used as a key');
      return this.parseLiteralString();
    }
    const start = this.pos;
    while (this.pos < this.len && isBareKeyChar(this.src.charCodeAt(this.pos))) this.pos++;
    if (this.pos === start) throw this.error(this.pos >= this.len ? 'Expected a key' : 'Invalid character in key');
    return this.src.slice(start, this.pos);
  }

  /** Read key = value and set it on table */
  private parseKeyValue(table: TomlTable): void {
    const start = this.pos;
    const keys = this.parseKey();
    this.skipWhitespace();
    if (this.code() !== CH_EQUAL) throw this.error('Expected "=" after key');
    this.pos++;
    this.skipWhitespace();

    let t = table;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      const v = Parser.get(t, k);
      if (v === undefined) {
        const nt = this.newTable(DOTTED);
        Parser.define(t, k, nt);
        t = nt;
      } else if (this.isTable(v) && this.kinds.get(v) === DOTTED) {
        t = v;
      } else {
        throw this.error(`Cannot add keys to "${keys.slice(0, i + 1).join('.')}"`, start);
      }
    }
    const last = keys[keys.length - 1]!;
    if (Parser.get(t, last) !== undefined) {
      throw this.error(`Duplicate key "${keys.join('.')}"`, start);
    }

    // Intermediate tables of a dotted key add depth. If the value is an array or table, it adds one more level itself
    const savedDepth = this.depth;
    this.enterDepth(keys.length - 1, start);
    const value = this.parseValue();
    this.depth = savedDepth;
    Parser.define(t, last, value);
  }

  // ---- Values ----

  private parseValue(): TomlValue {
    const c = this.code();
    switch (c) {
      case CH_DQUOTE:
        return this.src.startsWith('"""', this.pos) ? this.parseMultilineBasicString() : this.parseBasicString();
      case CH_SQUOTE:
        return this.src.startsWith("'''", this.pos) ? this.parseMultilineLiteralString() : this.parseLiteralString();
      case CH_LBRACKET:
        return this.parseArray();
      case CH_LBRACE:
        return this.parseInlineTable();
      case 0x74: // t
        return this.parseKeyword('true', true);
      case 0x66: // f
        return this.parseKeyword('false', false);
      case -1:
        throw this.error('Expected a value but reached end of input');
      default:
        if (isDigit(c) || c === CH_PLUS || c === CH_MINUS || c === 0x69 /* i */ || c === 0x6e /* n */) {
          return this.parseNumberOrDate();
        }
        throw this.error('Invalid value');
    }
  }

  private parseKeyword(word: string, value: boolean): boolean {
    if (!this.src.startsWith(word, this.pos) || isBareKeyChar(this.code(this.pos + word.length))) {
      throw this.error('Invalid value');
    }
    this.pos += word.length;
    return value;
  }

  private parseArray(): TomlArray {
    this.enterDepth(1);
    this.pos++; // [
    const arr: TomlArray = [];
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.len) throw this.error('Unterminated array');
      if (this.code() === CH_RBRACKET) break;
      arr.push(this.parseValue());
      this.skipBlank();
      const c = this.code();
      if (c === CH_COMMA) {
        this.pos++;
        continue;
      }
      if (c === CH_RBRACKET) break;
      throw this.error(c === -1 ? 'Unterminated array' : 'Expected "," or "]" in array');
    }
    this.pos++; // ]
    this.depth--;
    return arr;
  }

  private parseInlineTable(): TomlTable {
    this.enterDepth(1);
    this.pos++; // {
    const savedCreated = this.inlineCreated;
    this.inlineCreated = [];
    // Treat as DOTTED until closed so that dotted keys can build its contents
    const table = this.newTable(DOTTED);
    this.skipWhitespace();
    if (this.code() === CH_RBRACE) {
      this.pos++;
    } else {
      for (;;) {
        this.skipWhitespace();
        this.parseKeyValue(table);
        this.skipWhitespace();
        const c = this.code();
        if (c === CH_COMMA) {
          this.pos++;
          continue;
        }
        if (c === CH_RBRACE) {
          this.pos++;
          break;
        }
        throw this.error(c === -1 ? 'Unterminated inline table' : 'Expected "," or "}" in inline table');
      }
    }
    for (const t of this.inlineCreated) this.kinds.set(t, INLINE);
    this.inlineCreated = savedCreated;
    this.depth--;
    return table;
  }

  // ---- Strings ----

  /** "..." */
  private parseBasicString(): string {
    this.pos++; // "
    let out = '';
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= this.len) throw this.error('Unterminated string');
      const c = this.src.charCodeAt(this.pos);
      if (c === CH_DQUOTE) {
        out += this.src.slice(chunk, this.pos);
        this.pos++;
        return out;
      }
      if (c === CH_BACKSLASH) {
        out += this.src.slice(chunk, this.pos);
        out += this.parseEscape();
        chunk = this.pos;
        continue;
      }
      if (c === CH_LF || c === CH_CR) throw this.error('Newline is not allowed in a single-line string');
      if (isForbiddenControl(c)) throw this.error('Control character must be escaped in a string');
      this.pos++;
    }
  }

  /** '...' */
  private parseLiteralString(): string {
    this.pos++; // '
    const start = this.pos;
    for (;;) {
      if (this.pos >= this.len) throw this.error('Unterminated string');
      const c = this.src.charCodeAt(this.pos);
      if (c === CH_SQUOTE) {
        this.pos++;
        return this.src.slice(start, this.pos - 1);
      }
      if (c === CH_LF || c === CH_CR) throw this.error('Newline is not allowed in a single-line string');
      if (isForbiddenControl(c)) throw this.error('Control character is not allowed in a literal string');
      this.pos++;
    }
  }

  /**
   * Detect the closing quotes of a multi-line string.
   * Counts the run of quotes: fewer than 3 is content, 3-5 closes the string (extras are content), 6 or more is an error.
   * Returns the number of quotes to include in the content (-1 if the string is not closed).
   */
  private scanQuoteRun(quote: number): number {
    let n = 0;
    while (this.code(this.pos + n) === quote) n++;
    if (n < 3) {
      this.pos += n;
      return -1;
    }
    if (n > 5) throw this.error('Too many quotes at the end of a multi-line string', this.pos + 5);
    this.pos += n;
    return n - 3;
  }

  /** """...""" */
  private parseMultilineBasicString(): string {
    this.pos += 3;
    this.skipNewline(); // Trim a newline immediately after the opening delimiter
    let out = '';
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= this.len) throw this.error('Unterminated multi-line string');
      const c = this.src.charCodeAt(this.pos);
      if (c === CH_DQUOTE) {
        const end = this.pos;
        const extra = this.scanQuoteRun(CH_DQUOTE);
        if (extra >= 0) return out + this.src.slice(chunk, end) + '"'.repeat(extra);
        continue;
      }
      if (c === CH_BACKSLASH) {
        out += this.src.slice(chunk, this.pos);
        // Line-ending backslash: trim all following whitespace and newlines
        let j = this.pos + 1;
        while (this.code(j) === CH_SPACE || this.code(j) === CH_TAB) j++;
        const nc = this.code(j);
        if (nc === CH_LF || nc === CH_CR) {
          this.pos = j;
          for (;;) {
            this.skipWhitespace();
            if (!this.skipNewline()) break;
          }
        } else {
          out += this.parseEscape();
        }
        chunk = this.pos;
        continue;
      }
      if (c === CH_LF) {
        this.pos++;
        continue;
      }
      if (c === CH_CR) {
        this.skipNewline();
        continue;
      }
      if (isForbiddenControl(c)) throw this.error('Control character must be escaped in a string');
      this.pos++;
    }
  }

  /** '''...''' */
  private parseMultilineLiteralString(): string {
    this.pos += 3;
    this.skipNewline(); // Trim a newline immediately after the opening delimiter
    const start = this.pos;
    for (;;) {
      if (this.pos >= this.len) throw this.error('Unterminated multi-line string');
      const c = this.src.charCodeAt(this.pos);
      if (c === CH_SQUOTE) {
        const end = this.pos;
        const extra = this.scanQuoteRun(CH_SQUOTE);
        if (extra >= 0) return this.src.slice(start, end) + "'".repeat(extra);
        continue;
      }
      if (c === CH_LF) {
        this.pos++;
        continue;
      }
      if (c === CH_CR) {
        this.skipNewline();
        continue;
      }
      if (isForbiddenControl(c)) throw this.error('Control character is not allowed in a literal string');
      this.pos++;
    }
  }

  /** Read one escape sequence starting at a backslash */
  private parseEscape(): string {
    const start = this.pos;
    this.pos++; // \
    const c = this.code();
    this.pos++;
    switch (c) {
      case 0x62: return '\b'; // b
      case 0x74: return '\t'; // t
      case 0x6e: return '\n'; // n
      case 0x66: return '\f'; // f
      case 0x72: return '\r'; // r
      case 0x65: return '\x1b'; // e (TOML 1.1)
      case CH_DQUOTE: return '"';
      case CH_BACKSLASH: return '\\';
      case 0x75: return this.parseUnicodeEscape(4, start); // u
      case 0x55: return this.parseUnicodeEscape(8, start); // U
      default:
        throw this.error('Invalid escape sequence', start);
    }
  }

  private parseUnicodeEscape(digits: number, start: number): string {
    let cp = 0;
    for (let i = 0; i < digits; i++) {
      const c = this.code();
      if (!isHexDigit(c)) throw this.error('Invalid unicode escape', start);
      cp = cp * 16 + parseInt(String.fromCharCode(c), 16);
      this.pos++;
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw this.error('Unicode escape is not a valid scalar value', start);
    }
    return String.fromCodePoint(cp);
  }

  // ---- Numbers and date-times ----

  private parseNumberOrDate(): TomlValue {
    const start = this.pos;
    while (this.pos < this.len && isTokenChar(this.src.charCodeAt(this.pos))) this.pos++;
    const s = this.src;
    const isDate =
      this.pos - start >= 5 &&
      isDigit(s.charCodeAt(start)) &&
      isDigit(s.charCodeAt(start + 1)) &&
      isDigit(s.charCodeAt(start + 2)) &&
      isDigit(s.charCodeAt(start + 3)) &&
      s.charCodeAt(start + 4) === CH_MINUS;
    const isTime =
      this.pos - start >= 3 &&
      isDigit(s.charCodeAt(start)) &&
      isDigit(s.charCodeAt(start + 1)) &&
      s.charCodeAt(start + 2) === CH_COLON;
    // Date and time separated by a space, as in "1979-05-27 07:32:00"
    if (
      isDate &&
      this.pos - start === 10 &&
      this.code() === CH_SPACE &&
      isDigit(this.code(this.pos + 1)) &&
      isDigit(this.code(this.pos + 2)) &&
      this.code(this.pos + 3) === CH_COLON
    ) {
      this.pos++;
      while (this.pos < this.len && isTokenChar(this.src.charCodeAt(this.pos))) this.pos++;
    }
    const token = s.slice(start, this.pos);
    if (isDate || isTime) return this.parseDateTime(token, start);
    return this.parseNumber(token, start);
  }

  private parseNumber(token: string, start: number): number | bigint {
    switch (token) {
      case 'inf':
      case '+inf':
        return Infinity;
      case '-inf':
        return -Infinity;
      case 'nan':
      case '+nan':
      case '-nan':
        return NaN;
    }
    const invalid = (): TomlError => this.error(`Invalid number "${token}"`, start);

    // Hexadecimal, octal, binary (unsigned)
    if (token.length > 2 && token.charCodeAt(0) === 0x30) {
      const p = token.charCodeAt(1);
      const radix = p === 0x78 ? 16 : p === 0x6f ? 8 : p === 0x62 ? 2 : 0;
      if (radix) {
        const digits = cleanDigits(token.slice(2), radix);
        if (digits === null) throw invalid();
        return this.toInteger(token.slice(0, 2), digits, radix, start);
      }
    }

    // Decimal: [+-] integer [. fraction] [e [+-] exponent]
    let body = token;
    let sign = '';
    const c0 = token.charCodeAt(0);
    if (c0 === CH_PLUS || c0 === CH_MINUS) {
      sign = token[0]!;
      body = token.slice(1);
    }
    let expIndex = body.indexOf('e');
    if (expIndex < 0) expIndex = body.indexOf('E');
    const mantissa = expIndex >= 0 ? body.slice(0, expIndex) : body;
    const exponent = expIndex >= 0 ? body.slice(expIndex + 1) : null;
    const dot = mantissa.indexOf('.');
    const intPart = cleanDigits(dot >= 0 ? mantissa.slice(0, dot) : mantissa, 10);
    if (intPart === null) throw invalid();
    if (intPart.length > 1 && intPart.charCodeAt(0) === 0x30) throw invalid(); // Leading zeros are not allowed

    if (dot < 0 && exponent === null) {
      return this.toInteger(sign, intPart, 10, start);
    }

    let text = sign + intPart;
    if (dot >= 0) {
      const frac = cleanDigits(mantissa.slice(dot + 1), 10);
      if (frac === null) throw invalid();
      text += '.' + frac;
    }
    if (exponent !== null) {
      let e = exponent;
      let eSign = '';
      if (e.charCodeAt(0) === CH_PLUS || e.charCodeAt(0) === CH_MINUS) {
        eSign = e[0]!;
        e = e.slice(1);
      }
      const expDigits = cleanDigits(e, 10);
      if (expDigits === null) throw invalid();
      text += 'e' + eSign + expDigits;
    }
    return Number(text);
  }

  /**
   * Check the 64-bit integer range and return a number if it is safe, otherwise a bigint.
   * Rejects by digit count before converting, to avoid creating huge BigInts.
   */
  private toInteger(prefix: string, digits: string, radix: number, start: number): number | bigint {
    let i = 0;
    while (i < digits.length - 1 && digits.charCodeAt(i) === 0x30) i++; // Leading zeros (allowed in hex/octal/binary)
    if (digits.length - i > MAX_INT64_DIGITS[radix]!) throw this.error('Integer is out of 64-bit range', start);
    const value = BigInt(prefix + digits.slice(i));
    if (value > INT64_MAX || value < INT64_MIN) throw this.error('Integer is out of 64-bit range', start);
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }

  /**
   * Date-times are validated and returned as strings.
   * Supported forms: offset date-time / local date-time / local date / local time
   */
  private parseDateTime(token: string, start: number): string {
    const invalid = (): TomlError => this.error(`Invalid date-time "${token}"`, start);
    let i: number;
    if (token.charCodeAt(2) === CH_COLON) {
      i = parseTime(token, 0);
      if (i !== token.length) throw invalid();
      return token;
    }
    if (!isValidDate(token)) throw invalid();
    if (token.length === 10) return token;
    const sep = token.charCodeAt(10);
    if (sep !== 0x54 && sep !== 0x74 && sep !== CH_SPACE) throw invalid(); // T, t, space
    i = parseTime(token, 11);
    if (i < 0) throw invalid();
    if (i === token.length) return token;
    const z = token.charCodeAt(i);
    if ((z === 0x5a || z === 0x7a) && i + 1 === token.length) return token; // Z, z
    if (
      (z === CH_PLUS || z === CH_MINUS) &&
      i + 6 === token.length &&
      twoDigits(token, i + 1) <= 23 &&
      token.charCodeAt(i + 3) === CH_COLON &&
      twoDigits(token, i + 4) <= 59
    ) {
      return token;
    }
    throw invalid();
  }
}

/**
 * Validate a digit string with underscore separators and return it without the underscores.
 * Underscores are only allowed between digits. Returns null if invalid.
 */
function cleanDigits(s: string, radix: number): string | null {
  if (s.length === 0) return null;
  let out = '';
  let chunk = 0;
  let prevDigit = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_UNDERSCORE) {
      if (!prevDigit) return null;
      out += s.slice(chunk, i);
      chunk = i + 1;
      prevDigit = false;
      continue;
    }
    const ok =
      radix === 16 ? isHexDigit(c) : radix === 10 ? isDigit(c) : radix === 8 ? c >= 0x30 && c <= 0x37 : c === 0x30 || c === 0x31;
    if (!ok) return null;
    prevDigit = true;
  }
  if (!prevDigit) return null;
  return out + s.slice(chunk);
}

/** Return the two-digit value of s[i], s[i+1] if both are digits, otherwise 99 */
function twoDigits(s: string, i: number): number {
  const a = s.charCodeAt(i);
  const b = s.charCodeAt(i + 1);
  if (!isDigit(a) || !isDigit(b)) return 99;
  return (a - 0x30) * 10 + (b - 0x30);
}

/** YYYY-MM-DD */
function isValidDate(s: string): boolean {
  if (s.length < 10 || s.charCodeAt(4) !== CH_MINUS || s.charCodeAt(7) !== CH_MINUS) return false;
  for (let i = 0; i < 4; i++) if (!isDigit(s.charCodeAt(i))) return false;
  const year = Number(s.slice(0, 4));
  const month = twoDigits(s, 5);
  const day = twoDigits(s, 8);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Validate HH:MM:SS[.fraction] and return the position after it (-1 if invalid) */
function parseTime(s: string, i: number): number {
  if (
    twoDigits(s, i) > 23 ||
    s.charCodeAt(i + 2) !== CH_COLON ||
    twoDigits(s, i + 3) > 59 ||
    s.charCodeAt(i + 5) !== CH_COLON ||
    twoDigits(s, i + 6) > 60 // leap second
  ) {
    return -1;
  }
  i += 8;
  if (s.charCodeAt(i) === CH_DOT) {
    i++;
    const fracStart = i;
    while (isDigit(s.charCodeAt(i))) i++;
    if (i === fracStart) return -1;
  }
  return i;
}
