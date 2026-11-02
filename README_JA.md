<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

**简体中文** | [English](README_EN.md) | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**era 系口上スクリプト（`.ERB` / `.kojo`）のための構造認識 IDE。**
Tauri 2 シェル（Rust は IO プリミティブのみ）+ React 19 + Monaco、pnpm monorepo。
**カーネルにゲーム知識はゼロ、すべてはプラグイン。**

</div>

| 定義へ移動 `F12`（ファイル横断） | 参照の検索 `Shift+F12`（peek・ファイル別件数） |
|---|---|
| ![定義へ移動](docs/assets/erb-definition.gif) | ![参照の検索](docs/assets/erb-references.gif) |
| 補完（入力即表示・名前のスロットで絞る） | プロジェクト全体検索（10 件 · 4 ファイル） |
| ![補完](docs/assets/erb-completion.gif) | ![プロジェクト全体検索](docs/assets/editor-search.gif) |
| コマンドパレット（100+・キー変更可） | たたみ（tree-sitter CST が区間を返す） |
| ![コマンドパレット](docs/assets/editor-palette.gif) | ![たたみ](docs/assets/editor-folding.gif) |

> デモデータはすべて合成（`tools/gif-scenarios/demo-project/`）。再生手順は §10。

---

- ダウンロード：[Releases](https://github.com/Poboking/kojo-editor/releases/latest) · 操作ガイド：[docs/USER-GUIDE.md](docs/USER-GUIDE.md)
- 貢献する前に必読：[AGENTS.md](AGENTS.md)（不変条件・コマンド・協力規律）

## 1. 「構文ハイライトをもう一つ」では済まない理由

ERB は 1998 年世代の行指向スクリプト言語で、LSP も AST ツールチェーンもパッケージ管理もない。実プロジェクトは **3,971 の方言ファイル / 110,049 の関数定義**（実測値、[docs/STATE.md](docs/STATE.md) 参照）を持ち、口上関数は**命名規約**で呼び合う（`M_KOJO_{キャラ}_MESSAGE_COM_{コマンド}`）。1 つ改名すれば呼び出し側はプロジェクト全体に散っている。

必要なのは IDE 面の一式、つまり **インデックス → シンボル → 参照 → 診断 → 書換**。本プロジェクトはそれを監査可能な 3 層に作る：判断根拠はライブラリパッケージ（純関数、Monaco なし・IO なし）、ホストは組立てと翻訳だけ、ゲーム知識はアダプタプラグインにしか入れない（`pnpm audit:decoupling` と `pnpm audit:language` が両側から守る）。

## 2. ERB 言語サポート

> キーは既定値で、アプリ内のキー設定画面で全部変更できる。最終列は**コードの場所**。

| 機能 | 既定キー | 実装場所 |
|---|---|---|
| 定義へ移動（ファイル横断） | `F12` | `packages/app/src/monaco/kojo-definition.ts` ← インデックス供給側 |
| 定義をその場で速覧 | `Alt+F12` | Monaco 内建（同じ provider） |
| 実装へ移動 | `Ctrl+F12` | 同上 |
| 参照の検索（peek + ファイル別件数） | `Shift+F12` | `packages/app/src/monaco/find-references.ts` |
| ホバー文書（作者コメント + 仮引数表 + 定義位置） | `Ctrl+K Ctrl+I` | `packages/app/src/monaco/kojo-hover.ts` |
| シグネチャヒント（現在の引数位置） | `Ctrl+Shift+Space` | `packages/app/src/monaco/kojo-signature.ts` |
| 補完（トリガ文字 `#` `[` `@` `$` `.`） | `Ctrl+Space` / 入力即表示 | `packages/app/src/monaco/erb-completion*.ts` |
| リアルベリフィケーション（波線 + 問題パネル + ステータスバー件数） | `Ctrl+Shift+M` パネル · `Alt+F8` 1 件ずつ | `packages/plugins/convention-linter` → `packages/app/src/monaco/slot-service-providers.ts` |
| シンボル一括改名（呼び出し側も同時） | `F2` | Monaco 内建 + 言語側 rename 供給 |
| ドキュメントシンボル / ファイル内シンボルへ | `Ctrl+Shift+O` | `packages/app/src/monaco/kojo-symbols.ts` |
| 同一シンボル強調 · スマート選択 · code lens | `Ctrl+D` / `Shift+Alt+→` / 行内 | `erb-highlight.ts` · `erb-selection-range.ts` · `kojo-code-lens.ts` |
| たたみ（関数本体 / ブロック単位） | 折りたたみガター | `kojo-folding.ts` + `erb-syntax-tree`（tree-sitter CST） |

定義へ移動は**ファイル横断**の関数インデックスを読む（開いているファイル内のテキスト照合ではない）。参照の検索は peek でヒットをファイル別に数え、補完の候補は**名前のスロット**で絞る（台詞・ナレーション・コメント・文字列の内側では出ない）。

## 3. エディタ機能

- **あらゆる機能にプログラマブルな入口がある**：コマンドパレットに 100 超のコマンド（`Ctrl+Shift+P`）、キーも変更可。デバッグ CLI は同じ経路で UI を駆動する（§10）。
- **エディタグループ**：右 / 下への分割（`Ctrl+\`）、縦横配置、`Ctrl+1..4` フォーカス、フォーカス中のグループの拡大縮小。
- **複数カーソルと矩形編集**：`Ctrl+D` 次を追加、`Ctrl+Shift+L` 全部追加、`Ctrl+Alt+↑/↓` 列カーソル、`Alt+↑/↓` 行移動、`Ctrl+Shift+K` 行削除。
- **エンコーディングと改行の保持**：宣言されたエンコーディング（Shift-JIS / GBK / UTF-8）で読み、元の EOL / BOM の形を**バイト単位で**書き戻す。1 行の編集がファイル全体の並べ替えにはならない。
- **読み取り専用保護**：ゲームディレクトリ内のファイルは既定で読み取り専用、最初の実際のキー入力で確認が出る。解除は**このファイル・このセッション**限定で、再起動すると保護に戻る。
- **書き込み許可は互いに継承されない 3 経路のみ**：カーネルの `writablePaths`、`exportFile`（システムダイアログがすなわち許可）、ランチャの `launcher/approvals.json`。

作者向けの完成品パネル（状態注入 / 口上マーケット / アーカイブブラウザ / 糖衣エディタ / 条件マトリクス / デプロイウィザード）はプラグイン。[docs/USER-GUIDE.md](docs/USER-GUIDE.md) を参照。

## 4. どう実現しているか

| 面 | やり方 |
|---|---|
| 言語の階層 | **ERB**（エンジン原生）/ **kojo 1.0**（旧表層）/ **kojo 2.0**（現行通道）が同じスロット供給側で共存。言語の追加 = descriptor を 1 枚足すことで、ホストに `if (languageId === …)` を増やさない（`audit:language` の M2 がまさにそれを数えている） |
| 構造とたたみ | `packages/erb-syntax-tree` と `packages/kojo-syntax-tree` に tree-sitter CST を各 1 枚。たたみも構造ビューも CST から取る——正規表現で `IF/ENDIF` を数えない |
| インデックス | プロジェクト単位のインデクシングは**ERB サブツリー全体**を歩く（口上ルート + 読み取り専用ベースライブラリを祖先畳み込みして 1 つの走査ルートに）。名前登録・参照フロー・仮引数・`#DIM` 宣言を産出し、スナップショットをディスクへ。熱い起動はスナップショットを読む（実データ計測：`read+parse 0ms`、`refs scan 2ms`） |
| 診断 | ルールは `convention-linter` プラグインが所有。文言は人間の言葉に翻訳し**エンジンの結果**を書く。ルールが投げた例外は必ず `report.failedRules` に載る（カーネルは黙らない） |
| 性能 | 計算は専用の worker プール（構造層は単一プールに統合済み）。コールドスタートとメモリはバッチごとに [docs/STATE.md](docs/STATE.md) へ記帳し、「体感が速い」に頼らない |
| 規模 | 機能プール **1,170 ファイル · 22,281 passed / 0 failed**（約 143 件はコーパスの有無で skip）・計時プール 31 ファイル・typecheck 二式・監査 4 種・プラグイン 31 個 |

現在値はすべて [docs/STATE.md](docs/STATE.md) を正とする（テスト数 / サイズゲート / メモリ / コールドスタート / コーパス）。記憶や古い文書を信じないこと。

## 5. アーキテクチャ概観

```
┌──────────────────────────────────────────────────────────────┐
│ プラグイン層（31 個、すべてはプラグイン）                      │
│  ゲームアダプタ × 8 │ 言語面（ERB / kojo 1.0 / 2.0）│ UI パネル │
│  マーケット · アーカイブ解析 · 状態再生 · 糖衣 · 検証 …        │
├──────────────────────────────────────────────────────────────┤
│ スロット登録表（UI と拡張点。同一スロットの多重登録可、        │
│ 衝突は必ず error として可視）                                  │
├──────────────────────────────────────────────────────────────┤
│ カーネル（汎用基盤、ゲーム知識ゼロ）                           │
│ DI │ イベントバス │ ストレージ域 │ ファイル IO │ プロジェクト   │
├──────────────────────────────────────────────────────────────┤
│ Tauri 2 Rust ホスト：IO プリミティブ / ウィンドウ / ランチャのみ │
└──────────────────────────────────────────────────────────────┘
```

変更前に復唱する 4 つの不変条件（`pnpm audit:decoupling` が検査する。詳細は [AGENTS.md](AGENTS.md) §2）：

1. **カーネル / 契約 / Rust ホストにゲーム名詞ゼロ**——ゲーム知識はアダプタプラグインにしか置けない；
2. **プラグインの依存は `@kojo/plugin-api` のみ**——kernel の import 禁止、プラグイン間の相互 import 禁止；
3. **書き込み許可は互いに継承されない 3 経路のみ**（§3 最終項）；
4. **カーネルは黙らない**——inactive は可視、衝突は error、検証ルールの例外は必ず `report.failedRules` へ。

設計判断の全体は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) と [docs/adr/](docs/adr/)。

