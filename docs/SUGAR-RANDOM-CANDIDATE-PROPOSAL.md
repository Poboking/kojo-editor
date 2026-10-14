# 随机块候选三方案（R 提案）

> 2026-10-14 · 状态：**待拍板**（三项互不冲突，认领行在 `docs/BOARD.md` §E：E17 / E18 / E19）
> 文内行号以本文件提交时的 master 为准；探针脚本为一次性工具（读数见 §1，脚本不入库）。
> 2026-10-14 审计批：E19 实操项已交付（`当` 候选修复 / 嵌套随机实测通过 / `选项` 候选守卫 / 槽位断言）；E17/E18 仍待拍板。

## 0. 问题

用户实测追问：`随机：` 块里「一格（一个候选）想打印两句」怎么表达？

```kojo
随机：
    「……呼。」
    「……呼……嘻嘻。」   ← 想要它跟上一句同属一档
    「再、再摸摸嘛。」
```

结论先行：**现状文法「一行 = 一个候选」是刻意设计**（规范 §3.6；`parser.ts:934 parseRandomBody`），
上述写法会被读成三个候选；「一格多句」的今天正解是 `当 RAND:n：`。真正的缺陷是
**教程没写这条边界** + **`当 RAND:n：` 缺档会静默**（§2）。三份方案见 §2/§3/§4。

## 1. 现状事实（全部实测）

| # | 探针（构造可复现） | 读数 |
|---|---|---|
| A | §0 例子原样转译 | 产物 `LOCAL = RAND:3` + `CASE 0/1/2`，三句各占一档，**零诊断** |
| B | `当 1：` 作候选（想借块分组） | 报错 `block-empty` + `indent-mismatch`，产物残缺——根因见 §4.3（双重 `next`） |
| B2 | `如果 1 == 1：` 作候选 | 能过，产物多一层恒真 `IF` 壳（不推荐，但可用） |
| C | `当 RAND:2：` + 多行档 | **零诊断**，产物 `SELECTCASE RAND:2`（语料主流形态） |
| D | lift 语料直进式多行 | 自证通过 → 产 `当 RAND:2：/是 0：/甲一 续/甲二 续` |
| E | lift 糖产物形（`LOCAL=RAND`）多行 | `roundtrip-mismatch` 跳过——糖块形态对多行「看得见写不出」 |
| F | lift 糖产物形单行 | 自证通过 → 产 `随机：` |
| G | `当 RAND:3：` 只写 `是 0：/是 1：`（无 `否则：`） | **零诊断**——第 2 档掷到即永远沉默 |
| L1b | lift：CASE 体内嵌 `如果` 块 | 自证通过 → 产 `当 RAND:2：/是 0：/如果 …：`（嵌套条件块可读可写） |
| R2 | 随机候选 = 嵌套随机 | 零诊断，槽位 `LOCAL:1` 正确——**已可用**（原"待复核"实测转正） |

语料读数（`個人口上` 全树 awk 实测）：26,606 个 `SELECTCASE RAND` 块、92,490 个分支，
**71.6% 的分支打印 ≥2 行**（四面角色 57.4%）——多行候选是多数用法，直进式 `SELECTCASE RAND:n` 是事实标准。
库内事实标准：`fixtures/sugar/teaching-full.kojo:80-85`（单行走 `随机：`）；
K12 整包装译 golden（`kojo-sugar/tests/goldens/corpus-k12-lumia-daily.kojo`，40 档以下多行走 `当 RAND:40：`）。

## 2. E17 · 方案 1 —— 边界写清 + 缺档诊断（语法零改动，推荐先行）

### 2.1 教程⑬补边界（`eratw-adapter/src/tutorial-content.ts:446`）

新增段落（拟稿，文风待做时统一）：

> 「随机：」里每个候选的边界是**行**——一行一个候选。想让一档说好几句话，改用
> `当 随机数：` 写法（第⑪节的选择块）：`当 RAND:2：` 下面 `是 0：` 那一档想写几行写几行。

新增一条对照迷你样例（kojo + erb 两半）。
**硬约束**：教程样例受「溯源守卫」管（`eratw-adapter/tests/tutorial.test.ts:133-207`）——
样例行必须逐字来自 fixtures。步骤：

1. `fixtures/sugar/teaching-full.kojo`（:80-85 之后）加 `当 RAND:2：` 两档示例（档 0 两句、档 1 一句）；
2. `KOJO_SMOKE_PROJECT="C:\game\eratw-sub-modding-eratw4.980" TEACHING_GOLDEN_WRITE=1 node node_modules/vitest/vitest.mjs run packages/kernel/tests/sugar-teaching.transpile.test.ts`
   —— **真实链路重生成** `teaching-full.expected.erb`（人工过目后提交；不许手写 golden）；
3. 去掉 `TEACHING_GOLDEN_WRITE` 重跑该测试：零 error、逐字节一致；
4. 教程⑬引用新行（kojo/erb 两半都在 fixture 里）。

