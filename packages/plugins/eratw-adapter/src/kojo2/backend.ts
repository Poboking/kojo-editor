/**
 * eraTW 的 `KojoEmitBackend` 实现（E4 的 backend 半边）—— **游戏事实只住本包**。
 *
 * 分层（设计稿 §1.1 / §10.2）：
 * - core 只给"请求"（文本三正交、演出块、随机候选、program 语句、`# 机`/`@织` 装配），
 *   不知道 ERB 长什么样；
 * - 本文件把请求落成 eraTW/Emuera 产物行：`PRINTFORM` 变体、`HPH_PRINT`、`SETCOLOR`/
 *   `RESETCOLOR`、`PRINT_FACE`/`PRINT_FACE_PLAYER`、`PRINTDATA`/`RAND+SELECTCASE`、
 *   `# 表`/`# 池` 的等值分派（`SELECTCASE`，形状在 `table-emit.ts` / `pool-emit.ts`）、
 *   `#PRI/#LATER/#ONLY`、`@函数` + 伴生 `_1`、`#DIM/#DIMS`；
 * - 所有引擎记号/模板/库函数名都从 **kojo2 数据**（`ERATW_PRESENTATION` / `ERATW_PROFILE` /
 *   `ERATW_EVENT_CATALOG`）与既有 `face-templates.ts`（口上函数名模板）派生，不抄第二份；
 * - 表达不了的构造**一律 fail-closed**（返回 `EmitFailure` + 诊断），不产半成品字节。
 *
 * ## 表达式端口
 *
 * 请求里的表达式是 core 的源切片（`KojoExprText`）。2.0 的表达式→ERB 编译属于宿主注入的
 * expression 管线（v1 `lowerExpression`），本包**不 import 任何插件**（解耦审计 C），
 * 故由工厂参数注入：
 *
 * ```ts
 * const backend = createEratwEmitBackend({
 *   compileExpression: (expr) => myExpressionPipeline(expr.text),
 *   charNo: '12',          // 口上函数模板的 {n}
 * });
 * ```
 *
 * ## profile 端口（K2-ADAPTER-PROFILE）
 *
 * 本 backend 的 `profile` 是**落点事实**（core 读它解析等待/随机/演出能力，发射器读它选
 * `PRINTFORM` 变体）。缺省 = `eratwLoweringProfile()`（全部从 kojo2 数据派生）；调用方可以
 * 两层注入（后者盖前者，合并/校验由 `profile-resolve.ts` 的纯函数负责）：
 *
 * - `adapterProfile`：`GameAdapter.profile`（**声明**）——按写死的映射表只搬落点字段；
 * - `profile`：生效覆盖（project / file profile）。
 *
 * 不传任何一层 ⇒ 产物与今天**逐字节相同**。传了非法值 ⇒ 建实例时就抛（fail-closed，
 * 不静默回缺省）：配置错不能被"看起来还能编"掩盖。
 *
 * ## 隐藏槽
 *
 * core 的 `@随机`/`# 表` 用 `__kojo_` 前缀的隐藏槽。Emuera 允许在 **ERB 函数内**用
 * `#DIM` / `#DIMS` 声明函数私有变量（`exfunc` 手册「定義」节），所以 eraTW 侧直接按
 * core 给的 `slots` 清单在**各自函数头**（主场景 `_1` / 每个 `@织` 监听）发声明：
 * 局部变量跨函数不可见，主场景的槽不会泄漏进监听函数。
 *
 * 本 backend **无状态**：不缓存槽映射、不从 body 反推；同输入同输出。
 */
import type { KojoAssignTarget, KojoExprText, KojoOptionItem, KojoRandomCandidate, KojoSpan, KojoTextPart } from '@kojo/kojo-core';
import type {
  AdapterProfile,
  AssignEmitRequest,
  BlankEmitRequest,
  CallEmitRequest,
  EmitFailure,
  EmitResult,
  ExprCallEmitRequest,
  FaceEmitRequest,
  ForEachEmitRequest,
  HintSupport,
  KojoEmitBackend,
  KojoHiddenSlot,
  KojoLoweringProfile,
  KojoDiagnostic,
  MachineWrapRequest,
  OptionsEmitRequest,
  PoolDispatchEmitRequest,
  RandomEmitRequest,
  ResolvedWait,
  TableDispatchEmitRequest,
  TextEmitRequest,
  WeaveEmitRequest,
} from '@kojo/kojo-core';
import { isEmitFailure, encodeEngineLiteral, encodeEngineText } from '@kojo/kojo-core';

