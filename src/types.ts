/** Values that appear in parse results */
export type TomlPrimitive = string | number | bigint | boolean;
export type TomlArray = TomlValue[];
export interface TomlTable {
  [key: string]: TomlValue;
}
export type TomlValue = TomlPrimitive | TomlArray | TomlTable;

export interface ParseOptions {
  /**
   * Maximum nesting depth (default 100).
   * Counted as the number of tables and arrays (including arrays of tables) on the path from the root to a value.
   * This is the same as stringify's maxDepth, so any parsed value can be stringified with the same limit.
   * Throws RangeError unless it is a finite non-negative integer.
   */
  maxDepth?: number;
}

export interface StringifyOptions {
  /** Maximum nesting depth (default 100). Throws RangeError unless it is a finite non-negative integer */
  maxDepth?: number;
}
