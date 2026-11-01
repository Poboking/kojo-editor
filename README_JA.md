<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

[简体中文](README.md) | [English](README_EN.md) | **日本語**

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

era 系ゲーム（eraTW など）の**口上スクリプト**向けの構造認識エディタ。  
Tauri 2 シェル（Rust は IO プリミティブのみ）+ React 19 + Monaco、pnpm モノレポ。  
**カーネルはゲーム知識を一切持たない。すべてはプラグイン。**

</div>

---

> **この README は開発者向けです** — リポジトリの構成、動かすために必要なもの、
> 変更をどう証明するか、プラグインの追加方法。
>
> - ツールを**そのまま使いたい**場合：[Releases](https://github.com/Poboking/kojo-editor/releases/latest)、操作マニュアルは [docs/USER-GUIDE.md](docs/USER-GUIDE.md)（中国語）。
> - **先に画面を見たい**場合：[メイン画面](docs/assets/app-editor.jpg)、[条件マトリクス](docs/assets/app-condition-matrix.jpg)、[マーケット](docs/assets/app-market.jpg)。
> - 触る前に必読：[AGENTS.md](AGENTS.md)（規約・コマンド・協業ルールの唯一の入口、中国語）。

## 1. これは何か（エンジニア視点）

2,000 以上の `.ERB` ファイルと約 10 万関数の口上ライブラリを、**辿れる・検証できる・再生できる・書き換えられる**構造に変えるデスクトップアプリ。

| 観点 | 事実 |
|---|---|
| 形態 | Tauri 2 デスクトップシェル + Monaco、Windows 10/11 x64 |
| カーネル | DI・イベントバス・スコープ付きストレージ・ファイル IO・プロジェクト・スロット・ワークスペース・計算プール。**ゲーム名ゼロ**（監査で強制） |
| 拡張性 | プラグイン **31 個**：ゲームアダプタ 8 + 言語レイヤ + UI パネル + マーケット / セーブ / 糖衣構文 |
| 規模 | 機能プール **1,163 ファイル · 22,158 passed / 0 failed**（コーパスの有無で 143 件スキップ） |
| ゲート | 二重 typecheck · 疎結合監査（A–D）· 言語ラチェット監査 · 起動グラフ容量ゲート · ワンコマンドのリリースゲート |

## 2. アーキテクチャ概観

```
┌──────────────────────────────────────────────────────────────┐
│ プラグイン層（31、すべてがプラグイン）                        │
│  ゲームアダプタ × 8 │ 言語（ERB / kojo 1.0 / 2.0）│ UI       │
│  マーケット · セーブ解析 · 状態再生 · 糖衣構文 · 検証 …       │
├──────────────────────────────────────────────────────────────┤
│ スロットレジストリ（UI と拡張点。同一スロットに複数登録可、   │
│ 競合は必ず error）                                            │
├──────────────────────────────────────────────────────────────┤
│ カーネル（汎用施設、ゲーム知識ゼロ）                          │
│ DI │ バス │ ストレージ │ ファイル IO │ プロジェクト │ スロット │
├──────────────────────────────────────────────────────────────┤
│ Tauri 2 Rust ホスト：IO プリミティブ / ウィンドウ / ランチャー │
└──────────────────────────────────────────────────────────────┘
```

変更前に必ず意識する 4 つの規約（`pnpm audit:decoupling` が検査。詳細は [AGENTS.md](AGENTS.md) §2）：

1. **カーネル / 契約 / Rust ホストにゲーム名を書かない** — ゲーム知識はアダプタプラグインのみ；
2. **プラグインが依存してよいのは `@kojo/plugin-api` だけ** — カーネルの import もプラグイン間 import も禁止；
3. **書き込みは互いに継承しない 3 つの認可経路のみ**：カーネル `writablePaths`、`exportFile`（ダイアログ自体が認可）、ランチャー `launcher/approvals.json`；
4. **カーネルは黙らない** — inactive は可視、競合は error、ルール例外は `report.failedRules` へ。

設計判断の理由は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) と [docs/adr/](docs/adr/)（中国語）。

