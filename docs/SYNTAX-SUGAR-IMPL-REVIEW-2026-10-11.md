# 语法糖实现提案审阅（2026-10-11）

> 审阅对象：语法糖技术方案与风险分析提案（四层架构 / Tree-sitter / 三段式转译 / 双向可逆）。
> 基准文档：`docs/SYNTAX-SUGAR-DESIGN.md`（设计纪要）、`docs/ARCHITECTURE.md`（铁律）、`docs/HANDOFF.md`（现状基线）。
> 结论先行：**框架采纳，三处重大调整，三处补漏，Tree-sitter 降级为评估项**。落地路线见 §六。

---

## 一、逐层审阅

### 1.1 解析层 —— 调整（提案最重要的一处偏离）

提案把 Tree-sitter 定为已选定方案，理由是"精确 AST、错误恢复、递归注入"。对照项目现状：

| 提案假设 | 项目事实 |
|---|---|
| 需要从零建 ERB 解析能力 | `erb-parser` scanner 已有**引擎级配对表**（funcMatch 精确：TRYC 六个/TRY*LIST 三个/PRINTDATA 九个，BUG-2 修复后无幻影开块）；`condition-extractor` 已有 Pratt 表达式解析器，**493,712 谓词未解析率 0.04%**，且经真实语料两轮 dump-补缺迭代（`[[词]]`、括号索引段） |
| Tree-sitter 服务编辑器注入 | 本项目编辑器是 **Monaco**，不原生支持 tree-sitter；接 web-tree-sitter（WASM）后还要自建 token→Monaco decoration 管线，等于在 Monaco 上重造一个高亮引擎 |
| 糖语法复杂，需要 LR | 糖是**行式结构**（对白行 / `当…:` 块头 / `- ` 列表项 / `{}` 插值），语法复杂度远低于 ERB 本体；`当` 块配对靠缩进，连错误恢复都比 ERB 简单 |

**决定**：
- **转译用解析器 = 手写三段式**（提案转译层本来就定了三段式，解析层照搬即可），且 ERB 侧表达式解析**直接复用 condition-extractor 的 expr 模块模式**（同源规则镜像，参考 extract.ts 镜像 scanner 的先例）。
- **Tree-sitter 降级为待实测评估项**：仅当"糖+ERB 混合高亮"在 Monaco Monarch + decorations 方案下被证明做不出可接受体验时，再评估 web-tree-sitter。两份 grammar 对齐、injections.scm、错误节点语义这些成本，第一版不背。

### 1.2 转译层 —— 采纳，补三条项目级硬约束

三段式、AST 双节点类型（SugarNode/RawErbNode）、源映射从第一天维护、golden 逐字节测试——全部采纳，与项目 golden-roundtrip 测试文化（sav 六档字节级一致）同构。补充：

1. **产物写盘走双闸 + 备份**：编译产物写入 個人口上 目录 = 游戏目录内写入，必须走 kernel io `writablePaths`（用户批准）+ Rust 写允许域第二道闸 + `{appData}/backup` 自动备份。这条提案完全没提，但它是 v1.1 注入器刚刚趟平的现成通路（`snapshot.writer` 同款安全顺序：守卫 → 生成 → 备份 → 写 → 回读验证）。**转译产物回读验证 = 重新 parse 生成结果，确认结构无损**。
2. **生成代码必须是"可回放形态"**：糖预览要靠 state-replay 吃生成后的 ERB（见 1.4），所以 codegen 的模式必须落在 condition-extractor 可解析、inline 解释器可执行的子集内——直线赋值、IF/ELSEIF/ELSE、SELECTCASE、CALL。**禁止生成器自作聪明输出解析器覆盖不了的花活**；每新增一种生成模式，condition-extractor 侧要有对应测试。
3. **临时变量不要用 LOCAL**：提案说"随机块 LOCAL:N 槽位嵌套递增"。但 LOCAL 是作者手写代码的主战场（真实语料 LOCAL 系赋值是回放 unknown 第一大来源），糖生成器挤进去必然冲突。生成产物是完整函数（front-matter 骨架自带 `#DIM`），**声明私有 `#DIM SUGAR_RAND` 等专用变量**，干净隔离，也顺手避免了与回放叠加层的语义纠缠。标签前缀同理：`__sugar_1` 改为 `$SUGAR_{函数名}_{序号}` 形态，保证跨函数唯一且可读。

### 1.3 边界层 —— 采纳混合策略，落地顺序改为"显式先行"

提案推荐"自动识别为主 + 显式兜底"。结合 1.1 的调整（第一版没有 tree-sitter 自动注入），第一版顺序反过来：

