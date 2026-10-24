/**
 * eraFL 的 `KojoEmitBackend` 实现（入口 D）—— **游戏事实只住本包**。
 *
 * ## 与 eraTW 后端的关系：同引擎、不同落点
 *
 * eraFL 跑在 Emuera 上（真盘 `Emuera.exe` + `EmueraFL_v1.45-preview.exe`），所以
 * **通用 Emuera 面可照**：`PRINTFORM` 变体、`IF/ELSEIF/ELSE/ENDIF/SIF`、`WHILE/WEND`、
 * `REPEAT/REND`、`GOTO`/`$标号`、`CALL`/`RETURN`、`SETCOLOR`/`RESETCOLOR`、
 * `PRINTDATA/DATAFORM`、`RAND + SELECTCASE`。这些是**引擎语言**，不是某个游戏的私有形状。
 *
 * **不能照的是 `# 机`**：eraTW 的 kojo 文件本身就是引擎事件函数（`@EVENTTRAIN` 一族，
 * 一个角色一份），eraFL 的 kojo 是 **XML**（`KOJO_XML_REGISTER` 注册，引擎按
 * `KOJO_XML_CLASS_COM/EVENT/COMBAT` 查询），ERB 侧只剩注册壳。见 {@link wrapMachine}。
 *
 * ## 逐面裁决（2026-10-25 真盘读数）
 *
 * | 面 | eraFL | 依据 |
 * | --- | --- | --- |
 * | `text` | `PRINTFORML` / `PRINTFORMW`（+ D 变体） | `PRINTFORMD` 481 处、`PRINTFORMW` 系 24,047 处 |
 * | `blank` | 同 text（空行没有可着色内容） | 同上 |
 * | `control` | `IF` / `ELSEIF` / `ELSE` / `ENDIF` / `SIF` | Emuera 语言面；语料 `IF` 遍地 |
 * | `presentation.color` | `SETCOLOR` / `RESETCOLOR`（hex 字面量 `0x…`） | `SETCOLOR` 1,932 处（口上域 134） |
 * | `presentation.face` | **fail-closed** | `ERAFL_PRESENTATION.face = null`：颜绘在 XML 属性侧 |
 * | `presentation.heart` | **fail-closed** | `heart = null`：心形演出 eraFL 无 ERB 落点 |
 * | `presentation.options` | **fail-closed** | `options = null`：口上域无选项 UI |
 * | `presentation.random` | `PRINTDATA`（纯文本）/ `RAND+SELECTCASE`（多行、有副作用） | `PRINTDATA` 404 处 |
 * | `weave`（`@织`） | **fail-closed** | 全树 `#PRI` / `#LATER` / `#ONLY` **零处**——没有语料证据前不假装支持 |
 * | `program` | 照 Emuera（`ARRAYS/WHILE/GOTO/REPEAT` 开；`foreach/recursion` 由 adapter 声明关） | `program.ts` 逐项读数 |
 * | `wrapMachine` | `@<引擎事件>` + `#LATER` + body | 见下 |
 *
 * ## `# 机` 的落点（本批唯一的设计决定）
 *
 * 真盘事实三条：
 * 1. 四个引擎事件（`EVENTFIRST` / `EVENTLOAD` / `EVENTSHOP` / `EVENTBUY`）**各只有一份
 *    定义，都在系统文件里**（`NEWGAME.ERB:76` / `SAVELOAD.ERB:441` / `SHOP.ERB:6,113`）；
 * 2. 这些系统函数**自带流程**（`EVENTFIRST` 末尾 `BEGIN TITLE`、`EVENTSHOP` 里
 *    `JUMP FL_TRAIN`）——直接重定义会**顶掉系统逻辑**（静默灾难），裸 `#PRI` 则会在
 *    初始化之前跑；
 * 3. 作者的 ERB 口上钩子是 `@KOJO_EVENT_K{角色号}(ARG)`（4 份真盘样例，
 *    `TRYCCALLFORM KOJO_EVENT_K{n}, ARG:1` 调用，`ARG` = `CSV/KojoEvent.CSV` 的事件号），
 *    那是**口上事件**、不是引擎事件——与本 adapter 的 `eventCatalog`（四个引擎事件）
 *    不是同一条轴。
 *
 * 所以本批的落点是：**`@<引擎事件>` + `#LATER`**——Emuera 的事件桶机制让"作者体"
 * 在系统函数之后被调用，既不顶掉系统逻辑，也不在初始化之前跑。`#LATER` 是 Emuera
 * 引擎语言（eraTW 的 2,285 份口上在用它），不是 eraFL 私有语法；eraFL 语料自身零使用
 * 只说明"原生语料没写过"，不构成"引擎不支持"。
 *
 * 若作者要的是**口上事件**（`KOJO_EVENT_K{n}(ARG)` 那条轴），本批**不猜**：
 * `eventCatalog` 里没有那些事件（它们不是引擎事件），写 `# 机 告白成功` 会在 core 侧
 * 报 `event/unknown` 并列出四个真事件——这是如实拒绝，不是静默降级。
 *
 * ## 表达式端口
 *
 * 与 eraTW 同一条：请求里的表达式是 core 的源切片，落到 ERB 由宿主注入的
 * expression 管线负责（本包不 import 任何插件——解耦审计 C）。
 *
 * ## 无状态
 *
 * 不缓存、不从 body 反推；同输入同输出（一个实例可服务串行/并行编译）。
 */
