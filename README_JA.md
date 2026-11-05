<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

[简体中文](README.md) | [English](README_EN.md) | **日本語**

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Built with](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![Downloads](https://img.shields.io/github/downloads/Poboking/kojo-editor/total?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**era 系ゲームの口上スクリプト（`.ERB` / `.kojo`）用エディタ。**  
関数が見つかる、他人の口上が読める、書きながらミスに気づける、出来たらワンクリックでゲームに入る。Windows 10 / 11。

</div>

<div align="center">
  <img src="docs/assets/erb-definition.gif" width="760" alt="定義へ移動">
  <br><sub>呼び出し側に光标を置いて <code>F12</code> —— <b>別のファイル</b>の中の定義へ飛ぶ</sub>
</div>

## 亮点

- **構造で探すので全名を覚えなくていい**。キャラ → 一族 → 面 → 関数のツリーをたどるだけ。`M_KOJO_K12_MESSAGE_COM_310` のような名前はツールに組み立てさせます。関数にマウスを乗せると、作者が関数の上に書いたコメントブロックが浮かび、大文字の関数名だけ眺めるよりずっと読めます。
- **他人の `.ERB` が読める**。ゲームディレクトリのファイルを開くと `IF` / `PRINTFORMW` がその場で「もし …：」と台詞行に表示され、`ENDIF` はインデントで表現します。**表示だけ**でファイルは 1 バイトも変わらず、`Ctrl+Alt+T` でいつでも元に戻せます。
- **いつもの IDE 動作、それもファイル横断で**。定義へ移動 `F12`、その場で速覧 `Alt+F12`、実装へ `Ctrl+F12`、参照の検索 `Shift+F12`（peek でヒットをファイル別に件数表示）、一括改名 `F2`（呼び出し側も一緒に）、ホバーでコメントと仮引数、シグネチャヒント、`Ctrl+Shift+O` でシンボルへ、同一シンボル強調とスマート選択。
- **ミスは入力中に出る。ゲームで「効いてない」を確認しなくていい**。関数名の打ち間違い、一族の不足、兜底漏れの分岐、怪しい条件を行に波線で示し、クリックで飛びます。ステータスバーに件数常駐、`Ctrl+Shift+M` で問題パネル、`Alt+F8` で 1 件ずつ。
- **エンコーディングと改行をバイト単位で保持**。宣言されたエンコーディング（Shift-JIS / GBK / UTF-8 / UTF-16）で読み、元の改行と BOM の形のまま書き戻します。1 行の編集がファイル全体の並べ替えにならず、Shift-JIS が黙って UTF-8 になることもありません。
- **ゲームディレクトリは既定で読み取り専用**。実際の最初のキー入力で確認が出ます。解除はそのファイル・そのセッション限りで、再起動すると保護に戻ります。自分の作品は独立した口上プロジェクト（ワークスペース）にあり、常に書けるので許可に邪魔されません。
- **自分の作品は別管理、出来たらワンクリックでゲームへ**。新規プロジェクトは 8 枚の面ファイルと中国語 README を用意し、ライセンスは LTOL / CC BY-NC / MIT / BSD-2 / ISC / 生成なしから選べます。**エクスポート**は配布用 zip、**デプロイ**は書き先に先に画面を示してから確定。宛先が既にある場合は上書きせずエラー、転訳が失敗したらまとめて拒否し、欠けた半成品パッケージは渡しません。
- **ゲームを起動して試さなくていい**。状態リプレイは今のセーブデータで「この台詞が出るか・どの分岐へ進むか」を答え、状態インジェクタは変数を目標値にして**テスト用セーブ**に書き込みます（二次確認・自動バックアップ・書き戻し後の照合つき）。
- **「この台詞はいつ出る？」に表で答える**。条件マトリクスは状態キー × 時機面を広げ、色付きのマスをクリックすると該当する口上関数へ飛びます。
- **探せる・変えられる・増やせる**。コマンドパレットに 100+ 画面のできることが揃い、キー割当も変更可能。内建の `.kojo` チュートリアルと文法全表は、書き方・コンパイル結果・エラー文を逐語で対照できます。口上マーケットはレジストリを取得して他の作者のパッケージを導入でき、ファイルごとに sha256 を照合します。

## ダウンロードとインストール

[Releases](https://github.com/Poboking/kojo-editor/releases/latest) から：

- **インストール版** `kojo-editor_<バージョン>_x64-setup.exe`：ウィザードどおり進める。以降の版は「設定 → 更新」でワンクリック。
- **緑版** `kojo-editor_<バージョン>_x64-portable.zip`：解凍して `kojo-editor.exe` を実行。レジストリ書き込みなし。WebView2 実行環境が必要（Windows 11 は同梱、Windows 10 は[先に導入](https://developer.microsoft.com/microsoft-edge/webview2/)することがあります）。

各 Release に `SHA256SUMS.txt` を同梱しています。インストールパッケージは**コード署名なし**なので、初回起動で「Windows は PC を保護しました」が出ることがあります。「詳細情報 → 実行」で進んでください。

## 最初の起動

1. ウェルカム画面で「ゲームディレクトリを選択」を押し、eraTW のルートを選ぶ；
2. 続いて書き込み許可を聞かれます——**読むだけなら断って構いません**、閲覧・検証・リプレイはそのまま使えます；
3. 左の「口上ファイル」からキャラの `.ERB` を開くと、最初に「`.kojo` プレビュー」を使うか尋ねられます；
4. 自分用なら：左の「我的口上项目」（自分の口上プロジェクト）→「＋ 新建」（新規作成）。

詳しい手順（プロジェクトの新規作成、エクスポート / デプロイ、ライセンスの選び方、状態インジェクタの安全説明）は
[docs/USER-GUIDE.md](docs/USER-GUIDE.md)（現在中国語のみ）にあります。

## ソースから動かす

```bash
corepack enable
pnpm install
pnpm --filter @kojo/app tauri dev      # 開発実行（初回 cargo ビルドは 20〜30 分）
pnpm --filter @kojo/app tauri build    # インストーラ生成
```

Node.js 22・pnpm 11.22.0・Rust stable（MSVC）が必要。環境マトリクス、検証コマンド、プラグインとアダプタ開発、リリース手順は [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) に。

## よくある質問

| 質問 | 回答 |
|---|---|
| ゲームディレクトリを壊さない？ | 既定は読み取り専用。許可したパスだけ書けます。書く前は自動バックアップ、エンコーディングと改行は元のまま。 |
| 対応ゲームは？ | era 系 8 本につながっています。eraTW が最も丁寧に作り込み、eraFL は口上が XML データファイル。残りは適用度がまちまちです。 |
| `.ERB` を直接編集するのと衝突しない？ | しません。原生の書き方は今までどおり編集でき、読みやすい表層表記は選択肢です。 |
| macOS / Linux は？ | まだありません。Windows 10 / 11 x64 のみ。 |
| ゲームに入れても反応がない | エンジンは `.ERB` しか読みません。「エクスポート」か「デプロイ」を使い、源ファイルを直接コピーするのは避けてください。 |

## ドキュメント

| 文書 | 対象 |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | 作者向け：使い方（実装の話はしない。中国語） |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | 開発者向け：環境・検証・プラグインとアダプタ・リリース |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) | `.kojo` 言語仕様 |
| [docs/STATE.md](docs/STATE.md) | テスト・性能の読み値と未完了項 |
| [AGENTS.md](AGENTS.md) | AI 協力向けの規則とコマンド |

## 貢献

歓迎します。着手前に [AGENTS.md](AGENTS.md)（不変条件と協力の規律）をお読みください。落とし穴集は
[docs/PITFALLS.md](docs/PITFALLS.md)。ゲームを 1 本増やすには [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md)。
PR を出す前に Issue で一言いただけると、無駄な作業を防げます。

## スクリーンショットとデモ

アニメーションはすべて実際の画面から録ったもので、1 コマンドで作り直せます
（手順は [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) §8）。デモデータはすべて合成サンプルです。
静止画は 2026-10-20 の画面で、パネルの配置は批次で動くので実物をもって正としてください。

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/erb-references.gif" width="420" alt="参照の検索"><br><sub><b>参照の検索</b> <code>Shift+F12</code> —— 変える前に呼び出し側の散り方を確認</sub></td>
    <td width="50%" align="center"><img src="docs/assets/erb-completion.gif" width="420" alt="補完"><br><sub><b>補完</b> —— 台詞・コメント・文字列では出ない</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/editor-folding.gif" width="420" alt="たたみ"><br><sub><b>たたみ</b> —— 関数本体とブロック単位で畳む</sub></td>
    <td width="50%" align="center"><img src="docs/assets/editor-palette.gif" width="420" alt="コマンドパレット"><br><sub><b>コマンドパレット</b> <code>Ctrl+Shift+P</code> —— コマンド検索とキー割当</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/editor-search.gif" width="420" alt="プロジェクト全体検索"><br><sub><b>プロジェクト全体検索</b> —— 台詞の一節しか覚えていないときに</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-editor.jpg" width="420" alt="メイン画面"><br><sub><b>メイン画面</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-condition-matrix.jpg" width="420" alt="条件マトリクス"><br><sub><b>条件マトリクス</b> —— 色付きのマスから該当する口上へ</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-syntax-reference.jpg" width="420" alt="文法全表"><br><sub><b>文法全表</b> —— 書き方・コンパイル結果・エラー文</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-market.jpg" width="420" alt="口上マーケット"><br><sub><b>口上マーケット</b> —— 他の作者のパッケージを導入（図は合成デモパッケージ）</sub></td>
    <td></td>
  </tr>
</table>

## ライセンス

[GPL-3.0-or-later](LICENSE)。リポジトリにゲーム内容は同梱していません——この文書のアニメーションとスクリーンショットは
すべて合成サンプル由来で、テストが使う実コーパスはユーザー自身が導入し許可したディレクトリを**読み取りのみ**で扱います。

eraTW と era コミュニティ長年の創作に感謝します。

開発者：[**Poboking**](https://github.com/Poboking) · 要望・不具合は [Issue](https://github.com/Poboking/kojo-editor/issues) へ
