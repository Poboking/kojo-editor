/**
 * Core 诊断码与诊断载荷。
 *
 * 纪律（设计稿 §10.6 / §11.3）：
 * - **core 码闭集，只增不改**；adapter 码必须带命名空间（`unit/*` `event/*` …）；
 * - error 阻断编译、warning 不阻断；所有诊断尽量带 span（可点回源行）；
 * - 码表与级别在这里**唯一定义**，任何消费方不得另抄一份字符串表。
 */
import type { KojoSpan } from './ast.js';

/**
 * core 首批稳定码（与设计稿 §11.3 一一对应；词法/迁移类为 C1 实现所需 additive 扩码）。
 *
 * **闭集只增不改**（§11.3 / §16.6 S5.6）：既有码的字符串、与文案/级别语义一律不动。
 * S5.6 批（码表补齐）additive 扩入：`core/pool/duplicate-case`、`core/func/arg-count`、
 * `core/array/whole-assign`、`core/weave/not-weavable`——每条都在声明处写清生产者、
 * 分工与消息模板；`core/decl/bad-array-size` 早已在表内（`# 变量 x 整数[0]` 仍按设计稿
 * §3.4.2「N 必须是正整数」拒收，不新增码、不放开 0 长）。
 *
 * LAU-D1 批（方言载体契约）additive 扩入**六枚**方言/载体码（`core/dialect/*` 三枚 +
 * `core/event/*` 两枚 + `core/carrier/unowned`），逐枚在声明处写清生产者、与既有码的分工、
 * 级别与消息模板；`# 方言` 词位本身的文法不在此批（本批只把断言当**输入参数**吃）。
 */
