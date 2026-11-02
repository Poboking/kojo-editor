# kojo-editor 开发者指南

> 这篇讲**怎么在这个仓库里干活**：跑起来要什么、改完怎么自证、语言面与插件往哪落、演示动图怎么重录、怎么落地与发版。
> README 只留门面，工程细节搬到这里。
>
> 三份文档各司其职，本文不重复它们：**[AGENTS.md](../AGENTS.md)** ＝ 铁律 / 命令 / 协作纪律的唯一入口（动手前先读）；
> **[ARCHITECTURE.md](ARCHITECTURE.md)** 与 **[adr/](adr/)** ＝ 分层、槽位与设计取舍；
> **[STATE.md](STATE.md)** ＝ 基线数字的唯一真源。
> 语言规格看 [KOJO-2.0-LANGUAGE-SPEC.md](KOJO-2.0-LANGUAGE-SPEC.md) 与 [SYNTAX-SUGAR-SURFACE-SPEC.md](SYNTAX-SUGAR-SURFACE-SPEC.md)，
> 界面怎么用看 [USER-GUIDE.md](USER-GUIDE.md)（不讲实现）。

## 1. 工程视角的它是什么

一个把「两千多份 `.ERB`、十万量级函数」的口上库变成**可导航、可校验、可回放、可改写**的结构编辑器的桌面应用。

| 维度 | 事实 |
|---|---|
| 形态 | Tauri 2 桌面壳 + Monaco 编辑器主体，Windows 10/11 x64 |
| 内核 | DI、事件总线、存储域、文件 IO、项目、槽位、工作区、计算池——**零游戏名词**（审计强制） |
| 扩展 | 插件 **31 枚**：8 个游戏适配器 + 语言面 + 领域能力 + UI 面板 |
| 规模 | 功能池 **1,179 文件 · 22,408 passed / 0 failed**（2026-11-02 档，约 145 条按语料在位与否跳过）· 计时池 31 文件 |
| 守门 | 双 typecheck · 解耦审计（A–D）· 语言面棘轮 · 裸字节体检 · 开机图体积闸 · 发版闸一条命令 |

规模与读数**逐批在动**，本表只是搬迁当日的一次快照——要以 [STATE.md](STATE.md) 为准，别把这里当账本。

## 2. 架构速览与四条铁律

