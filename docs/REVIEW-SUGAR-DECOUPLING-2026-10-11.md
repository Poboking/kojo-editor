# 语法糖提交审阅：设计要求符合性 × 「一切皆插件」解耦

> 审阅范围：v0.3 批 S1–S5+ 六个提交
> （`7ebeb21` S1 契约+golden / `a6a7681` S2 转译内核 / `5ff486a` S3 写链路 /
> `1cdb52b` S4 预览 / `8bfdf4c` S5 升糖 / `0d0bc51` S5+ 旁白口径+liftApply+面板）
> 审阅基准：
> - `docs/SYNTAX-SUGAR-DESIGN.md`、`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（v1.2 冻结版）、
>   `docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md`（已批准的实现方案）、
>   `docs/LIFT-SUGGESTER-DESIGN.md`
> - `docs/ARCHITECTURE.md`（铁律源头）、`reverse-engineering/dsh-架构设计哲学.md`
> - 可执行门禁 `tools/audit-decoupling.mjs`
> 审阅方式：文档对表 + 源码逐条核查 + 门禁实跑（本报告全部结论均由实跑/实证支撑）。
> **本报告只做审阅与定性，不改动任何代码。**

---

## 一、结论速览

| 轴线 | 结论 |
| --- | --- |
| **轴线 1：语法糖设计要求** | **高度符合**。表层语法、转译算法、命名公式、round-trip 不变量、写链路安全模型、旁白口径，逐条对得上设计文档；未发现"自作聪明"或越界实现。 |
| **轴线 2：「一切皆插件」解耦** | **门禁全绿，但存在 1 处「设计文档承诺未兑现」的实质偏差**（B-1）。门禁绿是因为审计黑名单不含插件目录，而非因为问题不存在。 |

**关键发现（1 项，需用户定夺）**

> **B-1｜`kojo-sugar` 硬编码了 eraTW 的时机分野模板与 `M_KOJO` 字面量，未走 adapter。**
> 与已批准的实现方案 `SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md:153`（"37 调用面模板表**为 adapter 新增**"）
> 及三处契约/代码头注（`plugin-api/src/sugar.ts:12`、`kojo-sugar/src/index.ts:10`、`keywords.ts:5`）
> 明确矛盾。因审计 A 项黑名单不覆盖 `packages/plugins/*`，四闸全绿不报警。
> **这是"游戏知识是否只进 adapter"的实质问题，非命名/注释瑕疵。**

---

## 二、轴线 2：解耦审计（实证）

### 2.1 门禁实跑结果

```
$ node tools/audit-decoupling.mjs
=== 「一切皆插件」解耦审计 ===
✅ 全部通过：
   A. 内核 / plugin-api / Rust 宿主：零游戏名词
   B. 插件（14 个）：未依赖 @kojo/kernel
   C. 插件之间：无交叉 import
```

### 2.2 逐项核验（不只看门禁，看实质）

| 项 | 门禁口径 | 实质核验 | 判定 |
| --- | --- | --- | --- |
| **A** | `NEUTRAL_DIRS` = kernel/src、plugin-api/src、app/src-tauri/src、app/src/bridge、app/src/bootstrap.ts，黑名单 `eratw\|eraK\|eraSQN\|eraNAS\|M_KOJO\|個人口上\|\bsav\b` | 逐一 grep：契约层 `plugin-api/src/sugar.ts` **零命中**（中文关键字属跨游戏语言层，`kojo`/`chara` 为钦定通用术语）；内核仅 S3 新增 `ensureDir`（+7 行，同闸） | ✅ |
| **B** | 插件源码不得 `import @kojo/kernel` | 逐一读 14 个插件 `package.json`：**全部**仅依赖 `@kojo/plugin-api`（`devDependencies` 里的 `@kojo/plugin-*` 不算，审计只看源码行） | ✅ |
| **C** | 插件互不 import 其它插件包名（`tests/` 豁免） | `kojo-sugar` 经**服务槽软取**消费 `erb.parser`（`scanControlFlow`）/ `condition.extractor`（`parseExpression`）/ `state.replay`；`ui-sugar-lift` 只消费 `sugar.lift`/`sugar.liftApply`/`editor.activeFileChanged` | ✅ |

### 2.3 架构设计上的亮点（值得记录）

- **软取服务槽（`try { ctx.inject(...) } catch { return undefined }`）**：`kojo-sugar/index.ts:60-115`
  对 `state.replay`（S4）、`erb.parser`、`condition.extractor`（S5）三处采用软取，
  并把理由写进注释——**硬依赖会让"回放插件未激活"导致整个 `kojo-sugar` 静默 inactive，那是本末倒置**。
  这既符合 cordis `inject` 语义，也守住了"内核不静默"铁律的反面：能力缺席应**退化可见**而非消失。
- **"能力面 = 服务键面"**：`sugar.lift`（只读）与 `sugar.liftApply`（可写）拆成**两个服务键**
  （`index.ts:181-215`），注释明写"写能力必须显式声明成一个独立服务键，否则'哪些插件能写盘'就不再可审计"。
  这是 `dsh-架构设计哲学.md` §九"把不变式接到可执行门禁"思路的自发实践。
- **谁改盘谁发事件**：`liftApply` 的发口由装配层注入 `onApplied: (path) => ctx.bus.emit('file.changed', ...)`，
  实现层（`lift-apply.ts`）**零内核依赖**；`ui-sugar-lift` 面板只消费不发（其头注明确"写盘在 `sugar.liftApply` 里，事件也由那边发，职责不重叠"）。
- **UI 插件不持宿主引用**：`ui-sugar-lift` 通过宿主事件 `editor.activeFileChanged` 取当前文件，
  而非直接读宿主状态——符合 DSH "模型可见 ⟺ 已记录" 与事件域分发的思路。
- **`convention-linter` 糖规则零游戏知识**：`rules/sugar-conventions.ts` 头注「**零游戏知识**——只做 `.kojo` 表层文本的结构扫描」，
  5 条规则（`cont-inside-quotes` / `multiple-choice-blocks` / `expr-missing-else` / `readonly-alias-assign` / `static-conventions`）
  全部纯文本扫描，**不依赖 adapter 字典、不 import kojo-sugar**（避免 C 项违规），符合"引擎+规则"模式。

### 2.4 偏差项

#### **B-1（重要）｜时机分野模板硬编码在 `kojo-sugar`，未走 adapter**

**事实**

`packages/plugins/kojo-sugar/src/codegen.ts:292-349` 的 `resolveFace()`：

```ts
const faceTemplates: Record<string, string> = {
  初见: `M_KOJO{t}_ENCOUNTER_K{n}`,
  事件: `M_KOJO{t}_EVENT_K{n}_{i}`,
  绝顶: `M_KOJO{t}_MESSAGE_PALAMCNG_B_K{n}`,
  射精: `M_KOJO{t}_MESSAGE_PALAMCNG_A2_K{n}_{i}`,
  标记: `M_KOJO{t}_MESSAGE_MARKCNG_K{n}`,
  计数器: `M_KOJO{t}_MESSAGE_COUNTER_K{n}_{i}`,
  追加源: `M_KOJO{t}_EXTRASOURCE_${localsSeg}_K{n}_{i}`,
  日常: `M_KOJO{t}_DAILY_EVENT_K{n}_{i}`,
  日记: `DIARY{t}_TEXT_K{n}`,
  成功: `M_KOJO{t}_SUCCESS_${localsSeg}_K{n}_{i}`,
};
// 另有 `指令` 分支：`M_KOJO{t}_MESSAGE_${localsSeg}_K{n}_{i}`
```

同一文件另有硬编码：`@M_KOJO_COLOR_K{charNo}`（:152）、`@M_KOJO_K{charNo}`（:184）、
`@M_KOJO_FLAGSETTING_K{charNo}`（:193）、`TFLAG:192`（:235）、`SETBIT RESULT, ${bit}`（:411）。

**与设计文档/契约为约的直接矛盾**

| 出处 | 原文 |
| --- | --- |
| `SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md:153`（已批准方案） | 「**"L0 知识数据包" 的落位 = eratw-adapter**：变量字典 ≈ `variableSchema`（已建成），**37 调用面模板表为 adapter 新增**（游戏知识只进 adapter，铁律自动满足）」 |
| `plugin-api/src/sugar.ts:12`（契约头注） | 「**知识来源**：变量名字典 / **时机分野模板来自 game adapter**（游戏知识只进 adapter）」 |
| `plugin-api/src/sugar.ts:326`（`TimingBlock.face` 字段注释） | 「分野 → 函数名模板的映射**由 adapter 侧知识（完整 37 调用面）与转译器共同解析**，契约层不内嵌任何模板（否则游戏知识就会漏进契约）」 |
| `plugin-api/src/sugar.ts:702`（诊断码注释） | `'timing-face-unknown' // 分野关键字不在 **L0 分野表（adapter 提供）**` |
| `kojo-sugar/src/index.ts:10-11`（插件头注） | 「变量字典 / **时机分野命名模板来自 game adapter**……本插件只消费，不解释」 |
| `kojo-sugar/src/keywords.ts:5-6` | 「eraTW 特定的旗标命名 / 配色常量 / **时机分野模板来自 adapter**」 |

**adapter 侧现状（实证）**

`packages/plugins/eratw-adapter/src/plugin.ts:34-44` 提供的 `GameAdapter` 面为：
`gameId` / `displayName` / `functionFamilyIndex` / `conventions` / `variableSchema` / `kojoCallProtocol` / `detect` / `loadProject`。
**没有任何"分野关键字 → 函数名模板"表**。`kojoCallProtocol`（`call-protocol.ts`）是**反向**能力：
从 `KOJO_MESSAGE.ERB` 路由表解析出"函数名 → 转发槽位"，用于**校验既有函数**，不是"分野 → 新函数名模板"。

**`DictionaryLookup` 接口也无此通道**（`kojo-sugar/src/types.ts`）——只有 `resolveFamily(name)` 与 `resolve(ident)` 两个方法。
即：即便 adapter 想提供，契约层也没有承载它的形状。

**为什么门禁不报**：审计 A 项只对 `NEUTRAL_DIRS`（kernel / plugin-api / app-tauri / app-bridge / bootstrap）生效，
**不对 `packages/plugins/*` 生效**。所以 `M_KOJO` 出现在插件内是"门禁盲区"。
（注：插件包本身允许含游戏知识——`eratw-adapter` 就是干这个的；问题不在"插件含游戏知识"，
而在"**本该住在 adapter 的知识住进了通用插件 kojo-sugar**"。）

**性质判定**

- **不是**功能缺陷：产物正确（golden 逐字节一致、850 测试全绿）。
- **是**架构承诺落差：`kojo-sugar` 本应"零游戏知识、只消费 adapter 字典"，
  实际携带了 10 个 eraTW 分野名 + `M_KOJO`/`DIARY` 前缀 + `TFLAG:192` 位协议 + `SETBIT RESULT` 语义。
- **可扩展性代价**：接入第二个 era 游戏（或非 eraTW 变体）时，这些硬编码必须先被抽出，
  否则 `kojo-sugar` 无法复用——这正是"内核零游戏知识"要防的事，只是发生在插件层而非内核层。
- **风险等级**：中。不改不影响 v0.3 交付；改则是一次**契约扩展 + adapter 补表 + codegen 改造**的联动。

**处置建议（三选一，请用户定夺）**

1. **补齐承诺（推荐）**：契约新增 `TimingFaceTable`（或 `KojoFaceTemplates`）形状
   → `eratw-adapter` 按附录 C 37 调用面提供实现 → `codegen.resolveFace` 改为查表，
   同时补一条**审计口径**（把"插件源码出现特定游戏分野名"也纳入 B/C 类检查或新开 D 类），防止回归。
   成本：中等（契约 + adapter 一表 + codegen 一处 + 测试 + 审计一条）。
2. **修订文档**：若无近期多游戏规划，明说"v1 分野模板随转译器内建，adapter 化延期到接入第二个游戏时"
   ——但需同步改 6 处头注/注释（上表），否则注释与实现持续互相打脸。
3. **维持现状 + 记账**：仅在本报告登记，进入技术债清单（`ARCHITECTURE.md` 或 HANDOFF 的待办），不动代码。

> **✅ 处置结果（2026-10-11，用户拍板采纳方案 1）**：本条已按「补齐承诺」实施完毕——
> 契约新增 `KojoFaceTable`（`game.ts`）+ `GameAdapter.kojoFaceTemplates`；adapter 新建
> `face-templates.ts` 按附录 C 全量登记；`codegen` 全部改查表（fail-closed，缺表报
> `timing-face-unknown`）；审计新增 **D 项（通用插件零游戏知识）** 并经探针自证能拦回归。
> 产物零变化（golden 逐字节零回退）。实施记录见 `IMPLEMENTATION-LOG.md` §5.33。

#### **B-2（轻微）｜`buildFunctionName` 导出了但无外部消费者**

`codegen.ts:378` 的 `buildFunctionName` 标了 `export`，但全仓引用只有 `codegen.ts` 内部 3 处
（:223 / :227 / :420），`index.ts` 未转发、`lift.ts` 未复用（此前担心的"重复实现"**不存在**）。
→ **无功能问题**，仅"导出面大于消费面"。可顺手去掉 `export`（纯整洁性，非必须）。

#### **B-3（观察）｜`M_KOJO` 字面量在测试中固化**

`kojo-sugar/tests/*` 含 33 处 `M_KOJO` 断言（如 `compile.test.ts:380`、`golden.test.ts:58`、`preview.test.ts:332`）。
若采纳 B-1 的整改 1，这些断言需改为从"注入的 face table"推导；
但**golden 期望文件必须保持 eraTW 字面量**（它们本就是"规范 §6 示例的逐字节产物"）——两者性质不同，勿一刀切。

---

## 三、轴线 1：语法糖设计要求（逐条对表）

### 3.1 表层语法（vs `SYNTAX-SUGAR-SURFACE-SPEC.md` v1.2）

| 规范条目 | 实现位置 | 判定 |
| --- | --- | --- |
| §3.1 文件结构/头部声明（`角色:`/`口上:`/`口上色:`/`开关:`/`别名`） | `lexer.ts` / `parser.ts` | ✅ |
| §3.2 时机声明（函数名由工具生成） | `codegen.emitRegistration` / `emitTiming` | ✅（分野模板出处见 B-1） |
| §3.3 输出（引号=台词=作者色；`续`=不等待） | `codegen` PRINT 变体选择 | ✅ |
| §3.4 插值统一 `{…}` | `expression.ts` / `codegen` | ✅ |
| §3.5/§3.6 条件（`如果/否则如果/否则`）×`当/是/到/否则` | `parser.ts` + `codegen` → IF/ELSEIF/ELSE、SELECTCASE/CASE/CASEELSE | ✅ |
| §3.7 交互 `选项` 块（每时机一个、不嵌套、共用 RESULTS） | `codegen` + linter `multiple-choice-blocks` | ✅ |
| §3.8 代词/属性（`她`/`你`/`她的X`） | `expression.ts`（属性→查字典得变量族） | ✅ |
| §3.9 演出（`心形`/`着色`） | `codegen` | ✅ |
| §3.10 注释/折行/原生直通（行首 `@`） | `lexer.ts:150-158`（**全大写原生指令判定，`IF TFLAG:193 = 0` 走直通而非"如果"糖**） | ✅ |
| §5.0 别名预处理（全局第 0 步，先于一切降糖；四类右值；不跨文件） | `expression.ts:143` + parser 头表 | ✅ |
| §5.1 PRINT 变体选择算法（`d = (旁白色 == 默认) 且 (not speech)`） | `codegen` | ✅（S5+ 已补旁白口径自证） |
| §5.2 纯条件行 → IF 块（避免"空行+无用等待"） | `codegen` | ✅ |
| §5.3 块与缩进配对；异常**不产半成品** | `parser.ts` + `codegen` | ✅ |
| §5.4 槽位分配（`随机`←`LOCAL:N` 每块独占嵌套递增；`选项`←`RESULTS`） | `codegen` | ✅（**采用了规范冻结版，未采纳审阅 §1.2 的 `#DIM` 方案**——与 §8.1-3 对表结论一致） |
| §5.5 命名生成完整拼接公式 + 三件套不带家族段 | `codegen.buildFunctionName` + `emitRegistration` | ✅（公式正确；模板出处见 B-1） |
| 附录 C 37 调用面（v1 只覆盖高频；`—` 走原生直通） | `codegen` 覆盖 11 个分野 | ✅（覆盖集与 v1 声明一致） |
| §7.1 默认等待（非默认续） | `codegen` | ✅（与 2×2 语料矩阵的 70.32% 缺口吻合） |
| §7.2 排除清单（不做循环糖等） | 全仓无循环语法 | ✅ |
| §7.3 逃生舱（原生直通保证不漏水） | `lexer.ts` + parser | ✅ |
| §8 lint 清单 | `convention-linter/rules/sugar-conventions.ts`（5 规则） | ✅（§8 的"糖文本行可静态判定"子集，其余交由转译器精确诊断——取舍已写在头注） |

### 3.2 设计原则（vs `SYNTAX-SUGAR-DESIGN.md` / `IMPL-REVIEW`）

| 原则 | 实现证据 | 判定 |
| --- | --- | --- |
| **双向可逆编译**（降级 + 升糖） | S2–S3 降级；S5 升糖，且**只认 round-trip 自证过的候选** | ✅ |
| **糖要薄 / 优先由口上场景驱动** | 覆盖面严格限 v1 高频入口；不做循环糖 | ✅ |
| **`round-trip or nothing`**（候选成立由转译决定，不由形态决定） | `lift.ts:223-340`：糖片段包最小 `.kojo` 壳 → `transpile` → 取 `IF LOCAL`…配对 `ENDIF` 正文 → 双侧 `normalizeIndent` → 逐字节比对；不一致 → `skipped('roundtrip-mismatch')`；confidence 闭集只有 `'verified'` | ✅ **忠实** |
| **禁止生成器"自作聪明"** | 生成代码为可回放形态；`IF LOCAL` 信封层、骨架赋值（`LOCAL = n`/`TFLAG:192`/`SETBIT RESULT`）均按规范 | ✅ |
| **标签前缀保留 `__sugar_*`** | 与 §8.1-3 一致 | ✅ |
| **临时变量用 `LOCAL:N`** | 与 §8.1-3（推翻审阅 §1.2）一致 | ✅ |
| **编译有损 → 建议式提升 + 逐字节一致为安全前提** | S5 全链路 | ✅ |

### 3.3 写链路安全模型（vs S3 设计 + 注入器范式）

`compile.ts` 头注声明六步顺序，实读代码逐条对上：

```
1. 守卫（不产半成品、不建目录、不备份、不写盘）
2. 组装（BOM + 换行 + 末尾换行）
3. 建目录（ensureDir，经内核 io 同闸）
4. 备份（已存在时经内核 io backup 入 {appData}/backup/{hash}/）
5. 写盘（内核 io writeBytes；第一道闸 writablePaths；越权抛 WriteNotAllowedError 原样传播）
6. 回读验证（逐字节比对，不一致抛错且**携带备份路径**）
```

- **顺序即安全语义**：守卫在备份前抛；越权写抛出时备份已存在、目标未覆盖；回读失败必带备份位置。✅
- **编码口径**：产物恒 UTF-8-BOM + LF + 末尾换行；头注明确"以真实语料为准，**覆盖规范 §8 的 CRLF 断言**"——
  这是 S3 的设计取舍（3,818 ERB 实测 LF-only 3,787 / CRLF-only 3），**已在文档中显式记账，属有意偏离**。✅（记一笔：规范 §8 未回改，存在文-实不一致，建议在 spec 兜一句注解）

### 3.4 S5+ 旁白口径（vs `LIFT-SUGGESTER-DESIGN.md` §2.3）

- `旁白色: 默认`（缺省）→ 旁白走 D 系；`旁白色: 作者色` → 旁白也用角色色；**台词行不受影响**。
- 与 spec §5.1 第 3 步 `d = (旁白色 == 默认) 且 (not speech)` **完全一致**。
- 引擎语义实证（`D` = `ISPRINTDFUNC` → 忽略 `SETCOLOR`；`D` 与引号无引擎关联）已写入 `LIFT-SUGGESTER-DESIGN.md`。
- **本批不加任何新语法**——旁白开关是糖表层早已存在的机制。✅
- 2×2 语料矩阵（口上域：无引号非D=113,863 / D=269,814=**70.32%**；有引号非D=452,812 / D=1,583=**0.35%**）
  三项维持拒绝（`alias` 类候选维持 `not-covered`；`PRINTFORMDW/DL 「台词」` 1,583 行/0.35% 维持拒绝）✅

### 3.5 四闸验收（本会话实跑复核）

```
node tools/audit-decoupling.mjs   → ✅ A/B/C 全绿
./node_modules/.bin/vitest run    → ✅ 49 文件通过 / 3 跳过；850 测试通过 / 6 跳过
（typecheck root+app、真实语料冒烟 见提交记录，本会话未重跑）
```

---

## 四、提交范围核验（vs `ARCHITECTURE.md` §7「内核 diff 为空或仅涉及明确的 kernel issue」）

| 提交 | 内容 | 内核改动 | 判定 |
| --- | --- | --- | --- |
| `7ebeb21` S1 | 契约 + golden | 无 | ✅ |
| `a6a7681` S2 | `kojo-sugar` 新插件 + linter 加规则 + 四处登记 | 无 | ✅ |
| `5ff486a` S3 | 写链路 | **`packages/kernel/src/io.ts` +7 行**（`ensureDir`，同闸 `assertWritable`） | ✅ 明确的 kernel issue |
| `1cdb52b` S4 | 预览 + `state-replay/branches.ts` CASE 多区间修正 | 无 | ✅ |
| `8bfdf4c` S5 | `lift.ts` + 契约 + 软取解耦修正 | 无 | ✅ |
| `0d0bc51` S5+ | 旁白口径 + `liftApply` + 面板 | 无 | ✅ |

**结论：六提交中内核仅 `ensureDir` 一处，属"明确的 kernel issue"；其余全部插件形态 + 契约层。**
S2 对 `convention-linter` 是**加规则**而非改引擎逻辑，符合"引擎+规则"模式。✅

---

## 五、发现汇总与建议

| 编号 | 级别 | 内容 | 建议 |
| --- | --- | --- | --- |
| **B-1** | **中（架构承诺）** | 时机分野模板 + `M_KOJO` 等硬编码在 `kojo-sugar`，未走 adapter；与已批准方案及 6 处契约/注释矛盾；门禁盲区致不报警 | **✅ 已按方案 1 补齐**（KojoFaceTable 契约 + adapter 表 + codegen 查表 + 审计 D 项；见 §5.33） |
| B-2 | 低（整洁性） | `buildFunctionName` 导出无外部消费者 | 可去 `export`，可选 |
| B-3 | 低（观察） | 测试固化 `M_KOJO` 字面量 33 处 | 若整改 B-1 需区分"测试断言（改）"与"golden 产物（不改）"——**现经 `tests/support.ts` 统一从 adapter 真实表注入，测试断言即生产口径** |
| C-1 | 低（文-实） | `compile.ts` 编码口径有意覆盖 spec §8 的 CRLF，spec 未回改 | spec 兜一条注解指向实证 |

**符合项（无需动作）**：表层语法全条目、round-trip 不变量、写链路安全模型、旁白口径、
软取服务槽、能力面=服务键面、事件纪律（谁改盘谁发）、linter 零游戏知识、内核 diff 最小化。

**总体判定**：语法糖实现（轴线 1）**忠实于设计**，可确认交付；
解耦（轴线 2）**门禁合规、实质有一处待兑现的架构承诺**，建议按 B-1 处置。

> **✅ 后记（2026-10-11）**：B-1 已按「补齐承诺」处置完毕（用户拍板方案 1）——
> 实施记录 `IMPLEMENTATION-LOG.md` §5.33；验收 868 tests 全绿 / typecheck 双绿 /
> `audit:decoupling` **A/B/C/D 四项全绿** / 真实语料冒烟 1 passed / golden 逐字节零回退。
> B-3 随之消解（测试统一走 `tests/support.ts` 注入 adapter 真实表）。B-2 / C-1 仍为可选项。