export type CoreDiagnosticCode =
  /* 词法与结构（C1 additive） */
  | 'core/lex/anchor'
  | 'core/lex/indent'
  | 'core/lex/interpolation'
  /* 声明与名字 */
  | 'core/decl/duplicate-name'
  | 'core/decl/unknown-type'
  | 'core/decl/bad-initializer'
  | 'core/decl/unknown-storage'
  | 'core/decl/reserved-name'
  | 'core/decl/unknown-name'
  | 'core/decl/unknown'
  | 'core/decl/not-top-level'
  | 'core/decl/bad-array-size'
  | 'core/decl/const-cycle'
  | 'core/decl/const-not-constant'
  | 'core/decl/missing-machine'
  | 'core/decl/multiple-machine'
  | 'core/decl/multiple-view'
  /* 类型与表达式 */
  | 'core/expr/type-mismatch'
  | 'core/expr/assign-to-constant'
  | 'core/expr/readonly-target'
  | 'core/expr/bad-index'
  | 'core/expr/index-out-of-range'
  | 'core/expr/divide-by-zero'
  | 'core/expr/not-expression'
  | 'core/expr/unknown-symbol'
  | 'core/expr/bad-literal'
  | 'core/expr/void-in-expression'
  /* 表 */
  | 'core/table/overlap'
  | 'core/table/bad-range'
  | 'core/table/cycle'
  | 'core/table/missing-default'
  | 'core/table/empty-default'
  | 'core/table/type-mismatch'
  | 'core/table/dynamic-endpoint'
  | 'core/table/value-empty'
  | 'core/table/no-rows'
  | 'core/table/default-not-last'
  /* 池与模板 */
  | 'core/pool/no-default'
  | 'core/pool/empty-branch'
  | 'core/pool/side-effect'
  | 'core/pool/no-view'
  | 'core/pool/unknown-call'
  | 'core/pool/cycle'
  | 'core/pool/default-not-last'
  /**
   * 等值分派计划里**同一主语下的等值键重复**（`lower/expand/pool-plan.ts`；§7.1 / §16.2 C2.6）。
   * 两档同值无法区分：`IF` 链取第一个命中，等值分派同样会静默取第一个 ⇒ 计划不自洽，
   * **fail-closed 不产字节**（调用方报完即停）。
   *
   * 与 `core/expr/not-expression` 的分工：后者是"这一行/这个条件根本不是表达式"（语法面）；
   * 本码是"形态完全合法、但两条分支落同一个键"（计划面）。此前借用前者，作者读到的
   * 提示指向了错误的修法方向。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里）。
   * 消息模板：`池「{池名}」的等值键 {整数} 重复出现（第 {i} / {j} 个分支）：等值分派会静默
   * 取第一个，必须改成互不相同的整数（§7.1）。`
   */
  | 'core/pool/duplicate-case'
  | 'core/template/missing-slot'
  | 'core/template/unexpected-slot'
  | 'core/template/multi-slot'
  | 'core/template/arg-count'
  | 'core/template/side-effect'
  /* 叙事与等待 */
  | 'core/narrative/bare-quote'
  | 'core/narrative/bare-narration'
  | 'core/narrative/unknown-speaker'
  | 'core/narrative/bad-hint'
  | 'core/wait/no-profile'
  | 'core/color/nested'
  | 'core/color/no-output'
  | 'core/color/unsupported'
  | 'core/face/unsupported'
  | 'core/face/args'
  /* 随机 */
  | 'core/random/one-candidate'
  | 'core/random/nested'
  | 'core/random/group-nested'
  | 'core/random/bare-control'
  | 'core/random/empty-line'
  | 'core/random/unsupported'
  /* 控制流与程序层 */
  | 'core/control/break-outside'
  | 'core/control/continue-outside'
  | 'core/control/bad-repeat'
  | 'core/control/constant-condition'
  | 'core/control/unsupported'
  | 'core/array/unsupported'
  /**
   * **数组整体赋值**（`sema/check.ts::checkNameAssign`；§3.4.2 / §9.2）。
   * `队列 = 1` 这类写法：2.0 不支持数组整体赋值（没有数组字面量 / 整体比较 / 切片），
   * 作者该写元素（`队列[下标] = 值`）或 `.长度` 只读读取。
   *
   * 与 `core/expr/type-mismatch` 的分工：后者说的是"值的类型和槽不匹配"（换个值还能写）；
   * 本码说的是"这个赋值目标整体就不收"（任何值都不行），修法完全不同。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里）。
   * 消息模板：`“{名字}”是数组：2.0 不支持数组整体赋值，请写元素（\`{名字}[下标]\`，§9.2）。`
   */
  | 'core/array/whole-assign'
  | 'core/goto/unsupported'
  | 'core/goto/unknown-label'
  | 'core/goto/duplicate-label'
  | 'core/goto/label-in-block'
  | 'core/goto/cross-unit'
  | 'core/goto/backward'
  | 'core/func/return-outside'
  | 'core/func/return-mixed'
  | 'core/func/missing-return'
  | 'core/func/void-value'
  /**
   * **`! 函名(...)` 的实参个数不符**（`sema/check.ts::checkCall`；§7.3）。
   * 两种成因同码：缺必填（形参没有默认值却没给）与多给（实参数超过形参表）。
   * 2.0 只按**位置**传参、没有可变参数 ⇒ 两种都是"这个调用根本落不到函数签名上"，
   * 此前完全静默（产物照发，运行期少/多参的语义由引擎猜）。
   *
   * 与 `core/template/arg-count` 的分工：后者只属于 `# 模板` 的插槽调用（模板有自己的
   * 形参口径，见 `template.ts`），**不得挪用**到 `@函` 调用上。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里）。
   * 消息模板（缺必填）：`函数“{名}”的第 {n} 个形参“{形参}”没有默认值：实参至少要给 {n} 个，
   * 这里只给了 {m} 个（§7.3）。`
   * 消息模板（多给）：`函数“{名}”只有 {n} 个形参：多出的 {m-n} 个实参不会传给函数（§7.3）。`
   */
  | 'core/func/arg-count'
  | 'core/func/recursion-unsupported'
  /* 原生与织入 */
  | 'core/native/empty'
  | 'core/native/indent'
  | 'core/native/disallowed-location'
  | 'core/weave/multiple-only'
  | 'core/weave/modifier-conflict'
  | 'core/weave/shadowed-listener'
  | 'core/weave/scene-inside'
  | 'core/weave/unsupported'
  /**
   * 事件在 adapter 目录里声明 **`weavable: false`**（`project/weave-layers.ts`；§8.6 / §16.3 A3.9）。
   * 事件形状认得出、`@织` 写法也合法，但这类事件运行期不会被监听调用 ⇒ 挂上去是死代码，
   * 逐块 `blocked`。
   *
   * 与 `core/weave/unsupported` 的分工：后者是"adapter 没有这个事件 / 优先级模型不落修饰词"
   * （能力面缺落点）；本码是"事件明确声明不可监听"（数据面拒收）。此前两者共用前者，
   * 作者看到的"未知事件"提示与事实相反。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里）。
   * 消息模板：`事件「{事件}」在 adapter 目录里声明为不可被 @织 监听（{落点}）——挂上去
   * 运行期不会执行，已阻断。`
   */
  | 'core/weave/not-weavable'
  /* 迁移、profile、feature */
  | 'core/migration/if'
  | 'core/migration/switch'
  | 'core/migration/loop'
  | 'core/migration/call-return'
  | 'core/migration/ask'
  | 'core/migration/hidden-timing'
  | 'core/migration/alias'
  | 'core/migration/color-option'
  | 'core/migration/comment'
  | 'core/migration/version'
  | 'core/migration/heart'
  | 'core/migration/color'
  | 'core/migration/random'
  | 'core/migration/data'
  | 'core/migration/branch'
  | 'core/migration/label'
  | 'core/migration/raw'
  | 'core/migration/timing'
  /**
   * **同形歧义的显式台账**（`migrate/index.ts`；K2-MIGRATE-SHAPE，§12.1 / §15.2.3）。
   *
   * v1 的 `角色：「…」` 行是**连前缀与引号一起打印**的旁白文本；2.0 同一行是台词（只打印引号内
   * 正文）。迁移器能证明「这个前缀不是 v1 说话人」时按旁白改写；证不出时（前缀正是 v1 文件头
   * `角色:` 声明的说话人，或文件没有说话人事实）**原样保留为台词**并报本码——不静默，也不阻断。
   *
   * 与 `core/migration/raw` 的分工：后者是"这句我们根本改不动"（如行尾半角括号会被 2.0 当表演
   * 提示，旁白改写会改变打印文本）；本码是"两种解读都说得通、按幂等优先保留台词"。
   *
   * 级别：warning（在 `CORE_WARNING_CODES` 里；迁移器显式标 warning，不进 `ok`）。
   * 消息模板：见 `migrate/index.ts::ambiguousDialogueMessage`。
   */
  | 'core/migration/ambiguous-dialogue'
  | 'core/migration/fullwidth-punct'
  | 'core/migration/wait'
  /* 存储期分配（project/storage，fail-closed 完整性面） */
  | 'core/storage/fingerprint-mismatch'
  | 'core/storage/snapshot-version'
  | 'core/storage/invalid-class'
  | 'core/storage/invalid-declaration'
  | 'core/storage/unknown-class'
  | 'core/storage/duplicate-key'
  | 'core/storage/duplicate-name'
  | 'core/storage/shape-changed'
  | 'core/storage/corrupt-snapshot'
  | 'core/storage/range-changed'
  | 'core/storage/exhausted'
  /*
   * 方言与载体（LAU-D1；`ARCH-language-unification.md` §5.5）。
   *
   * 两族纪律先说清：`unit/*` 与 `event/*` 是**适配器数据自己不合格**的自检码
   * （`ADAPTER_VALIDATION_CODES`），**作者写错了**走下面的 `core/…`。
   * 尤其 `event/unknown` 这个串今天已被 `validateGameAdapter` 与 `checkEvent` 占用，
   * 语义与级别都不动——下面那枚 `core/event/unknown` 是同义的**作者面**码，两者并存。
   */
  /**
   * **方言未绑定**（`dialect-resolver.ts::resolveDialectBinding`；§5.3 第 4 级）。
   * 识别链（`detect()` → `project.adapterId`）与工作区覆盖**都**拿不到，或拿到的方言
   * 没有 2.0 事实面 ⇒ 事实类服务按"无事实"降级（空结果 + 本码）。
   *
   * **绝不回落到任何默认方言**（D12）：回落 = 用另一个游戏的事实给当前文件出提示，
   * 那正是 §5.1 事实 1 里"错误的事实不报错"的病根。
   *
   * 级别：warning（在 `CORE_WARNING_CODES` 里）——降级本身不阻断编译，但必须可见
   * （铁律 4「内核不静默」）；与 `core/options/pending` 同档：状态清楚、产物照走。
   * 消息模板：`未绑定方言：识别链没有给出结论（也没有工作区覆盖），事实类服务按无事实降级。`
   */
  | 'core/dialect/unbound'
  /**
   * **方言断言/覆盖与识别链冲突**（§5.3 第 2、3 级；生产者是 `resolveDialectBinding`）。
   * 两种成因同码：① 工作区 `meta` 覆盖 ≠ `detect()` 结论（**以覆盖为准**，冲突仍报）；
   * ② 文件内 `# 方言 <id>` 的断言 ≠ 解析结果（断言只自证、不产生真源）。
   *
   * 与 `core/dialect/unbound` 的分工：那边是"什么都没有"，本码是"有两个说法、且互不相容"。
   * `# 方言` 词位本身的文法/词表不在本批（由 L5 车道的文法实现产生断言值，本批只吃注入的字符串）。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里；§5.3「不一致是 error，不是 warning」）。
   * 消息模板：`方言冲突：{来源}声明 {A}，识别链结论 {B}——按 {取值口径} 处理，冲突已阻断。`
   */
  | 'core/dialect/mismatch'
  /**
   * **响应带的方言与请求的方言不一致**（§5.4 第 2 行「错事实不报错」的执行点；LAU-D2 接线时发射）。
   * 供方在响应里自证 `dialect` + `factsVersion`，宿主与 `request.project.adapterId` 对账，
   * 分叉即本码——`EditorDocumentIdentity.dialect` 只是便利下传，**不是第二真源**，
   * 因此分叉一定是供方/宿主接线错了，而不是"两个都对"。
   *
   * 与 `core/dialect/mismatch` 的分工：那条发生在**解析期**（工程/文件级的方言来源互相冲突）；
   * 本条发生在**响应期**（解析已定，某次语言服务响应用错了方言）。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里）。
   * 消息模板：`{服务}的响应用的是方言 {响应方言}（事实 {响应版本}），当前工程是 {工程方言}：结果已丢弃。`
   */
  | 'core/dialect/response-mismatch'
  /**
   * **作者写了当前方言事件目录里没有的事件**（§5.5 第 1 行；`# 机` / `@织` / XML `command` 三条落点共用）。
   *
   * 与既有 `event/unknown`（`ADAPTER_VALIDATION_CODES.eventUnknown`）的分工：那条是**适配器族**，
   * 今天同时被 `validateGameAdapter`（默认事件不在表里）与 `checkEvent` 使用，**语义与级别一律不动**；
   * 本码是**作者面**的稳定码，供 `dialect lint`（LAU-D2）按 `(码, 方言)` 聚合，
   * 不与自检码混在一张表里，否则聚合与错配断言都会失真。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里；「未知事件 = error」是 spec §10.6 的既有口径）。
   * 消息模板：`方言 {方言} 的事件目录里没有“{事件}”。可用事件：{列表}。`
   */
  | 'core/event/unknown'
  /**
   * **事件写在了错误的载体上**（§5.5 第 2 行；LAU-D3 的 XML 面发射）。
   * 事件名在目录里存在，但 `carriers[]` 声明它属于另一个载体——写在 ERB 里就落不到引擎的派发点。
   *
   * 与 `core/event/unknown` 的分工：那条是"没有这个事件"（名字面）；本条是"事件有、地方错"
   * （载体面），修法完全不同（改名 vs 把这段挪进对应载体）。
   *
   * 级别：error（不在 `CORE_WARNING_CODES` 里）。
   * 消息模板：`事件“{事件}”属于 {声明载体} 载体，这份文件是 {实际载体}：挪到 {glob} 覆盖的文件里。`
   */
  | 'core/event/wrong-carrier'
  /**
   * **这份文件不在方言声明的任何载体归属里**（§5.5 第 6 行；生产者 `resolveDialectBinding`）。
   * 方言声明了 `carriers`，但该文件路径匹配不上任何一条 glob ⇒ 载体归属不明，
   * 事实类校验只能整面跳过（**不猜**它属于哪个载体）。
   *
   * 与 `core/event/wrong-carrier` 的分工：那条"知道载体、且载体写错了"；本条"连载体都判不出来"。
   * 与 `core/dialect/unbound` 的分工：那边是方言没绑定，这边方言是绑定的、只有文件归属缺。
   *
   * 级别：warning（在 `CORE_WARNING_CODES` 里）——归属缺失不否定已有事实，只是这一面的校验落空；
   * 想让方言覆盖它，补一条 `carriers` 即可（数据面改动，不动语法）。
   * 消息模板：`文件 {路径} 不在方言 {方言} 声明的任何载体归属里（carriers 的 glob 都没命中）：该文件的载体级校验跳过。`
   */
  | 'core/carrier/unowned'
  | 'core/options/pending'
  | 'core/profile/missing'
  | 'core/feature/unsupported';

