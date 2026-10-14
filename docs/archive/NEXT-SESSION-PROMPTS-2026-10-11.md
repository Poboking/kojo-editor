# 夜间自主推进批次 Prompt（2026-10-11 晚准备，供次日会话直接粘贴）

> 使用方式：两条线**并行**。主线给一个会话按顺序执行 A → B（B 必须等 A 完成后开新会话）；并行线给 TRAE，与主线零文件交集。
> 每批完成判据统一：`pnpm test` 全绿 + `pnpm typecheck`（root+app 双跑）+ `pnpm audit:decoupling` 全绿 + Conventional Commits 提交（不推送）。
> 全程权威文档：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（表层语法 v1.2 冻结版）+ `docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md`（架构落位与批次路线 §8.2）。

---

## 线 A（主线·第一批）：S1 语法糖契约 + golden 固化

你是 kojo-editor（<工作树>）的批次执行者。先读 docs/HANDOFF.md、docs/SYNTAX-SUGAR-SURFACE-SPEC.md（§3/§5/§6）、docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md §八，然后完成 **S1 批：语法糖契约 + golden fixture 固化**。

任务：
1. 新契约 `packages/plugin-api/src/sugar.ts`：`SugarDoc`（front-matter + 时机列表）/ SugarNode 联合类型（TextLine{speech,wait,interpolations} / Interpolation{kind:'expr'|'cond'} / IfBlock / WhenBlock / RandomBlock / ChoiceBlock / ColorBlock / HeartLine / TimingBlock / RawLine / RawFunctionBlock / AliasDecl 四种右值）+ `SugarTranspileService`（transpile(source) → {erb, sourceMap, diagnostics}，sourcemap 行级）+ `SugarDiagnostic`。命名零游戏名词（审计 A 项；kojo/chara 允许）。
2. `SugarNode` 位置信息（行/列）从第一天带上（源映射地基，审阅 §1.2）。
3. golden fixture：`packages/plugins/kojo-sugar/tests/goldens/` 收录规范 §6.1、§6.2 两个示例的 .kojo 源与期望产物（期望产物暂时以 `expected.erb.todo` 存放并 skip 断言，S2 实现后转正式）。
4. 本批**不实现转译器**（那是 S2）；只交契约 + 类型 + 单测（类型层行为：别名右值四形态的类型守卫、诊断结构）。
5. 登记：plugin-api 导出即可，无新插件（kojo-sugar 插件 S2 建）。

边界：不动 erb-parser/condition-extractor/state-replay 任何现有文件；不写 docs/SYNTAX-SUGAR-SURFACE-SPEC.md（规范是冻结输入，只读）。

---

## 线 A（主线·第二批，A 完成后新会话）：S2 转译内核

承接 S1 契约，实现 **S2 批：`kojo-sugar` 插件转译内核**。先读 S1 的 sugar.ts 契约与规范 §5（转译算法逐条照抄：§5.0 别名预处理 → §5.1 PRINT 变体选择 → §5.2 插值/纯条件行 → §5.3 块配对 → §5.4 LOCAL:N 槽位 → §5.5 函数名拼接公式）。

任务：
1. 新插件 `packages/plugins/kojo-sugar/`（四处登记 + bootstrap），服务实现 SugarTranspileService。
2. 手写三段式：行式词法 → SugarNode AST（缩进配对，块头以全角冒号结尾）→ codegen（产物 TAB 缩进、`__sugar_` 标签前缀、随机块 LOCAL:N 每块独占嵌套递增、表达式 当/如果 必须有 否则 否则编译错误）。
3. 产物形态约束（审阅 §1.2-3）：直线赋值/IF 链/SELECTCASE/CALL 子集——生成的每一段必须能被 condition-extractor 解析。
4. golden 验收：§6.1/§6.2 期望产物**逐字节一致**（含 `　` 全角空格、`;記入チェック` 注释行）；加 ~40 项单测覆盖规范 §3 每条糖 + 错误路径（缩进异常/只读别名赋值/插值内写当/缺否则）。
5. linter 新规则挂 convention-linter 通用层：`续` 写进引号、每时机多 `选项` 块、表达式缺 `否则`、只读别名作左值（规范 §8 清单中糖侧可静态判定的子集）。

边界：不碰写盘（S3）、不碰 UI、不做升糖。

---

## 线 B（并行·TRAE）：v1.0 收口——协议覆盖校验规则

你是 kojo-editor（<工作树>）的批次执行者。先读 docs/HANDOFF.md §6.10（口上调用协议）与 §十 第 4 条，完成 **v1.0 收口余项：协议覆盖校验规则**。

任务：校验「口上函数签名槽」与「KOJO_MESSAGE.ERB 路由表转发实参」的一致性——对 adapter `call-protocol.ts` 解析出的每个家族槽位（KojoCallSlot），核对该家族实际函数的声明槽（复用 erb-parser 现有函数签名解析/condition-extractor 的 FunctionAssignment 通道）是否被路由转发覆盖；不一致（声明槽多于转发槽 = 调用永远收默认值）产出结构化问题。落位：convention-linter 新增一条 eraTW 规则（adapter 侧实现，注册进 eratw-adapter/conventions.ts 模式）+ ui-convention-report 自然呈现（现有面板消费，不改动）。

边界（与主线零交集）：只碰 `packages/plugins/eratw-adapter/**` 与其测试、docs（IMPLEMENTATION-LOG 新小节用 node 行号 splice 追加、HANDOFF 对应行）；**禁碰** packages/plugin-api/src/sugar.ts、packages/plugins/kojo-sugar/**（主线正在用）。验证同通用判据 + 真实工程冒烟（KOJO_SMOKE_PROJECT 环境变量，游戏目录 <本机目录>\eratw\eratw-4.980基线语料）。

---

## 次日人工验收清单（给用户）

- [ ] git log 看 3 批 commit 是否齐全、边界是否互不踩线（`git show --stat`）
- [ ] 重跑：`pnpm test && pnpm typecheck && pnpm audit:decoupling` + 真实冒烟
- [ ] golden §6.1/§6.2 是否逐字节一致
- [ ] 文档标题层级 grep 验证（防标题吞噬）
- [ ] 验收通过后统一推送
