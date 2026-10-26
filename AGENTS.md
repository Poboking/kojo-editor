# AGENTS.md — kojo-editor 协作总入口

> 面向 eraTW（及后续 era 系游戏）口上作者的结构感知编辑器。
> pnpm monorepo：Tauri2 壳（Rust 只做 IO 原语）+ React 19 + Monaco；内核零游戏知识；一切皆插件（22 插件）。
> 本文件 = 一切 agent 的第一入口。架构全景 `docs/ARCHITECTURE.md`；用户面 `docs/USER-GUIDE.md`。

## 一、必读顺序（按需，别全读）

1. 本文件（铁律 + 命令 + 协作纪律）
2. `docs/STATE.md` —— 基线数字 / 环境路径 / 剩余欠账（**读数字从这拿，别信记忆**）
3. `docs/BOARD.md` —— 在办看板：认领前先读，开工先改状态
4. 按需：`docs/PITFALLS.md`（写盘 / 探针 / 多 agent 前扫一眼）
5. 历史冻结在 `docs/archive/`（**只读**，不再追加）；本批新记录写 `docs/log/`，一行为一条

## 二、架构铁律（改动前默念，`pnpm audit:decoupling` 会查）

1. 内核 / 契约 / Rust 宿主**零游戏名词**（audit A；行尾 `// audit-allow: <理由>` 可豁免。**裸 `sav` 一词也在黑名单**：`savDir` 这类复合词不匹配、裸 `'sav'` 会挂）；
2. 插件**只许依赖 `@kojo/plugin-api`**：禁 import kernel、禁插件间交叉 import（audit B/C；测试文件豁免 C）；
3. 游戏知识只能进 eratw-adapter；跨游戏共享术语（kojo / chara）放 plugin-api；
4. 内核不静默：inactive 必须可见、冲突必须 error、校验规则抛错必须进 `report.failedRules`；
5. 游戏目录整体只读，写入仅限用户批准的 `writablePaths`（内核 io 强制）+ **常驻可写根**（作者工作区，不受项目开闭清空）；
6. **绕开写允许域只有一条法定通道**：`exportFile` —— 落点由系统对话框显式选定（对话框即授权），对话框与写盘绑在同一个 Rust 命令内。新增"写到域外"的能力必须照此形态，**不得开放任意目标路径参数**；
7. **启动器写授权是第三张表**，与内核 `writablePaths`、`exportFile` **互不继承**：实例 × `rootId` 逐根授权只由原生目录对话框写入 `launcher/approvals.json`（对话框与登记同一 Rust 命令）；启动器安装 / 恢复前必须复验目标落在已授权根内；JS 不拿落点决定权，也不得把游戏根写进内核 `writablePaths`（出处 ADR-0008 决策 7）。

## 三、开跑命令（验证矩阵）

```bash
pnpm install
pnpm test                 # 全量（当前基线见 STATE.md；跑全量不要设 KOJO_SMOKE_PROJECT）
pnpm typecheck            # root；app 另跑：pnpm --filter @kojo/app typecheck（两套都算数）
pnpm audit:decoupling     # 必须 ✅（22 插件；A–D 四项）
# 改了 Rust 才加跑（cargo 须经 node 起，Git-Bash TMP 坑见 PITFALLS）：
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
# 真实语料集成冒烟（语料目录名会变、也可能整目录暂离 ⇒ **先 `node tools/corpus.mjs --print` 确认 rc=0**，
# 语料不在位就跳过这条（挂空串会让 setup 全崩、152 文件全红）；以 KOJO_CORPUS_DIR 为准，解析见 tools/corpus.mjs；行号/文件名以仓库现状为准）：
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts
# 桌面壳冒烟：
node tools/smoke-tauri-dom.mjs   # DOM 冒烟（弹窗 ~100s 自动关）
node tools/smoke-tauri-ipc.mjs   # 真实 IPC 双闸 a–e（不传参即按内容自动发现语料目录——名字会变，以 KOJO_CORPUS_DIR 为准；也可 "C:\path\to\语料" 显式传；自动还原 store/文件/备份；~2min）
# 编辑器调试模式（2026-10-24 调试模式批）——多 agent 无桌面壳的体感/UI/功能验证通道：
node tools/debug-cli.mjs serve   # 拉起「调试宿+vite+浏览器(CDP)」，打印编辑器 URL（agent 内置浏览器直接开；--headless 无头）
node tools/debug-cli.mjs shell   # 起一台**真桌面壳**带 CDP——启动相位/无边框/窗口几何这类壳专属改动 Web 宿复现不了，用这个验
node tools/debug-cli.mjs <子命令> # open-project <目录> [--writable] · open-file <片段> · commands/run <id>（命令面板全量入口）· state · dom · events · eval · invoke · click/type/key · screenshot <png> · status · stop
node tools/debug-web-smoke.mjs   # 无头浏览器端到端冒烟（欢迎页→开项目→开文件→Monaco→命令表→事件→截图；没浏览器 rc=2）
# 调试模式的使用手册 + 开发规范（唯一真源）：docs/DEBUG-MODE.md——**扩展调试模式前必读其 §五**；
# 上手 skill 源随仓走：skills/kojo-debug/SKILL.md——各 agent 同步进自己专属 skill 目录（如 ~/.agents/skills/）。
```