## 3. リポジトリ構成

```
packages/
├── kernel/            カーネル：DI / バス / ストレージ / ファイル IO / スロット / 計算プール
├── plugin-api/        唯一の公開契約パッケージ：プラグイン型・サービスキー・アダプタ接口
├── app/               デスクトップシェル：Tauri（Rust ホスト）+ React + Monaco + 組合せ根
│   └── src-tauri/     Rust の IO プリミティブ・ウィンドウ・ランチャー（cargo test --lib が独立ゲート）
├── kojo-core/         Kojo 2.0 コア：字句 / 文法 / AST / 降糖 / 診断 / source map
├── kojo-lang/         Kojo 言語面の判定と Monaco データ
├── kojo-sdk/          言語パック作者向け SDK：2.0 契約形状 + 構造 worker プロトコル
├── kojo-vocab/        ERB / kojo1 / kojo2 共有の語彙と純関数（プラグインではない）
├── kojo-syntax-tree/  .kojo の tree-sitter CST とクエリ
├── erb-lang/          ERB 言語面の判定（同符号ハイライト / 拡張選択 / シグネチャヘルプ）
├── erb-vocab/         ERB エンジン語彙：制御構文の対表と語分類
├── erb-syntax-tree/   ERB 行構造の tree-sitter CST と折り畳みクエリ
├── kojo-conformance/  アダプタ適合スイート：契約自己検査・DSL→ERB ゴールデン・差分・符号/改行保持
├── kojo-project-kit/  口上プロジェクト工作流の共有実装（新規 / 取込 / 配備 / 公開ウィザード）
└── plugins/           31 個のプラグイン（下記）
```

`packages/plugins/` は 4 系統：

| 系統 | ディレクトリ |
|---|---|
| ゲームアダプタ（8） | `eratw-` `erafl-` `erakoumakan-` `erasqc-` `eratohok-` `eratohoreverse-` `eraav-` `eraakumamaid-adapter` |
| 言語面 | `erb-parser` `erb-lang` `kojo-lang` `kojo-sugar` `inline-completion-local` |
| 領域機能 | `condition-extractor` `convention-linter` `sav-parser` `state-replay` `kojo-market` `launcher-core` |
| UI パネル（12） | `ui-kojo-navigator` `ui-kojo-xml` `ui-condition-matrix` `ui-convention-report` `ui-sugar-editor` `ui-sugar-lift` `ui-sugar-preview` `ui-state-replay` `ui-snapshot-injector` `ui-archive-browser` `ui-market` `ui-plugin-status` |

その他：`docs/`（アーキテクチャ・状態・ボード・落とし穴・ADR）、`tools/`（監査・リリースゲート・デバッグ・計測・スモーク）、`fixtures/`（匿名化した口上サンプル）、`skills/kojo-debug/`（デバッグモードのスキル）。

## 4. 環境と起動

| 依存 | バージョン | 備考 |
|---|---|---|
| Node.js | 22 | CI / release と同一 |
| pnpm | 11.22.0 | `packageManager` で固定。`corepack enable` で導入 |
| Rust | stable ≥ 1.77 | デスクトップシェルのみ。MSVC ツールチェーン |
| WebView2 | システム | Windows 11 は同梱、Windows 10 はランタイムが必要 |

```bash
corepack enable
pnpm install

pnpm dev                            # フロントのみ（vite、ブラウザで動作、シェルなし）
pnpm --filter @kojo/app tauri dev                      # デスクトップシェル（初回 cargo ビルドは 20〜30 分）
pnpm --filter @kojo/app build       # フロント成果物
pnpm --filter @kojo/app tauri build # インストーラ（NSIS + updater 成果物）
```

デスクトップセッションがない場合も `node tools/debug-cli.mjs serve` が「デバッグホスト + vite + ブラウザ（CDP）」を起動し、エディタ URL を出力します。