```
┌──────────────────────────────────────────────────────────────┐
│ 插件层（31 枚，一切皆插件）                                   │
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

改动前默念四条铁律（`pnpm audit:decoupling` 会查，全文见 [AGENTS.md](../AGENTS.md) §2）：

1. **内核 / 契约 / Rust 宿主零游戏名词**——游戏知识只能住 adapter 插件；
2. **插件只许依赖 `@kojo/plugin-api`**——禁 import kernel、禁插件间交叉 import；
3. **写盘只有三条互不继承的授权通道**：内核 `writablePaths`、`exportFile`（系统对话框即授权）、启动器 `launcher/approvals.json`（出处 ADR-0008 决策 7）；
4. **内核不静默**——inactive 必须可见、冲突必须 error、校验规则抛错必须进 `report.failedRules`。

依赖方向是硬约束：`插件 → @kojo/plugin-api ← 内核`。插件之间不互相 import，协作走服务键与槽位。

## 3. 仓库结构

```
packages/
├── kernel/            内核：DI / 总线 / 存储域 / 文件 IO / 槽位注册表 / 计算池（零游戏知识）
├── plugin-api/        唯一公共契约包：插件类型、服务键、语言与适配器接口
├── app/               桌面壳：Tauri（Rust 宿主）+ React + Monaco + 平台桥 + 组合根
│   ├── src/monaco/    语言面装配层（定义 / 引用 / 悬停 / 签名 / 补全 / 符号 / 折叠 的 provider 注册）
│   └── src-tauri/     Rust 侧 IO 原语、窗口、启动器（cargo test --lib 独立闸）
├── kojo-core/         Kojo 2.0 语言核心：词法 / 文法 / AST / 降糖 / 诊断 / source map
├── kojo-lang/         Kojo 语言面判据与 Monaco 数据（符号树 / 声明索引 / 缩进与回车 …）
├── kojo-sdk/          语言包作者 SDK：2.0 契约形状 + 结构 worker 协议 + 语义角色表
├── kojo-vocab/        ERB / kojo1 / kojo2 共用词表与纯函数（非插件）
├── kojo-syntax-tree/  .kojo 的 tree-sitter CST 与查询
├── erb-lang/          ERB 语言面判据（同符号高亮 / 扩选 / 签名帮助）
├── erb-vocab/         ERB 引擎词表：控制流配对表与逐词分类
├── erb-syntax-tree/   ERB 行式结构的 tree-sitter CST 与折叠查询
├── kojo-conformance/  适配器一致性套件：契约自检 + DSL→ERB 黄金 + 差分 + 编码/换行保持
├── kojo-project-kit/  口上项目工作流共享实现（新建 / 导入 / 部署 / 发布向导）
└── plugins/           31 枚插件，按职责分四族（见下）
```

`packages/plugins/` 四族（名单以磁盘目录为准，由审计脚本派生，不手工维护）：

| 族 | 目录 |
|---|---|
| 游戏适配器（8） | `eratw-` `erafl-` `erakoumakan-` `erasqc-` `eratohok-` `eratohoreverse-` `eraav-` `eraakumamaid-adapter` |
| 语言面 | `erb-parser` `erb-lang` `kojo-lang` `kojo-sugar` `inline-completion-local` |
| 领域能力 | `condition-extractor` `convention-linter` `sav-parser` `state-replay` `kojo-market` `launcher-core` |
| UI 面板（12） | `ui-kojo-navigator` `ui-kojo-xml` `ui-condition-matrix` `ui-convention-report` `ui-sugar-editor` `ui-sugar-lift` `ui-sugar-preview` `ui-state-replay` `ui-snapshot-injector` `ui-archive-browser` `ui-market` `ui-plugin-status` |

配套目录：`docs/`（架构、状态、看板、踩坑、ADR）、`tools/`（审计 / 发版闸 / 调试 / 量具 / 冒烟 / GIF 录制）、`fixtures/`（脱敏口上样本）、`skills/kojo-debug/`（调试模式上手 skill）。

## 4. 环境与启动

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

无桌面会话时也能开发界面：`node tools/debug-cli.mjs serve` 会拉起「调试宿 + vite + 浏览器(CDP)」并打印编辑器 URL（详见 §8）。

两个开发机上的已知抖动：

- 首次 `tauri dev` 可能出现一次 vite「Re-optimizing dependencies」导致的页面重载（会回到欢迎页），再开一次工程即稳定；
- 若 `localhost:1420` 被上一次没退干净的 vite 占着，`tauri dev` 会直接失败退出，并把**已经在跑的编辑器窗口一起带走**——启动前先确认该端口空闲。

## 5. 验证矩阵

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

带环境变量跑 vitest 一律 `node node_modules/vitest/vitest.mjs run <file>`——`npx vitest` 会吞环境变量（见 [PITFALLS.md](PITFALLS.md)）。

发版闸把机器面收成一条命令，逐项给读数并统一给 `RESULT: PASS|FAIL`：

```bash
node tools/release-gate.mjs --skip-tests        # CI 快速档：双 typecheck + 审计 + conformance
node tools/release-gate.mjs --release --json    # 发版档：另加 version-sync / 两池 / artifact-audit / cargo
```

Rust 侧（改了 `src-tauri` 才跑，**必须经 node 起**，Git-Bash 的 `TMP` 会让 MSVC 链接报 LNK1104）：

```bash
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
```

真实语料 / 桌面壳冒烟（语料目录名会变，也可能整目录暂离，**先探针再跑**；挂空串会让 setup 全崩）：

```bash
node tools/corpus.mjs --print        # rc=0 才继续；不在位就跳过挂语料那档
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts

