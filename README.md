<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

**简体中文** | [English](README_EN.md) | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**给 era 系口上脚本（`.ERB` / `.kojo`）的结构感知 IDE。**
Tauri 2 壳（Rust 只做 IO 原语）+ React 19 + Monaco，pnpm monorepo。
**内核零游戏知识，一切皆插件。**

</div>

| 跳转定义 `F12`（跨文件） | 查找引用 `Shift+F12`（peek 分组计数） |
|---|---|
| ![跳转定义](docs/assets/erb-definition.gif) | ![查找引用](docs/assets/erb-references.gif) |
| 补全（输入即弹，按名槽出货） | 全工程检索（10 条 · 4 文件） |
| ![补全](docs/assets/erb-completion.gif) | ![全工程检索](docs/assets/editor-search.gif) |
| 命令面板（100+ 条可改绑） | 折叠（tree-sitter CST 给区间） |
| ![命令面板](docs/assets/editor-palette.gif) | ![折叠](docs/assets/editor-folding.gif) |

> 演示数据全为合成样本（`tools/gif-scenarios/demo-project/`），重录命令见 §十。

---

- 下载直接用：[Releases](https://github.com/Poboking/kojo-editor/releases/latest) · 操作手册：[docs/USER-GUIDE.md](docs/USER-GUIDE.md)
- 协作前必读：[AGENTS.md](AGENTS.md)（铁律 / 命令 / 协作纪律）

## 一、为什么不是"再加一个语法高亮"

ERB 是 1998 年时代的行式脚本：没有 LSP、没有 AST 工具链、没有包管理，一个真实工程 **3,971 份方言文件 / 110,049 个函数定义**（实测口径见 [docs/STATE.md](docs/STATE.md)），口上函数靠**命名约定**互相调用（`M_KOJO_{角色}_MESSAGE_COM_{指令}`），一个角色改一处、调用散在全工程。

所以这里要的不是高亮，是一整套 IDE 面：**索引 → 符号 → 引用 → 诊断 → 改写**。本项目把它做成三层可审计的东西：判据住库包（纯函数、零 Monaco、零 IO）、宿主只做装配与翻译、游戏知识只能住适配器插件（`pnpm audit:decoupling` 与 `pnpm audit:language` 双向守门）。

## 二、ERB 语言支持

> 键位是缺省值，全部可在应用内「键位」页改；下表判据列指**代码位置**。

| 能力 | 缺省键位 | 判据 / 装配在哪 |
|---|---|---|
| 跳转定义（跨文件） | `F12` | `packages/app/src/monaco/kojo-definition.ts` ← 索引供方 |
| 速览定义（就地展开不切走） | `Alt+F12` | Monaco 内建，接同一批 provider |
| 跳到实现 | `Ctrl+F12` | 同上 |
| 查找引用（peek 浮窗 + 跨文件计数） | `Shift+F12` | `packages/app/src/monaco/find-references.ts` |
| 悬停文档（作者注释 + 形参表 + 定义落点） | `Ctrl+K Ctrl+I` | `packages/app/src/monaco/kojo-hover.ts` |
| 参数提示（当前参数位高亮） | `Ctrl+Shift+Space` | `packages/app/src/monaco/kojo-signature.ts` |
| 补全（触发字符 `#` `[` `@` `$` `.`） | `Ctrl+Space` / 输入即弹 | `packages/app/src/monaco/erb-completion*.ts` |
| 实时校验（波浪线 + 问题面板 + 状态栏计数） | `Ctrl+Shift+M` 面板 · `Alt+F8` 逐条 | `packages/plugins/convention-linter` → `packages/app/src/monaco/slot-service-providers.ts` |
| 重命名符号（跨文件一起改） | `F2` | Monaco 内建，接语言侧 rename 供方 |
| 文档符号 / 转到本文件符号 | `Ctrl+Shift+O` | `packages/app/src/monaco/kojo-symbols.ts` |
| 同符号高亮 · 扩选 · code lens | `Ctrl+D` / `Shift+Alt+→` / 行内 | `erb-highlight.ts` · `erb-selection-range.ts` · `kojo-code-lens.ts` |
| 折叠（按函数体 / 区块） | 编辑器左侧折叠条 | `kojo-folding.ts` + `erb-syntax-tree`（tree-sitter CST） |

跳转定义读的是**跨文件**的函数索引（不是当前文件内的文本匹配）；查找引用给的是 peek 浮窗按文件分组的命中数；补全的候选按**名槽**出货——台词、旁白、注释、字符串段里不弹，不是把词表全量糊上去。

## 三、编辑器能力

- **一切能力都有可编程入口**：命令面板注册表 100+ 条（`Ctrl+Shift+P`），键位页可改绑；调试 CLI 用同一条腿驱动界面（§十）。
- **多编辑器组**：向右 / 向下拆分（`Ctrl+\`）、上下左右排列、`Ctrl+1..4` 聚焦、放大缩小焦点组。
- **多光标与列编辑**：`Ctrl+D` 逐个加、`Ctrl+Shift+L` 一次全加、`Ctrl+Alt+↑/↓` 列光标、`Alt+↑/↓` 移行、`Ctrl+Shift+K` 删行。
- **编码与换行保持**：读取按声明编码（Shift-JIS / GBK / UTF-8），写回**逐字节保持**原文件的 EOL 与 BOM 形态——改一行不会把整份文件的重排掉。
- **只读保护**：游戏目录里的文件默认只读，第一次真键入弹确认；解锁只在**这一份文件、这一次会话**有效，重启回到默认只读。
- **写盘只有三条互不继承的授权通道**：内核 `writablePaths`、`exportFile`（系统对话框即授权）、启动器 `launcher/approvals.json`。

面向口上作者的成品面板（状态注入 / 口上市场 / 存档浏览 / 语法糖编辑器 / 条件矩阵 / 部署向导）是插件，见 [docs/USER-GUIDE.md](docs/USER-GUIDE.md)。

## 四、它是怎么做到的

| 面 | 做法 |
|---|---|
| 语言分层 | **ERB**（引擎原生）/ **kojo 1.0**（旧表层）/ **kojo 2.0**（当前通道）三档并存，同一套槽位供方；新增语言 = 加一枚 descriptor，不往宿主塞 `if (languageId === …)` 分支（`audit:language` 的 M2 在数这个） |
| 结构与折叠 | `packages/erb-syntax-tree` / `packages/kojo-syntax-tree` 各一枚 tree-sitter CST，折叠与结构视图都从 CST 来，不靠正则数 `IF/ENDIF` |
| 索引 | 项目级索引扫**整棵 ERB 子树**（口上根 + 只读基座库经祖先折叠成同一个扫描根），产出函数名录 / 引用流水 / 形参与 `#DIM` 声明；快照落盘、热载走快照（真语料实测：热载 `read+parse 0ms`、`refs scan 2ms`） |
| 诊断 | `convention-linter` 插件出规则，文案统一翻成人话并写**引擎后果**；规则抛错必须进 `report.failedRules`（内核不静默） |
| 性能 | 计算走自有 worker 池（结构层已并入单 worker 池）；冷开剖面与内存读数逐批记账在 [docs/STATE.md](docs/STATE.md) |
| 规模 | 功能池 **1,170 文件 · 22,281 passed / 0 failed**（约 143 条按语料在位与否跳过）· 计时池 31 文件 · 双 typecheck · 四份审计 · 31 枚插件 |

基线数字（测试数 / 体积闸 / 内存 / 冷开 / 语料）一律以 [docs/STATE.md](docs/STATE.md) 为准。

## 五、架构速览

```
┌──────────────────────────────────────────────────────────────┐
│ 插件层（31 个，一切皆插件）                                   │
│  game adapter × 8 │ 语言面（ERB / kojo 1.0 / 2.0）│ UI 面板    │
│  市场 · 存档解析 · 状态回放 · 语法糖 · 校验 · 条件抽取 …      │
├──────────────────────────────────────────────────────────────┤
│ 槽位注册表（UI 与扩展点；同槽允许多注册，冲突必须报 error）   │
├──────────────────────────────────────────────────────────────┤
│ 内核（通用设施，零游戏知识）                                  │
│ DI │ 事件总线 │ 存储域 │ 文件 IO │ 项目 │ 槽位 │ 工作区 │ 计算池 │
├──────────────────────────────────────────────────────────────┤
│ Tauri 2 Rust 宿主：只做 IO 原语 / 窗口 / 启动器，零业务逻辑    │
└──────────────────────────────────────────────────────────────┘
```

改动前默念四条铁律（`pnpm audit:decoupling` 会查，细节见 [AGENTS.md](AGENTS.md) §二）：

1. **内核 / 契约 / Rust 宿主零游戏名词**——游戏知识只能住 adapter 插件；
2. **插件只许依赖 `@kojo/plugin-api`**——禁 import kernel、禁插件间交叉 import；
3. **写盘只有三条互不继承的授权通道**（§三末条）；
4. **内核不静默**——inactive 必须可见、冲突必须 error、校验规则抛错必须进 `report.failedRules`。

设计取舍全景见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/adr/](docs/adr/)。

