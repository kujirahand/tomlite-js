import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, TomlError } from '../src/index.ts';

describe('stringify', () => {
  it('基本型', () => {
    assert.equal(
      stringify({ s: 'a"b\\c\n\u0001', i: 42, f: 1.5, t: true, big: 9223372036854775807n, d: new Date(Date.UTC(2020, 0, 2, 3, 4, 5)) }),
      's = "a\\"b\\\\c\\n\\u0001"\ni = 42\nf = 1.5\nt = true\nbig = 9223372036854775807\nd = 2020-01-02T03:04:05.000Z\n',
    );
  });

  it('特殊な浮動小数点数', () => {
    assert.equal(stringify({ a: Infinity, b: -Infinity, c: NaN, d: 1e300, e: 1e-7 }), 'a = inf\nb = -inf\nc = nan\nd = 1e+300\ne = 1e-7\n');
  });

  it('負のゼロを保持する', () => {
    assert.equal(stringify({ n: -0, p: 0 }), 'n = -0.0\np = 0\n');
    const r = parse(stringify({ n: -0, a: [-0] }));
    assert.ok(Object.is(r['n'], -0));
    assert.ok(Object.is((r['a'] as number[])[0], -0));
  });

  it('Date は 4 桁の年の範囲だけ出力し、範囲外はエラー', () => {
    const ok = [new Date('0000-01-01T00:00:00Z'), new Date('9999-12-31T23:59:59.999Z')];
    for (const d of ok) {
      const toml = stringify({ d });
      assert.equal(parse(toml)['d'], d.toISOString());
    }
    const ng = [new Date('+010000-01-01T00:00:00Z'), new Date('-000001-12-31T23:59:59Z'), new Date(8.64e15), new Date(-8.64e15)];
    for (const d of ng) assert.throws(() => stringify({ d }), /out of range/);
  });

  it('キーの引用符', () => {
    assert.equal(stringify({ 'a b': 1, 'x.y': 2, '': 3, ok_key: 4, 'あ': 5 }), '"a b" = 1\n"x.y" = 2\n"" = 3\nok_key = 4\n"あ" = 5\n');
  });

  it('配列とインラインテーブル', () => {
    assert.equal(stringify({ a: [1, 'x', [true]], b: [], c: [{ x: 1 }, 2], d: [{}] }), 'a = [1, "x", [true]]\nb = []\nc = [{ x = 1 }, 2]\n\n[[d]]\n');
  });

  it('ネストしたテーブル', () => {
    const toml = stringify({ title: 'T', a: { x: 1, b: { y: 2 } }, c: { d: { z: 3 } }, e: {} });
    assert.equal(toml, 'title = "T"\n\n[a]\nx = 1\n\n[a.b]\ny = 2\n\n[c.d]\nz = 3\n\n[e]\n');
  });

  it('テーブル配列', () => {
    const toml = stringify({ fruits: [{ name: 'apple', physical: { color: 'red' }, tags: [{ n: 1 }] }, { name: 'banana' }] });
    assert.equal(
      toml,
      '[[fruits]]\nname = "apple"\n\n[fruits.physical]\ncolor = "red"\n\n[[fruits.tags]]\nn = 1\n\n[[fruits]]\nname = "banana"\n',
    );
  });

  it('undefined は省略し、null や関数はエラー', () => {
    assert.equal(stringify({ a: undefined, b: 1 }), 'b = 1\n');
    assert.throws(() => stringify({ a: null }), TomlError);
    assert.throws(() => stringify({ a: () => 1 }), TomlError);
    assert.throws(() => stringify({ a: [undefined] }), TomlError);
    assert.throws(() => stringify({ a: new Map() }), TomlError);
    assert.throws(() => stringify({ a: new Date(NaN) }), TomlError);
    assert.throws(() => stringify({ a: 2n ** 64n }), TomlError);
    assert.throws(() => stringify([] as unknown as object), TypeError);
  });

  it('疎な配列の空き要素はエラー', () => {
    // eslint-disable-next-line no-sparse-arrays
    assert.throws(() => stringify({ arr: [1, , 2] }), /empty slots/);
    assert.throws(() => stringify({ arr: new Array(1) }), TomlError);
    assert.throws(() => stringify({ arr: [[1, , 2]] }), TomlError);
    // eslint-disable-next-line no-sparse-arrays
    assert.throws(() => stringify({ tables: [{ a: 1 }, , { a: 2 }] }), TomlError);
    assert.throws(() => stringify({ inline: { x: new Array(3) } }), TomlError);
  });

  it('循環参照はエラー', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    assert.throws(() => stringify(a), /circular/);
    const arr: unknown[] = [];
    arr.push(arr);
    assert.throws(() => stringify({ arr }), /circular/);
  });

  it('同じオブジェクトを複数回参照するのは許可', () => {
    const shared = { x: 1 };
    assert.deepEqual(parse(stringify({ a: shared, b: shared })), { a: { x: 1 }, b: { x: 1 } });
  });

  it('maxDepth は有限の非負整数だけ受け付ける', () => {
    for (const maxDepth of [NaN, Infinity, -Infinity, -1, 1.5, '3' as unknown as number]) {
      assert.throws(() => stringify({ a: 1 }, { maxDepth }), /maxDepth must be/);
    }
    assert.equal(stringify({ a: 1 }, { maxDepth: 0 }), 'a = 1\n');
    assert.throws(() => stringify({ a: [1] }, { maxDepth: 0 }), /too deep/);
  });

  it('深すぎる入れ子はエラー', () => {
    let obj: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 1000; i++) obj = { a: obj };
    assert.throws(() => stringify(obj), /too deep/);
    let arr: unknown = 1;
    for (let i = 0; i < 1000; i++) arr = [arr];
    assert.throws(() => stringify({ arr }), /too deep/);
  });

  it('parse との往復', () => {
    const data = {
      title: 'TOML "Example"',
      n: -17,
      f: 0.1,
      big: -9223372036854775808n,
      flags: [true, false],
      nested: [[1, 2], ['a']],
      inline: [{ k: 'v', deep: { x: [1] } }, 3],
      owner: { name: 'Tom', 'key with space': { ok: true } },
      servers: [{ ip: '10.0.0.1', meta: { role: 'a' } }, { ip: '10.0.0.2', ports: [{ p: 80 }] }],
      __proto__x: 1,
    };
    assert.deepEqual(parse(stringify(data)), data);
  });

  it('__proto__ キーを含むデータの往復', () => {
    const data = parse('"__proto__" = { a = 1 }\nb = 2');
    assert.deepEqual(parse(stringify(data)), data);
  });

  it('孤立サロゲートを含む値はエラーにする', () => {
    for (const bad of ['\uD800', '\uDC00', 'a\uD800b', '\uDC00\uD800', 'x\uD800']) {
      assert.throws(() => stringify({ s: bad }), TomlError);
      assert.throws(() => stringify({ a: [bad] }), TomlError);
    }
  });

  it('孤立サロゲートを含むキーはエラーにする', () => {
    for (const bad of ['\uD800', '\uDC00', 'k\uD800']) {
      assert.throws(() => stringify({ [bad]: 1 }), TomlError);
      assert.throws(() => stringify({ t: { [bad]: 1 } }), TomlError);
    }
  });

  it('正常なサロゲートペアは値・キーとも往復できる', () => {
    const data = { '😀key': '😀 \u{10FFFF} a😀', t: { '𠮷': ['😀'] } };
    assert.deepEqual(parse(stringify(data)), data);
  });
});
