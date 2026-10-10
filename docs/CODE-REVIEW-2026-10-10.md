# kojo-editor 代码审阅报告（2026-10-10）

- **审阅对象**：`main` 分支已提交代码（commit `8707ae6`，v0.2 第十批）
- **审阅范围**：kernel、plugin-api、10 个插件、app（TS 前端 + Rust 宿主），对照逆向文档与引擎源码抽查语义正确性
- **审阅方式**：只读。未修改任何代码文件；未触碰开发中工作区（详见 §1.3）
- **补充验证**：全量测试、解耦审计、真实工程（K49 语料）冒烟数据复核、针对可疑点的临时脚本实测（脚本仅写入系统 TEMP）

---

## 1. 总体结论

**代码质量整体良好，架构纪律执行到位。** 写保护模型、二进制协议镜像、三值求值、内联解释器等核心难点实现正确；"不静默、不猜测、一切未知带原因"的哲学贯穿一致。发现 **1 个高严重性语义 bug**（CASE TO 区间被 OR 展开，语料影响 3136 处）和 5 个中等问题，其余为轻微卫生项与前瞻建议。

### 1.1 验证结果

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 全量测试 | 420 / 421 通过 | 唯一失败为 sav-parser 金样本回归测试，属**开发中工作区**（见 §1.3），非已提交代码回归 |
| `pnpm typecheck` | 失败 | 报错全部位于对方未提交的 `serialize.ts` / `writer.ts`，非已提交代码问题 |
| `pnpm audit:decoupling` | 通过 | 10 插件全部未越界依赖 plugin-api |
| 真实工程集成冒烟 | 与 HANDOFF 记录一致 | K49 回放：函数 1356、谓词 11685、未知 3741（32.0%）、exact 836 / partial 482 / unknown 38 |

### 1.2 亮点（值得保持的设计）

- **写保护端到端完整**：adapter 提议 → 用户显式批准（`WritableApprovalDialog`）→ 内核白名单校验（`assertWritable`）→ 写前备份（appDataDir 保留 20 版）→ Rust 原子写（同目录 tmp + rename，Windows 带 REPLACE_EXISTING 语义）。`paths.ts` 的 `normalize`/`isPathUnder` 语义正确（`..` 不逃出根、尾分隔符防 `C:\game2` 误判、win32 大小写折叠）。
- **编码探测策略正确**：BOM → 严格 UTF-8 校验 → Shift-JIS 兜底；写路径从磁盘重探测（`probeOnDisk`）而非按内容推断，保证"编辑不改编码"。
- **sav 二进制协议镜像**（binary.ts / parse.ts / gunzip.ts）：`m_ReadInt` 编码（≤0xCF 单字节 / 0xD0 Int16 / 0xD1 Int32 / 0xD2 Int64）、7-bit 长度前缀字节数语义、奇数字节校验、魔数 / 版本 1808 / 分区流 eof-eoc-separator / EM 扩展区，与《存档实战解析》逐条一致。
- **三值求值**（evaluate.ts）：Kleene 逻辑（&& 短路、!& NAND、!| NOR、^^ 传播）、BigInt 64 位位运算、C# 截断除法、字符串 ordinal 比较均正确。
- **有界内联解释器**（inline.ts，649 行）：预编译（IF 链栈配对、SIF 体校验、#DIM/#FUNCTIONS reject）+ PC 解释 + pendingEval 机制区分条件假跳转与自然掉落 + MAX_INLINE_DEPTH=8。设计精良。
- **缓存生命周期**：lineCache / InlineManager 的 resetCaches 正确挂接 `kojo.functionChanged` 与 `project.closed`。
- **约定校验规则全部有逆向实证**：4 条规则（KX 占位符 / 四件套 / FORM 三连符号 / MESSAGECHECK 位协议）均引用逆向文档章节并附实测数据（1546 处占位符、43 文件 `+++` 有意占位等），"宁可漏报不可误报"贯穿，报告粒度去重设计合理。
- **linter 引擎稳健**：单规则失败隔离进 `failedRules` 显式呈现、文件读取一次运行内记忆化、issue 去重排序。