/** warning 码（其余 core 码一律 error；码表唯一真源） */
export const CORE_WARNING_CODES: ReadonlySet<CoreDiagnosticCode> = new Set<CoreDiagnosticCode>([
  'core/color/no-output',
  'core/control/constant-condition',
  'core/goto/backward',
  'core/weave/shadowed-listener',
  'core/options/pending',
  // 迁移期专用：同形歧义只能保留现状并提示（不阻断迁移）。见码声明处的分工说明。
  'core/migration/ambiguous-dialogue',
  // LAU-D1：方言/载体归属的**降级面**（不阻断，但必须可见）；四枚 error 档
  // （方言冲突、响应错配、未知事件、事件落点错）刻意不进这张表，见各码声明处的级别说明。
  'core/dialect/unbound',
  'core/carrier/unowned',
]);

/** adapter 诊断命名空间（additive，不覆盖 core 码） */
export type AdapterDiagnosticNamespace =
  | 'unit'
  | 'event'
  | 'symbol'
  | 'text'
  | 'variant'
  | 'overlay'
  | 'raw';

export type AdapterDiagnosticCode = `${AdapterDiagnosticNamespace}/${string}`;

export type DiagnosticCode = CoreDiagnosticCode | AdapterDiagnosticCode;

export function isCoreCode(code: string): code is CoreDiagnosticCode {
  return code.startsWith('core/');
}

export function severityOf(code: CoreDiagnosticCode | string): 'error' | 'warning' {
  return isCoreCode(code) && CORE_WARNING_CODES.has(code) ? 'warning' : 'error';
}

/** 一条诊断（core 与 adapter 共用形状；`span` 缺省 = 无精确落点） */
export interface KojoDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly span: KojoSpan | null;
}

/** 诊断收集器：解析/降糖共用；**不静默**——抛错必须转成诊断或原样上抛 */
export interface DiagnosticSink {
  report(diagnostic: KojoDiagnostic): void;
  readonly all: readonly KojoDiagnostic[];
  hasError(): boolean;
}

export function createDiagnosticSink(): DiagnosticSink {
  const list: KojoDiagnostic[] = [];
  let errors = 0;
  return {
    report(diagnostic) {
      list.push(diagnostic);
      if (diagnostic.severity === 'error') errors++;
    },
    get all() {
      return list;
    },
    hasError() {
      return errors > 0;
    },
  };
}