import type {
  AssignEmitRequest,
  BlankEmitRequest,
  CallEmitRequest,
  EmitFailure,
  EmitResult,
  ExprCallEmitRequest,
  FaceEmitRequest,
  HintSupport,
  KojoAssignTarget,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoExprText,
  KojoHiddenSlot,
  KojoLoweringProfile,
  KojoRandomCandidate,
  KojoSpan,
  KojoTextPart,
  MachineWrapRequest,
  OptionsEmitRequest,
  RandomEmitRequest,
  ResolvedWait,
  TextEmitRequest,
  WeaveEmitRequest,
} from '@kojo/kojo-core';
import { encodeEngineText, isEmitFailure } from '@kojo/kojo-core';

import { ERAFL_EVENT_CATALOG } from './event-catalog.js';
import { ERAFL_PRESENTATION } from './presentation.js';
import { ERAFL_PROFILE } from './profile.js';
import { ERAFL_PROGRAM_FEATURES } from './program.js';

/* ============================== 常量（全部数据派生） ============================== */

/** 函数体缩进（1 级 = 4 空格；core 比对 body 时看 trimStart） */
const INDENT = '    ';

/** 本文件 fail-closed 的诊断码（adapter 命名空间 `unit/*`） */
const BACKEND_INCOMPLETE = 'unit/backend-incomplete' as const;

/**
 * 行尾提示 `(心形)`：eraFL 的 `presentation.heart = null` ⇒ 明确不支持。
 * 其余提示名一律按**导演批注**处理（不进玩家文本），与 eraTW 同口径。
 */
const HEART_HINT = '心形';

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

/* ============================== profile ============================== */

/**
 * eraFL 的落点 profile：**逐字段从 kojo2 数据派生**（不写第二份默认值）。
 *
 * - 落点字段（等待/取色/D/池/随机）直接取 `ERAFL_PROFILE`（真盘读数）；
 * - `presentations` 按 `ERAFL_PRESENTATION` 有无形状给：**有数据面 = 能力开**，
 *   `null` = 关（与 core 的"数据没声明形状就不发字节"同一条判据）；
 * - `priorityModel` 由事件目录推：只要有事件声明了 `emuera-buckets` 就允许桶修饰。
 *
 * 本批**不收**调用方覆盖（project/file profile）：那是独立的一层，eraTW 侧已有
 * `profile-resolve.ts` 的实现与测试；eraFL 的覆盖需求尚无验收线，先不预埋
 * （预埋 = 一条没人验证的配置面）。
 */
