import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, TomlError } from '../src/index.ts';

function throwsToml(src: string, pattern?: RegExp): void {
  assert.throws(() => parse(src), (e: unknown) => {
    assert.ok(e instanceof TomlError, `expected TomlError, got ${String(e)}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

describe('キーと値', () => {
  it('基本のキーと値', () => {
    assert.deepEqual(parse('a = 1\nb = "x"\n'), { a: 1, b: 'x' });
  });

  it('ドット付きキー・引用符付きキー', () => {
    assert.deepEqual(parse('a.b.c = 1\na . d = 2\n"x.y" = 3\n\'q\'.r = 4\n"" = 5'), {
      a: { b: { c: 1 }, d: 2 },
      'x.y': 3,
      q: { r: 4 },
      '': 5,
    });
  });

  it('重複キーはエラー', () => {
    throwsToml('a = 1\na = 2', /Duplicate key/);
    throwsToml('a.b = 1\na.b = 2', /Duplicate key/);
    throwsToml('a = 1\na.b = 2', /Cannot add keys/);
  });

  it('__proto__ キーでプロトタイプが汚染されない', () => {
    const r = parse('__proto__.polluted = 1\n[constructor]\nx = 1');
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.ok(Object.hasOwn(r, '__proto__'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(r, '__proto__')?.value, { polluted: 1 });
  });

  it('キーや値の欠落はエラー', () => {
    throwsToml('= 1', /Invalid character in key/);
    throwsToml('a =', /Expected a value/);
    throwsToml('a 1', /Expected "="/);
    throwsToml('a = 1 b = 2', /Expected end of line/);
    throwsToml('"""a""" = 1', /Multi-line string cannot be used as a key/);
  });
});

describe('コメント・改行', () => {
  it('コメントを無視する', () => {
    assert.deepEqual(parse('# head\na = 1 # tail\n  # indented\n'), { a: 1 });
  });

  it('CRLF に対応し、単独の CR はエラー', () => {
    assert.deepEqual(parse('a = 1\r\nb = 2\r\n'), { a: 1, b: 2 });
    throwsToml('a = 1\rb = 2', /carriage return/);
  });

  it('コメント中の制御文字はエラー', () => {
    throwsToml('# \u0000', /Control character/);
  });

  it('BOM を読み飛ばす', () => {
    assert.deepEqual(parse('\uFEFFa = 1'), { a: 1 });
  });
});

describe('文字列', () => {
  it('基本文字列とエスケープ', () => {
    assert.deepEqual(parse('s = "a\\tb\\n\\"\\\\\\u00e9\\U0001F600"'), { s: 'a\tb\n"\\é😀' });
  });

  it('不正なエスケープはエラー', () => {
    throwsToml('s = "\\x"', /Invalid escape/);
    throwsToml('s = "\\uD800"', /scalar value/);
    throwsToml('s = "\\u12"', /Invalid unicode escape/);
  });

  it('リテラル文字列', () => {
    assert.deepEqual(parse("s = 'C:\\path\\to'"), { s: 'C:\\path\\to' });
  });

  it('複数行基本文字列', () => {
    assert.deepEqual(parse('s = """\nline1\nline2"""'), { s: 'line1\nline2' });
    assert.deepEqual(parse('s = """\\\n   a \\\n\n   b"""'), { s: 'a b' });
    assert.deepEqual(parse('s = """a""""'), { s: 'a"' });
    assert.deepEqual(parse('s = """a"""""'), { s: 'a""' });
    assert.deepEqual(parse('s = """a""b"""'), { s: 'a""b' });
    throwsToml('s = """a""""""', /Too many quotes/);
  });

  it('複数行リテラル文字列', () => {
    assert.deepEqual(parse("s = '''\nraw \\n\n'''"), { s: 'raw \\n\n' });
    assert.deepEqual(parse("s = '''it''s'''"), { s: "it''s" });
  });

  it('閉じていない文字列や改行入り文字列はエラー', () => {
    throwsToml('s = "abc', /Unterminated string/);
    throwsToml('s = "a\nb"', /Newline/);
    throwsToml("s = 'abc", /Unterminated string/);
    throwsToml('s = """abc', /Unterminated multi-line string/);
    throwsToml("s = '''abc", /Unterminated multi-line string/);
  });
});

describe('数値', () => {
  it('整数', () => {
    assert.deepEqual(parse('a = 42\nb = +7\nc = -17\nd = 1_000_000\ne = 0'), { a: 42, b: 7, c: -17, d: 1000000, e: 0 });
  });

  it('16進・8進・2進', () => {
    assert.deepEqual(parse('a = 0xDEAD_beef\nb = 0o755\nc = 0b1101'), { a: 0xdeadbeef, b: 0o755, c: 0b1101 });
  });

  it('安全な範囲を超える整数は bigint、64bit を超えるとエラー', () => {
    assert.deepEqual(parse('a = 9223372036854775807\nb = -9223372036854775808'), {
      a: 9223372036854775807n,
      b: -9223372036854775808n,
    });
    throwsToml('a = 9223372036854775808', /64-bit/);
    assert.deepEqual(parse('a = 0x7fff_ffff_ffff_ffff\nb = 0o777777777777777777777\nc = 0b' + '1'.repeat(63)), {
      a: 0x7fffffffffffffffn,
      b: 0o777777777777777777777n,
      c: 2n ** 63n - 1n,
    });
    throwsToml('a = 0x8000000000000000', /64-bit/);
    throwsToml('a = 0o1000000000000000000000', /64-bit/);
    throwsToml('a = 0b1' + '0'.repeat(63), /64-bit/);
    throwsToml('a = -9223372036854775809', /64-bit/);
    throwsToml('a = 99999999999999999999', /64-bit/);
    // 16/8/2進では先頭の 0 は桁数に数えない
    assert.deepEqual(parse('a = 0x' + '0'.repeat(10_000) + '1\nb = 0b' + '0_'.repeat(100) + '1'), { a: 1, b: 1 });
  });

  it('浮動小数点数', () => {
    const r = parse('a = 3.14\nb = -0.01\nc = 5e+22\nd = 1e06\ne = -2E-2\nf = 6.626e-34\ng = 9_224.5_1');
    assert.deepEqual(r, { a: 3.14, b: -0.01, c: 5e22, d: 1e6, e: -0.02, f: 6.626e-34, g: 9224.51 });
  });

  it('inf / nan', () => {
    const r = parse('a = inf\nb = +inf\nc = -inf\nd = nan\ne = -nan');
    assert.equal(r['a'], Infinity);
    assert.equal(r['b'], Infinity);
    assert.equal(r['c'], -Infinity);
    assert.ok(Number.isNaN(r['d']));
    assert.ok(Number.isNaN(r['e']));
  });

  it('不正な数値はエラー', () => {
    for (const v of ['01', '1__0', '_1', '1_', '1.', '.5', '1._5', '1e', '0x', '+0x1', '0b2', '1.2.3', 'infinity', '--1']) {
      throwsToml(`a = ${v}`, /Invalid (number|value)/);
    }
  });
});

describe('真偽値・日時', () => {
  it('真偽値', () => {
    assert.deepEqual(parse('a = true\nb = false'), { a: true, b: false });
    throwsToml('a = truex', /Invalid value/);
    throwsToml('a = TRUE', /Invalid value/);
  });

  it('日時は検証して文字列で返す', () => {
    assert.deepEqual(
      parse(
        [
          'a = 1979-05-27T07:32:00Z',
          'b = 1979-05-27T00:32:00.999999-07:00',
          'c = 1979-05-27 07:32:00',
          'd = 1979-05-27',
          'e = 07:32:00.5',
          'f = [2000-02-29, 2000-01-01T00:00:00+09:00]',
        ].join('\n'),
      ),
      {
        a: '1979-05-27T07:32:00Z',
        b: '1979-05-27T00:32:00.999999-07:00',
        c: '1979-05-27 07:32:00',
        d: '1979-05-27',
        e: '07:32:00.5',
        f: ['2000-02-29', '2000-01-01T00:00:00+09:00'],
      },
    );
  });

  it('不正な日時はエラー', () => {
    for (const v of ['1979-13-01', '1979-02-30', '2001-02-29', '1979-05-27T25:00:00', '1979-05-27T07:32', '07:60:00', '1979-05-27T07:32:00+9:00']) {
      throwsToml(`a = ${v}`, /Invalid date-time/);
    }
  });
});

describe('配列', () => {
  it('配列（複数行・コメント・末尾カンマ・混在型）', () => {
    assert.deepEqual(parse('a = [\n  1, # one\n  "two",\n  [3],\n]\nb = []'), { a: [1, 'two', [3]], b: [] });
  });

  it('不正な配列はエラー', () => {
    throwsToml('a = [1 2]', /Expected "," or "\]"/);
    throwsToml('a = [,]', /Invalid value/);
    throwsToml('a = [1,', /Unterminated array/);
  });
});

describe('インラインテーブル', () => {
  it('インラインテーブル', () => {
    assert.deepEqual(parse('a = { x = 1, y.z = "s", w = { v = [] } }\nb = {}'), {
      a: { x: 1, y: { z: 's' }, w: { v: [] } },
      b: {},
    });
  });

  it('インラインテーブルは後から拡張できない', () => {
    throwsToml('a = { x = 1 }\na.y = 2', /Cannot add keys/);
    throwsToml('a = { x = 1 }\n[a]', /already defined/);
    throwsToml('a = { x = { y = 1 } }\n[a.x.z]', /non-table/);
    throwsToml('a = { b.c = 1 }\na.b.d = 2', /Cannot add keys/);
  });

  it('不正なインラインテーブルはエラー', () => {
    throwsToml('a = { x = 1, }', /Invalid character in key/);
    throwsToml('a = { x = 1\n}', /Expected "," or "}"/);
    throwsToml('a = { x = 1, x = 2 }', /Duplicate key/);
    throwsToml('a = { x = 1', /Unterminated inline table/);
  });
});

describe('テーブル', () => {
  it('テーブルとサブテーブル', () => {
    assert.deepEqual(parse('[a]\nx = 1\n[a.b]\ny = 2\n[ c . "d" ]\nz = 3'), {
      a: { x: 1, b: { y: 2 } },
      c: { d: { z: 3 } },
    });
  });

  it('暗黙のテーブルは後から定義できる', () => {
    assert.deepEqual(parse('[a.b]\nx = 1\n[a]\ny = 2'), { a: { b: { x: 1 }, y: 2 } });
  });

  it('ドット付きキーで作ったテーブルの下にサブテーブルを作れる', () => {
    assert.deepEqual(parse('[fruit]\napple.color = "red"\n[fruit.apple.texture]\nsmooth = true'), {
      fruit: { apple: { color: 'red', texture: { smooth: true } } },
    });
  });

  it('テーブルの再定義はエラー', () => {
    throwsToml('[a]\n[a]', /already defined/);
    throwsToml('[a.b]\n[a]\n[a]', /already defined/);
    throwsToml('a.b = 1\n[a]', /already defined/);
    throwsToml('[a]\nb.c = 1\n[a.b]', /already defined/);
    throwsToml('a = 1\n[a]', /already defined/);
    throwsToml('a = 1\n[a.b]', /non-table/);
    throwsToml('[a.b]\n[a]\nb.c = 1', /Cannot add keys/);
  });

  it('不正な見出しはエラー', () => {
    throwsToml('[]', /Invalid character in key/);
    throwsToml('[a', /Expected "\]"/);
    throwsToml('[a] b = 1', /Expected end of line/);
    throwsToml('[[a]', /Expected "\]\]"/);
  });
});

describe('テーブル配列', () => {
  it('テーブル配列とサブテーブル', () => {
    const src = `
[[fruits]]
name = "apple"

[fruits.physical]
color = "red"

[[fruits.varieties]]
name = "red delicious"

[[fruits.varieties]]
name = "granny smith"

[[fruits]]
name = "banana"

[[fruits.varieties]]
name = "plantain"
`;
    assert.deepEqual(parse(src), {
      fruits: [
        {
          name: 'apple',
          physical: { color: 'red' },
          varieties: [{ name: 'red delicious' }, { name: 'granny smith' }],
        },
        { name: 'banana', varieties: [{ name: 'plantain' }] },
      ],
    });
  });

  it('静的な配列やテーブルにテーブル配列は追加できない', () => {
    throwsToml('a = []\n[[a]]', /not an array of tables/);
    throwsToml('[a]\n[[a]]', /not an array of tables/);
    throwsToml('[[a]]\n[a]', /already defined/);
  });
});

describe('エラー位置', () => {
  it('行と桁を報告する', () => {
    try {
      parse('a = 1\nb = 2\nc = @');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof TomlError);
      assert.equal(e.line, 3);
      assert.equal(e.column, 5);
      assert.match(e.message, /line 3, column 5/);
    }
  });

  it('文字列以外を渡すと TypeError', () => {
    assert.throws(() => parse(1 as unknown as string), TypeError);
  });
});
