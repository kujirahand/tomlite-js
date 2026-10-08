/*
 * DoS 対策の回帰テスト。
 * 大量のコメント行・深い入れ子・長いキー行・不正な文書のそれぞれで、
 * 入力サイズに対して線形時間で終わる（またはすぐにエラーになる）ことを確認する。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, TomlError } from '../src/index.ts';

/** 時間制限。遅い CI でも誤検知しないよう緩めにしてある（2 乗時間なら桁違いに遅くなる） */
const TIME_LIMIT_MS = 2000;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

function parseFast(src: string): ReturnType<typeof parse> {
  const { result, ms } = timed(() => parse(src));
  assert.ok(ms < TIME_LIMIT_MS, `parse took ${ms.toFixed(0)}ms`);
  return result;
}

function throwsFast(src: string, pattern?: RegExp): void {
  const { ms } = timed(() => {
    assert.throws(
      () => parse(src),
      (e: unknown) => {
        assert.ok(e instanceof TomlError, `expected TomlError, got ${String(e)}`);
        if (pattern) assert.match(e.message, pattern);
        return true;
      },
    );
  });
  assert.ok(ms < TIME_LIMIT_MS, `parse took ${ms.toFixed(0)}ms`);
}

/**
 * 入力を n と 4n にしたときの時間比を見て、2 乗時間になっていないことを確かめる。
 * 線形なら約 4 倍、2 乗なら約 16 倍になる。揺らぎを考慮して 10 倍未満を合格とする。
 */
function assertLinear(make: (n: number) => string, n: number, run: (src: string) => void = (s) => parse(s)): void {
  const small = make(n);
  const large = make(n * 4);
  run(small); // ウォームアップ
  const best = (src: string): number => {
    let min = Infinity;
    for (let i = 0; i < 3; i++) min = Math.min(min, timed(() => run(src)).ms);
    return min;
  };
  const t1 = Math.max(best(small), 1);
  const t4 = best(large);
  assert.ok(t4 / t1 < 10, `not linear: ${t1.toFixed(1)}ms -> ${t4.toFixed(1)}ms`);
}

describe('DoS: 大量のコメント行', () => {
  it('20 万行のコメントを含む文書を線形時間でパースする', () => {
    const src = '# comment line\n'.repeat(200_000) + 'a = 1\n';
    assert.deepEqual(parseFast(src), { a: 1 });
  });

  it('値の間・配列の中に大量のコメントがあっても線形', () => {
    const src = 'a = [\n' + '  # c\n'.repeat(100_000) + '  1,\n' + '  # c\n'.repeat(100_000) + ']\n';
    assert.deepEqual(parseFast(src), { a: [1] });
  });

  it('コメント行数に対して線形に伸びる', () => {
    assertLinear((n) => '# comment\n'.repeat(n) + 'a = 1\n', 50_000);
  });

  it('コメントの後に不正な行があるとすぐエラーになる', () => {
    throwsFast('# c\n'.repeat(200_000) + 'a = \n', /Expected a value|Invalid value/);
  });

  it('非常に長い 1 行のコメント', () => {
    assert.deepEqual(parseFast('#' + 'x'.repeat(5_000_000) + '\na = 1'), { a: 1 });
  });
});