## 六、仓库结构

```
packages/
├── kernel/            内核：DI / 总线 / 存储域 / 文件 IO / 槽位注册表 / 计算池（零游戏知识）
├── plugin-api/        唯一公共契约包：插件类型、服务键、语言与适配器接口
├── app/               桌面壳：Tauri（Rust 宿主）+ React + Monaco + 平台桥 + 组合根
│   ├── src/monaco/    语言面装配层（定义 / 引用 / 悬停 / 签名 / 补全 / 符号 / 折叠 的 provider 注册）
│   └── src-tauri/     Rust 侧 IO 原语、窗口、启动器（cargo test --lib 独立闸）
├── kojo-core/         Kojo 2.0 语言核心：词法 / 文法 / AST / 降糖 / 诊断 / source map
├── kojo-lang/         Kojo 语言面判据与 Monaco 数据（符号树 / 声明索引 / 缩进与回车 …）
├── erb-lang/          ERB 语言面判据（同符号高亮 / 扩选 / 签名帮助）
├── erb-vocab/         ERB 引擎词表：控制流配对表与逐词分类
├── erb-syntax-tree/   ERB 行式结构的 tree-sitter CST 与折叠查询
├── kojo-syntax-tree/  .kojo 的 tree-sitter CST 与查询
├── kojo-sdk/          语言包作者 SDK：2.0 契约形状 + 结构 worker 协议 + 语义角色表
├── kojo-vocab/        ERB / kojo1 / kojo2 共用词表与纯函数（非插件）
├── kojo-conformance/  适配器一致性套件：契约自检 + DSL→ERB 黄金 + 差分 + 编码/换行保持
├── kojo-project-kit/  口上项目工作流共享实现（新建 / 导入 / 部署 / 发布向导）
└── plugins/           31 个插件：8 游戏适配器 + 语言面 + 领域能力 + UI 面板
```

