/** Error thrown when parsing or serializing TOML fails */
export class TomlError extends Error {
  /** 1-based line number (0 when serializing) */
  readonly line: number;
  /** 1-based column number (0 when serializing) */
  readonly column: number;
  /** Offset in the input string (-1 when serializing) */
  readonly offset: number;

  constructor(message: string, line = 0, column = 0, offset = -1) {
    super(line > 0 ? `${message} (line ${line}, column ${column})` : message);
    this.name = 'TomlError';
    this.line = line;
    this.column = column;
    this.offset = offset;
  }

  /** Create an error pointing at `offset` in `src` (line numbers are counted once, only on error) */
  static at(src: string, offset: number, message: string): TomlError {
    let line = 1;
    let lineStart = 0;
    const end = Math.min(offset, src.length);
    for (let i = 0; i < end; i++) {
      if (src.charCodeAt(i) === 0x0a) {
        line++;
        lineStart = i + 1;
      }
    }
    return new TomlError(message, line, offset - lineStart + 1, offset);
  }
}