## 5. 検証マトリクス

**完了条件は常に数字を伴う** — テスト数を減らさない、二重 typecheck は 0、監査は全緑。

```bash
pnpm test                    # 両プール（機能 + 計測。全量では KOJO_SMOKE_PROJECT を設定しない）
pnpm test:unit               # 機能プールのみ（並列）
pnpm test:perf               # 計測プールのみ（直列・静穏。機能プールと混ぜない）

pnpm typecheck                       # root
pnpm --filter @kojo/app typecheck    # app（両方とも有効）

pnpm audit:decoupling        # 「すべてはプラグイン」監査：A–D と 31 プラグインの計数
pnpm audit:language          # 言語ラチェット：M1 ゲーム名 / M2 言語 id 分岐 / M3 旧トークン
pnpm audit:bytes             # 生バイト検査：NUL / BOM / 不正 UTF-8 / 孤立 CR
pnpm audit:board             # ボード構造と参照の自己検査
```

リリースゲートは機械可読面を 1 コマンドにまとめ、項目ごとの読みと `RESULT: PASS|FAIL` を出します：

```bash
node tools/release-gate.mjs --skip-tests        # CI 快速档：二重 typecheck + 監査 + conformance
node tools/release-gate.mjs --release --json    # リリース档：version-sync / 両プール / artifact-audit / cargo を追加
```

Rust 側（`src-tauri` を変更した時のみ。**必ず node 経由で起動**。Git-Bash の `TMP` は MSVC の LNK1104 を招く）：

```bash
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
```

実コーパス / デスクトップシェルのスモーク（コーパスのディレクトリ名は変わり、不在のこともある。まず探針）：

```bash
node tools/corpus.mjs --print        # rc=0 のときだけ続行。不在ならコーパス依存の段はスキップ
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts

node tools/smoke-tauri-dom.mjs       # DOM スモーク
node tools/smoke-tauri-ipc.mjs       # 実 IPC・二重ゲート（store / ファイル / バックアップを自動復元）
node tools/debug-web-smoke.mjs       # ヘッドレス端到端
```

現在の基準値（テスト数・容量ゲート・メモリと性能の読み）は **[docs/STATE.md](docs/STATE.md)** のみが真実です。

## 6. プラグインとアダプタの開発

**依存の向きはハード制約**：`プラグイン → @kojo/plugin-api ← カーネル`。プラグイン同士は import せず、サービスキーとスロットで協働します。

- **プラグイン追加**：`packages/plugins/<name>/` + `package.json`（`@kojo/plugin-<name>`）+ エクスポートする `Plugin` 記述子（`requires` / 貢献点）。UI は `ui.panel` スロット、言語サービスは `services.slot` で宣言。
- **ゲーム追加**：カーネルには触れず、アダプタプラグインを足すだけ。1 コマンドで骨組み・マニフェスト項目・依存・パス別名を生成（4 箇所の散点はツールが編集し、`adapter-manifest.test.ts` が双方向で証明）：

  ```bash
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
  ```

  方言作者向け手引き：[docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md)、適合スイート：`@kojo/kojo-conformance`。
- **言語面は 3 層**：ERB（エンジン原生）/ kojo 1.0（旧表層）/ kojo 2.0（現行チャネル）。判定はライブラリパッケージ（純関数・Monaco / React / IO ゼロ）、ホストは組立てと翻訳のみ。新しい言語能力はライブラリ + スロット供方に置き、ホストに分岐を足さない（`audit:language` の M2 が数える）。

## 7. デバッグと証拠収集

並列エージェント開発の主検証経路はデバッグモードです（デスクトップシェルなしで UI / コマンド / イベント / 意味読みを検証）：