import { createEratwFaceTable } from '../face-templates.js';
import type { KojoFaceTemplate } from '@kojo/plugin-api';
import { ERATW_EVENT_CATALOG } from './event-catalog.js';
import { emitEratwForEachLoop } from './foreach-emit.js';
import { emitOptions } from './options-emit.js';
import { emitPoolDispatch } from './pool-emit.js';
import { ERATW_PRESENTATION } from './presentation.js';
import type { EratwProfileOverrides } from './profile-resolve.js';
import { eratwAdapterProfileOverrides, resolveEratwProfile } from './profile-resolve.js';
import { emitTableDispatch } from './table-emit.js';

/* ============================== 工厂依赖（宿主注入） ============================== */

/** 表达式编译端口：源切片 → 引擎表达式；表达不了返回 EmitFailure（fail-closed） */
export type EratwCompileExpression = (expr: KojoExprText) => string | EmitFailure;

/** 赋值左值编译端口；缺省 = 原样使用 `target.text`（宿主可注入别名/域符号展开） */
export type EratwCompileTarget = (target: KojoAssignTarget) => string | EmitFailure;

export interface EratwEmitDeps {
  /** **必填**：2.0 表达式源切片 → ERB 表达式（宿主注入 v1 expression 管线） */
  readonly compileExpression: EratwCompileExpression;
  /** 可选的赋值左值编译（缺省原样透传） */
  readonly compileTarget?: EratwCompileTarget;
  /** 口上函数模板的 `{n}`（角色号）；wrapper 用到 `{n}` 而缺省 → fail-closed */
  readonly charNo?: string;
  /** 口上函数模板的 `{t}`（别人版家族段；标准版空串） */
  readonly familySegment?: string;
  /** 口上函数模板的 `${段}` 选择（如 `指令` 的 `com` 段；缺省取 adapter 表首键） */
  readonly segments?: Readonly<Record<string, string>>;
  /**
   * 生效 profile 的**落点覆盖**（project / file profile；additive）。
   *
   * 只收落点字段（六个取色/等待/落点字段 + `presentations` / `programFeatures` 子开关）；
   * 缺省 = 不覆盖（产物与今天逐字节相同）。非法值/未知键 → 建实例时抛（fail-closed）。
   */
  readonly profile?: EratwProfileOverrides;
  /**
   * adapter 侧**声明**（`GameAdapter.profile`；additive）。
   *
   * 按 `ERATW_ADAPTER_PROFILE_LANDING` 写死映射表只搬六个落点字段——声明与落点因此同源，
   * 不会一边改口径、另一边按缺省发。`features` / `programFeatures` / `presentations` /
   * `priorityModel` 故意**不搬**（声明面与落点面分开，双源对拍才有效）。
   */
  readonly adapterProfile?: AdapterProfile;
}

/* ============================== 常量（全部数据派生） ============================== */

/** 口上函数表（既有 adapter 单一真源；本文件只消费不解释） */
const FACE_TABLE = createEratwFaceTable();

/** core 的行尾提示词（§4.8）；eraTW 只认识这一枚演出提示 */
const HEART_HINT = '心形';

/** `@织` 修饰词 → Emuera 事件函数属性（§8.6 / 附录 B.1） */
const WEAVE_PRIORITY_ATTR: Readonly<Record<'pri' | 'later' | 'only', string>> = Object.freeze({
  pri: '#PRI',
  later: '#LATER',
  only: '#ONLY',
});

/** 函数体缩进（1 级 = 4 空格；core 比对 body 时看 trimStart） */
const INDENT = '    ';

/** 隐藏槽/未实现构造的 fail-closed 诊断码（adapter 命名空间 `unit/*`） */
const BACKEND_INCOMPLETE = 'unit/backend-incomplete' as const;

/* ============================== 小工具 ============================== */

function diagnostic(code: typeof BACKEND_INCOMPLETE, message: string, span: KojoSpan): KojoDiagnostic {
  return Object.freeze({ code, severity: 'error', message, span });
}

function fail(message: string, span: KojoSpan): EmitFailure {
  return Object.freeze({ diagnostics: Object.freeze([diagnostic(BACKEND_INCOMPLETE, message, span)]) });
}

/** 一行的作者批注里不能落换行（会把产物切行）；制表/全角空格保留 */
function oneLineComment(text: string): string {
  return text.replace(/\r?\n/g, ' ');
}

