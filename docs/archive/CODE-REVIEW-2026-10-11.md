# 代码审阅（二）——增量审阅报告

- **日期**：2026-10-11
- **范围**：`8707ae6`（上轮审阅基线，v0.2 第十批）→ `HEAD`（e32a610），共 50 个提交，195 个文件，+35392/−660 行
- **方法**：与上轮一致——只读审阅；对照逆向文档与引擎源码验证语义；真实 eraTW 工程冒烟；审阅工具脚本仅写系统 TEMP
- **关联文档**：上轮报告 `CODE-REVIEW-2026-10-10.md`（本轮逐条验收其修复）

---

## 1. 验证基线（本轮实测）

| 项目 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 通过 |
| `pnpm audit:decoupling` | ✅ 16 个插件全部通过（插件间零交叉 import） |
| `pnpm vitest run`（含真实工程集成冒烟） | ✅ **1018/1018 通过**，63 个测试文件（较 HANDOFF 记录的 1012+6 skip 更进一步，无失败） |
| Rust `cargo test`（写允许域 9 项单测） | ✅（随 CI 覆盖；本轮复核测试断言逻辑正确） |

> 上轮报告中"typecheck 失败"与"golden-roundtrip 测试失败"均因当时 sav 写侧未提交；本轮写侧已提交并通过全部金样本验证，两处失败自然消除。

---

## 2. 上轮报告修复验收（全部通过）

| 上轮编号 | 修复提交 | 验收结论 |
| --- | --- | --- |
| **H1** CASE TO 区间 OR/AND 语义 | `9adae53` | ✅ **通过**。`branches.ts` 同行谓词按 AND 组成对消费（false 主导的 Kleene AND），组间 OR；`CASE 1, 240 TO 359, 5` 现正确折叠为 `v==1 ‖ (240≤v∧v≤359) ‖ v==5`；多区间连续 `TO`（`CASE 1 TO 3, 5 TO 7`）成对消费不会整段 AND 恒假，边界注释明确；附 7 项单测。仅依赖 extract 层"and 谓词逐部分顺序 push 且恒成对"的相邻性约定，建议在 plugin-api 契约注释中显式写明该约定 |
| **M1** stop 无级联停用 | `68c8c79` | ✅ 依赖闭包 BFS + 逆拓扑停用，stopAll 语义兼容 |
| **M2** 编码 had_errors 忽略 | `9adae53` | ✅ encode 侧 had_errors → 拒绝写盘（U+FFFD 无法再编码 → 损坏不落盘）；decode 侧只读放行 + 日志，权衡合理 |
| **M3** Rust 无第二道闸 | `a8e22e6` | ✅ 写允许域双闸落地：`canonicalize_deep`（最深已存在祖先 + 尾段）正确处理待建文件；`is_within` 组件级前缀 + 大小写折叠，防 `project`/`projec` 字符串误判；`..` 穿越、symlink 逃逸、未注册 fail-closed 均有测试；batch 17 做了真实 IPC 端到端双闸验证 |
| **M4** 切文件丢未保存内容 | `9adae53` | ✅ `dirtyPaths` 集合 + `requestOpenFile` guard + `UnsavedConfirmDialog` |
| **M5** 回放联动闭包陈旧 | `9adae53` | ✅ `runReplayRef` 每渲染更新 current；后续新组件（如 `writableRef`）也统一采用该模式，教训被吸收 |
| **L1** storage JSON.parse 无降级 | `9adae53` | ✅ 损坏文件降级为空记录并继续启动 |
| **L2** POWER 精度 | — | 判定为**误报**：`inInt64` 内 `Number.isSafeInteger` 对超 2^53 值恒 false → 返回 unknown，路径安全（复核确认） |
| **L3** 字符串比较语义 | `9adae53` | ✅ 驱动源已注明引擎默认 OrdinalIgnoreCase |
| **L4** state-view 注释与实现不一致 | `9adae53` | ✅ 已改为按真实语义记录（快照缺已知变量 → missing-var） |
| **L5** scanner TRY 宽泛开块 | `68c8c79` | ✅ 按引擎 funcMatch 表收敛为三档精确集合（TRYC\*→CATCH、TRY\*LIST→ENDFUNC、其余单行），并保留结构性核对 |
| **L6** family-index 锚点劫持 | `68c8c79` | ✅ 锚点语义显式化 + PLAIN_FACES 前缀校验防劫持 |
| **L7** 脏判定每击键全量比较 | `68c8c79` | ✅ 版本号 O(1) 比较 |

上轮 14 项发现全部闭环（12 修复 + 1 误报澄清 + L3 语义澄清），修复质量普遍高于"最小改动"——均补了回归测试且注释写明依据。

---

## 3. 新增模块审阅

### 3.1 sav 写侧（batch 11/13/16：writer / serialize / container / verify / inject）— 质量高

- **编码对称性**：`encodeInt` 与 `m_ReadInt` 严格互逆（负数走 Int16 不走单字节，与读侧非负语义一致）；`sevenBitUInt` 用乘除法避免 >2^31 位截断，与读侧同口径；`str` 代理对成对写回、孤立码元单写，无损往返。**同构性有硬实证**：save00 金样本 571,185 字节逐字节一致。
- **精度闭环**：`uniqueCode`/`gameVersion` 读侧存 BigInt 字符串、写侧转回 BigInt——无 2^53 精度损失（审查过此疑点，已排除）。数组 CellPatch 有 `isSafeInteger` 守卫，超界拒绝。
- **行驱动重编码**：2D/3D 游程（E0/F1/E1/F2/F0/FF）与金样本 cursor 证据（GMF_MAPNAME=[12,0]）一致；首行 dx=0 无标记、后续行按间距跳行——与引擎写侧行为吻合。
- **写盘编排（inject）安全语义完整**：Int64 守卫先于备份（守卫失败零副作用）→ 备份先于写盘 → 回读验证失败抛错且带备份路径。gzip 重压缩字节不同（mtime/压缩级）但解压语义等价，注释明确，且 batch 16 已做 appData 副本端到端真实验证。
- **verify**：重解析后标量值严格相等 + 补丁逐条下标比对，未落盘/类型不符显式报 mismatch。

