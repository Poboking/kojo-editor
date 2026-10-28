; Kojo 2.0 缩进查询（queries/v2/indents.scm）—— K2-INDENT-BRACKETS 起**有真捕获**。
;
; ## 捕获口径（沿用宿主既有约定）
;
; 宿主（`kojo2-worker.ts`）把捕获翻成 `KojoStructureIndentRules` 的三条腿，再交给
; `mergeIndentConfig` 消费（v1 同形契约，字段名一处不新造）：
;
; | 捕获 | 语义 | 宿主去向 |
; |---|---|---|
; | `@indent.increase` | 开体行：体比块头深一级 | `increasePatterns` + `enterPatterns`（回车 / 行中回车 / 粘贴都抬一级） |
; | `@indent.align` | 并列容器：行与行同层，不加深 | 三腿**不翻译**（Monaco 的默认"新行沿用当前行缩进"就是同级；这一档留给 nvim 式缩进消费者） |
;
; 本语法**没有** `@indent.decrease` / `@indent.end`：2.0 的收块靠 offside 回缩，没有收束记号
; （§4.13 / §8.5），硬造一条 decrease 规则就是把"作者回缩"改写成"编辑器替我回缩"。
;
; ## 为什么按节点 kind 派生，而不是按整行文本
;
; v1 那份零捕获头注的反对理由对"逐字匹配整行"成立：块头行带实参（表名 / 条件 / 参数），
; 整行锚定正则换个实参就失效。这里捕的是**节点**，宿主取"行首锚 + 词形"派生规则
; （`# 表` → `^\s*#[ \t\u3000]+表(?:[ \t\u3000]|$)` 一类），实参不参与规则 ⇒ 换表名 / 换条件
; 不改规则。派生层在 `packages/app/src/monaco/tree-sitter/kojo2-worker.ts::indentRulesFromCaptures`。
;
; ## 覆盖与边界
;
; - 五锚点里的开体形状：`#` 块声明（表 / 池 / 模）、`@` 调度块头（算 / 着色 / 随机 / 组 /
;   循 / 复 / 巡 / 函 / 织）、`?` 条件链（含 `? 否`）；
; - `@原生` 围栏头（体深一级）；**围栏体内不参与**：本文件只捕 `native_head`，不捕
;   `native_line` / `native_body`，围栏里长得像块头的行不会出现在捕获里；
; - 表两列（`(table_row)`）、池分支链 / 随机候选 / 组体的 `block_body` 是 `align`（行与行同层）；
; - `!` 触发**不捕**：它虽然是语法层的**可选体**块头，但同一枚 `trigger` 节点在 `block_body`
;   里也当"裸调用行"出现（`! 记录(...)`），按节点捕会把每条普通调用都变成开体行；
;   "这个模板有没有插槽"只有定义处知道（§7.2 把它列为报错项、不是推断项）⇒ 与
;   `monaco/kojo2-indent.ts` 的回车判据同一条纪律：判不准就不给规则。
;
; 行文本判据的已知上限：宿主把规则交给 Monaco 的静态 `onEnterRules` / `indentationRules` 时，
; 那些规则只拿得到"当前行文本"、看不到"这一行在不在围栏内"（`@kojo/kojo-lang/language-config` 头注同一条）。
; 带上下文的围栏判定在 `kojo2-indent.ts` 的 on-type 层（词法 `kind === 'native'`），两层分工不变。

; ---- 开体：块头 → 体 +1 级 ----
[
  (table_head)
  (pool_head)
  (template_head)
  (native_head)
  (calc_head)
  (color_head)
  (random_head)
  (group_head)
  (while_head)
  (foreach_head)
  (repeat_head)
  (function_head)
  (weave_head)
  (condition_head)
  (else_head)
] @indent.increase

; 并列容器的 `align` 锚在**首项**上（不是栏头行末的零宽 `indent`）：栏头行末的锚会让消费者
; 把体对齐到栏头那一层。`.` 锚定 `block_body` 的头两枚子节点 = 栏头换行（`blank_line`）
; 与它的第一枚并列项（语法层的固定形状，见 `grammar.v2.js` 的 `block_body`）。

; ---- 并列：表的两列行（行与行同层） ----
(table_row) @indent.align

; ---- 并列：`# 池` 的 `?` 链体（首条分支锚定；分支头自己仍由 increase 开体） ----
(block
  open: (pool_head)
  body: (block_body
          .
          (indent)
          .
          (blank_line)
          .
          (_) @indent.align))

; ---- 并列：`@随机` 的候选层（首条候选锚定；单行候选与 `@组` 块同层） ----
(block
  open: (random_head)
  body: (block_body
          .
          (indent)
          .
          (blank_line)
          .
          (_) @indent.align))

; ---- 并列：`@组` 的组体（组里的行彼此同层） ----
(block
  open: (group_head)
  body: (block_body
          .
          (indent)
          .
          (blank_line)
          .
          (_) @indent.align))