`packages/plugins/` 按职责分四族：

| 族 | 目录 |
|---|---|
| 游戏适配器（8） | `eratw-` `erafl-` `erakoumakan-` `erasqc-` `eratohok-` `eratohoreverse-` `eraav-` `eraakumamaid-adapter` |
| 语言面 | `erb-parser` `erb-lang` `kojo-lang` `kojo-sugar` `inline-completion-local` |
| 领域能力 | `condition-extractor` `convention-linter` `sav-parser` `state-replay` `kojo-market` `launcher-core` |
| UI 面板（12） | `ui-kojo-navigator` `ui-kojo-xml` `ui-condition-matrix` `ui-convention-report` `ui-sugar-*` `ui-state-replay` `ui-snapshot-injector` `ui-archive-browser` `ui-market` `ui-plugin-status` |

配套目录：`docs/`（架构、状态、看板、踩坑、ADR）、`tools/`（审计 / 发版闸 / 调试 / 量具 / 冒烟 / GIF 录制）、`fixtures/`（脱敏口上样本）、`skills/kojo-debug/`（调试模式上手 skill）。

## 七、环境与启动

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22 | CI 与 release 同版本 |
| pnpm | 11.22.0 | 由 `packageManager` 字段固定，用 `corepack enable` 装 |
| Rust | stable ≥ 1.77 | 仅桌面壳需要；MSVC 工具链 |
| WebView2 | 系统自带 | Windows 11 预装，Win10 需运行时 |

```bash
corepack enable
pnpm install

pnpm dev                            # 只起前端（vite，浏览器里跑，无桌面壳）
pnpm --filter @kojo/app tauri dev   # 桌面壳开发（首次 cargo 编译约 20–30 分钟）
pnpm --filter @kojo/app build       # 前端产物
pnpm --filter @kojo/app tauri build # 安装包（NSIS + updater 产物）
```