## 6. リポジトリ構成

```
packages/
├── kernel/            DI / バス / ストレージ域 / ファイル IO / スロット登録表 / 計算プール（ゲーム知識ゼロ）
├── plugin-api/        唯一の公開契約パッケージ：プラグイン型、サービスキー、言語とアダプタのインターフェース
├── app/               デスクトップシェル：Tauri（Rust ホスト）+ React + Monaco + 基盤ブリッジ + 合成根
│   ├── src/monaco/    言語面の組立層（定義 / 参照 / ホバー / シグネチャ / 補完 / シンボル / たたみ）
│   └── src-tauri/     Rust 側の IO プリミティブ、ウィンドウ、ランチャ（`cargo test --lib` の独立ゲートあり）
├── kojo-core/         Kojo 2.0 言語コア：字句 / 文法 / AST / 糖衣展開 / 診断 / source map
├── kojo-lang/         Kojo 言語面の判断根拠と Monaco データ（シンボルツリー / 宣言インデックス / インデントと Enter …）
├── erb-lang/          ERB 言語面の判断根拠（同一シンボル強調 / 拡張選択 / シグネチャヘルプ）
├── erb-vocab/         ERB エンボキャブラリ：制御フロー対応表と語ごとの分類
├── erb-syntax-tree/   ERB の行構造の tree-sitter CST とたたみクエリ
├── kojo-syntax-tree/  .kojo の tree-sitter CST とクエリ
├── kojo-sdk/          言語パック作者向け SDK：2.0 契約の形 + 構造 worker プロトコル + 役割テーブル
├── kojo-vocab/        ERB / kojo1 / kojo2 共用の語彙と純関数（プラグインではない）
├── kojo-conformance/  アダプタ適合性スイート：契約自己点検 + DSL→ERB ゴールデン + 差分 + エンコーディング/EOL 保持
├── kojo-project-kit/  口上プロジェクト手順の共通実装（新規 / インポート / デプロイ / 公開ウィザード）
└── plugins/           31 プラグイン：ゲームアダプタ 8 + 言語面 + 領域機能 + UI パネル
```