describe('DoS: 深い入れ子', () => {
  it('深い配列は上限でエラーになり、スタックを使い切らない', () => {
    throwsFast('a = ' + '['.repeat(100_000), /too deep/);
    throwsFast('a = ' + '['.repeat(100_000) + ']'.repeat(100_000), /too deep/);
  });

  it('深いインラインテーブルは上限でエラー', () => {
    throwsFast('a = ' + '{ b = '.repeat(100_000), /too deep/);
  });

  it('配列とインラインテーブルの混在', () => {
    throwsFast('a = ' + '[{ b = '.repeat(50_000), /too deep/);
  });

  it('深いドット付きキー・見出しは上限でエラー', () => {
    throwsFast('a' + '.a'.repeat(100_000) + ' = 1', /too deep/);
    throwsFast('[a' + '.a'.repeat(100_000) + ']', /too deep/);
    throwsFast('[[a' + '.a'.repeat(100_000) + ']]', /too deep/);
  });

  it('深さはルートからの経路にあるテーブルと配列の数で数える', () => {
    // ドット付きキーの途中のテーブル 50 段 + 配列 51 段 = 101 > 100
    throwsFast('a' + '.a'.repeat(50) + ' = ' + '['.repeat(51) + ']'.repeat(51), /too deep/);
    // 見出し 50 段 + ドット付きキー 25 段 + 配列 26 段 = 101 > 100
    throwsFast('[a' + '.a'.repeat(49) + ']\n' + 'b' + '.b'.repeat(25) + ' = ' + '['.repeat(26) + ']'.repeat(26), /too deep/);
  });

  it('ネストしたテーブル配列は各段の配列も数える', () => {
    // [[a]] → [[a.b]] → [[a.b.c]] ... と n 段ネストすると、テーブル n 段 + 配列 n 段 = 2n
    const nestedTableArrays = (n: number): string => {
      const lines: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < n; i++) {
        keys.push(`k${i}`);
        lines.push(`[[${keys.join('.')}]]`);
      }
      return lines.join('\n');
    };
    throwsFast(nestedTableArrays(51), /too deep/);
    throwsFast(nestedTableArrays(61), /too deep/);
    throwsFast(nestedTableArrays(51) + '\nx = 1', /too deep/);
    // [a] の下に [[a.b]] の要素がある場合も同様
    throwsFast('[[a]]\n' + '[a' + '.t'.repeat(99) + ']', /too deep/);
    assert.doesNotThrow(() => parse('[[a]]\n' + '[a' + '.t'.repeat(98) + ']'));
    assert.doesNotThrow(() => parse(nestedTableArrays(50)));
  });

  it('上限ちょうどの文書はパースでき、同じ上限で stringify できる', () => {
    const nestedTableArrays = (n: number): string => {
      const lines: string[] = [];
      for (let i = 1; i <= n; i++) lines.push(`[[${'k.'.repeat(i - 1)}k]]\nv = ${i}`);
      return lines.join('\n');
    };
    const docs = [
      'a = ' + '['.repeat(100) + ']'.repeat(100),
      'a' + '.a'.repeat(99) + ' = 1',
      'a' + '.a'.repeat(99) + ' = [1]',
      'a = ' + '{ b = '.repeat(100) + '1' + ' }'.repeat(100),
      '[a' + '.a'.repeat(99) + ']\nx = 1',
      nestedTableArrays(50),
    ];
    for (const doc of docs) {
      const data = parse(doc);
      assert.deepEqual(parse(stringify(data)), data);
    }
    // 1 段深くするとエラー
    throwsFast('a = ' + '['.repeat(101) + ']'.repeat(101), /too deep/);
    throwsFast('a' + '.a'.repeat(101) + ' = 1', /too deep/);
    throwsFast('a' + '.a'.repeat(100) + ' = [1]', /too deep/);
    throwsFast('a = ' + '{ b = '.repeat(101) + '1' + ' }'.repeat(101), /too deep/);
    throwsFast('[a' + '.a'.repeat(100) + ']', /too deep/);
  });

  it('不正な maxDepth で深さ制限が無効にならない', () => {
    const deep = 'a = ' + '['.repeat(100_000) + ']'.repeat(100_000);
    for (const maxDepth of [NaN, Infinity, -1, 1.5, '3' as unknown as number]) {
      // スタックオーバーフローも RangeError なので、メッセージで区別する
      assert.throws(() => parse(deep, { maxDepth }), (e: unknown) => e instanceof RangeError && /maxDepth must be/.test(e.message));
      assert.throws(() => parse('a = 1', { maxDepth }), /maxDepth must be/);
    }
    assert.deepEqual(parse('a = 1', { maxDepth: 0 }), { a: 1 });
    assert.throws(() => parse('a = []', { maxDepth: 0 }), /too deep/);
  });

  it('maxDepth オプション', () => {
    assert.throws(() => parse('a = [[[[1]]]]', { maxDepth: 3 }), /too deep/);
    assert.deepEqual(parse('a = [[[1]]]', { maxDepth: 3 }), { a: [[[1]]] });
  });

  it('入れ子の深さに対して線形', () => {
    assertLinear((n) => 'a = ' + '['.repeat(n), 20_000, (s) => assert.throws(() => parse(s), TomlError));
  });
});

