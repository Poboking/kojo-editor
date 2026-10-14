# 交接文档（v0.1 ✅ / v0.2 第一批～第十七批 ✅ / v1.1 第十六批 ✅ / v0.3 糖批 S1–S7 ✅ / UI 重设计 P0–P3 ✅ / 口上项目批 P-A…P-E ✅）

> 更新：**2026-10-12**（语法糖线 13 个提交已 rebase 进 master —— 冲突处置与编号让位见
> IMPLEMENTATION-LOG **§5.64**；此前口上项目批 P-A…P-E 收口）。**新会话从这里开始读，读完即可开工。**
>
> **本组（本机小组）分工**：整体项目推进 + UI 优化。**语法糖优化**与**性能优化归别组**
> （各占独立分支，见 §十二）。接活前先分层，糖语义与解析性能默认不碰。
> v0.1 全量（含桌面壳端到端）+ v0.2 第一批（约定校验器 + 索引响应式化）；
> 第二批：函数树导航（`ui-kojo-navigator`）；
> 第三批：条件谓词抽取（`condition-extractor`）+ 导航条件徽章 + adapter 变量字典；
> 第四批：存档快照源（`sav-parser`，服务 `snapshot.source`）；
> 第五批：状态回放引擎（`state-replay`，服务 `state.replay`）；
> 第六批：回放求值器扩展——本地量数据流 + 引擎内置纯函数 + 调用上下文注入（未知率 62.9% → 48.5%）；
> 第七批：有界内联求值——口上域 `#FUNCTION` 纯助手顺序解释（未知率 48.5% → 32.0%，call 桶消解 84%）；
> 第八批：`ui-state-replay` 回放面板（第 10 个插件）——选档 × 选角色 × 选函数 × 逐条谓词三值结果，导航面板 ⟲ 联动；
> 第九批：分支走向——谓词结果按 IF 链 / SELECTCASE 链折叠，回放面板显示"该状态会走哪个分支"（含可达性传播）；
> 第十批：口上调用协议——adapter 解析 KOJO_MESSAGE.ERB 路由表 → 槽位语义表，回放面板结构化场景参数输入（协议不可用优雅降级）；
> 本会话完成 **v0.2 第十一批：存档写侧预研——ByteWriter + serializePayload + 金样本回归，save00 载荷 571,185B 逐字节完全一致（编码器同构达成）；暴露 Int64 精度硬前置（RANDDATA 等），方案 B（rawBytes 保留）写入 §5.17**。
> 本会话完成 **v0.2 第十二批：审阅修复（依据 docs/archive/CODE-REVIEW-2026-10-10.md）——H1 CASE TO 区间 AND 语义（conjunction 契约 + 三层落地）+ M4 切文件丢内容（确认对话框）+ M5 回放联动闭包 + M2 Rust 编码 had_errors + L1/L3/L4；426 项全绿，回放基线不变**。
> 本会话完成 **v0.2 第十三批（双线）：① sav-parser Int64 精度方案 B 落地（rawBytes passthrough）——六档金样本 passthrough 全部字节级一致（含此前被拒的 save01-05）+ 标量/单元补丁注入 + Int64 守卫；纠正第十一批结论：RANDDATA 是 u32 序列逐值安全，真雷在 RESULT/CFLAG/GIFT_GOT（IMPLEMENTATION-LOG §5.19）；② TRAE 并行交付 ui-archive-browser 归档浏览器（第 11 插件，commit ca1a323）；456 项全绿**。
> 本会话完成 **v0.2 第十五批（v1.0 收口线一）：回放面板场景预设**——把手填的调用上下文槽位一等化为「场景」（命名保存 / 下拉切换 / 一键应用 / 删除）；`ReplayScene` 纯逻辑（+15 单测）+ `ctx.storage` 独立域（`ui-state-replay`）+ 协议降级（建议名 label 拼接 / 不可用则纯手填）；应用后槽位来源标 manual（作者假设，非引擎事实），与 §5.20 的 assumption 徽章并存；回放引擎与 condition-extractor 契约零改动；485 项全绿（IMPLEMENTATION-LOG §5.22）。
> 本会话完成 **v0.2 第十七批：桌面壳端到端冒烟——tauri dev 真实 IPC 下跑通 Rust 双闸 a–e 全清单（域内放行 / 域外 fail-closed 拒绝 / 关项目后回落 appDataDir），固化自动化探针 `tools/smoke-tauri-ipc.mjs` + 手工清单 `tools/smoke-tauri-manual.md`；沙箱 os error 231 未复现；零源码改动（IMPLEMENTATION-LOG §5.24）**。
> 本会话完成 **v1.1 第十六批：存档注入器用户面——写链路端到端**——新服务 `snapshot.writer`（契约 `SnapshotWriteService`，读写职责分离）+ sav-parser 0.3.0（容器组装 container.ts / 回读验证 verify.ts / engine.inject：Int64 守卫先于备份 → 先备份 → 写盘 → 回读验证，失败报错携带备份路径）；新插件 `ui-snapshot-injector`（第 12 插件：选档→定位变量→编辑→diff→两步确认注入）；修复 eratw-adapter writablePaths 缺 sav 目录的真实缺口；kernel 集成第 9 节（appData 副本端到端 + 越权拒绝 + Int64 守卫，绝不写真实游戏档）；509 项全绿（IMPLEMENTATION-LOG §5.23）。
> 本会话完成 **v0.3 批 S1：语法糖契约 + golden 固化**——新契约 `packages/plugin-api/src/sugar.ts`（SugarDoc / SugarNode 联合 15 型 / AliasValue 四右值[变量可读写、角色·数值·字符串只读] / SugarDiagnostic 23 码闭集 / 行级 SugarSourceMapEntry / SugarTranspileService；每节点带 1 基行列源位置）+ 服务键 `sugar.transpile`（实现 `kojo-sugar` 插件 S2 建）+ golden fixture（规范 §6.1/§6.2 源与期望产物，**逐字节等于规范原文**、测试按规范行号切片比对；期望产物 `.erb.todo` 暂存 + `describe.skip` 待 S2 转正式）；**不实现转译器**；555 项全绿（IMPLEMENTATION-LOG §5.26）
> 本会话完成 **v0.3 批 S3：编译产物写链路（`.kojo` → 合规 `.erb` 落盘）**——`SugarTranspileService.compileToFile`（契约新增 `SugarCompileResult` / `SugarCompileOptions` / `SugarCompileEncoding` / `SugarCompilerDeps` / `SugarCompileError`；**唯一含 IO** 的方法）+ `FileIO.ensureDir`（契约 + 内核实现，**与 writeBytes 同闸**）+ 写链路 `kojo-sugar/src/compile.ts`（守卫 → 编码组装 → ensureDir → 备份 → 双闸写 → **回读字节比对**，复刻注入器安全顺序）+ 产物恒 **UTF-8-BOM + LF + 末尾换行**；**重大发现：任务/规范 §8 的「CRLF」与真实语料不符**（全树 3,818 个 ERB：LF-only 3,787 / CRLF-only 3；口上域 2,317 个全 LF、零 CRLF）→ 采语料口径（用户拍板）；717 passed / 6 skipped（纯本批 +35，基线 679）；kernel 集成新增**第 10 节**；回放基线逐字不变（IMPLEMENTATION-LOG §5.29）
> 本会话完成 **v0.3 批 S4：糖预览数据层**（§5.30，服务 `sugar.preview`）与 **S5：升糖建议器数据层**（§5.31，服务 `sugar.lift`，`SugarLiftConfidence` 闭集只有 `'verified'`）。
> 本会话完成 **v0.3 S5+ 批：旁白口径 round-trip + lift apply 链路 + `ui-sugar-lift` 面板（第 14 插件）**——lift 自证壳支持 `旁白色:` 两种口径、新服务 `sugar.liftApply`、golden 冻结计数 2→4；850 项全绿（§5.32a/§5.32b）。已推 `0d0bc51`。
> 本会话完成 **v0.3 解耦补齐批：时机分野模板归位 adapter（S2 遗留承诺 B-1 兑现）+ 审计 D 项**——契约新增 `KojoFaceTable`/`KojoFaceTemplate` + `GameAdapter.kojoFaceTemplates?`；`eratw-adapter/src/face-templates.ts` 按附录 C 全量登记；`codegen.resolveFace` 改查表 **fail-closed（缺表→timing-face-unknown，绝不回退内建模板）**，golden 逐字节零回退；`audit-decoupling.mjs` 新增 D 项（通用插件零游戏知识，`sav` 仅 A 项）探针自证；851→868 项全绿 / typecheck root+app / audit 四项 / 真实语料冒烟 ✅；**基线更新：868 项 / 14 插件 / 四项审计**（§5.33；审阅报告 `docs/archive/REVIEW-SUGAR-DECOUPLING-2026-10-11.md`）。已推 `26dd4d8`。
> 本会话完成 **v0.3 S4-UI 批：糖预览面板（第 15 插件 `ui-sugar-preview`）**——把 S4 的 `sugar.preview` 数据层接成可浏览面板：当前 `.kojo` → 转译 + 源映射 + 诊断（有存档附状态回放）→「糖源码行 ↔ 生成产物行 ↔ 消息块可达性」三向映射；**存档扫描是软依赖**（缺席退化为两向映射，不 inactive）+ **未接存档时不显示可达徽章**（不可判定 ≠ 可达，绝不误导）；跳转复用 `editor.revealLocation`、当前文件走 `editor.activeFileChanged`、存档预填走 `kojo.snapshotSelected`（UI 插件间零直接依赖）；909 项全绿 / typecheck root+app / audit 四项（**15 插件**）/ golden 零回退（§5.34）。
> 本会话完成 **v0.3 S6 批：编辑体验（第 16 插件 `ui-sugar-editor`）**——`.kojo` Monaco Monarch 糖高亮（台词=作者色/中文关键字分角色/`续`标记/插值/```erb 围栏）+ 中文关键字·保留代词·文件内别名补全（**英文隐藏别名不进列表**，规范 §4.1）+ 危险波浪线（新槽 `ui.editor.decorator` → Monaco markers，owner `kojo-decorators`）+「糖判定」面板（可编译/警告/不可编译 + 逐条诊断跳转）；词表**单一真源**从 kojo-sugar 转译器关键字表派生（永不脱节），高亮住 app 宿主层（Monaco 不属插件）；931 项全绿 / typecheck root+app / audit 四项（**16 插件**）/ app build ✅ / golden 零回退（§5.35）。
> 本会话完成 **v0.3 S7 批（数据层 + UI）与 UI 重设计 P0**——S7 保存路径推导 + `.kojo` 保存接线（发版判据 ① 最后一环，§5.36/§5.37，958 项）；P0 写权限闭环批 + 三轮实机反馈修复（静默只读 / 重授权入口 / 索引阶段可见化 / 函数树失败态 + 头部自救按钮，§5.38–§5.41，959 项）。
> 本会话完成 **UI/UX 重设计 P1–P3 批（VSCode 式五区布局落地）**——**P1** 壳层骨架（五区布局 + 活动栏 + 三容器 + 10 面板迁移，`4ae9366`）/ **P2** 命令与工具栏（统一命令注册表 + 命令面板/快速打开 + overlay 宿主 + 新建口上文件向导；事件白名单补全 `0bf2eb9`；`e4663aa`）/ **P3** 编辑器深化（多标签 `63f362e` + 💡 CodeAction + 状态栏诊断计数 `9e72af0`）；契约**全部 additive**、宿主**零业务知识**（§5.42–§5.44）。随后**审阅 + 补测批**（§5.45）：3 处修复（`\` 路径文件名优先 / 功能键大写 / codeAction id 单调不复用）+ app 层补测 **+48**（`commands.test.ts` / `layout.test.ts` / `new-file-wizard.test.ts`）；并**修复审阅发现 B1**（§5.46：宿主订阅 `file.changed`，外部写盘后重载 model，杜绝「旧文本覆盖升糖结果」，+5 测试）；**基线更新：1012 passed / 6 skipped / 16 插件 / 审计 A–D 四项**（审阅报告 `docs/archive/REVIEW-UI-P1-P3-2026-10-12.md`）。P4 待用户确认后开工。
> 本会话完成 **2026-10-12 内核优化批（L0 实测 + 超长文件丝滑 + 索引快照）**（分支 `feat/kernel-optimization`，实施记录 §5.49；路线与全部实测见 `docs/PERF-REVIEW-2026-10-11.md` §七）——
> ① 用户定调「内核优化 = 体感丝滑」（例 1 加载快/二次打开不等；例 2 超长文件不卡）；
> ② L0 实测推翻两条假设：击键转译只作用于 `.kojo`（ERB 有 isKojoFile 短路）；「打开超长 ERB 卡顿」的真凶是**我们自己的折叠链**（Monaco 打开即要整篇 folding ranges → `ui.editor.liftPreview` → `sugar.lift.liftSuggest` 全文，52,601 行实测 **231 ms**）；
> ③ 超长文件降级：契约 additive `lineCount` + `ui-sugar-lift/large-file.ts`（>5000 行自动路径让路、告警可见、面板显式出口）+ Monaco 选项按体量分级（`app/src/ui/editor-options.ts`）；
> ④ **索引快照 + 增量复扫**：erb-parser 把 `{path→(mtimeMs,textLength,ErbFile)}` 落存储域（实测 52,601 行仅 43 KB JSON，全量约 10–20 MB），二次打开 mtime 未变者零读盘零解析、只重扫变更文件（`service.buildIndex` 显式调用仍 = 强制重建）；实机探针常驻（`__kojoPerf`）；
> **基线更新：1043 passed / 8 skipped（1051）/ 16 插件 / 审计 A–D 四项全绿；typecheck root + `@kojo/app` 双跑 exit 0**。
> **下批欠账**：条件抽取 ~6.2s / 约定校验 ~9s 既没持久化也没下池（级联大头仍在）；`kernel.compute`（T1）/ L2 共享缓存未动。
> 本会话续完成 **2026-10-12 计算池批（即点即现）**（`01635b7` + 本批；实施记录 §5.52）——
> ① 先测量两处：`buildNavigatorTree` **258ms**（不值得切片，改为去重）；索引构建串行 **4,290ms**（纯 CPU 主导 → 必须多线程）；
> ② 修「开项目建两遍树」（`project.opened` 与 `kojo.functionChanged` 双触发同一索引实例 → 新增纯函数 `shouldRebuildIndex` 去重）；
> ③ 新内核设施 **`kernel.compute`**（契约 `plugin-api/src/compute.ts`）：`yieldToMain`（MessageChannel 宏任务让路）+ `runSliced`（时间片 + 窗口并发）+ 优先级 interactive>background + `runLatest` 单飞尾缘合并 + `offload`（可搬运任务，失败回退本地）；
> ④ 级联过池三处：erb-parser 的 stat/parse（32/12 并发）、condition-extractor 的抽取循环（8）；**IO 留主线程，只把纯解析搬上并行通道**；
> ⑤ **并行运输层**：`createWorkerTransport(factory,{size})` 多槽轮转（单槽不减少总 CPU，故按 `hardwareConcurrency-1` 封顶 4）+ `handleComputeRequest` 协议；任务表单一真源（插件导出 → 宿主 `registerTask` 与 worker 入口共用）；
> ⑥ 验证：真线程测试 15 项（含多槽轮转）+ `@kojo/app build` 通过 + **构建产物端到端**（vm 加载 worker 产物，52,601 行真实 ERB 解出 124 函数）；
> **基线更新：1083 passed / 8 skipped（1091）/ 16 插件 / 审计 A–D / app build ✅**。
> **下批欠账**：条件抽取与约定校验的 CPU 仍整段在主线程（下一步搬上并行通道）；markers 未走 interactive 档（当前收益有限）；L2/L4 未动。
> 本会话续完成 **2026-10-13 P4 补测批（壳层判据抽纯 + 中文合成期 Esc 缺陷修复）**（实施记录 §5.92）——
> ① 判据 ⑥ 的真实欠账（P4 零新增测试）**已清**：`layout-reducer.ts` / `panel-drop.ts` / `shell-keys.ts` 三个零 React
> 纯模块 + **65 项新断言**（Esc 链 16 种组合穷举、拖拽落点判据、`zenLimitWidth` 两头、清洗漏网分支、
> 「布局不进内核存储域」静态守门）；组件语义零改动，靠真实壳同一套 DOM 断言反证。
> ② 顺手修掉一条**实机缺陷**：中文输入法按 Esc 撤销拼音候选会被全局快捷键吞掉（关掉设置页 / 退出全禅）。
> 根因是整仓零合成期判据，且设置 overlay 只防了鼠标没防键盘。判据单源
> `app/src/ui/shell-keys.isComposingEvent`（`isComposing` / `keyCode 229` / `compositionstart` 会话标志），
> 并同批堵掉新失效模式（失焦清标志，否则快捷键全废）。
> ③ **真实桌面壳端到端实测**：一次性 CDP 探针同口径两遍，改后 **19 项全绿** / 改前 **5 项红**（含真 DragEvent
> 落点改到 `panelLocations`；拖拽 4 项两边都绿 ⇒ 抽纯重构零回归）；
> 改前游离 worktree 对照 6 项红。合成事件只证接线，**真人 IME 目视仍欠**（`MANUAL-CHECKLIST` 5.D）。
> **基线更新（本批落地时实测）：1497 passed / 11 skipped（1508）**；rebase 进 master 合流后为 1712 / 13（1725）。
> 本会话续完成 **2026-10-13 UI 反馈批（第一批 7 条里的 5 条）**（实施记录 §5.93，协作件
> `docs/UI-FEEDBACK-2026-10-13.md`）——
> ① 反馈 1/2/3（观感与文案）：编辑器只读指示改用**底栏同款黄色胶囊**（去 🔒 与冗长括注）；
> 解锁询问弹窗删「💡 一键把 ERB 写法改成糖写法」这类实现细节；「恢复只读」按钮作废，
> 回锁能力改由「✏ 可编辑」徽章自身承接（能力不丢，少一颗丑按钮）。
> ② 反馈 5：用户报"展开被折叠的原文失效"，读代码的结论是**该控件从未存在**——糖段 `<pre>`
> 没有任何监听，骨架段还是"只藏不显"。按 ADR-0006 补 `sugar-fold.ts`（隐藏区间 / 展开态 /
> 占位文案 / 已收起行数）+ 宿主折叠柄，摘要改为「已映射 N 行｜已收起 M 行（可展开）」。
> ③ 反馈 6：真实壳实测证明菜单**没断**（0 → 2285 文件行），真因是①工具条「展开全部」
> 只展开角色组、不展开作者包；②菜单项单向且在全展开时不留任何交代。新增 `file-tree-reveal.ts`
> 把动作做成可逆开关 + 一句可读数反馈。
> ④ 反馈 4（糖视图改用虚拟文档）与反馈 7（ERB 语法波浪线）**未在本批做**：前者要契约加行级映射
> 且需用户拍板（方案与三个待答问题写在协作件 §二），后者规格已定（同件 §四）。
> **基线更新（本批落地时实测）：1522 passed / 11 skipped（1533）**；合流后当前基线 **1712 passed / 13 skipped（1725）**。
> 本组另**认领全项目实机测试**（约定见协作件 §五）。
>
> **2026-10-13 傍晚 · 中断批盘点（用户指派移交）**：上个会话中断，留下三处在制品（均未推送 / 未提交）——
> ① main 树 **HK-8 裁决批**（`notice-queue.ts` + 6 项测试；号已让位 **§5.120 → §5.127 → §5.129**，盘点复跑 vitest 1838/14、双 typecheck、审计 A–D 与声称一致）；
> ② 同树 **向导文案再对齐小改**（未入册；清单 §六 7.2 引文待同步）；
> ③ `临时工作树` worktree **HK-4 第三轮图标系统**（`ui/icons.tsx` + 17 文件，未提交未入册）。
> 三件的落库步骤、注意项与 stash 摘要全在 **§十二-7**——**①② 已于 2026-10-13 晚落库（§5.129，`ddc06f4..29505d8`）**；③ 仍在制品。


---

## 一、项目一句话

**kojo-editor** = eraTW 口上编辑器：结构感知（Monaco + ERB 语法）× 一切皆插件 × sav 快照回放（远期差异化核心）。
技术栈：pnpm monorepo · TS（TS7/vitest4/vite7）· Tauri2（Rust 只做 IO 原语）· React 19 · Monaco。

- 仓库：`<工作树>` = github.com/Poboking/kojo-editor
  （**2026-10-12 起本机为新环境主机，只有 `C:` 一个盘；本文档正文里历史批次记录中的 `<本机目录>` / `<本机目录>` / `<node 安装目录>` 路径全部失效，按本表换算，勿照抄执行**）
- 测试游戏目录：`C:\game\eratw-4.980基线语料`（汉化整合版，CSV/ERB 均 UTF-8-BOM）
  —— 实测 ERB 全树 **3,818 个文件**，与 §5.29 记录逐字吻合，是同一份真实语料；**但整份语料无任何 `sav` 存档**，六档金样本类测试在本机自动跳过属正常。
- 应用数据目录：`%APPDATA%\dev.kojo.editor\`（`store/_global/{recent-projects,approved-writable}.json` 跨次保留；`workspaces/` = 作者工作区根）

## 二、当前状态（30 秒版）

- **v0.1 全部完成**：kernel（DI/总线/存储域/文件IO/槽位/运行时）+ plugin-api + 3 插件 + Tauri 桌面壳，端到端已验证。
- **v0.2 第一批完成**（本会话）：
  1. **索引所有权收敛到 `erb-parser`**：订阅 `project.opened` 自动建索引并缓存，`currentIndex()/ensureIndex()` + `kojo.functionChanged` 广播；app 不再自建索引。
  2. **约定校验器**：`plugin-api/conventions.ts` 契约 + 新插件 `convention-linter`（引擎 + 内置通用规则）+ `eratw-adapter/conventions.ts`（4 条 eraTW 规则）+ 新插件 `ui-convention-report`（面板，点击问题跳转）。
  3. **通用导航事件 `editor.revealLocation`**（内核事件表新增）+ app 落地（打开文件并定位行）。
- **v0.2 第二批完成**（上一会话）：
  1. **新插件 `ui-kojo-navigator`**（`ui.panel`）：角色 → 家族 → 面 → 函数 三维树；角色下拉 + 全量函数名搜索（含未归属）；点击 → `editor.revealLocation`。
  2. **`tree.ts` 纯逻辑**（零 React）：面语义排序（FACE_ORDER）、slot 数值排序、`declare` 单独成面、orphan 只计数不展开（99k 函数里非口上域占大头）。
  3. **家族规则经槽位查询获取**（按 `project.adapterId` 精确匹配），**不 import adapter 包**——多游戏共存天然正确。
  4. 集成冒烟新增「导航地基」断言：可归属角色 / 多家族角色 / 多面角色 / 最重角色。
- **v0.2 第三批完成**（本会话）：
  1. **scanner 扩展 `scanControlFlow`**（erb-parser）：控制流骨架线性输出（kind / 条件原文 / 块深度 / 行号）；配对表以引擎 `FunctionIdentifier.cs funcMatch` 为准（IF→ENDIF / REPEAT→REND / TRY系 / PRINTDATA系…）；孤儿闭合向栈内查最近匹配（宽容不中断）。服务 `ErbParserService.scanControlFlow` 暴露。
  2. **新插件 `condition-extractor`**（服务 `condition.extractor`）：ERB 表达式子集解析器（Pratt，优先级以 `OperatorCode.cs` 为准）→ `ConditionExpr` AST + 函数级 `StateDependency` 聚合；**包容降级**（opaque，绝不抛）；CASE 展开（`==值`/`IS >= n`/`a TO b`/逗号列表）；订阅 `kojo.functionChanged` 串行调度全量抽取。
  3. **契约**：`plugin-api/conditions.ts`（AST/依赖/索引/服务）+ `ControlFlowStatement`（erb.ts）。
  4. **adapter `variableSchema`**（CSV 驱动）：扫描游戏 `CSV/*.csv` 名称表（33 张）建编号↔名称双向字典；引擎经槽位查询透传标注（恋慕/好感度…）。
  5. **导航条件徽章**：`ui-kojo-navigator` 函数行显示 schema 标签徽章（悬停看阈值）。
- **v0.2 第四批完成**（第四批会话）：**存档快照源（`sav-parser` 插件，服务 `snapshot.source`）**——v1.0 快照回放的读侧地基。
  1. **契约 `plugin-api/snapshot.ts`**：`SnapshotArchive`（元数据 + 角色区 + 变量区 + EM 扩展区）/ 变量模型（标量 / 稀疏数组 / Map / Xml / DataTable）/ 扫描结果 / `SnapshotSourceService`（scan / current / parse / subscribe）。**服务键命名决策 `snapshot.source`**（非 `sav.parser`）：审计 A 项禁裸 `sav` 词（契约层零游戏/格式名词），且"快照来源"语义本就是三来源（sav/CliDebug/手工）的统称——IMPLEMENTATION-LOG §5.10 有记录。
  2. **新插件 `sav-parser`**（第 8 个插件）：字节原语（7-bit **字节数**前缀字符串 / 整数编码）+ 六种数组游程解码 + 顶层 / 角色块 / 变量流 / EM 区解析 + gzip（`DecompressionStream`，跨 Node/WebView，不 import node:zlib）。**纯读先行**（写 / 注入随 v1.1）。
  3. **响应式**：订阅 `project.opened` 扫 `project.savDir`（`headerOnly` 浅解析列档，6 档 27ms）；`project.closed` 清空；代际保护；无 `savDir` → 空结果（显式）。
  4. **测试**：58 项单测（合成字节 round-trip 全类型 + 错误路径 + 编排）+ 集成冒烟六档断言 + 与逆向 CJS 解析器逐字段交叉对拍（一次性，16,000 变量/档全等）。
- **v0.2 第五批完成**（本会话）：**状态回放引擎（`state-replay` 插件，服务 `state.replay`）**——v1.0 快照回放的**求值侧**地基。
  1. **契约 `plugin-api/replay.ts`**：`ReplayStateView`（状态视图）/ `ReplayValue`·`ReplayOutcome`（三值）/ `ReplayUnknown`（原因分类 16 种）/ `FunctionReplay`（置信度三档）/ `StateReplayService`。
  2. **新插件 `state-replay`**（第 9 个插件）：Emuera 变量寻址语义（TARGET 补位 `X:i`≡`X[TARGET,i]`、全局 `X`≡`X:0`、MASTER/ASSI 顶层指针、#DIM 数据驱动）+ **三值求值器**（Kleene：`false && unknown = false`）+ 编排（createView / replayFunction / replayFunctions）。
  3. **condition-extractor 扩展**：`functionPredicates()` 按需谓词明细（读文件 → `scanControlFlow` → 逐条 AST；**不入全量索引**，文件文本 + 明细双缓存，索引重建自动失效）；契约新增 `FunctionPredicate`/`FunctionPredicates`。
  4. **adapter 契约扩展**：`VariableInfo.resolvedIndex`（具名索引 → 编号：`TALENT:恋慕` → 3，引擎关键字字典语义）。
  5. **测试**：62 项 state-replay 单测（连 Kleene/寻址全类别/错误路径/编排）+ 4 项明细 API 测试 + 集成冒烟回放断言。
- **v0.2 第六批完成**（本会话）：**回放求值器扩展——本地量数据流 + 引擎内置纯函数 + 调用上下文注入**（IMPLEMENTATION-LOG §5.12 为权威记录）。
  1. **先测量再动手**：实测推翻批五"未知主因 = `ARG:*`"假设——真实构成 pseudo 4,439（**LOCAL 系为主**）/ call 2,485 / ARG 系仅 ≈1,005（14%）。口上作者大量使用"直线赋值的局部开关"（`LOCAL = 1` / `LOCAL:1 = 1`，K49 语料 97% RHS 为纯数字常量）。
  2. **本地量数据流**：`collectAssignments`（condition-extractor，仅明细路径，聚合零开销）收集 `LOCAL/LOCALS/RESULT/RESULTS` 直线赋值；`buildContextLookup` 段栈折叠出**分支上下文路径**；求值侧 `locals.ts` 叠加层按"**前缀可达 + last-write-wins**"解析（兄弟分支互不可达、闭合块外不吃块内赋值、RHS 递归 + 记忆化、`+=` 记为失效点）。引擎依据 = ConvertArg/IntoFunction（Process.CalledFunction.cs:162-239 + Process.State.cs:495-515）。
  3. **内置纯函数**（`builtins.ts`，Creator.Method.cs 逐条对齐）：GETBIT / GROUPMATCH / MAX / MIN / ABS / SIGN / LIMIT / POWER；错误路径 → unknown('builtin') 不抛错。明确不收录：数组区间族 / GETNUM（等 adapter schema 通道）/ 字符串形态族 / RAND。
  4. **调用上下文**：`ReplayCallContext{ints,strs}`（裸 ARG ≡ ARG:0，引擎 1D 裸引用语义）注入 `replayFunction(view, name, {callContext})`；未提供/未覆盖 → unknown('call-context')，**不猜测 0**（转发自路由层的值是场景输入）。adapter 口上调用协议（路由表 → 转发实参映射）留作 UI 场景选择器地基（默认流收益实测 ≈ 0）。
  5. **测试**：+29 单测（assignments 识别与上下文 / locals 叠加 / builtins 语义）；集成冒烟新增数据流与调用上下文断言 + 未知率守门（<55%）+ 未知分类打印。
- **v0.2 第七批完成**（本会话）：**有界内联求值——口上域 `#FUNCTION` 纯助手顺序解释**（IMPLEMENTATION-LOG §5.13 为权威记录）。
  1. **先测量再动手（第四次应验）**：对 call unknown 做**被调函数形态分析**（临时 dump 跑完即删），实测推翻批六预估——call 覆盖 26 名 / 2,805 谓词中，**口上索引域内有定义仅 3 名 / 1,991 条（71%）**（`陷落状态`×1830 + `关系_310`×160 + `陥落状態`×1）；23 名（FIRSTTIME 等）定义在 kojoPaths 之外（COMMON.ERB 等），本就不可内联（FIRSTTIME 写 CSTR 副作用）。可内联函数体 100% 为 IF/ELSEIF/SIF/RETURNF + **ARG 补位赋值**（`SIF !ARG / ARG = TARGET` 惯用法）——唯一拦路的是 ARG 不在批六收集名单。
  2. **契约**：`FunctionAssignment.name` 扩 `'ARG'|'ARGS'`（结构事实；静态叠加层不消费——ARG 读取仍走 call-context 注入优先）；`FunctionPredicates` +`endLine` / +`returns`（RETURNF 结构事实）。
  3. **抽取**（condition-extractor）：`ASSIGN_RE` 扩 ARG/ARGS + `collectReturns`；明细路径产出 endLine/returns（聚合路径零开销）。
  4. **求值**（state-replay）：`inline.ts` 预编译 + **PC 顺序解释器**（SIF 条件体 / IF 链 / RETURNF / 环境读 / **索引段替换** `TALENT:ARG:恋人`）；`evaluate.ts` 求值通道重构 `EvalContext{read, resolveCall}`；`InlineManager`（analyze 缓存 + `preanalyze` BFS 预热 → 执行期同步命中）；state-replay `requires` 增 `kernel.io`。
  5. **实现最微妙的坑**：ELSEIF/ELSE op 的两种到达方式（条件假跳转 vs 分支体自然掉落）——编译期把"假跳转到 ELSE"改写为直接进体（`elseIdx+1`），运行期 `pendingEval` 标记区分"跳转到达 ELSEIF（求值）"与"自然掉落（跳 endAfter）"。首版实现 ELSE 与 ELSEIF 双双踩中此坑（集成测试 ELSE 分支错误落到链尾兜底 RETURNF）。
  6. **真实回归**：未知 5,668→**3,741**（**48.5%→32.0%**）/ call 桶 2,297→**368**（消解 84%）/ exact 786→**836** / 全未知函数 70→**38**。+27 单测 + 集成冒烟守门 0.55→0.40 + 陷落状态内联专项断言。
- **v0.2 第八批完成**（本会话）：**`ui-state-replay` 回放面板（第 10 个插件）**（IMPLEMENTATION-LOG §5.14 为权威记录）。
  1. **面板**（`ui.panel`）：选档（`snapshot.source` 扫描 + saveMes 摘要）→ 选角色（`project.charaIndex`）→ 选函数（条件索引子串提示，≥2 字符）→ 逐条谓词三值结果（kind 徽章 + 原文 + 行号点击 → `editor.revealLocation`）+ 置信度徽章（确定/部分未知/无法判定）+ **未知原因分组**（code → 中文提示 + 计数）。视图按（档 × 角色）惰性重建 + 代际保护。
  2. **调用上下文输入**：`0=36, 1="约会"` 文本 → `ReplayCallContext`（panel-logic.ts 纯函数解析；带引号 → 字符串槽；解析失败红字提示不阻塞；空 → 不注入走 call-context unknown——场景输入绝不猜测）。
  3. **联动事件 `kojo.replayFunction`**（内核事件表新增，editor.revealLocation 同款模式）：导航面板函数行/搜索行加 ⟲ 徽章（stopPropagation）→ 回放面板自动填名并回放；UI 插件间零直接依赖。
  4. **登记**：四处（package.json/tsconfig paths/vitest aliases/vite aliases+deps）+ bootstrap.ts；`rp-*` 样式；`nav-badge.replay` 样式。
  5. **测试**：+11 单测（panel-logic 全路径）；400 项全绿；audit 10 插件 ✅；真实工程冒烟无回归；app build ✅。
- **v0.2 第九批完成**（本会话）：**分支走向**（IMPLEMENTATION-LOG §5.15 为权威记录）。
  1. **契约**：`BranchChainOutcome`（if-chain/select-chain × taken/no-match/unknown/unreachable）+ `FunctionReplay.branches`。
  2. **引擎**（state-replay `branches.ts`）：链栈配对折叠（与 scanner 配对表同源）+ **unknown 立即阻断**（后续真不可救——链语义与 Kleene 同构）+ **可达性传播**（链头在外层未进入分支区间 → unreachable，防"不可达却显示命中"误导作者）+ 宽容（孤儿分支跳过）。
  3. **呈现**：回放面板"分支走向"区（按 depth 缩进；✓/∅/?/· 四态标记；命中链显示条件原文+跳转行号；rp-branch* 样式）。
  4. **测试**：+14 单测（三态/阻断/短路/CASE 同行任一真/CASEELSE/嵌套可达/宽容三例）；集成冒烟分支断言（真实数据 IF LOCAL 链 taken）。
- **v0.2 第十批完成**（本会话）：**口上调用协议**（IMPLEMENTATION-LOG §5.16 为权威记录）。
  1. **先测量纠正过度承诺**：dump call-context 构成（ARG 槽 ≈200 函数：ARG:0×158/ARG:1×53，形态 `LOCAL:1 && ARG == 1`）+ 路由源码核验（口上函数 (ARG,ARG:1) = 路由 ARG:3/ARG:4 透传 = **纯场景输入不可推导**）——候选清单里"858 条自动消解"是想当然；协议真实价值 = 槽位语义标注 + 默认场景（全 0 是引擎转发链未设置槽的确定事实）。
  2. **契约**：`KojoCallSlot{index,kind,label}` + `KojoCallProtocol.slotsFor(fn)` + `GameAdapter.kojoCallProtocol?`（游戏知识只住 adapter）。
  3. **adapter**（`call-protocol.ts`）：解析 KOJO_MESSAGE.ERB 路由表 → 家族模板正则（尾部 {…}=数值时机 \d+ 优先 / %…%=字符串时机 .+）+ 槽位表（ARG:n→int / ARGS:n→str 按序绑定）；loadProject 加载、缺文件降级 undefined；+5 单测。
  4. **面板**：有协议 → 结构化场景参数输入区（每槽一框 + 转发来源 tooltip + int 预填 0；空=未提供不猜测）；无协议 → 回退文本框；**回放引擎零改动**。
  5. **验证**：集成冒烟协议断言（真实路由表 SPEVENT→2 槽/家族外 null）；419 项全绿。
- **存档解析基线（2026-10-10 实测）**：六档全绿——168 角色/档、16,005 变量/档（save00 16,000）、`#DIM` 恒 65、MASTERNAME 7/168、RANDDATA saveLen 625（**save00 nonEmpty=0 全零剪枝实证** / save01+ 全量）、MONEY 51 亿（Int64 路径）、EM 区 2 张 DT 表、**残余 0B**。
- **状态回放基线（2026-10-10 实测，第七批后）**：save03 × 古明地觉（K49）全量回放 **1,356 个含谓词函数 / 11,685 谓词**——命中 1,549 / 未命中 6,395 / 未知 **3,741（32.0%）**；置信度 exact **836** / partial 482 / unknown **38**。第七批后未知构成：pseudo 1,886（RAND 等运行期值）/ call-context 858 / call 368（索引域外函数）/ named-index 337 / local-no-write 196 / missing-var 80 / 其余 <20。
- **真实工程基线（2026-10-10 实测）**：168 角色 / 2,285 ERB / 99,104 函数 / 去重名 99,101；家族识别 98.91%（109 家族）；索引 ~2.9s；约定校验 757 项（~9s）。
- **v0.2 第十一批完成**（本会话）：**存档写侧预研**（IMPLEMENTATION-LOG §5.17 为权威记录）。
  1. **实现**（sav-parser 游戏无关）：`writer.ts`（ByteWriter：m_ReadInt 逆编码 + 7-bit 前缀 UTF-16LE）+ `serialize.ts`（serializePayload 载荷层重序列化）+ 金样本回归测试（六档守门）。
  2. **关键发现——数组游程是行驱动结构**：每行末必写 0xE0、每面末必写 0xE1（含最后一行/面，cursor 证据 GMF_MAPNAME=[12,0]）；首行（dx=0）不写行标记（初版误写 F1+0 → 24 字节差异，逐 token 对比定位修正）。
  3. **金样本结果**：save00 载荷 **571,185B 字节级完全一致**（编码器同构达成：游程/整数宽度/7-bit/流控制全对）；save01+ **Int64 大数近似不可写回**（RANDDATA SFMT 625 状态 ≈2.8e16，serialize 显式抛拒绝）——**v1.1 注入器硬性前置 = Int64 精度策略**，倾向方案 B（`rawBytes?` 原样复制未修变量 + 被修变量含大数拒绝注入）。
  4. **教训（§九-10 复发）**：联合判别式 narrow 不可靠（writeVar 的 int/str case）——显式守卫。
- **条件抽取基线**：95,504 函数 / **493,712 谓词（未解析 187 = 0.04%）** / 含依赖函数 31,609 / 依赖条目 164,910 / schema 标注 109,742（恋慕 17,993 / 好感度 480）/ 全量 ~6.2s（冷启动 ~13s）。
- **v0.3 批 S1 完成**（本会话）：**语法糖契约 + golden 固化**（IMPLEMENTATION-LOG §5.26 为权威记录）。
  1. **契约** `plugin-api/sugar.ts`：`SugarDoc`（front-matter + 时机列表）/ `SugarNode` 联合（TextLine·HeartLine·IfBlock·IfExpr·WhenBlock·WhenExpr·RandomBlock·RandomInline·ChoiceBlock·ColorBlock·RawLine·RawFunctionBlock·AliasDecl·TimingBlock·Interpolation）/ **`AliasValue` 四右值**（变量引用可读写；角色引用·数值·字符串字面量只读）/ `SugarDiagnostic` + 23 码闭集 / **行级** `SugarSourceMapEntry` / `SugarTranspileService`（parse / transpile / sourceOf）。
  2. **源映射地基**：每节点携 `loc{start,end}`（1 基行列，UTF-16 码元）；行级粒度为本批明确决策（列级留 S6，规范 §9 待实测第 3 条）；纯生成行 `sourceLine: null` 不伪造。
  3. **15 个显式类型守卫**（`isVariableAlias`/`isReadonlyAlias`/…）替代判别式 narrow（TS7 教训）；**只读性单一真源** = `isReadonlyAlias`。
  4. **golden fixture**：`kojo-sugar/tests/goldens/` 收录规范 §6.1/§6.2 源 + 期望产物（`.erb.todo`），**逐字节等于规范原文**（测试按规范行号切片，fixture 误改即红）；S2 转正式断言。
  5. **边界**：只碰 plugin-api + goldens；未碰 erb-parser/condition-extractor/state-replay；规范文档只读；无新插件（S2 建 `kojo-sugar`）。
  6. **并行线**：adapter 线（TRAE）WIP 使其 `ruleCount` 断言暂红（5→6 属其维护域）；stash 归位复跑确认本批无回归（回放基线逐字不变）。
- 测试：**485 项全绿**（无游戏目录时集成冒烟 1 项自动跳过）；typecheck（root + app）通过；解耦审计 ✅（**11 插件**）。
- **v1.0 收口完成**（本会话）：**协议覆盖校验规则**（IMPLEMENTATION-LOG §5.27 为权威记录）。
  1. **校验语义**：对 `call-protocol.ts` 解析的每个家族槽位，核对家族实际函数签名槽（`ErbFunction.params`）是否被 `KOJO_MESSAGE.ERB` 路由转发覆盖；声明槽 > 转发槽 ⇒ 该槽调用时**永远**收引擎默认值（0/空串）→ 结构化 `warning`（ruleId `eratw.kojo-call-slot-coverage`）。
  2. **覆盖语义 = 存在性**（`maxForwardedSlotsFor`，max-over-all-matching 模板）：任一匹配模板转发该槽即不算「永远」——修掉 `_CHILD_%ARGS:1%` 抢占通用模板导致的 156 条误报（193→36）。
  3. **TRYC 修复**：`ROUTE_LINE_RE` 补 `TRYCCALLFORM`（原漏；引擎 `ERB_EXCOM.khp:175` 确证，整合版 214 处）——修复后 ONABARE 4 实参模板可见，误报 37→36。
  4. **落位**：`eratw-adapter/conventions.ts` 第 5 条规则 + 闭包注入 `getProtocol`（ctx 刻意不暴露 adapter）；`plugin.ts` 传 `() => currentProtocol`；契约扩展 `EratwCallProtocol extends KojoCallProtocol`（不改 plugin-api）；`ui-convention-report` 零改动自然消费。
  5. **测试**：规则单测 3 路径（覆盖/不覆盖/协议不可用降级）+ call-protocol +5（模板具体性与覆盖语义）+ 真实语料 `corpus.test.ts`（36 条，全 warning，全「数值槽 声明 1 / 转发 0」）；kernel 集成冒烟 `ruleCount` 5→6 + 新增 `=== 36` 断言。
  6. **验证**：564 passed / 7 skipped（无 smoke）；569 / 2 skipped（带 smoke）；typecheck root+app ✅；audit ✅（13 插件）；**回放基线逐字不变**（K49 1356/11685/未知 3741/exact 836）。

- **v0.3 语法糖批进度**：**S1 契约 + golden ✅**（§5.26）/ **S2 转译内核 ✅**（§5.28）/ **S3 写链路 ✅**（§5.29）/ **S4 糖预览数据层 ✅**（§5.30）/ **S5 升糖建议器数据层 ✅**（§5.31）/ **S5+ 旁白口径 + lift apply + ui-sugar-lift 面板 ✅**（§5.32a/b）/ **解耦补齐批（KojoFaceTable 契约 + 审计 D 项）✅**（§5.33）/ **S4-UI 糖预览面板 ✅**（§5.34，第 15 插件 `ui-sugar-preview`）/ **S6 编辑体验 ✅**（§5.35，第 16 插件 `ui-sugar-editor`）/ **S7 保存路径推导 + 前置检查（数据层）✅**（§5.36）/ **S7-UI `.kojo` 保存接线 ✅**（§5.37，发版判据 ① 最后一环）。服务键：`sugar.preview` / `sugar.lift` / `sugar.liftApply`（`sugar.transpile` 增 `planSave` 纯函数方法）。基线 **958 项 / 16 插件 / 审计 A–D 四项**。
- **2026-10-12 保存接线批（S7-UI）完成**（本会话）：把 §5.36 数据层接成 **UI 闭环**（IMPLEMENTATION-LOG §5.37 为权威记录）——**发版判据 ① 的最后一环**。
  1. **新通用槽 `ui.editor.saveHandler`**（`plugin-api/slots.ts`）：`EditorSaveHandlerContribution`（`matches(path)` + `save(request)`）+ `EditorSaveOutcome` 三态（`saved` / `needs-choice` / `error`）+ `EditorSaveWarning` / `EditorSaveChoices`。宿主**零格式知识**：保存前按 `matches` 就近征询接管者，命中即委托；**缺席自动退化**为内核 io `writeText` 缺省保存。
  2. **`.kojo` 保存逻辑住插件**（`ui-sugar-editor/src/save-handler.ts`，纯编排可单测）：`planSave` 前置 → **源文件始终保存** → `blocked` 只拦产物（`note` 说明「产物未生成」）→ 否则 `compileToFile` 落盘。**无新插件（仍 16）**，`ui-sugar-editor` 从两处贡献扩为三处。
  3. **全角空格 = 告警 + 决策点（不强制阻断）**：未确认返 `needs-choice` 且**尚未落盘**；宿主弹 `SaveWarningDialog` 三选——**取消 / 仍然保存 / 替换为半角空格并保存**（后者走 `executeEdits` 可撤销修复）。
  4. **顺手修复潜在缺陷**：宿主 `Ctrl+S` 回调（`addCommand` 只注册一次）原闭包捕获旧 `save`（deps 含 `filePath`）→ 换文件后会存到旧文件。改用 `filePathRef.current` + 稳定 deps 修掉。
  5. **测试**：+8 单测（`save-handler.test.ts` 多路径）+ `integration.test.ts` 补槽收集与断言；基线 **958 passed / 6 skipped（964）**；typecheck root+app ✅；audit ✅（16 插件）。
  （S7 **数据层**记录见 §6.27 / IMPLEMENTATION-LOG §5.36：`planSave` + `resolveSugarTarget` + 全角空格单一真源上收契约层。）
- **UI/UX 重设计线（发版判据 ⑥）进度**：需求定稿 v1.0（`docs/UI-REDESIGN-2026-10-11.md`）→ **P0 写权限闭环 ✅**（写权限徽章 / 通知中心 / 只读保存拦截 / 三入口 + 三轮实机反馈修复，§5.38–§5.41）→ **P1 壳层骨架 ✅**（五区布局 + 活动栏 + 三容器 + 10 面板迁移，§5.42，`4ae9366`）→ **P2 命令与工具栏 ✅**（统一命令注册表 + 命令面板 / 快速打开 + overlay 宿主 + 新建口上文件向导，§5.43，`e4663aa` + `0bf2eb9`）→ **P3 编辑器深化 ✅**（多标签 + 💡 CodeAction + 状态栏诊断计数，§5.44，`63f362e` + `9e72af0`）→ **审阅 + 补测 ✅**（3 处修复 + app 层 +48 测试，§5.45）→ **B1 修复 ✅**（宿主订阅 `file.changed`，外部写盘后重载 model，杜绝旧文本覆盖升糖结果，§5.46）→ **审阅回执修复 ✅**（`pickSaveHandler` 的 `matches()` 抛错不再静默，改 `console.warn`；针对 `ed68f231` 审阅第 2 条，第 1 条 `filePathRef` 系误读、第 3 条 sort 稳定不成立；无独立提交，随 P1 批 `4ae9366` 入库，§5.47）→ **解耦修复批 ✅**（审阅 `DECOUPLING-REVIEW-2026-10-11.md` M1–M4 全量：事件 emit 权限单一真源 + 编译期防漂移断言〔机制化根治 `0bf2eb9`〕/ 宿主文案去游戏化 + 审计 A 项收编宿主 UI·Monaco 层 / `WellKnownCommands` / gitignore+docs 入库，§5.48）→ **P4 停靠与全禅 ✅**（三容器拖拽停靠 + 全禅限宽设置 + 设置 overlay，`d871878`；日志系 §5.54 **入库后补记**，**判据⑥的实机勾验仍是欠账**）。
  - 关键纪律（本线全程遵守）：契约**全部 additive**（新字段 optional，缺省即现状，任一中间态可运行）；宿主**零业务知识**（壳层只提供容器/动作语义）；布局状态住壳层私有 `localStorage`（`kojo.ui.layout.v1`），**不进内核存储域**；新增内核事件必须在 `plugin-api/src/events.ts` 登记 emit 权限分类（`PLUGIN_EMITTABLE`/`KERNEL_ONLY` 两表 + 编译期断言 `KERNEL_EVENT_CLASSIFICATION_GUARD` 强制，§5.48——`0bf2eb9` 手工同步教训已机制化）。

- **口上项目线（2026-10-12 批 P-A…P-E，✅ 本组主线，权威记录 = IMPLEMENTATION-LOG §5.49）**：
  落地《口上项目/口上树讨论纪要》定调的「口上项目 ──引用──▶ 游戏项目」对偶模型，
  **新建 → 编辑 → 导入 → 导出 → 部署** 全链路已通：
  - `kernel.workspaces`（P-A）：通用 `project/artifact` 模型 + **常驻可写根**（工作区恒可写，
    不受项目开闭周期清空）；manifest = `workspace.json`，注册表 = 扫目录（索引即目录，崩溃不漂移）。
  - 编辑器写权限**按目录分野**（P-B0）：游戏目录 ERB 只读、工作区 ERB 恒可编辑。
  - 「我的口上项目」面板（P-B）：三级树 + 双真相源常驻提示条；包默认折叠，行内动作悬停才显。
  - 新建向导 + 中文脚手架（P-C）：`{作品名}-{角色名} v{版本}`，中文 README + 8 核心面空壳（纯 `;` 注释，不生活函数；四件套刻意不生成）。
  - 导入（P-F）：文件树右键 → 内核意图事件 → 向导，**强制新包名**不覆盖他人署名，字节级复制。
  - 导出（P-D）：当年是 `exportDirectory` 桥能力，**对话框即授权**——落点刻意过不了写允许域，
    但对话框与复制绑在同一 Rust 命令内，JS 拿不到落点决定权，故无越权面。
    （导出改走 ZIP 后它零生产调用方，**该授权模型现由 `exportFile` 独任，`exportDirectory` 已删，见 §5.97**。）
  - 部署（P-E）：三道前置判定**全在动盘之前**（源是目录 / 目标不存在 / 目标在写白名单内），
    未授权时连目录都不建，不给引擎留半成品。方向唯一，永不回写工作区。
  - **剩余欠账**（纪要 §5 清单）：导出 ZIP（**下一批首选**）· 直连模式开关 ·
    多剧本编号上树 · 中日对照。
  - **✅ T2 署名 / 授权一等公民已完成**（§5.50）：`attribution.ts` 纯函数抽取
    （先 dump 真实语料定形态，三次推翻直觉）+ 面板展开态一行摘要（给证据不给结论，
    悬停看原文出处）+ 导入向导随 meta 携带原作者。**口径 = 高精度宁缺勿滥**：
    实测 214 包只抽到 26 个署名，这是设计结果——假阳性会让人把别人的作品当无主作品改。
    语料基线常驻 `attribution.corpus.test.ts`（`KOJO_SMOKE_PROJECT` 守门）。
- **当前基线（2026-10-13 §5.127 批 P 合流 §5.123–§5.126 线之后、本机实测）：1843 passed / 14 skipped（1857），
  104 文件过 / 8 跳（112）；16 插件；审计 A–D 四项全绿；typecheck root + app 双跑 exit 0；`pnpm --filter @kojo/app build` ✓ 38.71s（§5.112 那次的读数，本批未改构建面）；
  带语料单跑的**结构闸门**（3,818 文件 / 4,115,009 行）零误报，最慢单文件体检 30.0ms，**修复闭环**（删一条 ENDIF → 💡 补回 → 复检为零）在最大那份真文件上过。
  §5.115（实机复验第七轮）**零代码改动**：合流到上游 §5.114 之后本组复跑，读数与上游自记**逐字相同**（1826/14/1840、104/8/112），
  typecheck root + app 与审计 A–D 也复跑为绿 ⇒ 基线不另起数。
  > **糖线 §5.114 之后（本机 `C:先前项目master-kojo-editor` 实测）：1826 passed / 14 skipped（1840）、104 文件过 / 8 跳（112）**
  > 批 N 投影单测 11 条 + 第七把尺子「数据表条目可读率 **57.4%**（10,421/18,154）」；
  > 语料三 gate 全绿、不变量违例 0，段数 287,805 → **285,546**（摘掉批 N 涨回 287,805，当场量过）。
  > **§5.128 索引 stat 折叠批（本机 `<工作树>` 实测，rebase 到 §5.127 之后复测；这是本批第六次 rebase）**：**1844 passed / 14 skipped（1858）**、
  > 104 文件 / 8 跳（112）、typecheck root + app 双 0、审计 A–D ✅；上游把六处读数取齐到 1843，本批 +1 条
  > walk/stat 等价断言 = **1844**（代码提交当时读的 1827 是 rebase 前同一棵树的值；六轮 rebase 五次重测
  > 1827→1833→1833→1838→1838→1844，每轮都按 §十二-31 重跑，不沿用上一轮）。`cargo test --lib` **18 项全绿** ——
  > ⚠ 本表此前写「19 项全绿」是**失真的**：`eac536e`（§5.97 看板 HK-3，收回 `exportDirectory` 绕闸通道）
  > 连同删掉 3 条 `export_directory` 用例，此后实际一直是 **16**（删测试合法，能力撤了；是汇总行没跟着改），
  > §5.128 +2 ⇒ 18。`pnpm --filter @kojo/app build` 本批未重跑（不动打包面）。
  > **§5.130 抽取段分段剖面批（本机 `<工作树>` 实测，rebase 到 §5.129 之后复测）**：**1852 passed / 14 skipped（1866）**、
  > 105 文件 / 8 跳（113）、typecheck root + app 双 0、审计 A–D ✅；本批零产品行为改动（只加抽取段分段日志 +
  > 2 条断言）。实机三轮：全冷 7.5/26.3/21.0s、抽取冷 0.55/10.0/1.0s、全热 0.60/1.35/1.37s；
  > 抽取段分段条见 §5.130 表（冷开读盘 45.1s 墙钟累加 ÷ 并发 8 ≈ 5.6s，扫描 2,285 次全走 worker，主线程循环 1.0s）。
  > `cargo test --lib` 本批未动 Rust（18 项口径不变）。
  数字闭合（逐批可追）：上游 §5.104 自记 1661 passed / 13 skipped（**1674**）+ P4 补测批 **68**
  （`shell-keys` 22 / `panel-drop` 19 / `layout-actions` 14 / `layout.test.ts` +13）+ UI 反馈第一批 **25**
  （`sugar-fold` 14 / `file-tree-reveal` 11）= 1767 + 实机复验轮 **7**（`looseProjectDirs` 的挑法）= 1774 +
  ERB 波浪线批 **30**（`structure.test` 23 / `plugin.test` 接线 6 / 语料闸门 1）= 1804 +
  ERB 💡 补齐批 **25**（`structure-fix.test` 14 / `plugin.test` 接线 7 / `structure.test` 字段口径 4）= 1829 +
  上游 §5.114 批 N **11**（`kojo-sugar/tests/project.test` 数据表投影）= **1840**，与本组复跑的 vitest 运行数一致。
  ⚠ skipped 从 11 变 13 不是回归：本主机存档/语料在位与否会让 corpus 用例在 passed/skipped 间移动（§13.3-5）。
  `cargo test --lib` 未跑：§5.105 起零 Rust 改动（本仓口径是"改了 Rust 才加跑"）。
  与上游 §5.108（只动 `tools/` 与文档、零新增用例）同基线：他们自记沿用 1754/1767，本批 +7 ⇒ **1761/1774**。
  上一段闭合链（保留供追账，谁的账谁留）：§5.87 自记 1577 + 落盘引导批 27（落盘编排 22 / 关联号解析 4 /
  接线 1）+ 快照 v4 批 3（key 派生不变式 / 含冒号安全 / 非派生值拒绝编码）= 1607；
  实机复测批 §5.90 **零代码改动、零新增用例**（它对 v4 的端到端反证来自真实 app 探针，比语料 gate 更硬）；
  看板 HK-5 批 15（分野 6 / 合批器 5 / `dirsToRelist` 4）= 1622；IPC 读盘通道批 5
  （`bridge-decode.test.ts`）= 1627；看板 HK-6 批 10（`watch-scope` 8 / 面板接线 2）= 1637；
  本批（看板 HK-7）5（`matchOpenedPath` 五种形态）= **1642**。
  文件数：91 → 93（落盘引导批 +2）→ 94（IPC 批 +1）→ 95（HK-6 批 +1；HK-7 批用例落在既有测试文件里）
  → **96**（看板 HK-2 批 +6 条模态栈用例 = 1648）。
  ⚠ §5.92 明写"app build 本批未重跑"——本批重跑了（✓ 1m02s），那条欠账现在平了。
  ⚠ 换基座必重跑：本组第一次量到 1619 是 rebase **之前**的基座（§九-31，各批自记的数为准）。
  skipped 13 = §5.82 无语料跳过的 2 项 + 其余 11 项（存档在位的宿主上会变成 passed，**跨主机不必相等**）。
  ⚠ 跑全量**不要**设 `KOJO_SMOKE_PROJECT`（会放行依赖 sav 存档的注入测试而本机零存档必红）；
  语料基线单独带变量跑那一个文件即可。
- **2026-10-12 回放线重测批完成**（本会话；`docs/IMPLEMENTATION-LOG.md` **§5.74** 为权威记录）：
  差异化核心「sav → 状态回放」在 §5.64 合流 / §5.65 索引快照 v3 / §5.70 抽取按文件增量之后
  **首次重测**（此前本机零存档，两条守门长期 skipped，§5/§6 只是文档里的历史数字）。
  1. **用户提供了六份真实存档**，逐字节验真确认**就是 2026-10-10 那批原始档**：`save00` 载荷
     **571,185 B 逐字节同构**（与 §5.17 记录一字不差）、`save03` saveMes = `第 47日`（正是集成
     测试断言）、档集 `global + save00–03 + save1000` = 6（与 `toBe(6)` 同源）。
  2. **§5 与 §6 逐字复现**：168 角色/档、16,005 变量/档（save00=16,000）、`#DIM` 恒 65、
     MASTERNAME 7/168、RANDDATA 625（save00 全零剪枝）、MONEY 51.77 亿、EM 2 表、残余 0B；
     K49 回放 **1,356 函数 / 11,685 谓词 / 命中 1,549 / 未命中 6,395 / 未知 3,741 = 32.0% /
     exact 836 / partial 482 / unknown 38**，未知分类亦逐项对齐。
     → **结论：合流与两批缓存改动没有把回放求值带偏。**
  3. **一处口径漂移已归因**：抽取「扫描函数数」实测 99,104（= 索引全量），§4 旧记 95,504；
     谓词四项逐字未变 ⇒ 是 `16747f4`（§5.70）"无控制流的文件也留空桶"让计数变宽，不是回归。
  4. **封堵金样本两处假绿面**（本批唯一代码改动，三处都是**收紧**）：旧 `golden-roundtrip`
     硬编码 `save00–save05`（另一套槽位）且对缺失档 `catch { continue }` ⇒ **标题六档、实际四档仍绿**；
     现改为档集**身份清单**（缺档即红并指名）+ 把真实强度写死（**逐字节 2 档 / 近似档 4 档 /
     方案 B passthrough 6 档**）；另把"有环境变量但语料无 `sav/`"从 ENOENT 失败改成**显式 skip**。
  5. **复测配方 + 安全边界**：真实语料 `C:\Game\eratw-…(PC)` 全程**零写入**（无 `sav/`、顶层 29 项不变）；
     六份档的长期位置 = **`C:\Game\eratw-save\sav\`**（用户 2026-10-13 定，语料的**同级目录**、不入库）。
     金样本可**零副本直跑**该库，只有全链路复测才用一次性副本；两条命令见 §五"回放线复测"。
  6. **未做**：六份档需要一处长期的仓库外固定位置（建议 `C:\kojo-fixtures\sav\`，**位置待用户定**，
     微信接收目录会被清理）；SKIA v15 一侧与 CliDebug 快照来源未验（本机引擎是 LazyLoading v3.0，
     PE 内无 socket 面）；§7 编码往返基线未在副本上顺手重跑；桌面壳实机目视仍欠。
- **内核优化线（2026-10-12 批 P-A…P-F 同期，✅ 已收口进 master）**：L0 埋点 → 超长文件丝滑 →
  索引快照 → 计算池 `kernel.compute` → 并行运输层 → 扫描段上通道 → 审修补丁，
  权威记录 = IMPLEMENTATION-LOG **§5.51 / §5.52 / §5.53**（体感口径：加载二次不等、超长文件不卡）。
- **体感丝滑线（2026-10-12 批，✅ 已收口进本分支）**：开项目级联三段**现在全部有持久化**——
  索引（逐文件 mtime 增量）/ 条件抽取（摘要快照）/ 约定校验（报告快照）。真实语料二次开项目
  水位：函数树 2068→**623ms**、条件徽章 9890→**1175ms**、校验面板 9900→**1178ms**。
  **派生缓存纪律**（详见 §5.58）：① 判据必须覆盖**全部实际输入**——ERB 正文之外，adapter
  在 `loadProject` 吃进的东西（CHARA 表 / 变量名称表 / 角色目录名）要经 `GameProject.inputDigest`
  声明，**缺一即不缓存**（`VariableSchema` 是 CSV 驱动的，只盯 ERB 会吐旧语义标签）；② 改规则或
  抽取口径**必须 bump** `LINT_SNAPSHOT_FORMAT` / `EXTRACT_SNAPSHOT_FORMAT`（规则是闭包，哈希不出
  行为）；③ **fail-closed**：判据或结构不符 ⇒ 删除快照并全量重算，绝不"修"；④ 失败的工作
  **不进缓存**——v1 是"整报告带 `failedRules` 就拒绝命中"，校验 v2（§5.72）起细化成**坏哪块不存哪块**
  （抛错的规则不写 `projectResults`、抛错的文件不留桶），坏一次不能永久缓存坏结果；⑤ 面板「重新校验」走 `run({ force: true })`，显式意图不许被缓存糊住；
  ⑥ 量"二次启动"必须**换新 kernel 共用同一 appData**（同进程 close/open 会被异步落盘污染，
  本批就据此得出过"缓存反而更慢"的假结论）；⑦ **判据要分层，且每层各占各的字段**——整项目指纹会把
  "作者改一个文件"放大成"重算全库"，所以分三层：全局层（项目根 / `adapterId` / `inputDigest` /
  语义版本 / 规则清单摘要）、整项目层（ERB 指纹）、逐文件层（桶 mtime vs `ErbIndex.fileMtimes`）。
  **把两层合成一个 `fingerprint` 字段就是那个根因**，§5.70 抽取与 §5.72 校验各栽过一次；
  ⑧ 缓存等价性不能只看 `stats`——**语义标签丢了统计看不出来**，要按全量内容指纹比；
  ⑨ 可增量复用的粒度由**被缓存的那件事自己声明**（校验规则 = `ConventionRule.scope:'file'` +
  `checkFile`），引擎不猜——猜错的代价不是变慢而是**悄悄吐出过期结论**。跨文件聚合的规则
  （按名 / 按角色）必须留在 `scope:'project'`；改判 `scope` 要同时改 `rulesDigest` 的输入，
  并配"全量 vs 增量同值同序"的等价性测试；
  ⑩ **共享实例的 memo 有三道前提**，缺一就不能加：被 memo 的函数必须是**纯函数**（只读入参与
  模块常量表）、返回值一律 `Object.freeze`（ESM 严格模式下改写直接抛错——"不可变"从注释变成硬约束）、
  要有**生命周期清空**通道（adapter 挂 `project.closed`；内核 `open()` 会先 `close()` 旧项目并广播它，
  所以只挂 closed 就覆盖切项目）。上限策略：**满了整表清空而不是 LRU**——"全库一遍"的键集逐条淘汰
  只会让下一遍重新解析。见 §5.73。**加 memo 前先问"同一份键在一次运行里被访问几次"**——
  协议侧那层按名 memo 就是这么被退的：一轮校验里每个函数名只访问一次，命中率≈0（§5.81）。
  ⑪ **收益判断必须量在用户跑的那条通道上**（§5.90）：同一份代码、同一份语料，vitest + node bridge
  探针里抽取热段 366ms、12.5MB 快照热读 74ms，真实 `tauri dev` 里对应是 **10.5s 水位 / 快照读 4.1s**
  ——差 2–3 个量级，因为每次读盘在 app 里是**两趟 IPC + 双向 base64**（`bridge/tauri-bridge.ts:14`/`:87`）。
  推论有两半边：**探针只能验机制**（复用率、内容指纹等价、判据生死），**体感一律用 app 的 `__kojoPerf`
  三个水位**；而"压体积有没有用"这个问题**在两条通道上答案相反**——node bridge 里 12.31→9.01MB
  不动水位（§5.89），base64 时代的 app 里 1MB ≈ 0.33s 墙钟，所以瘦身当时确实值 ~1s/次开项目。
  ⚠ **这个汇率已经过期**：§5.92 把读通道换掉后，12.5MB 快照从 4,147ms 降到 **234ms**（≈ 0.02s/MB），
  "再瘦身换墙钟"的收益缩了两倍 ⇒ **每次改 IO 形态后，体积汇率要重量，别沿用旧表**。
  ⑫ **换了被测通道，验证面也要跟着换**（§5.92）：宿主层（`tauri-bridge` / Rust 命令）的改动
  在 vitest 里**一行都不执行**——测试走的是 node bridge。这类改动默认配一支 CDP in-app 对照探针
  （同一份输入跑新旧两条路逐字节比），否则"全绿"只证明我没测到东西。
  ⚠ 别拿"真实语料抽样全同"当唯一凭据：本仓语料 **只有 utf-8-bom / utf-8 两种编码**，
  对 shift_jis / utf-16 是零覆盖，编码类改动必须补合成边界 + 随机缓冲区两批对照（§5.92 表三）。
  **卫生批（§5.65）已收**：索引快照 v3 元组编码 **44.4 MB → 11.9 MB**（剥可派生字段 + 键名
  位置化；热读盘 250ms → 74ms，索引可用 623ms → 541ms）；三段统一成**单文件语义**
  （多项目残留与 `index-v1-*`/`v2-*` 孤儿自动清理，磁盘封顶 ~58 MB）；三个体感水位常驻进
  `__kojoPerf`（`cascade.projectOpened→index可用/条件可用/校验有结果`）。
  **抽取按文件增量批（§5.70）已收**：抽取快照 v3 改**按文件分桶**（`EXTRACT_SNAPSHOT_FORMAT` 2→3），
  真实语料改 1 个 ERB 后重开：**抽取段 7200ms → 49ms**（复用 2284 / 重算 1），全量与增量
  逐字段同值同序（内容指纹 `0c357d324fd294`、schema 标注 109,742 四轮一致），磁盘 12.47 → 12.31 MB。
  **校验按文件增量批（§5.72）已收**：规则自己声明计算粒度（`ConventionRule.scope` + `checkFile`），
  快照换成**三层判据 + 逐文件桶**（`LINT_SNAPSHOT_FORMAT` 1→2，两个指纹分成两个字段）。
  真实语料改 1 个 ERB：**校验自计 5754ms → 1198ms**（逐文件部分只剩 8ms，其余是跨文件规则必付），
  端到端校验水位 6508ms → **2564ms**；四轮 793 项分规则条数逐项一致。
  代价：全命中从 1ms 整块还原变 60ms 装配，磁盘 440KB → 1371KB。
  **名称解析 memo 批（§5.73）已收**：`parseKojoFamily` 套一层「函数名 → 结果」memo。
  分布表（量出来的）：一次全量校验 **397,622 次**解析请求 / 去重 **99,101** 个名字 ⇒ **75% 是重复劳动**。
  真实语料 touch 阶段**校验自计 1198ms → 746ms**，端到端"改一个文件后重开"2564ms → **2056ms**；
  代价 15.6MB（gc 后，随 `project.closed` 清空）。前提不变量：纯函数 + `Object.freeze` 返回值 +
  只读调用点已逐个审过。
  **规则成本归位批（§5.81）已收 = 一条负结果**：`kx-placeholder` 加 `_KX` 前置过滤（可证等价：
  `isPlaceholder` 只有一个分支，入口条件就是含 `_KX`）后从 387ms 掉到 58ms，**但 completeness 从
  36ms 涨回 364ms**——三条合计 654 → 660ms 在噪声里。那 265ms 的"解析每个名字"是 completeness
  本来就要付的账，只是原先由排在前面的 kx 替全场买单。改动保留（绝对少做事 + 诊断口径归位），
  **但不宣称提速**；协议侧按名 memo 同样无收益，已退并在代码里留了"为什么被退"的注释。
  成立的那半：协议里 `slotsFor` 每次 `[...rules].sort(...)` 与逐模板重数槽数（都是实例常量）已上提。
  **抽取快照 v4 批（§5.89）已收 = 一条只在探针通道成立的负结果**：删派生 `key`
  （164,910 条依赖逐条验 0 例外）+ `name` 进字典（1,176 种写 164,910 次），体积 12.31 → **9.01MB**、
  内容指纹与 v3 逐字相同，抽取段却 366ms（v3 349–363ms）没动——分段成本读盘 36 / parse 138 / 造对象 126ms。
  **但同批的实机复测（§5.90）把这条归因推翻了一半**：真实 app 里"读盘"本身就是秒级。
  **实机复测批（§5.90）已收 = 本组前提被自己打掉**：CDP 驱动真实 `tauri dev` 开同一份语料，
  缓存**确实落盘也确实复用**（抽取自计 冷 93,139ms → 热 29ms；快照 9,443,607B 落地），
  可三段水位是 **热开 6.4s / 10.5s / 10.6s**，比 vitest 探针读数高 **2–3 个量级**；
  根因是**每读一个文件要走两趟 IPC + 双向 base64**（`bridge/tauri-bridge.ts:14` 读字节、`:87` 又把
  整份字节编码送回 Rust 只解码一次），而编码判定本来就是纯 JS（`kernel/src/encoding.ts` 已用
  `TextDecoder`，node bridge 也是）——**前四批优化的是 node bridge 那条通道，用户跑的是另一条**。
  **IPC 读盘通道批（§5.92）已收 = 本组目前最大的一笔真实收益**：① `decode` 搬回客户端
  （`encoding_rs` 与 `TextDecoder` 是同一份 WHATWG 标准，五个标签全覆盖）；② 新增
  `read_file_bytes_raw` 返回 `ipc::Response`，字节以 ArrayBuffer 过界（**没有** `responseType`
  这个选项——那是凭记忆会写错的 API，读过 `core.d.ts` 才定）。
  真实 app 三段水位：**热开 6.4/10.5/10.6s → 2.4/3.2/3.2s**，**冷开条件段 108s → 18.6s**，
  12.5MB 索引快照读 4,147ms → **234ms**。等价性：真实语料 63 份逐字节 + 逐字符全同、
  1,200 个随机缓冲区全同、16 例合成边界 15 例同（唯一分叉在读取路径上不可达，已钉成断言）。
  **§5.128 已落地**：索引不再逐文件 stat——`walkDir({withMetadata})` 顺带带回 mtime/size，
  热开三段 **2.66/3.43/3.45s → 0.63/1.57/1.60s**，`stat` 段 **2,038ms → 0**（2,285 次 IPC 直接消失，不是搬走）。
  ⇒ **#29「批量 stat / `stat_many`」与「再调高 stat 并发度」两案经实测都不必做**（并发早已是 32，见 §5.110 更正）。
  仍欠：`extractFunctionConditions` 未上并行通道（#21，冷开条件段 16.45s 的唯一大头）、
  打字→保存→徽章/校验那条级联的真实代价未量（#20）。
  **累计：用户「第二次打开同一项目」10.5s（§5.90）→ 3.43s（§5.92）→ 1.60s（§5.128）。**
  **§5.130 已落地**：抽取段按阶段拆了账 ⇒ **#21「抽取上并行通道」结案（否证）**——扫描 2,285 次**全部**走 worker
  （内联 0 / 回退 0），主线程抽取循环只 **1.0s**；冷开真正的大头是**读盘**（45.1s 墙钟累加 ÷ 并发 8）。
  下一靶子 = **#36「批量读盘原语」**（2,285 次单发读 IPC 折成一批；索引/抽取/校验三段共用同一原语）。
- **分支收口（IMPLEMENTATION-LOG §5.55）**：`feat/kernel-optimization` 因 `origin/master` 连续推进
  经历了**两轮 rebase**（第一轮撞在 `EditorPane.tsx` 与 `kernel/plugin-api` 的导出上，均取并集；
  第二轮纯文档消冲，代码零冲突面）。rebase 漏网的冲突标记曾在 4 个中间提交树里，**推送前已折叠回
  引入点**并逐提交复扫为 0；`git diff` 折叠前后 tip 为空 = 内容零变化。远端编号（§5.49/§5.50）不动，
  本链三批顺延为 §5.51–§5.53；两组同题的双写补记已删一份。
  **`origin/feat/kernel-optimization` 已删除**（旧链 8 提交已全部进 master，留之只会诱使后来者基于
  rebase 前的旧链开工），旧 tip 由本地 `backup/remote-feat-kernel-74603c5` 持有。

- **2026-10-12 语法糖视图批完成**（本会话）：把升糖重做的 **B 层（显示口径）做成端到端可用**——`docs/IMPLEMENTATION-LOG.md` §5.59 为权威记录。一句话：**打开别人写的 ERB，默认就显示为语法糖（台词像剧本、条件变成「如果 …：」），少部分机器码原样留原代码。**
- **2026-10-12 语法糖批 A/C/D/E 完成**（本会话；`docs/IMPLEMENTATION-LOG.md` §5.60 为权威记录）：按用户十条口径做了四批，**每一步都已提交并推送到 `syntax-sugar` 分支**。
  1. **批 A 交互口径**：删除「升糖预览」面板（停止开发）并停用逐条候选预览；`.kojo` 的 💡 **改为语法糖写法**（`EditorCodeAction.edits` + 宿主单次 `executeEdits`，`Ctrl+Z` 可撤回）；ERB **只读锁 + 编辑意图弹窗二选**（解锁按文件按会话、解锁即关闭糖视图，不做 ERB→`.kojo` 转换）；糖视图**首次打开弹窗询问** + 设置页开关。
  2. **修一个真 bug**：`lift.ts` `normalizeIndent` 按**字符**剥缩进却按**层级**算——凡空格缩进的 `.kojo`（规范示例/新建向导的写法）**识别不到任何升糖候选**，💡 根本不出现。已修 + 4 种缩进风格回归测试。
  3. **批 C**：属性反糖（`{CFLAG:TARGET:1088}` → `{她的好感度}`，无需改 adapter——`lookup().description` 就是名称）+ `SETCOLOR`/`RESETCOLOR` 配对成「着色 …：」块（三重守卫：不跨函数 / 不跨停用区 / 同深度）。
  4. **批 D**：函数骨架合并（包装三联 1,612 处 + 記入チェック信封 3,824 处），判据要求**可证明**、配不上就整段不动；信封拆掉时正文整体减一层缩进。
  5. **批 E**：注释**保留到产物**（用户第 3 条）+ 规范 §3.10/§6.1 同步修订（golden 与规范文档互相守门，四处行号锚点同步）。
  6. **真实语料读数（2285 文件）**：**台词行覆盖 98.6%**（不变）｜文件覆盖 96.4%→**97.4%**｜行覆盖 51.7%→**54.5%**｜不变量违例 0。K49 真实文件目视复核：糖覆盖 292→354 行。
  7. **仍未做**：桌面壳实机目视（本机无 `src-tauri/target`；手工清单见 §5.60 末）。tree-sitter 与口上项目线按用户口径不做。
  1. **契约定死**：`SugarProjectSegment` + `SugarProjectResult{segments,stats}`（修掉"契约写 `text`、实现返回 `segments`"的**半成品断链**）；统计补齐为完整口径 `projected+passthrough+native === totalLines`（硬不变量）。
  2. **可读化**：`%CALLNAME:MASTER%` → `{你}`、`%CALLNAME:TARGET%` → `{她}`（反向表由正向表**派生**，杜绝漂移）。
  3. **空行输出并入投影**：作者用裸 `PRINTFORMW`/`PRINTFORMDL␠` 打空行（400 文件实测 **35,425 行**、形态 100% 为"指令后为空"）；此前原样保留会把**每一段糖都切断**（段数 187/文件、最多 4,804）→ 现投影为一行空行。
  4. **宿主闭环**：工具条开关 / `Ctrl+Alt+T` / 事件 `editor.sugarView.set`（`on` 省略 = 反转；已按 §5.48 机制登记白名单）；偏好 `kojo.ui.sugarView.v1` **默认开**；渲染 = ViewZone（糖文本）+ `setHiddenAreas`（原子隐藏，能力探测 + 降级可见）；**着色复用 `.kojo` 的 Monarch 配色**；**分帧填充**（最大 9,569 段/文件也不卡首屏）。
  5. **面板改口径**（`ui-sugar-lift` →「糖视图」）：从"候选列表 + 九万条未建议区间"改为 **"读懂了百分之多少 / 剩下的为什么是原代码"**。
  6. **量化验收固化**：新 `packages/kernel/tests/sugar-projection.corpus.test.ts`（测**真实实现**，含不变量硬断言 + 覆盖率下限），兑现"必须有量化提升"的验收口径；原两个临时探针删除。
  7. **真实语料读数（2285 文件 / 3,598,297 行）**：**台词行覆盖 98.6%**（985,559/999,114）｜文件覆盖 96.4%｜行覆盖 51.7%｜不变量违例 0。未投影的行是函数骨架（`RETURN` 20.7 万 / `CALL` 13.5 万 / `LOCAL` 8.8 万）与非 FORM 输出指令——**是"少部分留原代码"，不是漏掉**。
  8. **边界未做**：函数骨架合并（下一杠杆，单独立项）／属性反糖（需 adapter 反向字典）／`SETCOLOR`→`着色` 块／**桌面壳实机目视**（本机无 `src-tauri/target`，首次 cargo 编译 20–30 分钟且需 GUI，手工清单见 §5.58 末）。
- **2026-10-12 语法糖教学样例批完成**（`docs/IMPLEMENTATION-LOG.md` §5.61 为权威记录；提交 `861a0b4`）：交付 `fixtures/sugar/teaching-full.kojo`（全语法面教学样例，每式旁配中文规则注释）+ 同目录 golden `.erb` + 常驻守门 `packages/kernel/tests/sugar-teaching.transpile.test.ts`（生产链路零 error 诊断 + golden 逐字节；`TEACHING_GOLDEN_WRITE=1` 重锚）。**样例首跑即实证三处转译器缺陷并已修**（行内条件分支整段被当代码降糖 / 头部声明与别名的行内注释未剥离导致函数名嵌注释 / 字符串字面量别名在插值内展开成非法 FORM）——规范自己的示例过不了自己的转译器，"样例即测试"这条路的价值由此坐实。
- **2026-10-12 语法糖批 F/G 完成**（本会话；`docs/IMPLEMENTATION-LOG.md` §5.62 为权威记录；提交 `45190cd` + `ade3a68`）：继续清**真实语料回放暴露的投影边界**，服务对象仍是"不熟悉 EraBasic 的读者"。
  1. **批 F · PRINT 输出家族投影**：显示口径表换成三判据 `form` / `newline` / `wait`（全部由指令名本身决定，一条不猜）。非 FORM 行（`PRINTL`/`PRINTW`/`PRINTDL`/`PRINTDW`/`PRINT`/`PRINTD`，实测 62,651 行）投影为文本行但**逐字符原样**——非 FORM 不展开 FORM 记号（语料实证：非 FORM 行含 `%…%` 仅 5/62,651 行；`PRINTDL` 含 `\@` 的 518 行**全是 ASCII 图形文字**）；`L`/`W` 变体空体并入"打空行"（非 FORM 系实测 4.6 万行）；裸 FORM `PRINTFORM`/`PRINTFORMD`（7,750 行）投影为文本行但**不加**「续」（`续` = `L`，无后缀是"不换行"，糖无等价标记）；表外变体（按钮 / 排版，合计 ≈350 行）**不投影**。
  2. **批 G · 行内条件 → 糖三元**：`\@cond?A#B\@` → `{cond ? "A" : "B"}`；三条判据（`\@` 成对 / `?` 与 `#` 齐备 / 条件非空）任一条不满足就**整行**留原代码；条件段走表达式反糖，分支含 `%` `"` `{` `}` 时原样照抄（规范 §3.4 禁嵌套插值，不造读者写不出来的假语法）。顺带修 `toSegment`：段内空行不再带缩进制表符（否则是一条无内容的彩色横条）。
  3. **守门口径升级**：新增「**输出行覆盖**」尺子（12 个输出变体），旧「台词行覆盖」（4 个 FORM 变体）保留以便与 §5.58/§5.59 历史读数可比——**只用窄尺子则"少认一类 `PRINTL`"永远不会红**；覆盖率下限 0.95→**0.99**（三个退化落点：输出行 92.1% / 98.7%、台词行 98.6%，都拦得住）。
  4. **真实语料读数（2,285 文件）**：台词行覆盖 98.6%→**99.2%**（990,914/999,114）｜输出行覆盖 **99.2%**（1,060,647/1,069,516）｜行覆盖 54.5%→**56.5%**｜成因 `inline-condition` 5,357→**0**、`unsupported-print-variant` 70,276→**503**｜段数 364,507→**325,302**（宿主少插 3.9 万个 ViewZone，最大 9,489→9,016）｜不变量违例 0。
  5. **查证记录**：零段文件 `Lilystory2.ERB`（1,822 行 `PRINTFORMDW` 却 0 段）**不是缺陷**——整文件被 `[SKIPSTART]`(1 行)…`[SKIPEND]`(2,706 行) 包裹，是作者整体废弃的口上，投影判它"停用区"正确。
  6. **下一杠杆**（读数已定位；`SIF` 已在**批 H** 做掉，见 §5.63）：**`@` 函数头时机中文反糖**（15,761 行 `@M_KOJO_*` → 需 adapter 37 面表的**反向**查询，属契约 / adapter 边界，须单独立项）｜着色层对"字面记号"的误着色（需段文本带元信息 → 契约级）。**桌面壳实机目视仍未做**。
- **2026-10-12 语法糖批 H 完成**（本会话；`docs/IMPLEMENTATION-LOG.md` §5.63 为权威记录；提交 `722a4e4`）：`SIF` 单行条件投影成「如果 …：」+ 正文 **+1 层缩进**（糖"缩进即块"的天然读法恰好等于 SIF 的"只管一条语句"）。
  1. **探针先纠正了我自己的误判**：第一版把 `LOCAL`/`RESULT`/`STR` 当"指令关键字"去切冒号边界，于是 17,499 行**裸 `SIF 条件`**（条件里本就带**变量索引冒号**，如 `SIF !CFLAG:ARG:诶嘿嘿`）被误判成冒号形态。修正后重测（18,130 行 SIF）：**`SIF 条件:命令` 形态 0 例，100% 是"条件独占一行 + 下一行单条语句"**（下一行：简单语句 13,137｜输出行 4,987｜连写 `SIF` 6｜**开块或闭合行 0**）。教训：**变量名与指令名混在一张关键字表里，判据就会指错方向**。
  2. **四条判据**，一条不满足就**整行不动**：表达式非空｜表达式里没有"冒号 + 指令关键字"形态（与索引冒号在没有完整表达式解析时不可证，语料 0 例也不猜）｜向下第一个非空非注释行是**单条语句**（不是开块、不是 `ENDIF`/`ELSE`/`CASE` 这类链的续行、不是另一条 `SIF`、不是 `@`/`#`/`$`/`[`）｜不在停用区与 `PRINTDATA` 数据表体内（结构判据先于内容判据）。条件段走与 IF 同一个 `reverseExprAttributes`。
  3. **读数（2,285 文件）**：**SIF 覆盖 93.3%**（8,875/9,516；余下 641 行是判据**故意**挡下的——目视确认在 `[SKIPSTART]` 废弃样本里、正文是开块、连写 SIF）｜行覆盖 56.5%→**56.8%**｜文件覆盖 97.4%→**97.5%**（+3 个文件首次出现糖段）｜`unsupported-control-flow` 21,657→**12,782**｜台词/输出行 99.2% 不变｜不变量违例 0。
  4. **守门新增第三把尺子**「SIF 覆盖」（断言 > 0.9）——这条能力只占全语料 **0.26%** 的行，混在"行覆盖"里退化**不会红**；尺子必须跟着能力长。
  5. 真实文件目视：`SIF CFLAG:1:300 == 15 && CFLAG:MASTER:300 == 15` → `如果 她的既成事実:300 == 15 && 你的現在位置 == 15：`，正文 `CALL MOPIGU(RESULT)` 留原代码并 +1 缩进。**这条目视当时看错了**：`她的既成事実:300` 是假阳性（`CFLAG:1:` = 角色 1 的作用面，不是 1 号属性），批 J（§5.66）加守卫后该行条件保持原样。
  6. **未做**：`SIF 条件:命令` 冒号形态（语料 0 例，要支持得用 `condition-extractor` 的表达式解析）；正文非输出行时块头"悬空"（要连正文画进糖区需改 `SugarProjectSegment` 语义 = 契约级）。
- **2026-10-12 两线合流批完成**（本会话；权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.64**）：语法糖线 13 个提交 **rebase 进 master**（master 侧 24 提交 / +8,814 行，重叠文件 14 个）。
  1. **编号让位**：口上项目线与内核优化线先落地并占了 §5.49–§5.57，糖线小节整体顺延 ——
     §5.49→**§5.59**、§5.50→**§5.60**、§5.51→**§5.61**、§5.52→**§5.62**、§5.53→**§5.63**（合流批自身 §5.64）；
     交叉引用同批动（只在我自己的区域内改，他们那三条字面串一个没碰）。
     **第三次同因撞车**：紧随其后的快照卫生批原写 §5.59，rebase 时又被本线的 §5.59 占位
     ⇒ 再让位为 **§5.65**。根因与固定做法见 §5.65 头注（写小节前 fetch + 取当前最大号 +1）。
     **提交信息里的旧编号不回改**（改 13 条已推送提交的 message 要 force-push，收益小于风险）。
  2. **`EditorPane.tsx` 三处并集**（两组都改了这个文件）：import 区并两侧；
     切文件时 `clearSugarView()` 与"按体量落 Monaco 选项"**都在 `setModel` 之前**（先还原上一个
     model 的隐藏区间，再落新 model 选项）；他们的 `lineCount` 降级守卫原本挂在折叠链上，
     而批 A 已按用户口径删面板 / 停用逐条候选预览 → **守卫接回唯一剩下的自动触发路径**
     （`.kojo` 💡，Monaco 光标/选区变化时反复调用，整篇自证实测 231 ms），`large-file.ts` 判据与其单测原样保留。
  3. **ADR-0005 落地**（提交 `ebb40bc`）：`sugarViewAllowed` 纯函数成为唯一判据，宿主三处共用；
     **工作区 ERB 不再弹首次询问、不再投影**；`setErbEditable` 的 `readOnly` 补上轴一。
     糖视图**不套 5,000 行阈值**：`liftProject` 是逐行局部映射（千行级 ~4 ms），而超长文件恰恰是
     读者最需要"像剧本一样读懂"的那些——这条与内核优化批的取舍不同，已在 §5.64 写明理由。
  4. **基线并流**：事件白名单 15→**16**（`workspace.importRequested` ∪ `editor.sugarView.set`）；
     `eratw-adapter` 新增 `react` peerDependency → 本机必须先 `pnpm install`，否则 **18 个测试文件**
     以 `Cannot find package 'react'` 整片红（环境动作，不是代码问题，后来者会再踩）。
  5. **验收**：`vitest run` **1296 passed / 11 skipped**；typecheck root + app 双 exit 0；审计 A–D 全绿；
     全仓冲突标记 0；**语料守门读数与 rebase 前逐字相同**（台词 99.2%｜输出 99.2%｜SIF 93.3%｜行 56.8%｜
     不变量 0）——这条"一字不动"就是本次合并的验收线，糖投影正是被性能线最容易影响到的消费者。
  6. **待办**：`origin/syntax-sugar` 需 force-push（**等用户确认**，旧 tip `fa9a18a` 由本地
     `backup/syntax-sugar-20261012` 持有）；`pnpm --filter @kojo/app build` 与桌面壳实机勾验本批未重跑。
- **2026-10-12 语法糖批 I 完成**（本会话；权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.66**）：
  `@` 函数头反解成规范 §3.2 的**「时机 …：」块头**，正文缩进一级——10 万行有了章节锚点。
  1. **为什么是这根杠杆**：台词行已 99.2%，再加台词类糖是往满了的方向上加；而读者打开文件的
     第一行永远是函数头，头留原代码时他知道"这里开始一段"却**不知道是哪一段**。
  2. **契约口径三条**（用户拍板方向，口径本批定）：① **标签 = 作者写得出的那一行**——默认类型段
     整个省略（`…_MESSAGE_COM_K1_300` → `时机 指令 300：`），非默认段按 §3.2 写命名参数
     （`时机 指令 60 类型: SCOM：`），默认值 = adapter `segments` 声明的**第一个键**（与 `codegen`
     缺段规则同源）；② 角色号 `{n}` 不进标签，家族段非空收成 `（X版）`；③ 解不出 / 歧义 /
     段名未在语法层登记命名参数 → **整头不标** + 成因 `other` 不静默。
  3. **新模块** `kojo-sugar/src/faces-reverse.ts`（纯反向算术，游戏知识仍只在 adapter）；
     `LiftDeps.faceTable?: () => KojoFaceTable | undefined` 注入，`index.ts` 接 `faceTableOf()`。
  4. **两个 bug + 一次口径回改**：`{t}` 未进 `slots` 造成捕获位错位；`${com}` 宽松字符类把
     `MESSAGECHECK_COM`/`PALAMCNG_A` 吞成"指令的类型段"（**错标比不标危险**）→ 只认声明取值
     75.7%→81.9%；单测绿后才发现产出 `时机 指令 COM 310：` 是"读得懂但写不出"，根因是
     **把"不丢信息"误当第一判据**。补**闭环测试**：8 条真实标签逐个喂回 `transpile`，
     断言产出同一个函数名——糖视图与糖语法分叉就会红。
  5. **读数（2,285 文件 / 100,532 个头）**：**函数头可标率 81.2%**（81,656）｜行覆盖 56.8%→**58.8%**｜
     文件覆盖 97.5%→**97.8%**｜台词/输出 99.2%、SIF 93.3% 不变｜段 326,330→**333,895**
     （+7,565 = 正文全为骨架的头自成一段，**用 ViewZone 数买读感，明码记账**）｜不变量违例 0。
  6. **守门第四把尺子**「函数头可标率」（断言 > 0.7；退化落点实测 **8.1%**）；行覆盖下限随能力
     上移 0.5→**0.55**（撤掉批 I 不误红，那条回归由函数头尺子负责——每把尺子只管一件事）。
  7. **基线更新：1398 passed / 11 skipped（1409）**；typecheck root + app 双 exit 0；审计 A–D 全绿
     （16 插件）；教学/归因/调用面/编码往返语料守门 5 文件 11 测试全绿；`vite build`（app）✓ 31.2 s。
  8. **未做**：18.8% 的头**故意不标**（`MESSAGECHECK` 四件套、`KOJO_*_CUSTOM_BUTTON_*`、工具函数）；
     反糖**写回**口径（`liftSuggest` 侧生成时机声明与三件套）不在本批；着色层字面记号误着色
     需契约级段元数据；函数骨架合并（`RETURN`/`CALL`/`LOCAL` 仍是未投影榜首）待单独立项。
- **2026-10-12 语法糖批 J 完成**（本会话；权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.67**）：
  角色状态赋值行反糖（`CFLAG:TARGET:1088 += 50` → `她的好感度 += 50`）。**本批真正的产出是
  堵死一个从批 D 就在的假阳性**。
  1. **判据一条**：左值必须是**角色作用域族**（九族），且反糖**真的改动了字**；右值走同一个
     `reverseExprAttributes`。分母刻意**不含 `LOCAL`**（口上域 122,065 条赋值里 `LOCAL` 占 72%，
     那是读者噪声底）——判据与尺子同源，否则读数会骗人。
  2. **假阳性**：`CFLAG:1:好感度`（**角色 1 的**好感度）被读成 `她的既成事実:好感度`——
     `EXPR_REF_RE` 的作用域组只认 `TARGET|MASTER`，遇到数字角色号就把 `1` 当属性编号去查名。
     批 G（行内条件）/批 H（`SIF`）同样受影响，**§5.63 当时归档的"真实文件目视"就是这条洞的
     样本**（已在两处文档标注作废）。根因记牢：**覆盖率量的是"有没有被处理"，量不出"处理得对不对"**
     ——错标能骗过所有覆盖率尺子，只有读样本会看见。
  3. **守卫**：无显式 `TARGET`/`MASTER` 作用域而匹配后仍紧跟 `:` → 整支不动（三段以上引用是
     "别的角色"，规范 §3.8 里糖没有对应写法）。与插值通道（`sugarForRef`）的判据对齐。
  4. **读数**：**状态赋值可读率 26.0%**（5,344 / 20,532；守卫前是**虚高**的 43.8%，掉下来的
     3,642 行全是假阳性）｜行覆盖 58.8%→**59.0%**｜成因 `other` 461,442→**452,456**｜
     台词/输出/SIF/函数头**逐字不变**（守卫只改文本、不改是否投影）｜不变量违例 0。
  5. **剩下 74% 的成因三分**（口上域 20,562 条候选行）：其它角色号作用面 **57.4%（故意不标）**｜
     名字索引原文已可读 **27.3%**｜数字索引**字典查不到** `TEQUIP:4` 之类 **15.3%（L0 数据缺口）**
     ⇒ 这把尺子的**天花板 ≈ 41%**；要再高得先给 §3.8 加「角色 N 的属性」写法 = **语法层决策，待用户拍板**。
  6. **守门第五把尺子**「状态赋值可读率」（下限 0.2）；**基线更新：1411 passed / 11 skipped（1422）**；
     typecheck root + app 双 exit 0；审计 A–D 全绿；语料守门 6 文件全绿；`vite build` ✓ 24.3 s；
     三个探针同批删除。
- **2026-10-12 语法糖批 K 完成**（本会话；权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.68**）：
  演出行 `CALL HPH_PRINT` 投影成 **「心形 …」**（规范 §3.9）——本组迄今最大的一根杠杆。
  1. **为什么**：探针实测口上域 `CALL` 行 **135,720** 条里 HPH_PRINT 占 **67,808 = 50%**，
     而这些行的第二个参数**就是要给读者看的台词**；不投影等于把台词关在指令里。
  2. **形态集中**：96.8% 是 `CALL HPH_PRINT,@"字面量","模式"`（逗号调用式）、1.4% 括号式，
     其余 1.8% 是变量实参 / 缺模式字母 / 字面量内嵌引号——**判据只需三条**
     （必须 `@"…"` 格式串、模式 ∈ `w/l/dw/dl`、调用式必须整齐）。
  3. **文本走 `readableText`**：`@"…"` 就是引擎的"展开 `%…%` 字符串"，语料实证参数里写的就是
     `%CALLNAME:MASTER%` → 显示 `{你}`。**「」原样保留**（正向 `heartCall` 会剥引号，但显示口径
     的第一职责是"读者看见的 == 游戏打印出来的"）——**这个不对称必须记着**：将来写回口径接
     心形时要重新定义引号规则，不能复用显示层输出。
  4. **读数**：**演出行可投影率 98.0%**（65,903 / 67,282，第六把尺子）｜行覆盖 59.0%→**60.8%**｜
     **段数 332,614→289,542（−43,072，−13%）**——演出行原先每行切断糖段，现并入连续段落，
     **读感与性能同向**（做错的批通常表现为段数上涨）｜其余五把尺子逐字不变｜不变量违例 0。
  5. **两个我自己的错**（写进日志避免重犯）：`HEART_RE` 一度要求闭括号前有空白 → 括号式全落空；
     **探针把源行截断到 44 字符，骗我以为"无模式字母的行也投影了"**——打印样本不能截断关键字段。
  6. **基线更新：1420 passed / 11 skipped（1431）**；typecheck root + app 双 exit 0；审计 A–D 全绿；
     语料守门 6 文件全绿；`vite build` ✓ 24.1 s；三个探针同批删除。
- **2026-10-12 语法糖批 L 完成**（本会话；权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.69**；
  规范 **v1.2 → v1.3**，唯一增量在 §3.8）：糖新增 **`角色12的好感度`** 写法（→ `CFLAG:12:好感度`），
  反向同源；并**首次兑现** §3.8 里"引用其它角色 `{角色12的名字}` → `%CALLNAME:12%`"这条只写在纸上的承诺。
  1. **为什么动语法层**：批 J 成因三分后最大一类是**表层缺口**——实测 108,968 次三段式变量引用里
     **33.6%（36,601 次）是数字角色号作用面**，v1.2 语法对此无能为力。方向由用户 2026-10-12 拍板。
  2. **边界由读数定死**：数字必须是**字面角色号**；`ARG`/`LOCAL`/角色号变量（实测 ~1.2% + 长尾）
     **不提供写法**（作者写不出、读者也认不出是谁 → 要引用用 `别名`）；`PLAYER` 按引擎别名归到 `你的`，
     **不新造第三种代词**。
  3. **反向判据收拢成一个点**：批 J 那个"只吃第一段"的表达式正则换成**一次吃全 1～2 段**，
     插值通道与表达式通道**共用 `segmentsToSugar`**；`sugarForRefParts` 下线。
     批 J 假阳性的根因正是两条通道各写一套规则——这是那刀的第二下。
  4. **顺手修掉一个引擎不认的产物**：`{她的名字}` 此前产出 `%CALLNAME:TARGET:名字%`
     （`CALLNAME` 以角色号为索引，没有"名字的索引"）→ 现在产出 `%CALLNAME:TARGET%`。
  5. **拆地雷**：golden 断言原先按**行号区间**从规范抽代码块（`specSlice(735, 753)`），本批给 §3.8
     增补十几行就整片红四次。**golden 是内容契约不是行号契约** → 改为标题 + 围栏锚定
     （`specCodeBlock(/^### 6\.1 /, 0)`），逐字节断言不变。与 §5.64 那次"锚点删掉 2,935 行"同族事故。
  6. **读数**：**状态赋值可读率 26.0% → 54.8%**（11,255 / 20,532，尺子下限随之上移 0.2→**0.4**）｜
     行覆盖 61.0%｜段数 289,542→**287,805**｜其余五把尺子**逐字不变**｜不变量 0｜
     golden 产物**逐字节零回退**。**批 J 估的天花板 41% 低估了**（实测 54.8%）——
     推算落点只是参考下限，不是承诺，这句留在记录里。
  7. **基线更新：1426 passed / 11 skipped（1437）**；typecheck root + app 双 exit 0；审计 A–D 全绿；
     教学/归因/调用面/编码往返语料守门全绿；三个探针同批删除。
- **2026-10-12 折叠口径已拍板并固化为 ADR-0006**（`docs/adr/0006-sugar-view-code-folding.md`，
  本批只写决策**不写实现**）：糖视图**允许**收起函数骨架，但必须「默认收起 + 可展开原文」，
  白名单封闭可证（只允许 `LOCAL` 赋值 / `RETURN` / 空行，**有副作用的一律不折**），
  折叠数在状态栏可见、偏好可整体关掉。**实施前的 7 条核对清单写在 ADR 末尾**（含契约要加
  additive 字段、第七把尺子必须是「副作用数恒为 0」的硬不变量）。
  > **状态更新（同日批 M）：搁置——前提被实测否证**，权威记录 **§5.71**。折叠的收益只来自**成串**，
  > 而实测口上域 3,621,150 行里"无调用 `LOCAL`/`LOCALS` 赋值 + `RETURN`"的串长分布是
  > **长度 1：294,772 串｜长度 2：355｜≥3：90 串共 377 行**；全量跑投影只产出 **89 个折叠段**
  > （占未投影行 0.1%）。所以剩余 39% **不是"代码成块可藏"，而是"代码逐行夹在台词中间"**。
  > ADR 的**口径继续有效**（如果将来真出现成串骨架，7 条清单直接用），只是**目前没有折叠对象**。
- **2026-10-12 语法糖批 M 完成 = 一条负结果**（权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.71**）：
  1. **纪律（本批唯一新增的可复用资产）**：任何"把噪声移开"的方案（折叠 / 灰化 / 分组）立项前
     必须先要一张**排布分布表**（run-length / 直方图）。动机表里的"多少行"只回答"有多少"，
     不回答"是否连成块"——把逐行交错的问题当成成块可折的问题，就是这么发生的。
  2. **读数不利时放弃方案，而不是放宽判据凑收益**：放宽到"任何非角色族赋值"能把可折行数从
     377 抬到 ≈12.9k（0.36%），代价是把"什么算无副作用"从封闭白名单变成会持续滑坡的启发式——
     这正是批 J 假阳性的同一种诱惑。**不做**。
  3. **不留半成品**：已写好的投影 `LineRec.fold` / 契约 `segment.folded` + `stats.foldedLines` /
     宿主过滤 / 9 条单测 / 守门折叠审计 **六文件整批 `git checkout` 回退**；回退后复跑
     `kojo-sugar` **389 passed**、`git status` 干净、**契约零改动**；守门**没有**新增恒为 0 的第七把尺子。
  4. **修正后的下一批首选**（都有现成糖写法可套，按未投影行数排）：
     ① `DATAFORM` / `ENDDATA` **17,734 + 3,532 行**（`PRINTDATA` 数据表 ↔ 糖的 `随机`/`选项` 族读法）｜
     ② 未配对 `SETCOLOR` **17,713 行**（§3.9 `着色 …：` 块；但分发器收尾 `RESETCOLOR` 的覆盖性是
     规范 §9 第 5 条**待实机**项，未实测前不放宽配对判据）｜
     ③ `CASE` **3,502 行**（`是 …：` 写法已有，缺块内正文接入）｜
     ④ L0 数字索引缺口 `TEQUIP:4` 一类（15.3%，属数据包不属投影）。
     > **同日 §5.75 已把这四条逐条量过，①③④ 不成立**（①卡在语法层缺写法→需用户拍板；
     > ③真缺口只有 207 行；④菜单族在口上域只有 267 行 `PRINTBUTTON`）。**以 §5.75 的表为准**，
     > 这里保留原文只为显示"候选表是怎么被实测改掉的"。**每一项照例先探针（含排布分布）再定语义。**
- **2026-10-13 判据①发版样例批完成**（权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.82**）：
  用户要求"判据①的测试 kojo 必须足够复杂、足够长、涵盖所有情景所有关键字"。原来那份是
  **四行**（`角色: 49` + 一句台词），只验保存链路，不验编译产物的可跑面。
  1. **交付**：`fixtures/sugar/release-check.kojo`（**353 行**，21 个时机分野逐项 / `成否:` 四取值 /
     `类型:` 四取值 / 别名四形态 / 嵌套控制流 / 表达式如果与当 / 范围与取反 / 九个中文运算符逐个 /
     心形四模式 / 着色块内套如果 / 选项块三键（条目内嵌套）/ 原生直通行 + `@` 块含 FOR·NEXT、
     `$标签`+GOTO、#DIM/#DIMS / 一整段**英文关键字**块）→ 产物 **778 行 / 73 个函数** golden。
  2. **核心是"覆盖率从人的记性挪进断言"**：新守门 `sugar-releasecheck.transpile.test.ts` 的覆盖断言
     派生自**单一真源**——`keywords.ts` 的 `KEYWORDS`（转译器与编辑器补全共用）+ adapter 的
     `KojoFaceTable.faces` + 运算符/`续`/`不在`/`成否:`/`类型:` 取值表。**以后新增关键字或分野
     而没在发版样例里用过，直接红**。头部英文别名例外（一份文件只能声明一次头部），
     其等价性由 `transpile.test.ts` 的头部等价用例守住——注释里写明了这个分工。
  3. **断言当场抓到两个真问题**（本批净收益）：① 同一时机里写中文 `隐藏情景:` + 英文 `skip-scene:`
     生成**两个同名 MESSAGECHECK 函数**；② **`时机 指令 310 成否: …` 与同文件独立的
     `时机 成功 310：` 生成同一个 `SUCCESS_COM_K145_310`，转译器零诊断**（`timing-duplicate`
     只管同划分野同编号）。样例已按规避方式改写（`成否:` 用 316–319），**转译器补诊断另立任务**。
     为此断言里还加了**「产物函数名不得重复」**与各结构（IF/SELECTCASE/FOR/#FUNCTION/PRINTDATA）
     **配对平衡**——"口上全哑"那类事故的静态半边。
  4. **角色号取 145**：168 角色里 155 个有前人口上目录，145 号没有 ⇒ 不会撞 `@M_KOJO_K145` 函数名；
     清单里写明"存档没有 145 就只改 `角色:` 一行"。
  5. **手工清单 §二 重写**：a–h 保留（保存链路），新增 **i0–i3** 以本样例为输入，逐项列出实机应
     看到的九类现象（节奏 / 插值 / 控制流 / 选项三键菜单 / 演出四模式 / 开关与位协议 / 别名 /
     原生直通 / 注释），附"看到重复定义 = 你把 `成否:` 和 `时机 成功` 同时写了"的排查提示。
  6. **验收**：`vitest run` **1448 passed / 13 skipped**；语料三 gate（投影/教学/发版样例）全绿且
     投影读数与 §5.75 **逐字相同**；转译零 error **零 warning**；typecheck root+app / 审计 A–D 全绿。
  7. **未做**：实机半边（本机无 GUI 会话）；数据表仍无糖写法（§5.75 的规范决策）；
     跨划分野撞同名函数的诊断 = 任务清单第 20 项（**§5.85 已收**）。

- **2026-10-12 晚 · UI 归一批（本组第一次接管糖组界面；详见 §5.76）**：用户口径「糖组的 UI
  不是他们的长处，UI 优化归本组」。**只动呈现层，`sugarViewAllowed` 的判据一行没改**。
  1. **可判定的三条不一致**（每条都有仓内对照物，不是口味）：模态 `primary` 恒=推荐项且排最右
     （三家老模态如此，糖组那版**反了**）；命令面板标题裸动宾无括号（其余 13 条皆然）；
     面向作者的句子不含实现术语（`已映射` / `EraBasic` 下屏，摘要改 `语法糖 N 行`）。
  2. **徽章配色按风险给**：`只读`(安全默认态) 从 `--amber` 改中性、`已解锁`(写保护已失效)
     改 `--warning`——初版恰好相反，一屏二十个琥珀＝喊狼来了。
  3. **修一处会裁台词的算术**：ViewZone 盒高 = `行数 × Monaco 行高(19px)`，而 `.sugar-zone`
     按 `12.5px × 1.6 = 20px` 排版，>19 行的长段尾部被 `overflow: hidden` 裁掉。新增
     `editorLineHeightPx()` 读实测值喂 CSS。**踩坑**：第一版读 `.view-lines`（容器）——Monaco
     把 `line-height` 内联写在**每条 `.view-line`** 上，容器只有 `white-space: nowrap`，
     读它得 `normal` → 静默退回兜底、改了等于没改。
  4. **无障碍反向补齐**：`role="dialog" aria-modal` 此前**只有**糖组那两个新对话框有，
     三家老模态全无；现五家齐 + 开关补 `aria-pressed`。
  5. **本仓第一条渲染型测试**：`packages/app/tests/sugar-dialogs.test.ts`（13 项），
     从 `.ts` 里 `renderToString(createElement(...))`——vitest `include` 只收 `*.test.ts`
     但 `resolve.extensions` 含 `.tsx`，**零新依赖**。
  6. **实机目视已做**（补掉 §5.64 挂的共同欠账）：真实项目 2,285 ERB / 99,104 函数，
     新文案与层级全部落地可见；T3 真实文件夹视图同场回归通过。
  7. **基线**：**1362 passed / 11 skipped**（1348 + 本批 14）；typecheck root+app / 审计 A–D /
     app build 全绿。

- **2026-10-12 晚 · 导出批（反馈 1a + 2；详见 §5.77）**：工作区改以 `.kojo` 为源，导出打
  **制品 ZIP**，部署自动转译。
  1. **判断**：#14（默认 `.kojo`）与 #17（导出/部署转译）**必须同批**——`.kojo` 一成为默认，
     既有的"逐字节复制"部署就变成**静默不生效**（引擎只读 `.ERB`，不报错），比报错更糟。
     任务清单按反馈条目分列 ≠ 按依赖分列。
  2. **ZIP 在 TS 层**（用户拍板不给 Rust 加 `zip` crate）：`plugin-api/src/zip.ts` 只做容器
     （本地头+中央目录+EOCD+CRC32），压缩用平台自带 `CompressionStream('deflate-raw')`。
     三条硬规矩：UTF-8 名字位 bit11 必置（中日文文件名）、分隔符一律 `/`、deflate 变大退 store。
  3. **编码口径只留一份**：契约新增 `compileToBytes`（纯、零 IO），`compileToFile` 改为**调它**
     拿字节再走原 3-6 步 ⇒ 导出产物与保存产物不会各自拼 BOM/换行而漂移。
  4. **新增 `exportFile` 落点能力**（FileIO/PlatformBridge/Rust）：与 `export_directory` 同一
     "对话框即授权"模型，落点在写域外是设计意图；字节走 base64（仓内既有约定）。
     **时序**：打包先于弹框——转译失败不弹一个注定失败的对话框。
  5. **糖服务用 `tryInject` 且延迟到点击时**：写成 `requires` 硬依赖会让糖插件停用时
     **整个 adapter 不激活**（游戏识别全废）；且 adapter 早于糖插件激活，当场取必为 undefined。
  6. **验证到"真解压工具"这一层**：往返自证读器 21 项 + 制品规则 13 项 + 本机 `.NET ZipFile`
     交叉验证 + **实机端到端**（新建项目 → 磁盘 8 个 `.kojo` → 导出 → 解包得 8 个 `.ERB` +
     README、`.kojo` 残留 0、产物带 `ef bb bf` BOM）。
     ⚠ **`unzip` 显示乱码不是包的问题**（Info-ZIP 在 Windows 按 OEM 码页转名），
     **别为此删掉 bit11**——那会真弄坏 Explorer/7-Zip 下的中文名。
  7. **基线**：**1400 passed / 11 skipped**；双 typecheck / 审计 A–D / app build /
     `cargo test`（12 项）全绿。
  8. **待用户定夺两件**：① **LTOL（时限开放许可）查不到权威全文**（联网两次皆空），
     法律文本不凭记忆编造——需用户给原文，或确认它只作"待填框架"（→ #16 卡在这）；
     ② `exportDirectory` 在导出改走 ZIP 后**暂无 UI 调用方**，属契约收缩，未顺手删。
     （**后续**：看板 HK-3 复核后已于 §5.97 删除，绕闸通道收回 `exportFile` 一条。）

- **2026-10-12 深夜 · 工作区新建条目批（反馈 1b；详见 §5.78）**：「我的项目」区右键
  → 新建文件夹 / `.kojo` / `.ERB` / `.txt`，行内命名框（**不用 `window.prompt`**，
  WebView2 里它可能静默返回 null）。
  1. **给后来者最有用的一条**：本仓根 tsconfig `lib: ["ES2022"]` + `types:["node"]`，
     **不含 DOM**，且 16 个插件正文实测零 `document`/`window`。插件里要用事件/元素时，
     按**结构化最小类型**声明（`(e: { target: { value: string } })`、
     `useRef<{ focus(): void } | null>`），视口宽走 React 合成事件的 `e.view` ——
     **不要给 `lib` 加 DOM**，一加插件就会自然地开始依赖 `document`，那道边界就没了。
  2. **命名取向与脚手架刻意相反**：程序自造的名字可静默消毒（`sanitizeSegment`），
     **作者手打的名字一律拒绝 + 给原因**（悄悄把 `A/B` 改成 `AB` 等于让他以为编辑器坏了）。
     预览名与建成名同源一个函数，堵掉"提示说 A、建出来是 B"。
  3. 菜单复用壳层既有 `.context-menu`；行内框度量对齐 `.kp-file-btn`；失败原因独占一行
     （侧栏窄，塞后面会被挤成看不见的碎片）。新建后自动 `reveal` 打开、只重拉该目录不闪树。
  4. **实机走通**：右键 → 选类型 → 输入（实时预览 `→ 测试新建.kojo`）→ Enter →
     磁盘出现该文件、树里就位、**编辑器自动打开且可写（无 🔒 徽章）**——
     顺带把 ADR-0005 轴一在真实场景里验到了。
  5. **基线**：**1414 passed / 11 skipped**；双 typecheck / 审计 A–D 全绿。

- **2026-10-12 深夜 · 许可协议可选批（反馈 4；详见 §5.79）**：新建项目向导的
  「附带 LICENSE」勾选 → **七选一下拉**（不生成 / 占位模板 / LTOL / CC BY-NC 4.0 / MIT /
  BSD-2-Clause / ISC），缺省「不生成」。
  1. **纪律**：许可证不是文案，**只有三种合法来源** —— OSI 标准条款逐字内置、
     用户提供的权威原文逐字内置（LTOL）、明示"要点速览 + 官方链接"的指引（CC BY-NC）。
     我联网两次查不到 LTOL 原文，**没有自己起草**，停下来问到了原文（日文 + 中文）。
  2. **LTOL 一字未改**，日文在前（源头语言）、中文随后，**连原文自身的编号差异都保留**
     （日文版第 3 节下是 1./2.，中文版是 3-a/3-b）——"顺手统一"就等于重新解释条款。
     单测用逐字关键句 + 长度双钉，防后来者"觉得别扭"就动一个字。
  3. `includeLicense: boolean` → `license: LicenseKind`，不留兼容 shim。
     勾选框消失后 `.wizard-field.wizard-check` 两条 CSS 成了自引用孤儿，删掉。
  4. 说明放正文里而非 tooltip：许可选择是"读完再决定"的动作。
  5. **基线**：**1430 passed / 11 skipped**；双 typecheck / 审计 A–D 全绿
     （LTOL 属游戏知识 ⇒ 只住 adapter，未进内核与 plugin-api）。
  6. **未做实机视觉复核**（vite 整页重载 + 宿主窗口反复最小化，没继续抢前台）——
     风险面小，但没看过就是没看过。

- **2026-10-12 深夜 · 三线合流批（本组六提交 rebase 进 master；详见 §5.80）**：
  远端两轮共前进 **25 个提交**（快照卫生 / 语法糖批 I–M / 抽取与校验按文件增量 / 名称解析 memo /
  回放线重测 / 度量批）。真冲突面按 merge-base 求交集：第一轮 4 个文件、第二轮 5 个
  （多出 `eratw-adapter/src/plugin.ts`，两侧改的是不同区域，**自动合入未手工干预**）。
  1. **一夜编号撞了两次**（累计第四、五次）：本组五节最终落 **§5.76–§5.80**。
     第一次是跨轮沿用了旧号；第二次更值得记 —— **取号取对了，但推送时机错**：
     第一次 rebase 后按当时最大号 §5.72 取了 §5.73–§5.77，推送被拒才发现远端已到 §5.75，
     把我刚取的号占掉了。**改号返工六条提交的历史**就是代价。
     → 口径升级：**文档批最后写、最后推**。代码先 rebase → 全闸验证 → 立刻推 →
     再写日志（此时取号才反映真实远端态）→ 单独 docs 提交。把写文档放在推送链路最前面就是埋雷。
  2. **往别人章节追加内容 = 自找冲突**：我方给 §5.64 末条追写的一行续写，会跟着冲突块
     被搬到文件尾、脱离原列表。两轮都手工搬回过一次。
  3. **基线算术闭合**：远端 §5.72 自记 **1440** + 本组净增 **82** = 第一轮实测 **1522** ✓。
     ⚠ 对基线要认 **IMPLEMENTATION-LOG 各批自记的数**：远端 HANDOFF 汇总行写 1432 而 LOG 写 1440，
     摘要行滞后了一批，按它核对会得出"+90 对不上"的假警报（§九-31）。
  4. **索引行改为从 LOG 实际标题重建**（32 条），不再手工维护 —— 手工合并三轮后必然拼成混合体。
  5. 工作树里**不属于本批**的在制品（`src-tauri/icons/` 图标改 PNG 驱动）：未提交未丢弃，
     用带唯一标记的 `git stash push -u` 暂存、`apply` 确认原样后再 `drop`（两轮各一次）。
  6. **基线：1522 passed / 11 skipped**（第二轮 rebase 后需重跑确认）；
     双 typecheck / 审计 A–D / app build / `cargo test` 全绿。

- **2026-10-13 · 设置页归一批（反馈 8；详见 §5.83）**：设置 overlay 从 4 项平铺改成分层。
  1. 分「视图 / 编辑器 / 布局」三组（组标题用小号 dim + 一条分隔，**不加粗不放大**——
     面板不该比它承载的内容更显眼）。
  2. 「编辑器居中限宽」是写作模式的从属项，非写作模式下它什么都控制不了 → 缩进一级 +
     `disabled` + 提示改「需要先开启写作模式」。**给一个点了没反应的控件，比给一个明确
     不可用的控件更糟**（前者让人怀疑自己操作错了）。
  3. 去掉漏给用户的魔数「（约 1000px）」；语法糖视图的说明按 ADR-0005 写准
     （原文案"仅对 .erb 生效"不准确，真正生效域是"游戏目录里未解锁的那一份"）。
  4. 页脚合成一行并守全站模态房规（primary 恒为推荐项、排最右）：原先「重置布局」与
     「完成」同权重、各占一行。`.settings-actions` 随之成孤儿规则，删。
  5. **差点写进文档的一句假声明**：验证表初稿写"设置项行为由 `layout.test.ts` 的 reducer 覆盖"，
     去核对才发现 `reducer` 内联在 ShellLayout、没导出也没测 —— 审阅补测批漏了动作本体。
     处置不是改措辞了事，而是把 reducer 搬到 `layout.ts`（依赖本在那儿，近乎零成本）
     并补 6 条断言。**凡在文档里声称"某处已被测试覆盖"，必须当场跑一遍那条测试。**
  6. **基线：1536 passed / 11 skipped**；双 typecheck / 审计 A–D / app build 全绿；
     设置页实机看过（三组分层、从属项置灰禁用、页脚单一 primary）。
  7. 推送纪律第二次执行：代码先 rebase → 验证 → **立刻推**（`a07f7eb..52c9bdd`）→ 才写文档，
     全程 rebase 零冲突。别线两次占过 §5.76 均**自行让号**到 §5.81 / §5.82，本组五节不再返工。

- **2026-10-13 · BUG-5 文件监视批（发版判据②；详见 §5.84）**：`file.changed` 从此真的有监视器在生产路径上产生。
  1. **原缺陷的形状**：`PlatformBridge.watchDirs` 的 Tauri 实现是 `console.warn` + 空取消函数的**占位**，
     全仓无生产调用方；而测试桥 `NodeBridge` 早就实现了 `fs.watch` ⇒ **契约齐、测试桥齐、
     生产实现空，所有测试全绿**。这是"量测试桥不等于量生产桥"的一整类漏口。
  2. **分层**：Rust 加 `start_watch`/`stop_watch`（notify 8.2 递归监视，原始事件逐条转发，
     零策略）+ 桥 `listen('kojo:fs-changed')` ↔ 回调 + **内核** `FileWatcherServiceImpl`
     （200ms 尾缘去抖、末态类别合并、根目录折叠、会话号竞态）+ 宿主只做生命周期与呈现。
  3. **契约演进（additive）**：`watchDirs` 增可选 `onReport`（监视器自述：逐根结果 + 运行期失效）；
     新事件 `file.watchState` 走 **`KERNEL_ONLY`** 表 ⇒ 可 emit 白名单仍 16，计数不动是设计结果。
     判级四态 `watching` / `partial` / `unavailable` / `stopped`，后两种由宿主弹常驻 error toast。
  4. **三条退化落点实测过**：撤会话号 → 2 条竞态用例红；平台不过滤原子写临时文件 → 真 fs 用例
     **当场先红后修**；撤去抖 → 合并用例红。窗口从**首条**事件起算且不重置（重置版在持续写入上饿死）。
  5. **真实链路怎么证的**：`watcher.realfs.test.ts` 走真 `fs.watch`（写文件 → 恰好一条事件 /
     范围外零事件）；Rust 侧事件流**证不了**（`EventHandler` 要 `AppHandle`），只对纯映射下测试，
     真实投递留人工清单 §2.J。本机 `cargo` 冷启动且 `cargo add`/`fetch` **必须走代理**（已进 §十二）。
  6. **消费方边界（刻意不做，下一批）**：外部改 ERB 后**函数树不会自动重建**（`erb-parser` 只订
     `project.opened`）、文件树 `dirCache` 不失效、归档列表不自动重扫——接成"整库重建"要先量
     快照复用与增量粒度，塞进 bug 批会得到"能自动刷但每次刷 2 秒"。
  7. **基线：1560 passed / 13 skipped（1573）**；双 typecheck / 审计 A–D / app build / `cargo test --lib` 17 全绿。

- **2026-10-13 · 演出配色探针批（详见 §5.120，零代码改动）**：糖线第二杠杆被量否 + 规范 §9-5 的理由被量歪。
  1. **25,083 个 `SETCOLOR` 里只有 23.4% 同深度成对，74.2% 是被下一个 `SETCOLOR` 覆盖**（链式改色，
     压根没有收尾）⇒ "把未配对 SETCOLOR 投影成「着色 …：」块"会给 76.6% 的行**编造一个不存在的边界**，
     撞上 §5.109 那条"错标比不标危险"。行级注记是唯一诚实的形状，但对"读懂剧情"零增量 ⇒ **不做，候选位让掉**。
  2. 规范说"分发器在 37 个调用面的**返回路径上**都有 `RESETCOLOR`"：本机 `KOJO_MESSAGE.ERB` 里
     **正好 37 处**（数字对上），但**只有 19 处紧邻 `RETURN/BREAK`**、3 处是入口复位、**15 处两者都不是**。
     ⇒ 结论也许仍对，但它现在依赖一个**没验证过的机制**；坐实需要 `_emuera_src`（本机没有）。
     登记在 §5.120，**不动冻结的规范本体**，也**不要**反向读成"所以现在该补 RESETCOLOR"。
  3. 方法收获：按函数计数比按总数计数诚实得多（11 个函数只有 4 个含 RESETCOLOR，
     `@KOJO_MESSAGE_SEND_IMAGE` 一处都没有）——"每个调用面都有"这种笼统句一计数就露馅。
  4. 探针跑在 `%TEMP%`、真实语料零写入、跑完即删；两处数字自洽（25,083 = 5,867 + 19,216；37 = 19 + 3 + 15）。

- **2026-10-13 · 撞名诊断批（任务 20 收口；详见 §5.85）**：产物层的「重复定义」从测试断言变成作者看得见的错误。
  1. **原状**：`指令 310 成否: …` 与独立的 `时机 成功 310：` 在 `.kojo` 面上看不出冲突，
     渲染出的却是同一个 `@…_SUCCESS_COM_K12_310`；转译器**零诊断**，只有 §5.82 发版样例守门里
     "产物不得重复定义函数"那条断言会红——**问题已被机器发现，却没交给作者**。
  2. **检查放在产物层（Emitter 函数头记账）而不是写法层**：一个后置检查同时覆盖三类撞名
     （成否 ↔ 独立成功 / 同分野同编号写两次 / 原生直通块撞名），且**跟着 adapter 模板表走**，
     以后新增会重名的模板不必再加专项规则。`setOwner()` 让诊断点到作者那一行。
  3. **severity = error** ⇒ `planSave` 阻断（`transpile-error`），不给半成品 `.ERB` 落盘
     ——判据是"产物能不能被用"，与 `timing-face-unknown` 的 fail-closed 同口径。
  4. **闭集新码** `function-name-duplicate`（与 `timing-duplicate` 的分工写在契约注释里：
     后者管写法层面，前者管产物层面）；`sugar.test.ts` 抽样同批登记。
  5. **假阳性守门 5 条**，最关键的是「每个时机都产 `@X` 与 `@X_1` 两行函数头」不许自撞
     （把它写错 ⇒ 全库皆红）。真实语料：`release-check.kojo` 353 行 / 73 函数仍**零 error 零 warning**。
  6. 自查现场：一开始只报一条诊断，查下来是**我的样例漏了块尾 `：`**（那个时机没成立），
     另 `必然成功` 不是真名（表里是 `一定成功`）⇒ **改测试不是改代码**，又一次"别凭直觉，回去查表"。
  7. **基线：1572 passed / 13 skipped（1585）**；语料三 gate 全绿、投影读数不变；双 typecheck / 审计 A–D 全绿。

- **2026-10-13 · 判据②补证批（详见 §5.86）**：§5.84 那句"Rust 侧的事件流证不了"**只对了一半**。
  1. 证不了的只有 `app.emit → WebView listen`；"**递归监视在这台机器上收不收得到事件**"
     不需要 WebView——`notify` 的接收端可以是 `mpsc::channel`。边界要划在真实位置上，
     否则实机出问题不知道该怀疑哪一段。
  2. 新增 `mod watch_runtime_tests` 2 条：三层深目录里的写入必须收到事件且映射落在契约三态内；
     第二条按 `notify/src/windows.rs` 的实际投递形态钉住映射。**`cargo test --lib` 17 → 19 全绿**。
  3. **反证实测**：`RecursiveMode::Recursive` 改 `NonRecursive` ⇒ 第 1 条立刻红，改回即绿。
  4. API 坑记一笔：`recv_timeout()` 返回**双层 Result**，枚举是 `RecvTimeoutError`
     （`Timeout` → continue / `Disconnected` → break），不是 `TryRecvError`。
  5. 留在实机的只剩事件名那一对字符串（`FS_CHANGED_EVENT` ↔ `'kojo:fs-changed'`）——
     Tauri 不检查事件名，改一边会静默失灵 ⇒ 清单 j1/j2 就是它的哨兵。

- **2026-10-13 · 监视消费方批（上）（任务 21 部分；详见 §5.87）**：外部往存档目录写档 → 归档浏览器自动重扫。
  1. **首动作零 IO**：先 `isPathUnder(project.savDir, ev.path)`，不在存档目录里直接 return——
     监视根是整个项目目录，游戏运行时的其他写入也会投递事件。
  2. **合批交给内核池**：`kernel.compute.runLatest` + **同一个 key**，插件不再自造第二个去抖器
     （合并语义已由 `kernel/tests/compute.test.ts` 守）。
  3. **`refresh()` 改为返回扫描的 Promise**：原先 `void snapshots.scan()` 内部吞掉，
     池看不见"在途" ⇒ **单飞等于没开**。这是接线层最常见的假接入：调了 API，交出去的却是"发起"而非"完成"。
  4. **刻意不做**：外部改 ERB → 函数树/索引重建。既有读数"改一个 ERB 后重开 ≈ 2.1s"，
     而索引是全项目动作 ⇒ 接成事件触发 = 给每次外部写入挂 2 秒主线程工作；属性能线一整批（要先量）。
  5. **刻意留下批**：`FileTree` 的 `dirCache` 是组件私有 useState、**没有任何失效通道**
     （`ensureDir` 里 `has(dir)` 直接短路；"折叠全部"不清缓存）⇒ 要做得新增 prop 穿到
     `StableFileTree`，而本机跑不了 GUI。**不能亲验的 UI 改动不空投**。
  6. 面板过期文案已改（"目录监视未实现，用刷新重扫"从本批起是假话）。
  7. **守门**：`ui-archive-browser/tests/watch-rescan.test.ts` 5 条，反证实测
     （去掉 `isPathUnder` ⇒ 2 条红）。计算池用零调度直跑替身（审计 B 项禁止插件测试 import 内核）。
  8. **基线：1577 passed / 13 skipped（1590）**，91 文件过 / 7 跳（98）；实机半边进清单 **§2.J j9**。

- **2026-10-13 · 批 N 数据表投影（糖线；详见 §5.112）**：1.8 万行 `DATAFORM` 从原始代码变成候选清单。
  1. **只给结构标注，绝不借用糖关键字**：糖表层没有数据表写法（§3.6 `随机：` 的产物机制不同、
     且表达不了"轮流"），写成 `随机：` 就是 §5.66 否证过的"看着像糖、写回语义不同"。
     先例是同一文件里的"裸指令打空行"——**糖里没有对应写法的刻意显示口径**。
  2. **标签只陈述核对得上的事实**：「数据表 · 择一输出（以下 N 条）」；
     `…L/…W/…K/…D` 变体词**原样回显**，不写成随机/轮流——翻了语料全文与 README 集，
     **没有引擎侧出处**（§5.75 那句"L=轮流"是我自己上批的无源结论，这次不打给读者）。
  3. **判据全可证明，配不上整块不动**：块内只允许条目/空行/注释、必须配对 `ENDDATA`、
     正文过不了可读化管线只降那一行。实测 **3,685 块中只有 2,812 块纯条目**，
     873 块含 `DATALIST/ENDLIST`（2,380 对）⇒ 整块保留原代码，**条目也不投影**。
  4. **顺带更正 §5.75 的记录**：那次写"3,552 块全部纯条目"，两次"纯"的定义不同
     （当时没把 `DATALIST` 当语句）。同一族数据第二次自我更正，方法只是**换个角度重跑**。
  5. **第七把尺子**「数据表条目可读率」**57.4%**（10,421/18,154），下限 0.5；
     退化落点当场实测：**摘掉本批 → 0.0%、行覆盖 61.4→61.0%、段数涨回 287,805**。
     段数**下降**（287,805 → 285,546）= 方向正确的形态学信号。
  6. 12 条真实完整样本目视核对（探针同批删除）。**基线：1801 passed / 14 skipped（1815）**，
     三 gate 全绿、不变量违例 0、双 typecheck / 审计 A–D 全绿。
  7. **教训**：「必须先改规范」隐含一个没检验的假设——这能力只能活在写回层。
     **作者怎么写**确实是规范决策，**读者能不能看懂**不是。下次遇到"卡在拍板上"的候选，
     先问"它只能活在那一层吗"。

- **2026-10-13 · 落盘引导批（用户反馈 3；详见 §5.88）**：「新建口上文件」的落点从游戏目录改成口上项目。
  1. **反馈原样落地**：无口上项目时不再停在"请先打开项目"，而是问一句 ——
     主选「新建口上项目并创建」（跳既有 P-C 向导，建完**自动**把作者正在填的那份 `.kojo`
     落进新项目最近的包里并打开它），备选「选择文件夹另存…」（`io.exportFile`，对话框即授权）。
  2. **顺带把常态落点也归位**：旧 Ctrl+N 直写 `chara.kojoDir`（游戏目录），与面板顶部常驻的
     「工作区为权威 · 游戏目录仅部署目标」**同屏相反**；改完一并消掉「写权限未批准」
     与「该角色尚无口上目录」两条死路。要进游戏目录请走「部署」（§5.77 的自动转译线）。
  3. **契约 +2 语义事件**（可 emit 白名单 **16 → 18**）：`workspace.newProjectRequested`（意图）
     与 `workspace.projectCreated`（兑现）。**刻意不做"知名 overlay id 表"**：初版把
     `eratw.newKojoProject` 写进 plugin-api ⇒ **审计 A 项当场判红**——契约层写下某适配器的
     模态名 = 让"一切皆插件"反过来依赖某个游戏。语义事件换掉它，第二个适配器可接同一意图。
  4. **关联号 `requestToken` = 两拍之间的安全绳**：没有它，作者取消了项目向导、改天从面板
     正常新建，那个新包里会冒出一份他没要过、还带着上次家族名的文件。规矩三条：请求带号 /
     兑现只认同号 / **向导一关即清号**；口径由不对称代价决定（误判"有人在等"= 替作者做决定）。
  5. **编排搬出组件**（新 `ui-sugar-editor/src/new-file-flow.ts`，258 行）：插件包无 react-dom
     点不动按钮，而本批易坏的东西全在时序里 —— 先例 `package-actions.ts`「插件只接线，
     逻辑不渲染面板也能单测」。
  6. **反证实跑**：撤关联号配对 ⇒ 2 条红；撤覆盖保护 ⇒ 1 条红；均改回后复跑全绿。
  7. **协作**：本节起新增 `HANDOFF` **§十三 跨主机协作看板**（QA-1…QA-9 交实机线 / HK-1…HK-5 本组）。
     已接实机线留在文档里的两条活 —— §5.87「函数树增量重建」**移交性能线**（他们的算账成立），
     §5.87「`FileTree dirCache` 无失效通道」由**本组认领 HK-5**（宿主 UI 正是本组范围；实机半边 QA-9）。
  8. **基线：1604 passed / 13 skipped（1617）**，93 文件过 / 7 跳（100）；双 typecheck / 审计 A–D /
     app build ✓ 1m05s / 语料 gate 2 passed 全绿；桌面壳实机半边登记为 **QA-1**。
  9. **工作树纪律（§十二-6 新条）**：本机共用工作树内存在**并发写者**（不走 git）；本组一次
     bare `git stash` 卷走过它未提交的 docs（已落成
     `.git/concurrent-docs-wip-2026-10-13.patch`，551 行可取回）。本批此后全程在独立
     worktree `<临时工作树>` 完成（`pnpm install` 走本地 store 实测 8s，不是负担）。

- **2026-10-13 · 看板 HK-5 批（详见 §5.91）**：文件树的目录缓存第一次有了失效通道。
  1. **来源不是本组排的队**：实机线在 §5.87 明记「刻意留在下一批……本机跑不了 GUI，不能亲验的 UI 改动
     不空投」——宿主 UI 正是本组范围，于是它从对方的"不做清单"变成本组的看板行 HK-5。
  2. **链路**：`file.changed` → `affectsKojoTree`（零 IO 路径分野，纪律是 §5.87 自己立的）→
     400ms 尾缘合批（**窗口不随后续事件重置**，§5.84 的饿死坑）→ `refreshNonce` 递增 →
     只重列正在显示的目录，展开态一概不动。三段逻辑全是纯函数 + 15 条用例。
  3. **本批自造的两个风险就地封掉**：重列把旧列表换成 loading ⇒ 每次 Ctrl+S 整棵树闪白（改为
     有内容就原地留、新结果到了再换）；新旧请求并发时旧响应后到 ⇒ 倒灌回改动前那份目录且没有
     下一次来纠正（按目录记请求序号，只认最新）。
  4. **手动「重新读取」不是装饰**：`file.watchState` 会如实报 `partial` / `unavailable`（§5.84），
     那种时刻自动失效一条都不会到，作者手里必须有一条不用重开项目的路。
  5. **顺手补防数据丢失**：监视根加入**作者工作区根**。`.kojo` 住在可写权威区，而"外部写盘 → 重载 /
     冲突问一下"那条链路（§5.36 B1、§5.84）此前只覆盖游戏目录那半边 ⇒ 记事本改完回编辑器 Ctrl+S
     就是静默覆盖。`rootDir()` 在无平台数据目录的环境抛 ⇒ 吞成 null，**不因为可选根带崩开项目流程**。
  6. **分工裁决写进 §13.6**：§5.90 的 #24 IPC 通道修复（`tauri-bridge.ts`）**让给性能线**——
     那文件按分工表属本组，但验收口径是他们刚建立的"真实 app 三个水位"，换一手等于把
     "量在用户跑的那条通道上"重新丢一次；同一晚两组改同一片热点就是 §5.64 冲突面的雏形。
  7. **基线：1622 passed / 13 skipped（1635）**；双 typecheck / 审计 A–D / app build ✓ 1m18s。
     反证两组实测（恒 true ⇒ 3 红；忽略展开态 ⇒ 4 红），改回后复跑绿。
  8. **实机半边**：本组随后真壳自验了反馈 3 那条链（①③④ + a1 第一拍 + 落盘字节口径全过；
     a1 第二拍**未验成**——截图坐标点不到对话框右下角的按钮，取证与判读见 §5.91「实机结果」，
     已回写看板 QA-1）。**HK-5 自己的体感半边（外部新增文件上树 / 保存不闪白）一条都没验到**
     ⇒ QA-9 保持待认领，这条不算收口。

- **2026-10-13 · 看板 HK-6 批（详见 §5.93）**：口上项目面板开始消费工作区的外部改动。
  1. **来源是上一批自己**：§5.91 把工作区根纳入监视根，"外面丢一个文件进包，面板看不见"
     就从"没人承诺过的事"变成"本批制造的期望"，所以由本批收，不留白。
  2. **判据一条**："某个目录的内容变了" ≡ 改动条目的**父目录**要重列；
     只重列**已在缓存里**的目录（作者看过的那些），改动落在工作区根的直接子层才重拉项目列表。
  3. **另写 `relistDir` 而不是复用 `refreshDir`**：后者 delete→ensure，中间那一帧渲染成
     「读取目录…」——自家动作闪一下没关系，**外部改动让整块内容闪白**就是"我在别的程序存了个文件，
     这个面板抽了一下"。读失败同样保留旧内容、只 `log.warn`（把一份正确的目录换成错误态是更坏的失败）。
  4. **更正一处注释与实现相反**（契约层）：`FileChangedEvent.path` 写"归一化后的绝对路径"，
     而 `kernel/watcher.ts` 的 `flush()` 明写"原样透传"。原样是对的（中途改分隔符会让
     "这个文件正打开着"判空 ⇒ 事件静默失效），错的是注释；顺手把消费方义务写进契约：
     **判等一律走 `pathKey()`**——本批的缓存查找就是这么做的（事件形态来自平台、
     缓存键形态来自 `join()`，Windows 上两者都不保证一致）。
  5. **带出 HK-7**：`EditorPane` 的 `entriesRef.has(ev.path)` 正是裸字符串判等，
     现网大概率"恰好一致"故**不当 bug 报**，但那是防数据丢失的 B1 链路，登记待办。
  6. **基线：1637 passed / 13 skipped（1650）**，95 文件 / 7 跳；双 typecheck / 审计 A–D /
     app build ✓ 1m02s；反证：撤掉工作区分野 ⇒ 2 条红，改回全绿。
  7. **§5.92 那批欠的"app build 未重跑"由本批补平**（见基线块）。

- **2026-10-13 · 看板 HK-7 批（详见 §5.94）**：外部改动重载不再拿裸字符串认"正打开的是哪个文件"。
  1. **同一处判等，两边不同源**：`ev.path` 是平台原样透传（§5.93 刚写进契约），
     `entriesRef` 的键是宿主自己的 `filePath`。Windows 上分隔符与大小写都不保证一致。
  2. **坏法是静默的**：判不上 ⇒ 外部改了盘而 model 还是旧的 ⇒ 作者随后一次 Ctrl+S 就覆盖掉外部改动。
     这正是 §5.36 B1 要防的数据丢失，而它**没有任何症状**——没人会知道自己正拿着旧内容。
  3. 改法：`matchOpenedPath()` 按 `pathKey()` 找回宿主用的那个键，之后一律用它
     （提示里显示的也是作者标签上认识的那条路径）；找不到 = 与编辑器无关，语义不变。
  4. **基线：1642 passed / 13 skipped（1655）**，95 文件 / 7 跳；双 typecheck / 审计 A–D /
     app build ✓ 1m03s；实机判据沿用 §2.J j1（本组坐标驱动不可靠，见 §九-33，不重复自证）。

- **2026-10-13 · 看板 HK-2 批（详见 §5.95）**：五家宿主模态第一次全部接上 Esc。
  1. **一个极小的模态栈**（`ui/modal-stack.ts`）：挂载入栈 / 卸载出栈 / `closeTopModal()` 只打栈顶
     并报告是否消费。各家自己监听键盘的话，叠着开时一次 Esc 会同时关掉所有层——作者要的是"退一层"。
  2. **Esc 一律落在不写盘那一侧，且每家在接入处显式写出自己那一格**：写权限批准→只读浏览、
     未保存确认→取消、保存告警→取消这次保存、糖视图引导→不用、ERB 解锁→保持只读。
     不用"关窗"这种含糊动作兜底（Esc 语义写错方向 = 键盘替作者做了他没做的决定）。
  3. **次序不靠层叠偶然**：`.modal-mask` 与 `.overlay-backdrop` 的 z-index 同为 `--z-modal`，
     谁在上面取决于 DOM 先后；之所以不必修它，是实践中模态与向导互斥（两边遮罩都吃掉点击）。
  4. **测试纠正了自己一处错判**：closer 不出栈（生产里靠卸载出栈），用例必须显式扮演那一步；
     若改成"closer 自己出栈"，未来任何"Esc 被拒绝"的模态都会从栈里摘掉、此后再也接不到 Esc。
  5. **基线：1648 passed / 13 skipped（1661）**，96 文件 / 7 跳；双 typecheck / 审计 A–D /
     app build ✓ 1m03s。真按 Esc 的体感半边登记为 **QA-10**（本组坐标驱动只能验屏上呈现，验不了键盘）。

- **2026-10-13 · 实机复验批（详见 §5.96，零代码改动）**：把看板上三条"本组验不了、请别机跑"的实机半边自己跑完了。
  1. **能力口径纠正**：§5.91/§九-33 写下"本组只有截图坐标"时，`tools/smoke-tauri-dom.mjs` 里那条
     CDP `Runtime.evaluate` 通道一直都在——起壳加 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
     就能用 DOM 选择器驱动整个界面。四条可复用配方（含"Monaco 走 EditContext，别去 focus 那个常年 readOnly 的 textarea"）
     写进 §5.96 首节与 §九-35；坐标驱动在本仓作废。
  2. **收掉三条**：QA-1 ②（项目建好后挂起的 `.kojo` 自动落进新包并成为活动标签，BOM+LF，建开即干净）、
     QA-9 工作区半边（外部新增/删除 ≤0.5s 自反映，零点击零刷新）、QA-10 层叠（一次 Esc 只退一层）
     + 五家模态里的两家（未保存确认 / 保存提醒，Esc 后**盘上一个字节都没写**）。
     顺带两条同源实机证据：打开着的文件被外部删除 → 「…现在是唯一副本——保存会重新创建该文件。」；
     脏 + 外部改动 → 明示"保存会覆盖磁盘内容"且**不**把用户内容换成磁盘内容。
  3. **一条口径纠正 + 一条新讨论项**：`保存告警` 实为 §5.37 的**全角空格决策**（`EditorSaveWarning.kind` 只有
     `fullwidth-space`），不是磁盘冲突守卫——QA-10 判据原文措辞已改；"要不要在按下保存时再确认一次"开成 **HK-8**（待议）。
  4. **零写入铁律复核**：全程 `find C:\Game\… -newermt "2026-10-13 02:00"` = **0 命中**；探针脚本、`%TEMP%` 备份、
     测试期挪开的工作区项目全部还原/删除，dev 壳按 PID 树收干（§九-36：不要按镜像名全局杀 webview）。
  5. **基线不变**：本批只动 `docs/`，沿用 §5.95 的 **1648 passed / 13 skipped（1661）**（推送前复跑同数）。
- **2026-10-13 · 看板 HK-3 批（详见 §5.97）**：契约收缩——`exportDirectory`（整目录复制）全链删除。
  1. **三条复核都指向"删"**：master 零生产调用方；别组在飞的 `feat/ipc-read-channel` 各文件命中数与 master
     **逐文件相同**（只有定义链，没新增调用）、`ui-polish` 一条都不含；纪要与 backlog 里没有"导出成文件夹"的将来需求。
  2. **留着它会让一句安全口径变成假的**：§六-6 写"绕开写允许域**只有一条**法定通道"，实际挂着两条、其中一条是死的。
     现收回真的一条（`exportFile`），并把"新增绕闸能力必须照此形态 / 不得开放任意目标路径参数"写进契约注释本身。
  3. **删的是死码，留下的是活通道的断言**：那四条"对话框即授权"不变量原本只钉在没人用的 `exportDirectory` 上，
     活着的 `exportFile` 在内核层**一条行为测试都没有** ⇒ 四条**移植**过去 + 加一条 BOM 字节原样过桥的断言。
  4. **基线**：TS **1648 passed / 13 skipped**（同数，因为是移植不是删测试）；`cargo test --lib` **16 passed**
     （`#[test]` 19→16，减的正是被删命令的复制助手单测），`cargo check --lib --tests` 零 warning；
     双 typecheck / 审计 A–D 全绿。
- **2026-10-13 · 工具批（详见 §5.98）**：`node tools/git-push.mjs` 从"只赌直连"改成**直连/代理交替试**
  （奇数趟清代理直连、偶数趟 `-c http.proxy=<本机代理>`；`KOJO_GIT_PROXY=""` 退回纯直连）。
  起因是 §5.97 那次推送**旧工具 6/6 全灭、手工带代理一次就通**；当场验证 try1 direct 红 → try2 proxy 绿。
  只动 `tools/`，不进包体、不在测试路径；套件仍照 §十二-5 复跑：**1648 passed / 13 skipped**（同数）、审计全绿。
- **2026-10-13 · 看板 HK-4 批（详见 §5.99，UI P4）**：编辑器工具条**身份不许裁**——第一次用 CDP 量测挑活。
  1. **量出来的三条事实**（1280×841，真实语料一个游戏目录 ERB）：`.file-label` 宽 550px 而 **clipX = 419px**
     （CSS 尾部省略恰好把**文件名整个裁光**，作者读到的是游戏目录前缀）；`.editor-status` 68px 宽 **clipX 52px**
     （编码·换行·行数被挤成半句话）；工具条高 **50px**（截图看到「保存 (Ctrl+S)」折成两行）。
  2. **修法是定次序，不是各调一个像素**：路径切三段 `head`（可缩，dim，自带中段省略）/ `tail`（作者包名，不缩）/
     `base`（文件名，不缩、加粗），完整路径恒在 `title`；再加 `.editor-status { flex: 0 0 auto }` 与工具条按钮 `nowrap`。
  3. **一次量测把"看起来对了"打回"结构不对"**：第一版两段（JS 中段省略目录 + 文件名）纯函数测试全绿，
     接上壳子却量到 `.file-dir` **clipX = 57** —— CSS 把承诺保住的最深一层目录又裁掉了。
     字符预算对不上像素也不该对（可分宽度随窗口变）⇒ **要靠结构不靠预算**。修后三段 clipX 全 0，工具条 50px → **34px**。
  4. **基线**：**1658 passed / 13 skipped（1671）**，97 文件（+10 条 `path-label` 纯函数测试，其中一条当场抓到
     `pathLabelParts` 第一版解构了 `splitPath` 根本不返回的 `tail`）；`app build` ✓ 1m28s；双 typecheck / 审计 A–D 全绿。
- **2026-10-13 · 看板 HK-4 批第二轮（详见 §5.100）**：同一把尺子接着量全站——**快速打开（Ctrl+P）副行**中招。
  1. **量到的**：14 行候选各被裁 **337–389px**，被裁的恰好是最深一层目录（`灵梦-少女之梦`）——
     一堆同名 `M_KOJO_K1_2_*.ERB` 之间**唯一的区分点**；1280 / 900 / 1120 三档视口全一样，是结构问题不是宽度问题。
  2. **修的**：`path-label.ts` 抽出 `dirLabelParts`（head 可缩 / tail 恒显），`Palette.tsx` 候选项
     `secondary: string` → **`secondaryDir`** 两段渲染；改完 `secondary` 全仓无人设置 ⇒ **顺手删掉这个死字段**
     （连带去掉中途用过的 `:has()` 写法）。实测三档视口 `secClip = 0`，命令面板回归确认无变化。
  3. **负结果也登记**：欢迎页 / 设置浮层 / 写作模式三档视口**零裁剪**；口上文件树的行裁 6–61px
     **刻意不改**（树内截断是常态 + 有 `title` + 侧栏可拖宽；要"保中段"就得认识 `M_KOJO_K1_2_` 命名模式，
     那是口上知识，不该进宿主 UI）。
  4. **一条驱动坑**（§九-37）：window 级合成 `Escape` 关不掉 picker（它只听自己输入框冒泡的事件），
     差点把"两种 picker 数字一样"当成产品怪象报出去 ⇒ 驱动通道自己失败 ≠ 产品失败。
  5. **基线**：**1661 passed / 13 skipped（1674）**（1658 + 3 条 `dirLabelParts`）；双 typecheck / 审计全绿；`app build` 见 §5.100 表尾。
- **2026-10-13 · 实机复验批第二轮（详见 §5.101，零代码改动）**：**QA-2 糖视图行高收口**。
  1. 这条本来派给别机，但它是**可数的**不是观感 ⇒ CDP 直接量：两种模式 `.view-line` computed `lineHeight` 均 **19px**；
     糖模式 24 个 ViewZone 高度 {285, 57, 380, 0} = **15/3/20×19 与 0**，偏离"行高整数倍"**0px** ⇒ **无累积漂移**，判据② **19px 成立**。
  2. **判据本身要修两处**（否则量到假信号）：糖正文住在 **ViewZone** 里，用"相邻行 top 差恒定"当判据会因 zone 占位报出不存在的缺陷；
     `--sugar-lh` 不在 `:root` 也不在 `.editor-body`，而是宿主落在 **zone 元素自己**上（`EditorPane.tsx:506`）。
  3. 一条观察不报缺陷：有一个 0 高度 zone（不影响对齐、无第二条证据）。一条驱动坑 §九-38：**zen 跨次保留会把侧栏选择器全部打空**。
  4. **基线不变**：只动 `docs/`，推送前复跑 **1661 passed / 13 skipped（1674）** 同数；语料零写入、探针同批删除。
- **2026-10-13 · 看板 HK-4 第三轮（详见 §5.102，纯 CSS）**：全站**可访问性量测**（对比度 / 点击目标 / 可访问名），五状态扫（欢迎页 · 快速打开 · 项目+ERB 糖视图 · 新建向导 · 设置浮层）。
  1. **先修尺子再修界面**：第一版把背景**从父元素起算**，于是"白字压蓝底"整类漏报（算出 12:1 的漂亮数字）；
     改成含元素自身背景后**全站最重要的控件当场红一片**——`保存 (Ctrl+S)` / `打开文件…` / `创建并打开` 白字对 `--accent` **3.32:1**（正文需 4.5），
     主按钮里的快捷键芯片 **1.03:1（等于看不见）**，`.small` 按钮族**全部 23px 高**、`.tab-close` **17×17**。
     ⇒ 口径：**量测器自己不达标时，"没报告"不等于"没问题"**。
  2. **根因是一个色值被要求同时干两件相反的事**：`--accent` 既当填色底（压白字不够）又当文字色（压深底也不够）。
     拆三档：`--accent` 描边/高亮（4.15:1 过 3:1）、**新 `--accent-strong`** 填色底（白字 **4.87:1**）、
     **新 `--accent-text`** 当文字（**5.54:1**）；快捷键芯片改"压暗"（加白半透明是反方向，仍 3.8:1）实测 **7.07:1**；
     选中行副行回正文色（3.48→达标）；`.small` 补 `min-height: 24px`、`.tab-close` 补 24×24。
  3. **修后五状态各自为 0**：对比度不达标 0 条 / 目标 <24×24 共 0 类 / 无可访问名按钮 0 个。
  4. **刻意不做**：其余 13 处 `color: var(--accent)` **一条都没被量红**，不做"看见 token 就全替换"；
     `×` 悬停才现（目标尺寸已补齐，"看不见就可点"这件事要连触屏一起定）；树行中段截断需口上知识，不做（§5.100）。
  5. **基线**：**1661 passed / 13 skipped（1674）** 同数（纯 CSS 无新可测行为）；双 typecheck / 审计全绿；`app build` 见 §5.102。
- **2026-10-13 · 实机复验批第三轮（详见 §5.103，零代码改动）**：**造 fixture 游戏目录**，一次收掉 QA-9 游戏目录半边 + QA-10 余下三家模态。
  1. **配方**（两边可复用）：`detect()` 只认 `ERB/口上・メッセージ関連` + `CSV/Chara` 同时存在 ⇒ `%TEMP%` 下 6KB 假游戏目录
     （真语料**字节级复制** 2 个小 Chara CSV + 自造一个包一个 ERB）；打开方式 = 把路径写进 `store/_global/recent-projects.json`
     再点「最近打开」（绕开 CDP 驱动不了的原生文件夹对话框）。`detect → loadProject → 索引` **429ms**，角色表与口上树都按真实结构解析。
  2. **QA-9 两半完成**：包展开状态下外部写一个 `.ERB` 进游戏目录侧 → **825ms** 上树、外部删 → **824ms** 消失，
     角色组与包的**展开态全程保住**；真实语料 `find -newermt` 仍 **0 命中**。
  3. **QA-10 五家全过**：写权限确认（Esc → 横幅 + 徽章落只读）· ERB 解锁（真实编辑意图弹、Esc 后标签不脏且**盘上逐字节未变**）·
     糖视图须知（清 `localStorage['kojo.ui.sugarView.prompted.v1']` 触发，Esc → 屏上是原文且标记写回 `'1'`）。三家都在本机真键盘语义下完成。
  4. **QA-3 拆成两半**：部署落盘那半用 fixture 可自验；"Emuera 真读出台词"那半仍留别机（fixture 配方已写进那一行，别机不必动自己语料）。
  5. 一条驱动坑 §九-39：**活动栏图标是切换式**，已可见时再点会藏掉整个视图（本组因此整轮空跑过一次）。基线不变：**1661 / 13 skipped** 同数。
- **2026-10-13 · 实机复验批第四轮（详见 §5.104，零代码改动）**：**判据②人工清单 §2.J 本机勾掉四格，并修掉一条过期判据**。
  1. **勾掉**：j1（打开无红色通知，弹的是写权限确认）· **j2**（外部改一个已打开且干净的 ERB → **306ms** 编辑器自己跟上，
     状态栏原文就是清单要的「已从磁盘重新加载（文件在外部被修改）」，标签仍"已保存"）· **j4**（自身保存零回声）·
     **j5**（外部删除 → "唯一副本"通知 + 标签不被自动关，§5.96 证据并入清单）。
  2. **⚠ j6 判据过期**：原文写"新建 `.ERB` → 文件树与函数树不会自动出现"，但 HK-5/HK-6 落地后**文件树会**（§5.103 实测 825ms 上树 / 824ms 消失）。
     已改写为：**文件树自动出现 = 通过**、**函数树与包计数不跟 = 已知边界（HK-1 余量，属性能线）**。
     ⇒ 口径：**判据也会过期**——行为改了得回头改等着验它的那张清单，否则清单从"验收工具"变成"缺陷制造机"，而且**不会有任何测试变红**。
  3. **诚实的半格**：j3 通知上的动作按钮「重新加载（放弃我的修改）」**没验到**——本组试图先解锁只读 ERB 再打字制造脏态，
     点完「仍要直接编辑」后注入的字符没落进缓冲区（标签始终不脏），于是没有可点的动作 ⇒ 不猜它能不能用，留给真人键盘。
     j7（要改源码塞不存在的监视根，与 §九-34 冲突，需单独一批停壳来做）· j8/j9（零存档 + 无拔盘条件）同留别机。
  4. **机器状态**：fixture 与临时脚本删除、`recent-projects.json` 备份后原样还原；真实语料 `find -newermt` 仍 **0 命中**。基线不变：**1661 / 13 skipped（1674）**。
- **2026-10-13 · P4 补测批（详见 §5.105，实机线 / 本组主机）**：判据⑥ 的欠账按"补测试"而不是"重做 P4"来还。
  1. **三个纯模块**：`panel-drop.ts`（拖拽落点四事件状态机）、`shell-keys.ts`（**Esc 链顺序 + 输入法合成期门**单源）；
     reducer 的抽纯**撤回**——上游「设置页归一批」已把它搬进 `layout.ts`，只补 `layout-actions.test.ts` 测那张表（§5.105 §七-6）。
  2. **+68 项**（`shell-keys` 22 / `panel-drop` 19 / `layout-actions` 14 / `layout.test.ts` +13），
     含 3 项**静态红线守门**：读 `layout.ts` 源码文本断言不含 `@kojo/kernel`、不含 `ctx.storage`、含 `kojo.ui.layout.v1`。
  3. **实机缺陷修复**：中文输入法合成期按 Esc 会关掉设置页 / 退出全禅。根因 = 全局快捷键只认 `e.key === 'Escape'`，
     全仓零合成判据。修 = 三条判据叠用（`isComposing` / `keyCode 229` / `compositionstart` 会话标志）+ **失焦清标志**
     （否则"合成期不消费"退化成"永久不消费"，比原缺陷更坏）。真实壳同口径 19 项：改后全绿 / 改前 5 红。
  4. ⚠ **本批撞过两次号**（§5.71 → §5.92 → §5.105）：推送通道不通期间远端落了 20 个提交。
     **Esc 链在上游 HK-2 之后是 5 层**（picker > **modal** > overlay > settings > zen），改顺序只改 `ESC_PRIORITY`。
- **2026-10-13 · UI 反馈第一批（详见 §5.106，用户夜间 7 条反馈 + 认领全项目实机测试）**：
  1. **三条与用户描述不一致，都按实测办**：反馈 3 的按钮实名「恢复只读」；反馈 5 的"展开失效"其实是**该控件从未存在**
     （骨架段还"只藏不显"＝静默删码）；反馈 6 在 `FileTree` 侧真因是**展开不可逆且零反馈**，而"新建文件夹"在上游 §5.67
     已存在于**口上项目面板** ⇒ 那半边须在新基线重测（见 §5.107）。
  2. **落地**：只读改用底栏同款黄胶囊（去掉 🔒 与冗长括注）；「✏ 已解锁编辑」徽章自身变成回锁入口（删掉多余按钮）；
     糖视图每段补**折叠柄**（ADR-0006「收起 ≠ 删除」宿主侧），摘要变成「语法糖 N 行｜已收起 M 行（可展开）」；
     文件树「展开全部 / 折叠全部」+ 根节点右键项统一成**可逆开关**并产出一句可读数。
  3. **+25 项**（`sugar-fold` 14 / `file-tree-reveal` 11）；两批合落地后全仓 **1754 passed / 13 skipped（1767）**、102 文件过 / 7 跳。
  4. **未做**：反馈 4（糖视图改成编辑器本体渲染）方案 + **三个待用户拍板的问题**写在 `docs/UI-FEEDBACK-2026-10-13.md` §二；
     反馈 7（`.ERB` 结构错误波浪线）规格已定在同一件 §四，**下一批实现**（要新增 additive 契约方法）。
- **2026-10-13 · 实机复验轮（详见 §5.107，qa 主机）**：把上一批的读数在新基线上重跑，并把**反馈 6 的真凶**找出来。
  1. **四条探针 68 项全绿**（同口径重跑，不引用旧树的数）：合成期 Esc + 拖拽 20 / UI 反馈 1·3·5·6 共 22 /
     合成期 Esc × 宿主模态 11（本轮新写，= 人工清单 5.D-D9 的自动半边）/ 口上项目面板新建文件夹 15（本轮新写，含磁盘侧独立核对）。
  2. **反馈 6 改判对象**：用户说的"根节点"是**口上项目面板**（上游 §5.67 在那儿做了四种新建条目），
     上一批"全仓没有新建文件夹入口"只在旧基线成立。真实壳里复现出**两条渲染空洞**：
     ① 项目行的菜单把草稿指向 `projectDir`，而 `draftRow` 只在 `renderDir` 里产出、`renderDir` 只跑包目录
     ⇒ 点「新建文件夹」只是往 state 写了个 draft，**界面一个像素都不变**；
     ② 修好槽位后目录真建到盘上了，但项目行只渲染 `workspace.json` 登记的包 ⇒ **盘上有、面上无，仍读作"没生效"**。
     只修 ① 等于修了一半。
  3. **修**：`looseProjectDirs`（纯函数，+7 项单测钉"挑法"）+ `renderEntry` 抽成共用渲染源 +
     项目行下面补 `draftRow` 槽位与「包之外的目录 N 个」那一块；**接线交给真实壳那 16 项**（node 环境测不了组件）。
  4. **两条仪器教训**（首轮 5 项红全是自己的）：**标签恒为「语法糖视图」之后，开关判据必须改读 `aria-pressed`**；
     探针自己写的偏好会毒死下一轮（`sugarView.prompted` 落进 localStorage 后"须知"再也不弹）⇒ **先存档、结束恢复原样**。
     全仓基线：**1761 passed / 13 skipped（1774）**。
- **2026-10-13 · ERB 结构波浪线批（详见 §5.109，qa 主机）**：用户反馈 7（"编辑 ERB 没有任何语法错误提示，不可接受"）落地。
  1. **只报三类可证明的结构错误**（孤儿闭合 / 走到函数边界或文件尾仍未闭合 / 无主分支），配对表**单源于 `erb-parser/scanner.ts`**：
     新增 `forEachControlFlowLine` + `controlFlowToken` + `closerNameForPair`（从 `CLOSE_KINDS` 反查），`scanControlFlow` 改成消费同一道门、行为逐字不变。
  2. **交付面宿主零改动**：`ErbParserService.checkStructure?` 是 **additive 可选**契约方法；波浪线走既有 `ui.editor.decorator`，
     去抖仍是 `MARKER_DEBOUNCE_MS = 250`。装饰器由解析器插件自己注册（契约是纯函数，放这里不新增跨插件依赖，也不把"哪些行算语句"外化成第二份知识）。
  3. ⚠ **真实语料把第一版判据打脸**：把 `@` 开头的行当函数边界 ⇒ 语料里大量跨行 `CALL` 的续行以 `@"…"` 开头，
     5 个文件误报 23 条（一次误报**连环两条**：未闭合 + 孤儿闭合）。改成"函数名首字符必须是字母/下划线"后
     **3,818 文件 / 4,115,009 行零报告**，并由语料闸门把"零报告 + 反证（删一条 ENDIF 必须报）+ 封顶"钉成回归。
  4. **性能实测**：最大单文件 52,602 行 ⇒ 体检 23.4ms / 28.5ms（两次独立读数），与既有骨架扫描同量级；不做"大文件不降级"的第二种真相。
  5. 真实壳 9 项全绿：波浪线落在开块那一行、悬停原文 `IF（第 3 行）到这里还没有闭合，缺 ENDIF。`、磁盘补回 ENDIF 后消失、现场敲 `IF A` 立刻出现。
     全仓基线：**1790 passed / 14 skipped（1804）**。
- **2026-10-13 · ERB 💡 一键补齐批（详见 §5.112，qa 主机）**：波浪线只说"少一个 ENDIF"，而**补在哪一行**对新手更难——
  补在 `IF` 紧后面与补在函数末尾都编译得过，语义完全不同。本批把那一步代掉。
  1. `ErbStructureIssue` 加 **additive** 两字段 `closer` / `fixBeforeLine`，**只给 `unclosed-open`**：
     多写的闭合词也可能是"我们把函数边界漏判了"（漏判是刻意留的安全方向），拿不确定的推断去删作者写好的行**不做**。
  2. 落地走既有 `ui.editor.codeAction` + 既有 `EditorTextEdit`（宿主 `executeEdits`，一个撤销步），**宿主零改动、不碰磁盘**；
     门槛两条都朝保守收：只对 `io.isWritable(path)` 为真的路径供（不挡就会造出"只读文件被改脏、保存键又是灰的"），
     且只在光标落在波浪线那一行时给（位置未知不猜，否则几十条动作灌进同一个菜单）。闭合词跟着**开块那一行**的缩进走。
  3. 测试钉"补完要对"不钉"生成了 edits"：14 项全部跑**闭环**（补完立刻复检必须零报告）+ 11 个配对类逐条验闭合词出口；
     语料闸门加真实代码闭环半边（最大真文件删一条 ENDIF → 补回 → 复检零，行数与 ENDIF 计数回到删之前）。
     全仓基线：**1815 passed / 14 skipped（1829）**、104 文件过 / 8 跳；build ✓ 38.71s。
- **2026-10-13 · 实机复验第六轮（详见 §5.113，qa 主机，零代码改动）**：清单 §六 **7.D 整组（7.17–7.22）50 项全绿**，
  正好补上上游 §5.111 点名的缺口（7.18–7.19 / 7.21–7.22）。轴一那条（7.21 ★★）第一次拿到完整实机证据：
  工作区 `.ERB` 无只读胶囊、不弹模态、不投影、直接打字即改、波浪线照样在线。
  ⚠ 两条口径事实：① 7.20 的"关掉编辑器后恢复只读"实测机制 = **关最后一个标签 ⇒ EditorPane 卸载 ⇒ 会话内解锁集合消失**
     （第一轮探针把它量反了，真因是自己的选择器写了不存在的 `.tab`，标签根本没关掉）；
  ② 屏外的 ViewZone 会被 Monaco 收走（5 段里只有 1 段有高度，281 行那段高 0）⇒ "尾部不裁"的判据**只对可见段成立**，
     且必须另外断言"至少一段 >19 行被量到"，否则零裁切只是因为什么都没量到。格子按 §5.111 口径**仍留** `[ ]`。
- **2026-10-13 · 实机复验第七轮（详见 §5.115，qa 主机，零代码改动）**：接着收清单 §六 的可驱动项——
  **7.15 / 7.16 / 7.23 / 7.28 ★★ / 7.29 ★ 五项拿到屏上原样证据**（7.28 第一次在壳上验出那条时序：转译发生在弹框之前，
  失败态常驻 `.kp-status.err`、没有成功态；7.29 的「产物名冲突（大小写不敏感）」原文已录）。
  ⚠ **7.13 / 7.14 的"屏上标注"半边没收**，如实留着：两轮探针都没能稳定进入包的真实文件夹视图（`.pkg-real`），
  第二次点击后它才出现 ⇒ 按 §九-35 当**仪器失败**登记，不报产品缺陷；判据本体由 `file-tree.test.ts` 的
  `visibleEntries` 钉着（"子目录被渲染成空目录 = 谎报文件系统"那条形状就来自这份语料）。下一轮的三条路写在 §5.115 §五。
  另有一条**反向价值**的读数：造"必然转译失败"夹具时试了五个候选，只有"糖正文不在「时机」块内"真报错，
  未知时机分野 / 未知名 / 正常体**全部 0 error 宽容通过** ⇒ "写个不认识的名字就会报错"是错的直觉（一次性 vitest 跑完即删）。
  合流后基线复跑 **1826 passed / 14 skipped（1840）**，与上游 §5.114 自记数逐字相同。
- **2026-10-13 · 实机复验第八轮（详见 §5.116，qa 主机，零代码改动）**：§5.115 登记"没收"的 **7.13 / 7.14 补收到屏上证据**
  （`…/夢美/M_KOJO_K9_日常系コマンド_ボツ.7z` 的 title 原文含「压缩包/资源，不在编辑器内打开」；
  `…/灵梦-少女之梦/灵梦—《少女之梦》eradme.txt` 含「附加文件，不在口上索引内」；子目录 `没写的` 展开后 10 条 ERB、无「（空目录）」）。
  ⚠ 根因一半在**我自己的判据**上：7.14 那条"收起后文件行应为 0"是错的——`FileTree.tsx:513` 写明是
  "追加式、ERB 平铺列表原地不动"，收起时只该消失 `.pkg-real` 那批行（31 → 20 → 31 才是对的）。§九-50 已按实测改写，
  另一半根因是**旧节点引用**（不是 §5.115 猜的"树筛选框残留"，本轮实测筛选框为空、渲染条件一直满足）。
  这一轮净成本三次壳跑，换来的是"最容易假绿的那两条判据"有了真读数。
- **2026-10-13 · 看板 HK-4 批 · UI 系统化第一轮（详见 §5.121，本机）**：用户重指派重心为**打磨 UI**
  （目标「专业 · 克制 · 流畅 · 高效 · 耐看」，以 VSCode 为基准，定夺时优先用现代编辑器现成方案）。
  本组自拟**六项**任务清单并按序推进：字号尺度 → 圆角/边框/阴影 → 图标系统 → 焦点与键盘可达 → 动效可关 → 底部问题面板。
  1. **第一项做完了**：CDP harness 量出全站**渲染出 10 档字号、其中 4 档是半像素**
     （12.5px 摊到 193 个元素；10.5px 是 `.rp-*`/`.ab-*`/`.inj-*` 三个插件面板自造的一档）——
     半像素不是精细，是**各子系统各自微调、没人统一**的沉积物，CJK 落在子像素网格上行与行轻重不一。
     现定 6 档整数尺度（按角色命名：元信息 11 / 密集控件 12 / 正文 UI 13 / 强调 14 / 大 16 / 模态标题 18 / display 26），
     **CSS 里 `font-size` 字面量清零**，改字号只剩 token 一个入口。
  2. **同批收掉量出来的另外三条**：`button.link`（欢迎页最近打开的路径）4.41:1 与 `.toolbar-btn.on`（布局切换图标）3.74:1
     都改走文字档 `--accent-text`（5.54:1）；包行「导出 / 部署」39×**22** 补 `min-height: 24px`。
     **十个状态的对比度不达标条目从每状态 1 条降到 0**，裁剪未恶化、无新增溢出，截图复核通过。
  3. **harness 从此是回归门禁**：字号档数 / 对比度 / 裁剪 / 目标尺寸四个数字，后续每一批 UI 改动都复跑。
  4. **基线提醒**：本批 rebase 到 master（含别组 HK-9 的 +6 项）后复跑 = **1832 passed / 14 skipped（1846）**，104 文件 / 8 跳；
     本组 §5.104 自记的 1661 已被别组新增测试覆盖掉，**对基线请按 1832 起算**。
- **2026-10-13 · 看板 HK-4 批 · UI 系统化第二轮（详见 §5.122，本机）**：六项里的**第二项**——圆角与阴影 token 归一。
  1. **静态**：`border-radius` 有 **12 种字面量**（1/3/4/5/6/8/12/14px + 999 + 50%），token 只 2 档、73 处声明里仅 10 处用它。
     **屏上**（harness 新加第 5/6 项指标 `distinctRadii`/`distinctShadows`）：十状态渲染出 **6 档圆角**（`8px`/`14px` 是异类）、**4 档阴影**。
  2. **收成**：圆角 5 档（xs 2 / sm 4 / md 6 / lg 10 / pill 999，语义值 `50%`、`0` 不进尺度）；
     阴影 3 档抬升（shadow-1 菜单 toast / shadow-2 picker overlay / shadow-3 模态欢迎卡），inset 指示条**不并入**。
     结果：**圆角 6→5、阴影 4→3、CSS 字面量清零**；字号/对比度/裁剪/目标尺寸**不动**（本批零 font 声明）。
  3. **顺手修好 harness 一个假绿陷阱**：harness 从"app 当前状态"起步，两次 run 状态集对不齐（差 45 个 13px 元素），
     根因是**不是从同一处起步**。修法 = 起步先 `location.reload()` 回欢迎页；修完连跑两次**逐状态分毫不差**。
     上面那张前后表就是确定性量出来的。**别再用未重载起步的 run 之间比聚合数**（§九 已登记）。
  4. 六项剩 **UI-3 图标（emoji → 单色 SVG）/ UI-4 焦点环与键盘可达 / UI-5 动效可关 / UI-6 底部问题面板**。
- **2026-10-13 · 语法糖批 P 完成**（权威记录 `docs/IMPLEMENTATION-LOG.md` **§5.127**；规范 **v1.3 → v1.4**）：
  用户一句"本项目有没有用于实现空行的语法糖"查出的缺口——**读的时候有、写的时候没有**：
  §3.10 定死源文件空白行不进产物，而投影层（批 F）早就把作者的裸指令空体翻成空行并**记了一笔代价**
  （`W`/`L` 不可分辨）；语料里这个形态约 **20 万行**。用户拍板"按建议加入清单并首先实现"。
  1. **三条判据**：① 整行恰为 `空行` / `blank` 才算语句（`「空行」`、`空行是什么。` 照原样打印；
     `空行 不等待` 一类自造说法不认，退回旁白）；② 产物走旁白系 `PRINTFORMDW` / `PRINTFORMDL`，
     **空体不留尾随空格**；③ **不新增 AST 节点**——它就是一条文本为空的文本行，
     于是转译/预览/校验/高亮/补齐五处消费方零改动（本批最值得复用的判断）。
  2. **显示口径补掉那笔代价**：`L` 系空行投影为 `续`、`W` 系保持纯空行，两种节奏终于可分辨。
  3. **教学样例同步**：`teaching-full.kojo` 加 `空行` 示范 + 三行讲解，golden 用 `TEACHING_GOLDEN_WRITE=1`
     再生并人工看过 diff（只多 4 行），结构冒烟加断言 `'\n\tPRINTFORMW\n'`。
  4. **我自己的错被测试抓住**：第一版断言写的是 `空行 不等待` → `PRINTFORMDW 不等待`，
     实际产物 `PRINTFORMDW 空行 不等待`（整句照打才是对的）——**改了断言，没改实现**。
  5. **基线更新：1843 passed / 14 skipped（1857）**（合流 §5.123–§5.126 线后实测 = 上游 1837/14（1851）+ 本批 +6）；typecheck root + app 双 exit 0；审计 A–D 全绿；
     语料七把尺子读数不动（本批不动覆盖率，动的是写侧能力与文本内容）：
     台词 99.2｜输出 99.2｜SIF 93.3｜函数头 81.2｜状态赋值 54.8｜演出 98.0｜数据表条目 57.4%，
     行覆盖 61.4%｜段 285,546｜不变量违例 0。
  6. **未做**：写回口径（`liftSuggest`）不产 `空行` 候选；刻意**不做**"既不换行也不等待的空行"
     （无后缀 `PRINT`/`PRINTFORM` 空体仍不投影）。其余边界见 §5.127「边界未做」。
  7. **收口被中断过（2026-10-13）**：本批收口提交 rebase 到上游 HK-4 第二轮时停在
     `IMPLEMENTATION-LOG` 冲突上（两条线同取 §5.122、两节在文件尾部整体对撞）；接手会话按
     "远端全文为底 + 本地节改号"收口。首次推送被拒、fetch 复核发现远端已连号落地
     §5.123–§5.126 ⇒ 第三次让位到 **§5.127** 后全部落地，并复跑验收（读数见 §5.127）。

- **2026-10-13 · 目视体检批（详见 §5.123，qa 主机，+5 项）**：这轮换挑活方式——**先把壳逐态截图自己看**，
  再对可疑处量 DOM，量出三处真实缺陷，其中两条是"判据空转"才活到今天的：
  ① **长糖段尾部被裁**：`--sugar-lh` 首帧量不到就退回 1.6 兜底（20px vs 编辑器 19px），43 行的段溢出 11px、
     281 行的段约 **13 行台词看不见**；修法 = 变量落到 wrap + 分帧填充时**重问一次行高再补写**（自愈）。
  ② **糖块开头一大块空白**（段首空行，实测 leadingBlank=2）⇒ 纯函数只剪首尾、段内分节不动。
  ③ **只读胶囊 1180 档被压成 36×38 竖排圆牌**（§5.99 只给 `button` 立过规矩，胶囊是 `<span>`）⇒ 把**让位次序**
     写成显式规则：状态与身份不许缩，先让摘要（悬停有全文）、再让编码信息（状态栏另有一份）。
  ⚠ 教训进化：`scrollHeight - clientHeight` 比**同一个元素**恒为 0 —— 这条判据是空的（§九-53）。
  真实壳 6 项全绿（含"内容高 − 盒子高 = −32px"），单测 +5；合流上游 §5.121 字号尺度后复跑 **1837/14（1851）**。
- **2026-10-13 · UI 打磨批 · 状态栏诊断计数收声（详见 §5.124，qa 主机）**：状态栏那簇 `✕ 0 ⚠ 647 ℹ 147`
  此前全量铺严重度色（琥珀/蓝），视觉重量压过同排的「可写」胶囊，而它是**项目级常态计数**。
  改成整簇 dim + `tabular-nums`，**只有 error > 0 才给红**（约定校验的 error 是真事故，常态为 0）；
  严重度语义仍在底部「约定校验」面板逐条呈现，信息一条没删。
  实测：三项 computed color 同 `rgb(139,148,158)`；`tools/ui-measure.mjs` 六个数字**全不回退**
  （字号 6 档 / 圆角 5 档 / 阴影 3 档 / 对比度 0 条 / 裁剪 0（1 条既存省略号）/ 小目标 1（既存表单控件））。
  ⚠ `error > 0` 的分支**没在实机触发过**（语料 error 恒 0），代码路径一处判断，已记为欠账。
- **2026-10-13 · 实机复验第十轮 · 清单 §5.E 机器半边（详见 §5.125，qa 主机，零代码改动）**：
  **E1 / E2 / E3 / E5 / E6 / E7 全收**（19 项断言全绿）：
  波浪线落点与悬停原文逐条对上（含 💡「Quick Fix」只出现在"补得出来"的未闭合那条上）；
  有红线照样能改能存（`Ctrl+S` 后盘上真多一个字符、波浪线仍在）；
  52k 行 / 2.2MB 文件上按键回声 **46/44/46ms**、新敲的 `IF` **342ms** 出红线（去抖 250ms + 体检 30ms）；
  含 `@"` 续行的真语料字节副本**零波浪线**。**E4（"自己天天改的那份该一条红线都没有"）留真人**——
  语料闸门只能证明"3,818 份真实文件零报告"，证明不了"你那一条改了三个月的口上也没事"。
- **2026-10-13 · 实机复验第十一轮 · 清单 7.30–7.33 部署半边（详见 §5.126，qa 主机，零代码改动）**：
  fixture 假游戏目录（**CSV 整份复制**）里把"会碰游戏目录"的四格跑完，**15 项全绿**：
  7.30 落点在确认前就显示 + 无口上目录的角色当场说明且按钮禁用（下拉逐项标「无口上目录」）；
  7.31 未批准写权限是**前置闸门**（写明"请先批准" + 按钮禁用 + fixture 零字节）；
  7.32 目标已存在 ⇒「部署不会覆盖」+ 禁用 + 既有内容逐字未变；
  7.33 成功落盘 10 个 `.ERB`（无 `.kojo`）+ 工作区哈希一字未变。
  ⚠ 两条机制事实记在那节：**写权限批准按项目目录记忆**（复用 fixture 路径会让 7.31 测不到 ⇒ 目录名每次唯一起）、
  **fixture 光有 `CSV/Chara` 不够**（糖编译要变量字典，缺了报"变量字典未收录或未加载" ⇒ CSV 要整份复制）。

## 三、文档索引（按权威性排序；2026-10-11 整理批后口径）

### 活文档（`docs/` 根，11 份 + adr/）

| 文档 | 内容 |
|---|---|
| `docs/HANDOFF.md`（本文件） | **交接状态 + 下一批动手清单（新会话从这里开始）** |
| `docs/IMPLEMENTATION-LOG.md` | **批次实施记录权威**：每批实施细节 / 金样本发现 / 踩坑 / 审阅回执（当前至 **§5.130**：§5.49 = 口上项目批 P-A…P-E · §5.50 = 口上项目批 T2 · §5.51 = 内核优化批 · §5.52 = 计算池批 · §5.53 = 本批自审与验收记录 · §5.54 = UI 重设计 P4 补记 · §5.55 = 分支收口批 · §5.56 = 口上项目批 T3 · §5.57 = 口上项目批 T4 · §5.58 = 体感丝滑批 · §5.59 = 语法糖视图批 · §5.60 = 语法糖批 A/C/D/E · §5.61 = 语法糖教学样例批 · §5.62 = 语法糖批 F/G · §5.63 = 语法糖批 H · §5.64 = 两线合流批 · §5.65 = 快照卫生批 · §5.66 = 语法糖批 I · §5.67 = 语法糖批 J · §5.68 = 语法糖批 K · §5.69 = 语法糖批 L · §5.70 = 抽取按文件增量批 · §5.71 = 语法糖批 M · §5.72 = 校验按文件增量批 · §5.73 = 名称解析 memo 批 · §5.74 = 回放线重测批 · §5.75 = 语法糖度量批 · §5.76 = UI 归一批 · §5.77 = 导出批 · §5.78 = 工作区新建条目批 · §5.79 = 许可协议可选批 · §5.80 = 三线合流批 · §5.81 = 规则成本归位批 · §5.82 = 判据①发版样例批 · §5.83 = 设置页归一批 · §5.84 = BUG-5 文件监视批（判据②） · §5.85 = 撞名诊断批（任务 20 收口） · §5.86 = 判据②补证批 · §5.87 = 监视消费方批（上） · §5.88 = 落盘引导批（反馈 3） · §5.89 = 抽取快照 v4 批（负结果只在探针通道成立） · §5.90 = 实机复测批（真实 app 三段水位是探针的 2–3 个量级，头号靶子改成 IPC 读盘通道） · §5.91 = 看板 HK-5 批（文件树目录缓存的失效通道 + 工作区根进监视） · §5.92 = IPC 读盘通道批（真实 app 热开 10.5s→3.2s；下一靶子 = 批量 stat） · §5.93 = 看板 HK-6 批（面板消费工作区外部改动 + `FileChangedEvent.path` 契约更正） · §5.94 = 看板 HK-7 批（外部改动重载改按 pathKey 判等） · **§5.95 = 看板 HK-2 批（全站宿主模态接上 Esc）** · **§5.96 = 实机复验批（CDP DOM 驱动收掉 QA-1②/QA-9/QA-10，零代码改动）** · **§5.97 = 看板 HK-3 批（`exportDirectory` 契约收缩，绕闸通道收回一条）** · **§5.98 = 工具批（推送通道直连/代理交替试）** · **§5.99 = 看板 HK-4 批（编辑器工具条身份不许裁，CDP 量测挑活）** · **§5.100 = 看板 HK-4 第二轮（快速打开副行 + 全站裁剪扫描）** · **§5.101 = 实机复验批（QA-2 糖视图行高收口）** · **§5.102 = 看板 HK-4 第三轮（全站可访问性量测）** · **§5.103 = 实机复验批第三轮（fixture 游戏目录收 QA-9/QA-10）** · **§5.104 = 实机复验批第四轮（§2.J 清单：勾四格 + 修一条过期判据）** · **§5.105 = P4 补测批（壳层判据抽纯 + 合成期 Esc 门）** · **§5.106 = UI 反馈第一批（只读胶囊 / 折叠柄 / 展开反馈）** · **§5.107 = 实机复验轮（反馈 6 真凶＝项目根没有行内框槽位；四条探针 68 项全绿）** · **§5.108 = 探针选择器归一批（判据③ 自动化半边，工具与文档，零新测试）** · **§5.109 = ERB 结构波浪线批（反馈 7 落地；语料把第一版判据打脸过一次）** · **§5.110 = 合流后 IO 通道摸底批（本机，零产品代码）** · **§5.111 = 实机复验第五轮（清单 §六 7.1–7.7）** · **§5.112 = ERB 💡 一键补齐批（反馈 7 第二步）** · **§5.113 = 实机复验第六轮（清单 §六 7.D，50 项全绿）** · **§5.114 = 批 N 数据表投影（糖线，第七把尺子）** · **§5.115 = 实机复验第七轮（§六 7.15/7.16/7.23/7.28/7.29 收到证据；7.13/7.14 当时没收）** · **§5.116 = 实机复验第八轮（7.13/7.14 补收 + 判据本身被修正）** · **§5.117 = 实机复验第九轮（HK-10：💡 补齐的真实点击链）** · **§5.118 = 向导角色文案批（HK-9）** · **§5.119 = 仪器修正批（桌面壳冒烟三处假红）** · **§5.120 = 演出配色探针批（SETCOLOR 投影被量否）** · **§5.121 = 看板 HK-4 · UI 系统化第一轮（字号尺度归一）** · **§5.122 = 看板 HK-4 · UI 系统化第二轮（圆角与阴影 token 归一）** · **§5.123 = 目视体检批（糖视图行高自愈 / 段首空行 / 工具条让位次序）** · **§5.124 = UI 打磨批 · 状态栏诊断计数收声（严重度色只留给 error；harness 六数字不回退）** · **§5.125 = 实机复验第十轮（清单 §5.E 机器半边 E1/E2/E3/E5/E6/E7 全收）** · **§5.126 = 实机复验第十一轮（清单 7.30–7.33 部署半边，fixture 假游戏目录 15 项全绿）** · **§5.127 = 语法糖批 P（`空行` 写法，规范 v1.4）** · **§5.128 = 索引 stat 折叠批（`stat` 2,038ms→0；热开三段 2.66/3.43/3.45s → 0.63/1.57/1.60s）** · **§5.129 = 看板 HK-8 裁决批（常驻通知溢出先丢 info）** · **§5.130 = 抽取段分段剖面批（冷开读盘 45.1s 墙钟累加 ÷ 并发 8；扫描 2,285 次全走 worker；主线程抽取循环只 1.0s ⇒ #21 结案）**） |
| `docs/ARCHITECTURE.md` | **架构权威**：铁律、内核边界、GameProject 形状（§5）；实施记录已迁出（§5.8+ 留指针） |
| `docs/BASELINES.md` | 实测基线汇总（索引/回放/抽取/校验性能与正确性数字） |
| `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` | **糖表层规范 v1.4**（v1.2 冻结版 + §3.8 一处增量〔v1.3，2026-10-12〕+ §3.3 `空行` 一处增量〔v1.4，2026-10-13〕，均由用户拍板）：语法/转译/产物逐条定义，golden 逐字节锚定（golden 断言按**标题+围栏**锚定，不再按行号） |
| `docs/UI-REDESIGN-2026-10-11.md` | **UI/UX 重设计定稿 v1.0**（用户拍板 Q1–Q11；五区布局/additive 槽位/迁移表/P0–P4；= beta.1 判据⑥；**P0–P4 已全部入库**（P4 = `d871878`），余真实终端勾验） |
| `docs/KOJO_PROJECT_AND_KOJO_TREE_DISCUSSION_MINUTES.md` | **口上项目 / 口上树 讨论纪要（定调权威）**：对偶+引用模型、三条硬约束、五个决策问题、§5 全量清单（口上项目线的 backlog 源头） |
| `docs/LIFT-REPOSITION-2026-10-12.md` | 升糖重定位决策（升糖降为预览、ERB 默认只读的由来；与 ADR-0005 同源） |
| `docs/USER-GUIDE.md` | 终端用户指南（安装 / 开项目 / .kojo 保存编译 / 注入器安全） |
| `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md` | 发版手工验收清单（实机勾验用，发版判据组成部分） |
| `docs/RESEARCH.md` | 技术调研 |
| `docs/PERF-REVIEW-2026-10-11.md` | **性能 / 内核优化路线权威**（L0–L4 + 执行序 + 验收门槛；§七 = L0 实测记录）——2026-10-12 从归档取回为活文档 |
| `docs/PERF-ANALYSIS-2026-10-11.md` | 性能分析（卡顿链路梳理 + 分级建议；同批取回） |
| `docs/adr/0001-0006` | 工具链 / game.adapter 服务键语义 / 壳架构 / 快照来源服务键命名（snapshot.source）/ **ERB 写权限与糖视图口径（0005，跨组共同依据）** / **糖视图代码折叠口径（0006，已拍板但前提被实测否证 → 搁置）** |

### 归档区（`docs/archive/`，历史冻结，只读）

| 入口 | 内容 |
|---|---|
| `docs/archive/README.md` | **⚠️ 全部已过时标注 + 14 份历史报告逐份状态索引**（审阅 / 缺陷报告 / 接力 prompt / 已实现设计稿） |

### 仓库外权威

> **本机已无 `<本机目录>\reverse-engineering\` 目录**（新环境主机只有 `C:` 盘）。逆向文档改为线上托管，
> 直链规则 `https://moments-blog-kl3wezk9yhf.qoder.zone/essays/<文件名>.md`（文件名含中文，需 percent-encode；
> 索引页 `/essays/index.html` —— **无 index.html 会 404**）。2026-10-12 实测可取。

| 文档（`eratw4.980-` 前缀） | 内容 |
|---|---|
| `口上机制深挖.md` | **口上领域知识权威**（27 CASE 路由、MESSAGECHECK 位协议、家族命名、四件套） |
| `存档实战解析.md` / `存档二进制层.md` | sav 协议（v1.0 前必读）/ 字节层 |
| `变量系统与求值.md` / `词法与表达式.md` / `内置方法速查表.md` | state-replay 寻址与 builtins、condition-extractor Pratt 优先级依据 |
| `Statements补全.md` / `Lang与Statements边角.md` / `主循环收官.md` | 语句与控制流（erb-parser `scanControlFlow` 配对表依据） |
| `Counter与KOJO系统分析.md` / `引擎源码分析.md` / `整体架构与原理总览.md` / `机制分析.md` / `成长与日常系统分析.md` / `CliDebug动态验证.md` | 引擎总体与游戏系统 |

> 本项目有条反复应验的铁律（§九-1 / -11 / -15）：**定语义前必须回引擎源码或上述文档核验，不许凭直觉猜**。

## 四、代码地图（v0.2 第三批增补）

```
packages/
├── plugin-api/src/
│   ├── conventions.ts         # 约定校验器契约（规则/问题/上下文/报告/服务）
│   ├── conditions.ts          # 条件谓词契约（ConditionExpr AST / StateDependency / ConditionIndex / 服务 + FunctionPredicate(s) 明细 + ★第七批：FunctionAssignment.name 扩 ARG/ARGS、FunctionPredicates +endLine/+returns、FunctionReturn）
│   ├── snapshot.ts            # 存档快照源契约（ArchiveMeta/SnapshotArchive/变量模型/扫描/服务）
│   ├── replay.ts              # 状态回放契约（ReplayStateView / ReplayValue·ReplayOutcome / ReplayUnknown / FunctionReplay / StateReplayService）
│   ├── services.ts            # +WellKnownServices.ConditionExtractor / SnapshotSource='snapshot.source' / StateReplay='state.replay'
│   ├── events.ts              # +KernelEventMap['editor.revealLocation']
│   ├── erb.ts                 # ErbParserService +currentIndex()/ensureIndex()/scanControlFlow()；+ControlFlowStatement
│   └── game.ts                # VariableSchema/VariableInfo（+resolvedIndex：具名索引→编号）
├── kernel/src/bus.ts          # +KERNEL_EVENT_NAMES: 'editor.revealLocation'
├── plugins/
│   ├── erb-parser/src/
│   │   ├── scanner.ts         # +scanControlFlow（控制流骨架：配对/深度/条件原文/宽容）
│   │   └── plugin.ts          # 服务暴露 scanControlFlow
│   ├── eratw-adapter/src/
│   │   ├── variable-schema.ts # 变量字典（CSV 驱动；33 张名称表；编号↔名称双向 + resolvedIndex 填充）
│   │   ├── conventions.ts     # eraTW 4 条规则（KX/四件套/FORM/MESSAGECHECK）
│   │   └── constants.ts       # +csvDir
│   ├── convention-linter/src/ # 引擎（engine.ts + rules/duplicate-function.ts）
│   ├── condition-extractor/src/ # 条件抽取（expr/extract/engine/index；functionPredicates 明细 API + 双缓存 + assignments 本地量赋值收集 + 分支上下文 + ★第七批：ARG/ARGS 赋值 + collectReturns）
│   ├── sav-parser/src/        # 存档快照源（v0.2 第四批）
│   │   ├── binary.ts          #   ByteReader：7-bit 字节数前缀 / 整数编码 / 越界即抛
│   │   ├── arrays.ts          #   六种数组游程解码（0xF0/F1/F2/E0/E1/D8；cells 省略/截断）
│   │   ├── parse.ts           #   文件级解析（魔数/版本/顶层/角色块/变量流/EM 区）
│   │   ├── gunzip.ts          #   DecompressionStream gzip（Web 标准，不 import node:zlib）
│   │   ├── engine.ts          #   扫描编排（浅解析列档 / 并发 4 / 代际保护 / 订阅）
│   │   └── index.ts           #   装配（requires: kernel.io/kernel.project）
│   ├── state-replay/src/      # 状态回放引擎（v0.2 第五~七批）
│   │   ├── var-model.ts       #   引擎级变量清单（角色 22+4+CSTR+CDFLAG / 全局 / 伪变量 / 局部量）
│   │   ├── state-view.ts      #   归约（按 NO 定位角色块 / TARGET 补位 / 稀疏取值 / 越界与截断显式）
│   │   ├── evaluate.ts        #   三值求值器（Kleene / 整数除法截断 / BigInt 位运算 / 字符串 == / ★第七批：EvalContext{read, resolveCall}）
│   │   ├── builtins.ts        #   内置纯函数（GETBIT/GROUPMATCH/MAX/MIN/ABS/SIGN/LIMIT/POWER + ★isBuiltinName）
│   │   ├── locals.ts          #   函数级叠加层（本地量数据流前缀可达 + 调用上下文注入）
│   │   ├── inline.ts          #   ★ v0.2 第七批：有界内联解释器（analyze 预编译 + PC 顺序执行 + 环境读/索引段替换 + InlineManager 缓存/preanalyze 预热）
│   │   ├── engine.ts          #   编排（createView / replayFunction(s) / replayPredicates 纯函数 + ★InlineManager 集成 + resetCaches）
│   │   └── index.ts           #   装配（requires: kernel.project/kernel.slots/★kernel.io/snapshot.source/condition.extractor；project.closed/functionChanged → resetCaches）
│   ├── ui-convention-report/src/index.ts # ui.panel 面板（订阅 linter；点击 → revealLocation）
│   ├── ui-kojo-navigator/src/          # 函数树导航（tree.ts 纯逻辑 + index.ts 面板 + 条件徽章 + ★第八批：⟲ 回放徽章 → kojo.replayFunction）
│   ├── ui-state-replay/src/            # ★ v0.2 第八批：状态回放面板（第 10 个插件）
│   │   ├── panel-logic.ts              #   纯逻辑（调用上下文文本解析 / 未知分组 / 函数名提示；零 React 可单测）
│   │   └── index.ts                    #   ui.panel（选档×选角色×选函数 → 三值结果 + 置信度 + 未知分组；监听 kojo.replayFunction）
│   └── ui-plugin-status/src/           # 插件状态面板
│   └── kojo-sugar/src/                 # ★ v0.3 S2/S3：语法糖转译 + 编译落盘（服务 sugar.transpile）
│       ├── lexer.ts / parser.ts / codegen.ts / expression.ts  # 三段式转译（行式词法 → AST → ERB 产物）
│       ├── service.ts                  # 服务实现（parse/transpile/sourceOf 纯函数 + compileToFile）
│       └── compile.ts                  # ★ S3：写链路（守卫→编码组装→ensureDir→备份→双闸写→回读字节比对）
└── app/src/
    ├── bootstrap.ts           # 注册插件（13 个插件）
    ├── ui/App.tsx             # 订阅 kojo.functionChanged / editor.revealLocation
    ├── ui/ProjectView.tsx     # 透传 reveal
    ├── ui/EditorPane.tsx      # revealLine/revealNonce → Monaco revealLineInCenter
    └── styles.css             # 约定面板样式 +导航面板样式（nav-*）+ ★回放面板样式（rp-*）+ nav-badge.replay
```

## 五、验证矩阵（怎么跑）

```bash
cd <工作树>
pnpm install
pnpm test               # 1432 项（本机真实语料无 sav/ → 金样本/集成冒烟里依赖存档的用例**显式 skip**，属正常；2026-10-12 §5.74 起不再是 ENOENT 失败）
pnpm typecheck          # root + app（app: pnpm --filter @kojo/app typecheck）—— 两套都必须跑
pnpm audit:decoupling   # 必须 ✅（plugins 数 16；审计 A–D 四项）
# Rust 宿主（本机 cargo 可用、增量秒级；改 lib.rs / 新增 tauri::command 必跑）：
cd packages/app/src-tauri && cargo test --lib   # 12 项（写允许域 9 + 导出复制 3）
node node_modules/vitest/vitest.mjs run packages/plugin-api/tests/sugar.test.ts   # v0.3 S1：语法糖契约（类型守卫 / 别名只读性 / 源映射 / golden 逐字节）
node node_modules/vitest/vitest.mjs run packages/plugins/kojo-sugar/tests/compile.test.ts   # v0.3 S3：编译落盘（编码组装 / 双闸 / 备份 / 回读验证）
# 真实工程集成冒烟（168 角色/2285 文件/99k 函数/家族覆盖率/导航地基/校验报告/条件抽取/存档六档/状态回放/注入写链路/**语法糖编译落盘**）：
KOJO_SMOKE_PROJECT="C:\game\eratw-4.980基线语料" pnpm vitest run packages/kernel/tests/integration-plugins.test.ts
# 回放线复测（§5 / §6）——**存档库 = `C:\Game\eratw-save\sav\`**（语料的同级目录，2026-10-13 用户定；
# 真实语料本体始终零写入、也**不放** sav/，避免与作者自己的游戏目录混在一起）。档不入库，身份见 BASELINES §5。
# A) 只复测金样本（serialize∘parse 同构，只需 .sav）→ **零副本直跑**：
KOJO_SMOKE_PROJECT="C:/Game/eratw-save" node node_modules/vitest/vitest.mjs run packages/plugins/sav-parser/tests/golden-roundtrip.test.ts
# B) 复测全链路（索引/校验/抽取/回放/注入，需要完整工程根）→ 用一次性副本，验完删：
#   cmd //c "robocopy C:\Game\<基线语料> C:\tmp-kojo-sav\eratw /E /XJ /MT:24 /NFL /NDL /NJH /NJS /R:1 /W:1"   # 退出码 <8 即成功
#   cmd //c "robocopy C:\Game\eratw-save\sav C:\tmp-kojo-sav\eratw\sav /E /NFL /NDL /NJH /NJS"
KOJO_SMOKE_PROJECT="C:/tmp-kojo-sav/eratw" node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts
#   跑**全量**套测时仍然**不要**设 KOJO_SMOKE_PROJECT（会放行依赖存档的用例并在无档机器上变红）
# 桌面壳（会弹窗 ~100s 自动关闭）：
node tools/smoke-tauri-dom.mjs
# 桌面壳真实 IPC 冒烟（Rust 双闸 a–e；CDP 直调 invoke；自动还原 store/文件/备份；会弹窗 ~2min）：
node tools/smoke-tauri-ipc.mjs
# 口上项目线 UI 实机验证（2026-10-12 实测可行）：pnpm tauri dev 起真壳 → 从「最近打开」进项目
# （写授权已持久化，不必重走对话框）→ 活动栏 ⌂ 进「我的口上项目」。
# 想让面板有内容又不想点向导：直接在 %APPDATA%\dev.kojo.editor\workspaces\<id>\workspace.json 种一个。
# WebView2 外层窗口的无障碍树是空壳，须按截图坐标点；原生对话框（rfd）有完整 UIA 树，可用 element_index 驱动。
```

**架构铁律（改动前默念）**：
1. 内核/契约/Rust 宿主**零游戏名词**（审计 A 项，只查代码行；行尾 `// audit-allow: <理由>` 可豁免；**注意裸 `sav` 词也在黑名单**——`savDir`/`SavArchive` 这类带后缀的复合词不匹配、裸 `'sav'` 会挂）；
2. 插件**只许依赖 `@kojo/plugin-api`**，禁 import kernel、禁插件间交叉 import（审计 B/C 项；**测试文件豁免 C 项**）；
3. 游戏知识只能进 eratw-adapter；跨游戏共享术语（kojo/chara）放 plugin-api；
4. 内核不静默：inactive 必须可见、冲突必须 error、**校验规则抛错必须进 `report.failedRules`**；
5. 游戏目录整体只读，写入仅限用户批准的 `writablePaths`（白名单在内核 io 强制）+ **常驻可写根**（作者工作区根，不受项目开闭周期清空，口上项目批 P-A）；
6. **绕开写允许域只有一条法定通道**：`exportFile` —— 落点由用户在系统对话框里显式选定（**对话框即授权**），且对话框与写盘绑在**同一个 Rust 命令**内，JS 拿不到落点决定权。新增任何"写到域外"的能力必须照此形态，**不得开放任意目标路径参数**。（同形态的 `exportDirectory`（整目录复制）已于 §5.97 删除：导出改走 ZIP 后全仓零生产调用方，而"只有一条通道"这句话不该挂着一个没人用的能力。）

## 六、v0.2 批次记录（第三批～第十七批，✅ 全部完成）+ v0.3 糖批（S1～S7，✅）

### 6.1 第三批：条件谓词抽取 `condition-extractor`

**实施结果**：三层落地全部完成——结构（`scanControlFlow`）/ 谓词（`condition-extractor` 插件）/ 语义（adapter `variableSchema` CSV 驱动）。

#### 交付清单
- **`scanControlFlow`**（erb-parser `scanner.ts` + 服务）：线性控制流骨架（kind/表达式原文/块深度/行号）；配对表以引擎 `FunctionIdentifier.cs funcMatch` 为准；孤儿闭合宽容；11 项单测。
- **`condition-extractor` 插件**（服务 `condition.extractor`）：`expr.ts`（表达式 tokenizer + Pratt 解析：全运算符 + `[[词]]` + 括号索引段 + opaque 降级）/ `extract.ts`（CASE 展开、依赖聚合、语言局部量排除、schema 标注）/ `engine.ts`（全量编排：并发 8、两指针切片、代际保护）/ `index.ts`（装配）。32 项单测。
- **契约**：`plugin-api/conditions.ts`（`ConditionExpr`/`VariableRef`/`StateDependency`/`FunctionConditions`/`ConditionIndex`/服务）；`plugin-api/erb.ts` +`ControlFlowStatement`。
- **adapter `variableSchema`**：`variable-schema.ts`（扫描 `CSV/*.csv` 名称表 33 张；编号↔名称双向 lookup）；`constants.csvDir`。7 项单测。
- **导航条件徽章**：`ui-kojo-navigator` 函数行显示 schema 标签（恋慕/好感度…）+ `+n` 折叠；悬停看阈值；`.nav-badge.cond` 样式。

#### 关键设计（详见 IMPLEMENTATION-LOG §5.9）
- 谓词**聚合**存储（函数级 `StateDependency`），不存全量谓词对象——49 万谓词的量级必须聚合控制内存。
- `opaque` 降级**绝不抛错**；未解析计数显式呈现（不静默）；未解析率 0.04%。
- 局部量排除名单（LOCAL/ARG/RESULT/COUNT 系）是**通用语言知识**（Emuera 内置），不违"零游戏知识"。
- schema 标注按 `project.adapterId` 精确匹配（复用 ADR-0002 槽位查询通道）。

#### 真实数据口径（排障用）
- KX 占位符 603 条出自"函数名去重计"；条件抽取 95,504 函数中 31,609 含状态依赖（66.9% 函数无状态条件 = 大量纯文本/工具函数）。
- `CFLAG:2`（好感度）条件依赖合计 480 函数——比想象少（作者更常用 `TALENT:恋慕` 门禁，17,993 函数）；矩阵设计时以 TALENT 维度为主。

### 6.2 第四批（✅ 已完成）：存档快照源（`sav-parser` 先行）

**实施结果**：契约 + 插件 + 测试 + 集成全量落地（IMPLEMENTATION-LOG §5.10 为权威记录）。

- **契约**：`plugin-api/snapshot.ts`（`SnapshotArchive` / 变量模型 / `SnapshotSourceService`）；服务键 **`snapshot.source`**（非 `sav.parser`，理由见IMPLEMENTATION-LOG §5.10）。
- **插件** `sav-parser`：`binary.ts`（7-bit 字节数前缀 / 整数编码）+ `arrays.ts`（六种数组游程解码）+ `parse.ts`（文件级全流程）+ `gunzip.ts`（`DecompressionStream`）+ `engine.ts`（扫描编排）+ `index.ts`（装配）。58 项单测（合成字节）。
- **真实回归**：与逆向 CJS 解析器逐字段对拍（六档全等，16,000 变量/档）；集成冒烟六档断言（零残余 / #DIM 65 / MASTERNAME 7 / RANDDATA 剪枝实证 / MONEY 51 亿 / EM 2 表）。
- **写侧（v1.1）未动**：金样本"原样写回逐字节对比"与注入 UI 是后续阶段。

### 6.3 第五批（✅ 已完成）：状态回放引擎（`state-replay`）

**实施结果**：契约 + 插件 + condition-extractor 明细扩展 + 测试 + 集成全量落地（IMPLEMENTATION-LOG §5.11 为权威记录）。

- **契约 `plugin-api/replay.ts`**：`ReplayStateView` / `ReplayValue`·`ReplayOutcome`（三值）/ `ReplayUnknown`（16 种原因分类）/ `FunctionReplay`（置信度三档）/ `StateReplayService`。服务键 **`state.replay`**。
- **插件 `state-replay`（第 9 个）**：`var-model.ts`（引擎级变量清单）/ `state-view.ts`（归约：按 NO 定位角色块、TARGET 补位、稀疏取值、越界与截断显式）/ `evaluate.ts`（三值求值：Kleene / 整数除法截断 / BigInt 位运算 / 字符串 `==`）/ `engine.ts`（编排）/ `index.ts`（装配）。62 项单测。
- **condition-extractor 扩展**：`functionPredicates(name)` 按需明细（读文件 → `scanControlFlow` → 逐条 AST；不入全量索引；文件文本 + 明细双缓存，索引重建失效）；`extractFunctionPredicates` / `collectPredicates` 导出；4 项新单测。
- **adapter 契约扩展**：`VariableInfo.resolvedIndex`（具名索引 → 编号：`TALENT:恋慕` → 3；variable-schema 填充）。
- **真实回归**：save03 × 古明地觉（K49）全量回放 1,356 函数 / 11,685 谓词（命中 773 / 未命中 3,561 / 未知 7,351；exact 230 / partial 755 / unknown 371）。

### 6.4 第六批（✅ 已完成）：回放求值器扩展（数据流 + 内置函数 + 调用上下文）

**实施结果**：契约 + 抽取 + 求值三层落地（IMPLEMENTATION-LOG §5.12 为权威记录）。

- **契约**：`FunctionAssignment` + `FunctionPredicates.assignments` + `FunctionPredicate.context`（conditions.ts）；`ReplayCallContext` / `ReplayFunctionOptions` + 3 个新 unknown 码（`local-no-write` / `call-context` / `builtin`）（replay.ts）。
- **抽取**（condition-extractor）：`buildContextLookup`（段栈折叠：开块入栈 / 分支换段 / 闭合弹栈，kind 分类与 scanner 配对表同源）+ `collectAssignments`（直线赋值；`==` 不误匹配；`+=` 失效点；注释/@#$ /SKIP 块跳过）；仅 `functionPredicates` 明细路径收集。
- **求值**（state-replay）：`locals.ts` 叠加层（前缀可达 + last-write-wins + RHS 递归记忆化 + ARG/ARGS 注入）；`builtins.ts` 8 个纯函数；`evaluate.ts` call 分支先查内置表。
- **真实回归**：未知 7,351→5,668（62.9%→48.5%）；exact 230→786；全未知函数 371→70。
- **设计教训（先测量）**：批五"主因 = ARG"假设被实测推翻（ARG 仅 14%，LOCAL 族 60% 才是大头）——假设必须让位于测量。

### 6.5 第七批（✅ 已完成）：有界内联求值（口上域 `#FUNCTION` 纯助手顺序解释）

**实施结果**：契约 + 抽取 + 求值三层落地（IMPLEMENTATION-LOG §5.13 为权威记录）。

- **测量先行（§5.9 教训第四次应验）**：临时 dump 实测 call 被调函数形态——26 名 / 2,805 谓词中口上域内可解释仅 3 名 / 1,991 条（71%，`陷落状态`+`关系_310`+`陥落状態`）；23 名在索引域外（FIRSTTIME 等，本就不可内联）。可内联体 100% 为 IF/SIF/RETURNF + ARG 补位赋值。
- **契约**：`FunctionAssignment.name` 扩 `'ARG'|'ARGS'`；`FunctionPredicates` +`endLine`/+`returns: FunctionReturn[]`。
- **抽取**：`ASSIGN_RE` 扩 ARG/ARGS + `collectReturns`（RETURNF 收集）；明细路径产出（聚合零开销）。
- **求值**：`inline.ts`（analyze 预编译 + PC 顺序解释器：SIF 条件体 / IF 链 nextBranch/endAfter / pendingEval 双语义标记 / 环境读 + **索引段替换** / 深度界 8）+ `evaluate.ts`（`EvalContext{read, resolveCall}` 重构）+ `InlineManager`（缓存 + `preanalyze` BFS 预热）+ state-replay `requires` 增 `kernel.io`。
- **真实回归**：未知 5,668→3,741（**48.5%→32.0%**）；call 桶 2,297→**368**（消解 84%）；exact 786→836；全未知函数 70→38。
- **教训（§九-19）**：ELSEIF/ELSE op 的"跳转到达 vs 自然掉落"双语义——PC 无法区分来源，须编译期改写（假跳转绕过 ELSE op）+ 运行期标记（pendingEval）。首版集成测试抓出（ELSE 分支错误落到链尾兜底 RETURNF）。

### 6.6 第八批（✅ 已完成）：状态回放面板（`ui-state-replay`）

**实施结果**：呈现 + 纯逻辑 + 事件联动落地（IMPLEMENTATION-LOG §5.14 为权威记录）。

- **面板**：选档 → 选角色 → 选函数 → 逐条谓词三值结果 + 置信度徽章 + 未知原因分组（中文提示）；谓词行点击跳源码；视图（档 × 角色）惰性重建 + 代际保护。
- **调用上下文**：`0=36, 1="约会"` 文本解析（panel-logic.ts，+11 单测）；场景输入不猜测。
- **联动**：内核事件 `kojo.replayFunction`（events.ts + bus.ts）；导航面板 ⟲ 徽章发起；UI 插件零交叉依赖。
- **验证**：400 项全绿 / audit 10 插件 / 真实冒烟无回归 / app build ✅。
- **环境边界**：桌面壳深度冒烟在沙箱会话不可跑（tauri CLI 的 `BeforeDevCommand` 经 `cmd /S /C` 触发宿主管道耗尽 os error 231）——非项目问题，需在正常终端执行；app vite build 已验证。

### 6.7 第九批（✅ 已完成）：分支走向

**实施结果**：契约 + 引擎折叠 + 面板呈现落地（IMPLEMENTATION-LOG §5.15 为权威记录）。

- **契约**：`BranchChainOutcome`（if-chain/select-chain × taken/no-match/unknown/unreachable）+ `FunctionReplay.branches`。
- **引擎**（`branches.ts` 纯函数）：链栈配对折叠 + unknown 立即阻断（后续真不可救）+ 可达性传播（外层未进入 → unreachable）+ 宽容。
- **呈现**：面板"分支走向"区（缩进 + 四态标记 + 点击跳命中行）。
- **教训（§九-23）**：向文档追加 §5.x 小节时，Edit 的 old_string 含 `## 6. 目录结构` 标题而 new_string 漏回——连续两批误删同一段落标题（已靠 grep 章节结构验证兜住）。**追加式编辑必须读回验证标题层级**。

### 6.8 第十批（✅ 已完成）：口上调用协议

**实施结果**：契约 + adapter 路由表解析 + 面板结构化输入落地（IMPLEMENTATION-LOG §5.16 为权威记录）。

- **测量纠正过度承诺**：call-context 值是场景输入不可推导——协议价值 = 槽位语义标注 + 默认场景（全 0 = 引擎转发链事实），不是"858 条自动消解"。
- **契约**：`KojoCallSlot` / `KojoCallProtocol` / `GameAdapter.kojoCallProtocol?`。
- **adapter**：`call-protocol.ts` 解析路由表（尾部段类型消歧：数值时机 \d+ 优先）；+5 单测。
- **面板**：结构化场景参数区（协议）↔ 文本框（无协议降级）；回放引擎零改动。
- **教训（§九-15 的再次应验）**：候选清单也要先测量——"自动消解"在写清单时未核验路由源码。

### 6.9 第十一批（✅ 已完成）：存档写侧预研

**实施结果**：写侧 PoC + 金样本回归落地（IMPLEMENTATION-LOG §5.17 为权威记录）。

- **save00 载荷 571,185B 字节级完全一致**——编码器同构达成（行驱动游程 / 整数宽度 / 7-bit 前缀 / 流控制）。
- **Int64 精度硬前置暴露**：RANDDATA（SFMT 625 状态）等大数被读侧近似，写回必坏——serialize 显式抛拒绝；v1.1 注入器倾向方案 B（rawBytes 原样复制 + 被修变量含大数拒绝注入）。

### 6.10 第十二批（✅ 已完成）：审阅修复（依据 docs/archive/CODE-REVIEW-2026-10-10.md）

**实施结果**：H1 + M2/M4/M5 + L1/L3/L4 落地（IMPLEMENTATION-LOG §5.18 为权威记录）。

- **H1（高，CASE TO AND 语义）**：契约 `conjunction?: 'and'`（FunctionPredicate + PredicateReplay 透传）→ extract.ts TO 半边打标 → branches.ts 同行"组内 AND（Kleene）/ 组间 OR"；向后兼容（无标记 = OR）。+7 单测；真实语料 3,136 处 TO 区间的分支走向不再"多命中"失真。
- **M4**：App 层 `requestOpenFile` 守卫 + `UnsavedConfirmDialog`（保存并前往/丢弃/取消）；EditorPane `onDirtyChange`/`registerSave`。
- **M5**：回放面板 `runReplayRef`（监听 effect 依赖清空，闭包永新）。
- **M2**：Rust `encode_string` had_errors 拒绝写（防 HTML 实体静默损坏）；`decode_bytes` had_errors 记 stderr 不阻塞浏览。
- **L1** storage JSON 容错 / **L3** POWER 超 2^53 先拒 / **L4** resolveModel 死代码清理（null 分支不可达）。L2 核实为误报（比较两侧已过 pathKey）；M1/M3 留 v0.3。

### 6.11 第十三批候选（已完成 2 项，余项顺延）

- **v1.0 收口**：✅ 回放面板场景预设（§6.15，第十五批）；✅ 协议覆盖校验规则（§5.27，签名槽与路由转发一致性）；**余项**：桌面壳真实终端冒烟（沙箱 os error 231 欠账）。
- **index-603 索引域外函数源（消解剩余 call 368）**：FIRSTTIME 等定义在 kojoPaths 之外——"游戏函数源"通道（扩 index 扫描域 / 按需 parseFile）；多数有副作用，收益需再测量。
- **adapter 口上调用协议**：家族 → 转发实参映射（KOJO_MESSAGE.ERB 路由表）→ call-context 858 条的自动消解；回放面板的场景选择器可从协议生成"对话对象/时机"下拉（替代手填槽位）。
- **回放面板角色上下文增强**：MASTER/ASSI/PLAYER 指针的场景选择（当前取快照顶层值）。
- **归档浏览器面板**（✅ 第十三批由 TRAE 交付，commit ca1a323）：消费 `snapshot.source` 列档（saveMes / 角色数 / 大小），点击看摘要。
- **存档注入器地基**（✅ 第十三批，见 §6.12）：Int64 精度方案 B 落地。

### 6.12 第十三批（✅ 已完成）：存档注入器地基（Int64 精度方案 B）+ 归档浏览器（TRAE）

**实施结果**：方案 B 全量落地（IMPLEMENTATION-LOG §5.19 为权威记录）。

- **契约**（plugin-api/snapshot.ts）：5 个变量接口 + `raw?: Uint8Array`；`keepRaw?` 解析选项；`ArchiveCellPatch` / `ArchiveOverrideValue` / `ArchiveOverrides`（vars + chars 两级 Map）——均从 index.ts 导出。
- **读侧**：parse.ts 读毕变量后 `span()` 记 subarray 视图（零拷贝，含 token+key+值域）。
- **写侧**（serialize.ts writeVar 三路）：① 无覆盖+raw → `w.bytes(raw)` passthrough（先于 token/key，Int64 近似值永不写回）；② 覆盖 → 标量替换（类型不符即抛）/ 数组 CellPatch 按下标合并（mergedCells：同下标替换、插入、排序；**Int64 守卫**——任一单元超安全域即抛）；③ 无 raw 走 legacy 重编码。
- **金样本关键纠正**：RANDDATA（SFMT u32 ×625）逐值均在安全域，第十一批"RANDDATA ≈2.8e16"是整体规模误读；真雷 = save01+ 顶层 `RESULT` 与角色块 `CFLAG`/`GIFT_GOT`/`TCVAR`。守卫测试动态扫描不安全单元，不硬编码变量名。
- **测试**：raw-inject.test.ts（+8 合成）+ golden-roundtrip 第二用例重写（六档 passthrough 差异 0 含 save01-05 + save00 注入 `ISASSI=123456789` 读回一致 + save01 守卫拒绝）。
- **TRAE 并行**：`ui-archive-browser` 插件（snapshot.source 消费，第 11 插件，注册四处齐全，audit 11 插件全绿）。
- 下一步（第十四批候选）：v1.1 注入器用户面（改槽注入 UI → 含修改金样本回归 → 写盘走 writablePaths+备份）；或 v1.0 收口（回放面板场景预设 / 桌面壳真实终端冒烟）。
- **ui-condition-matrix（条件矩阵）**：按角色/家族聚合状态依赖；MESSAGECHECK 位可视化。
- `watchDirs` 文件监视——**已接真实监视器**（§5.84：Rust notify + 内核去抖）；**剩下的欠账在消费方**：
  外部改 ERB 后增量重建索引（现只有编辑器 model 重载，函数树/文件树不自动跟随）。
- Monaco bundle 4.3MB 拆分（manualChunks，低优先级）。
- scanner 的 TRY 系配对精度（`TRYCALLFORM` 无 CATCH 时产生幻影开块）——影响上下文路径精度，方向"宁少勿错"，低优先级。

### 6.13 第十四批（v1.0 收口线一，✅ 已完成）：回放面板信任闭环（C9 + A3）

**实施结果**：假设值标注 + 预览职责分层落地（IMPLEMENTATION-LOG §5.20 为权威记录）。

- **C9**：协议槽预填 0 从"确定值"降格为**假设值**——来源三态 `manual` / `assumption` / `unset` 纯逻辑；UI「假设」徽章 + 虚线边框、「基于假设」谓词标注、分支区「本结果含 N 个假设参数」汇总；**空值 = unknown 语义不变**。
- **附带修正**：槽位输入改以 `slotKey(kind,index)` 为键（修 `ARG:0` / `ARGS:0` 同号互相覆盖）。
- **A3**：面板内分「预览层（`renderReplayPreview`）」与「壳层（选档/选角/输入）」；ARCHITECTURE §5.4 补一行职责注记（糖预览复用 `preview.renderer`，不自建渲染）。
- **不变式**：回放引擎语义与 condition-extractor 契约零改动；真实基线不变（未知 3,741 / exact 836）。
- **验证**：470 项全绿（+14）/ typecheck root+app ✅ / 真实工程冒烟通过。**audit:decoupling 报红 = 并行线 C7 未提交的 `lib.rs:484` 裸 `sav` 词（非本批文件）**。
- 边界：仅 `packages/plugins/ui-state-replay/**` + 两份文档；未碰 `packages/app/src-tauri/**` 与 kernel io（C7 线）。

### 6.14 第十四批线二（✅ 已完成）：C7 Rust 侧写路径纵深防御（M3）

**实施结果**：Rust 写允许域第二道闸落地（IMPLEMENTATION-LOG §5.21 为权威记录）。

- **允许域语义**：允许 = 项目根目录整体（含游戏目录，与 kernel writablePaths 判定域一致）+ appDataDir（备份/配置，常驻）；其余一律拒绝并明确报错（不静默、fail-closed）。双闸并存——kernel io writablePaths（用户批准子集）语义不变，以更严者为准。
- **生命周期**：`register_write_domain`（project.opened 时 App.tsx 注册项目根）/ `clear_write_domain`（project.closed 回到仅 appDataDir）；注册失败 fail-closed + 显式 setError。均在 `isTauri()` 守卫内。
- **上闸命令六处**：write_file_bytes / ensure_dir / rename_path（from+to 双端）/ copy_file（仅 to）/ remove_file；读路径不受限。判定核心纯函数化（canonicalize_deep 解析 `..` 与符号链接 + is_within 组件级大小写折叠前缀比较），可脱离 Tauri 单测。
- **测试**：cargo test 9/9（域内放行 / 域外拒绝 / 未注册拒绝 / `..` 穿越两种 / 符号链接逃逸 / 组件级前缀不误判 / 深层不存在文件）；kernel io 契约与行为零改动（仅注释补双闸说明）。
- **验证**：470 项全绿 / typecheck root+app ✅ / audit 11 插件 ✅（§6.13 提到的 `lib.rs:484` 裸 sav 词已修——单测字符串 `v1.sav`→`v1.dat`）/ cargo check ✅ / 真实工程集成冒烟 ✅。桌面壳端到端手工冒烟（真实 IPC 下域外写被拒）沙箱不可跑，需正常终端 `pnpm tauri dev` 验证。
- 边界：仅 `packages/app/src-tauri/**` + `App.tsx`（注册/清除接线）+ kernel io.ts 注释 + docs。**M3 收口，v1.1 注入器的第二道闸前置条件达成**。

### 6.15 第十五批（v1.0 收口线一，✅ 已完成）：回放面板场景预设

**实施结果**：调用上下文从"每次手填"升级为**一等化的场景**——命名保存 / 下拉切换 / 一键应用 / 删除；纯逻辑在 `panel-logic.ts`（零 React，+15 单测）。

- **数据模型**：`ReplayScene{ id, name, slots: { slotKey(kind,index): { value, kind:'manual' } } }`；存储走 `ctx.storage`（域 = 插件 id `ui-state-replay`，键 `replay-scenes`），**不复用他人域**；内置默认场景为虚拟项不入存储。
- **一键应用**：默认场景 = 回全 0（int 假设 / str 未提供）；用户场景覆盖的槽标 **manual**（作者假设，非引擎事实——文案不写死"正确值"）；与 §5.20 的 assumption 徽章语义并存不冲突。
- **合并冲突显式上报**（不静默）：场景槽不在当前函数签名 → `dropped` 忽略；已填槽未被场景覆盖 → `reset` 回默认；同名保存 → 覆盖（保留原 id）。
- **协议降级**：协议可用 → 建议名由槽位 label 拼接（「对话对象=觉/时机=SP_EVENT」）；不可用 → 空串纯手填，场景改作用于裸上下文文本框（槽位↔文本双向转换，解析失败提示不抛错）。
- **不变式**：回放引擎（`state-replay`）与 `condition-extractor` 契约**零改动**；真实基线逐字复现（未知 3,741 / exact 836）。
- **验证**：485 项全绿（+15）/ typecheck root+app ✅ / `audit:decoupling` ✅（11 插件）/ 真实工程集成冒烟 ✅。
- 边界：仅 `packages/plugins/ui-state-replay/**` + docs。

### 6.16 第十六批（v1.1，✅ 已完成）：存档注入器用户面（写链路端到端）

**实施结果**：「改槽注入」从引擎能力做成用户可用的写链路（IMPLEMENTATION-LOG §5.23 为权威记录）。批次编号顺延：第十五批编号已被 §6.15 场景预设占用。

- **契约**：`plugin-api` 新增 `SnapshotWriteService { inject(path, overrides) }`（服务键 `snapshot.writer`）+ `SnapshotInjectionResult { path, backupPath, byteSize, verifiedCount }`；只读消费者不感知写权限。
- **sav-parser 0.3.0**：`container.ts`（16B 头 + gzip/raw 正文，Web 标准 CompressionStream）；`verify.ts`（回读验证：标量值 / CellPatch 全维度下标）；`engine.inject` 安全顺序 = Int64 守卫（先于备份）→ serialize → 组装 → 备份 → 写盘 → 回读 parse + verify，mismatch 抛错携带备份路径。
- **缺口修复**：eratw-adapter `writablePaths` 原缺 sav 目录 → 注入会被 kernel 第一道闸拒绝；已补提议（批准弹窗流程复用，内核/Rust 零改动）。
- **第 12 插件 `ui-snapshot-injector`**：`panel-logic.ts` 纯逻辑（+16 单测）+ 面板（档位下拉复用 archive-browser 列档数据流 / `kojo.snapshotSelected` 预填 / 作用域+变量过滤 / diff 清单 armed 两步确认 / 成功后重解析显示落盘新值）；登记四处 + bootstrap（order 71）。
- **回归**：kernel 集成第 9 节（appData 副本端到端注入 + 越权拒绝 + Int64 守卫）；golden-roundtrip 容器级注入用例（save00 动态标量 → gzip 组装 → 回读 verified）。
- **验证**：509 项全绿（+39）/ typecheck root+app ✅ / audit 12 插件 ✅ / 真实冒烟 ✅（副本 56744B 注入验证 + 备份已建；回放基线不变 3741/836）/ app vite build ✅。
- 边界：kernel/Rust 源码零改动（仅测试）；未碰 `ui-state-replay/**`。

---

### 6.17 第十七批（✅ 已完成）：桌面壳端到端冒烟（Rust 双闸真实 IPC 验证）

**实施结果**：还掉 C7/M3（§6.14）端到端欠账 + 固化自动化探针（IMPLEMENTATION-LOG §5.24 为权威记录）。

- **环境结论**：本机正常终端（PowerShell）`pnpm tauri dev` **可跑**——vite 1420 ✓ / cargo 增量编译 ~21s / 宿主 `kojo-editor.exe` ✓ / CDP 9222 ✓ / DOM 渲染 ✓；**沙箱 os error 231 未复现**（§八 已录）。
- **自动化探针 `tools/smoke-tauri-ipc.mjs`**：CDP 进 WebView 直调 `__TAURI_INTERNALS__.invoke`（与 app bridge 同一条**真实 IPC** 通道，非伪造），一条命令跑 a–e 全清单；自带 store（recent + approved-writable）/文件原字节/`.bak` 清场还原 + 端口预检。
- **手工清单 `tools/smoke-tauri-manual.md`**：a–f 可勾选 + 每项预期结果 + 本批实测结论表 + 安全不变量（后续每批人工过一遍）。
- **实测（全 PASS）**：a 开真实游戏目录（168 角色 / 2285 文件 / 99104 函数）；a2 首次「写权限确认」→「允许写入」；b 域内编辑保存 → 落盘含标记 + 备份目录新增 `.bak`；c 写 `C:\Windows\Temp` → 「写允许域拒绝」；d 关项目后写游戏目录 → 同拒；e appDataDir 写正常。**双闸语义实测成立**（项目根 + appDataDir 放行 / 域外 fail-closed / 关闭后回落仅 appDataDir）。
- 边界：仅 `tools/**` + `docs/**`，**零源码改动**（未动 Rust / TS；未碰 `packages/plugins/**` 与 kernel）。

---



### 6.18 第十八批（✅ 已完成）：审阅缺陷修复（BUG-REPORT-2026-10-10：M1 级联 / L5 / L6 / L7 脏判定）

**实施结果**：BUG-1~4 修复 + BUG-5 判定延后（IMPLEMENTATION-LOG §5.25 为权威记录）。

- **BUG-1（M1）方案 A**：runtime stop(id) 级联——dependentsClosure（requires×provides BFS，slot 消费关系不在图内已注明边界）+ 逆拓扑序逐个停用（最深依赖方先停），stopAll 行为兼容；retry docstring 陈旧说法一并更正。+3 测试。
- **BUG-2（L5）**：按引擎 funcMatch 原文精确配对——TRYC 六个→CATCH / TRY*LIST 三个→ENDFUNC（新配对类 funclist）/ PRINTDATA 九个；TRYCALL/TRYCALLFORM 等是单行语句不开块（比报告"影响为零"更进一步：修掉了幻影开块根因）。extract.ts 上下文栈同源镜像修。旧测试更正（原断言固化了误开块）。真实冒烟基线逐字不变（3741/836）。
- **BUG-3（L6）**：锚点语义（取最后一个 _K{no}）注释显式化 + 4 项边界单测，行为零改动。
- **BUG-4（L7）**：EditorPane 脏判定改 getAlternativeVersionId 版本号比较（O(1)）；取舍=撤销回原文显示脏（注释写明）。
- **BUG-5 延后**：file.changed payload 契约与 v1.1 注入器写链路一并设计（避免契约先行实现滞后），记入下一批清单。

**验证**：520 passed / 4 skipped 全绿（+16）/ typecheck root+app ✅ / audit 12 插件 ✅ / 真实工程集成冒烟 ✅。

### 6.19 语法糖 S2 批（✅ 已完成）：`kojo-sugar` 转译内核（+ 糖侧 lint 规则）

**实施结果**（IMPLEMENTATION-LOG §5.27 为权威记录）：S1 契约（`plugin-api/sugar.ts` + golden 固化）已就位，本批实现**转译内核**与其静态约定规则。

- **新插件 `packages/plugins/kojo-sugar/`**（`sugar.transpile`）：手写三段式——行式词法（`lexer.ts`）→ `SugarNode` AST（`parser.ts`，缩进配对，块头全角冒号 + 块体缩进更深）→ codegen（`codegen.ts`）。纯函数语义（不读不写文件）；四处登记齐全（package.json / root tsconfig paths / vitest aliases / app vite aliases + app deps / bootstrap.ts）。
- **codegen 硬约束**：产物缩进统一 **TAB**；引号台词/旁白按 §5.1 算法选 `PRINTFORM` 变体（`base + (d?"D":"") + (wait?"W":"L")`）；随机块 `LOCAL:N` 每块独占、嵌套递增（第 0 块写 bare `LOCAL`，golden 冻结口径）；表达式 `当`/`如果` 缺 `否则` → 编译错误（不产半成品）；纯条件行（整行仅 `{cond ? X : ""}`）→ `IF` 块（§5.2）；别名替换（§5.0）先于一切降糖，只读别名作左值报错；插值 `{}` 内出现 `当`/`如果` 报错；原生直通（全大写指令 / `$标签` / `@` 起整块）原样透传（§3.10）。
- **golden 验收**：§6.1 / §6.2 期望产物**逐字节一致**（含全角空格与 `;記入チェック` 注释行）；§6.2 是摘录（`IF LOCAL`..`ENDIF`，去一级呈现缩进），已按此口径冻结比对。
- **可回放形态验收**（新增 `replayable.test.ts`）：产物经 erb-parser 骨架扫描 + condition-extractor 表达式解析后**零 opaque**（覆盖两份 golden + 一份覆盖 §3 全部糖形态的合成样例）。为此 erb-parser 公开导出 `scanControlFlow`（与同类纯函数并列）。
- **糖侧静态 lint 规则**（convention-linter 内置新增第 2 条 `sugar.static-conventions`）：只对 `.kojo` 生效、零游戏知识、纯文本扫描——① `续` 写在引号内；② 每时机多个「选项」块；③ 表达式 `如果`/`当` 缺「否则」；④ 只读别名作赋值左值。**注意**：内置规则数 1→2，`integration-plugins.test.ts` 的 `ruleCount` 6→7 已同步（本批边界内，非并行线）。

**验证**：679 passed / 5 skipped 全绿（无 smoke；+115 相对上批 564）/ typecheck root+app ✅ / audit 13 插件 ✅ / 真实工程集成冒烟 ✅（**回放基线逐字不变**：K49 1356 函数 / 11685 谓词 / 未知 **3741** / exact **836** / partial 482 / unknown 38）/ app vite build ✅ / 产物过 condition-extractor **零 opaque** ✅。

**边界**（未做，属后续批）：写盘（S3）、UI/预览（S4）、升糖（S5）；spec 冻结未动。

### 6.20 语法糖 S3 批（✅ 已完成）：编译产物写链路（`.kojo` → 合规 `.erb` 落盘）

**实施结果**（IMPLEMENTATION-LOG §5.29 为权威记录）：S2 的纯转译内核接上磁盘，并确立产物落盘的**编码口径**。

- **契约扩展**（`plugin-api/src/sugar.ts`，零游戏名词）：`SugarCompileEncoding`（`{bom, eol:'lf'|'crlf', trailingNewline}`，**字节层**语义）/ `SugarCompileOptions`（+`encoding?` +`writeSourceMap?`）/ `SugarCompileResult`（`{erbPath, byteSize, backupPath, sourceMapPath?, diagnostics}`）/ `SugarCompileError`（携带 `targetPath`/`backupPath`/`diagnostics`，fail-closed）/ `SugarCompilerDeps`（`{io, transpile, log?}`）；`SugarTranspileService.compileToFile(source, targetPath, options?)` 新增（**唯一含 IO** 的方法；`parse`/`transpile`/`sourceOf` 仍纯函数）。
- **IO 契约扩展**：`FileIO.ensureDir(path)` 新增（契约 + `FileIOServiceImpl` 实现）——**与 `writeBytes` 同闸**（`assertWritable` 后 `bridge.ensureDir`）；关键安全点：目录创建同样不能越权（否则先在域外造目录）。
- **写链路**（`kojo-sugar/src/compile.ts`，新）：守卫（error 诊断先于一切副作用）→ 编码组装（`encodeErbBytes`）→ `ensureDir` → 备份 → `io.writeBytes`（第一道闸；越权 `WriteNotAllowedError` **原样传播**）→ **回读字节比对**（不一致抛错携带备份路径）；（可选）源映射旁挂。
- **编码口径（重大，与规范 §8 冲突，以语料为准）**：产物恒 **UTF-8-BOM + LF + 末尾换行**。实测全树 3,818 个 ERB：**LF-only 3,787 / CRLF-only 3**（口上域 2,317 个全 LF）；BOM 98.90%。规范 §8 的"CRLF"与语料不符（用户拍板采语料口径）。`crlf` 保留为可选项。
- **插件装配**：`kojo-sugar` 的 `requires` 增 `KernelServices.IO`；服务实例注入 `io` + `ctx.log`；契约头注改写（写盘已属本插件）。
- **目标路径**：`compileToFile` **严格按调用方给定路径写**；`.kojo` → `M_KOJO_K{No}_{分野}.ERB` 命名/目录推导留 S4（真实布局 = `個人口上/{编号 名称}/{口上名}/M_KOJO_K{n}_{分野}.ERB`，由 adapter `charaIndex[no].kojoDir` 给出）。

**验证**：714 passed / 6 skipped（**纯本批 +35**，基线 679；含工作区并行遗留合计 717）/ typecheck root+app ✅ / audit 13 插件 ✅ / 真实工程集成冒烟 ✅（**回放基线逐字不变**：K49 1356 函数 / 11685 谓词 / 未知 **3741** / exact **836**；**新增第 10 节**：副本端到端 360B（BOM+LF+末尾换行）+ 回读一致 + 备份 + 越权拒绝 + 编译拒绝零副作用）/ **golden §6.1/§6.2 逐字节断言零回退**。

**边界**（未做，属后续批）：UI 保存/预览（S4）、升糖（S5）、Monarch 高亮（S6）、保存期全角空格告警（随 S4）；spec 冻结未动。

### 6.21 语法糖 S4 批（✅ 已完成）：糖预览三向映射（数据层）

**实施结果**（IMPLEMENTATION-LOG §5.30 为权威记录）：给"这一行糖源码在这份存档状态下会走到哪、说什么"提供**数据层**答案——输入糖源码 → 转译 → **复用 `state.replay`**（不新建模拟器）→ 输出「糖源码行 ↔ 生成 ERB 行 ↔ 回放消息块」三向映射。**UI 留给后续批次**。

- **契约扩展（additive，零游戏名词）**：`WellKnownServices.SugarPreview = 'sugar.preview'`；`SugarPreviewRequest` / `SugarPreviewLine` / `SugarPreviewMessageBlock` / `PreviewReachability`（三档）/ `SugarPreviewResult` / `SugarPreviewArchive` / `SugarPreviewFunctionReplay` / `SugarPreviewDegradeReason`（**5 值闭集**）/ `SugarPreviewService.preview(request)`；守卫 `isReachableBlock` / `hasGenerated` / `hasArchive`。**旧签名一律未动**。
- **实现**（`kojo-sugar/src/preview.ts`，新文件；**transpile 内核与 golden 零改动**）：转译（复用注入的 `transpile`）→ 产物索引（`scanProductFunctions` + `foldMessageBlocks`）→ 源映射反查（`generatedLine → sourceLine`）→ 回放（逐产物函数 `replayFunctions`）→ 组装三向映射。
- **服务装配**：`index.ts` 的 `provides` 增 `SugarPreview`；**`state.replay` 是软依赖**（`try inject`，缺席则降级）——不写进 `requires`（否则回放插件未激活会让整个 `kojo-sugar` 静默 inactive）。**不注册任何 `ctx.bus.on`**：预览只消费事件、绝不发射（S3 已落 `file.changed` payload 契约）。
- **四项关键决策**：①**糖源行为主键**（编辑器锚点在糖源码；纯糖语法行如 `时机 …：` 无产物行对应，反查会落空）；②**纯生成行（`sourceLine: null`）不归属任何糖行**（不给糖行硬塞产物行——映射比没有更糟）；③**信封链（转译器生成的 `IF LOCAL` 包装守卫）不参与可达性折叠**（`LOCAL` 是语言局部量，回放只报 `unknown`，参与折叠会把每个块污染成 unknown；判据纯源映射：链头无糖源归属 + 走向 unknown；仍照列 `branches` 保可见性）；④**可达性折叠要求"所有覆盖链都通过"**（用"任一 taken 链通过"会因信封链 `takenLine` = 自身头行而**恒真**）。
- **降级是分类不是布尔**：`no-archive-requested` / `no-character` / `replay-service-unavailable` / `archive-unreadable` / `replay-failed`；**转译 error 也不抛错**（诊断原样带出、骨架照给，策略留给调用方）。
- **已知边界（写进契约头注）**：三向映射以**本次产物行号**为坐标系；`state.replay` 是**从磁盘读函数体**的（行号 = 该 `.erb` 文件行号），而预览跑的是**未落盘**的内存产物——S4 只做数据层与折叠逻辑，不替这一层做决定；未来接真实"保存后 .erb"的批次据此装配。

**验证**：**745 passed / 6 skipped**（纯本批 **+28**，基线 717；零回归）/ typecheck root+app ✅ / audit 13 插件 ✅ / **golden §6.1/§6.2 逐字节断言零回退**（未触碰）/ 新测试含 S1 golden 走**真实 `StateReplayEngine`**（`TFLAG:193 = 1/2/9` 三档钉死分支走向 + 信封链不污染 + 具名索引不可解析如实报 unknown）。

**边界**（未做，属后续批）：预览 UI（Monaco 高亮/悬浮/跳转、消息块气泡、可达性着色）、逐字符 FORM 展开渲染串、保存期全角空格告警、糖 `角色:` 直接从 AST 取（当前由产物 `_K{n}` 反推）。

### 6.22 语法糖 S5 批（✅ 已完成）：糖提升建议器（原生 ERB → 糖候选，数据层）

**实施结果**（IMPLEMENTATION-LOG §5.31 为权威记录；设计稿 `docs/archive/LIFT-SUGGESTER-DESIGN.md`）：给"这段原生 ERB 能不能改写成表层语法糖"提供**数据层**答案——扫描原生 ERB → 识别糖候选 → **对每个候选跑一遍 S2 转译做 round-trip 自证** → 只有逐字节一致才保留。**方向与 S2 相反（升糖）**；**UI 留给后续批次**；**永不自动改写磁盘**。

- **核心不变量（round-trip or nothing）**：候选成立**不由形态决定，由转译决定**。糖片段包最小 `.kojo` 壳 → 调本插件 S2 `transpile` → 取 `IF LOCAL` 与配对 `ENDIF` **之间**的正文 → 双侧 `normalizeIndent`（去公共最小缩进）→ 逐字节比对。不一致 → `roundtrip-mismatch` **降级不入结果**。`SugarLiftConfidence` 闭集**只有 `'verified'`** —— 契约层面不允许"可能对"的候选（误报结构上不可能，代价是有意为之的漏报）。
- **契约扩展（additive，零游戏名词）**：`WellKnownServices.SugarLift = 'sugar.lift'`；`SugarLiftKind`（4 值）/`SugarLiftConfidence`/`SugarLiftRoundTrip`/`SugarLiftCandidate`/`SugarLiftSkipReason`（**11 值闭集**）/`SugarLiftSkip`/`SugarLiftRequest`/`SugarLiftResult`/`SugarLiftService.liftSuggest(request)`；守卫 `isVerifiedCandidate` / `hasCandidates`。`ConditionExtractorService` **additive** 新增 `parseExpression(text)`（无状态纯函数，不依赖索引）。**旧签名一律未动**。
- **实现**（`kojo-sugar/src/lift.ts`，新文件 ~1200 行；**transpile 内核与 golden 零改动**）：`liftBlocks` / `liftPrintLines` / `liftAliases` 三类扫描 → `tryLiftIf` / `tryLiftWhen` / `detectRandomGroup` 装配糖片段 → `verifyRoundTrip` 自证 → 产出候选 / 跳过项。跳过区间**同时** `markConsumed`（`skipBlock`，否则成员行被碎片化提升）。
- **`IF LOCAL` 信封透传（`envelopeDepth`）**：转译器为每个 `时机` 块**自动**生成 `IF LOCAL … ENDIF`，真实语料里作者正文总被它包着 → 识别时探测"顶层恰为一个 `IF <裸 LOCAL>` 开块"，只在其**内部**识别，绝不把信封当候选。与 S4 `isEnvelopeChain` 同源；且转译器 expression 层**解析不到 `LOCAL`**（`unknown-identifier`），信封糖片段本来就过不了自证（双重保险）。
- **PRINT 变体映射（实测更正）**：D 后缀由**引号性**（是否台词）决定：`「台词」`→`PRINTFORMW`、`「台词」 续`→`PRINTFORML`、`旁白`→`PRINTFORMW`、`旁白 续`→`PRINTFORML`。故 `PRINTFORMDW 旁白` 类**无法 round-trip**，自动被拒。`PRINTFORM` / `PRINTFORMD` / `PRINTL` 系无糖形态 → `unsupported-print-variant`。
- **`alias` 类定案：v1 不出候选**（只报 `not-covered`）。实测：`别名` 是**糖源码层预处理**，糖层对原生 ERB 的 `%…%` 与全大写直通行**原样透传** → 原生 ERB 侧**没有可验证的别名落点**。保留类型与扫描（`ALIAS_MIN_OCCURRENCES = 3`）以备将来重开。
- **零交叉 import（解耦审计 C 项）**：`kojo-sugar` **不 import** 其它插件包；`scanControlFlow` / `parseExpression` 改为**软取服务槽**（`try inject / catch → undefined`）：前者缺席退回**内置兜底扫描**，后者缺席**保守跳过**所有带条件的块。

**验证**：**783 passed / 6 skipped**（纯本批 **+38** 项 lift 测试 + preview 装配断言 1 项更新，基线 745；零回归）/ typecheck root+app ✅ / audit 13 插件 ✅ / 真实游戏目录冒烟 ✅ 1 passed / **golden 逐字节断言与 S2 内核零改动**。

**边界**（未做，属后续批）：升糖 UI（候选列表/高亮/「应用」/diff 预览）、`选项` 块（三段合并）、`心形` 块、`别名` 自动建议、列级定位、带信封的整函数升糖。

### 6.23 语法糖 S5+ 批（✅ 已完成）：旁白口径 round-trip + lift apply 链路 + ui-sugar-lift 面板

**实施结果**（IMPLEMENTATION-LOG §5.32a/§5.32b 为权威）：① lift 自证壳支持 `旁白色:` 两种口径（`默认` 优先 / `作者色`），契约 additive `SugarLiftCandidate.narrationColor`；② 新服务 `sugar.liftApply`（apply 纯函数 + applyToFile 与 compileToFile 同款写链路，成功后发 `file.changed`）；③ 新插件 `ui-sugar-lift`（第 14 插件，`ui.panel` 槽 order 72：候选列表/单选/全选/忽略 + diff + 应用）+ 新事件 `editor.activeFileChanged`。golden 冻结计数 2→4。验收 850 passed / 6 skipped；已提交推送 `0d0bc51`。

### 6.24 解耦补齐批（✅ 已完成）：时机分野模板归位 adapter（S2 遗留承诺兑现）+ 审计 D 项

**实施结果**（IMPLEMENTATION-LOG §5.33 为权威；审阅发现 = `docs/archive/REVIEW-SUGAR-DECOUPLING-2026-10-11.md` B-1，用户拍板「补齐承诺」）：

- **契约**：`plugin-api/game.ts` 新增 `KojoFaceTable` / `KojoFaceTemplate`（faces + registration 三件套 + successFlag 位协议 + messageCheck 位协议；占位 `{t}/{n}/{i}` + `${段}` 上下文段）；`GameAdapter.kojoFaceTemplates?` 可选字段；诊断码新增 `face-table-missing`。
- **adapter**：`eratw-adapter/src/face-templates.ts`（新）按规范 §3.2 / 附录 C 全量登记 eraTW 分野表；`plugin.ts` 挂载（纯数据，不依赖 loadProject）。
- **转译器**：`codegen.resolveFace` 改查表，**缺表/未登记 → timing-face-unknown fail-closed，绝不回退内建模板**；三件套 / 成否 / MESSAGECHECK 全部由表驱动；装配层 `faceTableOf()` 与 `dictionaryOf()` 同源注入，所有 transpile 路径统一 `makeTranspiler()`。**产物零变化**（golden 逐字节零回退）。
- **审计 D 项**：`audit-decoupling.mjs` 新增 **D(通用插件零游戏知识)**——非 adapter、非 tests 的插件代码行出现 `M_KOJO` / `DIARY{` / `TFLAG:192` / 游戏名 / `個人口上` 即违规；`sav` 不在列（emuera 通用容器，sav-parser 是引擎级插件）。探针自证可拦回归。顺手把 `ui-state-replay` 占位符的 `M_KOJO_*` 示例改为游戏无关形态。
- **测试**：851 → 868（`face-templates.test.ts` 7 项 + 装配口径 4 项 + fail-closed 断言；`tests/support.ts` 统一注入 adapter 真实表）。

**验收（2026-10-11）**：868 tests / 862 passed + 6 skipped（50 文件全绿）/ typecheck root+app ✅ / **audit A/B/C/D 四项全绿** / 真实语料冒烟 1 passed / golden 逐字节零回退。**基线更新：868 项 / 14 插件 / 四项审计**。

### 6.25 语法糖 S4-UI 批（✅ 已完成）：糖预览面板（`ui-sugar-preview`，第 15 插件）

**实施结果**（IMPLEMENTATION-LOG §5.34 为权威）：把 S4 的**数据层**（`sugar.preview`）接成可浏览面板——当前 `.kojo` 文件 → 转译 + 源映射 + 诊断（有存档时附状态回放）→「**糖源码行 ↔ 生成产物行 ↔ 消息块可达性**」三向映射。**只做呈现 + 导航意图，转译/源映射/回放折叠全部来自数据层。**

- **新插件 `ui-sugar-preview`**（`ui.panel` 槽 order 74）：`requires` 只有 `sugar.preview` + `kernel.io` 两个硬槽，**`provides` 为空**（纯消费者）；`panel-logic.ts` 纯逻辑（零 React，39 项单测）+ `index.ts` 面板（`createElement` 非 JSX）。
- **存档扫描是软依赖**：`snapshot.source` 用 `try { ctx.inject } catch { undefined }` 取——缺席时面板退化为**两向映射**（糖源码行 ↔ 产物行），而不是 inactive。**"能力缺席要退化可见，不能静默"**。
- **未接存档 → 不显示可达徽章（本批最关键的纠正）**：数据层在无回放时 `fnBranches=[]` → 会把每个块折成 `reachable`——那是"**不可判定**"而非"可达"。UI 层用 `withReach = arch.connected` **门控**（不接存档就不调可达性折叠），并显示降级提示条。**不许把"不知道"画成"一定走到"。**
- **UI 插件间零直接依赖**：存档下拉预填走内核事件 `kojo.snapshotSelected`；跳转走宿主既有通道 `editor.revealLocation`；当前文件走宿主广播 `editor.activeFileChanged`。面板不持有宿主引用、不 import 任何 UI 插件。
- **角色号不在 UI 层推导**：面板只把 `archivePath` 交给 `sugar.preview`，由后者从产物骨架 `_K(\d+)` 反推——同一条推导只有一处实现。
- **事件纪律**：面板只读当前文件、绝不改盘，故**不发 `file.changed`**（谁改盘谁发）；`sugar.preview` 自身亦只读不发事件——**整条链路无变更源**。

**验收（2026-10-11 实测）**：**909 passed / 6 skipped（915）**（868 → 909，**+47**；52 passed / 3 skipped 文件，15 插件，零回归）/ typecheck root ✅ + app ✅ / `audit:decoupling` **A/B/C/D 四项全绿（15 插件）** / golden 逐字节零回退（未触碰）。**基线更新：909 项 / 15 插件 / 四项审计**。

**关键坑**：① `buildPreviewRows` 对以 `\n` 结尾的源 `split('\n')` **多一条幻影空行**，与 `countLines`/数据层 `buildLines` 口径不一致 → 已修（strip 尾部空元素），靠"概要源行 vs 列表行数"对照断言钉死；② TS2769——`createElement` 面板里 helper 返回 `unknown` 不能赋给 `ReactNode`（vitest 不报、只有 tsc 报，双跑价值再现）；③ 新插件必须 `pnpm install --no-frozen-lockfile`（frozen 会 `ERR_PNPM_OUTDATED_LOCKFILE`）。

**边界**（未做，属后续批）：Monaco 内联高亮/悬浮/装饰（`ui.editor.decorator`）、消息块逐条气泡、保存期全角空格告警的**阻断/一键修复**（需先接保存路径推导）、虚拟滚动、`.kojo` 角色号直读糖 AST。

### 6.26 语法糖 S6 批（✅ 已完成）：编辑体验（`.kojo` 高亮 + 补全 + 波浪线 + 判定面板，第 16 插件 `ui-sugar-editor`）

**实施结果**（IMPLEMENTATION-LOG §5.35 为权威）：把语法糖从"能编译"推进到"**写起来有支撑**"——四处交付：Monarch 高亮、补全、危险波浪线、判定面板。**§8 静态 lint 清单已在 S2 批落在 `convention-linter` 的 `sugar.static-conventions`（commit a6a7681），本批不重复实现。**

- **高亮住 app 宿主层，不住插件**：[kojo-language.ts](file:///<工作树>/packages/app/src/monaco/kojo-language.ts) 的 Monarch tokenizer + 语言配置 + 补全 provider 全在 `packages/app/src/monaco/`——**Monaco 不属任何插件**（插件契约刻意不依赖 Monaco），对齐 `erb-language.ts` 先例。糖专属 token 配色导出 `KOJO_SUGAR_THEME_RULES`，由 `erb-language.ts` **合并进同一处 `defineTheme('kojo-dark')`**（避免二次定义覆盖）。
- **词表单一真源（本批最关键的解耦决策）**：中文关键字 / 英文别名 / 运算符一律从 `kojo-sugar` 转译器自身的 `KEYWORDS`/`OPERATORS` **派生导出**（`SUGAR_LEXICON_WORDS`/`SUGAR_LEXICON_OPERATORS`/`sugarEditorLexicon()`），app 组合根 import——**高亮/补全与词法永不脱节**，本文件不复制任何词形清单。app → 插件的数据导入不违反审计（app 组合根本就 import 插件）。
- **规范 §4.1「中英双收但不对等展示」**：中文主形进补全列表，**英文隐藏别名输入即生效但不进列表**（避免污染候选）；保留代词 `她`/`你` 单列；文件内 `别名 X = …` 名字排最前（扫描 `ALIAS_DECL`，不重复转译器）。
- **波浪线走新槽 `ui.editor.decorator`（本批首次消费）**：契约 `LineDecoration` 增列级 `startColumn?`/`endColumn?`/`code?`；插件注册**纯函数** `decorate({path,text,project})` → app 壳 `refreshMarkers()` 逐个 try/catch 消费为 Monaco markers（`monaco.editor.setModelMarkers`，owner=`kojo-decorators`，250ms 去抖）。**契约刻意不提 Monaco**——宿主负责翻译，插件只吐行/列/严重级。
- **「糖判定」面板**（[ui-sugar-editor](file:///<工作树>/packages/plugins/ui-sugar-editor/src/index.ts)，`ui.panel` order 76）：当前 `.kojo` 的转译判定（**可编译 / 有警告 / 不可编译** + 逐条诊断，点击 `editor.revealLocation` 跳转）；`requires` 只有 `sugar.transpile` + `kernel.io`，`provides` 为空（纯消费者）。与 `ui-sugar-preview`（回放预览）、`ui-convention-report`（全项目校验）**职责不重叠**。
- **事件纪律**：装饰函数与判定面板**都是纯读取**（不改盘、不发 `file.changed`）；当前文件走宿主广播 `editor.activeFileChanged`；UI 插件间零直接依赖。
- **`SugarDiagnosticCode` 是闭集**：测试里造占位诊断不能随便填串（tsc TS2322）→ helper 用 `Omit<Partial<SugarDiagnostic>,'code'> & {code: string}` 再内部断言为闭集成员。

**验收（2026-10-11 实测）**：**931 passed / 6 skipped（937）**（909 → 931，**+22**；ui-sugar-editor 两文件 22 项全过）/ typecheck root ✅ + app ✅ / `audit:decoupling` **A/B/C/D 四项全绿（16 插件）** / `pnpm -C packages/app build` ✅ / golden 逐字节零回退（未触碰）。**基线更新：931 项 / 16 插件 / 四项审计**。手工清单 a–g 七项勾验见 IMPLEMENTATION-LOG §5.35。

**关键坑**：① **面板/装饰同样要过"能力缺席退化可见"**——`ui.editor.decorator` 槽被查询到但实现抛错时，宿主必须 try/catch 单条跳过而非整批失败；② 主题**二次 `defineTheme` 会整体覆盖** rules → 糖配色必须**合并进同一处定义**（导出 `KOJO_SUGAR_THEME_RULES` 拼接），不是另起一次调用；③ Monaco 补全/change 回调**闭包会捕获过时值** → 路径等易变状态必须 ref 化（`filePathRef`）；④ markers **列/行越界会静默丢弃或报错** → 一律 clamp 到 `[1, getLineMaxColumn]`；⑤ 新插件五处登记（root tsconfig paths / vitest aliases / app vite aliases / app package.json deps / **bootstrap 注册**）+ `pnpm install --no-frozen-lockfile`。

**边界**（未做，属后续批）：保存路径推导（`.kojo` → `M_KOJO_K{No}_{分野}.ERB`）接 `compileToFile` + 保存期全角空格**阻断/一键修复**；编辑器内三向映射装饰（悬浮/内联）；消息块逐条气泡；虚拟滚动。

### 6.27 语法糖 S7 批（✅ 已完成）：保存路径推导 + 前置检查（数据层，无新插件）

**实施结果**（IMPLEMENTATION-LOG §5.36 为权威）：把"编辑 → 保存"闭环缺的最后一块**数据层**补上——`.kojo` 的**目标产物路径推导** + **保存前置检查** `planSave`。本批**只做数据层**，UI 接线留 S7-UI。

- **目标推导 = "同目录换扩展名"（非 `charaIndex[no].kojoDir` 拼接）**：[resolveSugarTarget](file:///<工作树>/packages/plugin-api/src/sugar.ts) 只做 `.kojo` → 同目录同基名 `.ERB`（大小写不敏感，分隔符保留原样），**纯函数、零游戏知识、住契约层**。源 `.kojo` 由新建向导与产物**同目录**生成、沿用产物基名（`M_KOJO_K49_指令.kojo` 惯例），故换扩展名即正确；跨目录/改名（需 adapter 命名知识）留新建向导。
- **全角空格单一真源上收契约层**：`FULLWIDTH_SPACE` / `fullwidthSpaceLines` 从 `ui-sugar-preview` 本地定义**上收**到 `plugin-api/sugar.ts`，预览面板改为**原样转出**（import 面不变、测试零改动即绿）——保存前置检查与预览面板共用同一判据，杜绝分叉。
- **`planSave` 是只读前置**：一次算齐「目标推导 + 转译（产物/源映射/诊断）+ 全角空格告警行」；`blocked` 闭集两值 `'source-not-kojo' | 'transpile-error'`（优先级：无目标 > 半成品）。**落盘仍走 S3 `compileToFile`**，写盘能力不外溢（能力面 = 服务键面）。
- **全角空格只告警不阻断**：规范 §8 明文"保存期告警"；语料证据 55,565 / 3,599,696 行（1.54%）全为行中用途、**行首 0 次**。故独立成 `fullwidthSpaceLines` 字段而非诊断码（不污染 `SugarDiagnosticCode` 语义闭集），阻断/一键修复留 UI。
- **无新插件**：契约 + 引擎 + 单测 + 单一真源收敛，插件数仍 **16**。

**验收（2026-10-11 实测）**：**950 passed / 6 skipped（956）**（931 → 950，**+19**；`save-plan.test.ts` 三节全过）/ typecheck root ✅ + app ✅ / `audit:decoupling` **A/B/C/D 四项全绿（16 插件）** / golden 逐字节零回退（未触碰）。**基线更新：950 项 / 16 插件 / 四项审计**。

**边界**（未做，属 S7-UI 或后续批）：保存 UI 接线（`Ctrl+S` → `planSave` → 阻断对话框 / `compileToFile` 落盘）；保存期全角空格**阻断/一键修复**；新建向导跨目录目标命名校验。

### 6.28 语法糖 S7-UI 批（✅ 已完成）：`.kojo` 保存接线（发版判据 ① 最后一环，无新插件）

**实施结果**（IMPLEMENTATION-LOG §5.37 为权威）：把 §5.36 数据层接成 **UI 闭环**——`.kojo` 编辑 → `Ctrl+S` → 源保存 + 产物 `.ERB` 编译落盘。落盘能力（`compileToFile`）与前置检查（`planSave`）**一行未改**，全部复用。

- **新通用槽 `ui.editor.saveHandler`（宿主零格式知识的关键）**：[slots.ts](file:///<工作树>/packages/plugin-api/src/slots.ts) 新增 `EditorSaveHandlerContribution`（`matches(path)` + `save(request)`）+ `EditorSaveOutcome` 三态（`saved` / `needs-choice` / `error`）+ `EditorSaveWarning` / `EditorSaveChoices`。宿主保存前按 `matches` 就近征询接管者（取 `order` 最小命中，唯一接管不级联），命中即委托；**无命中 → 内核 io `writeText` 缺省保存**（能力缺席自动退化，不静默不阻塞）。
- **`.kojo` 保存逻辑住插件**（[save-handler.ts](file:///<工作树>/packages/plugins/ui-sugar-editor/src/save-handler.ts)，纯编排可单测）：`planSave` 前置 → **源文件始终保存**（作者成果不可因编译失败而丢）→ `blocked` 只拦产物（`note`「产物未生成：转译含 N 项错误」）→ 否则 `compileToFile` 落盘。失败一律转 `error` 结果（**不抛**）。
- **全角空格 = 告警 + 决策点（不强制阻断）**：未确认返 `needs-choice` 且**尚未落盘**（避免"取消"留副作用）；宿主弹 [SaveWarningDialog.tsx](file:///<工作树>/packages/app/src/ui/SaveWarningDialog.tsx) 三选——**取消 / 仍然保存 / 替换为半角空格并保存**（后者走 `executeEdits` + `pushUndoStop`，**可撤销**修复）。语义依据：规范 §8 + §5.36 决策 2（语料 1.54% 全为行中用途、行首 0 次）。
- **顺手修复潜在缺陷**：宿主 `Ctrl+S` 回调（`addCommand` 只注册一次）原闭包捕获旧 `save`（旧 deps 含 `filePath`）→ 换文件后会**存到旧文件**。改用 `filePathRef.current` + 稳定 deps（`[kernel, markSaved]`）修掉。
- **无新插件**：契约增槽 + 插件增第三处贡献 + 宿主接线 + 单测，插件数仍 **16**。

**验收（2026-10-12 实测）**：**958 passed / 6 skipped（964）**（950 → 958，**+8**；`save-handler.test.ts` 8 项 + `integration.test.ts` 补槽断言）/ typecheck root ✅ + app ✅ / `audit:decoupling` **A/B/C/D 四项全绿（16 插件）** / golden 逐字节零回退（未触碰）。**基线更新：958 项 / 16 插件 / 四项审计**。手工清单 a–i 九项勾验见 IMPLEMENTATION-LOG §5.37。

**边界**（未做，属后续批）：保存失败的结构化定位（备份路径跳转）；产物 diff 预览；新建向导（`.kojo` 落位 + 命名校验）；多接管者链式管线（避过早抽象）。

## 七、安全模型（写文件功能相关必读）

- 写入仅允许 `writablePaths`（用户批准 + 持久化于 kernel 存储域 `_global`），越权抛 `WriteNotAllowedError`；
- **双闸并存**（v0.2 第十四批 M3）：kernel io 白名单（第一道闸）+ Rust 宿主写允许域（第二道闸：项目根整体 + appDataDir，project.opened 注册 / project.closed 清除），语义以更严者为准；
- 写回**保编码保换行**（首读探测缓存：utf-8-bom / utf-8 / shift_jis / utf-16；eol 多数派）；
- 原子写（临时文件+rename）+ 自动备份 `{appData}/backup/{hash}/`（保留 20 版）；
- UI 侧「只读浏览」永远可用（未批准 = 不可写，不阻塞浏览）。
- **常驻可写根**（口上项目批 P-A）：作者工作区根经 `io.setAppWritableRoots` 登记，
  **不受 `setWritableRoots([])` 收回影响** —— 工作区恒可写独立于游戏目录授权的开闭周期。
- **导出是唯一法定绕闸通道**（P-D → 现由 `exportFile` 承担，§5.97）：落点刻意不过写允许域（导出的意义
  就是落到域外），授权来自系统对话框的显式选择；对话框 + 写盘绑在同一个 Rust 命令内，
  JS 侧只能传文件名与字节 → **无越权面**。取消返回 `null`，属正常路径不算失败。
  内核层那四条断言（不静默降级 / 原样透传字节 / 取消≠失败 / 不受白名单约束）在
  `kernel/tests/io.test.ts`「导出（唯一法定绕闸通道）」里钉着。
- **部署的三道前置判定全部在动盘之前**（P-E）：源必须是目录 / 目标不得已存在（报错不覆盖）/
  目标必须在写白名单内（未授权时**连目录都不建**，不给引擎留半成品）。复制走字节级，刻意不转码。
- **ERB 编辑器的只读口径**（写权限 × 糖视图，两组的共同依据）：见
  [`adr/0005-erb-write-permission-and-sugar-view.md`](adr/0005-erb-write-permission-and-sugar-view.md)
  —— 目录分野定默认可写性（工作区 ERB 恒可编辑），显式解锁只管「游戏目录里这一份、这一次」。

## 八、环境坑速查（本机，2026-10 实测）

| 坑 | 对策 |
|---|---|
| **本文档正文历史批次里满是 `<本机目录>` / `<本机目录>` / `<node 安装目录>` 路径**（照抄必失败） | 本机为新环境主机，只有 `C:` 盘 —— 换算表见 §一；§六 的历史记录**保留不回改**（git 历史同理，§十一-2 口径） |
| 沙箱注入的 `HTTP(S)_PROXY=127.0.0.1:8587` 是**坏的**，git/curl 默认走它必失败 | **推送一律用 `node tools/git-push.mjs`**（§5.98 起：奇数趟清代理直连、偶数趟走本机 Clash 代理，交替试；`KOJO_GIT_PROXY=""` 可退回纯直连） |
| github 直连时通时断（2026-10-13 实测：直连会 `Recv failure: Connection was reset`；**同晚 §5.97 推送时旧工具 6/6 全灭而代理一次就通**） | 直接跑 `node tools/git-push.mjs` 就行（它两条路都试）。手工兜底：`git -c http.proxy=<本机代理> -c https.proxy=<本机代理> push`（实测 `HTTP/1.1 200 Connection established`；**别改全局 git config**）。`git fetch` 同理要带代理 |
| npm/pnpm registry=npmmirror **直连可用** | 别给镜像配代理（ECONNREFUSED）；项目 `.npmrc` 已固定 |
| pnpm 11 供应链策略拦构建脚本 | pnpm-workspace.yaml `allowBuilds` 显式批准（esbuild 已批） |
| **`npx vitest` 会吞掉命令行环境变量**（Git-Bash 的 npx shim 不透传），带 `KOJO_SMOKE_PROJECT` 跑真实语料时整组静默 skip，看起来像"通过" | 带环境变量一律用 `node node_modules/vitest/vitest.mjs run <file>`（实测 `npx` 传不进、直调 node 传得进） |
| **`cat >> 文件` 在本机 shell 会把内容插到文件开头**（2026-10-12 实测把 describe 块灌到第 2 行；**2026-10-13 §5.89 同一条坑重现**：一次 heredoc 追加把 5,227 行的 `IMPLEMENTATION-LOG.md` 首部覆盖掉，靠事先 `.local` 备份 + `git show HEAD:<file> \| cmp -` 逐字节核对才复原） | **追加一律用 Edit/Write 工具**或 `node -e "fs.appendFileSync(...)"`；**改大文件前先 `cp` 一份**，复原前先核对备份与 HEAD 逐字节相同；改完必须 `grep -n` 读回首行与目标小节 |
| **在 vitest + node bridge 探针里量出来的"水位"不是用户等的时间**（§5.90：同一段真实 app 慢 2–3 个量级，因为每次读盘要过两趟 IPC） | 机制类结论（复用率 / 指纹等价 / 判据生死）可以用探针；**体感类结论一律 CDP 驱动真实 `tauri dev` 读 `__kojoPerf` 三个水位**；探针脚本只读语料、不点「允许写入」、`recent-projects.json` 播种后还原 |
| **多线程期间 `IMPLEMENTATION-LOG` 小节号凭记忆取 ⇒ 必撞**（2026-10-12 一天内撞三次：§5.49、§5.50、§5.59） | 写日志小节前先 `git fetch`，用 `grep -E "^### 5\." docs/IMPLEMENTATION-LOG.md \| tail -1` 取当前最大号 +1；rebase 撞号时**后落地的一方让位**（已公开编号不动），并在自己的小节头注里记下让位事实 |
| **Git-Bash 里 `TMP=/tmp` 让 MSVC `link.exe` 报 `LNK1104: 无法打开文件 C:\WINDOWS\lnk{GUID}.tmp`**（`cargo check` / `cargo test` 直接跑必挂，`TMP='D:\\...' ` 前缀也救不了） | **cargo 一律经 node 起**（`node -e "cp.execSync('cargo test --lib',{cwd:'…/src-tauri'})"`）——node 继承的是真 Windows 环境 `TMP=%LOCALAPPDATA%\Temp`，实测立刻通过 |
| **`window.__TAURI_INTERNALS__.invoke` 包不上**：它是 **non-writable 数据属性**，直接赋值和 `defineProperty` 都抓不到真实调用（§5.110 实测：注入后自检返回 `NOT-COUNTED(0)`） | 别指望 monkey-patch 数 IPC。两条正路：**次数**用 app 自己的日志计数（`reused 2285/2285`、`重算 2285 文件`、`逐文件重算 4570 个文件`）；**成本**在页面里直接跑受控实验（同一条路径集，串行 vs 并发各测一次）。任何计数探针**必须带自检**（调一次已知命令看有没有 +1），否则假数会一路进结论 |
| **探针 fatal 路径不收子进程 ⇒ 1420 被占死**，下一发 `tauri dev` 直接起不来（§九-29 那条连坐坑换了形式重现）；而 Git-Bash 里 `taskkill /PID x /T /F` 会被 MSYS 改写成 `<Git 安装目录>/PID`，报"无效参数" | `spawn` 之后**立刻** `process.on('exit', () => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide:true}))`；taskkill 一律走 node 的参数数组（不要经 shell），事后用 `netstat | grep 1420` 确认端口已空 |
| **应用侧探针也会把 fire-and-forget 的快照落盘截断**（§5.130 实测，v1 探针）：一到水位就 `taskkill` ⇒ 12 MB 抽取快照的写入被截在进程退出时，`store/condition-extractor/` 空目录 ⇒ **下一轮开项目仍是冷开，差点被读成"缓存没命中"的产品缺陷** | 探针收进程前**等插件自己那条落盘完成日志**（`Condition snapshot saved`）；量"某段耗时"的探针别在同一轮里顺手量"缓存有没有命中" |
| **同一个工作树只能跑一个桌面实例**（§5.128 实测）：另一发 `tauri dev` 跑的正是本树编译出的 `target\debug\kojo-editor.exe`，占着二进制（cargo 报 `拒绝访问 (os error 5)`）与 WebView2 用户数据目录 ⇒ 第二个实例**既编译不动也起不来**（WebView2 `0x8007139F`）；**换端口没用**（`tauri dev --config` 能覆盖 devUrl，锁还在） | 复测前先 `tasklist` 看有没有 `kojo-editor.exe`，确认是谁的会话再动——本组口径：**先问用户、经授权才 taskkill**。两条连带小坑：`spawn(…, {shell:true})` 传内联 JSON 会被吞引号 ⇒ 写成临时 json 文件再传路径；taskkill 必须走 node 的参数数组（MSYS 会把 `/PID` 改写成 `<Git 安装目录>/PID`） |
| **`(git fetch | tail) || 代理兜底` 是假兜底**：管道只把 `tail` 的退出码 0 交回来，直连失败被静默吞掉 ⇒ 在**过期的 `origin/master` 视图**上差点完成推送（§5.128 第五次撞号就是这么漏出来的） | fetch / push 单独成句，跑完看 `rc=$?` 或 `${PIPESTATUS[0]}`；兜底要显式判失败并改走 `git -c http.proxy=<本机代理>`（**只给单次调用带代理，不动全局配置**） |
| **临时探针（vitest）进程退出会截断 fire-and-forget 的快照落盘**：12 MB 只留下 `.tmp` 孤儿、正式文件从未 rename 出来 ⇒ 下一轮"什么都没读到"，直接量出"缓存没收益"的**假结论**（2026-10-12 §5.70 踩到） | 原子写以 rename 收尾 ⇒ 轮询**「目标文件 mtime 比进入本轮时新」**才算落盘完成（只看 `size>0` 不行，正式文件可能还在；全命中那轮反过来断言 mtime **未变** = 没回写） |
| **`ConditionIndex.durationMs` 不含快照读盘**（引擎 `t0` 在 `load` 之后），而级联由 `project.opened` 自动催动、显式 `ensureIndex()` 只是汇合在途 Promise ⇒ 围 `ensureIndex()` 计时量到的是"汇合耗时"，12 MB 的还原成本整段漏掉（差点报出"抽取 15ms"） | 量级联某段 = **从 `project.open()` 起算的水位差**（前一水位减后一水位），别用自计 `durationMs` 当体感 |
| bash coreutils 时常 127；`node -e` 多层引号/Markdown 反引号必翻车 | 一切用 node 临时 `.mjs` 文件或 Read/Write/Edit 工具；PowerShell 工具 stdout 不回显 |
| **`node -e` / bash 里的多层引号与 `grep -E "...\(..."`**：Git-Bash 的 grep 常把 `-E` 当普通正则用（`Unmatched (`），带引号的 node 内联脚本必翻车 | 一律落成临时 `.mjs` 文件再 `node` 跑；数出现次数用 `node -e` 里的 `str.match(/.../gm).length` 而不是 grep |
| **从代码路径"推"调用次数会推错**（本批实测：按 `find` + 命中后再一次 + `filter` 推 `kx-placeholder` 是 3×/名字 ⇒ 算出 594,621 次；真实读数是 397,622——`find` 在无命中时短路，而绝大多数名字无命中） | **给被优化的纯函数加计数读数**（`memo.stats()` 之类）再下结论；分布表必须是量出来的，不是推出来的（§5.73） |
| **vitest 会把 `console.log` 的第一行并进 `stdout | <文件> > <套件> > <用例>` 那行头**（多行日志只丢首行，看起来像"没打印"）⇒ 用 `grep '^\[probe'` 过滤会把水位行整个漏掉，误判成"探针没测到" | 探针输出**重定向到文件**再 grep（`> .local/probe-x.txt 2>&1`），或把关键数字放在非首行 |
| **bash 严重残缺时 pnpm/vitest/tsc shim 全挂**（`sed`/`dirname`/`uname` 缺失） | 直调 node：`node "<pnpm 的 pnpm.mjs>" install`；vitest → `node "node_modules/.pnpm/vitest@4.1.11_@types+node@2_1db5548ac037c87131628c83c4241b81/node_modules/vitest/vitest.mjs" run`；tsc → `node "node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/lib/tsc.js" --noEmit -p tsconfig.json` |
| **Edit 工具偶发"声称成功未落盘"，且同文件并行 Edit 会 EBUSY** | 关键修改后读回验证；**同一文件的多次 Edit 必须串行** |
| 模板字符串里写 Markdown 反引号（如 \`====\`）会截断 TS 模板串 | 用「」代替反引号 |
| cargo 输出带 ANSI 色码 | 正则匹配前先 stripAnsi（tools/smoke-*.mjs 有现成函数） |
| crates.io 直连慢 | cargo 首次 build 已完成，之后增量秒级 |
| **沙箱 `os error 231` 未复现**：本会话 Trae 终端（PowerShell）直接 `node tools/smoke-tauri-dom.mjs` / `pnpm tauri dev` → vite 1420 ✓ / cargo 增量 ~21s / 宿主 ✓ / CDP 9222 ✓ / DOM ✓ | 桌面壳可在正常终端跑；真实 IPC 冒烟走 `node tools/smoke-tauri-ipc.mjs`（Rust 双闸 a–e，自动还原 store/文件/备份） |
| tauri dev 首轮冷启动 vite `Re-optimizing dependencies` 会 HMR 重载页面（项目打开后回欢迎页） | 首次 dev 的已知抖动，二次稳定；`smoke-tauri-ipc.mjs` 已加端口预检 + 180s 等待缓解 |
| **同工作区并行线 WIP 会让集成冒烟断言误红**（如 adapter 新增规则使 `ruleCount` 5→6） | 先 `node tools/audit-decoupling.mjs` 粗判；再 `git stash push -- <并行线文件>` 复跑确认本批无回归，`git stash pop` 还原；**只提交自己边界内的文件**，并在 IMPLEMENTATION-LOG 记待办 |
| **rebase 解冲突时，git 判为「自动合并」的文件可能内嵌冲突标记；`git add -A` 会把它直接提交进历史**（2026-10-12 实录：计算池批提交 `0a97f91`（两轮 rebase 后现链为 `151367a`，演进表见 §5.55）把 `<<<<<<< / ======= / >>>>>>>` 连同正文提交，靠 typecheck **TS1185** 才逮到；tip 补干净 ≠ 历史干净，中间 4 个提交仍带标记） | 解冲突批**逐文件 add** + `git diff --cached` 过目，不用 `git add -A` 兜底；提交后立刻跑 **root + app 双 typecheck** 并全仓扫描冲突标记；推送前用 `git patch-id --stable` 逐对核对 rebase 前后提交，只对不相同的两对做逐行归属核验；已公开的历史不要乱改，**未推送时**用 `git rebase --onto` 把善后折叠回引入点（`git diff` 新旧 tip 为空即证内容零变化，详见 IMPLEMENTATION-LOG §5.55） |
| **`packages/app/tsconfig.json` 的 `types` 只有 `vite/client`**（`@types/node` 的全局不进这份配置） | 测试里 `import { readFileSync } from 'node:fs'` **可用**（显式模块导入仍能解析到 `@types/node`；§5.71 的「布局不进内核存储域」静态守门就这么写，root + app 双 typecheck 实测 exit 0）。若哪天报 TS2307，改测试写法，**别**往 app 配置里塞 node 全局——那会把 DOM/node 混成第三套类型环境（§九-7 的老坑） |
| **中文输入法合成期的按键会穿透到 `window` 全局快捷键**（2026-10-13 实机报障；真实壳实测：改前树 5 项红 —— 合成期 Esc 关掉设置页 / 退出全禅、合成期 `z` 误触 `Ctrl+K Z`） | 判据单源 `packages/app/src/ui/shell-keys.ts` 的 `isComposingEvent`（`isComposing` / `keyCode === 229` / `compositionstart` 会话标志三条叠用），`ShellLayout` 在全局 keydown **第一行**就退出；**失焦必须清会话标志**（漏 `compositionend` 会让快捷键全废，比原缺陷更坏）。新增全局快捷键一律走这道闸，别在组件里各自判 `e.key`；设置类浮层要防键盘，不能只防 `onMouseDown` |
| **真实壳 DOM 探针的两类假失败**（2026-10-13 各踩一次） | ① 按钮 `title` 带快捷键后缀（「切换底部区 (Ctrl+J)」），精确匹配取不到 ⇒ 先怀疑仪器再怀疑被测物；② 固定 `sleep` 等不到 vite 冷启的首屏 ⇒ 轮询目标元素。**派事件前必须先自检仪器**（合成事件能否真的带上 `isComposing` / `keyCode`），否则读数不可信 |
| **测「改前」行为时别动另一份在用的工作副本**（多 agent 共享主机，抢 vite 1420 / CDP 9222，还可能撞上对方未提交的树） | 用 `git worktree add <临时目录> HEAD --detach` 起游离树（本批未提交改动天然不在里面，正是干净基线）；`CARGO_TARGET_DIR` 指到已有 target 免冷编译 |
| **CDP 探针的四类假失败**（2026-10-13 一次批里各踩一遍，白跑三轮） | ① 场景串写成模板字符串又内含反引号 ⇒ **字符串被截断**（本仓早有同条教训：模板串里别放 Markdown 反引号），改成行数组 `join('\n')`；② 上一轮残留的 `kojo-editor.exe` 还在 9222 应答**旧构建** ⇒ 开跑前预检端口并清场；③ Monaco 视口**虚拟化**，用「渲染行条数」量展开/隐藏必然失真 ⇒ 量行文本**集合大小**；④ 点已激活的活动栏图标是**切换侧栏显隐**，不是打开视图；先判存在再点 |

## 九、本会话踩坑记录（给未来的自己）

1. **规则必须先核验引擎源码再定语义**：FORM 三连符号初版按"字面出现即报"实现 → 239 条里大量是 `+++`（MASTER 名）的有意用法（43 个文件）。收窄为排除 `+++` + 每文件每符号聚合 → 8 条真实事故。见 IMPLEMENTATION-LOG §5.8"规则误报治理原则"。
2. **`ctx.onDispose` 是插件订阅/清理的必经之路**：事件订阅不 `onDispose` 会导致插件停用后残留 handler（内核 deactivate 逆序执行 disposer）。erb-parser / convention-linter 均照此。
3. 新增插件包需四处登记：`packages/plugins/*/package.json`、root `tsconfig.json` paths、`vitest.config.ts` aliases、`app/vite.config.ts` aliases + `app/package.json` deps（kernel devDeps 亦然）。漏一处就 resolve 失败。
4. **真实语料是解析器的验收标准（第三批）**：初版表达式解析器 dump 真实 opaque 样本（528k 条件行中 2.17%）→ 发现两大系统性缺口：`[[词]]`（引擎 rename 语法，读取期按 `_Rename.csv` 替换）与**括号索引段**（`YOGORE:(GET_CHARAHOME(TARGET))`、`TALENT:(NO:30):恋慕`）。补齐后引擎侧未解析 3,383 → **187**（0.04%）。教训：**先 dump 真实失败样本，再定语法扩展**——不要凭直觉猜"什么写法常见"。
5. **具名索引的 schema 反向查询语义**（variable-schema 单测抓出）：`lookup('TALENT','恋慕')` 时 description 应取**名称本身**；初版直接把名称→编号反向表的**编号**当描述返回（`description:'3'`）。数字索引查名、具名索引自描述——两个方向别混。
6. **CASE 文本不能整体 parse**：`CASE 1, 2, 3` / `CASE 10 TO 20` 是 SELECTCASE 语法而非表达式——必须在抽取层展开为 `subject == 值` 再逐条 parse（dump 统计时若对 CASE 原文整体 parse 会误报 opaque）。
7. **双 lib 类型环境（node vs DOM）对 Web API 的严格度不同**（第四批）：`new Blob([bytes])` 在 root tsconfig（@types/node）通过、在 app tsconfig（DOM lib）报 `Uint8Array<ArrayBufferLike>` 不满足 `BlobPart`（SharedArrayBuffer 不兼容性）。修法：`new Uint8Array(bytes)` 复制到独立 ArrayBuffer 支撑数组，两套定义下均兼容。**tsc 必须 root + app 双跑**。
8. **vite build 的 `prepare-out-dir` 偶发 EPERM**（第四批）：清空 `packages/app/dist/assets` 时报 Permission denied（文件瞬时占用），手动 `fs.rmSync(dist, {recursive, force})` 后重试即过——不是代码问题。
9. **批次编号勘误**（第四批会话）：`conditions.ts` 头注释与 IMPLEMENTATION-LOG §5.9 曾写"条件抽取=第四批"，与 HANDOFF 口径（第三批）不一致；已统一为——**第三批=条件抽取、第四批=sav-parser**（判据：函数树=第二批在工作日志与 HANDOFF 双证）。
10. **TS7 对"联合字面量属性"的判别式 narrow 不可靠**（第五批）：`ArchiveScalarVariable.type` 是 `'int' | 'str'`（联合属性），`if (v.type === 'int' || v.type === 'str') return ...` 之后 TS 仍不把该变体从后续代码排除（报"Property 'saveLen' does not exist on ArchiveScalarVariable"）。修法：**显式类型守卫**（`isArrayVar(v): v is ArchiveArrayVariable`）替代判别式 narrow。
11. **变量寻址语义必须回引擎源码逐行核验**（第五批，§九-1 的再次应验）：`CFLAG:2` ≡ `CFLAG[TARGET,2]`、裸 `CFLAG` ≡ `CFLAG[TARGET,0]`（角色 1D）、裸 `DAY` ≡ `DAY:0`（全局 1D）——全部来自 `VariableParser.ReduceVariable`（:102-133 角色分支 / :153-170 全局分支），不是直觉推断。求值器的每个寻址分支都注了源码行号。
12. **JS 数字语义与 C# 的两处硬差异**（第五批）：①整数除法是**截断**（`-7/2 = -3`，Math.trunc，非 floor）；②位运算符（`& | ^ << >>`）在 JS 是 **32 位**——`1 << 40` 会得到 256 而非 2^40，必须经 BigInt 中转（`Number(BigInt(a) << BigInt(b))`，并先 `Number.isInteger` 检查）。
13. **同文件并行 Edit 必 EBUSY；且 Edit 偶发"声称成功未落盘"**（第五批复现，§八同款）：一次消息里对同一文件发多个 Edit 工具调用 → 第二个报 `EBUSY: resource busy or locked`；另有一次 Edit 报告成功但 `isArrayVar` 定义实际未写入（grep 复核时发现）。**同文件多次 Edit 必须逐条串行 + 关键修改后读回验证**。
14. **vitest 4 没有 `--reporter=basic`**（第五批）：传了会直接 Startup Error（"Failed to load custom Reporter from basic"）；用默认 reporter 即可（console.log 默认可见）。
15. **先测量再定语义（§九-1 / §5.9 教训第三次应验）**（第六批）：批五断言"未知主因 = `ARG:*`"，第六批实测构成：pseudo 4,439（LOCAL 系为主）/ call 2,485 / ARG 系仅 ≈14%。方法 = **临时 dump 测试（跑完即删）拿真实构成**再排优先级——本批因此把"本地量数据流"提为最大杠杆、调用上下文降为注入基建。
16. **块注释里写 `TRY*/PRINTDATA*` 会提前终止注释**（第六批，TS1127）：`*/` 序列在 `/** ... */` 内就是注释结束符；措辞改成"TRY 系、PRINTDATA 系"。
17. **引擎参数槽语义（第六批核验，勿凭直觉）**：签名第 i 个**声明槽**按顺序赋值——`(ARG, ARG:1)` 即声明 ARG:0 与 ARG:1 两槽（`getEl1forArg` = 下标，ErbLoader.cs:694-741）；声明槽被调用时**必有值**（实参或默认 0/''，ConvertArg Process.CalledFunction.cs:162-239）；未声明却引用 `ARG:n` → 引擎警告 + 默认尺寸 token（fresh-load 读 0，调用间持久）；`CALL FOO`（无括号）= 全部声明槽取默认值。LOCAL/ARG 调用间持久、读档重置（SetDefaultLocalValue 仅在 load/reset 时清）——回放取"直线执行"近似。
18. **模块循环依赖规避**：evaluate.ts 的 call 分支要调 builtins.ts、builtins 又要递归求值 → builtins 接收 `evalExpr: ExprEvaluator` 作为参数（依赖单向：evaluate → builtins），不搞双向 import。
19. **解释器的"到达方式"双语义是隐坑**（第七批）：IF 链的 ELSEIF/ELSE op 有两种到达路径——**条件假跳转**（需进入：ELSEIF 求值 / ELSE 进体）与**分支体自然掉落**（需跳过：跳 endAfter）。PC 落点相同、无法区分来源 → 首版集成测试抓出 ELSE 分支错误落到链尾兜底 RETURNF（THEN 体掉到 ELSE op 被当"前分支完成"跳过；IF 假跳到 ELSE op 也被同样跳过）。修法两层：①编译期——假跳转目标为 ELSE 时**绕过 else op 直接进体**（`elseIdx+1`）；②运行期——`pendingEval` 标记"跳转到达 ELSEIF（求值，用后即清）"，自然掉落（false）→ 跳 endAfter。IF op 无歧义（链顶只可能顺序到达）。
20. **preanalyze 别忘了函数自身**（第七批）：内联缓存的预热若只收集"谓词 AST 里的被调名"，顶层函数自身（体里不调用别人的）永远不会入缓存 → resolveCall 全 miss。`preanalyze` 第一步必须 `ensureAnalyzed(自身名)`。
21. **resolveCall 同步契约 vs analyze 异步现实的矛盾**：求值热路径是同步的（Kleene 求值器纯函数），但函数体文本读取是异步 → **两阶段设计**：`replayFunction` 先 await `preanalyze(detail)`（BFS 递归 analyze 全部可达被调），执行期 resolveCall 同步查缓存必命中（miss = 竞态 → log warn 回落 unknown，不挂起）。
22. **Bash 工具的 cwd 不如想象中可靠**（本会话实测）：`cd X && cmd` 的 cd 前缀偶发被吞、后台任务起始目录回到会话根 → **一律用 `pnpm -C <绝对路径>` / node 绝对路径脚本**，不依赖工作目录持久化。
23. **文档追加式编辑的"标题吞噬"**（第七、九、十批连续三次）：向 ARCHITECTURE 追加 §5.x 小节时，Edit 的 old_string 以 `## 6. 目录结构` 标题为锚、new_string 漏回该标题 → §6 标题被静默删除（前两次靠 grep 兜住，第三次依旧发生——**人工 Edit 不可靠，已改用 node 行号插入**）。根治措施：①追加小节用 node 脚本按行号 splice；②每次文档编辑后必须 `grep -n "^## \|^### "` 读回验证标题层级。

24. **回放链路的行号坐标系有三处来源，改一处不算改**（S4 批，排查最久）：`FunctionReplay.branches[].headLine` 由 `buildBranchOutcomes(detail.statements, predicates)` 构造——**只平移 `predicates[].line` 时 `branches[].headLine` 纹丝不动**。沙箱里跑"内存产物 + 真实回放引擎"（预览场景）时，`statements` / `predicates` / `assignments` / `returns` **四个数组的 `line` 都要同源平移**。
25. **"读不到就默认 0"让夹具写错变成"看起来对但走向错"**（S4 批）：`state-replay` 的 `readTopVar` 对**已知名但快照缺块**回默认值 0/`''`（不报错）。但 `TFLAG` 在 `var-model.ts` 的 `GLOBAL_INT_1D` 里 = **全局变量**，夹具放进 `chars[0].vars` 会静默读到 0 → 分支走向全错而**测试不报错**。修法：夹具放顶层 `vars`，且断言用"不同状态 → 不同走向"的**对照**（`TFLAG:193 = 1/2/9`），别只断言"有结果"。
26. **折叠类逻辑的"任一/所有"是隐蔽分水岭**（S4 批）：可达性折叠写成"某一条 taken 链命中即可达"时，外层信封链（`takenLine` = 自身头行、体涵盖整个函数）会让判定**恒真**——内层 `SELECTCASE` 的分支归属白算。正确是"**每一条**覆盖链都须通过"。这类错误不会崩、只会悄悄全绿，必须用"命中 A / 命中 B / 走兜底"三档对照钉死。
27. **自己生成的骨架守卫会污染语义判定**（S4 批，一般化）：`codegen` 生成的 `IF LOCAL` 里 `LOCAL` 是语言局部量，回放器只能报 `unknown` —— 若让它参与可达性折叠，**每个块都被污染成 unknown**（预览信息量归零）。解法是"识别并旁路信封"，判据必须**纯源映射**（链头产物行 `sourceLine === null`）而非游戏/引擎知识，否则会把 ADAPTER 该管的事漏进内核侧插件。

28. **读 Monaco 的行高必须读 `.view-line`（单数），不是 `.view-lines`（容器）**（UI 归一批 §5.65）：Monaco 把 `height:Npx;line-height:Npx` **内联写在每一条 `.view-line`** 上，`viewLines.css` 里 `.monaco-editor .view-lines` **只有 `white-space: nowrap`**——读容器只会拿到继承来的 `normal`，`parseFloat` → NaN → 静默退回兜底值，**改了等于没改且不报错**。且 `applySugarView` 紧跟 `setModel`，首帧可能一行都还没有 → 这类"问 DOM"的函数要带缓存。旁证：Monaco 自己在 `viewLines.css` 注释里写着 *"view-lines in view-zones … they don't set a line height"*。
29. **`pnpm tauri dev` 撞上占用 1420 的旧 vite 会连坐杀掉正在跑的桌面实例**（UI 归一批，本批弄丢了用户先前开着的两个编辑器窗口）：`beforeDevCommand` 失败即整个命令退出，并把已在的 `kojo-editor.exe` 一起带走。而**跨过一次 merge 的旧 vite 不能复用**——`node_modules/.vite` 预打包缓存过期（merge 给 eratw-adapter 带了 `react` peerDependency），用它起的壳是**纯白屏**；`cargo run` 直接复用旧 vite 同样白屏，别把"绕过 beforeDevCommand"当捷径。顺序：**先确认 1420 空闲 → 必要时 `rm -rf node_modules/.vite` → 再起**。

30. **bash 里 `node -e "..."` 的反引号会被 shell 当命令替换吃掉**（三线合流批）：改 docs 时字符串里的 `.kojo` 直接消失，写进文档成了"（ 为源 + 制品 ZIP…）"，且**不报错、不留痕**。本仓文档满是反引号代码跨度，命中率极高。→ **改 docs 一律落成临时 `.cjs` 脚本跑，跑完即删**，别用 `node -e` 内联。
31. **"对基线"要认 IMPLEMENTATION-LOG 各批自记的数，别拿 HANDOFF 的汇总行当准**（三线合流批）：远端 HANDOFF §二 写 1432、LOG §5.72 写 1440 —— 摘要行滞后了一批没同步。按 1432 核对会得出"+90 对不上"的假警报，白找一轮。
32. **"把成本从 A 挪到 B"会被误读成"在 A 发现了浪费"**（§5.81）：`kx-placeholder` 读数 387ms，加 `_KX` 前置过滤掉到 58ms，但 `kojo-completeness` 立刻从 36ms 涨回 364ms——那笔"解析全库每个名字"的账是 completeness 本来就要付的，只是原先由执行顺序在前的 kx 代付。**动手前要问的不是"这条规则能不能变快"，而是"这笔工作是谁必须付的"**；量净变化，不要量单条规则的读数。同类负结果见 §5.71 / §5.75。
33. **本壳里按截图坐标点对话框右下角的按钮不可靠**（§5.91 实机自验）：三次点「创建项目」都只把 overlay 关掉、盘上什么都没发生。判据是**反证**——把表单清空（按钮变 disabled）再点同一点**仍然关窗**，而 `.overlay-host` 对 `onMouseDown` 做了 `stopPropagation`，点在对话框内不可能关窗 ⇒ 命中测试落在了遮罩上。同一坐标区间在面板入口的向导上却成功创建过，所以**不能据此报产品缺陷**，只能承认是驱动方式的问题：要验这类流程，用 CDP 拿 DOM（`tools/smoke-tauri-dom.mjs` 那条通道）而不是点坐标；实在要点，先做"点禁用按钮应不关窗"的命中测试。
34. **别在还挂着 `pnpm tauri dev` 的工作树里跑"改源码看谁红"的反证**（§5.91）：反证要临时改源文件，而活着的 vite 会 HMR 进那个正在被驱动的窗口——本批 02:31:52 那次 `hmr invalidate /src/ui/FileTree.tsx` 就发生在 GUI 验证前 90 秒。结果本身仍成立（改回在点击之前），但**顺序一旦反过来，验的就是被临时改过的产品**。规矩：反证与实机**不同时进行**，或反证前先停壳。
35. **CDP 驱动 Monaco 打字：焦点给错元素会"看起来像只读锁泄漏"**（§5.96）：这个壳里的 Monaco 走 Chromium **EditContext**，输入面是 `div.native-edit-context`，而 `textarea.ime-text-area` 常年 `readOnly=true`（只是 IME 残影）。若先 `textarea.focus()` 再把键投进去，字**一个都不进**，现象与 ADR-0005 的只读锁一模一样——本组据此差点上报"工作区 `.kojo` 打不了字"。正确顺序：`Input.dispatchMouseEvent` 真点 `.view-lines` ⇒ 焦点自然落在 edit context ⇒ `rawKeyDown` + **`char`(带 `text`)** + `keyUp`（`type:'keyPress'` CDP 不认）。**别动焦点**，也别用 `Input.insertText`（它对着 readonly 的 textarea 也是空转）。报缺陷前先跑一条"能解释全部观测"的反证：干净会话里只开 `.kojo` 也打不进 ⇒ 通道问题，不是产品问题。
36. **收尾杀进程按 PID 树，不要 `taskkill /IM msedgewebview2.exe /F`**（§5.96）：WebView2 渲染进程是**全机共用**的，按镜像名强杀会连带打断别人正在开着的窗口（本批就误杀过 3 个，幸而都是可重画的渲染进程，没造成数据损失）。规矩：先 `netstat -ano | grep ":1420\|:9222"` 拿到自己那棵树的 PID，再 `taskkill /PID <pid> /T /F`；`kojo-editor.exe` 是本仓独有镜像名，按名杀可以。
37. **CDP 驱动：window 级合成 `Escape` 关不掉 picker**（§5.100）：Esc 链第一句 `if (pickerRef.current) return;` 把键盘语义让给 picker 自己，而 picker 监听的是**它那个输入框里冒泡上来的事件**。从 `window` 派发 ⇒ 它收不到 ⇒ 面板一直挂着，下一轮量测就会把"两种 picker 数字一模一样"当成怪现象报出去。正确姿势：`document.querySelector('.picker input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`。同 §九-35 的口径：**驱动通道自己失败 ≠ 产品失败**，先确认事件真到了那个处理器。
38. **写作模式（zen）跨次保留，会把侧栏选择器全部打空**（§5.101）：zen 下不渲染活动栏，`🗀` / `.tree-group-btn` / `.tree-file` 一律 MISS，看起来像"文件树坏了 / 索引没建出来"，实际是上一轮扫描结束在 zen 里没退出（它是被存住的偏好）。规矩：**量测开头先测 `.shell.zen`**，要用侧栏就先 `Ctrl+K Z` 退出；或者干脆走 **Ctrl+P 快速打开**拿文件（不依赖侧栏）。
39. **活动栏的视图图标是切换式，不是"切到那个视图"**（§5.103）：目标视图**已经可见**时再点它的图标，会把它整个藏掉——本组第二趟就这么把 `.tree-group-btn` 点没了，接着一整轮选择器落空、"外部新增没上树"，看起来完全像 HK-5 的失效通道在游戏目录侧失灵。规矩：**先测目标元素在不在，再决定点不点**（`if (count === 0) click(...)`），别把点图标当幂等操作。
40. **中文输入法合成期的按键会被当成全局快捷键**（§5.105，实机缺陷；§八 表里有同一件事的速查版，这条记处置口径）：全局 `keydown` 只认 `e.key === 'Escape'`，于是"撤销拼音候选的那次 Esc"与"关设置页 / 退全禅"在代码里是**同一条路径**；写作模式的主场景就是大量中文输入 ⇒ 一按就把用户的界面状态拆掉，而布局是持久化的，重启还在。规矩：三条判据叠用（`isComposing` / `keyCode === 229` / `compositionstart` 会话标志），监听走**捕获阶段**（组件含 Monaco 可自行 stopPropagation）；**必须配失焦清除**，否则"合成期不消费快捷键"退化成"永久不消费快捷键"，比原缺陷更坏。判据单源在 `shell-keys.isComposingEvent`，上游 HK-2 的模态栈（§5.95）现在也挂在这道门后面 ⇒ 合成期 Esc 同样不会误关对话框。
41. **上游已经搬走的逻辑，不要再抽成第二个文件**（§5.105 §七-6）：本组把 `reducer` 从 `ShellLayout` 抽成 `layout-reducer.ts`，rebase 时才发现上游「设置页归一批」已把它搬进 `layout.ts`——留着我的新文件等于同一张动作表两个真源，改一边另一边照旧，**比没测更坏**。规矩：抽纯前先 `git log -- <path>` 看上游最近一批把它搬到哪；撞车时撤回自己的文件、只保留测试。
42. **扫"冲突残留"的正则本身是判据**（§5.105 §七-7）：`^(<<<<<<<|=======|>>>>>>>)$` 只命中孤零零的 `=======`，而真实标记带后缀（`<<<<<<< HEAD` / `>>>>>>> 1ee625c (标题)`）⇒ 一处没解决的冲突被当成干净树提交，下一轮 rebase 把它当"我方内容"重放，制造**嵌套冲突**。规矩：口径写成 `^(<<<<<<<|=======|>>>>>>>)( |$)`，解完再跑一遍确认 0 命中。
43. **界面文案被刻意做成恒定之后，探针判据必须改读状态属性**（§5.107，首轮 5 项红全是仪器自己的）：糖视图开关的标签自 T3 起恒为「语法糖视图」（开关态在 `aria-pressed` 与 `.on` 配色上），而探针还按旧文案判"要不要点它"⇒ 条件永远不成立 ⇒ 糖视图根本没开 ⇒ `糖区=0` 连带反馈 5 整组假失败。规矩：**判据跟着界面口径改**，读 `aria-pressed !== "true"`；写判据前先问一句"这个字符串是状态还是恒定标签"。
44. **探针自己写的偏好会毒死下一轮，也会毒死用户**（§5.107）：驱动"糖视图须知"时点掉对话框，把 `kojo.ui.sugarView.prompted.v1` 写进了 localStorage ⇒ 第二轮"须知"再也不弹，看起来像产品坏了。规矩：**开跑前存档相关键、结束恢复原样**。⚠ 但**"恢复原样"会毒死另一支探针**——把 `prompted` 恢复成 `null` 之后，下一支测 Esc 分层的探针打开文件时弹窗又出现了，而模态排在 settings/zen 之前，那些断言就被模态吃掉（报成产品红，其实产品是对的）。⇒ 多条探针共用一份持久化偏好时，**终态按整套算，不按每一支开场的快照算**，并且**测分层行为前先清场，把清场本身写成一个断言**。同族陷阱：**再点一次已打开的同一行不会重新触发一次性判定**，换文件或用 `.file-label` 的 title 比对后再点。
45. **"菜单有这一项" ≠ "这一项有落脚点"**（§5.107，反馈 6 的真凶形态）：口上项目面板的右键菜单能把草稿指向项目根，但行内命名框只在 `renderDir` 里产出，而 `renderDir` 从不为项目根跑 ⇒ 点击只是往 state 写了个 draft。规矩：加菜单落点时**同时确认该作用域有渲染槽位**；建完的东西还要**看得见**（盘上有、面上无，用户读来仍是"点了没生效"——只修槽位等于修了一半）。
46. **Monaco 的波浪线不在 `.view-line` 里，DOM 判据得换坐标系**（§5.109）：装饰画在独立 overlay 层，`squiggly-error.closest(".view-line")` **恒为 null** ⇒ 看起来像"波浪线没绑到那一行"，实际是选错祖先。规矩：拿 squiggle 的**矩形**与各 `.view-line` 的矩形按 `top` 差最小反查归属；且 `.view-lines` 是**虚拟化的**（屏外行不在 DOM 里），"行数"只能当"可见行"读，别拿它当缓冲长度。
47. **Monaco 用 U+00A0 呈现前导空白；壳还会恢复上次会话的脏标签**（§5.109）：把 `.view-line` 的 `textContent` 直接当判据，`includes("  IF")` 会**假失败**（读到的是 nbsp）⇒ 先 `.replace(/\u00a0/g, " ")` 再比。⚠ **2026-10-13 HK-10 批再踩一次，这次是"内部空格"**：Monaco 把整行**每一个**空格都渲染成 nbsp（不止前导）⇒ `startsWith("PRINT Y")` 同样假失败；更阴的是 `trim()` 会剥掉前导/末尾 nbsp，于是以标识符打头的查找（`trim().startsWith("IF")`）**照样命中**、把坑自己藏住——**取到行**能跑通就以为归一做了。规矩升级：任何对 `.view-line` 文本的匹配一律先过同一个归一函数。另一条同族：应用启动会把**上次会话未保存的标签**恢复回来，探针若按固定文件名开文件，屏上可能是**上一次失败实验留下的脏内容** ⇒ 探针文件用唯一名，并在断言前加一句"屏上就是盘上那份"的前置检查（这条能把"产品红"和"仪器红"分开）。
48. **标签的类是 `.editor-tab` / `.tab-dirty` / `.tab-close`，不是 `.tab`**（§5.113 首轮 8 红之一）：选择器写错时"关标签"**静默失败**，
   后面每一条"重开文件"量的都是同一个没关掉的实例 ⇒ 会读出与产品**相反**的结论（本轮差点把"关掉编辑器即恢复只读"报成缺陷）。
   规矩：涉及"关掉/重开"的断言，先断"标签数真的变了"，再断重开后的状态。
49. **口上项目面板：包行是 `.kp-artifact-btn`，`.kp-dir-btn` 只是包里的子目录**（§5.113）：只点后者永远等不到文件行；
   两级都是 caret 切换式（`▸` 才点，`▾` 绝不重复点，§九-39/43 同族）。另记一条：**Ctrl+P 快速打开不含工作区文件**（列表来自项目索引），
   验"工作区 ERB 恒可编辑"这条轴一只走口上项目面板或文件树。⚠ 清场不能一刀切：遗留标签**可能是别的 agent 的在制品** ⇒
   按标签 `title`（绝对路径）判：不属于本探针、且盘上还在的 ⇒ 放弃这一轮，不动它。
50. **判据本身可以错得让产品看起来有缺陷**（§5.115 → §5.116 实测改写）：给 7.14 加的"收起后文件行必须为 0"是**错的判据**——
   `FileTree.tsx:513` 的设计注释写得很清楚：**追加式，真实文件夹内容在上、ERB 平铺列表原地不动（无动画、不卸载）**。
   收起时该消失的只有 `.pkg-real` 那批行，平铺的 20 条 ERB **本来就该留着**（读数 31 → 20 → 31 是对的）。
   闭环写法：`.pkg-real` 计数 11 → 0 → 11，平铺计数恒定。
   另一半根因（§5.115 猜错的那半也记着）：真正的仪器问题是**点击前拿到的节点引用在重渲染后过期**，
   而 `filter.length === 0` 这个条件本轮实测**一直满足**（筛选框为空）——不要因为"渲染条件有两个"就先去猜第二个。
   还有：工具条「展开全部」之后包行**已经是展开态**（caret ▾、`.pkg-real` 已在 DOM），"只在 ▸ 时点击"这条规矩
   会让人一次都不点、然后去量一个旧引用。规矩：**先 dump 再决定点不点**（§九-39/43 同族），且断言前重新查询节点。
51. **Monaco 的菜单是 `position: fixed`，别用 `offsetParent` 判"可见"**（§5.117 HK-10）：Quick Fix 菜单挂在
   `.context-view monaco-component fixed …` 上 ⇒ 里面**真实那行** `.monaco-list-row.action` 的 `offsetParent`
   **恒为 null**。用 `offsetParent !== null && clientWidth > 0` 当"可见"过滤器，会把真行**滤掉**、
   留下一个 91px 宽的隐藏占位行（几何 5,5）；照着它点 = 点在空处，**菜单明明开着却"什么都没发生"**，
   读来像"动作没生效"。规矩：菜单行选择器收敛到 **`.context-view .monaco-list-row.action`**，
   可见性用**几何**（`w > 150 && h > 0`）判。同族一条：`.lightBulbWidget` 需**先 hover 再点**
   （鼠标先移开、再移回目标行，它才弹菜单），直接点它为空是驱动姿势问题、不是产品行为。
52. **UI harness 必须每次从同一处起步，否则两次 run 之间比聚合数是假绿**（§5.122）：`tools/ui-measure.mjs`
   从"app 当前状态"起步——第一次跑时壳在欢迎页，第二次跑时壳已停在项目视图，两个 run 覆盖的元素集不同
   （实测差 **45 个 13px 元素**），看起来像"UI 改动动了字号"，其实**本批零 font 声明**。规矩：harness 开头
   `await ev('location.reload()')` 回欢迎页再开量（本机壳重载即回欢迎页，实测 2ms）。修完连跑两次，
   逐状态分毫不差。**同族**：任何"前后对比"的探针，先自证"同一输入跑两次得同一输出"，再拿它量产品。

53. **判据"比同一个元素"就是空判据**（§5.123，两轮漏网的真凶）：`scrollHeight - clientHeight` 只有在元素**有固定高度**时才有意义；
   量一个由内容撑开的 `pre` 时它恒为 0，于是"尾部没被裁"一路绿灯——真正的比较对象是**内容高 vs 盒子高（两个不同元素）**。
   同族：§5.101 量的是"盒子高是行高的整数倍"（是，但内容每行多 1px 照样溢出）。
   规矩：写判据前先问"**这条判据在什么情况下会红**"；答不上来就换一条能证伪的（本仓 §5.116 也栽在同一类上）。
## 十、新会话动手清单

1. `cd <工作树> && pnpm install`（**绝对路径按主机而**：口上项目组主机 = `<工作树>`，
   本机 = `<工作树>`；bash 残缺时用 §八 的直调 node 方式）
2. `pnpm test && pnpm typecheck && pnpm audit:decoupling` —— **确认三项全绿**（基线：**1852 passed / 14 skipped（1866）**、105 文件过 / 8 跳 / 16 插件 / 审计 A/B/C/D 四项）**注意 typecheck 要 root + `packages/app` 双跑**；改了 Rust 再加 `cargo test --lib`（cwd = `packages/app/src-tauri`，**现 18 项全绿**（本表此前长期写 19：`eac536e`（§5.97）撤 `exportDirectory` 通道时连删 3 条用例，此后实为 16；§5.128 加 2 条 ⇒ 18。汇总行当时没跟着改）；本工作树没有 `target/`，首次是冷编译数分钟；新增 crate 需 `HTTPS_PROXY=<本机代理>`，与推送同一代理）
3. 读 `docs/IMPLEMENTATION-LOG.md`（§5.8–§5.130 全量批次记录）+ `docs/ARCHITECTURE.md` §1–§7 + 本文件 §二 / §六 / §十二；
   **并先扫一遍 §十三 跨主机协作看板**——`待认领` 的行是该动手的活，`已认领:<别线>` 的不要抢；
   §13.6 是"谁不动哪个文件"的边界表，有异议直接改那一行（改行即生效）
4. **本组当前三条主线**：
   - **体感丝滑线（本组主目标，性能）**：三段级联全部持久化（§5.58）→ 快照瘦身与卫生（§5.65）→
     抽取按文件增量（§5.70）→ 校验按文件增量（§5.72）→ **名称解析 memo（§5.73）**。
     真实语料当前水位（从 `project.open` 起算）：冷 索引 2.4s / 条件 9.8s / 校验 9.9s；
     **热（未改动）三段 ≈ 1.0s**；**改一个 ERB 后重开 ≈ 2.1s**（这一项曾 6.5s → 2.6s → 2.1s）。
     校验段已经不是瓶颈（§5.81 把这条问对了：touch 端到端 2085ms 里校验自计只占 ~660ms）。
     ⚠ **上面那组水位全部量自 vitest + node bridge 探针，已作废**——§5.90 在真实 `tauri dev`
     里复测：同一份语料热开 **6.4s / 10.5s / 10.6s**（index / 条件 / 校验），冷开条件段 **100s**。
     缓存机制本身成立（抽取自计 93,139ms → 29ms，快照 9.44MB 落盘并被读到），
     **但体感的钱在 IPC 通道上，不在快照解码上**。
     **#24 已由 §5.92 做完**（① `decode` 本地化；② 新增 `read_file_bytes_raw` 返回
     `ipc::Response`。⚠ 原先这里写的 `responseType:'arraybuffer'` 是**不存在的选项**——
     @tauri-apps/api 2.12.2 的 `InvokeOptions` 只有 `headers`，二进制响应由命令返回类型决定）。
     真实 app 当前水位（同机同语料，从 `project.open` 起算）：**热开 index 2.4s / 条件 3.2s / 校验 3.2s**；
     **冷开 index 2.5s / 条件 18.6s / 校验 14.1s**（本批之前分别是 6.4/10.5/10.6 与 条件 108）。
     **下一批首选 = #29，但方案已被 §5.110 的实测改过一半**：真实 app 页面内同一条 2,285 路径，
     `stat_file` **串行 6,750ms → 并发 64 只要 1,840ms（3.7 倍）**，读也类似（796 → 335ms）。
     ⇒ **先改调度，别加命令**：① `io.readText` 里 `readFileBytes` 与 `stat` 互不依赖，一次
     `Promise.all` 省一个 RTT（冷开 6,855 次读取全吃到）；② erb-parser 索引构建的 stat 循环
     **分窗并发**（复用内核现成 `runSliced`，不造新调度器）；③ 真要再降才轮到 `walk_dir` 带 mtime
     （2,285 次变 1 次，那才是契约 + Rust 面改动）。
     ⚠ 两个 stat 数都真且不等价：app 自计 `stat 1,970ms` 问的是"关键路径占比"，
     我 isolated 测的 6,750ms 问的是"独占成本"——决策取后者，别拿前者当上界。
     **验收口径 = 真实 app 的三个水位**，宿主层改动必须带 in-app 对照探针（§5.92 §六、§5.110 §二）。
     次选：#20 打字→保存→刷新（§5.89 量到回写侧 ~116ms 同步序列化）、#21 抽取上并行通道
     （前置 = `VariableSchema` 导出原始表，路线文档 §三 L1）、按角色分组判据
     （要先量"一次改动波及几个角色"的分布表，§5.71 教训）。
   - **口上项目线**（纪要 §5 清单）：P-A…P-E + T2 + T2.1 + T3 + T4 已通。
     **下一批首选 = 导出 ZIP（TS 层，用户 2026-10-12 拍板）**：
     ZIP 容器（local/central header + CRC32）在 TS 层做，压缩用平台
     `CompressionStream('deflate-raw')`；**不给 Rust 加 `zip` crate** ——
     Rust 定位是「只做 IO 原语、零业务逻辑」，ZIP 组装属业务逻辑。
     同批要接上：导出/部署时把 `.kojo` 自动转译为 `.erb`
     （经服务键 `WellKnownServices.SugarTranspile`，合法先例见 `ui-sugar-editor/src/index.ts`）。
     其后 = 项目区右键新建 · LICENSE 多协议 · 直连模式开关 · 中日对照。
   - **UI/UX 重设计线**（发版判据 ⑥）：P0–P4 **已全部入库**（P4 = 三容器拖拽停靠 + 全禅模式 +
     设置 overlay，`d871878`，记录见 §5.54）；P4 的**测试侧欠账已清**（§5.92：判据抽纯 + 65 项断言 +
     真实壳 19 项端到端读数）。判据 ⑥ 现余：**真实终端手工勾验**（需求定稿 `docs/UI-REDESIGN-2026-10-11.md` §200
     + `MANUAL-CHECKLIST` 五节 A–C 与新增 5.D），其中**中文输入法合成期的目视只能人做**（探针派的是合成事件）。
   - **不属于本组**：语法糖语义（`kojo-sugar` / `ui-sugar-*` / `.kojo` 转译高亮 / 糖视图）与
     解析索引性能 —— 归别组，见 §十二。**糖线 2026-10-12 起直接在 `master` 上推进**
     （`origin/syntax-sugar` 已删除、旧 tip 由本地 `backup/syntax-sugar-20261012` 持有，§5.64/§5.66/§5.67）；
     动这些模块前先 `git log -- <path>` 看糖线最近一批的读数口径。
5. 每完成一批：`pnpm test` 全绿 → Conventional Commits 提交 → `node tools/git-push.mjs`；**新批次编号用「日期 + 简称」，不再用 vX.Y 第N批（§十一 版本纪律）**；发版时走 §十一 的 tag 流程（首个发行版 = `v0.4.0-beta.1`，判据六项）。
   **解过 rebase/merge 冲突的批次，推送前必须 root + app 双 typecheck + 全仓冲突标记扫描**
   （§八 末行 / §5.55）；`tip 干净 ≠ 历史干净`——推送前对 `origin/master..master` 逐提交扫标记。
   **动手前先 `git fetch`**：本轮第一次 push 就是被 `(fetch first)` 拒了才发现远端已推进三条。

## 十一、版本纪律（2026-10-11 定，用户拍板）

> 背景：批次编号（`v0.2 第十三批` / `v1.1 第十六批` / `v0.3 S6`）是**开发里程碑名**，与 package.json 版本不成映射，双口径易混。本节声明分工，一次性消解。

1. **版本单一真源 = root `package.json` 的 `version` + git tag**。发版动作 = 改 root version → `git tag vX.Y.Z` → push（`--tags`）。子包（plugin-api / kernel / plugins / app）版本平时不再各自漂移，发版时随 root 统一提升即可（私仓不发 npm，子包版本仅内部标识）。
2. **历史批次编号定格为"历史里程碑名"**：文档中已写的 `v0.X 第N批` / `SN` 一律**保留不回改**（git 历史同理）；**新批次记录不再使用 `vX.Y 第N批` 编号**，改用日期 + 简称（例：「2026-10-12 保存路径推导批」）。
3. **首个发行版 = `v0.4.0-beta.1`**（用户拍板 2026-10-11；不做 v1.0.0，等闭环稳定后再转正）。**发版判据**（全部满足才打 tag）：
   - ① 保存路径推导接 `compileToFile` + 保存期全角空格阻断（`.kojo` 编辑→保存→真实游戏可跑的闭环成立）——**代码侧已闭环**（S7 数据层 §5.36 + S7-UI 接线 §5.37；`ui.editor.saveHandler` 槽 + 源保存/产物编译 + 全角空格告警三选），**实机输入已升级为全语法面发版样例**（§5.82：`fixtures/sugar/release-check.kojo` 353 行 → 产物 778 行 / 73 函数，覆盖率与结构平衡由 `sugar-releasecheck.transpile.test.ts` 机器守门），**余真实终端 `pnpm tauri dev` 手工勾验**（清单 §二 a–h + **i0–i3**）；
   - ② BUG-5 `file.changed` 真实监视器接线 + 去抖——**代码侧已闭环**（§5.84：Rust notify `start_watch`/`stop_watch` 原语 + 内核 `FileWatcherServiceImpl` 200ms 尾缘去抖 + 监视状态判级新事件 `file.watchState`；真实 `fs.watch` 端到端有 `watcher.realfs.test.ts`，`cargo test --lib` 12→17），**余真实终端勾验**（清单 §2.J：外部编辑器改一行 → 编辑器跟随、脏文件不覆盖、partial/unavailable 降级提示）；
   - ③ 桌面壳真实终端深度冒烟通过（§八 os error 231 欠账，需本机正常终端）；
   - ④ tauri 打包产物（NSIS/安装器）可在干净目录安装启动；
   - ⑤ README/用户文档最低集（安装、打开工程、`.kojo` 编辑编译保存、注入器安全提示）；
   - ⑥ **UI 新壳**（2026-10-11 用户拍板插入）：`docs/UI-REDESIGN-2026-10-11.md` 定稿的 P0–P4 全部完成 + 真实终端勾验——写权限闭环/五区布局/命令体系/多标签/💡升糖/拖拽停靠/全禅模式。
   判据未齐前 root version 保持 `0.1.0` 不动。
4. **SemVer 规则**（自 v0.4.0-beta.1 起）：major = 破坏存档/工程兼容；minor = 新能力（新语法糖块、新面板等）；patch = 修复。beta 阶段用 `v0.4.0-beta.N` 递增 N；转正 = 去掉 `-beta.N` 后缀发布 `v0.4.0`。

## 十二、小组分工与分支拓扑（2026-10-12 定，用户告知）

### 分工

| 线 | 归属 | 范围 |
| :-- | :-- | :-- |
| **整体项目推进 + UI 优化** | **本组（本机小组）** | 内核 / plugin-api 契约 / 宿主壳 / 面板与交互 / 口上项目线 / 发版 |
| 语法糖优化 | 别组（`syntax-sugar`） | `kojo-sugar` 转译语义、`.kojo` 高亮补全、糖视图、升糖口径 |
| 性能优化 | 别组（分支**尚未推上远端**，截至 2026-10-12） | 索引 / 解析耗时、tree-sitter 重做对照线 |

> 本组要动糖组或性能组边界内的文件时（例：契约加方法导致它们的测试假件必须补齐），
> 保持**最小机械改动**，不顺手改语义。

### 分支（用前先 `git fetch` 复核——分支尖端 decay 很快）

| 分支 | 归属 | 说明 |
| :-- | :-- | :-- |
| `master` | 本组主线 | 口上项目批 P-A…P-E 全在这条线上（`712a9f5`） |
| `ui-polish` | 本组 UI 线 | 2026-10-12 时点 **0 领先 / 8 落后 master**（空占位）。**UI 优化今后落这条还是继续走 master，尚未定，需问用户** |
| `syntax-sugar` | 别组（语法糖线） | **已 rebase 进 master 并删除远端分支**（2026-10-12，处置见 §5.64）。旧尖端 `fa9a18a` 由本地 `backup/syntax-sugar-20261012` 持有；**糖线今后直接在 master 上推进**，不再留长命分支 |

### 已知的跨组冲突面（**2026-10-12 已合流关闭**，留档供后来者判读）

按 merge-base 实测，`master` 与 `syntax-sugar` 真冲突热点 7 文件，其中 6 处机械性，
唯 **`packages/app/src/ui/EditorPane.tsx` 是语义分叉**：两组各自重做了「ERB 什么时候只读」
（本组按目录分野 / 糖组按 `ErbUnlockDialog` 显式解锁），且**糖分支尚未引入「工作区」概念**。
实际合流时热点扩到 **14 文件**（两组并行推进了 29 + 15 个提交），处置逐条记于 **§5.64**。

口径已由用户 2026-10-12 拍板并固化为 **[`adr/0005-erb-write-permission-and-sugar-view.md`](adr/0005-erb-write-permission-and-sugar-view.md)**：
两道正交轴 —— 分野定默认可写性，解锁只管「游戏目录里这一份、这一次」；
糖视图与可编辑态互斥（**工作区 ERB 恒可编辑 ⟹ 默认禁用糖视图**）。
合并时按 ADR 里的代码片段对齐，不要就地即兴裁决。

另：`plugin-api/src/events.ts` + `events.test.ts` 双方各自新增事件并各自 bump 白名单计数快照
（本组 `workspace.importRequested` / 糖组 `editor.sugarView.set`），属 `0bf2eb9` 那类双源漂移，
必冲突但好修 —— 合并后计数应为 **16**。

### 跨组须知（2026-10-13 凌晨增补 · 回放线重测批 §5.74）

给所有在这个 worktree / 这条 `master` 上并行的 agent，七件事（第 6 / 7 条均为后补）：

1. **小节号现状（取号前必读）**：`IMPLEMENTATION-LOG` 已用到 **§5.130**——
   §5.76 = UI 归一批、§5.77 = 导出批、§5.78 = 工作区新建条目批、§5.79 = 许可协议可选批、
   §5.80 = 三线合流批、§5.81 = 规则成本归位批（性能线）、§5.82 = 判据①发版样例批（糖线）、
   §5.83 = 设置页归一批（UI 线）、§5.84 = BUG-5 文件监视批（判据②）、
   §5.85 = 撞名诊断批（任务 20 收口）、§5.86 = 判据②补证批（Rust 侧监视投递）、
   §5.87 = 监视消费方批（上）、§5.88 = 落盘引导批（反馈 3）、§5.89 = 抽取快照 v4 批、
   §5.90 = 实机复测批（性能线）、§5.91 = 看板 HK-5 批（文件树目录失效通道 + 工作区进监视根）、
   §5.93 = 看板 HK-6 批（面板消费工作区外部改动 + 契约路径形态更正）、
   §5.94 = 看板 HK-7 批（外部改动重载改按 pathKey 判等）、
   **§5.95 = 看板 HK-2 批（全站宿主模态接上 Esc）**、**§5.96 = 实机复验批（CDP DOM 驱动收 QA-1②/9/10，零代码改动）**、
   §5.92 = IPC 读盘通道批（真实 app 热开 10.5s→3.2s）、§5.109 = ERB 波浪线批、§5.110 = 合流后 IO 通道摸底批、**§5.111 = 实机复验第五轮（清单 §六 7.1–7.7，零代码改动）**、**§5.114 = 批 N 数据表投影（糖线，第七把尺子）**。
   ⚠ 本表历史上只逐条列到 §5.96，**§5.97–§5.108 不再逐条登记**——取号一律以
   `grep -E "^### 5\." docs/IMPLEMENTATION-LOG.md | tail -1` 的现读值 +1 为准（本文件 §十二-1 的固定做法）；
   **（下面这段是历史行文，取号以本小节开头那条为准：新批次从 §5.131 起）**。**§5.97 = 看板 HK-3 批（`exportDirectory` 契约收缩）**、**§5.98 = 工具批（`git-push.mjs` 直连/代理交替试）**、**§5.99 = 看板 HK-4 批（编辑器工具条身份不许裁，CDP 量测挑活）**、**§5.100 = 看板 HK-4 第二轮（快速打开副行 + 全站裁剪扫描）**、**§5.101 = 实机复验批（QA-2 糖视图行高收口，零代码改动）**、**§5.102 = 看板 HK-4 第三轮（全站可访问性量测）**、**§5.103 = 实机复验批第三轮（fixture 游戏目录：QA-9 两半 + QA-10 五家收口）**、**§5.104 = 实机复验批第四轮（§2.J 判据②清单勾四格 + 修一条过期判据）**、**§5.105 = P4 补测批（壳层判据抽纯 + 合成期 Esc 门）**、**§5.106 = UI 反馈第一批（只读胶囊 / 折叠柄 / 展开反馈）**、**§5.107 = 实机复验轮（反馈 6 复验 + 口上项目面板新建链修复）**、**§5.108 = 探针选择器归一批（判据③ 自动化半边在 §5.106 之后整轮红，本机）**、**§5.109 = ERB 结构波浪线批（反馈 7 落地，qa 主机）**。**§5.112 = ERB 💡 一键补齐批**、**§5.113 = 实机复验第六轮**、**§5.114 = 批 N 数据表投影（糖线，第七把尺子）**、**§5.115 = 实机复验第七轮（qa 主机，零代码改动）**、**§5.116 = 实机复验第八轮（7.13/7.14 补收 + 判据修正）**、**§5.117 = HK-10 收口**、**§5.118 = HK-9 向导角色文案批**、**§5.119 = 仪器修正批（桌面壳冒烟三处假红；本组主机能跑实机半边）**、**§5.120 = 演出配色探针批（第二杠杆被否证 + §9-5 理由待更正）**、**§5.121 = 看板 HK-4 批（UI 系统化第一轮 · 字号尺度归一）**、**§5.122 = 看板 HK-4 批（UI 系统化第二轮 · 圆角与阴影 token 归一）**、**§5.123 = 目视体检批（qa 主机，+5 项）**、**§5.124 = UI 打磨批（状态栏计数收声，qa 主机）**、**§5.125 = 实机复验第十轮（清单 §5.E 机器半边）**、**§5.126 = 实机复验第十一轮（清单 7.30–7.33 部署半边）**、**§5.127 = 语法糖批 P（`空行` 写法，规范 v1.4）**、**§5.128 = 索引 stat 折叠批（性能线：热开 3.43s→1.60s）**、**§5.129 = 看板 HK-8 裁决批（常驻通知先丢 info；中断批盘点落库，见 §十二-7）**、**§5.130 = 抽取段分段剖面批（冷开读盘是大头、扫描已全走 worker ⇒ #21 结案）**。**新批次从 §5.131 起**。
   小节**物理顺序现已单调**（§5.73 → §5.74 → §5.75 → §5.76 … §5.130）：§5.74/§5.75 曾因让位改号被
   重排脚本挤到文末，§5.89 同批改回，并核对移动前后**行多重集只差空行**。
   **纪律一：改号只改标题行，不要搬整节**——要搬就用脚本，搬完必须比对行多重集。
   本节号 2026-10-13 一夜撞**五轮**（本组 §5.82→§5.86→§5.89 三连让位，另一组 §5.86/§5.87/§5.88 同刻抢占）。
   **纪律二（本批新增，血的教训）：取号之后、push 之前必须再 fetch 一次并重编号**——（§5.128 补：**它只压概率、不归零**：同一批连撞五轮，最后一次 fetch 距 push 只差几分钟。所以顺延要用**一个脚本**改完（手改必漏），fetch 要**单独成句看退出码**，别写 `cmd | tail || fallback`——管道会吞掉失败）——
   本批第三次 fetch 就在推送前几分钟，还是被人把 §5.88 抢走了；rebase 到 push 之间的十几分钟足够别人落地一节。
   固定做法：**提交前一刻**用
   `grep -n "^### " docs/IMPLEMENTATION-LOG.md | tail -1` 现取最大号 +1，别用记忆里的号；
   推送前再 `git fetch` 复核一次。旧提交信息里的号不回改，本节即映射表。
   **纪律三（§5.105/§5.106 新增，推送通道不通时适用）**：github 443 打不通时只能离线取"当时最大号 +1"，
   而别人在这几十分钟里能落**一整批**（实测远端一次推进 20 个提交、§5.92–§5.104 全被占）⇒ 本组两节连撞两次
   （§5.71→§5.92→**§5.105**、§5.72→§5.93→**§5.106**）。规矩：① 正文留**取号记位链**（旧号 → 每次让位原因 → 终号），
   提交信息里的旧号不回改；② rebase 后必须把新节**移到文件末尾并核对物理顺序单调**——
   自动合并会按旧位置插入，出现 §5.93 落在 §5.82 之前这种乱序（本轮就撞上过一次，用脚本搬回并比对行多重集）；
   ③ 解完冲突用 `^(<<<<<<<|=======|>>>>>>>)( |$)` 扫全仓（**带后缀的标记也要抓到**，见 §九-42）。
2. **存档库位置（用户 2026-10-13 定）**：六份原始存档在 **`C:\Game\eratw-save\sav\`**
   （`global + save00–03 + save1000`，身份与 sha256 见 `BASELINES` §5；**不入库**）。
   ⚠ **不要把 `.sav` 放进真实语料目录** `C:\Game\<基线语料>\sav\`——那是作者的游戏目录，
   本仓硬约束是它**零写入**；复测一律走档案库或一次性副本（两条命令见 §五"回放线复测"）。
   另外金样本的档集已按真实清单钉死：`golden-roundtrip` 现在**缺档即红**，
   若你的分支还假设"六档 = save00–save05"，改统一到上面这组名字。
3. **推送（今晚直连完全不通，Clash 可用）**：
   `HTTPS_PROXY=<本机代理> HTTP_PROXY=<本机代理> GIT_TERMINAL_PROMPT=0 git push origin master`
   （`git fetch` 同理；`tools/git-push.mjs` 仍是 6 轮全败）。
   ⚠ 共用 `master` 时 push 会把别人**未推的本地提交**一起带上去——本次 `b241764..2925cf7`
   就顺带发了别线的 `4ce63cd 度量批`（我已把它的小节让位到 §5.75 并在该节注明）。
   **推之前请先 `git log origin/master..HEAD --oneline` 看清要带谁**；判成功比
   `git rev-list --count origin/master..HEAD`，别看管道退出码。
4. **回放线现在有实机证据了**：§5 / §6 已逐字复现（未知率 32.0%、exact 836 全中），
   所以**动 `erb-parser` / `condition-extractor` / `state-replay` / `sav-parser` 的批，
   验收必须带上 §5.74 的那两条命令**——§5.64 那轮"只守糖投影读数"不要重演。
5. **Rust 侧改动的两条本机实况**（§5.84）：① `packages/app/src-tauri/target/` **不在工作树里**，
   `cargo test --lib` 首次是**冷编译（数分钟）**，别按"秒级"规划收尾；② `cargo add` / `cargo fetch`
   与 git 走**同一个代理**（`HTTPS_PROXY=<本机代理> HTTP_PROXY=<本机代理>`），
   crates.io 直连同样不通。新增 crate 会进 `Cargo.lock` ⇒ **必须一并提交**，否则别线拉下来构建不出来。
6. **同一台主机上也可能有第二个写者**（2026-10-13 凌晨实测事故，涉及 `<工作树>`）：
   本组一次 `git stash push -u`（为了给 `master` 让出快进空间）卷走了当时正被并行编辑的
   `docs/ARCHITECTURE.md` / `docs/USER-GUIDE.md`，几秒后那两个文件又被写回**另一版**内容
   ——即同一工作树里存在并发写者，且它不走 git。处置：
   被卷走的那版已落成补丁 **`.git/concurrent-docs-wip-2026-10-13.patch`**（551 行，只含 docs），
   stash 条目 `stash@{0}（On master: feedback3-wip-2026-10-13）` 原地未动，谁需要都能取回。
   **今后纪律**：① 并行 agent 一律各开一个 `git worktree`（本组反馈 3 批起在
   `<临时工作树>`，`pnpm install` 走本地 store 实测 **8 秒**，不是负担）；
   ② **共用工作树里禁止 bare `git stash` / `stash pop`**——它会连带回滚别人的未提交改动；
   ③ 提交只 `git add` 自己动过的路径，从不 `git add -A`。

7. **中断批盘点（2026-10-13 傍晚，用户指派移交 · 本机新会话）**：上一个会话被中断，在两条工作树上留下未推送 / 未提交的在制品。
   清点、复跑与落库步骤全在这里——**谁先接手谁落库**，落完按 §13.3 在对应行回执。

   **① HK-8 裁决批（通知队列淘汰规则）—— 已落库（2026-10-13 晚推送，`ddc06f4..29505d8`）**（`<工作树>` 工作树）：
   - 本批：`ui/notice-queue.ts`（新，纯函数）、`tests/notice-queue.test.ts`（+6 项）、`NotificationCenter.tsx`（换一行调用）、
     HANDOFF HK-8 行、LOG 节（已让位 **§5.120 → §5.127 → §5.129**，取号记位链写在节首）。
   - 盘点复跑（本机 2026-10-13 18:21–18:3x）：`vitest run` **1838 passed / 14 skipped**、根 + `@kojo/app` 双 typecheck `exit 0`、
     `node tools/audit-decoupling.mjs` A–D 全绿 —— 与 §5.129 §四 的声称**逐条一致**。
   - 落库步骤（提交已做，自 rebase 起）：rebase 到 origin/master（盘点时本树落后 **13 个提交**，推送前复核时已 **20 个**）→ 按 §十二-1 纪律二 `fetch` 复核取号
     （**已做：§5.127 = 语法糖批 P、§5.128 = 索引 stat 折叠批先后落库 ⇒ 二次让位至 §5.129**）→ 复跑上列三闸（读数按 rebase 后实测校准，先例 §5.121 的校准提交）→ push → 回填。
   - **落库完成（2026-10-13 晚，本条即回填记录）**：rebase 到 `ddc06f4`（冲突解：LOG 尾段并序 + HANDOFF 三处取并集，全仓扫 `^(<<<<<<<|=======|>>>>>>>)( |$)` 零残留）→ 复跑三闸：vitest **1850 passed / 14 skipped（1864）**、根 + `@kojo/app` 双 typecheck `exit 0`、审计 A–D 全绿 → push `ddc06f4..29505d8`（fetch 复核后 §5.129 未被再占；`git rev-list --count origin/master..HEAD` = 0）。
   - ⚠ 解冲突时凡见「§5.120」旧号别改回——旧号在远端另有其主（演出配色探针批）。

   **② 同树小改：向导文案再对齐**（`new-project-wizard.ts` + 测试 2 文件）：下拉文案缩短、警告语与 `deploy.ts` 拒绝原因同词、
   提示换 `.wizard-warn`。**已随批提交并推送（2026-10-13 晚）：取「带」路，`MANUAL-CHECKLIST` §六 7.2 引文已同步**——落库记录见 LOG **§5.129 §五**。

   **③ HK-4 第三轮图标系统（在制品）—— `临时工作树` worktree（分支 `fb3-landing`）未提交**：
   新增 `packages/app/src/ui/icons.tsx`（16×16 单色 `currentColor` 注册表，未命中按字形回落 ⇒ 兼容第三方贡献的单字符 icon）+
   16 个文件迁移（壳层 + 9 个插件文件、23 处 `<Icon>`；`⚙ ◧ ⬓ ⟳ ▸ ▾ ✕` 这些"当图标用的符号字符"在 `app/src/ui` 已归零）+
   `styles.css`（`.icon` / `.icon-glyph` 基类）+ `tools/ui-measure.mjs` 新增第 7 项量测（`glyphTexts` / `svgIcons`，目标随迁移单调降到 0）。
   盘点验过：`@kojo/app` typecheck `exit 0`。**欠**：ui-measure 前后对照实测（要真壳）、入册（工具注释里预写的 §5.123 已被占，落库改号）、提交推送。
   它与 ① 同碰 `NotificationCenter.tsx`（改的是不同区域：图标 vs 队列调用），合流无风险，但要一起跑闸。
   ⚠ 该 worktree 里只 `git add` 自己动过的路径，绝不 stash / reset（同第 6 条纪律）。

   **④ stash 实体摘要**（`stash@{0} · feedback3-wip-2026-10-13`，原地未动，第 6 条已记）：主体是反馈 3 早期方案——
   代码部分**已被 §5.88 以另一形态取代**（`workspace.projectCreated` 进了契约；`WellKnownOverlays` 方案与审计 A 项冲突、
   实落为 adapter 侧 `NEW_KOJO_PROJECT_OVERLAY_ID` 常量——**别按旧方案原样复用**）。**独有可复用的一件**：
   OS 级应用图标的 PNG 驱动生成器（`generate-icons.mjs` 自带 PNG 解码 + 预乘 alpha 缩放，`icon.ico` 重生成 313398B）+
   未跟踪区里的源图 **`app-icon.png`（48757B）**——取用：`git checkout stash@{0} -- packages/app/src-tauri/icons/`，
   或 `git show stash@{0}^3:packages/app/src-tauri/icons/app-icon.png > app-icon.png`。`.git/concurrent-docs-wip-2026-10-13.patch` 同第 6 条，不动。

## 十三、跨主机协作看板（2026-10-13 定，用户指派）

### 13.1 为什么单开一节

用户 2026-10-13 指定：**另一台主机上有一个具备完整实机能力的 agent**，它会持续认领
我们写进文档里的测试工作；它在文档里提交的反馈，由我们认领并落地；两边的分工方案本身
也要求"在文档里谈完"。两边不共享终端、不共享内存，**唯一交接面就是这套文档**——
所以看板必须做到：任务写得让对方**不用回来问**、认领状态**不会撞车**、
回执落点**固定到一眼找得着**。

### 13.2 两条线的分工与能力边界

| 线 | 主机 / 路径 | 观测到的能力（**按主机而定，不符请直接改这张表**） | 归它做 |
| :-- | :-- | :-- | :-- |
| **本组（本机）** | `<工作树>`（批间切换 worktree，见 §十二-6） | 代码 / 单测 / typecheck / 审计 A–D / `vite build` / `cargo test --lib`（`target/` 已预热，增量秒级）/ **桌面壳可起可目视**（§5.79 起做过三次），**且 2026-10-13 起接上 CDP DOM 驱动**（`--remote-debugging-port=9222` + `Runtime.evaluate`，配方四条见 §5.96 首节；坐标驱动作废） | 功能实现、契约演进、UI 打磨、消化实机反馈、维护看板 |
| **实机线（QA 主机）** | `<工作树>` | **2026-10-13 已由本主机自证**：桌面壳可起（`pnpm --filter @kojo/app tauri dev`，复用 `<工作树>` 的 `CARGO_TARGET_DIR` 增量秒级），且 **CDP 9222 + `Runtime.evaluate` DOM 驱动可用**（§5.105 / §5.106 两批的 19 项与 22 项断言都在这里跑的，含 Monaco 输入、拖拽、右键菜单）；工作树 = **`<本机目录>\master-kojo-editor`**（`<工作树>` 是同源旧副本，只借 cargo target，不在里面改文件）；cargo 冷编译仍要数分钟（本树无 `target/`）

**第三条工作树实况（2026-10-13，§5.119 自证）**：`<本机目录>\master-kojo-editor`（主线副本）
**也能起真壳并跑 CDP**——cargo 增量 20.23s、CDP 9222 通、欢迎页 `rootChildren=1` 实测渲染。
⇒ QA-4 / QA-5 / QA-8 / QA-14 以及判据③/①的实机半边**不是"只能等别机"**，谁先跑谁署名。
⚠ 同一棵树里存在**第二个并发写者**（本次撞上：`lexer.ts / parser.ts / keywords.ts / codegen.ts /
project.ts` 有未提交改动）。在那儿干活的纪律：只 `git add` 自己动过的路径、**绝不 stash / reset**；
需要 rebase 时走临时 worktree（§5.119 就是这么推的：`git worktree add` 到 origin/master
→ `cherry-pick` → `git push origin HEAD:master` → 删 worktree，全程不碰那棵树的工作区）。

**这张表刻意写成"观测"而不是"判决"**：分工错了会让任务派到没有能力的一方，比不派更糟。
**能自己验的就自己验**（两边都不是"实机"的唯一责任人）；只有本机确实做不到的，才登记成对方任务。
判据②（发版）的人工清单（`MANUAL-CHECKLIST` §2.I / §2.J）是**共同验收面**：谁跑谁在行尾署主机名。

### 13.3 认领协议（两边都按这个走，不一致就按本节改）

1. **看板只此一处**（§13.4）。别在 commit message、日志或聊天里派活——那些不进未来会话的上下文。
2. **一行一任务**，字段固定：`ID | 任务 | 判据（怎么算过）| 执行人 | 状态 | 回执`。
   - `执行人` ∈ `本机`（本组）/ `qa`（实机线）/ `待认领`；
   - `状态` 流转：`待认领` → `已认领:<线> <YYYY-MM-DD>` → `完成` / `阻塞:<一句话>`；
   - **认领 = 编辑该行 → 立刻提交推送**（先到先得；后推的人 rebase，**别改别人的行**）。
3. **任务必须自带判据**：写清"验什么、屏上看到什么算过"；能复制命令就把命令写全
   （含 `HTTPS_PROXY`、含语料路径）。没有判据的任务等于让对方回来问，是要不得的。
4. **回执写在同一行**；一行放不下就写进 `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md` 对应小节，
   行内留指针。报"红"请带：**现象 + 复现步骤 + 期望 vs 实际 + 屏上原样文案**；
   截图存一次性目录即可，**不入库**（仓内不放二进制噪声，历史一致）。
5. **跑测试前先对齐基线口径**：跨主机的 `skipped` 数**不必相等**（存档在位就会变 passed，
   见 §5.84 自记）——比对按各批自记的 `passed` 数，别拿 skipped 当异常报。
6. 做完不删行：状态改 `完成` 留档；判据收口口径回写 `HANDOFF §二`。
7. **本节与 §二 冲突时以 §二 为准**（§二 是"当前状态 30 秒版"，本节的任务表比它新）。

### 13.4 任务表

#### A. 交给实机线（QA 主机）——本组批次欠的实机半边

| ID | 任务 | 判据（怎么算过） | 执行人 | 状态 | 回执 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| QA-1 | **反馈 3 新建口上文件向导**（§5.88）三条落盘路径 | ① 无口上项目时按 Ctrl+N：屏上出现「还没有口上项目…」引导，按钮从左到右 = `取消` / `选择文件夹另存…` / **`新建口上项目并创建`(primary)**；② 点主选 → 填项目 → 创建后**新项目包里自动出现** `M_KOJO_K{n}_家族.kojo` 并在编辑器里打开；③ 走 ② 之前**取消**项目向导，之后从面板「＋ 新建」正常建项目 ⇒ 新包里**不得**冒出刚才那份文件；④ 已有项目时落点行显示工作区路径（不再需要游戏目录写权限） | 本机 | **完成（四条全过）** | ①③④ + a1 第一拍 + 落盘字节口径 = §5.91（坐标驱动，真壳目视）；**② 由 §5.96 用 CDP DOM 驱动验成**：空工作区 → Ctrl+N → 主选 → 填向导 → `创建项目` ⇒ 新包里自动出现 `M_KOJO_K0.kojo`（BOM+LF，与脚手架 8 空壳并列）、成为活动标签、建开即干净、无失败重开提示。**坐标驱动本不可信**（§5.91 那条 ⚠ 是误关遮罩，已撤销）——以后这类流程请直接用 CDP（配方在 §5.96 首节） |
| QA-2 | **糖视图行高对齐像素复核**（§5.76 遗留：只有源码级证据） | 开语法糖视图（Ctrl+Alt+T）对照原 ERB 行：糖投影每行与原文件同 `lineHeight`，无累积漂移；`--sugar-lh` 实测值 = 19px（fontSize 14 × 1.35） | 本机 | **完成（§5.101）** | 这条是**可数的**，不是观感 ⇒ 不必排队等别机。CDP 实测（真实语料 463 行 → 糖 349 行）：两种模式 `.view-line` computed `lineHeight` 均 **19px**；糖模式 24 个 ViewZone 高度 = {285, 57, 380, 0} = **15/3/20×19 与 0**，偏离"行高整数倍"最大值 **0px** ⇒ 无累积漂移。**判据本身要修两处**：① 糖正文住在 ViewZone 里，拿"相邻行 top 差恒定"当判据会因 zone 占位报出假缺陷，正确形式是"zone 高度为行高整数倍"；② `--sugar-lh` 不在 `:root` 也不在 `.editor-body`，而是宿主落在 **zone 元素自己**上（`EditorPane.tsx:506`）——去读 `:root` 会得到空串并误判"变量没生效"。另记一条观察：有一个 0 高度 zone，不影响对齐，无第二条证据，不当缺陷报 |
| QA-3 | **部署 `.kojo → .ERB` 真实落盘 + 引擎读得到**（§5.77 只有单元级证据） | 工作区一个含 `.kojo` 的包 → 「部署」到游戏目录角色口上目录 → 落盘是 `.ERB`（**无 `.kojo` 残留**）、编码 Shift-JIS/CRLF 合规、游戏里实际读出台词；同包重复部署 → 报「目标已存在，未覆盖」且不写半个字节 | qa | **拆成两半**（§5.103） | **前一半本组能自验**：§5.103 的 fixture 配方（`%TEMP%` 下一个 6KB 假游戏目录，`detect` 只需 `ERB/口上・メッセージ関連` + `CSV/Chara/Chara<N>*.csv`）可以随便部署进去，验"落盘是 .ERB / 无 .kojo 残留 / 重复部署不覆盖且不写半字节"；**"Emuera 真读出台词"那一半仍需真引擎真目录，留别机**。别机跑时可直接照 §5.103 造 fixture，不必动自己的真实语料 |
| QA-4 | **ZIP 导出在 Windows 资源管理器里可解压**（§5.77 用 .NET 交叉验过，缺真人双击） | 「导出」选目录 → 得到 `.zip` → 资源管理器双击能开、中文名文件不乱码（若显示乱码请附 `unzip -l` 与本机的差别，两者判据不同） | qa | 待认领 | — |
| QA-5 | **新建项目向导许可下拉的观感复核**（§5.79 明记"未做实机视觉复核"） | 7 个协议选项在向导里不撑破卡片、选中项说明紧贴下方可读 | qa | 待认领 | — |
| QA-6 | **全站模态都没有 Esc 关闭**（已知缺陷，先取证再修） | 逐个试 5 家模态（设置 / 糖视图须知 / 写权限批准 / 保存冲突 / 未保存确认）按 Esc：记录哪些能关哪些不能；本组据此做宿主模态注册表（HK-2） | qa | **作废（不必取证）** | 本机：答案没有悬念（§5.80 已记"五家全都没有 Esc"），HK-2 直接做完了 ⇒ 取证改由 **QA-10** 承接（验"真按 Esc 退一层"的体感） |
| QA-10 | **Esc 退一层**（HK-2 / §5.95 的实机半边） | ① 逐家试：写权限批准 / 未保存确认 / **保存提醒（全角空格决策，§5.37——它不是磁盘冲突守卫，`EditorSaveWarning.kind` 只有 `fullwidth-space`）** / 糖视图须知 / ERB 解锁，按 Esc 都应关闭且**落在不写盘那一格**（写权限→保持只读徽章、未保存→标签还在且脏点仍在、保存提醒→一个字节都不写、糖视图→没开启、ERB→仍只读）；② 叠两层时一次 Esc 只退一层，第二次 Esc 才退到下一层；③ 没有模态时 Esc 仍照旧关向导 / 设置 / 退出写作模式，**不得变成没反应** | 本机 | **完成（5/5 家 + 层叠全过）** | 本机 §5.96（CDP DOM 驱动，键盘走 `Input.dispatchKeyEvent`，模态靠真脏缓冲区弹出）：**层叠**——写作模式为底层，分别叠 overlay 与模态，第一次 Esc 只关顶层、底层原样在（模态那层还断言到"标签没被关掉"），第二次 Esc 才退底层；**五家里的两家**——未保存确认、保存提醒（往工作区 `.kojo` 打进 U+3000 → 保存 → 弹「保存提醒」→ Esc：模态关、标签仍脏、盘上还是保存前内容）。**余三家请别机用人键补**：须知是一次性提示（本机偏好已记录，`loadSugarViewPrompted()` 短路）、ERB 解锁需要只读态上的真实编辑意图（注入没触发 `onDidAttemptReadOnlyEdit`）、写权限批准要往未批准路径保存（违反零写入，本组不做）。**后续（§5.103）余下三家全部补完 ⇒ 5/5**：用 fixture 游戏目录（可随便写的假 `個人口上`）——① 打开项目即弹「写权限确认」，Esc → 横幅 + 徽章落 **只读**；② 只读 ERB 上用可信点击 + `char` 键产生真实编辑意图 → 弹「ERB 只读保护」，Esc → 标签不脏、**盘上逐字节未变**；③ 须知是一次性的（`localStorage['kojo.ui.sugarView.prompted.v1']`），清掉标记重开 ERB 即弹「语法糖视图」，Esc → 屏上是**原文**、标记写回 `'1'`（= 真的落在"不用"那一格，不是只关窗）。三家都在本机、真键盘语义（CDP `Input.dispatchKeyEvent`）下过 |
| QA-7 | BUG-5 文件监视人工清单 **§2.J j1–j9** | 见 `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md` §2.J 逐条（判据②实机半边，§5.84 自留） | qa（余 j3 动作按钮 / j7 / j8 / j9） | **部分完成（本机，§5.104）** | 本机 2026-10-13 用 fixture 工程（§5.103 配方）自验并勾掉 **j1 · j2 · j4 · j5**（j2 状态栏原文就是「已从磁盘重新加载（文件在外部被修改）」，外部改动 306ms 跟上；j4 自身保存零回声）。**⚠ j6 的判据本身过期**——HK-5/HK-6 落地后文件树**会**自动出现新文件（实测 825ms 上树 / 824ms 消失），清单原文"不会自动出现"已按新口径改写：文件树自动 = 通过、函数树与包计数不跟 = 已知边界（HK-1 余量），两边都别再把工作正常的行为报成缺陷。**留给别机**：j3 通知上的动作按钮「重新加载（放弃我的修改）」（本组没能把缓冲区弄脏，不猜它能不能用）、j2 的光标/撤销栈保留（一格 Ctrl+Z）、j7（要改源码塞个不存在的监视根，与 §九-34 冲突，得单独一批停壳来做）、j8/j9（零存档 + 无拔盘条件）。 |
| QA-8 | 判据①发版样例人工清单 **§2.I（a–i3）** | 见同一份清单（§5.82 立的判据①半边） | qa | 待认领 | — |
| QA-9 | **文件树新文件自动出现**（HK-5 的实机半边；本组 `dirCache` 失效通道已落地）+ **口上项目面板同样自动重列**（HK-6，§5.93） | 在系统资源管理器里往项目目录丢一个 `.ERB` / 新建一个子目录 → 口上文件树**不重开项目**就该在数秒内出现它；已展开的节点折叠状态不得被打乱（这是"失效缓存但别丢展开态"的判据）；**并且**：展开一个包后在编辑器里 Ctrl+S，树**不得闪一下空白**（§5.91 专门修的那条）；同一次改动若落在工作区包里，「我的口上项目」面板展开的那个包也应自己更新（HK-6） | 本机 | **完成（两半都收）** | 本机 §5.96 验掉工作区这半：**外部**进程 `writeFileSync` 丢一个 `.kojo` 进已展开的包 → **零点击零刷新**、≤0.5s 上树；`unlinkSync` 删 → ≤0.5s 消失。顺带两条同链路实机证据：打开着的文件被外部删除 → toast 原文「…已在磁盘上被删除。编辑器里的内容现在是唯一副本——保存会重新创建该文件。」（§5.46 的"unlink 必须说"）；缓冲区脏 + 外部改动 → toast「…已在磁盘上被修改，但你有未保存的修改——保存会覆盖磁盘内容。」且标签保持脏、屏上仍是用户内容（conflict 分支不走 reload）。**剩下的游戏目录那半边仍要 fixture 工程**（真实语料零写入是硬约束，本组不会往 `C:\Game\…` 写一个字节）：按原建议造 `ERB/口上・メッセージ関連/个人口上/<角色>/<包>` + `csv/Chara*.csv` 的最小工程，随便写、验完删；折叠态被打乱这条本组没专门构造压力形状。**后续（§5.103）游戏目录半边也收了**：造 6KB fixture 游戏目录（真语料字节级复制 2 个 Chara CSV + 自造一个包），包展开状态下外部 `writeFileSync` 一个 `.ERB` → **825ms** 上树、`unlinkSync` → **824ms** 消失，期间角色组与包的展开态都保住 ⇒ **QA-9 两半完成**，真实语料仍 0 写入 |
| QA-11 | **UI 反馈 1/3/5/6 在第二次 rebase 后的真实壳复验**（§5.106 的实机半边） | 同口径断言重跑要**全绿**：只读胶囊文案＝「只读」且 `border-radius:999px`；工具条无「恢复只读」按钮； 糖段每段有折叠柄、点一下摘要里「已收起 N 行」真的减、再点回到原值（**可逆**）；文件树「展开全部 / 折叠全部」与根节点右键项双向可逆且有可读数；console 零异常 | qa | **完成（§5.107）** | 新基线上 **22 项全绿**（首轮 5 红全是仪器自己的：糖开关判据读文案而文案恒定 ⇒ 改读 `aria-pressed`；`.tree-note` 已被上游用作空目录行 ⇒ 本批读 `.tree-reveal-note`）。 关键读数：糖区 8 + 折叠柄 8、「语法糖 11 行｜已收起 14 行（可展开）」、点柄 14→13→14 可逆； 文件行 0→2733→0、反馈「已展开 135 个角色目录、193 个作者包」；胶囊 `radius=999px` / `color=rgb(209, 154, 102)`；工具条按钮只剩 `语法糖视图 | 保存 (Ctrl+S)`。 同轮另跑**合成期 Esc + 拖拽 20 项**与**合成期 Esc × 宿主模态 11 项**（= 清单 5.D-D9 的自动半边）全绿 |
| QA-12 | **反馈 6 的另一半边：口上项目面板的「右键 → 新建文件夹 → 行内命名框 → Enter」**（上游 §5.67 实现，用户报"点了没生效"） | 真实壳里走完这条链并**看到磁盘上真多出目录**：① 右键项目根 → 菜单含「新建文件夹」；② 点它 → 行内命名框出现（不是 window.prompt）； ③ 输入 + Enter → 树里出现该目录 **且** 盘上存在；④ 非法名拒绝并给中文原因、**不静默改名**；⑤ Esc 可取消草稿 | qa | **完成（§5.107）** | **复现成两条真缺陷并都修掉**：① 项目根从来没有行内框槽位（`draftRow` 只在 `renderDir` 里产出，`renderDir` 只跑包目录）⇒ 点菜单只写进 state，界面零变化； ② 建成功后也不可见（项目行只渲染 `workspace.json` 登记的包）⇒ 盘上有、面上无。 修 = `draftRow(pDir,1)` 槽位 + `looseProjectDirs` + 「包之外的目录 N 个」那一块，`renderEntry` 抽成共用渲染源；**+7 项单测钉挑法，16 项真实壳钉接线**（含磁盘侧独立核对与清场；语料 `find -newermt` 0 命中）。 非法名 `a/b` 实测原文「名称不能含这些字符：\ / : * ? " < > | 以及控制字符（Windows 文件系统限制）。」且名字留着不清空 |
| QA-13 | **口上项目 · 导出 · 部署人工清单 §六整节的实机半边**（本组 2026-10-13 活文档校准批新增，**两线都能跑**：本机 侧壳可起可目视，见 §13.2 ⇒ 谁先跑谁在行尾署主机名，不是"派给对方就完事"） | 逐条勾 `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md` §六 **7.1–7.33**；其中新建向导的三条落盘路径与 QA-1 同源，跑过 QA-1 的直接写「同 QA-1」不重复跑。⚠ 7.30–7.33 会往**真实语料的角色口上目录**新建包目录：跑前确认没有别的批在用同一份语料，验完删掉自己建的那个目录（守卫本就拒绝覆盖，同级作者包不得动）。红项按 §13.3 第 4 条报：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**——这批清单项是新写的，文案对不上时以屏上为准 | 待认领 | 部分完成:本机 2026-10-13 | **7.1–7.7 已收**（真壳 CDP 探针 + 磁盘侧独立核对，读数记 §5.111；顺手抓出"空壳带 BOM 会把 7.7 判成红"的仪器陷阱）；**7.8–7.12** 见 §5.107；**7.17 / 7.20** 见 §5.108；**7.D 整组（7.17–7.22）已由 §5.113 的 50 项 CDP 探针二次覆盖**（键盘走真实 `Input.dispatchKeyEvent`，含"只读态打字→解锁→丢弃修改→盘上字节未变"，7.21 ★★ 轴一首次拿到完整证据）。**§5.125（第十轮）已把 5.E 的机器半边收掉**：E1/E2/E3 的落点与悬停原文、E5 的"有红线照存且真落盘"、
  E6 的 52k 行按键回声 46/44/46ms 与新敲 `IF` 342ms 出红线、E7 的 `@"` 续行零误报（19 项全绿）；
  **E4 仍留真人**（"你自己天天改的那份打开该零红线"）。
  **7.15 / 7.16 / 7.23 / 7.28 / 7.29 由 §5.115 收到屏上证据**（7.28 含"转译在弹框之前"的时序与失败态原文；7.29 的产物名冲突原文已录；
  夹具进出对称，工作区目录回到原状、语料 0 改动）。⚠ **7.13 / 7.14 的"屏上标注"半边 §5.115 没收**（探针进不去 `.pkg-real`，
  按 §九-35 当仪器失败，不报产品缺陷；判据本体在 `file-tree.test.ts` 的 `visibleEntries`），下一轮的三条路见 §5.115 §五。
  **7.13 / 7.14 已在 §5.116 补收到屏上证据**（资源行「压缩包/资源，不在编辑器内打开」、附加文件行「不在口上索引内」、
  子目录 `没写的` 展开 10 条 ERB 无「（空目录）」、展开前后平铺 ERB 行数恒定）；**同时修正了 §5.115 那条错判据**
  （"收起后文件行应为 0"与 `FileTree.tsx:513` 的"追加式、平铺列表原地不动"设计相反）⇒ §九-50 已改写。
  **§5.126（第十一轮）把 7.30–7.33 也收了**：fixture 假游戏目录（**CSV 整份复制**，不碰真实语料）里
  15 项全绿——7.30 落点先显示 + 无口上目录当场说明且禁用；7.31 未批准写权限是前置闸门（fixture 零字节）；
  7.32 已存在 ⇒「不会覆盖」且既有内容逐字未变；7.33 落盘 10 个 `.ERB` 无 `.kojo`、工作区哈希未变。
  **余 7 项 = 7.24–7.27（4，要真系统保存对话框 + 真人双击 / 肉眼看乱码）
  + 7.16 注释覆盖率只做了抽样（1 面 1 函数）、7.13 / 7.14 / 7.15 的观感项（3，人眼）** |
| QA-14 | **ERB 结构波浪线人工清单 5.E（E1–E6）——本组能做的是"语料零误报"，做不了的是"人眼看着顺不顺"**（§5.109 落地后新增） | 逐条勾 `docs/MANUAL-CHECKLIST-v0.4.0-beta.1.md` §5.E：E1 删一条 `ENDIF` ⇒ 波浪线**落在那条 IF 上**、悬停原文含"缺 ENDIF"；
  E2 多余 `ENDIF` 落点正确；E3 孤立 `ELSE`/`CASE`/`CATCH` 报"不在它所属的块里"；**E4 是这条任务的价值所在**——
  拿一份**自己天天改的真实口上 ERB** 打开，屏上应当**一条红线都没有**；出现任何一条就把**屏上原文 + 那一段代码**贴回来（判据口径：错标比不标危险，误报优先处理）；
  E5 有红线照样能保存（波浪线不阻断写入）；E6 5 万行级文件输入不卡键（体检实测 23–29ms / 去抖 250ms） | 待认领 | 待认领 | — |

#### B. 本组认领（本机）——含从文档里接下来活

| ID | 任务 | 判据（怎么算过） | 执行人 | 状态 | 回执 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| HK-1 | **BUG-5 消费方接线**：外部改动自动跟随（§5.84 立的任务 21） | 归档列表自动重扫 = **§5.87 已收**；函数树/索引自动重建**归性能线**（§5.87 算过：全项目重建 ≈ 2.1s，不先做增量粒度就是"能自动刷但每次刷 2 秒"） | 本机 | 部分完成 → 移交性能线 | §5.87（上） · 余量见 §5.87「没收的那条」 |
| HK-5 | **FileTree `dirCache` 没有失效通道**（§5.87 明记"刻意留在下一批"，理由是本机跑不了 GUI ⇒ **正是本组的活**）：新建/外部新增的文件在树里不出现，除非重挂组件 | `dirCache` 加一条**外部可驱动的失效**（prop 或事件均可，但要穿到 `ProjectView → StableFileTree` 那层且不丢展开态）；实机半边挂 QA-9 | 本机 | **代码已推（§5.91）**·实机**已收（§5.96）** | 失效通道 = `refreshNonce`；另把**工作区根**加进了监视根（见 HK-6）。本组真壳自验跑的是反馈 3 那条链；**HK-5 自己的体感半边已由 §5.96 用 CDP 补上**（外部新增 ≤0.5s 上树、外部删除 ≤0.5s 消失、期间零点击零刷新）；"保存不闪白"本批覆盖到工作区面板那侧，游戏目录那半边随 QA-9 余量走 fixture 工程 |
| HK-6 | **工作区目录缓存的失效**（本批把工作区根纳入监视后新出现的期望）：`eratw-adapter` 面板的 `wsDirCache` 仍只被本插件自己的动作失效，外部改动（作者用别的编辑器改工作区、或从资源管理器拖文件进包）**不会**刷面板 | 面板订阅 `file.changed`，按 `isPathUnder(workspaces.rootDir(), ev.path)` 分野后**只失效受影响的目录**（照 §5.87 的首动作零 IO 口径）；实机半边同 QA-9 附一条 | 本机 | **完成（§5.93）**·实机已收（§5.96：外部新增/删除 ≤0.5s 自反映，零点击） | 判据 = "父目录要重列"；只重列已缓存的目录；重列不闪白、读失败保留旧内容只记日志 |
| HK-7 | **`EditorPane` 的外部改动重载用裸字符串判等**：`entriesRef.has(ev.path)`（:773）拿平台原样路径去查 io 路径建的表 | 判等改走 `pathKey()`（§5.93 已把这条义务写进 `FileChangedEvent.path` 的契约注释）；改完判据现成 = §2.J **j1**（外部改动跟随） | 本机 | **完成（§5.94）**·实机判据沿用 §2.J j1 | 新增 `matchOpenedPath()` 按 pathKey 找回宿主用的那个键；**不当 bug 报**（现网大概率恰好一致），但这条是防数据丢失的 B1 链路、静默失效没有症状。由 §5.93 的契约更正带出 |
| HK-2 | **宿主模态注册表 + Esc 关闭**（QA-6 取证后动手；`§5.80` 留的"全站模态没有 Esc"） | 五家模态 Esc 均可关，且与既有 Esc 优先级链（picker > overlay > zen）不冲突；新增第 6 家只需注册一行 | 本机 | **完成（§5.95）**·实机 = QA-10（**§5.96 已验 3/5 家 + 层叠全过**） | `ui/modal-stack.ts` 一个极小的栈；每家在接入处显式写出自己那一格（全是不写盘那一侧）；新增第 6 家 = 一行 `useModalEscape(...)` |
| HK-3 | **`exportDirectory` 已无 UI 调用方**（§5.77 被 ZIP 导出顶掉）：确认是否还有别线要用，再决定留契约还是删 | 全仓 `grep` 无生产调用方且别组无异议 → 契约收缩（删）；否则写明消费方 | 本机 | **完成（§5.97）** | 复核三条都指向"删"：master 零生产调用方、`origin/feat/ipc-read-channel` 命中数与 master 逐文件相同（= 只有定义链，没新增调用）、`origin/ui-polish` 一条都不含；纪要/backlog 无"导出成文件夹"的将来需求。**契约收回一条通道**（Rust 命令 + 助手 + 6 处替身 + 两层接口），并把那四条"对话框即授权"断言**移植**到活着的 `exportFile`（它此前在内核层零行为测试）。要恢复请照 `exportFile` 形态重新加，别恢复原码——这条不视为"别组需要它"的证据。 |
| HK-4 | **UI P4 继续打磨**（用户常任指派：专业 / 克制 / 流畅 / 高效 / 耐看） | 每批挑 1–2 处真实摩擦点，带截图级文案复核；风格与糖组并入部分统一 | 本机 | 进行中 | 反馈 3 批（§5.88）已含向导落点区；**§5.99 / §5.100 / §5.102 起改用 CDP 量测挑活**（不再靠主观）：① 编辑器工具条三处（文件名被尾部省略整个裁光 clipX 419px / 编码·换行·行数被挤到 clipX 52px / 「保存 (Ctrl+S)」折行把工具条撑到 50px）② 快速打开副行（14 行各裁 337–389px，最深一层目录不可见）③ **全站可访问性**（白字压 `--accent` **3.32:1**、主按钮里的快捷键芯片 **1.03:1 等于看不见**、`.small` 按钮族全 23px 高、`.tab-close` 17×17、dim 压选中行 3.48:1）——三批修完，**五状态扫描现在对比度 / 目标尺寸 / 可访问名全部为 0**；欢迎页 / 设置浮层 / 命令面板 / 写作模式三档视口零裁剪（负结果也留档）。**仍欠**：徽章族四套样式合并（波及 4 个插件，需单独一批配视觉复核）、工具条与状态栏编码信息重复（刻意不删）、树行中段截断（要保中段就得把口上命名知识带进宿主 UI，不做）、`×` 悬停才现（目标尺寸已补齐，"看不见就可点"要连触屏口径一起定）。**2026-10-13 早间用户重指派重心：打磨 UI，目标「专业 · 克制 · 流畅 · 高效 · 耐看」，以 VSCode 为基准，需定夺时优先采用现代编辑器现成方案。本组据此自拟六项并按序推进（每项都带一个可复跑的量化判据）：UI-1 字号尺度 ✅ §5.121 → UI-2 圆角/边框/阴影 ✅ §5.122 → UI-3 图标（emoji → 单色 SVG）→ UI-4 焦点环与键盘可达 → UI-5 动效可关 → UI-6 底部问题面板（状态栏 ✕//ℹ 现在无处展开，是最大功能缺口）**。**UI-3（图标系统）在制品**：`临时工作树` worktree 未提交（`ui/icons.tsx` + 17 文件；欠量测 / 入册 / 提交）——盘点与落库步骤见 §十二-7 |
| HK-8 | **口径讨论（不是缺陷）**：脏缓冲区 + 外部改动 → 现在只在**发现时**发一条 toast（「…保存会覆盖磁盘内容。」），作者随后按保存 = 直接覆盖磁盘（§5.96 实机看到的行为）。要不要在**按下保存那一刻**再确认一次？ | 裁决产出 = 一条写进 `IMPLEMENTATION-LOG` 的口径（改或不改都要写理由）。两条反对改的现成理由：①"工具不替作者做决定"，警告已经说过；② 每次覆盖前弹窗会把"我用别的工具改完再回这里存"变成三次点击。一条支持改的理由：警告与保存之间可能隔着几十分钟，作者早忘了。**本组倾向：不改行为，但把 toast 的可见性做硬**（它现在会自己消失——真正的静默风险在这里）。请别机从作者视角评一句 | 本机（裁决）+ 请 QA 侧意见 | **完成（裁决：不改保存行为）** | §5.129（中断批盘点落库：**已推送，`ddc06f4..29505d8`（2026-10-13 晚）**）。⚠ 本行原假设「toast 会自己消失」**被代码否证**：`error` 根本没有 TTL，消失来自同屏上限 `MAX_NOTICES` 不分 kind 丢最旧 ⇒ 已改成先丢 info（`notice-queue.ts` 纯函数 +6 项测试，那条常驻警告现在扛得住 10 条 info 刷屏）。QA 侧意见照旧欢迎，但按 §13.3 请**追加行**，别再改这一行。 |
| HK-9 | **向导的「目标角色」把 K0（master「你」）当成普通可选项**：§5.111 跑新建口上项目时，探针按「取下拉第一项」拿到 `#0 你`，包名就成了「探针作品甲-你 v1.0」。是真该允许（确有游戏把 K0 当真实角色用），还是该排除、或至少给出后果提示，**本批没有证据下判断 ⇒ 先登记、不当场改** | 作者选到 K0 时要么**明确说后果**（例如「K0 通常没有个人口上目录，部署会失败」），要么按 `charaIndex` 的真实可用性过滤——两条都行，但**不许默默删选项**；无论走哪条都要有测试 | 本机 | 完成 | §5.118（裁定=提示不过滤；证据：`CSV/Chara/Chara0.csv` 真存在且無 000 口上目录，168 表 vs 155 目录；+6 项测试含两条反向断言） |
| HK-10 | **💡 一键补齐（§5.112）的真实点击链没有在壳上验过**：纯函数闭环 + 槽接线两层都钉住了，但「光标落在波浪线行 → 按 💡 → 选中动作 → 补进一行 → 波浪线消失」这一段依赖 Monaco 的 action 菜单 DOM，本组从未成功驱动过它（§九-33 坐标驱动作废在前，不敢拿旧路数冒充证据） | 真实壳里：工作区 `.ERB` 故意少写 `ENDIF` ⇒ `.squiggly-error` 在场 → 打开 💡 菜单（Monaco 的 `.monaco-action-bar` / ghost 菜单节点，先 dump 再选，别猜类名）→ 点中「补上缺失的 ENDIF（放在第 N 行之前）」→ 断言 ① 缓冲区只多了那一行且缩进等于开块行 ② 波浪线数 -1 ③ 一次 `Ctrl+Z` 全部撤销 ④ **盘上字节未变**（未保存前不许落盘）；跑完丢弃修改、探针文件删除 | 本机 | **完成（四条全过）** | §5.117。真壳 CDP 全链（本组 worktree `kojo-hk10` 隔离，未碰别 agent 在制品）：工作区探针 `.ERB`（7 行，`@`-边界前少一条 `ENDIF` ⇒ `.squiggly-error`=1）→ 点行造光标变化 → **真鼠标点 `.lightBulbWidget`（💡）** → 菜单（`.context-view`，header `Quick Fix`）唯一可点行「补上缺失的 ENDIF（放在第 5 行之前）」→ 点中 ⇒ ① **只多一行 `  ENDIF`、缩进 = 开块行（2 空格）** ② 波浪线 **1→0** ③ 一次 `Ctrl+Z` 全复原 ④ **盘上 sha256 逐字节未变**（`d385f277…`；`dirty` 全程 false ⇒ 未保存前不落盘）。跑完丢弃修改、探针文件与夹具工作区已删、语料零写入。另记 §九-51（`offsetParent` 判可见会滤掉真行）+ §九-47 升级（Monaco 把整行每个空格都渲染成 nbsp）——**两条都是仪器坑、非产品缺陷** |
| HK-11 | **语法糖全中文化：系统函数名 + 指令表 + 数字脱敏**（用户 2026-10-13 指派；拖拽视图搁置后的第一优先）。① 系统函数名中文化——作者在条件/正文里可能写到的全大写英文（`GETBIT`/`FIRSTTIME`/`CHK_*`/`RAND`/系统 `CALL` 目标…）全部给中文糖形；② 指令表中文化——`时机 指令 310：` 升级为可用中文名（`时机 指令 摸屁股：`）；数据源 = **当前打开项目**的 `CSV/Train.csv`（引擎读取惯例 `TRAINNAME:编号`；270–299 = kojo_com 段；各版本/汉化/魔改自动跟随，**不内置打包**）；③ 能由工具查表/分配的数字不让作者手写（指令编号、事件编号等） | ① 纯中文重写：真实场景（`时机 指令 <中文名>：` + 条件 + 系统函数）写出 → 编译产物语义与 golden 一致，**作者全程零英文、零裸数字**；② 指令名补全/解析来自打开项目的 `Train.csv`（换项目即换表）；表里查不到的名字（魔改新指令）报「未命名指令（编号 N）」不猜；③ 旧写法（`指令 310`）兼容不破。现状盘点：关键字 17 个已中文（`kojo-sugar/src/keywords.ts`）+ 变量已中文（§3.8 她/你/角色12的好感度），缺口正是本条 ①②③ | 本机 | 待认领（② 的**数据源解析口径已实测**，见右） | 用户 2026-10-13 指派；语料实证 300=会話、310=摸屁股（`TRAINNAME` 用法见 `USERCOM.ERB`）。<br>**§5.120 追加实测（本机 `C:Game…<基线语料>`）**：`CSV/Train.csv` = UTF-8 **带 BOM**、**225 条条目 + 95 条 `;` 注释行**、无重号。<br>⚠ **解析铁律：编号取第一列，不是行号**——注释行穿插其间（数组下标 299/300/310 处实际是 `;706 胸愛撫(慰)` / `;707 玩弄乳頭(慰)` / `;745 肛用振動棒(慰)`，按行号取会整套错位），且 `;` 行本身带编号，**必须整行跳过**。<br>⚠ 本包里 **270–299 段为空**（kojo_com 自定义段靠 `USERCOM.ERB` 定义，不在 Train.csv 里）⇒ HK-12 的编号分配不能假设该段已有表项可读。<br>⇒ 换项目/换汉化包时表内容随文件变（符合"不内置打包"）；实现放 adapter（游戏知识），糖层只查表。 |
| HK-12 | **系统自定义函数糖化：作者可扩展钩子**（用户 2026-10-13 指派）。把系统给作者的"工具钩子"做成中文糖：① **自定义指令**五钩子（`KOJO{t}_COM_NAME/COM_ABLE/COM/CAN_COM/Counter不発_K{n}_{编号}`，270–299 段 + 内部编号）；② **自定义事件**（`CUSTOM_EVENT_K{n}_{i}`）；③ 自定义素质（`CUSTOM_TALENT`）；④ SHOP 按钮（`SHOP_BUTTON[_CONDITION]`）。**数字传参全由编辑器分配/管理**（编号自动递增、防撞车、可查表、改名不改号） | 「自定指令 赛钱：」→ 生成 NAME（`RESULTS = 赛钱`）/ABLE/本体 函数组，可选钩子按需；编号自动分配且与既有函数不撞；改名只动 RESULTS 值、编号不变；真实语料打开后自定指令出现在函数树/条件矩阵列 | 本机 | 待认领 | 用户 2026-10-13 指派；语料实证 ≥10 角色在用自定指令（灵梦 `COM_NAME_K1_1 = 求婚`、`= 除灵仪式`）；附录 C 的 25 个未覆盖入口里本条先做这四族 |
| HK-13 | **英文关键字语法糖封存（决策）**（用户 2026-10-13 拍板）。① 英文别名路径（§4.1 的 `timing`/`if`/`char`…、`CONT_MARKS` 的 `cont/continue`）冻结——不再新增、不再作为设计/测试/推广重点，**存量输入兼容不删**；② **"ERB→糖反解保真"不再是新糖设计的约束**（用户原话「现在又不需要 erb 文件转 kojo 文件」）：新糖按中文优先、编译单向设计 | 后续糖 PR 不再被"能反解回原写法/英文保真"堵住；§4.1 英文列不再增长；现有英文别名输入照旧生效（回归测试保留）；**防误读两处**：封存 ≠ 删代码；语法糖视图（ViewZone 投影）与升糖预览是**现行已发布功能，不属本条范围**——§8 表中"升糖=纯预览、不改写原文件"的既成结论不动 | 本机 | 决策已定（2026-10-13） | 用户 2026-10-13 拍板，为 HK-11/HK-12 解除设计约束 |
| HK-14 | **条件矩阵面板（独立面板）**（用户 2026-10-13 指派，替代被搁置的拖拽可视化视图）。给口上作者"参考填表"用的**状态 × 时机网格**：行 = 状态键（CFLAG/TALENT/TCVAR/MARK… 含作者私有状态，带中文标签如「CFLAG:318 生气中」），列 = 该角色的时机（系统时机 + **作者自定义时机**，即 HK-12 的自定指令/自定事件）；空白格 = 「这个时机还没对这条状态写过反应」，作者可据此补写 | 打开真实工程 → 面板出网格且**点格子跳对应源码行**；空白格视觉可辨；自定指令/自定事件出现在列里；布局与 `ui-snapshot-injector` 同构（**对象选择 → 定位 → 详情/编辑**三段式）；数据走已有 condition-extractor（`StateDependency`）不新造抽取；误报口径沿用"错标比不标危险" | 本机 | 待认领 | 用户 2026-10-13 指派；既有登记：`plugin-api/src/conditions.ts:56/224`（"条件矩阵主数据"）、HANDOFF §6.11（按角色/家族聚合 + MESSAGECHECK 位）、ARCHITECTURE:353（未立项）；数据已抽好（20 万 IF / 4.5 万 SELECTCASE 已结构化）。**同批决策**：拖拽式可视化创作视图**搁置，不做** |

### 13.5 反馈通道（QA 主机 → 本组）

QA 主机发现问题时**不需要**猜代码在哪：在本节 A 表下方追加一行
`QA-<n> | 现象一句话 | 复现步骤 | qa | 待认领 | —`，本组每次开工先读这张表。
本组消化完会在对应批次小节（`IMPLEMENTATION-LOG` §5.x）里写明"接了哪一行"。
**跨主机沟通只有这张表**——写在别处的反馈等于没写。

### 13.6 让位与边界（谁不动哪个文件；每条都写理由，不是客气）

同一晚两条线改同一小片热点，就是 §5.64 那 14 文件冲突面的雏形。凡是"这活儿我能力上能做、
但归你更该你做"的，一律在此写明：

| 事项 | 归属 | 本组的动作 | 理由 |
| :-- | :-- | :-- | :-- |
| **#24 IPC 通道修复**（`tauri-bridge.ts` 的 `decode` 改 `TextDecoder` / `arraybuffer` 过界 / 批量原语）——见 §5.90 第六节 | **性能线** | **不动** `packages/app/src/bridge/tauri-bridge.ts`；需要呈现层配合时本组接 `src/ui/*` | 这条链路的验收口径已被 §5.90 定为**真实 app 三个水位**，CDP 探针是他们刚建刚跑过的；换一手做同样改动等于把"量在用户跑的那条通道上"重新丢一次 |
| 函数树 / 索引增量重建（HK-1 余量） | **性能线** | 不动 `erb-parser` 的索引触发模型 | §5.87 已算过：全项目重建 ≈ 2.1s，未定增量粒度就接成事件触发 = 每次外部写入挂 2 秒主线程 |
| 宿主壳与面板（`src/ui/*`、`styles.css`、契约演进、口上项目线） | **本组** | 持续推进（HK-2/HK-3/HK-5/HK-6） | §十二 分工表 |
| 真实 app 体感与人工清单（§2.I / §2.J / QA-1…QA-9） | **谁跑得动谁跑** | 本组也在自验（§5.88 起） | 本组主机能起壳能目视但只有截图坐标；别机有 CDP 真探针——两条能力**不等价**，所以按"能验的各自验，行尾署主机名"，不设唯一责任人 |

> ⚠ 这张表由本组单方面写下（§5.91 批），**性能线与实机线如有异议请直接改**——
> 按 §13.3 的认领协议，改行即生效，不用回来问。
>
> ✅ **第一次裁决已被遵守**：#24 IPC 读盘通道由性能线自己做完并落 master（§5.92，
> 热开 10.5s → 3.2s / 冷开 108s → 18.6s），本组全程没碰 `tauri-bridge.ts`。
> 这条边界成立，故 §13.6 继续按"谁建尺子谁量"排。