### 3.2 kojo-sugar（S1–S7，约 6500 行 + 契约 1534 行）— 质量高

- **compile.ts（唯一 IO 点）**：六步安全顺序严格复刻注入器范式（守卫→ensureDir 过闸→备份→写盘→回读字节比对→源映射旁挂）；编码口径（BOM+LF+末尾换行）有语料实证，`\r\n`/`\r` 归一化正确避免 `\r\r\n`。
- **resolveFace fail-closed**：分野模板缺失即 `timing-face-unknown` 拒绝产出半成品，**绝不回退内建模板**——游戏知识不回流通用插件，架构铁律贯彻到位。
- **测试矩阵**：3200+ 行测试（transpile 763 / preview 605 / lift 599 / lift-apply 396 / compile 383 / golden 逐字节 / replayable / save-plan），golden fixture 覆盖规范 §3.3/§6.1/§6.2，lift 做 round-trip 自证。
- parser/lexer 未逐行细读（体量原因），由 golden 逐字节 + round-trip 测试兜底，风险可控。

### 3.3 第 11–16 插件与 kernel 变更 — 通过

- **ui-snapshot-injector**：两步确认（armed → 确认写盘）、预览 diff、面板只消费 `SnapshotWriteService` 不自建写逻辑、结果含备份位置——资金安全 UI 语义正确。
- **kernel**：事件白名单补全（10 事件，含 `ui.overlay.open/close`、`editor.activeFileChanged`）；`scopedBus` 违规恒 throw（`onViolation` 只做可观测性，不吞事件）——契约与实现一致。
- **eratw-adapter**：`writablePaths` 补入 sav 目录（修复了上轮未发现的"真实缺口"——此前只提议 personalKojo，存档注入无法获批）；`face-templates.ts` 按规范附录 C 全量登记。

### 3.4 app 层 UI 重设计（P0–P4）与 B1 — 通过

- 五区布局 / 命令面板 / 多标签 / CodeAction 结构清晰，`ShellLayout`/`commands.ts`/`Palette` 职责分明。
- **B1（外部写盘后重载）**：`decideExternalChange` 纯函数三态（noop/reload/conflict），外部写盘后静默替换或冲突提示，视图状态保留——处理正确。
- **SaveWarningDialog**：全角空格告警默认不阻断 + 一键替换半角，尊重作者本意。
- 多标签 + `dirtyPaths` + 关闭确认交互闭环（有他们自己的 P1–P3 审阅报告与 48 项补测兜底，本轮抽验未再发现问题）。

---

## 4. 本轮新发现（全部轻微/信息级，无高中危）

| # | 严重性 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| N1 | 轻微 | `kojo-sugar/compile.ts`（回读验证 catch） | 源映射旁挂回读失败时抛 `SugarCompileError`，但此时主 .erb 已落盘且验证通过，错误文案易让用户误判"全部失败" | 错误消息区分"主产物已写盘，仅源映射旁挂异常" |
| N2 | 信息 | `sav-parser/writer.ts`（游程写入） | 注入"值 0 到尾部零区"会写显式尾零（引擎写侧不写），产物比引擎自写多几个字节；读回语义等价，verify 可过 | 可选：写前对与既有值相同的补丁做"passthrough 保留"优化；不做也不影响正确性 |
| N3 | 信息 | `sav-parser/engine.ts`（inject） | read-modify-write 无并发锁；单用户桌面 + 单步确认 UI 下风险极低 | 未来若出现自动化批量注入（如多档批量打补丁），再引入互斥 |
| N4 | 建议 | `plugin-api/src/sugar.ts`（AND 折叠契约） | H1 修复依赖"and 谓词恒成对且顺序相邻"的隐式约定，契约注释尚未写明 | 在契约注释显式声明该不变量，防止未来 extract 实现变更破坏折叠语义 |

---

## 5. 总评

- 上轮报告的 14 项发现**全部闭环**，且修复方式（补测 + 注释依据 + 教训模式化复用）体现了良好的工程闭环习惯。
- 新增的写路径（sav 注入、sugar 编译）**全部复用同一套安全编排范式**（守卫先于副作用、备份先于写、回读验证、双闸放行），这是本轮最值得肯定的架构演进——高危操作收敛到经过验证的单一模式。
- fail-closed 原则（resolveFace 拒绝半成品、编码拒绝损坏、写允许域 fail-closed）在所有新模块中一致贯彻。
- 本轮未发现高/中危新问题；4 条轻微/信息级建议不阻塞 v0.4.0-beta.1。
- 审阅覆盖：修复验收全量；sav 写侧/注入器/sugar compile/codegen 关键路径细读；sugar parser/lexer 由测试矩阵兜底抽验；UI 插件与 app 层抽验（解耦审计 + 结构 + 高危交互）。sugar parser 内部转译细节的极限 case 依赖 golden 与 round-trip 测试，未做独立穷举验证，特此说明。

---

*审阅工具脚本（TRY 影响面扫描、语料统计）仅写入系统 TEMP 目录；本报告为唯一项目目录写操作，未触碰任何代码文件。*