export function eraflLoweringProfile(): KojoLoweringProfile {
  const buckets = ERAFL_EVENT_CATALOG.events.some((spec) => spec.priority === 'emuera-buckets');
  return Object.freeze({
    waitDefault: ERAFL_PROFILE.waitDefault,
    narrationColor: ERAFL_PROFILE.narrationColor,
    dialogueColor: ERAFL_PROFILE.dialogueColor,
    colorMode: ERAFL_PROFILE.colorMode,
    poolStyle: ERAFL_PROFILE.poolStyle,
    randStyle: ERAFL_PROFILE.randStyle,
    priorityModel: buckets ? 'emuera-buckets' : 'none',
    presentations: Object.freeze({
      heart: ERAFL_PRESENTATION.heart !== null,
      color: ERAFL_PRESENTATION.color !== null,
      face: ERAFL_PRESENTATION.face !== null,
      // `@随机` 的落点能力：PRINTDATA 与 RAND+SELECTCASE 都是引擎语言，恒可用
      random: true,
      options: ERAFL_PRESENTATION.options !== null,
    }),
    programFeatures: ERAFL_PROGRAM_FEATURES,
  });
}

/* ============================== 工厂依赖 ============================== */

/** 表达式编译端口：源切片 → 引擎表达式；表达不了返回 `EmitFailure`（fail-closed） */
export type EraflCompileExpression = (expr: KojoExprText) => string | EmitFailure;

/** 赋值左值编译端口；缺省 = 原样使用 `target.text` */
export type EraflCompileTarget = (target: KojoAssignTarget) => string | EmitFailure;

export interface EraflEmitDeps {
  /** **必填**：2.0 表达式源切片 → ERB 表达式（宿主注入） */
  readonly compileExpression: EraflCompileExpression;
  /** 可选的赋值左值编译（缺省原样透传） */
  readonly compileTarget?: EraflCompileTarget;
}

/* ============================== 构建器 ============================== */