- **第一版：显式标记是唯一边界**（```erb 围栏 或 行首 `@erb`）。可靠、零歧义、实现成本低，且设计文档 §六 本来就是这么写的。
- **第二版：行式启发式自动识别**（非 ERB 行首特征 + 现有 scanner 的控制流配对做交叉验证），只在"判定结果面板可见"的前提下逐步放开。
- 提案的边界场景表（标签冲突/变量冲突/错误跨边界）全部采纳，缓解措施并入 1.2。

### 1.4 预览层 —— 调整（不要重建模拟器）

提案四方案对比本身没问题，但"推荐轻量模拟器"忽略了一个事实：**`state-replay` 就是这个轻量模拟器的已建成形态**——三值求值（Kleene）、分支走向（可达性传播）、未知原因 16 分类、调用上下文注入、场景预设，七批打磨到未知率 32.0%。

**决定**：
- 糖预览 v1 = **state-replay 的消费方**：对白行/文本节点从生成的 ERB 抽取（新增"文本行抽取"通道，复用 functionPredicates 明细路径模式），按分支走向折叠出"该状态下会显示哪些对白"。`CFLAG:TARGET:5 → 好感度` 的人类可读标签直接用 **adapter `variableSchema`（CSV 33 张名称表，编号↔名称双向）**，不另建映射表。
- §6.13 已定调（A3）：糖预览复用预览层职责分界，不自建渲染。真实引擎子进程模式保留为接口位（`preview.engine` 可替换），实现无限期后置——era_mcp 无头核心若可用再评估。
- 提案否决"内置修改版引擎"的理由（耦合/沙盒/调试粒度/多 fork）全部成立，采纳。

### 1.5 升糖 —— 采纳，指出可复用资产

"编译有损 → 源文件唯一权威 → 建议式提升 + 逐字节一致校验"全部采纳，与设计文档 §八一致。补充两点：

- 模式识别的底座现成：scanner（控制流配对）+ condition-extractor（表达式 AST）+ variableSchema（`CFLAG:2`→好感度 反向命名）。第一版升糖建议只做**高置信三模式**：单行 `PRINTFORMW` 对白、直线 IF 链、SELECTCASE 随机组。
- "更轻量的中间态"（只高亮补全不转换）恰好就是当前 v0.2 的形态，作为升糖不可用时的天然降级。

---

## 二、提案遗漏的项目级约束（补漏）

1. **解耦铁律落位**：糖系统按"一切皆插件"落位——契约 `plugin-api/sugar.ts`（`SugarTranspileService`：parse / transpile / liftSuggest / sourcemap 查询），新插件 `kojo-sugar`（转译引擎）+ `ui-script-view`（剧本视图，远期）。契约层与内核**零游戏名词**（audit 黑名单含裸 `sav`、`eratw` 等；kojo/chara 是允许的跨游戏术语）。语法糖的"中文关键字"本身是跨游戏语言层，放 plugin-api；eraTW 特定旗标命名走 adapter。
2. **语义旗标映射的数据来源**：`旗标 已告白 = CFLAG:TARGET:1037` 的映射表 = **项目级配置 + adapter schema 两层**。TALENT/CFLAG 通用名查 adapter variableSchema（CSV 权威）；个人口上私有旗标（1000~1999 段）由作者在 .kojo front-matter 声明，编辑器校验越界（接入 convention-linter 新规则）。
3. **危险波浪线 = convention-linter 规则扩展**：全角字符、RAND 连写不等概率、缺 ENDIF（糖侧不存在，但升糖导入的 ERB 侧存在）、CFLAG 越界、函数重名——现有 linter 引擎 + 4 条 eraTW 规则的架构直接容纳，糖侧规则按"引擎 + 通用规则"模式加。

---

## 三、提案内部修订表

| 提案条目 | 判定 | 修订 |
|---|---|---|
| Tree-sitter 为选定方案 | **调整** | 降级为评估项；转译用手写三段式（复用 expr 模块模式）；高亮先走 Monaco Monarch + decorations |
| 两份 grammar + injections.scm | 暂缓 | 随 Tree-sitter 评估一并推迟 |
| ERB 子集范围（PRINT 家族/IF 系/SELECTCASE 系/CALL/SETCOLOR/赋值） | 采纳 | 覆盖优先级由真实语料指令分布 dump 决定（§五），不拍脑袋 |
| 三段式 + AST 双节点 + 位置信息 | 采纳 | — |
| `__sugar_` 标签/变量前缀 | 修订 | 变量改 `#DIM SUGAR_*` 函数私有声明；标签改 `$SUGAR_{fn}_{n}` |
| RANDOM 块 LOCAL:N 嵌套递增 | 修订 | 弃用 LOCAL，见 §1.2 |
| 选项块 v1 禁止多块共存 | 采纳 | linter 规则化 |
| 源映射第一天维护 + golden 用例 | 采纳 | golden 用例 = 设计文档 §五/§六 示例 + 真实语料采样 |
| 边界：自动为主显式兜底 | 顺序调整 | v1 显式唯一 → v2 启发式 + 判定结果可见 |
| 预览：轻量模拟器起步 | 调整 | 直接消费 state-replay；文本行抽取新增通道；真实引擎子进程留接口 |
| 状态标签映射来自 L0 数据包 | 修订 | 用 adapter variableSchema（已建成），不引"L0 数据包"概念 |
| 升糖：建议式 + 逐字节一致 | 采纳 | 高置信三模式起步 |
| 待实测五条 | 采纳并修订 | 见 §四 |