### 1.3 开发中工作区（本报告不评、未触碰）

`git status` 显示以下未提交/未跟踪文件属另一位开发者的进行中工作（第十一批 sav 写侧）：

- `packages/plugins/sav-parser/src/serialize.ts`、`src/writer.ts`（未跟踪）
- `packages/plugins/sav-parser/tests/golden-roundtrip.test.ts`（未跟踪，import serialize.ts）

全量测试的唯一失败（`expected 571182 to be 571185`）与 typecheck 报错均源于此，属正常开发中间态，不构成已提交代码的回归。

---

## 2. 发现清单

### 高严重性

#### H1. `CASE a TO b` 区间被 OR 语义展开 —— 系统性分支误判

- **位置**：`condition-extractor/src/extract.ts` 的 `expandCase`（把 `CASE a TO b` 拆成两条同 line 谓词：`subject>=a`、`subject<=b`）；`state-replay/src/branches.ts` 链折叠时对同一行多条谓词取"任一为真即命中"（OR）。
- **问题**：TO 区间语义是 **AND**（`a <= v && v <= b`），OR 展开后 `v <= b` 单边即命中。例：`CASE 240 TO 359`（日時天候管理.ERB 的时间段判断）在 TIME=100 时被 `<=359` 误命中。
- **影响面（实测）**：`CASE TO` 在全部 3818 个 ERB 中出现 **3136 次**（对比 `CASE IS` 2263 次），集中在时间/天候/情绪等状态分档判断——这是口上分支走向的最高频语料之一。当前第九批交付物（分支走向、置信度徽章）在含 TO 区间的函数上**系统性失真**，且失真方向是"多命中"（unknown 被错报为 true），不会以 unknown 形式暴露。
- **修复方向**：`FunctionPredicate`（plugin-api 契约）增加 AND 组标记（如 `conjunction: 'or' | 'and'` 或 `groupId`）；extract.ts 的 `splitToRange` 给同组谓词打 AND 标记；branches.ts 折叠时同 line 先按组内 AND 归约、组间 OR。三处改动，向后兼容（无标记默认 OR）。

### 中严重性

#### M1. `runtime.stop()` 不级联停用依赖方（kernel/runtime.ts）

单独 `stop(A)` 时，依赖 A 服务键的插件 B 不会被级联停用，B 持有悬空服务引用。`stopAll` 的逆序停用缓解了正常关闭路径，但 v0.2 已提供单插件 stop 能力（插件状态面板可触发）。建议：stop(A) 前先拓扑计算依赖闭包，一并停用或直接拒绝（报告"有 N 个依赖方"）。

#### M2. Rust 宿主忽略编码 `had_errors`（app/src-tauri/src/lib.rs）

- `decode_bytes`：`enc.decode()` 的 `had_errors` 被丢弃——Shift-JIS 等非严格解码发生字节替换（→ U+FFFD）时前端无感知。
- `encode_string`：`enc.encode()` 的 `had_errors` 被丢弃——encoding_rs 对不可映射字符默认输出 **HTML numeric entity（`&#NNNN;`）**。用户往 Shift-JIS 口上文件粘贴简体字/Emoji 后保存，文件会被静默写入 `&#x604B;` 这类实体，**引擎读取为字面乱码**，属数据损坏。
- 建议：两个命令回传 `had_errors`；encode 侧遇错误直接返回 Err（调用方提示"内容含 Shift-JIS 无法表示的字符"）。

#### M3. Rust 命令无路径约束，写保护仅存一层（lib.rs）