带环境变量跑 vitest 一律 `node node_modules/vitest/vitest.mjs run <file>`——`npx vitest` 会吞环境变量（详 PITFALLS）。
**验收口径：任何"改好了"必须带数**——测试数（不许回退）/ 双 typecheck / 审计 / 真实壳读数。

## 四、Git 纪律（2026-10-13 定 · 2026-10-19 二改分支模型，多 agent 并行必守）

- **分支模型（2026-10-19 起，`master` 已停用删除，远端默认分支＝`main`）**：
  - `dev`＝**日常落地分支**，一切一般更新（功能 / 修复 / 文档批）的窄门出口；
  - `main`＝**发行版分支**，只在发版时更新（把已判可发的 dev 提交并入 → 打 tag `v*` 触发 release 工作流）；
  - 日常批次**一律不推 `main`**，也不再推 `master`（该分支已不存在）。
- **一个 agent 一个工作树；一个批次一条短命分支**：`b/<agent>/<MMDD>-<slug>`，从 `origin/dev` 起，**不在本地 `dev` / `main` 上直接提交**。
- 中途备份：`git push -u origin <branch>`（自己的分支 rebase 后可 `--force-with-lease` 只 force 它）。
- **落地 = 过 dev 窄门**：`git fetch origin --prune` → `git rebase origin/dev` → 门槛全绿（见 §三；纯文档批豁免测试面）→ `git push origin HEAD:dev`。
  非快进被拒**就是并发协议本身**——重跑 fetch + rebase 再推；**永不** force 到 `dev` / `main`。落地后删远端批次分支。
- **发版 = 单独一条路**：用户点头发版时，才把既定 dev 提交 fast-forward 或合并进 `main` 并打 tag；版本号三处同步（§七）照旧在发版提交里过。
- `git fetch` 单独成句，看 `rc=$?`（`git fetch | tail` 是假兜底：管道吞失败码）。github 直连时通时断 ⇒ 本 clone 已配 repo 本地代理（`git config http.proxy <本机代理>`；新 clone 配一次，**永不改全局配置**）；推送反复失败时兜底 `node tools/git-push.mjs`（默认目标已是 `dev`；交替直连/代理重试）。
- 禁用：`git add -A`（逐文件 add）、共享树里 `stash`、改写已公开历史、对 `dev` / `main` force。
- rebase 解冲突逐文件 add + `git diff --cached` 过目（`add -A` 会把冲突标记提交进历史）；提交后全仓扫 `^(<<<<<<<|=======|>>>>>>>)( |$)`。
- 提交信息：Conventional Commits **中文标题**。

## 五、文档纪律（2026-10-13 二改：**文档只做认领与交付**）

- **只写两件事**：①**认领**——`docs/BOARD.md` 写一行「认领：<主机> <日期>」；②**交付**——删行 + 回执（读数 + 取舍）**写进提交信息**。
- **此外不写任何文档**：不写批次 log、不写总结 / 分析 / 报告、不举行取号仪式。历史由 git 保留，`docs/archive/` 冻结不再追加。
- 仅两个豁免：硬坑（会造成返工的实际陷阱）一行一条进 `docs/PITFALLS.md`；基线数字（测试数等）真变时顺手改 `docs/STATE.md` 对应行。
- 规格类文档（`ARCHITECTURE` / `BASELINES` / `SYNTAX-SUGAR-SURFACE-SPEC` / `USER-GUIDE` / `adr/`）只在实现与文档冲突且实现是对的时改一行算一行，不做重写。
- 旧制残留：`docs/log/` 各文件为历史存档，不再新增；`docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md` 供发版判据引用，不再是看板索引。

## 六、分工边界与冲突纪律

- 动别人模块前先 `git log --oneline -- <path>` 看最近一批是谁的、读数口径是什么；跨模块需求走 **additive 契约**（旧消费方零改动），不替别线改口径。
- 冲突热点：`EditorPane.tsx` / `styles.css` / `sugar-view.ts`——改前确认干净，同文件多次编辑**串行**且改完读回。
- 量"改前"用 `git worktree add <临时目录> HEAD --detach` 起游离树，别动别人的工作副本。

## 七、版本纪律

抬版本要**三处同步**：root `package.json`、`packages/app/package.json`、`packages/app/src-tauri/tauri.conf.json` 的 `version` 逐字相等（发版提交 `9b2009d` / `e4d4621` 的纪律），现由 `packages/app/tests/app-version.test.ts` 钉住——欢迎页那格即取 app 包清单，不许另抄；`v0.4.0-beta.1` 发版判据见 `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md`（判定行）与 `README.md`（判据节）。