describe('DoS: 長いキー行', () => {
  it('非常に長いキー', () => {
    const key = 'k'.repeat(1_000_000);
    const r = parseFast(`${key} = 1`);
    assert.equal(r[key], 1);
  });

  it('非常に長い引用符付きキー', () => {
    const key = 'x'.repeat(1_000_000);
    assert.equal(parseFast(`"${key}" = 1`)[key], 1);
  });

  it('= のない長いキー行はすぐエラーになる', () => {
    throwsFast('k'.repeat(1_000_000), /Expected "="/);
    throwsFast('k'.repeat(1_000_000) + '\n' + 'k'.repeat(1_000_000), /Expected "="/);
    throwsFast('"' + 'k'.repeat(1_000_000), /Unterminated string/);
  });

  it('長いキー行が大量にあっても線形', () => {
    assertLinear((n) => {
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(`key_${i}_${'x'.repeat(200)} = ${i}`);
      return lines.join('\n');
    }, 5_000);
  });

  it('同じ長いキーの重複はすぐエラー', () => {
    const key = 'k'.repeat(1_000_000);
    throwsFast(`${key} = 1\n${key} = 2`, /Duplicate key/);
  });

  it('1 行に大量のドット区切り（上限内）のキーが並ぶ', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(`t${i}.${'a.'.repeat(50)}z = ${i}`);
    parseFast(lines.join('\n'));
  });

  it('長い値の行', () => {
    const r = parseFast(`s = "${'v'.repeat(5_000_000)}"\nt = [${'1,'.repeat(500_000)}]`);
    assert.equal((r['s'] as string).length, 5_000_000);
    assert.equal((r['t'] as number[]).length, 500_000);
  });

  it('エスケープだらけの文字列も線形', () => {
    assertLinear((n) => `s = "${'\\n'.repeat(n)}"`, 100_000);
  });
});

describe('DoS: 不正な文書', () => {
  it('閉じていない複数行文字列', () => {
    throwsFast('s = """' + 'a\n'.repeat(500_000), /Unterminated/);
    throwsFast("s = '''" + 'a\n'.repeat(500_000), /Unterminated/);
    throwsFast('s = """' + '\\\n'.repeat(200_000), /Unterminated/);
  });

  it('引用符の連続', () => {
    throwsFast('s = """' + '"'.repeat(1_000_000), /Too many quotes/);
    throwsFast('s = ' + '"'.repeat(1_000_000), /Too many quotes|Expected end of line/);
  });

  it('閉じていない配列・インラインテーブル', () => {
    throwsFast('a = [' + '1, '.repeat(500_000), /Unterminated array/);
    throwsFast('a = { k = 1, x', /Expected "="/);
    throwsFast('a = {' + ' k = { j = 1 }, k = 1', /Duplicate key/);
  });

  it('大量のテーブル再定義の途中で止まる', () => {
    throwsFast('[a]\n'.repeat(200_000), /already defined/);
  });

  it('大量の見出しと値でも線形', () => {
    assertLinear((n) => {
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(`[[items]]\nid = ${i}\n[items.sub]\nv = "x"`);
      return lines.join('\n');
    }, 5_000);
  });

  it('不正なバイト列・制御文字', () => {
    throwsFast('\u0000'.repeat(1_000_000));
    throwsFast('a = "' + '\u0001'.repeat(1_000_000) + '"', /Control character/);
    throwsFast('a = 1\r'.repeat(100_000), /carriage return/);
  });

  it('長い数値トークン', () => {
    throwsFast('a = ' + '1'.repeat(1_000_000), /64-bit/);
    throwsFast('a = ' + '1_'.repeat(500_000), /Invalid number/);
    throwsFast('a = -' + '9'.repeat(1_000_000), /64-bit/);
    throwsFast('a = 0x' + 'f'.repeat(1_000_000), /64-bit/);
    throwsFast('a = 0b' + '1'.repeat(1_000_000), /64-bit/);
    throwsFast('a = 0o' + '7_'.repeat(500_000) + '7', /64-bit/);
    throwsFast('a = 1.' + '0'.repeat(1_000_000) + 'x', /Invalid number/);
  });

  it('ランダムな入力でも TomlError か正常終了のどちらかになる（ハングしない）', () => {
    const alphabet = ['a', '1', '=', ' ', '\n', '"', "'", '[', ']', '{', '}', ',', '.', '#', '\\', 'e', '-', '_', ':', 'T', 'x', '\t', 'u'];
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const { ms } = timed(() => {
      for (let i = 0; i < 3000; i++) {
        let s = '';
        const len = rand() % 80;
        for (let j = 0; j < len; j++) s += alphabet[rand() % alphabet.length];
        try {
          parse(s);
        } catch (e) {
          if (!(e instanceof TomlError)) throw new Error(`unexpected ${String(e)} for ${JSON.stringify(s)}`);
        }
      }
    });
    assert.ok(ms < TIME_LIMIT_MS * 2, `fuzz took ${ms.toFixed(0)}ms`);
  });
});
