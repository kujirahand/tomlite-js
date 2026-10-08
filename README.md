# tomlite - A small, safe TOML parser for JS/TS

[![npm version](https://img.shields.io/npm/v/tomlite.svg)](https://www.npmjs.com/package/tomlite)

[日本語のREADME](https://github.com/kujirahand/tomlite-js/blob/main/README-ja.md)

This library is a small, safe parser and serializer focused on the essential features of TOML. It has no dependencies. Full compliance with the TOML specification is not a goal; unsupported syntax results in an error (`TomlError`).

## Usage

Importing `tomlite` gives you the `parse` and `stringify` functions.

```ts
import { parse, stringify, TomlError } from 'tomlite';

const data = parse(`
title = "Example"

[owner]
name = "Tom"
dob = 1979-05-27T07:32:00-08:00

[[fruits]]
name = "apple"
`);
// { title: 'Example', owner: { name: 'Tom', dob: '1979-05-27T07:32:00-08:00' }, fruits: [ { name: 'apple' } ] }

const toml = stringify({ title: 'Example', server: { port: 8080 } });
// title = "Example"
//
// [server]
// port = 8080

try {
  parse('a = [1, 2');
} catch (e) {
  if (e instanceof TomlError) console.log(e.line, e.column, e.message);
}
```

## Supported features

| Item | Details |
| --- | --- |
| Keys | `key = value`, dotted keys (`a.b = 1`), quoted keys |
| Tables | `[table]`, `[[array of tables]]` |
| Strings | Basic, literal, and multi-line (basic / literal) |
| Integers | Decimal, hexadecimal, octal, and binary, with `_` separators. Values beyond the safe integer range become `bigint`; values beyond 64 bits are an error |
| Floats | Exponent notation, `inf` / `nan` |
| Other | Booleans, arrays (mixed types allowed), inline tables, `#` comments |
| Date-times | Offset date-time, local date-time, local date, and local time. The format and value ranges are validated, and the value is returned **as a string** |

### stringify

- Supports strings, numbers (including `inf` / `nan`), `bigint`, booleans, `Date` (written as ISO 8601), arrays, and nested objects
- A non-empty array whose elements are all objects is written as an `[[array of tables]]`
- Properties set to `undefined` are omitted. `null`, functions, `Map`, and similar values are errors
- Circular references are errors

## Safety (DoS protection)

- The input is scanned once from start to end, so parsing runs in time linear to the input size
- Nesting depth is limited (100 by default). Depth is the number of tables and arrays (including arrays of tables) on the path from the root to a value. `parse` and `stringify` count depth the same way, so any value that parses can be stringified with the same limit. Recursion never exhausts the stack
- Integers are checked against the range by digit count before being converted to `BigInt`, so extremely long numbers never trigger an expensive conversion
- No regular expressions are used; characters are checked by character code
- Keys such as `__proto__` are set as own properties without modifying the prototype

```ts
parse(src, { maxDepth: 32 });
stringify(obj, { maxDepth: 32 });
```

Regression tests for large numbers of comment lines, deep nesting, long key lines, and malformed documents are in `test/dos.test.ts`.

## Development

Requires Node.js 20 or later. (Running the tests from TypeScript source needs Node.js 22.18 or later.)

```sh
npm install
npm test           # Run tests (node:test runs .ts directly)
npm run typecheck  # Type-check
npm run build      # Emit JS and type definitions to dist/
```

## License

MIT