无桌面会话时也能开发界面：`node tools/debug-cli.mjs serve` 会拉起「调试宿 + vite + 浏览器(CDP)」并打印编辑器 URL。

## 八、验证矩阵

**验收口径：任何「改好了」都必须带数**——测试数不许回退、双 typecheck 为 0、审计全绿。

```bash
pnpm test                    # 两池全量（功能池 + 计时池；跑全量别设 KOJO_SMOKE_PROJECT）
pnpm test:unit               # 只跑功能池（并行）
pnpm test:perf               # 只跑计时池（串行静默池，别和功能池混跑）

pnpm typecheck                       # root
pnpm --filter @kojo/app typecheck    # app（两套都算数）

pnpm audit:decoupling        # 「一切皆插件」解耦审计：A–D 四项 + 31 插件计数
pnpm audit:language          # 语言面棘轮：M1 游戏名 / M2 语言 id 分支 / M3 旧 token
pnpm audit:bytes             # 裸字节体检：NUL / BOM / 非法 UTF-8 / 孤立 CR
pnpm audit:board             # 看板结构与引用自检
```

发版闸把机器面收成一条命令，逐项给读数并统一给 `RESULT: PASS|FAIL`：

```bash
node tools/release-gate.mjs --skip-tests        # CI 快速档：双 typecheck + 审计 + conformance
node tools/release-gate.mjs --release --json    # 发版档：另加 version-sync / 两池 / artifact-audit / cargo
```

Rust 侧（改了 `src-tauri` 才跑，**必须经 node 起**，Git-Bash 的 `TMP` 会让 MSVC 链接报 LNK1104）：

```bash
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
```

真实语料 / 桌面壳冒烟（语料目录名会变，也可能整目录暂离，先探针再跑）：

```bash
node tools/corpus.mjs --print        # rc=0 才继续；不在位就跳过挂语料那档
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts

node tools/smoke-tauri-dom.mjs       # DOM 冒烟
node tools/smoke-tauri-ipc.mjs       # 真实 IPC 双闸（自动还原 store / 文件 / 备份）
node tools/debug-web-smoke.mjs       # 无头浏览器端到端
```

## 九、插件与适配器开发

**依赖方向是硬约束**：`插件 → @kojo/plugin-api ← 内核`。插件之间不互相 import，协作走服务键与槽位。

- **加一个插件**：`packages/plugins/<name>/` + `package.json`（名 `@kojo/plugin-<name>`）+ 导出 `Plugin` 描述符（`requires` / 贡献点）；UI 走 `ui.panel` 槽，语言服务走 `services.slot` 声明。
- **加一个游戏**：不碰内核，只加 adapter 插件。一条命令生成骨架、清单条目、依赖与路径别名（四处散点由工具代改，`adapter-manifest.test.ts` 双向自证）：

  ```bash
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
  ```

  方言作者手册见 [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md)，一致性套件见 `@kojo/kojo-conformance`。
- **新增一格语言能力**：判据落库包（纯函数、零 Monaco / 零 React / 零 IO），宿主只在 `packages/app/src/monaco/` 装配成 provider 并经槽位交出来；别往宿主塞语言 id 分支（`audit:language` 的 M2 会数）。

## 十、调试模式与演示录制

多 agent 并行开发的主要验证通道是调试模式（无桌面壳也能验 UI / 命令 / 事件 / 语义读数）：

```bash
node tools/debug-cli.mjs serve        # 调试宿 + vite + 浏览器(CDP)，打印编辑器 URL
node tools/debug-cli.mjs shell        # 真桌面壳 + CDP（启动相位 / 无边框 / 窗口几何只能这样验）
node tools/debug-cli.mjs <子命令>     # open-project / open-file / commands/run / state / dom / events
                                      # eval / invoke / click / type / key / screenshot / status / stop
node tools/debug-cli.mjs definition 18 10   # 语义读数：定义 / 引用 / 代码动作 / 签名 / 符号 / 诊断
```

**本 README 的动图都由这条通道录制**，可重放：

```bash
node tools/debug-cli.mjs serve --headless     # 1) 起会话
node tools/readme-gif.mjs list                # 2) 看场景清单
node tools/readme-gif.mjs record all --max-kb 1500 --keyframes 3
```