node tools/smoke-tauri-dom.mjs       # DOM 冒烟（弹窗约 100s 自动关）
node tools/smoke-tauri-ipc.mjs       # 真实 IPC 双闸（自动还原 store / 文件 / 备份）
node tools/debug-web-smoke.mjs       # 无头浏览器端到端
```

并行开发期跑全量**必须限并发**（满载机上的 20s 超时多为负载假红，先 `--maxWorkers=8` 复跑再判红，见 [PITFALLS.md](PITFALLS.md)）。

## 6. 语言面：判据住哪、宿主只做装配

README 的能力表只列「有什么能力 + 缺省键位」；**代码位置**在这一节。判据一律住库包（纯函数、零 Monaco / 零 React / 零 IO），宿主只在 `packages/app/src/monaco/` 装配成 provider 并经槽位交出来。

| 能力 | 判据 / 装配在哪 |
|---|---|
| 跳转定义（跨文件） | `packages/app/src/monaco/kojo-definition.ts` ← 索引供方 |
| 速览定义 · 跳到实现 | Monaco 内建，接同一批 provider |
| 查找引用（peek + 跨文件计数） | `packages/app/src/monaco/find-references.ts`（判据在 `@kojo/plugin-erb-parser` 的 `erbReferencesAt`） |
| 悬停文档 | `packages/app/src/monaco/kojo-hover.ts` |
| 参数提示 | `packages/app/src/monaco/kojo-signature.ts` + `@kojo/erb-lang/signature` |
| 补全 | `packages/app/src/monaco/erb-completion*.ts` · `@kojo/plugin-inline-completion-local` |
| 实时校验 | `packages/plugins/convention-linter` → `packages/app/src/monaco/slot-service-providers.ts` |
| 重命名符号 | Monaco 内建 + 语言侧 rename 供方（ERB 侧**不收敛**，双挂障碍钉在 `rename-dualleg.test.ts`） |
| 文档符号 / 转到本文件符号 | `packages/app/src/monaco/kojo-symbols.ts` |
| 同符号高亮 · 扩选 · code lens | `erb-highlight.ts` · `erb-selection-range.ts` · `kojo-code-lens.ts` |
| 折叠 | `kojo-folding.ts` + `erb-syntax-tree` / `kojo-syntax-tree`（tree-sitter CST） |

三条口径：

- **语言分层**：ERB（引擎原生）/ kojo 1.0（`.kojo1`，封存层）/ kojo 2.0（`.kojo`，当前通道）三档并存，同一套槽位供方。扩展名**只看后缀不看档位**：`.kojo` / `.kojo2` 归 2.0，`.kojo1` 归封存层，`.erb` 永远按原样。
- **新增一格语言能力**：判据落库包，宿主只装配；别往宿主塞 `if (languageId === …)` 分支（`audit:language` 的 M2 在数这个，基线只降不升）。
- **加一枚 descriptor，不加一条分支**：新语言接入走 §七。

## 7. 插件与适配器开发

- **加一个插件**：`packages/plugins/<name>/` + `package.json`（名 `@kojo/plugin-<name>`）+ 导出 `Plugin` 描述符（`requires` / 贡献点）；UI 走 `ui.panel` 槽，语言服务走 `services.slot` 声明。
- **加一个游戏**：不碰内核，只加 adapter 插件。一条命令生成骨架、清单条目、依赖与路径别名（四处散点由工具代改，`adapter-manifest.test.ts` 双向自证）：

  ```bash
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
  ```

  五步流程与边界见 [DIALECT-AUTHORING.md](DIALECT-AUTHORING.md)，一致性套件见 `@kojo/kojo-conformance`（契约自检 + DSL→ERB 黄金 + 差分 + 编码/换行保持）。
- **动别人模块前**先 `git log --oneline -- <path>` 看最近一批是谁的；跨模块需求走 **additive 契约**（旧消费方零改动）。冲突热点 `EditorPane.tsx` / `styles.css` / `sugar-view.ts`——同文件多次编辑**串行**，改完读回。

## 8. 调试模式与演示录制

多 agent 并行开发的主要验证通道是调试模式（无桌面壳也能验 UI / 命令 / 事件 / 语义读数）：

```bash
node tools/debug-cli.mjs serve        # 调试宿 + vite + 浏览器(CDP)，打印编辑器 URL（--headless 无头）
node tools/debug-cli.mjs shell        # 真桌面壳 + CDP（启动相位 / 无边框 / 窗口几何只能这样验）
node tools/debug-cli.mjs <子命令>     # open-project / open-file / commands/run / state / dom / events
                                      # eval / invoke / click / type / key / screenshot / status / stop
