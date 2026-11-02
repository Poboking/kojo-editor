<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

[简体中文](README.md) | [English](README_EN.md) | **日本語**

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**era 系口上スクリプト（`.ERB` / `.kojo`）のための構造認識 IDE。**  
Tauri 2 シェル（Rust は IO プリミティブのみ）+ React 19 + Monaco、pnpm monorepo。  
**カーネルにゲーム知識はゼロ、すべてはプラグイン。** Windows 10 / 11 x64。

</div>

## デモ

6 枚のアニメーションはすべて実際の画面から録画したもので、1 コマンドで作り直せます（手順：[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) §8）。デモデータはすべて合成サンプルです（末尾の「ライセンスと謝辞」参照）。

一枚の画面に積みはしません——**1 枚を 1 つの説明の隣に**置きます。まず「構造認識」を最もよく示すこの一枚を。残りは何れも下の「ERB 言語面」と「エディタとしての土台」の各節に散らしてあります。

<div align="center">
  <img src="docs/assets/erb-definition.gif" width="760" alt="定義へ移動（ファイル横断）">
  <br><sub><b>定義へ移動</b> <code>F12</code> —— 呼び出し側にいる光标が、<b>別のファイル</b>の中の定義へ飛ぶ</sub>
</div>

## まず「自分はどれか」を選ぶ

| あなた | ここから |
|---|---|
| **コードは書かないが、他人の口上を読みたい・直したい** | インストール → [docs/USER-GUIDE.md](docs/USER-GUIDE.md) §3 どおりゲームディレクトリを開く（**書き込み許可は断って構いません**、閲覧・検証・ナビゲーション・リプレイはそのまま使えます）→ 「`.kojo` プレビュー」で `.ERB` をその場で読みやすい表層表記に |
| **ERB を書ける。自分の構文で書き、ワンクリックでゲームに入れたい** | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) §7（口上プロジェクト）→ §8（言語面と保存の手順。`.kojo` 2.0 の現在地は §8.8）→ §10（エクスポート / デプロイ） |
| **コードを読む・プラグインを増やす・新しい era ゲームをつなぐ** | [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)（環境 / 検証マトリクス / 言語面の組立 / プラグインとアダプタ / デモ録画 / リリース）＋ [AGENTS.md](AGENTS.md)（不変条件と協力規律。触る前に必読） |

三つの道は同じ原則を共有しています。跳ぶ先も警告も、すべて単体テストで固定された純関数から出てくる——「ERB っぽさ」を正規表現で当てにしていません。

## 何が問題なのか

ERB は 1998 年世代の行指向スクリプトで、LSP も AST ツールチェーンもパッケージ管理もない。実プロジェクトは **3,971 の方言ファイル / 110,049 の関数定義**（eraTW 4.980 基線盤で実測、口径は [docs/STATE.md](docs/STATE.md)）を持ち、口上関数は**命名規約**で呼び合う（`M_KOJO_{キャラ}_MESSAGE_COM_{コマンド}`）。1 人ぶんの口上を書き換えると呼び出し側はプロジェクト全体に散り、関数名を一文字誤るとエンジンが**黙って効かない**。

だから足りないのは「構文ハイライトをもう一つ」ではなく、IDE 面の一式——**インデックス → シンボル → 参照 → 診断 → 書換**。本プロジェクトそれを監査可能な 3 層に作ります。判断根拠はライブラリパッケージ（純関数、Monaco なし・IO なし）、ホストは組立てと翻訳だけ、ゲーム知識はアダプタプラグインにしか入れない（`pnpm audit:decoupling` と `pnpm audit:language` が両側から守る）。

## ERB 言語面

> キーはすべて既定値で、大半はアプリ内のキー設定画面で変えられます（内建の 3 本は当面変更不可：執筆モード `Ctrl+K Z`、保存 `Ctrl+S`、選択範囲内検索 `Ctrl+Alt+F`）。実装場所の一覧は [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) §6。