写保护（白名单 + 备份 + 断言）全部在 JS 内核层；Rust 侧 `write_file_bytes` / `remove_file` / `rename_path` 接受任意绝对路径。正常 UI 流程受内核保护，但 WebView 内的依赖投毒 / XSS 场景下 IPC 面全量暴露，纵深防御缺第二道闸。建议：Rust 侧按当前 project root + appDataDir 建立写允许域（需在 open/close project 时同步），读可放宽。

#### M4. 编辑器切换文件不检查未保存更改（app/src/ui/App.tsx + EditorPane.tsx）

`openFile` 与 `editor.revealLocation` 事件均直接 `setActiveFile`，EditorPane 的 filePath effect 直接重读替换 model，未保存修改**静默丢失**。从校验面板点击问题跳转是高频操作，几乎必然造成数据丢失事故。建议：切换前检查 dirty → 确认对话框（保留/丢弃/取消）；或转为多 tab 模型。

#### M5. 回放面板跨面板联动闭包陈旧（ui-state-replay/src/index.ts）

监听 `kojo.replayFunction` 的 effect 依赖为 `[archivePath, charaNo, contextText]`，不含 `view`。视图在 `createView` 完成后才就绪，但该 effect 不会随之重挂，回调闭包内 `view` 永远是挂接时刻的旧值（null）。复现：选档 + 选角色 → 视图就绪 → 在函数树点"⟲ 回放此函数" → 误报"请先选择存档与角色"。建议：deps 加 `view`，或用 ref 持有最新 view/runReplay。

### 轻微

#### L1. `storage.ts` JSON.parse 无容错（kernel）

损坏的 `recent-projects.json` 会让 `open()` 直接抛错（recent 列表本身不关键）。建议 try/catch → 记日志 + 视为空列表。

#### L2. 写权限批准记录未做 pathKey 标准化（kernel/project.ts）

`approved` 存原始 paths，比较时 `approved.every(p => proposed.has(pathKey(p)))` 对大小写差异（Windows 不敏感文件系统）会误判"提议已变化"而重复弹批准框。建议存 pathKey 标准化后的值。

#### L3. POWER 内置的 2^53 精度顺序（state-replay/builtins.ts）

POWER 结果先做 Number 乘法再 `inInt64` 校验——超 2^53 时用**已失真值**判定。应先判 `|x| > 2^53` → unknown，再算。

#### L4. `resolveModel` null 分支注释与实现不一致（state-replay/state-view.ts）

注释说"已知名但快照缺失 → 由调用方按 0/'' 默认值处理"，实际 `read()` 直接返回 `unknown('missing-var')`。方向保守无害，但拉高了 missing-var 率（冒烟中 missing-var=80 可能部分源于此）。建议实现注释所述语义（走 readBlockVar/readTopVar 的默认值路径）或改注释。

#### L5. scanner 的 TRY 系开块规则宽泛（erb-parser/scanner.ts）

`kind.startsWith('TRY')` 把所有 TRY 开头语句当开块；引擎 funcMatch 表只允许 `TRYC*→CATCH` 与 `TRY*LIST→ENDFUNC` 配对，`TRYCALL/TRYJUMP/TRYCALLFORM/TRYGOTO` 是单行指令。**实测影响为零**（3818 文件、411 万行：栈残留对比 100 文件全一致且残留源头与 TRY 无关；逐语句 depth 序列零差异；buildContextLookup 的 TRY 段残留只是公共祖先前缀，不破坏可达性）。建议按引擎表收敛规则，纯代码卫生。

#### L6. family-index 编号锚点贪婪回溯的理论边缘（eratw-adapter/family-index.ts）

`/^(.*)_K(\d+)(_.+)?$/` 贪婪回溯取**最后一个** `_K\d` 作编号锚点；若家族名本身含 `_K{数字}` 段会劫持编号。eraTW 实测语料未出现（97.88% 覆盖），记录为已知限制。

#### L7. 杂项