`packages/plugins/` は責務で 4 群：

| 群 | ディレクトリ |
|---|---|
| ゲームアダプタ（8） | `eratw-` `erafl-` `erakoumakan-` `erasqc-` `eratohok-` `eratohoreverse-` `eraav-` `eraakumamaid-adapter` |
| 言語面 | `erb-parser` `erb-lang` `kojo-lang` `kojo-sugar` `inline-completion-local` |
| 領域機能 | `condition-extractor` `convention-linter` `sav-parser` `state-replay` `kojo-market` `launcher-core` |
| UI パネル（12） | `ui-kojo-navigator` `ui-kojo-xml` `ui-condition-matrix` `ui-convention-report` `ui-sugar-*` `ui-state-replay` `ui-snapshot-injector` `ui-archive-browser` `ui-market` `ui-plugin-status` |

付随ディレクトリ：`docs/`（アーキテクチャ、状態、ボード、落とし穴、ADR）、`tools/`（監査 / リリースゲート / デバッグ / 計測 / スモーク / GIF 録画）、`fixtures/`（除染した口上サンプル）、`skills/kojo-debug/`（デバッグモード習得用 skill）。

## 7. 環境と起動

| 依存 | バージョン | 備考 |
|---|---|---|
| Node.js | 22 | CI と release と同一 |
| pnpm | 11.22.0 | `packageManager` フィールドで固定。`corepack enable` で導入 |
| Rust | stable ≥ 1.77 | デスクトップシェルにのみ必要。MSVC ツールチェーン |
| WebView2 | OS 同梱 | Windows 11 はプリインストール、Win10 はランタイムが必要 |