### 2.2 缺档诊断（焊死探针 G 的洞）

规则：语句形态「当」块，主体为常量 `RAND:n`（含糖形 `随机(n)`；n ≥ 1 的十进制字面量），
**没有** `否则：`，且 `是` 档位并集未盖满 `0..n-1` → 报诊断。

- 建议码 `rand-case-incomplete`；severity **error**（与「表达式当缺否则」同档；试行嫌吵可一处降 warning）
- 文案拟稿：`「当 RAND:3：」的档位只盖到 0、1，也没有「否则：」——掷到 2 时什么都不会发生。请补齐档位或加「否则：」。`
- 落点：`parser.ts:759 parseWhenBlock` 返回前（该处已有 subject 与全部分支 `values`——单值/多值/`到` 范围，
  `lexer.ts:604 parseCaseValues` 已解析好）
- 边界（不查，明确写进规范）：主体非数字字面量（别名/表达式）不查；表达式「当」（赋值位）已有「缺否则=报错」覆盖；
  原生直通 `SELECTCASE` 不在糖管辖内；`RAND:0` 走既有 lint
- 测试（`kojo-sugar/tests/`）：缺档报 / `是 0 到 2：` 盖满不报 / 有 `否则：` 不报 / 非 RAND 主体不报 /
  `随机(3)` 糖形报 / 语句面与（不受影响的）表达式面各一条回归

### 2.3 规范同步

`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`：§3.6（:460-484）加「候选=行」边界句；
§8 lint 表（:1012）加 `rand-case-incomplete` 一行。

### 2.4 验收（带数）

全量测试 ≥ 现值不回退 + 新增 n 条；双 typecheck 0；`pnpm audit:decoupling` ✅；
teaching 链路测试真跑（含 golden 重生成后回读）；`python -c ""` 无关——按 AGENTS §三 口径执行。

## 3. E18 · 方案 2 —— `组：` 候选组（一档多行）

### 3.1 语法

```kojo
随机：
    组：
        「……呼。」
        「……呼……嘻嘻。」
    「再、再摸摸嘛。」
```

→ 2 个候选；第 1 档两句。组内允许与「如果」块体同口径的内容
（台词/旁白/心形/空行/原生行/注释/更深的块）。

- 空组 → error；`组：` 行后跟内容 → error（`组` 只作块头）
- 英文别名 `group`（§4.1 中文主形+英文别名双收）
- 位置口径：关键字全局可用（块头优先——原先把 `组：` 当旁白打印的极端写法会改义，规范注明）；
  **有意义的位置是随机候选**；顶层直接用 = 纯分组透传（无害，文档不教）

### 3.2 落点（全部是既有扩展点，零新机制）

| 文件 | 点 |
|---|---|
| `plugin-api/src/sugar.ts` | `GroupBlock` 接口（:244 同族）+ 语句联合（:511）+ `index.ts:257` 导出——**additive 契约** |
| `kojo-sugar/src/keywords.ts:47` | `['组','block.group']` + `['group','block.group']` + `KeywordId` 联合——高亮/补全自 `SUGAR_LEXICON_WORDS`（:258）派生，无第二份词表 |
| `kojo-sugar/src/lexer.ts` | `LineClass` 联合（~:155）加 `{ kind:'groupHead' }`；`parseBlockHead`（:563 switch）加 case |
| `kojo-sugar/src/parser.ts` | `buildStandaloneNode`（:988）加 case → groupBlock；`isBlockNode`（:1256）；`mergeBlockBody`（:1267）；语句面 `parseStatement`（:536）加 case |
| `kojo-sugar/src/codegen.ts:973` | `emitStatement` 加 case：体逐句透传（同缩进，不产生包装行） |
| 全仓对齐 | `grep -n "'randomBlock'"` 所有按 kind 分支处（当前：parser / codegen / 契约测试 4 处）+ `plugin-api/tests/sugar.test.ts` |

### 3.3 lift（拆为 E18b，可后置）

`lift.ts`（`buildRandomSugar`，约 :878）：CASE 体多行 → 该候选包 `组：`（单行候选保持裸行）
→ 探针 E 形从 `roundtrip-mismatch` 转自证通过；探针 F 形回归不变。

### 3.4 测试

transpile：混排（组+裸行）/ 双组 / 空组报错 / 组内注释与原生行 / 产物逐字（`CASE 1` 两行）；
lift：E 形自证 + F 形回归。

### 3.5 教程与规范

教程⑬加 `组：` 迷你样例 + 边界句（与 E17a 合流时该章只改一次）；
SPEC §3.6 补语法图；附录 A 关键字全表（:1038-1049）块头行加 `组`。

### 3.6 克制纪律论证（§7.2）

净新增 = 一个「候选分组」写法；无新算法、无符号表；产物逐字节仍是既有
`LOCAL = RAND:n` + CASE 形态，语料形态零变化（工具多了写法，产物不变）。成立。