---

## 四、待实测清单（修订版）

提案 §八 五条中，1、3 两条因解析层调整而改写：

1. **糖覆盖优先级测量**（新增，最高优先）：对 2,285 个 ERB / 99k 函数做指令分布 dump——各 PRINT 后缀频率、IF/SELECTCASE 占比、`%STR%`/`{NUM}`/`\@…\@` 三种插值出现率。**糖 v1 只做 dump 前四名的糖**（先测量再动手，§九-15 第五次应验）。
2. ~~Tree-sitter 覆盖率~~ → **行式解析器可识别率**：糖区域判定的误判率目标（显式边界 v1 = 0；启发式 v2 目标 <1%）。
3. 源映射精度：糖一行生成多行的错误回溯，目标 = 定位到源文件具体列。**验收方式**：在生成产物中人为注入错误，回溯路径必须命中源位置。
4. 大文件注入性能 → 改为**转译吞吐**：单文件（口上典型 <2000 行）转译 <50ms，全项目批量转译可并发。
5. 预览状态覆盖度：variableSchema 对口上条件变量的覆盖率已有实测基线（schema 标注 109,742 处）；糖侧只需验证旗标 front-matter 声明通道。
6. 子进程预览启动 <2s：保留，随 `preview.engine` 接口一起评估。

---

## 五、与现有基线的衔接

- **回放基线不受糖影响**：糖是新增产物路径，condition-extractor / state-replay 契约零改动（预览是消费方）；回放未知率 32.0% / exact 836 基线继续作为守门。
- **安全模型**：转译写盘 = 注入器同款（双闸 + 备份 + 回读验证 + fail-closed）。
- **审计**：新插件登记四处 + audit 12→13 插件。
- **golden 文化**：转译 golden 用例纳入 vitest 常驻；真实语料回放断言不变。

## 六、v0.3 落地路线（建议批次）

| 批次 | 内容 | 交付判据 |
|---|---|---|
| **批 S1（测量+契约）** | 指令分布 dump（临时测试跑完即删）→ 糖 v1 覆盖清单；`plugin-api/sugar.ts` 契约（TranspileService + SugarDoc/SugarNode/RawBlock/SourceMap）；golden fixture 固化（设计文档示例） | dump 报告 + 契约 + audit 绿 |
| **批 S2（转译内核）** | `kojo-sugar` 插件：行式词法→AST→codegen，覆盖 v1 糖（对白/插值/条件块/随机块/旗标 front-matter）；`#DIM SUGAR_*` 私有变量；行级源映射 v1；产物回读验证（parse 生成结果） | golden 逐字节一致；生成的 ERB 100% 通过 convention-linter 与 condition-extractor 解析（**可回放形态验收**） |
| **批 S3（边界+写链路）** | 显式 ```erb 围栏；RawBlock 不透明节点 + 错误隔离；写盘走双闸+备份（复用注入器安全顺序）；编码铁律（UTF-8-BOM/末尾换行） | 越权写拒绝测试；混合文件转译 golden |
| **批 S4（预览 v1）** | 文本行抽取通道（condition-extractor 扩展，明细路径模式）；预览面板 = state.replay 分支走向 × 对白折叠；variableSchema 语义标签 | 集成冒烟：真实口上函数的糖预览断言；回放基线逐字不变 |
| **批 S5（升糖建议器）** | 高置信三模式识别；逐字节一致校验 UI；逐条确认流 | 误判率测量报告；校验不过必拒绝 |
| **批 S6（编辑体验）** | Monaco Monarch 糖语法高亮 + 中文关键字补全 + 危险波浪线（linter 新规则）+ 判定结果面板 | app build + 手工清单 |
| 远期评估 | web-tree-sitter 混合高亮 / 真实引擎子进程预览 / 全自动升糖（永不） | 各自独立评估报告 |

**一句话**：提案的分层框架和风险表是对的，但落地上——解析复用已有解析资产而非 Tree-sitter，预览复用 state-replay 而非新建模拟器，写盘复用注入器双闸链路；糖生成器对内要喂得起回放引擎，对外要过得了解耦审计。