- `inline.ts` 的 `parseHeadLine` 正则对引号内括号无感知（ERB 头行无字符串默认值语法，风险极低）。
- `expr.ts` 字符串转义 `\` 后任意字符原样保留（引擎转义语义未逐条核对）；`indices` 存解码值而 `text` 用原文（仅影响展示/缓存 key，不参与语义）。
- EditorPane 的 dirty 检查每击键全量文本比较（`getValue() !== original`，MB 级文件每击键 O(n) 分配；建议 model 版本号比较）。

---

## 3. 各包简评

| 包 | 结论 |
| --- | --- |
| `@kojo/kernel` | 质量高。io/encoding/project 写保护链路完整；runtime 生命周期管理基本正确（M1 为唯一缺口）；storage/bus/container/slots 干净（L1/L2 轻微） |
| `@kojo/plugin-api` | 契约注释与实现一致性好；paths.ts 语义正确。H1 修复需同步扩展 FunctionPredicate 契约 |
| `plugin-erb-parser` | scanner 382 行控制流扫描总体正确；TRY 系规则不精确但实测无危害（L5）；extract.ts 的 collectAssignments 按行升序满足 locals.ts 的依赖假设 |
| `plugin-condition-extractor` | expr.ts Pratt 解析器优先级表与引擎 OperatorCode.cs 逐级对齐，失败整体降级 opaque，质量高；extract.ts 的 expandCase 是唯一语义错误（H1） |
| `plugin-sav-parser` | 二进制协议镜像正确（§1.2）；arrays cell 策略与截断标记（cellsTruncated）支撑了 state-view 的三态判定 |
| `plugin-state-replay` | 求值/内联/分支/本地量四层均达到"近似回放"设计目标；L3/L4 轻微；branches 的 OR 折叠是 H1 的另一半 |
| `plugin-eratw-adapter` | 游戏知识层集中且全部有逆向文档出处；CSV 宽容解析、优雅降级、命名解析 97.88% 实测覆盖（L6 理论边缘） |
| `plugin-convention-linter` | 引擎稳健（失败隔离/记忆化/去重）；duplicate-function 内置规则简单正确 |
| `ui-*`（4 个） | 外部源订阅模式统一、onDispose 齐全、渲染上限防 DOM 爆炸；M5 为唯一功能 bug |
| `@kojo/app` | 原子写正确、bridge 语义清晰（watchDirs 显式空实现）；M2/M3（Rust 侧）与 M4（编辑器）为待办重点 |

---

## 4. 前瞻性备注（v1.1 编辑器接入时处理）

1. **文件保存 → 缓存失效链缺失**：`EditorPane.save()` 只调 `writeText`，不发出任何事件；`kojo.functionChanged` 仅在 erb-parser 全量索引重建时发出。当前无编辑器索引更新机制（v1.1 路线图项），故保存后导航树/回放面板数据陈旧**尚无触发路径**；接入实时编辑时必须补"fileSaved → 单文件重解析 → 缓存失效"事件链。
2. `watchDirs` 已预留接口（Rust notify 接入点），当前 UI 用显式刷新，符合"不静默"原则。
3. 内联解释器 `MAX_INLINE_DEPTH=8` 与 `<<` 无上限位移、`*` 超 2^53 精度：均为理论边缘，语料未触发，保持现状可接受。

## 5. 修复优先级建议

1. **H1（CASE TO AND 语义）** —— 影响第九批核心交付物的正确性，且失真不可见，建议第十一批优先排入；
2. **M4（切换文件丢内容）** —— 用户数据丢失风险，改动小；
3. **M2（Rust 编码 had_errors）** —— 数据损坏路径，改动小；
4. **M5（回放联动闭包）** —— 功能不可用+误导报错，改动极小；
5. **M1 / M3** —— 架构级补强，可随 v0.3 规划；
6. L1-L7 —— 顺手清理。

---

*审阅人：代码审阅 Agent（只读审阅，未修改任何源码）。本文档为新增文件，不影响现有开发。*