```bash
corepack enable
pnpm install

pnpm dev                            # フロントエンドのみ（vite、ブラウザで動く、シェルなし）
pnpm --filter @kojo/app tauri dev   # シェル開発（初回 cargo ビルドは 20〜30 分）
pnpm --filter @kojo/app build       # フロントエンド成果物
pnpm --filter @kojo/app tauri build # インストーラ（NSIS + updater 成果物）
```

デスクトップセッションがなくても UI 開発はできる：`node tools/debug-cli.mjs serve` が「デバッグホスト + vite + ブラウザ(CDP)」を起動し、エディタの URL を表示する。

## 8. 検証マトリクス

**受入基準：「直った」は必ず数値を伴う**——テスト数を戻さない、typecheck 二式が 0、監査は全緑。

```bash
pnpm test                    # 両プール（機能 + 計時。全量実行時に KOJO_SMOKE_PROJECT を設定しない）
pnpm test:unit               # 機能プールのみ（並列）
pnpm test:perf               # 計時プールのみ（直列の静粛プール。機能プールと混ぜて走らせない）

pnpm typecheck                       # root
pnpm --filter @kojo/app typecheck    # app（両方とも計上）

pnpm audit:decoupling        # 「すべてはプラグイン」分離監査：A–D 四項 + 31 プラグイン計数
pnpm audit:language          # 言語面のラチェット：M1 ゲーム名 / M2 言語 id 分岐 / M3 旧 token
pnpm audit:bytes             # 生バイト点検：NUL / BOM / 不正 UTF-8 / 孤立 CR
pnpm audit:board             # ボード構造と参照の自己点検
```

リリースゲートは機械面を 1 コマンドに集約し、項目ごとに数値を出して最後に `RESULT: PASS|FAIL` を返す：

