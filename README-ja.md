# tomlite - JS/TS向けの安全で小さなTOMLパーサー

本ライブラリは、TOML の基本機能だけに絞った、小さく安全なパーサーとシリアライザーです。依存パッケージはありません。TOML への完全準拠は目指しておらず、対応していない構文はエラー（`TomlError`）になります。

## 使い方

`tomlite`をインポートすると、`parse`関数と`stringify`関数が使用できるようになります。

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

## 対応範囲

| 項目 | 内容 |
| --- | --- |
| キー | `key = value`、ドット付きキー（`a.b = 1`）、引用符付きキー |
| テーブル | `[table]`、`[[array of tables]]` |
| 文字列 | 基本・リテラル・複数行（基本／リテラル） |
| 整数 | 10進・16進・8進・2進、`_` 区切り。安全な整数の範囲を超えるものは `bigint`、64bit を超えるとエラー |
| 浮動小数点数 | 指数表記、`inf` / `nan` |
| その他 | 真偽値、配列（混在型可）、インラインテーブル、`#` コメント |
| 日時 | オフセット付き日時・ローカル日時・ローカル日付・ローカル時刻。形式と値の範囲を検証したうえで **文字列のまま** 返す |

### stringify

- 文字列・数値（`inf` / `nan` を含む）・`bigint`・真偽値・`Date`（ISO 8601 で出力）・配列・ネストしたオブジェクトに対応
- オブジェクトだけを要素に持つ空でない配列は `[[テーブル配列]]` として出力
- `undefined` のプロパティは省略。`null`・関数・`Map` などはエラー
- 循環参照はエラー

## 安全性（DoS 対策）

- 入力を先頭から一度だけ走査し、入力サイズに対して線形時間でパースします
- 入れ子の深さに上限（既定 100）を設けています。深さはルートから値までの経路にあるテーブルと配列（テーブル配列を含む）の数で数えます。`parse` と `stringify` で数え方が同じなので、パースできた値は同じ上限で `stringify` できます。再帰がスタックを使い切ることはありません
- 整数は `BigInt` に変換する前に桁数で範囲外を弾くので、極端に長い数値でも重い変換をしません
- 正規表現を使わず、文字コードで判定します
- `__proto__` などのキーはプロトタイプを書き換えずに独自プロパティとして設定します

```ts
parse(src, { maxDepth: 32 });
stringify(obj, { maxDepth: 32 });
```

大量のコメント行・深い入れ子・長いキー行・不正な文書についての回帰テストを `test/dos.test.ts` に収めています。

## 開発

Node.js 22.18 以降（TypeScript を直接実行できるバージョン）が必要です。

```sh
npm install
npm test           # テスト（node:test で .ts を直接実行）
npm run typecheck  # 型チェック
npm run build      # dist/ に JS と型定義を出力
```

## ライセンス

MIT