node tools/debug-cli.mjs definition 18 10   # 语义读数：定义 / 引用 / 代码动作 / 签名 / 符号 / 诊断
```

**README 首屏那六枚动图都由这条通道录制**，可重放：

```bash
node tools/debug-cli.mjs serve --headless     # 1) 起会话
node tools/readme-gif.mjs list                # 2) 看场景清单
node tools/readme-gif.mjs record all --max-kb 1500 --keyframes 3
```

场景是 `tools/gif-scenarios/*.json` 里的声明式步骤（真键盘 / 真鼠标 / 命令面板 / 语义读数）；每枚录前把演示工程重置成同一份已知起点，帧走 CDP 连续采样、编码走 ffmpeg 两段调色板，录完报帧数 / 时长 / 尺寸 / 字节；`--keyframes` 导等间隔帧供逐枚读图验收，`probe` 只跑动作不采帧。中间产物落 `%TEMP%/kojo-gif/`，仓库只留最终 `.gif`（现为 1100×564）。读数回查钉在 `tools/tests/readme-gif.test.ts`（`setInput` 回读框内值、`unlock` 回读解锁徽标、`waitExpr` 禁用 `?.x !== null` 恒真写法）。

演示工程 `tools/gif-scenarios/demo-project/` 全为合成样本，不含任何游戏内容。

调试模式的使用手册与扩展规范唯一真源：[DEBUG-MODE.md](DEBUG-MODE.md)——**扩展前必读其 §五**。上手 skill 随仓走：`skills/kojo-debug/SKILL.md`。

## 9. 贡献流程

分支模型（2026-10-19 起，`master` 已删除，远端默认分支 `main`）：

- `dev` ＝ 日常落地分支，一般功能 / 修复 / 文档批都进这里；
- `main` ＝ 发行版分支，**只在发版时更新**（并入已判可发的 dev 提交 → 打 tag `v*`）；
- 一个 agent 一个工作树；一个批次一条短命分支 `b/<agent>/<MMDD>-<slug>`，从 `origin/dev` 起，**不在本地 `dev` / `main` 上直接提交**。

落地即过窄门：

```bash
git fetch origin --prune
git rebase origin/dev
# 门槛全绿（见 §五；纯文档批豁免测试面）
git push origin HEAD:dev
```

非快进被拒就是并发协议本身——重跑 fetch + rebase 再推；**永不** force 到 `dev` / `main`。提交信息用 Conventional Commits + 中文标题；禁 `git add -A`（逐文件 add）、禁共享树里 `stash`；rebase 解冲突逐文件 add 并 `git diff --cached` 过目，提交后全仓扫冲突标记。

github 直连时通时断 ⇒ 给本 clone 配 repo 本地代理（`git config http.proxy <本机代理>`，**永不改全局配置**）；推送反复失败时兜底 `node tools/git-push.mjs`（默认目标已是 `dev`）。

文档纪律：只写「认领」与「交付」两件事——认领在 [BOARD.md](BOARD.md) 写一行，交付把读数与取舍写进提交信息；硬坑一行一条进 [PITFALLS.md](PITFALLS.md)，基线真变了才改 [STATE.md](STATE.md)。

## 10. 发版

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

发版判据：人工面见 [MANUAL-CHECKLIST-v0.4.0-beta.1.md](MANUAL-CHECKLIST-v0.4.0-beta.1.md)，机器面＝`node tools/release-gate.mjs --release`（读数口径见 [STATE.md](STATE.md)）。自动更新签名密钥在构建机 `%USERPROFILE%\.tauri\kojo-editor.key`，**永不入库**；CI Secret ＝ 密钥文件原样单行 base64。

## 11. 文档地图（开发向）

| 文档 | 用途 |
|---|---|
| [../AGENTS.md](../AGENTS.md) | **一切 agent 的第一入口**：铁律、命令、协作与 Git 纪律 |
| [STATE.md](STATE.md) | 基线数字唯一真源（测试数 / 体积 / 内存 / 性能 / 语料） |
| [BOARD.md](BOARD.md) | 在办看板：认领前先读，交付即删行 |
| [PITFALLS.md](PITFALLS.md) | 硬坑台账（写盘 / 探针 / 多 agent / 构建），动手前扫一眼 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层、槽位、核心接口、技术决策 |
| [adr/](adr/) | 架构决策记录（工具链、宿主、授权模型、插件源工程 …） |
| [DEBUG-MODE.md](DEBUG-MODE.md) | 调试模式手册 + 扩展规范 |
| [DIALECT-AUTHORING.md](DIALECT-AUTHORING.md) | 新方言 / 新游戏接入 |
| [LAUNCHER-ARCHITECTURE.md](LAUNCHER-ARCHITECTURE.md) | 启动器设计提案（现行待评审稿） |
| [KOJO-2.0-LANGUAGE-SPEC.md](KOJO-2.0-LANGUAGE-SPEC.md) | Kojo 2.0 语言规格 |
| [SYNTAX-SUGAR-SURFACE-SPEC.md](SYNTAX-SUGAR-SURFACE-SPEC.md) | `.kojo1` 表层语法完整规格 |
| [USER-GUIDE.md](USER-GUIDE.md) | 给作者的使用手册（不讲实现） |
| [../README.md](../README.md) | 门面：演示、三类读者入口、能力一览、边界 |
