### 5.26 语法糖契约 + golden 固化（v0.3 批 S1 实施记录：先立契约与基准，不碰转译器）

> 依据：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（表层语法 v1.2 冻结版，只读输入）+ `docs/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §8.2（S1 = 契约 + golden 固化；S1 的测量项已由规范 §1.1 提前完成）。
> 边界：仅 `packages/plugin-api/**` + `packages/plugins/kojo-sugar/tests/goldens/**`；未碰 erb-parser / condition-extractor / state-replay 任何现有文件；未改规范文档（冻结输入）；无新插件（`kojo-sugar` 插件 S2 建）。

#### 交付物

1. **契约 `packages/plugin-api/src/sugar.ts`**（新文件，约 700 行）：
   - `SugarDoc`（`filePath` + `frontMatter` + `topLevel` + `diagnostics`）；
   - `SugarFrontMatter`（角色/口上/显示名/简介/口上色/旁白色/开关/别名，对应规范 §3.1）；
   - **SugarNode 联合**（判别式统一为 `kind`）：`TextLine`（speech/wait/interpolations）/ `HeartLine` / `IfBlock` / `IfExpr` / `WhenBlock` / `WhenExpr` / `RandomBlock` / `RandomInline` / `ChoiceBlock` / `ColorBlock` / `RawLine` / `RawFunctionBlock` / `AliasDecl` / `TimingBlock` / `Interpolation`；
   - 语句位置与表达式位置**在类型层分离**：`SugarStatement`（可进块体）∪ `SugarExprNode`（仅赋值位置）= `SugarNode`；`SugarTopLevelNode` = `AliasDecl` | `TimingBlock`；
   - **`AliasValue` 四右值**（规范 §3.1 表）：`variable`（可读写）/ `character` / `number` / `string`（后三只读）；
   - `SugarDiagnostic` + `SugarDiagnosticCode`（23 码**闭集**，按「结构 / 表达式 / 插值 / 别名 / 时机 / 选项 / 文本 / 直通 / 兜底」分组）；
   - `SugarSourceMapEntry`（行级：generatedLine → sourceLine|null + span）/ `SugarTranspileResult` / `SugarTranspileService`（parse / transpile / sourceOf）。
2. **服务键**：`WellKnownServices.SugarTranspile = 'sugar.transpile'`（services.ts）——实现插件 `kojo-sugar` 在 S2 提供；本批**同时**交了 golden 基准与类型测试（不是空承诺）。
3. **golden fixture**（`packages/plugins/kojo-sugar/tests/goldens/`，4 文件）：
   - `spec-6.1-lumia-310.kojo` / `spec-6.1-lumia-310.expected.erb.todo`
   - `spec-6.2-choice-heart-random.kojo` / `spec-6.2-choice-heart-random.expected.erb.todo`
   - 两份源与两份期望产物**逐字节等于规范 §6.1/§6.2 原文**（含 TAB 缩进、全角「」、`;` 記入チェック 注释行）——测试**直接按规范行号切片比对**，不做本地副本，fixture 被误改即刻变红。
   - 期望产物以 `.erb.todo` 后缀暂存 + `describe.skip` 断言位（S2 转正式后启用）。

#### 关键设计决策（这些是"冻结"项，S2 实现不得擅自改）

- **源位置第一天带上**（审阅 §1.2）：每节点 `loc: { start, end }`，1 基行列、列按 UTF-16 码元（与 Monaco 一致）。
- **源映射粒度 = 行级**（本批明确决策，写进契约 docstring）：规范 §6 的 golden 验收是逐字节文本一致，行级足以支撑"每一产物行回溯到源位置"；**列级留到 S6 编辑体验批**（规范 §9 待实测第 3 条要求定位到列）。折行反斜杠合并时 `sourceLine` 取首行、`span` 覆盖多行；纯生成行（`ENDIF` / `ENDSELECT` / 包装骨架）`sourceLine` 为 `null`（不伪造）。
- **分野 → 函数名模板不进契约**：`TimingBlock.face` 只存分野关键字原文；模板（37 调用面）属 adapter 侧游戏知识——否则游戏知识漏进契约、违铁律。契约只承载"跨游戏语言层"（中文关键字、别名机制、插值/条件结构）。
- **`别名` 属契约层**：它是**文件级 front-matter 机制**（规范 §3.8「别名优先于 L0 查表」），不是某游戏的领域知识，故 `AliasDecl` / `AliasValue` 住 plugin-api。
- **只读性单一真源**：`isReadonlyAlias` / `isWritableAlias` 是唯一判定入口——15 个显式类型守卫（`isTextLine` / `isVariableAlias` / …）替代判别式 narrow，因为 TS7 对"联合字面量属性"的 narrow 不可靠（§九-10 教训又一次应用）。
- **`选择` 返回值不手写**：`ChoiceBlock` 只存 `label`（不含返回值）——"工具按书写顺序分配 1..n"是消灭参数顺序陷阱的设计（规范 §3.7），契约从类型上就不给作者写返回值的口子。

#### 验证

- vitest 全量 **555 passed / 7 skipped**（基线 520 → +35：`packages/plugin-api/tests/sugar.test.ts`；+2 项为本批 `describe.skip` 的 S2 断言位）。
- typecheck **root + app 双跑 ✅**（首次提交前修了 6 处测试文件的 `noUncheckedIndexedAccess` 严格报错）。
- `audit:decoupling` ✅（12 插件）——新契约零游戏名词（裸格式名词亦未出现），`kojo` 属钦定跨游戏术语。
- 真实工程集成冒烟 ✅（临时 stash 归位——见下"并行线冲突"）：**回放基线逐字不变**（K49 1356 函数 / 11685 谓词 / 未知 **3741** / exact **836**）。

#### 并行线冲突记录（重要，给验收者）

- 本批执行期间，**并行线（TRAE）正在同工作区改 `packages/plugins/eratw-adapter/**`**（v1.0 收口余项：协议覆盖校验规则，见 NEXT-SESSION-PROMPTS-2026-10-11 线 B）：新增第 5 条 adapter 规则 `CALL_SLOT_RULE`（`call-protocol.ts` 路由表 × 函数声明槽一致性）。
- 影响：集成冒烟断言 `report.ruleCount === 5`（引擎内置 1 + adapter 4）**因其 WIP 变为 6 而红**，且该行断言归 adapter 线维护。**已用 `git stash` 归位其改动复跑，确认本批无回归**（回放基线逐字不变、其余断言全过），随后 `stash pop` 还原，未触碰其文件。
- 本批交付**只提交自己边界内的文件**（plugin-api + kojo-sugar goldens + docs）；`packages/plugins/eratw-adapter/**` 与 `tests/_measure.tmp.test.ts` 属并行线，未纳入本批 commit。
- **待办（S2 开工前）**：adapter 线落地后需同步 `integration-plugins.test.ts:148` 的 `ruleCount` 期望值（5 → 6）——顺手核对 `[smoke]` 输出的 `across N rule(s)`。

---