| 機能 | 既定キー |
|---|---|
| 定義へ移動（ファイル横断）· その場で速覧 · 実装へ移動 | `F12` · `Alt+F12` · `Ctrl+F12` |
| 参照の検索（peek + ファイル別件数） | `Shift+F12` |
| ホバー文書（作者コメント + 仮引数表 + 定義位置） | `Ctrl+K Ctrl+I` |
| シグネチャヒント（現在の引数位置） | `Ctrl+Shift+Space` |
| 補完（トリガ文字 `#` `[` `@` `$` `.`、入力即表示） | `Ctrl+Space` |
| リアルベリフィケーション（波線 + 問題パネル + ステータスバー件数） | `Ctrl+Shift+M` パネル · `Alt+F8` 1 件ずつ |
| シンボル一括改名（呼び出し側も同時） | `F2` |
| ドキュメントシンボル / ファイル内シンボルへ | `Ctrl+Shift+O` |
| 同一シンボル強調 · スマート選択 · code lens | `Ctrl+D` · `Shift+Alt+→` · 行内 |
| たたみ（関数本体 / ブロック単位） | たたみガター |

上の表の三行に対応する三枚を、一枚一文で：

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/erb-references.gif" width="420" alt="参照の検索"></td>
    <td valign="middle"><b>参照の検索</b> <code>Shift+F12</code><br>
    peek 画面でヒットをファイル別にグループ化し件数を出す。口上関数は命名規約で呼び合うので、一か所を変える前に「呼び出し側がどのファイルに散っているか」を見ねばならない。全文 Grep が行数をくれるのに対して、これは「誰がそれを呼んでいるか」をくれる。</td>
  </tr>
</table>

<table>
  <tr>
    <td valign="middle"><b>補完</b> <code>Ctrl+Space</code> / 入力即表示<br>
    候補は<b>名前のスロット</b>で絞る。台詞・ナレーション・コメント・文字列の内側では出ず、トリガ文字は <code>#</code> <code>[</code> <code>@</code> <code>$</code> <code>.</code>。語彙表を丸ごと突きつけるのではなく、「この位置に何が入るか」を先に訊いている。</td>
    <td width="46%" align="center"><img src="docs/assets/erb-completion.gif" width="420" alt="補完"></td>
  </tr>
</table>

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/editor-folding.gif" width="420" alt="たたみ"></td>
    <td valign="middle"><b>たたみ</b> 関数本体 / ブロック単位<br>
    区間は tree-sitter CST から取り、正規表現で <code>IF/ENDIF</code> を数えない。数万行の口上ファイルは、構造で畳めて初めて読めるようになる。実コーパスでのたたみ召回率と逐行の付き合わせの読み値は <a href="docs/STATE.md">docs/STATE.md</a> に記帳してある。</td>
  </tr>
</table>

## 作者向けのパネル

これらは宿主のコードではなくプラグインです。使い方は [docs/USER-GUIDE.md](docs/USER-GUIDE.md)（現在中国語のみ）。

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-editor.jpg" width="480" alt="メイン画面"><br><sub><b>メイン画面</b> —— 左に口上プロジェクトツリーとチュートリアル入口、中央で `.kojo` / `.ERB` / `.md` をマルチタブ編集、ステータスバーに書込可否と診断件数</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-condition-matrix.jpg" width="480" alt="条件マトリクス"><br><sub><b>条件マトリクス</b> —— 状態キー × 時機面を一つの表に広げる。色付きのマスをクリックすると対応する口上関数へ飛ぶ（フローティング窓）</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-syntax-reference.jpg" width="480" alt="KOJO 文法全表"><br><sub><b>KOJO 文法全表（付録）</b> —— 書き方・コンパイル成果物・間違えたときの出る警告文を逐語で対照。左の目次に 13 枚の全表</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-market.jpg" width="480" alt="口上マーケット"><br><sub><b>口上マーケット</b> —— レジストリを取得し、他の作者の口上パッケージと辞書パッケージを閲覧・導入（図は CI の合成デモパッケージ）</sub></td>
  </tr>
</table>

> 4 枚の静止画は 2026-10-20 の画面です。パネルの配置は批次で動くので、実物をもって正としてください。アニメーションは該当しません（録り直せば現在の形になります）。