```bash
node tools/debug-cli.mjs serve        # デバッグホスト + vite + ブラウザ（CDP）、エディタ URL を出力
node tools/debug-cli.mjs shell        # 実デスクトップシェル + CDP（起動位相・枠なし・ジオメトリ）
node tools/debug-cli.mjs <command>    # open-project / open-file / commands/run / state / dom / events
                                      # eval / invoke / click / type / key / screenshot / status / stop
```

手引きと拡張規約の唯一の真実：[docs/DEBUG-MODE.md](docs/DEBUG-MODE.md)（拡張前に §5 を必読）。

## 8. ドキュメントマップ

| ドキュメント | 用途 |
|---|---|
| [AGENTS.md](AGENTS.md) | **あらゆるエージェントの第一入口**：規約・コマンド・Git と協業の規律 |
| [docs/STATE.md](docs/STATE.md) | 基準値の唯一の真実 |
| [docs/BOARD.md](docs/BOARD.md) | 進行中ボード：着手前に読み、納品で行を削除 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 実際に踏んだ罠（書込・探針・マルチエージェント・ビルド） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 階層・スロット・中核接口・技術判断 |
| [docs/adr/](docs/adr/) | アーキテクチャ決定記録 |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | デバッグモードの手引きと拡張規約 |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | 新しい方言 / ゲームの接続 |
| [docs/SYNTAX-SUGAR-SURFACE-SPEC.md](docs/SYNTAX-SUGAR-SURFACE-SPEC.md) | `.kojo` 表層文法の完全仕様 |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **作者向け操作マニュアル**（実装の話はしない） |

## 9. コントリビューション

ブランチモデル（2026-10-19 以降。`master` は削除済み、リモート既定は `main`）：

- `dev` — 日常の着地ブランチ。機能・修正・文書バッチはここへ；
- `main` — リリースブランチ。**リリース時のみ**更新（検収済みの dev コミットを併合 → `v*` タグ）；
- 1 エージェント 1 ワークツリー、1 バッチ 1 短命ブランチ `b/<agent>/<MMDD>-<slug>`。`origin/dev` から切り、**ローカルの `dev` / `main` で直接コミットしない**。

着地は狭き門を通ること：

```bash
git fetch origin --prune
git rebase origin/dev
# ゲート全緑（§5 参照）
git push origin HEAD:dev
```

非 fast-forward の拒否は並行プロトコルそのもの — fetch + rebase をやり直して再 push。**`dev` / `main` へ force しない**。コミットメッセージは Conventional Commits + 中国語の件名。`git add -A`（ファイル単位で add）と共有ツリーでの `stash` は禁止。

文書規律：書くのは「着手」と「納品」の 2 つだけ — 着手は `docs/BOARD.md` に 1 行、納品は読みと取捨をコミットメッセージへ。硬い罠は `PITFALLS.md` に 1 行ずつ、`STATE.md` は基準値が実際に動いた時だけ。

## 10. リリース

```bash
# 1. 3 箇所の version を逐字一致させる（app-version.test.ts が固定）
#    package.json / packages/app/package.json / packages/app/src-tauri/tauri.conf.json
# 2. 機械面を全緑に
node tools/release-gate.mjs --release --json
# 3. 検収済み dev コミットを main へ併合しタグを打つ（release.yml はタグ起動）
git checkout main && git merge --ff-only <検収済みコミット> && git tag v0.4.2
git push origin main --tags
```

`release.yml` の成果物：NSIS インストーラ、ポータブル zip、updater 成果物（`latest.json` + 署名）、`SHA256SUMS.txt`。ビルド前に快速ゲート（`--only=version-sync,typecheck-root,typecheck-app,audit,conformance`）を自前で実行し、rc≠0 ならビルドしません。

## 11. ライセンスと謝辞

[GPL-3.0-or-later](LICENSE)。リポジトリにゲーム内容は含みません — スクリーンショットとテスト入力はローカルに導入済みのゲーム由来で、`fixtures/` は匿名化した構造サンプルのみ。

eraTW と era コミュニティの長年の創作に感謝します。

メンテナ：[**Poboking**](https://github.com/Poboking)