```bash
node tools/release-gate.mjs --skip-tests        # CI 速档：typecheck 二式 + 監査 + conformance
node tools/release-gate.mjs --release --json    # リリース档：version-sync / 両プール / artifact-audit / cargo を追加
```

Rust 側（`src-tauri` を触ったときだけ。**node 経由で起動すること**——Git-Bash の `TMP` が MSVC のリンクを LNK1104 で落とす）：

```bash
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
```

実コーパス / デスクトップシェルスモーク（コーパスのディレクトリ名は変わるし、消えることもある。先にプローブ）：

```bash
node tools/corpus.mjs --print        # rc=0 のとき続行。無ければその枠はスキップ
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts

node tools/smoke-tauri-dom.mjs       # DOM スモーク
node tools/smoke-tauri-ipc.mjs       # 実 IPC 二重ゲート（store / ファイル / バックアップを自動復元）
node tools/debug-web-smoke.mjs       # ヘッドレスブラウザの端到端
```

## 9. プラグインとアダプタの開発

**依存方向は硬い制約**：`プラグイン → @kojo/plugin-api ← カーネル`。プラグイン同士は import せず、サービスキーとスロットで協調する。

- **プラグインを 1 つ足す**：`packages/plugins/<name>/` + `package.json`（名前は `@kojo/plugin-<name>`）+ `Plugin` 記述子（`requires` / 貢献点）。UI は `ui.panel` スロット、言語サービスは `services.slot` 宣言。
- **ゲームを 1 つ足す**：カーネルには触れず、アダプタプラグインだけを追加。1 コマードで骨格・マニフェスト項目・依存・パスエイリアスを生成（散った 4 箇所をツールが書き換え、`adapter-manifest.test.ts` が双方向に自己証明）：

  ```bash
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
  ```

  方言作者向けハンドブック：[docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md)。適合性スイート：`@kojo/kojo-conformance`。
- **言語機能を 1 つ足す**：判断根拠はライブラリパッケージ（純関数、Monaco / React / IO なし）に置き、ホストは `packages/app/src/monaco/` で provider に組立ててスロットから差し出すだけ。ホストに言語 id の分岐を増やさない（`audit:language` の M2 が数える）。

## 10. デバッグモードとデモ録画

複数 agent が並行開発する際の主要な検証通道はデバッグモード（デスクトップシェルなしで UI / コマンド / イベント / 意味読み取りを検証できる）：

```bash
node tools/debug-cli.mjs serve        # デバッグホスト + vite + ブラウザ(CDP)、エディタ URL を表示
node tools/debug-cli.mjs shell        # 実デスクトップシェル + CDP（起動相位 / 枠なし / ウィンドウ幾何）
node tools/debug-cli.mjs <サブコマンド> # open-project / open-file / commands/run / state / dom / events
                                      # eval / invoke / click / type / key / screenshot / status / stop
node tools/debug-cli.mjs definition 18 10   # 意味読み取り：定義 / 参照 / code action / シグネチャ / シンボル / 診断
```

**この README のアニメーションは全部この通道で録った**もので、再生できる：

```bash
node tools/debug-cli.mjs serve --headless     # 1) セッション起動
node tools/readme-gif.mjs list                # 2) シナリオ一覧
node tools/readme-gif.mjs record all --max-kb 1500 --keyframes 3
```

シナリオは `tools/gif-scenarios/*.json` の宣言手順（実際のキーボード / マウス / コマンドパレット / 意味読み取り）。毎回デモプロジェクトを既知の状態へ戻してから録り、フレームは CDP で連続サンプリング、符号化は ffmpeg の 2 パレット。録画後はフレーム数 / 長さ / サイズ / バイト数を報告し、`--keyframes` は等間隔フレームを目視検証用に吐く。`probe` はフレームを採らず手順だけ回す。中間物は `%TEMP%/kojo-gif/`、リポジトリには最終 `.gif` だけ。読み取りの復査は `tools/tests/readme-gif.test.ts` が留めている。