/** 建一个 eraFL backend（无状态；同输入同输出）。 */
export function createEraflEmitBackend(deps: EraflEmitDeps): KojoEmitBackend {
  const profile = eraflLoweringProfile();
  const compile = (expr: KojoExprText): string | EmitFailure => deps.compileExpression(expr);
  const compileLValue = (target: KojoAssignTarget): string | EmitFailure =>
    deps.compileTarget === undefined ? target.text : deps.compileTarget(target);

  /* ---------- 作者文本（唯一编码器：core literal.ts） ---------- */

  /** 一行叙事文本的格式串体（已转义文本 + `%表达式%` 插值 / `\@条件?A#B\@`） */
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

  /* ---------- 隐藏槽 → 函数内变量声明 ---------- */

  /** `int` → `#DIM`；`string` → `#DIMS`（按 core 给的**类型事实**，不从名字猜） */
  function slotDeclaration(slot: KojoHiddenSlot): string {
    return `${slot.valueType === 'string' ? '#DIMS' : '#DIM'} ${slot.name}`;
  }

  /* ---------- 等待轴 ---------- */

  const waitLetter = (wait: ResolvedWait): 'W' | 'L' => (wait === 'wait' ? 'W' : 'L');

  /**
   * D 系是否可用：`profile.colorMode === 'D'`（eraFL 实测 `PRINTFORMD` 481 处）。
   * 但 D 系**忽略 `SETCOLOR`**，所以只有"本行取色落在默认色"时才能用 D 变体表达；
   * eraFL 的 `narrationColor` / `dialogueColor` 都是 `author`（作者自订色 1,932 处）
   * ⇒ 实际几乎总是非 D。判据与 eraTW 同源，不另立一套。
   */
  const dSystem = (): boolean => profile.colorMode === 'D';

  function defaultColorLine(dialogue: boolean, request: TextEmitRequest): boolean {
    if (request.color.kind !== 'profile') return false;
    const policy = dialogue ? profile.dialogueColor : profile.narrationColor;
    return policy === 'default';
  }

  /** 空行裸指令（空行没有可着色内容；等待形才带 D，与 v1 codegen 同口径） */
  const emptyLineDirective = (wait: ResolvedWait): string =>
    wait === 'wait' ? `PRINTFORM${dSystem() ? 'D' : ''}W` : 'PRINTFORML';

  /* ---------- 文本三正交 ---------- */

  function textLine(request: TextEmitRequest): EmitResult {
    const body = renderFormatBody(request.parts, request.span);
    if (isEmitFailure(body)) return body;

    // `(心形)`：eraFL 数据没声明心形演出 ⇒ 报错（不静默当普通文本打印）
    if (request.hint === HEART_HINT && request.hintRole === 'supported') {
      return fail(
        'eraFL adapter 没有声明心形演出（presentation.heart = null）：`(心形)` 在 eraFL 无 ERB 落点，不生成产物。',
        request.span,
      );
    }

    const annotation =
      request.hint !== null && request.hintRole === 'annotation'
        ? ` ;(${oneLineComment(request.hint)})`
        : '';

    if (body.length === 0) return `${emptyLineDirective(request.wait)}${annotation}`;

    const dialogue = request.speech.kind !== 'narration';
    const d = dSystem() && defaultColorLine(dialogue, request);
    return `PRINTFORM${d ? 'D' : ''}${waitLetter(request.wait)} ${body}${annotation}`;
  }

  /* ---------- 演出 ---------- */

  function colorEnter(color: KojoExprText): EmitResult {
    const presentation = ERAFL_PRESENTATION.color;
    if (presentation === null) return fail('eraFL adapter 没有声明着色演出。', color.span);
    const compiled = compile(color);
    if (isEmitFailure(compiled)) return compiled;
    return `${presentation.setColor} ${compiled}`;
  }

  function colorExit(): EmitResult {
    const presentation = ERAFL_PRESENTATION.color;
    return presentation === null ? null : presentation.resetColor;
  }

  /** 颜绘：eraFL 在 XML 属性侧（`kojoPlace`/`emotion`），ERB 面没有落点 ⇒ fail-closed */
  function faceUnsupported(span: KojoSpan): EmitResult {
    return fail(
      'eraFL 的颜绘在口上 XML 属性侧（emotion / 立绘 XML），ERB 表达式面无落点：`@颜绘` 不生成产物。',
      span,
    );
  }

  /* ---------- 随机 ---------- */

  /**
   * 纯文本单行候选 → `PRINTDATA/DATAFORM`（eraFL `PRINTDATA` 404 处）。
   * 等待轴必须一致：全 `续` = 不等；全等待 = `ENDDATA` 后补 `WAIT`；混合 ⇒ fail-closed。
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
      for (const line of lowerCandidate(candidate, index)) {
        lines.push(line.length === 0 ? '' : `${INDENT}${INDENT}${line}`);
      }
    });
    lines.push('ENDSELECT');
    return lines;
  }

  function randomBlock(
    request: RandomEmitRequest,
    lowerCandidate: (candidate: KojoRandomCandidate, index: number) => readonly string[],
  ): EmitResult {
    // 等待轴的 PRINTDATA 只在 `randStyle = printdata` 且候选是纯文本单行时尝试；
    // 其余（多行 / 有副作用）走 RAND + SELECTCASE（§8.4），不做静默回落。
    if (request.purity === 'single-line-text' && profile.randStyle === 'printdata') {
      const dataform = tryPrintData(request);
      if (dataform !== null) return dataform;
    }
    return randSelectCase(request, lowerCandidate);
  }

  /* ---------- program ---------- */

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

  return Object.freeze({
    id: 'erafl',
    profile,

    /** 行尾提示：eraFL 只认识 `心形` 且**明确不支持**；其余一律导演批注（不打印） */
    hintSupport(hint: string): HintSupport {
      if (hint !== HEART_HINT) return 'annotation';
      return profile.presentations.heart ? 'supported' : 'unsupported';
    },

    text: { line: textLine },

    blank: {
      line(request: BlankEmitRequest): EmitResult {
        return emptyLineDirective(request.wait);
      },
    },

    control: {
      // Emuera 有 SIF（单语句条件）
      sifSupported: true,
      ifHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        return isEmitFailure(compiled) ? compiled : `IF ${compiled}`;
      },
      elseIfHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        return isEmitFailure(compiled) ? compiled : `ELSEIF ${compiled}`;
      },
      elseHeader(): EmitResult {
        return 'ELSE';
      },
      ifFooter(): EmitResult {
        return 'ENDIF';
      },
      sifHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        return isEmitFailure(compiled) ? compiled : `SIF ${compiled}`;
      },
    },

    presentation: {
      colorEnter,
      colorExit,
      face(request: FaceEmitRequest): EmitResult {
        return faceUnsupported(request.span);
      },
      randomBlock,
      optionsBlock(request: OptionsEmitRequest): EmitResult {
        return fail(
          'eraFL 的口上域没有选项 UI（presentation.options = null）：`选项` 不生成产物；eraFL 的选择肢在 XML/指令侧。',
          request.span,
        );
      },
    },

    weave: {
      /**
       * `@织` 监听：eraFL 语料**零** `#PRI/#LATER/#ONLY`——没有语料证据前不假装支持。
       * 事件目录里 `weavable: true` 是"监听内错误无隔离"的事实说明，不是"本 backend 能装配"。
       */
      weaveHeader(request: WeaveEmitRequest): EmitResult {
        return fail(
          'eraFL 语料没有任何 `#PRI / #LATER / #ONLY` 用法（0 处）：本版不装配 `@织` 监听函数（有语料证据后再开）。',
          request.span,
        );
      },
      weaveFooter(): EmitResult {
        return null;
      },
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
      exprCall(request: ExprCallEmitRequest): EmitResult {
        return compile(request.call);
      },
      loopJump(mode: 'break' | 'continue'): EmitResult {
        return mode === 'break' ? 'BREAK' : 'CONTINUE';
      },
      returnValue(value: KojoExprText | null): EmitResult {
        if (value === null) return 'RETURN';
        const compiled = compile(value);
        return isEmitFailure(compiled) ? compiled : `RETURN ${compiled}`;
      },
      label(name: string): EmitResult {
        return `$${name}`;
      },
      jump(target: string): EmitResult {
        return `GOTO ${target}`;
      },
      whileHeader(test: KojoExprText): EmitResult {
        const compiled = compile(test);
        return isEmitFailure(compiled) ? compiled : `WHILE ${compiled}`;
      },
      whileFooter(): EmitResult {
        return 'WEND';
      },
      repeatHeader(count: KojoExprText): EmitResult {
        const compiled = compile(count);
        return isEmitFailure(compiled) ? compiled : `REPEAT ${compiled}`;
      },
      repeatFooter(): EmitResult {
        return 'REND';
      },
      /**
       * 旧路径的 `@巡`（无计划）：eraFL `programFeatures.foreach = false`，core 本就不会
       * 走到这里；真走到也 fail-closed（不猜绑定名）。
       */
      forEachHeader(collection: KojoExprText): EmitResult {
        return fail(
          '`@巡` 在 eraFL 未开启（programFeatures.foreach = false）：请改用 `@循` 或 `@原生`。',
          collection.span,
        );
      },
      forEachFooter(): EmitResult {
        return 'NEXT';
      },
    },

    /**
     * `# 机` → `@<引擎事件>` + `#LATER` + body。
     *
     * 用桶修饰而不是裸定义的理由（三条真盘事实，见文件头）：四个引擎事件各只有一份
     * 系统定义且自带流程；裸重定义会顶掉系统逻辑，`#PRI` 会在初始化前跑，`#LATER`
     * 让作者体在系统流程之后被调用——这是 Emuera 事件桶机制的标准用法（eraTW 2,285
     * 份口上在用），不是 eraFL 私有语法。
     *
     * body 行按原顺序原样嵌入（只加缩进），wrapper 行只在 body 前后——source map 靠它找回。
     */
    wrapMachine(request: MachineWrapRequest): EmitResult {
      const spec = ERAFL_EVENT_CATALOG.events.find((item) => item.event === request.machine.event);
      if (spec === undefined) {
        return fail(
          `eraFL 事件目录没有“${request.machine.event}”：可用的只有 ${ERAFL_EVENT_CATALOG.events
            .map((item) => item.event)
            .join(' / ')}。`,
          request.machine.span,
        );
      }
      const argsText = request.machine.args.length === 0 ? '' : ` ${request.machine.args.join(' ')}`;
      const lines: string[] = [`;kojo2: # 机 ${request.machine.event}${argsText}`, `@${spec.engine}`];
      // 预处理器必须紧贴 @ 行：事件桶修饰 + 本场景体用到的隐藏槽
      lines.push('#LATER');
      for (const slot of request.slots) lines.push(slotDeclaration(slot));
      for (const line of request.body) lines.push(line.length === 0 ? '' : `${INDENT}${line}`);
      return lines;
    },
  });
}