パネルの正確な一覧（**既定で封存**されているもの、**kojo1 封存層にしか存在しない**ものを含む）は [docs/USER-GUIDE.md](docs/USER-GUIDE.md) §6.3 にあります。「パネルが見つからない」のは文書の欠陥であって使う側の問題ではない、という方針です。

## エディタとしての土台

- **エンコーディングと改行をバイト単位で保持**：宣言されたエンコーディング（Shift-JIS / GBK / UTF-8 / UTF-16）で読み、元の EOL / BOM の形のまま書き戻す。1 行の編集がファイル全体の並べ替えにならない。
- **ゲームディレクトリは既定で読み取り専用**：実際の最初のキー入力で確認が出る。解除は**このファイル・このセッション**限定で、再起動すると保護に戻る。あなたの作品は常設の書き込み可能ワークスペースにあり、影響を受けません。
- **書き込み許可は互いに継承されない 3 経路のみ**：カーネルの `writablePaths`、`exportFile`（システムダイアログがすなわち許可）、ランチャの `launcher/approvals.json`。
- **あらゆる機能にプログラマブルな入口がある**：コマンドパレット 100+、キー変更可、デバッグ CLI は同じ経路で UI を駆動する——この文書のアニメーションは全部その経路で録った。
- **グループ分割と複数カーソル**：分割（`Ctrl+\`）、`Ctrl+1..4` フォーカス、矩形編集、行移動、`Ctrl+Shift+L` で全部追加。

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/editor-palette.gif" width="420" alt="コマンドパレット"></td>
    <td valign="middle"><b>コマンドパレット</b> <code>Ctrl+Shift+P</code><br>
    画面ができることは全部ここで検索・実行・キー変更できる（内建の 3 本は当面変更不可）。パネルが見つからないとき、メニューを漁るのは正解ではない——コマンド表と画面は同じ入口を共有している。</td>
  </tr>
</table>

<table>
  <tr>
    <td valign="middle"><b>プロジェクト全体検索</b><br>
    ヒットはファイル別にまとめる（図は 10 件 · 4 ファイル）。上の「参照の検索」と組み合わせて使う。シンボル名が分かっているなら参照、台詞の一節や断片しか覚えていないなら検索。</td>
    <td width="46%" align="center"><img src="docs/assets/editor-search.gif" width="420" alt="プロジェクト全体検索"></td>
  </tr>
</table>

## 品質の拠り所

決まりは一つ：**「直った」は必ず数値を伴う**。

- 機能プール **1,184 ファイル · 22,491 passed / 0 failed / 149 skipped**（2026-11-02 時点、skip 件数はコーパスの有無で動く）· 計時プール 31 ファイル；
- typecheck 二式（root + app）· 監査 4 種（分離 A–D / 言語面ラチェット / 生バイト / ボード）· 起動グラフの容量ゲート · Rust 側は `cargo test --lib` で別ゲート；
- プラグイン **31 枚**、era 系 **8 ゲーム**のアダプタを含む；
- 実コーパスの読み取り（熱い起動の `read+parse 0ms` / `refs scan 2ms`、メモリとコールドスタートの剖面、たたみの付き合わせ）は [docs/STATE.md](docs/STATE.md) に逐批記帳。**数値の唯一の真源はあちら**で、ここにあるスナップショットは古くなります。

## まだできないこと（正直な一覧）

踏んでから探すより、ここに書いておこうと思います：

- **`.kojo`（Kojo 2.0）は現在、編集・色付け・診断・プレビューまで**です。保存時に `.ERB` を産出する経路も、エクスポート / デプロイの転訳経路も、当面は封存層 `.kojo1` と原生 `.ERB` を対象にしています（判据は `resolveSugarTarget`）。**結果をはっきり書いておきます**：`.kojo` を含むパッケージをエクスポート / デプロイすると `.kojo` はそのままパッケージに入り、エンジンはそれを読めず、しかもエクスポートは**エラーになりません**。今すぐゲームに入れたいなら `.ERB` か `.kojo1` で新規作成してください。
- **対応は Windows 10 / 11 x64 のみ**。macOS / Linux のビルドはありません。
- **インストールパッケージにコード署名がありません**：初回起動で SmartScreen の「Windows は PC を保護しました」が出ることがあります。各 Release に `SHA256SUMS.txt` を同梱しているので、値を照合してから許可してください。署名は自動更新通道にだけ施しています。
- **プレリリース版（バージョン番号に `-` を含む）は安定版の更新通道に入りません**。Release ページから手動でダウンロードしてください。
- ERB の波線は `CASE` / `PRINTDATA` の条件を**保守的に除外**しています（既知の盲点）。`.kojo` プレビューがまだカバーしない行（ループ、`TRY`、`SIF` 分岐、データ表、代入と呼び出し）は、隠さず元の形で表示します。
- **関数インデックスは増分再構築をしません**：外で作った / 変えたファイルはファイル監視でツリーに出ますが、新しい関数は「プロジェクトをリロード」するまでインデックスに入りません。

未完了項の逐条は [docs/STATE.md](docs/STATE.md) §四 にあります。

## ソースから動かす

```bash
corepack enable && pnpm install
pnpm dev                            # フロントエンドのみ（vite、ブラウザで動く、シェルなし）
pnpm --filter @kojo/app tauri dev   # シェル開発（初回 cargo ビルドは 20〜30 分）
pnpm test                           # 両プール。pnpm typecheck / pnpm audit:decoupling も同じ
```

依存：Node.js 22 · pnpm 11.22.0（`packageManager` で固定）· Rust stable ≥ 1.77（デスクトップシェルだけ）· WebView2。
環境・検証マトリクス、プラグインと方言の接続、デモ録画、リリースの流れの完全版は **[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)**。

## ドキュメント地図

| 文書 | 用途 |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **作者向けの使い方ガイド**（実装の話はしない。現在中国語のみ） |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | 開発者手册：環境 / 検証マトリクス / 言語面の組立 / プラグインとアダプタ / デバッグと録画 / リリース |
| [AGENTS.md](AGENTS.md) | 協力の総入口：不変条件、コマンド、Git と文書の規律 |
| [docs/STATE.md](docs/STATE.md) | 基準値の唯一の真源（テスト数 / 容量 / メモリ / 性能 / コーパス / 未完了） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/adr/](docs/adr/) | 層とスロットの設計判断、決定記録 |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) · [docs/SYNTAX-SUGAR-SURFACE-SPEC.md](docs/SYNTAX-SUGAR-SURFACE-SPEC.md) | Kojo 2.0 言語仕様 · `.kojo1` 表層語法の完全仕様 |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | 新しい方言 / ゲームの接続（五歩） |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | デバッグモードの手引き + 拡張規範 |
| [docs/BOARD.md](docs/BOARD.md) · [docs/PITFALLS.md](docs/PITFALLS.md) | 作業中のボード · 落とし穴台帳 |

貢献は「批次ごとに短いブランチを一本 → `dev` の狭門を通る」形です。ブランチモデル、ゲート、コミット規約は [AGENTS.md](AGENTS.md) §四 が本体なので、着手前にこちらと [docs/PITFALLS.md](docs/PITFALLS.md) をお読みください。

## ライセンスと謝辞

[GPL-3.0-or-later](LICENSE)。リポジトリはゲーム内容を同梱しません——README のアニメーションとスクリーンショットはすべて `tools/gif-scenarios/demo-project/` と `fixtures/` の**合成サンプル**由来です。テストが使う実コーパスは、ユーザー自身が導入し許可したディレクトリで**読み取りのみ**でアクセスされます。

eraTW と era コミュニティ長年の創作に感謝します。この道具がしたのは、口伝で受け継がれてきた「命名規約」を、機械が付き合わせて相互に検証できる形に書き下しただけです。

開発者：[**Poboking**](https://github.com/Poboking) · 要望・不具合は [Issue](https://github.com/Poboking/kojo-editor/issues) へどうぞ