/**
 * profile 读数：**逐字段从 kojo2 数据派生**（不写第二份默认值）。
 *
 * 现在是 `resolveEratwProfile()` 的无覆盖形态（同一份实现；profile 覆盖见
 * `profile-resolve.ts`）。`priorityModel` 由事件目录事实推：只要声明了 emuera 桶事件，
 * 才允许 之前/之后/接管。
 */
export function eratwLoweringProfile(): KojoLoweringProfile {
  return resolveEratwProfile();
}

/* ============================== 构建器 ============================== */

/**
 * 建一个 eraTW backend。
 *
 * 无状态：同输入同输出；一个实例可服务串行/并行编译（不保留跨文件事实）。
 *
 * profile 三层（缺省 → adapter 声明 → 生效覆盖）在这里合成一次并冻进实例；
 * 非法覆盖值会让本函数**抛错**（fail-closed，不静默回缺省）。
 */
export function createEratwEmitBackend(deps: EratwEmitDeps): KojoEmitBackend {
  const profile = resolveEratwProfile(
    deps.adapterProfile === undefined ? null : eratwAdapterProfileOverrides(deps.adapterProfile),
    deps.profile ?? null,
  );
  const { compileExpression } = deps;
  const compileTarget: EratwCompileTarget =
    deps.compileTarget ?? ((target: KojoAssignTarget) => target.text);

  /* ---------- 表达式端口 ---------- */

  const compile = (expr: KojoExprText): string | EmitFailure => compileExpression(expr);

  /** 赋值左值：宿主没注入时原样透传（别名/域符号由宿主 expression 端口负责） */
  const compileLValue = (target: KojoAssignTarget): string | EmitFailure => compileTarget(target);

  /* ---------- 作者文本（唯一编码器：core literal.ts） ---------- */

  /** 一行叙事文本的**格式串体**（已转义文本 + `%表达式%` 插值 / `\@条件?A#B\@`） */
  function renderFormatBody(parts: readonly KojoTextPart[], span: KojoSpan): string | EmitFailure {
    let out = '';
    for (const part of parts) {
      if (part.kind === 'text') {
        const encoded = encodeEngineText(part.text, { form: 'formatted', span });
        if (!encoded.ok) return Object.freeze({ diagnostics: encoded.diagnostics });
        out += encoded.body;
        continue;
      }
      if (part.cond !== undefined) {
        const cond = compile(part.cond.cond);
        if (isEmitFailure(cond)) return cond;
        const thenText = compile(part.cond.then);
        if (isEmitFailure(thenText)) return thenText;
        const elseText = compile(part.cond.else);
        if (isEmitFailure(elseText)) return elseText;
        out += `\\@${cond}?${thenText}#${elseText}\\@`;
        continue;
      }
      const value = compile(part.expr);
      if (isEmitFailure(value)) return value;
      out += `%${value}%`;
    }
    return out;
  }

  /** 颜绘实参：裸词 → `"词"`（编码器）；已带双引号的字符串原样；空串 = 占位 `""` */
  function renderFaceArg(expr: KojoExprText, span: KojoSpan): string | EmitFailure {
    const text = expr.text.trim();
    if (text.length === 0) return '""';
    if (text.startsWith('"')) {
      // 作者写的就是字符串字面量（parser 已校验成对）；原样进产物
      return text.includes('\r') || text.includes('\n') ? fail('颜绘实参不能跨行。', span) : text;
    }
    const encoded = encodeEngineLiteral(text, { form: 'plain', span });
    if (!encoded.ok) return Object.freeze({ diagnostics: encoded.diagnostics });
    return encoded.literal;
  }

  /* ---------- 隐藏槽 → 函数内变量声明 ---------- */

  /**
   * Emuera 允许在 **ERB 函数内**用 `#DIM` / `#DIMS` 声明函数私有变量（`exfunc` 手册）；
   * 隐藏槽就落在这里：声明形态由 core 给的**静态类型事实** `valueType` 决定
   * （`int` → `#DIM`；`string` → `#DIMS`；缺省 = int），**不从名字后缀猜类型**。
   *
   * 覆盖全部 `KojoHiddenSlotKind`（`table` / `random` / `template` / `foreach` / `pool`）：
   * 声明形态只由 `valueType` 决定，kind 只影响 core 的归类与 adapter 的可选命名策略，
   * 所以新增 `pool` 不需要新分支（池主语槽 = `#DIM`，与 `template` 同一落点）。
   */
  function slotDeclaration(slot: KojoHiddenSlot): string {
    const directive = slot.valueType === 'string' ? '#DIMS' : '#DIM';
    return `${directive} ${slot.name}`;
  }

  /** 一段 body 用到的槽声明（放函数头 `@…` 行之后、`#PRI/#LATER/#ONLY` 之后） */
  function slotDeclarations(slots: readonly KojoHiddenSlot[]): readonly string[] {
    return slots.map(slotDeclaration);
  }

  /* ---------- 文本三正交 ---------- */

  const waitLetter = (wait: ResolvedWait): 'W' | 'L' => (wait === 'wait' ? 'W' : 'L');

  /**
   * D 系打印是否可用（`profile.colorMode`）：`plain` = 本 adapter 不落 D 变体，
   * 一律非 D（D 系会忽略 `SETCOLOR`，`plain` 口径下连"默认色"也不借 D 表达）。
   */
  const dSystem = (): boolean => profile.colorMode === 'D';

  /**
   * **空文本体**的裸指令（`空行`，与 `lower/text.ts::lowerBlankLine` 同一通道）。
   *
   * 口径写死（v1 codegen `printLine` 短路径同源）：空行没有可着色内容，
   * - `等待` → D 系 `PRINTFORMDW`（D 可用时）/ `PRINTFORMW`（`plain` 时）；
   * - `续`   → 恒 `PRINTFORML`（**不加 D**：v1/语料的空行续写形态就是它，加了就是白送字节差）。
   */
  const emptyLineDirective = (wait: ResolvedWait): string =>
    wait === 'wait' ? `PRINTFORM${dSystem() ? 'D' : ''}W` : 'PRINTFORML';

  /**
   * 该行取色是否落在**默认色**（= 可以用 D 变体表达"不上色"）：
   * - 旁白看 `narrationColor`，台词（含池内裸引号）看 `dialogueColor`；
   * - `@着色` 块内恒非默认色（块色要 `SETCOLOR`，D 系忽略它）⇒ 非 D；
   * - `auto` 不是"默认色"证据（保守落非 D，不替作者猜）。
   */
  function defaultColorLine(dialogue: boolean, request: TextEmitRequest): boolean {
    if (request.color.kind !== 'profile') return false;
    const policy = dialogue ? profile.dialogueColor : profile.narrationColor;
    return policy === 'default';
  }

  function textLine(request: TextEmitRequest): EmitResult {
    const body = renderFormatBody(request.parts, request.span);
    if (isEmitFailure(body)) return body;

    const dialogue = request.speech.kind !== 'narration';
    const heart = presentationOpen('heart') ? ERATW_PRESENTATION.heart : null;

    // `(心形)` → HPH_PRINT(@"…","<mode>")：模式按 presentation 数据四象限
    if (heart !== null && request.hint === HEART_HINT && request.hintRole === 'supported') {
      const mode = dialogue
        ? request.wait === 'wait'
          ? heart.dialogue.wait
          : heart.dialogue.continue
        : request.wait === 'wait'
          ? heart.narration.wait
          : heart.narration.continue;
      return `CALL ${heart.engine}(@"${body}","${mode}")`;
    }

    const annotation =
      request.hint !== null && request.hintRole === 'annotation'
        ? ` ;(${oneLineComment(request.hint)})`
        : '';

    // 空文本体（`空行` 走 blank 通道；这里只防防御性空体）：v1 口径 = 裸 PRINTFORM 指令
    if (body.length === 0) {
      return `${emptyLineDirective(request.wait)}${annotation}`;
    }

    // `d` = 取色走默认色（旁白/台词各自的 profile 口径）且 D 系可用；块色恒非 D
    const d = dSystem() && defaultColorLine(dialogue, request);
    return `PRINTFORM${d ? 'D' : ''}${waitLetter(request.wait)} ${body}${annotation}`;
  }

  /* ---------- 演出 ---------- */

  /**
   * 演出面可用 = **数据声明了形状** ∧ **生效 profile 声明了能力**。
   *
   * 后半是 K2-ADAPTER-PROFILE 的补口：`presentations` 可被 project/file profile 关掉
   * （core 的能力闸读的就是它），适配器这一侧必须同口径——否则"声明不支持"却照样发字节。
   * 缺省两者都真 ⇒ 行为与今天逐字节相同。
   */
  function presentationOpen(feature: 'heart' | 'color' | 'face' | 'random' | 'options'): boolean {
    return profile.presentations[feature] === true;
  }

  function colorEnter(color: KojoExprText): EmitResult {
    const presentation = ERATW_PRESENTATION.color;
    if (presentation === null || !presentationOpen('color')) {
      return fail('当前 eraTW adapter 没有声明着色演出。', color.span);
    }
    const compiled = compile(color);
    if (isEmitFailure(compiled)) return compiled;
    return `${presentation.setColor} ${compiled}`;
  }

  function colorExit(): EmitResult {
    const presentation = ERATW_PRESENTATION.color;
    if (presentation === null || !presentationOpen('color')) return null;
    return presentation.resetColor;
  }

  function face(request: FaceEmitRequest): EmitResult {
    const presentation = ERATW_PRESENTATION.face;
    if (presentation === null || !presentationOpen('face')) {
      return fail('当前 eraTW adapter 没有声明颜绘演出。', request.span);
    }
    const object = request.object ?? 'me';
    const call = presentation.calls.find((item) => item.object === object);
    if (call === undefined) return fail(`颜绘对象“${object}”在 adapter 表里没有调用落点。`, request.span);

    const args: string[] = [];
    for (const arg of request.args) {
      const rendered = renderFaceArg(arg, request.span);
      if (isEmitFailure(rendered)) return rendered;
      args.push(rendered);
    }
    // 表情省略 = adapter 默认表情（`通常`）；尾部空占位省略，内部 `""` 保留
    if (args.length === 0) args.push(quoteDefaultExpression(presentation.defaultExpression));
    while (args.length > 0 && args[args.length - 1] === '""') args.pop();
    if (args.length === 0) args.push(quoteDefaultExpression(presentation.defaultExpression));

    return `CALL ${call.call}, ${call.receiverArg}, ${args.join(', ')}`.replace(/, $/, '');
  }

  function quoteDefaultExpression(text: string): string {
    const encoded = encodeEngineLiteral(text, { form: 'plain' });
    if (!encoded.ok) return `"${text}"`;
    return encoded.literal;
  }

  /* ---------- 随机 ---------- */

  /**
   * `@随机` 落点（与 core 的 `random-slot.valueType` 判据自洽）：
   * - 纯文本单行 + `randStyle = printdata` → `PRINTDATA/DATAFORM`（该落点不引用下标槽；
   *   全 `续` 不等待、全等待补一行 `WAIT`，混合同一候选族表达不了 → fail-closed）；
   * - 声明了 `printdatal`（DATALIST 落点）？本 adapter 数据没有该表 →
   *   **fail-closed**（不静默回退 PRINTDATA：那是另一个落点，行为不同）；
   * - 其余（多行/副作用/`rand-selectcase`/未声明的 printdatal 落点）→ `RAND + SELECTCASE`，
   *   槽是**候选下标 int**。
   */
  function randomBlock(
    request: RandomEmitRequest,
    lowerCandidate: (candidate: KojoRandomCandidate, index: number) => readonly string[],
  ): EmitResult {
    if (!presentationOpen('random')) {
      return fail('当前 eraTW adapter 没有声明 `@随机` 落点（presentations.random = false）。', request.span);
    }
    if (request.purity === 'single-line-text') {
      if (profile.randStyle === 'printdata') {
        const dataform = tryPrintData(request);
        if (dataform !== null) return dataform;
      } else if (profile.randStyle === 'printdatal') {
        return fail(
          'profile.randStyle = `printdatal`（DATALIST 落点）：当前 eraTW adapter 数据没有声明该候选表落点，不能生成候选表（fail-closed，不静默回退 PRINTDATA）。请改回 `printdata` 或声明该落点数据。',
          request.span,
        );
      }
    }
    return randSelectCase(request, lowerCandidate);
  }

  /**
   * 纯文本单行 → `PRINTDATA` 行数组。
   *
   * 等待轴由**全部候选**共同决定：全 `续` = 不等；全等待 = `ENDDATA` 后补 `WAIT`；
   * 混合 = 同一候选族无法逐候选等待 → fail-closed（不静默丢等待）。
   */
  function tryPrintData(request: RandomEmitRequest): EmitResult | null {
    const bodies: string[] = [];
    let waitCount = 0;
    let continueCount = 0;
    for (const candidate of request.candidates) {
      if (candidate.kind !== 'randomLine') return null;
      const line = candidate.line;
      if (line.kind !== 'textLine') return null;
      if (line.wait === 'wait') waitCount += 1;
      else continueCount += 1;
      const body = renderFormatBody(line.parts, line.span);
      if (isEmitFailure(body)) return body;
      bodies.push(body);
    }
    if (bodies.length === 0) return null;
    if (waitCount > 0 && continueCount > 0) {
      return fail(
        '`@随机` 的纯文本候选等待轴不一致（有的 `续`、有的会等待）：PRINTDATA 无法表达逐候选等待；请统一等待轴或改用 `@组` + `@原生`。',
        request.span,
      );
    }
    const lines = ['PRINTDATA', ...bodies.map((body) => `${INDENT}DATAFORM ${body}`), 'ENDDATA'];
    if (waitCount > 0) lines.push('WAIT');
    return lines;
  }

  function randSelectCase(
    request: RandomEmitRequest,
    lowerCandidate: (candidate: KojoRandomCandidate, index: number) => readonly string[],
  ): EmitResult {
    const slot = request.slot;
    const lines: string[] = [`${slot} = RAND:${request.candidates.length}`, `SELECTCASE ${slot}`];
    request.candidates.forEach((candidate, index) => {
      lines.push(`${INDENT}CASE ${index}`);
      for (const line of lowerCandidate(candidate, index)) lines.push(line.length === 0 ? '' : `${INDENT}${INDENT}${line}`);
    });
    lines.push('ENDSELECT');
    return lines;
  }

  /* ---------- 调度区 / program ---------- */

  function assign(request: AssignEmitRequest): EmitResult {
    const target = compileLValue(request.target);
    if (isEmitFailure(target)) return target;
    const value = compile(request.value);
    if (isEmitFailure(value)) return value;
    return `${target} ${request.op} ${value}`;
  }

  function call(request: CallEmitRequest): EmitResult {
    const args: string[] = [];
    for (const arg of request.args) {
      const value = compile(arg);
      if (isEmitFailure(value)) return value;
      args.push(value);
    }
    return `CALL ${request.name}(${args.join(', ')})`;
  }

  function exprCall(request: ExprCallEmitRequest): EmitResult {
    const value = compile(request.call);
    if (isEmitFailure(value)) return value;
    return value;
  }

  /* ---------- `@织` ---------- */

  /**
   * 监听函数的槽：ERB **函数私有变量跨函数不可见**，所以每个监听函数按自己的
   * `request.slots` 在函数头独立发 `#DIM` / `#DIMS`，不复用主场景体的槽声明。
   */
  function weaveHeader(request: WeaveEmitRequest): EmitResult {
    const spec = ERATW_EVENT_CATALOG.events.find((item) => item.event === request.event);
    if (spec === undefined) {
      return fail(`eraTW 事件目录没有“${request.event}”：无法装配监听函数。`, request.span);
    }

    // 预处理器必须紧贴 @ 行（Emuera 规则）：属性 → 本监听的槽声明
    const lines = [`;kojo2: @织 ${request.event}`, `@${spec.engine}`];
    for (const modifier of request.modifiers) lines.push(WEAVE_PRIORITY_ATTR[modifier]);
    lines.push(...slotDeclarations(request.slots));
    return lines;
  }

  function weaveFooter(): EmitResult {
    return null;
  }

  /* ---------- `# 机` 事件头 ---------- */

  /** 渲染口上函数名（`{t}` / `{n}` / `{i}` + `${段}`）；缺占位值即 fail-closed */
  function renderMachineName(machine: MachineWrapRequest['machine']): string | EmitFailure {
    const face = FACE_TABLE.faces[machine.event];
    if (face === undefined) {
      return fail(
        `eraTW adapter 的 face-templates 没有“${machine.event}”面：无法从既有模板派生根机函数名（不手抄第二套命名）。`,
        machine.span,
      );
    }
    let name = applySegments(face, machine, machine.span);
    if (isEmitFailure(name)) return name;

    if (name.includes('{n}')) {
      if (deps.charNo === undefined || deps.charNo.length === 0) {
        return fail('口上函数名含 {n}（角色号），但 backend 没注入 charNo：装配不了事件头。', machine.span);
      }
      name = name.replaceAll('{n}', deps.charNo);
    }
    if (name.includes('{i}')) {
      const index = machine.args[0];
      if (index === undefined || index.length === 0) {
        return fail(`口上函数名含 {i}（编号），但 \`# 机 ${machine.event}\` 没有给参数。`, machine.span);
      }
      name = name.replaceAll('{i}', index);
    }
    name = name.replaceAll('{t}', deps.familySegment ?? '');
    if (name.includes('{') || name.includes('$')) {
      return fail(`口上函数名模板含未声明占位符（求值后残留：“${name}”）。`, machine.span);
    }
    return name;
  }

  /** `${段}` 求值：优先 deps.segments 选择，缺省取 adapter 表首键（声明序） */
  function applySegments(
    face: KojoFaceTemplate,
    machine: MachineWrapRequest['machine'],
    span: KojoSpan,
  ): string | EmitFailure {
    const segments = face.segments;
    if (segments === undefined) return face.template;
    let out = face.template;
    for (const segName of Object.keys(segments)) {
      const map = segments[segName];
      if (map === undefined) continue;
      const token = '${' + segName + '}';
      if (!out.includes(token)) continue;
      const preferred = deps.segments?.[segName];
      const key =
        preferred !== undefined && map[preferred] !== undefined ? preferred : Object.keys(map)[0];
      const value = key === undefined ? undefined : map[key];
      if (value === undefined) {
        return fail(`口上函数名的 \${${segName}} 段在 adapter 表里没有取值。`, span);
      }
      out = out.replaceAll(token, value);
    }
    return out;
  }

  return Object.freeze({
    id: 'eratw',
    profile,

    /** 行尾提示：`(心形)` 是 adapter 声明过的演出；其余一律导演批注（不打印） */
    hintSupport(hint: string): HintSupport {
      if (hint !== HEART_HINT) return 'annotation';
      // 能力 = 数据有形状 ∧ 生效 profile 开着（旧口径只看数据；缺省下两者同真）
      return presentationOpen('heart') && ERATW_PRESENTATION.heart !== null ? 'supported' : 'unsupported';
    },

    text: { line: textLine },

    blank: {
      /**
       * 打空行：`等待` → `PRINTFORMDW`（`colorMode = plain` 时 `PRINTFORMW`）；`续` → `PRINTFORML`。
       *
       * 空行**没有可着色的内容**，故 D 字母只由 `profile.colorMode` 决定，且只出现在等待形
       * （见 {@link emptyLineDirective}）。缺省 `colorMode = D` ⇒ 与今天/v1 逐字节同口径。
       */
      line(request: BlankEmitRequest): EmitResult {
        return emptyLineDirective(request.wait);
      },
    },

    control: {
      // eraTW/Emuera 有 SIF（单语句条件）；core 可走 §5.2 优化
      sifSupported: true,
      ifHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        if (isEmitFailure(compiled)) return compiled;
        return `IF ${compiled}`;
      },
      elseIfHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        if (isEmitFailure(compiled)) return compiled;
        return `ELSEIF ${compiled}`;
      },
      elseHeader(): EmitResult {
        return 'ELSE';
      },
      ifFooter(): EmitResult {
        return 'ENDIF';
      },
      sifHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        if (isEmitFailure(compiled)) return compiled;
        return `SIF ${compiled}`;
      },
    },

    presentation: {
      colorEnter,
      colorExit,
      face,
      randomBlock,
      optionsBlock(request: OptionsEmitRequest, lowerItem: (item: KojoOptionItem, index: number) => readonly string[]): EmitResult {
        // 落点形状全部交给 `options-emit.ts`（数据派生；本文件只做能力/计划闸）。
        // 主链（expand/walk）总带 ETB 计划；缺计划 = 走的是无 adapter 能力闸的通用 lower，
        // 此时不猜按钮顺序/回传值 → fail-closed（不产半成品字节）。
        if (!presentationOpen('options')) {
          return fail('当前 eraTW adapter 没有开启「选项」UI（presentations.options = false）。', request.span);
        }
        if (request.plan === undefined) {
          return fail(
            '`选项` 请求缺少 ETB 计划（core 2.0 主链必带 plan）：不能确定按钮顺序/回传值，fail-closed。',
            request.span,
          );
        }
        return emitOptions({ plan: request.plan, lowerItem });
      },
      /**
       * `# 池` 可证等值落点（K2-POOL-SELECTCASE）：块形状全部交给 `pool-emit.ts`
       * （读 `ERATW_POOL_DISPATCH`）；core 只在可证等值时调用，本文件只做转调。
       *
       * 为什么**不按** `profile.poolStyle` 开关：`poolStyle` 声明的是"不可证时的兜底形状"
       * （eraTW = `IF / ELSEIF / ELSE`，由 core 自己发），`selectcase` 是**等值可证时的
       * 语义等价优化**（§7.1 / §10.2）——两者不是互斥的 profile 开关。所以本能力恒挂，
       * 由 core 的 `pool-plan` 决定用不用；`poolStyle` 只是落点事实面的读数。
       */
      poolDispatch(request: PoolDispatchEmitRequest): EmitResult {
        return emitPoolDispatch(request);
      },
    },

    weave: {
      weaveHeader,
      weaveFooter,
    },

    program: {
      sandboxEnter(): EmitResult {
        return null;
      },
      sandboxExit(): EmitResult {
        return null;
      },
      assign,
      call,
      exprCall,
      loopJump(mode: 'break' | 'continue'): EmitResult {
        return mode === 'break' ? 'BREAK' : 'CONTINUE';
      },
      returnValue(value: KojoExprText | null): EmitResult {
        if (value === null) return 'RETURN';
        const compiled = compile(value);
        if (isEmitFailure(compiled)) return compiled;
        return `RETURN ${compiled}`;
      },
      label(name: string): EmitResult {
        return `$${name}`;
      },
      jump(target: string): EmitResult {
        return `GOTO ${target}`;
      },
      whileHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        if (isEmitFailure(compiled)) return compiled;
        return `WHILE ${compiled}`;
      },
      whileFooter(): EmitResult {
        return 'WEND';
      },
      repeatHeader(count: KojoExprText): EmitResult {
        const compiled = compile(count);
        if (isEmitFailure(compiled)) return compiled;
        return `REPEAT ${compiled}`;
      },
      repeatFooter(): EmitResult {
        return 'REND';
      },
      forEachHeader(collection: KojoExprText): EmitResult {
        // 旧路径（无展开感知的块级预览）：`@巡` 的绑定必须由 plan 给（`forEachLoop`）；
        // 这里没有计划 ⇒ fail-closed，不猜绑定名。
        return fail(
          '`@巡` 的集合绑定（{值}/{下标}）必须由计划给出：本路径没有 ForeachLoopPlan，不能生成索引循环；请改用 `@循` 或 `@原生`。',
          collection.span,
        );
      },
      forEachFooter(): EmitResult {
        return 'NEXT';
      },
      forEachLoop(request: ForEachEmitRequest): EmitResult {
        // 落点形状全部交给 `foreach-emit.ts`（数据派生；本文件只做转调）。
        // core 已校验集合/绑定/长度并给槽名；这里只把计划与已降糖 body 落成 ERB。
        return emitEratwForEachLoop(request.plan, request.body, { compileExpression: compile });
      },
      /**
       * `# 表` 可证等值落点（K2-TABLE-SELECTCASE）：档位/兜底/缩进形状全部交给
       * `table-emit.ts`（读 `ERATW_TABLE_DISPATCH`）；判别式求值与各臂赋值行由 core 交来，
       * 本文件只做转调（不改写、不排序）。
       */
      tableDispatch(request: TableDispatchEmitRequest): EmitResult {
        return emitTableDispatch(request);
      },
    },

    wrapMachine(request: MachineWrapRequest): EmitResult {
      const name = renderMachineName(request.machine);
      if (isEmitFailure(name)) return name;

      const params: string =
        request.machine.args.length === 0
          ? ''
          : `(${request.machine.args
              .map((_arg: string, index: number) => (index === 0 ? 'ARG' : `ARG:${index}`))
              .join(', ')})`;

      const argsText = request.machine.args.length === 0 ? '' : ` ${request.machine.args.join(' ')}`;
      const lines: string[] = [
        `;kojo2: # 机 ${request.machine.event}${argsText}`,
        `@${name}${params}`,
        `CALL ${name}_1${params}`,
        'RETURN RESULT',
        '',
        `@${name}_1${params}`,
      ];
      // 预处理器必须紧贴 @ 行：本场景体用到的隐藏槽 → 函数私有变量（`#DIM/#DIMS`）
      lines.push(...slotDeclarations(request.slots));

      if (request.body.length === 0) {
        lines.push('LOCAL = 0');
      } else {
        lines.push(';-------------------------------------------------');
        lines.push(';記入チェック（=0, 非表示、1, 表示）');
        lines.push('LOCAL = 1');
        lines.push(';-------------------------------------------------');
        lines.push('IF LOCAL');
        for (const line of request.body) lines.push(line.length === 0 ? '' : `${INDENT}${line}`);
        lines.push('ENDIF');
      }
      lines.push('RETURN 1');
      return lines;
    },
  });
}