### 3.7 风险

教程/规范/高亮需同步（已列）；与 E17a 同域编辑（⑬章 + teaching fixtures）→ 串行认领（§5）；
`组`/`group` 撞词面仅在块头位置（行尾冒号）。

## 4. E19 · 方案 3 —— 候选可嵌条件/块（候选=语句）

### 4.1 语法

```kojo
随机：
    如果 她的好感度 >= 500：
        「……」
    否则：
        「哼。」
    着色 0xFFB0C8：
        「呀。」
    随机：
        「甲。」
        「乙。」
    「裸行仍是单行候选」
```

候选 := 单行 | `组：` | `如果`块 | `着色`块 | `随机`块（嵌套）| `当`块。

- **`选项` 保持禁止**（一时机一 `INPUTS` 的硬边界；候选路径不经过 `parseStatement` 的
  `choiceSeen` 检查——`parser.ts:556-566` 只在语句面，能否实绕以实测为准。E19 直接补
  `选项不可作随机候选` 的显式 error，把这条路钉死）
- 深度不设硬限（自然递归；教程建议 ≤2 层）

### 4.2 现状盘点

| 候选块 | 现状 |
|---|---|
| `如果` | **已可用**（探针 B2；IF 壳 = 语义本身） |
| `着色` | 已可用（`mergeBlockBody:1269` 已处理 colorBlock） |
| `当` | **已修复**（审计批：`parseWhenBlockFromClass` 分体，探针 B 转绿） |
| `随机`（嵌套） | **已可用**（审计批实测：零诊断、槽位 `LOCAL:1` 正确；`mergeBlockBody` 余行缺口在候选语境不产生实际影响） |

### 4.3 `当` 候选根因（可独立修，随 E19 走）

`parseWhenBlock`（`parser.ts:759-760`）进函数第一件事 `this.cursor.next()`：
语句面调用方（`parseStatement:545`）**不预消费**，依赖它自己 next；
而候选面 `parseRandomBody`（`parser.ts:961`）**已先 `next()`**——双重 next 跳过 `是` 行
→ `block-empty` + `indent-mismatch`（探针 B 全解释）。
修法照已有的 `parseIfBlock` / `parseIfBlockFromClass` 分体模式（:686 / :1025）：
加 `parseWhenBlockFromClass`（不自我消费）供候选面调用。**审计批已落地。**

### 4.4 落点

- `parser.ts:1000`（候选面改调 FromClass 变体）——**审计批已改**
- `parser.ts:1267 mergeBlockBody` 扩：`whenBlock`→末分支体、`randomBlock`→末候选体（现有 if/color 照旧）
  ——**审计批实测后判定不必扩**（候选语境下深层余行不可达，见 §4.2）
- `parser.ts` 候选面对 `choiceHead` 报 error——**审计批已加**（`choice-nested`，与块体同码同文案）
- codegen 无新增（`emitStatement:973` 全块递归已具备；槽位递增在 `codegen.ts:1336/1373`）

### 4.5 测试

每类块候选逐类正例；混排；嵌套两层随机槽位断言（`LOCAL` / `LOCAL:1` 不互踩）；
`当` 候选修复用例（=探针 B 转绿）；`选项` 候选 error 用例；语句面 `当` 回归不受影响。
**审计批已落 7 条用例**（6 条于 `transpile.test.ts`：当候选 / 如果·着色回归 / 选项候选守卫 / `不在` lint×3；1 条于 `lift.test.ts`：CASE 内嵌 IF 钉住）。

### 4.6 lift 边界

CASE 体内嵌 `如果` 块 → **实测自证通过**（可读可写，见 §1 L1b；`lift.test.ts` 已钉住）；
其余复杂混合形态仍按 lift 自证结果取舍——原先"体含逻辑块即跳过"系未实测断言，本批修正。

### 4.7 风险与档期

语言面变大（教程/规范/高亮全跟）；建议排 E18 之后、按真需求启动。

## 5. 组合建议与认领纪律

- 三项互不冲突：E17 立即值（补边界 + 焊洞，语法零改动）；E18 解原始诉求（一档多句）；
  E19 是「候选里嵌条件」的完整形态
- **同域编辑串行**：E17a 与 E18 都会动 `tutorial-content.ts:446+` 与 `teaching-full` 两个 fixture——
  后认领者 rebase 前者、改完读回
- 否决项（写死不翻案）：翻转分组默认（相邻行自动并组）＝存量 .kojo 静默变义；
  `选项` 作随机候选
- 不做：lift 对多行直进式改产 `组：`（保持 `当 RAND:n：`，两形态各归其位；
  `组：` 只在糖产物形（`LOCAL=RAND` + SELECTCASE）启用）

## 6. 关联资产

- E15 提案 `docs/SUGAR-INTIMATE-EXPANSION-PROPOSAL.md`（P-4 随机直出形：方向一致，未实施）
- 探针脚本已删不入库；§1 读数可由表格构造复现