场景是 `tools/gif-scenarios/*.json` 里的声明式步骤（真键盘 / 真鼠标 / 命令面板 / 语义读数）；每枚录前把演示工程重置成同一份已知起点，帧走 CDP 连续采样、编码走 ffmpeg 两段调色板，录完报帧数 / 时长 / 尺寸 / 字节；`--keyframes` 导等间隔帧供逐枚读图验收，中间产物落 `%TEMP%/kojo-gif/`，仓库只留最终 `.gif`。`probe` 子命令只跑动作不采帧。读数回查钉在 `tools/tests/readme-gif.test.ts`（`setInput` 回读框内值、`unlock` 回读解锁徽标、`waitExpr` 禁用 `?.x !== null` 恒真写法）。

使用手册与扩展规范唯一真源：[docs/DEBUG-MODE.md](docs/DEBUG-MODE.md)（扩展前必读 §五）。

## 十一、文档地图

| 文档 | 用途 |
|---|---|
| [AGENTS.md](AGENTS.md) | **一切 agent 的第一入口**：铁律、命令、协作与 Git 纪律 |
| [docs/STATE.md](docs/STATE.md) | 基线数字唯一真源（测试数 / 体积 / 内存 / 性能 / 语料） |
| [docs/BOARD.md](docs/BOARD.md) | 在办看板：认领前先读，交付即删行 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 硬坑台账（写盘 / 探针 / 多 agent / 构建），动手前扫一眼 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、槽位、核心接口、技术决策 |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) | Kojo 2.0 语言规格 |
| [docs/adr/](docs/adr/) | 架构决策记录（工具链、宿主、授权模型、插件源工程 …） |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | 调试模式手册 + 扩展规范 |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | 新方言 / 新游戏接入 |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **给作者的使用手册**（不讲实现） |

## 十二、贡献流程

分支模型（2026-10-19 起，`master` 已删除，远端默认分支 `main`）：

- `dev` ＝ 日常落地分支，一般功能 / 修复 / 文档批都进这里；
- `main` ＝ 发行版分支，**只在发版时更新**（并入已判可发的 dev 提交 → 打 tag `v*`）；
- 一个 agent 一个工作树；一个批次一条短命分支 `b/<agent>/<MMDD>-<slug>`，从 `origin/dev` 起，**不在本地 `dev` / `main` 上直接提交**。

落地即过窄门：

```bash
git fetch origin --prune
git rebase origin/dev
# 门槛全绿（见 §八）
git push origin HEAD:dev
```

非快进被拒就是并发协议本身——重跑 fetch + rebase 再推；**永不** force 到 `dev` / `main`。提交信息用 Conventional Commits + 中文标题；禁 `git add -A`（逐文件 add）、禁共享树里 `stash`。

文档纪律：只写「认领」与「交付」两件事——认领在 `docs/BOARD.md` 写一行，交付把读数与取舍写进提交信息；硬坑一行一条进 `PITFALLS.md`，基线真变了才改 `STATE.md`。

## 十三、发版

```bash
# 1. 三处 version 逐字相等（app-version.test.ts 钉住）
#    package.json / packages/app/package.json / packages/app/src-tauri/tauri.conf.json
# 2. 机器面全绿
node tools/release-gate.mjs --release --json
# 3. dev 已判可发的提交并入 main，打 tag（release.yml 由 tag 触发）
git checkout main && git merge --ff-only <已判可发的提交> && git tag v0.4.2
git push origin main --tags
```

`release.yml` 产出：NSIS 安装包、绿色版 `portable.zip`、updater 产物（`latest.json` + 签名包）与 `SHA256SUMS.txt`。发布前它自己会先跑一遍快速闸（`--only=version-sync,typecheck-root,typecheck-app,audit,conformance`），rc≠0 就不构建。

## 十四、许可与致谢

[GPL-3.0-or-later](LICENSE)。仓库不内置任何游戏内容——README 动图与测试所需的口上文件要么是 `fixtures/` / `tools/gif-scenarios/` 的**合成样本**，要么来自本机已安装、由用户自行授权的游戏目录。

感谢 eraTW 及整个 era 社区多年来的创作积累。

开发者：[**Poboking**](https://github.com/Poboking)