デバッグモードの唯一の正典（使い方と拡張規範）：[docs/DEBUG-MODE.md](docs/DEBUG-MODE.md)——拡張前に §5 を必読。

## 11. ドキュメントマップ

| 文書 | 用途 |
|---|---|
| [AGENTS.md](AGENTS.md) | **すべての agent の第一入口**：不変条件、コマンド、協力と Git の規律 |
| [docs/STATE.md](docs/STATE.md) | 基準値の唯一の正典（テスト数 / サイズ / メモリ / 性能 / コーパス） |
| [docs/BOARD.md](docs/BOARD.md) | 作業中のボード：引き受け前に読み、納品で行を消す |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 落とし穴台帳（書き込み / プローブ / 複数 agent / ビルド）着手前に一読 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 層、スロット、コア IF、技術判断 |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) | Kojo 2.0 言語仕様 |
| [docs/adr/](docs/adr/) | アーキテクチャ決定記録（ツールチェーン、ホスト、許可モデル、プラグイン源プロジェクト …） |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | デバッグモードの手引き + 拡張規範 |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | 新しい方言 / ゲームの接続 |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **作者向けの使い方ガイド**（実装の話はしない） |

## 12. 貢献の手順

ブランチモデル（2026-10-19 より `master` は削除済み、リモート既定ブランチは `main`）：

- `dev` ＝ 日常の着地ブランチ。機能 / 修正 / ドキュメントの一般更新はすべてここ；
- `main` ＝ リリースブランチ。**リリースのときだけ**更新（承認済みの dev コミットを併合 → tag `v*`）；
- agent 1 つにつきワークツリー 1 つ、バッチ 1 本に短命ブランチ `b/<agent>/<MMDD>-<slug>`（`origin/dev` から切る）。**ローカルの `dev` / `main` に直接コミットしない**。

着地は狭門を抜ける：

```bash
git fetch origin --prune
git rebase origin/dev
# ゲート全緑（§8 参照）
git push origin HEAD:dev
```

non-fast-forward で弾かれること自体が並行処理の規約——fetch + rebase をやり直して push。**決して** `dev` / `main` を force しない。コミットメッセージは Conventional Commits + 中国語タイトル。`git add -A` 禁止（ファイルごとに add）、共有ツリーでの `stash` 禁止。

ドキュメント規律：書くのは 2 つだけ——①引き受け（`docs/BOARD.md` に 1 行）、②納品（数値と取捨をコミットメッセージへ）。硬い落とし穴は 1 行 1 件 `PITFALLS.md`、基準値が実際に動いたときだけ `STATE.md` を直す。

## 13. リリース

```bash
# 1. 三箇所の version を逐字一致させる（app-version.test.ts が固定）
#    package.json / packages/app/package.json / packages/app/src-tauri/tauri.conf.json
# 2. 機械面を全緑に
node tools/release-gate.mjs --release --json
# 3. 検収済み dev コミットを main へ併合しタグを打つ（release.yml はタグ起動）
git checkout main && git merge --ff-only <検収済みコミット> && git tag v0.4.2
git push origin main --tags
```

`release.yml` の産出：NSIS インストーラ、緑版 `portable.zip`、updater 成果物（`latest.json` + 署名付きパック）、`SHA256SUMS.txt`。ビルド前に速档ゲート（`--only=version-sync,typecheck-root,typecheck-app,audit,conformance`）を自前で走らせ、rc≠0 ならビルドしない。

## 14. ライセンスと謝辞

[GPL-3.0-or-later](LICENSE)。リポジトリはゲーム内容を同梱しない——README のアニメーションとテストに必要な口上ファイルは、`fixtures/` / `tools/gif-scenarios/` の**合成サンプル**か、ユーザーがローカルに導入し許可したゲームディレクトリ由来のものだけ。

eraTW と era コミュニティ長年の創作に感謝する。

開発者：[**Poboking**](https://github.com/Poboking)
