/**
 * Kojo 2.0 迁移引擎（v1 `.kojo` → 2.0 `.kojo2`）——M7 / 设计稿 §12.1。
 *
 * 契约（纯函数、零 IO、不产半成品）：
 * ```
 * migrateKojoSource(source, options?) → {
 *   ok;                 // 全部行都机械迁移成功才为 true；false = 调用方**不许写盘**
 *   code;               // 迁移结果文本；ok=false 时不可迁移区间**原样保留**（不是半成品）
 *   sourceMap;          // 新行（1 基）→ 旧行（1 基）；数组下标 = 新行-1
 *   diagnostics;        // 迁移报告：warning=可迁移但需人工复核；error=不可迁移（同时进 unsupported）
 *   unsupported;        // 台账：{line, construct, targetHint, code}——每项对应一段原样保留的旧写法
 *   metadata;           // 从 v1 文件头搬到 adapter/工程配置的元数据（additive，不丢信息）
 * }
 * ```
 *
 * 纪律：
 * 1. **机械改写必须语义保持**：只做 §12.1 能逐字说清的那批；条件/表达式/实参原文照搬，
 *    不降糖、不猜名字（2.0 前端的活）。
 * 2. **不可机械迁移 = 原块不写**：整块（块头 + 缩进体）**逐字节原样**留在 `code` 里并记
 *    `unsupported`，`ok=false`——调用方见 false 即拒绝落盘，绝不产生"半旧半新"的文件。
 *    （原样保留含**原缩进**：那是 v1 文本，迁移器不改写；该文件本来就不该被写出。）
 * 3. **幂等**：已经 2.0 的行原样放行；`migrate(migrate(v1))` 逐字节等于 `migrate(v1)`。
 * 4. **失败可见**：每个 unsupported 都有 `core/migration/*` 码 + 目标写法提示 + 源行号。
 * 5. **`@` 原生块**：v1 的 `@NAME` 是 **ERB 函数头**（不是 2.0 锚点），迁进 `@原生` 围栏后
 *    那一行**逐字节保留**（剥掉 `@` 就丢了 ERB 函数声明）；围栏体按 §8.5 去掉最小基准缩进、
 *    再整体缩进一级。
 * 6. **文件头元数据不丢**：`角色:` 作裸台词说话人，其余声明进 `metadata`（2.0 没有这些行；
 *    字段属于 adapter / 工程配置，见 §15.2.3）。
 * 7. **v1 台词的引号是内容**（K2-MIGRATE-QUOTE，2026-10-22 裁决）：v1 把 `「…」` 行**连引号一起打印**
 *    （`PRINTFORMW 「涩涩的话」`），2.0 的 `角色：「…」` 引号是**语法**、只剥最外层那一对（首 `「`
 *    … 末 `」`，见 `lexer.ts::classifyDialogue`）。所以 v1 台词的打印文本**原样**放进 2.0 正文：
 *    `灵梦：「「涩涩的话」」` ⇒ 2.0 打印 `「涩涩的话」`，与 v1 逐字一致。依据：
 *    - §12.1「裸台词 `「…」` → `角色：「…」`」+ §15.2.3「只换行首分类；PRINT 变体、插值、转义复用」
 *      ——迁移只改行首分类，正文（含 v1 引号）不再改；
 *    - §2.6 的转义闭集只有行首 `\` / `\{` / `\}` / `\\`，`「」「」` 不是需要转义的字符（§4.13 叙事区
 *      本来就用全角 `「」`），因此这里不需要（也不能）用反斜杠"转义"，可打印形态就是放在 2.0 正文里；
 *    - §4.8 的规范级约束管的是"作者文本进引擎字面量"（`"`/`\` 由 `literal.ts` 唯一编码器处理），
 *      台词正文的 `「」` 不是引擎字面量特殊字符。
 *    **心形**是 v1 唯一把引号当语法的路径（`HPH_PRINT` 的实参不含引号），迁移按 v1 同一判据
 *    （`stripQuotesForHeart`：首个闭合引号必须收在行尾）剥；多段文本（`「甲」「乙」`）v1 原样打印，
 *    这里也走"打印文本原样进正文"。
 * 8. **`时机` 面词不猜**（K2-EVENT-FACEWORD）：调用方把 adapter `eventCatalog` 的名字投影经
 *    `options.eventNames` 传进来时，面词必须是其中之一，否则迁移期 unsupported（不产 `# 机`）；
 *    命名参数（`成否:` / `类型:` / `参数:`）一律 unsupported 并给 adapter 事件配置的目标提示。
 *    没传目录 = 调用方没给 adapter 事实，沿用 v1 形状判定（不内置任何事件名——core 零游戏知识）。
 */
import type { CoreDiagnosticCode, KojoDiagnostic } from '../diagnostics.js';
import type { KojoSpan } from '../ast.js';
import {
  classifyV1,
  hasWaitMark,
  isChoiceItem,
  isKojo2Line,
  rewriteWaitAlias,
  TARGET_HINTS,
  type Classified,
  type V1Kind,
} from './classify.js';
import {
  indentOfLevel,
  isBlankBody,
  lineSpan,
  readSource,
  type Eol,
  type V1Line,
  type V1Source,
} from './source.js';

/** 迁移选项 */
export interface MigrateOptions {
  /**
   * 说话人兜底：v1 文件头缺 `角色:` 时用它补裸台词（例如调用方从工程配置拿到角色名）。
   * 缺省 = 没有兜底（裸台词记 unsupported）。
   */
  readonly speaker?: string;
  /** 输出 EOL 覆盖；缺省沿用输入多数派（M7.3「编码/EOL 保留」） */
  readonly eol?: Eol;
  /**
   * adapter 事件目录的**名字投影**（宿主调用 `eventNames(adapter)` 交进来；§3.5 / 附录 B.1）。
   *
   * - 给了 ⇒ `时机` / `# 时机` 的面词必须是其中之一，否则迁移期 unsupported（**不产 `# 机`**，
   *   提示里列出可迁的事件名）——这条把"迁移产物编不过 `event/unknown`"挡在迁移期；
   * - 没给 ⇒ 不猜目录（无 adapter 事实），沿用 v1 的形状判定。core 不内置任何事件名（零游戏知识）。
   */
  readonly eventNames?: readonly string[];
}

/** 一条不可机械迁移的台账（`line` = v1 源 1 基行号） */
export interface MigrateUnsupported {
  readonly line: number;
  readonly construct: string;
  readonly targetHint: string;
  readonly code: CoreDiagnosticCode;
}

/** 从 v1 文件头搬到工程/adapter 的元数据（2.0 脚本里不再写这些行） */
export interface MigrateMetadata {
  /** `角色:` / `char:` 的值（裸台词的说话人来源） */
  readonly chara: string | null;
  /** 其余文件头声明（`口上:` / `显示名:` / `简介:` / `开关:` …）及其缩进体原文 */
  readonly headLines: readonly MigrateHeadLine[];
}

export interface MigrateHeadLine {
  readonly word: string;
  readonly value: string;
  /** v1 源行号 */
  readonly line: number;
  /** 该声明自带的缩进体原文（如 `开关:` 的条目）；无则空数组 */
  readonly body: readonly string[];
}

/** 迁移结果 */
export interface MigrateResult {
  readonly ok: boolean;
  readonly code: string;
  /** 新行（1 基）→ 旧行（1 基）；`sourceMap[newLine-1] = oldLine` */
  readonly sourceMap: readonly number[];
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly unsupported: readonly MigrateUnsupported[];
  readonly metadata: MigrateMetadata;
}

/** 已发射的一行（`text` 不含 EOL） */
interface OutLine {
  readonly text: string;
  /** 该行回源的 v1 行号（1 基） */
  readonly source: number;
}

/** 递归迁移上下文 */
interface RangeCtx {
  /** 缩进位移（迁移 `时机` 体时 -1：2.0 `# 机` 不包块） */
  readonly delta: number;
  /** 额外缩进位（`@组` 包装候选时 +1） */
  readonly shift: number;
  /** 跳过物理空行（`?` 链 / `@随机` 内：2.0 里空行会断链/非法） */
  readonly skipBlank: boolean;
}

/** 迁移器（一次调用一个新实例；纯内存） */
class Migrator {
  private readonly src: V1Source;
  private readonly lines: readonly V1Line[];
  private readonly eol: Eol;
  private readonly options: MigrateOptions;
  private readonly optionSpeaker: string | null;
  private readonly out: OutLine[] = [];
  private readonly diagnostics: KojoDiagnostic[] = [];
  private readonly unsupported: MigrateUnsupported[] = [];
  private readonly headLines: MigrateHeadLine[] = [];
  private speaker: string | null;
  /** v1 文件头 `角色:` 的原值（metadata 用；与 options.speaker 兜底分开） */
  private headerChara: string | null = null;
  private timingBlocks = 0;

  constructor(src: V1Source, options: MigrateOptions) {
    this.src = src;
    this.lines = src.lines;
    this.options = options;
    this.eol = options.eol ?? src.eol;
    this.optionSpeaker = options.speaker !== undefined && options.speaker.trim().length > 0 ? options.speaker.trim() : null;
    this.speaker = this.optionSpeaker;
    for (const line of this.lines) {
      if (line.body.trim().length === 0) continue;
      const cls = classifyV1(line.body);
      if (cls.kind.kind === 'timingHead') this.timingBlocks++;
    }
  }

  /* ============================== 发射原语 ============================== */

  private emit(level: number, content: string, sourceLine: number): void {
    this.out.push({ text: `${indentOfLevel(level)}${content}`, source: sourceLine });
  }

  /** 原样保留一行（不可迁移区间 / 已 2.0 行）：不做缩进归一 */
  private emitRaw(raw: string, sourceLine: number): void {
    this.out.push({ text: raw, source: sourceLine });
  }

  private emitBlank(sourceLine: number): void {
    this.out.push({ text: '', source: sourceLine });
  }

  /** 结构化行剥出的 v1 行内注释 → 独立 `//` 行（2.0 无行尾注释） */
  private emitComment(level: number, comment: string | null, sourceLine: number): void {
    if (comment === null) return;
    this.emit(level, `//${comment}`, sourceLine);
  }

  /**
   * warning 不阻断迁移（`ok` 只看 unsupported）。
   *
   * 严重度由本模块**显式标注**：迁移报告不是编译器严重级表（同一 `core/migration/*` 码在
   * 编译器侧是 error，在迁移器侧可能是"已自动修好但请复核"）。见模块头注。
   */
  private warn(code: CoreDiagnosticCode, message: string, span: KojoSpan | null): void {
    this.diagnostics.push({ code, severity: 'warning', message, span });
  }

  private reportUnsupported(line: V1Line, construct: string, targetHint: string, code: CoreDiagnosticCode): void {
    this.unsupported.push({ line: line.number, construct, targetHint, code });
    this.diagnostics.push({
      code,
      severity: 'error',
      message: `旧写法「${construct}」不能机械迁移到 2.0：${targetHint}`,
      span: lineSpan(line),
    });
  }

  /* ============================== 范围工具 ============================== */

  /** 缩进体区间（不含块头；尾随空行归还外层） */
  private bodyEnd(headIndex: number, limit: number): number {
    const head = this.lines[headIndex]!;
    let end = headIndex + 1;
    let i = headIndex + 1;
    while (i < limit) {
      const line = this.lines[i]!;
      if (isBlankBody(line.body)) {
        i++;
        continue;
      }
      if (line.indent <= head.indent) break;
      end = i + 1;
      i++;
    }
    return end;
  }

  /* ============================== 文本行迁移 ============================== */

  /**
   * v1 文本行 → 2.0 叙事行（台词 `角色：「…」` / 旁白 `> …`）。
   *
   * **引号口径（K2-MIGRATE-QUOTE）**：v1 的 `「…」` 台词行连引号一起打印（`PRINTFORMW 「…」`），
   * 2.0 的语法引号只剥最外层一对 ⇒ 迁移把 **v1 的打印文本原样**放进 2.0 正文
   * （`灵梦：「「…」」`），打印结果与 v1 逐字一致。**心形**在 v1 里剥引号（`HPH_PRINT` 实参不含
   * 引号），迁移沿用 v1 同一判据，不额外套引号。
   *
   * 失败 = 形态不完整（裸引号缺右引号 / 引号后还有正文 / 没说话人）⇒ 调用方记 unsupported。
   */
  private convertText(
    v1Body: string,
    heart: boolean,
  ):
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly construct: string; readonly hint: string; readonly code: CoreDiagnosticCode } {
    let body = v1Body;
    let wait = false;
    if (hasWaitMark(body)) {
      wait = true;
      body = rewriteWaitAlias(body).replace(/(?:^|[\s\u3000])续\s*$/u, '').trimEnd();
    }
    const hint = heart ? '(心形)' : '';
    const waitText = wait ? ' 续' : '';
    if (body.length === 0) {
      return { ok: false, construct: '空文本行', hint: '空行请写 `空行`', code: 'core/migration/raw' };
    }
    const first = body[0]!;
    if (first === '「' || first === '｢') {
      const closeChar = first === '｢' ? '｣' : '」';
      const close = body.lastIndexOf(closeChar);
      if (close <= 0) {
        return {
          ok: false,
          construct: '裸台词（引号未闭合）',
          hint: '补右引号，或改写为 `> 旁白`（§4.5）',
          code: 'core/narrative/bare-quote',
        };
      }
      const inner = body.slice(1, close);
      const after = body.slice(close + 1).trim();
      if (after.length > 0) {
        return {
          ok: false,
          construct: '裸台词（引号后还有正文）',
          hint: '2.0 台词行的引号后只能挂 `(提示)` / `续`；把引号外正文移进引号内或另起旁白行（§4.5）',
          code: 'core/migration/raw',
        };
      }
      const speaker = this.speaker;
      if (speaker === null) {
        return {
          ok: false,
          construct: '裸台词（缺说话人）',
          hint: '补 v1 文件头 `角色:`（迁移器取它当说话人），或手工写 2.0 的 `角色：「…」`',
          code: 'core/narrative/bare-quote',
        };
      }
      // 2.0 台词正文 = **v1 的打印文本**：
      // - 普通台词：v1 连引号一起打印 ⇒ 正文是整行 v1 文本（`｢｣` 按 §12.1 归一成全角，其余逐字，
      //   含引号后的空白——v1 也照打；不丢字符）；
      // - 心形：v1 只在"首个闭合引号收在行尾"时剥引号，否则多段文本原样打印 ⇒ 同一判据。
      const printed = heart
        ? heartPrintedText(body)
        : `${first === '｢' ? '「' : first}${inner}${closeChar === '｣' ? '」' : closeChar}${body.slice(close + 1)}`;
      return { ok: true, text: `${speaker}：「${printed}」${hint}${waitText}` };
    }
    return { ok: true, text: `> ${body}${hint}${waitText}` };
  }

  /**
   * `心形` 行 / `心形：` 块体行 → 2.0 叙事行（额外处理 v1 心形块里的 `你：` 自机前缀）。
   *
   * 正文取 **v1 心形实际打印的文本**（`stripQuotesForHeart` 同一判据：首个闭合引号收在行尾才剥，
   * 多段文本原样），再交给 2.0 语法引号包一层。
   */
  private convertHeartLine(
    v1Body: string,
  ): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly construct: string; readonly hint: string; readonly code: CoreDiagnosticCode } {
    const body = v1Body;
    const player = /^你\s*[：:]\s*(.*)$/.exec(body);
    if (player !== null) {
      const restText = player[1]!.trim();
      let wait = false;
      let text = restText;
      if (hasWaitMark(text)) {
        wait = true;
        text = rewriteWaitAlias(text).replace(/(?:^|[\s\u3000])续\s*$/u, '').trimEnd();
      }
      const waitText = wait ? ' 续' : '';
      const inner = heartPrintedText(text);
      if (inner.length === 0) {
        return { ok: false, construct: '`你：` 心形行没有内容', hint: '补台词内容，或改用 `> 旁白`', code: 'core/migration/raw' };
      }
      return { ok: true, text: `你：「${inner}」(心形)${waitText}` };
    }
    return this.convertText(body, true);
  }

  /* ============================== 主流程 ============================== */

  migrate(): MigrateResult {
    this.migrateRange(0, this.lines.length, { delta: 0, shift: 0, skipBlank: false });
    const code = this.renderCode();
    const sourceMap = this.out.map((line) => line.source);
    const ok = this.unsupported.length === 0 && !this.diagnostics.some((d) => d.severity === 'error');
    return {
      ok,
      code,
      sourceMap,
      diagnostics: this.diagnostics,
      unsupported: this.unsupported,
      metadata: { chara: this.headerChara, headLines: this.headLines },
    };
  }

  private renderCode(): string {
    if (this.out.length === 0) return this.src.bom ? '\uFEFF' : '';
    const body = this.out.map((line) => line.text).join(this.eol);
    const withFinal = this.src.finalNewline ? `${body}${this.eol}` : body;
    return this.src.bom ? `\uFEFF${withFinal}` : withFinal;
  }

  /** 迁移 [from, to) 区间（嵌套块体由各块头自己递归） */
  private migrateRange(from: number, to: number, ctx: RangeCtx): void {
    let i = from;
    while (i < to) {
      const line = this.lines[i]!;
      if (isBlankBody(line.body)) {
        if (!ctx.skipBlank) this.emitBlank(line.number);
        i++;
        continue;
      }
      const cls = classifyV1(line.body);
      i = this.handleLine(i, to, line, cls, ctx);
    }
  }

  /** 处理一行；返回下一行下标（块会消费自己的缩进体） */
  private handleLine(index: number, to: number, line: V1Line, cls: Classified, ctx: RangeCtx): number {
    const level = line.indent + ctx.delta + ctx.shift;
    const kind = cls.kind;
    switch (kind.kind) {
      case 'blank':
        if (!ctx.skipBlank) this.emitBlank(line.number);
        return index + 1;

      case 'comment':
        this.emit(level, `//${kind.rest}`, line.number);
        return index + 1;

      case 'kojo2': {
        // 已 2.0 的行：**缩进位移为 0 时逐字节原样**（幂等的构造基础）；在迁移后的
        // `时机` 体里（delta=-1）或 `@组` 包装位（shift=+1）则按层级重排缩进——
        // 否则 `空行 等待` 这类 2.0 行会留在 v1 的缩进深度上。
        const reindent = ctx.delta !== 0 || ctx.shift !== 0;
        if (!reindent) this.emitRaw(line.raw, line.number);
        else this.emit(level, line.body, line.number);
        if (isKojo2BlockHead(line.body)) {
          let j = index + 1;
          while (j < to) {
            const next = this.lines[j]!;
            if (!isBlankBody(next.body) && next.indent <= line.indent) break;
            if (!reindent || isBlankBody(next.body)) this.emitRaw(next.raw, next.number);
            else this.emit(next.indent + ctx.delta + ctx.shift, next.body, next.number);
            j++;
          }
          return j;
        }
        return index + 1;
      }

      case 'version':
        this.warn('core/migration/version', '已删除 v1 版本声明：2.0 没有版本号，文件直接从声明或正文开始（§3.1）。', lineSpan(line));
        return index + 1;

      case 'preprocessor': {
        let j = index;
        while (j < to && /^#[A-Za-z_]/.test(this.lines[j]!.body)) j++;
        this.emitNativeFence(index, j, level, line.number);
        return j;
      }

      case 'skipStart': {
        let j = index + 1;
        while (j < to && this.lines[j]!.body !== '[SKIPEND]') j++;
        if (j < to) j++; // 含 [SKIPEND]
        this.emitNativeFence(index, j, level, line.number);
        return j;
      }

      case 'skipEnd':
        this.emitNativeFence(index, index + 1, level, line.number);
        return index + 1;

      case 'rawAt': {
        // v1 `@` 原生函数块：直到下一个 `@` 行或区间末尾（同 v1 语义）
        let j = index + 1;
        while (j < to && !this.lines[j]!.body.startsWith('@')) j++;
        this.emitNativeFence(index, j, level, line.number);
        return j;
      }

      case 'headDecl':
        return this.handleHeadDecl(index, to, line, kind);

      case 'timingHash': {
        const parsed = parseTimingHead(kind.rest, this.options.eventNames);
        if (!parsed.ok) {
          this.reportUnsupported(line, parsed.construct, parsed.hint, 'core/migration/timing');
          this.emitRaw(line.raw, line.number);
          return index + 1;
        }
        this.emit(level, `# 机 ${parsed.machine}`, line.number);
        return index + 1;
      }

      case 'timingHead':
        return this.handleTimingBlock(index, to, line, kind, level);

      case 'ifHead':
      case 'elseHead':
        return this.handleIfChain(index, to, line, ctx, level);

      case 'whenHead':
      case 'isHead':
        return this.rejectBlock(index, to, line, '`当 / 是` 分支块', 'core/migration/switch', TARGET_HINTS.switch!);

      case 'branchHead':
        return this.rejectBlock(index, to, line, '`分支：` + `[条件]` 规则池', 'core/migration/branch', TARGET_HINTS.branch!);

      case 'askHead':
        return this.rejectBlock(index, to, line, '`初回 / 询问 / 确认` 块', 'core/migration/ask', TARGET_HINTS.ask!);

      case 'hiddenHead':
        return this.rejectBlock(index, to, line, '`隐藏情景 / 隐藏口上` 声明', 'core/migration/hidden-timing', TARGET_HINTS['hidden-timing']!, false);

      case 'loopHead':
        return this.rejectBlock(index, to, line, '`循环 …：` 块', 'core/migration/loop', TARGET_HINTS.loop!);

      case 'loopEnd':
        return this.rejectLine(index, line, '`循环结束` 收束行', 'core/migration/loop', TARGET_HINTS['loop-end']!);

      case 'catchHead':
        return this.rejectBlock(index, to, line, '`出错处理：` 块', 'core/migration/raw', 'TRY 系 2.0 未覆盖：整块放进 `@原生`（§12.1）');

      case 'catchEnd':
        return this.rejectLine(index, line, '`出错处理结束` 收束行', 'core/migration/raw', TARGET_HINTS.native!);

      case 'dataHead':
        return this.rejectBlock(index, to, line, '`数据表：` 随机数据表块', 'core/migration/data', TARGET_HINTS.data!);

      case 'dataEnd':
        return this.rejectLine(index, line, '`数据表结束` 收束行', 'core/migration/data', TARGET_HINTS.data!);

      case 'menuHead':
        return this.rejectBlock(index, to, line, '`菜单：` 块', 'core/migration/raw', TARGET_HINTS.menu!);

      case 'choiceHead':
        return this.handleChoiceBlock(index, to, line, ctx, level);

      case 'choiceItem':
        // 不在 `选项` 块里的孤条目标签：2.0 语法与 v1 相同，原样放行（编译器会报位置）
        this.emitRaw(line.raw, line.number);
        return index + 1;

      case 'colorHead':
        return this.handleColorBlock(index, to, line, ctx, level, kind.color);

      case 'randomHead':
        return this.handleRandomBlock(index, to, line, ctx, level);

      case 'randomInline':
        return this.handleRandomInline(index, line, level, kind.alternatives);

      case 'groupHead':
        this.reportUnsupported(line, '`组：` 块（不在 `@随机` 候选位）', '放在 `@随机` 里当一个候选：`@组` + 缩进体（§8.4）', 'core/migration/random');
        return this.emitRawBlock(index, to, line);

      case 'heartHead':
        return this.handleHeartBlock(index, to, line, level);

      case 'heartLine': {
        const conv = this.convertHeartLine(kind.body);
        if (!conv.ok) {
          this.reportUnsupported(line, conv.construct, conv.hint, conv.code);
          this.emitRaw(line.raw, line.number);
          return index + 1;
        }
        this.emit(level, conv.text, line.number);
        return index + 1;
      }

      case 'functionHead':
        return this.handleFunctionHead(index, to, line, ctx, level, kind, cls.comment);

      case 'callStatement': {
        this.emit(level, `! ${kind.target}`, line.number);
        this.emitComment(level, cls.comment, line.number);
        return index + 1;
      }

      case 'returnStatement': {
        this.emit(level, kind.value === null ? '@返' : `@返 ${kind.value}`, line.number);
        this.emitComment(level, cls.comment, line.number);
        return index + 1;
      }

      case 'labelDecl': {
        this.emit(level, `@标 ${stripLabelPrefix(kind.name)}`, line.number);
        this.emitComment(level, cls.comment, line.number);
        return index + 1;
      }

      case 'jumpStatement': {
        this.emit(level, `@跳 ${stripLabelPrefix(kind.target)}`, line.number);
        this.emitComment(level, cls.comment, line.number);
        return index + 1;
      }

      case 'text': {
        const conv = this.convertText(kind.body, false);
        if (!conv.ok) {
          this.reportUnsupported(line, conv.construct, conv.hint, conv.code);
          this.emitRaw(line.raw, line.number);
          return index + 1;
        }
        this.emit(level, conv.text, line.number);
        return index + 1;
      }

      case 'other': {
        if (kind.block) {
          this.reportUnsupported(line, kind.construct, kind.targetHint, kind.code);
          return this.emitRawBlock(index, to, line);
        }
        this.reportUnsupported(line, kind.construct, kind.targetHint, kind.code);
        this.emitRaw(line.raw, line.number);
        return index + 1;
      }

      default: {
        // 判别表新增了种类但本开关没接：不静默——按"清单外"整块保留
        const exhaustive: never = kind;
        void exhaustive;
        this.reportUnsupported(line, '未接线的迁移种类', TARGET_HINTS.unknown!, 'core/migration/raw');
        return this.emitRawBlock(index, to, line);
      }
    }
  }

  /* ============================== 各类块 ============================== */

  private emitNativeFence(from: number, to: number, level: number, headSource: number): void {
    this.emit(level, '@原生', headSource);
    let base = Number.POSITIVE_INFINITY;
    for (let i = from; i < to; i++) {
      const line = this.lines[i]!;
      if (isBlankBody(line.body)) continue;
      base = Math.min(base, line.lead.length);
    }
    if (!Number.isFinite(base)) base = 0;
    for (let i = from; i < to; i++) {
      const line = this.lines[i]!;
      if (isBlankBody(line.body)) {
        this.emitBlank(line.number);
        continue;
      }
      const content = line.raw.slice(base);
      this.out.push({ text: `${indentOfLevel(level + 1)}${content}`, source: line.number });
    }
  }

  /** 不可迁移块：整块（块头 + 缩进体）原样保留，返回下一行下标 */
  private emitRawBlock(index: number, to: number, line: V1Line): number {
    const end = this.bodyEnd(index, to);
    for (let i = index; i < end; i++) this.emitRaw(this.lines[i]!.raw, this.lines[i]!.number);
    return end < index + 1 ? index + 1 : end;
  }

  private rejectLine(index: number, line: V1Line, construct: string, code: CoreDiagnosticCode, hint: string): number {
    this.reportUnsupported(line, construct, hint, code);
    this.emitRaw(line.raw, line.number);
    return index + 1;
  }

  private rejectBlock(
    index: number,
    to: number,
    line: V1Line,
    construct: string,
    code: CoreDiagnosticCode,
    hint: string,
    withBody = true,
  ): number {
    if (!withBody) return this.rejectLine(index, line, construct, code, hint);
    this.reportUnsupported(line, construct, hint, code);
    return this.emitRawBlock(index, to, line);
  }

  private handleHeadDecl(index: number, to: number, line: V1Line, kind: Extract<V1Kind, { kind: 'headDecl' }>): number {
    const end = this.bodyEnd(index, to);
    const body: string[] = [];
    for (let i = index + 1; i < end; i++) body.push(this.lines[i]!.raw);
    if (kind.word === '角色' || kind.word === 'char') {
      if (this.speaker === null && kind.value.length > 0) this.speaker = kind.value;
      if (this.headerChara === null && kind.value.length > 0) this.headerChara = kind.value;
      this.headLines.push({ word: kind.word, value: kind.value, line: line.number, body });
      return end;
    }
    this.headLines.push({ word: kind.word, value: kind.value, line: line.number, body });
    return end;
  }

  private handleTimingBlock(
    index: number,
    to: number,
    line: V1Line,
    kind: Extract<V1Kind, { kind: 'timingHead' }>,
    level: number,
  ): number {
    if (this.timingBlocks !== 1) {
      this.reportUnsupported(
        line,
        '多个 `时机` 块（2.0 一个文件只写一个 `# 机`）',
        '按挂点拆文件：每个文件一个 `# 机 <事件>`（§3.5）',
        'core/migration/timing',
      );
      return this.emitRawBlock(index, to, line);
    }
    const parsed = parseTimingHead(kind.rest, this.options.eventNames);
    if (!parsed.ok) {
      this.reportUnsupported(line, parsed.construct, parsed.hint, 'core/migration/timing');
      return this.emitRawBlock(index, to, line);
    }
    this.emit(level, `# 机 ${parsed.machine}`, line.number);
    const end = this.bodyEnd(index, to);
    this.migrateRange(index + 1, end, { delta: -1, shift: 0, skipBlank: false });
    return end;
  }

  private handleIfChain(index: number, to: number, line: V1Line, ctx: RangeCtx, level: number): number {
    const headIndent = line.indent;
    const first = classifyV1(line.body);
    if (first.kind.kind !== 'ifHead') {
      // 孤立的 `否则` / `否则如果`：v1 也要求前面有 `如果`；保守整块保留
      this.reportUnsupported(line, '孤立的 `否则 / 否则如果`', '接到一条 `?` 链里（前面先有 `? 条件`）（§5.3）', 'core/migration/if');
      return this.emitRawBlock(index, to, line);
    }

    // 第一遍：扫链（块头 + 缩进体），同时做 overlap / 空条件 / `否则` 位置检查
    interface Head {
      readonly index: number;
      readonly cls: Classified;
      readonly end: number;
    }
    const heads: Head[] = [];
    let j = index;
    let invalid: { construct: string; hint: string } | null = null;
    while (j < to) {
      const cur = this.lines[j]!;
      if (cur.indent !== headIndent) break;
      const c = classifyV1(cur.body);
      if (c.kind.kind !== 'ifHead' && c.kind.kind !== 'elseHead') break;
      if (c.kind.kind === 'ifHead' && c.kind.condition.length === 0) {
        invalid = { construct: '`如果 / 否则如果` 缺条件', hint: '`?` 行必须带条件；兜底分支写 `? 否`（§5）' };
      }
      const end = this.bodyEnd(j, to);
      const hasInline = c.kind.kind === 'ifHead' && c.kind.inline.length > 0;
      if (end === j + 1 && !hasInline) {
        invalid = {
          construct: `\`${c.kind.kind === 'elseHead' ? '否则' : '如果 / 否则如果'}\` 分支没有正文`,
          hint: '每个条件分支下面要缩进写正文；删掉空分支，或补 `? 否` 兜底（§5）',
        };
      }
      heads.push({ index: j, cls: c, end });
      j = end;
    }
    const end = heads[heads.length - 1]?.end ?? index + 1;
    if (heads.some((h, i) => h.cls.kind.kind === 'elseHead' && i !== heads.length - 1)) {
      invalid = { construct: '`否则` 不在条件链末尾', hint: '`? 否` 必须贴在链尾（§5）' };
    }
    if (invalid !== null) {
      this.reportUnsupported(line, invalid.construct, invalid.hint, 'core/migration/if');
      for (let k = index; k < end; k++) this.emitRaw(this.lines[k]!.raw, this.lines[k]!.number);
      return end;
    }

    // 第二遍：按原顺序发射 `?` 链（不排序，§5）
    for (const head of heads) {
      const cur = this.lines[head.index]!;
      const c = head.cls;
      if (c.kind.kind === 'ifHead') {
        this.emit(level, `? ${c.kind.condition}`, cur.number);
        this.emitComment(level, c.comment, cur.number);
        if (c.kind.inline.length > 0) this.emitInlineBody(cur, c.kind.inline, level + 1);
      } else {
        this.emit(level, '? 否', cur.number);
        this.emitComment(level, c.comment, cur.number);
      }
      this.migrateRange(head.index + 1, head.end, { delta: ctx.delta, shift: ctx.shift, skipBlank: true });
    }

    // overlap warning（只报可证的：同文条件重复 / 恒真条件后面还有分支）
    this.checkOverlap(heads.map((h) => ({ cls: h.cls, line: this.lines[h.index]! })));
    return end;
  }

  private emitInlineBody(head: V1Line, inline: string, level: number): void {
    const cls = classifyV1(inline);
    if (cls.kind.kind === 'text') {
      const conv = this.convertText(cls.kind.body, false);
      if (conv.ok) {
        this.emit(level, conv.text, head.number);
        return;
      }
    }
    if (cls.kind.kind === 'heartLine') {
      const conv = this.convertHeartLine(cls.kind.body);
      if (conv.ok) {
        this.emit(level, conv.text, head.number);
        return;
      }
    }
    // 行内体只支持文本行（v1 行内块的常见形态）：其余保守记 unsupported
    this.reportUnsupported(head, '`如果 …： <行内体>`（行内体不是文本行）', '把行内体写成缩进一行的文本 / 旁白（§3.5）', 'core/migration/if');
  }

  private checkOverlap(heads: readonly { cls: Classified; line: V1Line }[]): void {
    const seen = new Map<string, V1Line>();
    let trueAt = -1;
    let lastIndex = -1;
    heads.forEach((head, i) => {
      lastIndex = i;
      const k = head.cls.kind;
      if (k.kind !== 'ifHead') return;
      const norm = normalizeCondition(k.condition);
      const prev = seen.get(norm);
      if (prev !== undefined) {
        this.warn(
          'core/migration/if',
          `同一条件在一条 \`?\` 链里出现两次（第 ${prev.number} 行与第 ${head.line.number} 行）——后一条永远不会命中；2.0 不自动排序，请作者合并或改阈值。`,
          lineSpan(head.line),
        );
      } else {
        seen.set(norm, head.line);
      }
      if (isLiteralTrue(k.condition) && trueAt < 0) trueAt = i;
    });
    if (trueAt >= 0 && trueAt < lastIndex) {
      const line = heads[trueAt]!.line;
      this.warn(
        'core/migration/if',
        `第 ${line.number} 行的条件恒真（\`真\` / \`1\` / \`true\`）——它后面的分支永远不会命中；请把它作为 \`? 否\` 之外的最后一条，或删掉后续分支。`,
        lineSpan(line),
      );
    }
  }

  private handleColorBlock(
    index: number,
    to: number,
    line: V1Line,
    ctx: RangeCtx,
    level: number,
    color: string,
  ): number {
    const value = color.trim();
    if (!/^0x[0-9A-Fa-f]{1,8}$/.test(value)) {
      this.reportUnsupported(line, '`着色` 块头（颜色不是十六进制字面量）', '写 `@着色 0xFF8080`（十六进制字面量或已声明整数常量）（§8.2）', 'core/migration/color');
      return this.emitRawBlock(index, to, line);
    }
    this.emit(level, `@着色 ${value}`, line.number);
    const end = this.bodyEnd(index, to);
    this.migrateRange(index + 1, end, { delta: ctx.delta, shift: ctx.shift, skipBlank: false });
    return end;
  }

  private handleRandomBlock(index: number, to: number, line: V1Line, ctx: RangeCtx, level: number): number {
    const bodyIndent = line.indent + 1;
    const end = this.bodyEnd(index, to);

    // 第一遍：候选边界（每个候选 = bodyIndent 上的一行 / 一个块）
    interface Candidate {
      readonly index: number;
      readonly end: number;
    }
    const candidates: Candidate[] = [];
    let k = index + 1;
    while (k < end) {
      const cur = this.lines[k]!;
      if (isBlankBody(cur.body)) {
        k++;
        continue;
      }
      if (cur.indent !== bodyIndent) break;
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'comment') {
        k++;
        continue;
      }
      const candEnd = this.bodyEnd(k, end);
      candidates.push({ index: k, end: candEnd });
      k = candEnd;
    }
    if (candidates.length < 2) {
      this.reportUnsupported(line, '`随机：` 块（候选不足两个）', '2.0 `@随机` 至少两个候选；只有一个就删掉随机（§8.4）', 'core/migration/random');
      return this.emitRawBlock(index, to, line);
    }

    this.emit(level, '@随机', line.number);
    let i = index + 1;
    while (i < end) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) {
        i++; // 2.0 `@随机` 内不允许物理空行（§8.4）：迁移丢弃
        continue;
      }
      if (cur.indent !== bodyIndent) break;
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'comment') {
        this.emit(level + 1, `//${cls.kind.rest}`, cur.number);
        i++;
        continue;
      }
      const candEnd = this.bodyEnd(i, end);
      // 单行文本候选：直接作为 `@随机` 的直接子项
      if (cls.kind.kind === 'text' || cls.kind.kind === 'heartLine') {
        const conv =
          cls.kind.kind === 'text' ? this.convertText(cls.kind.body, false) : this.convertHeartLine(cls.kind.body);
        if (!conv.ok) {
          this.reportUnsupported(cur, conv.construct, conv.hint, conv.code);
          for (let n = i; n < candEnd; n++) this.emitRaw(this.lines[n]!.raw, this.lines[n]!.number);
        } else {
          this.emit(level + 1, conv.text, cur.number);
        }
        i = candEnd;
        continue;
      }
      if (cls.kind.kind === 'groupHead') {
        this.emit(level + 1, '@组', cur.number);
        this.migrateRange(i + 1, candEnd, { delta: ctx.delta, shift: ctx.shift, skipBlank: true });
        i = candEnd;
        continue;
      }
      // 多行 / 控制流候选：必须包 `@组`（§8.4）
      this.emit(level + 1, '@组', cur.number);
      this.migrateRange(i, candEnd, { delta: ctx.delta, shift: ctx.shift + 1, skipBlank: true });
      i = candEnd;
    }
    return end;
  }

  private handleRandomInline(
    index: number,
    line: V1Line,
    level: number,
    alternatives: readonly string[],
  ): number {
    const converted: { readonly ok: true; readonly text: string }[] = [];
    for (const alt of alternatives) {
      const conv = this.convertText(alt, false);
      if (!conv.ok) {
        this.reportUnsupported(line, '行内 `随机` 候选（候选不是干净文本行）', '改成 `@随机` + 每个候选一行（§8.4）', 'core/migration/random');
        this.emitRaw(line.raw, line.number);
        return index + 1;
      }
      converted.push(conv);
    }
    this.emit(level, '@随机', line.number);
    for (const conv of converted) this.emit(level + 1, conv.text, line.number);
    return index + 1;
  }

  private handleChoiceBlock(index: number, to: number, line: V1Line, ctx: RangeCtx, level: number): number {
    const itemIndent = line.indent + 1;
    const end = this.bodyEnd(index, to);
    // 预检：条目层只能是 `「标签」：`（同 v1）；否则整块保留
    let itemCount = 0;
    for (let i = index + 1; i < end; i++) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body) || cur.indent !== itemIndent) continue;
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'choiceItem' || isChoiceItem(cur.body)) itemCount++;
      else if (cls.kind.kind !== 'comment') {
        this.reportUnsupported(line, '`选项：` 块（条目形状不认识）', '条目写 `「标签」：` + 缩进正文（§7.5）', 'core/migration/random');
        return this.emitRawBlock(index, to, line);
      }
    }
    if (itemCount === 0) {
      this.reportUnsupported(line, '`选项：` 块（没有任何条目）', '条目写 `「标签」：` + 缩进正文（§7.5）', 'core/migration/random');
      return this.emitRawBlock(index, to, line);
    }
    this.emit(level, '选项：', line.number);
    this.warn(
      'core/options/pending',
      '`选项` 是 2.0 待定 UI（§7.5）：迁移器保留为局部字面量区，后续 API 可能调整。',
      lineSpan(line),
    );
    let i = index + 1;
    while (i < end) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) {
        this.emitBlank(cur.number);
        i++;
        continue;
      }
      if (cur.indent !== itemIndent) {
        // 预检已保证不会出现；防御性整块外移
        i++;
        continue;
      }
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'comment') {
        this.emit(level + 1, `//${cls.kind.rest}`, cur.number);
        i++;
        continue;
      }
      if (cls.kind.kind !== 'choiceItem' && !isChoiceItem(cur.body)) {
        // 预检已拦截；防御性走到这里时整块保留（不产半成品）
        this.reportUnsupported(line, '`选项：` 块（条目形状不认识）', '条目写 `「标签」：` + 缩进正文（§7.5）', 'core/migration/random');
        return this.emitRawBlock(index, to, line);
      }
      const itemEnd = this.bodyEnd(i, end);
      this.emit(level + 1, normalizeChoiceItem(cur.body), cur.number);
      this.migrateRange(i + 1, itemEnd, { delta: ctx.delta, shift: ctx.shift, skipBlank: false });
      i = itemEnd;
    }
    return end;
  }

  private handleHeartBlock(index: number, to: number, line: V1Line, level: number): number {
    const bodyIndent = line.indent + 1;
    const end = this.bodyEnd(index, to);
    // 预检：块体只允许文本行 / 注释 / 空行（v1 心形块同一口径）
    let contentCount = 0;
    for (let i = index + 1; i < end; i++) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) continue;
      if (cur.indent !== bodyIndent) {
        this.reportUnsupported(line, '`心形：` 块（缩进异常）', '块体只写台词 / 旁白，一行一条（§4.8）', 'core/migration/heart');
        return this.emitRawBlock(index, to, line);
      }
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'comment') continue;
      // 心形块体一律按 v1 文本行处理（`灵梦：「…」` 在心形块里是带前缀的 v1 文本；
      // 只有 `你：` 是 v1 心形的自机前缀）
      if (!isHeartTextCandidate(cur.body, cls)) {
        this.reportUnsupported(line, '`心形：` 块（块体混入非文本行）', '块体只写台词 / 旁白，一行一条（§4.8）', 'core/migration/heart');
        return this.emitRawBlock(index, to, line);
      }
      contentCount++;
    }
    if (contentCount === 0) {
      this.reportUnsupported(line, '`心形：` 块（没有正文）', '块体至少写一行台词 / 旁白；空块请删掉（§4.8）', 'core/migration/heart');
      return this.emitRawBlock(index, to, line);
    }
    let i = index + 1;
    while (i < end) {
      const cur = this.lines[i]!;
      if (isBlankBody(cur.body)) {
        this.emitBlank(cur.number);
        i++;
        continue;
      }
      if (cur.indent !== bodyIndent) {
        i++;
        continue;
      }
      const cls = classifyV1(cur.body);
      if (cls.kind.kind === 'comment') {
        this.emit(level, `//${cls.kind.rest}`, cur.number);
        i++;
        continue;
      }
      const conv = this.convertHeartLine(cur.body);
      if (!conv.ok) {
        this.reportUnsupported(cur, conv.construct, conv.hint, conv.code);
        this.emitRaw(cur.raw, cur.number);
      } else {
        this.emit(level, conv.text, cur.number);
      }
      i++;
    }
    return end;
  }

  private handleFunctionHead(
    index: number,
    to: number,
    line: V1Line,
    ctx: RangeCtx,
    level: number,
    kind: Extract<V1Kind, { kind: 'functionHead' }>,
    comment: string | null,
  ): number {
    const signature = kind.params === null ? kind.name : `${kind.name}(${kind.params})`;
    this.emit(level, `@函 ${signature}`, line.number);
    this.emitComment(level, comment, line.number);
    const end = this.bodyEnd(index, to);
    this.migrateRange(index + 1, end, { delta: ctx.delta, shift: ctx.shift, skipBlank: false });
    return end;
  }
}

/* ============================== 小工具 ============================== */

/** 心形块体行是否可按 v1 文本行迁移（注释/文本/心形行；`你：` 前缀也认） */
function isHeartTextCandidate(body: string, cls: Classified): boolean {
  if (cls.kind.kind === 'text' || cls.kind.kind === 'heartLine') return true;
  // v1 心形块里的 `你：「…」`：classifyV1 会把它当已 2.0 台词，但心形块要补 `(心形)`
  return /^你\s*[：:]/.test(body);
}

/**
 * 2.0 的**缩进块**头（块体整块透传，不再按 v1 解释）：
 * `@算/@着色/@随机/@组/@循/@巡/@复/@函/@织/@原生` 与 `# 表/# 池/# 模`。
 *
 * 这些词在 v1 里没有同名写法（v1 是 `着色：`/`随机：`/`函数 …：`/`当 …：`），
 * 所以只可能来自"已经 2.0 的文本"，整块透传不会误吞 v1 内容。
 */
function isKojo2BlockHead(body: string): boolean {
  if (body.startsWith('@')) {
    const m = /^@([^\s@]+)/.exec(body);
    const name = m ? m[1]! : '';
    return ['算', '着色', '随机', '组', '循', '巡', '复', '函', '织', '原生'].includes(name);
  }
  if (body.startsWith('# ')) {
    const word = body.slice(1).trimStart().split(/[ \t\u3000]/)[0] ?? '';
    return word === '表' || word === '池' || word === '模';
  }
  return false;
}

/* ============================== `时机` 块头 ============================== */

/** v1 `时机` 块头的命名参数键（§3.2 命名参数表；`args` 是 `参数:` 的英文别名） */
const TIMING_NAMED_PARAM_KEYS: ReadonlySet<string> = new Set(['成否', '类型', '参数', 'args']);

/** `时机` 块头解析结果：成功给 `# 机` 的机器串；失败给**不猜的理由**（台账 construct + 目标提示） */
export type TimingHeadParse =
  | { readonly ok: true; readonly machine: string }
  | { readonly ok: false; readonly construct: string; readonly hint: string };

/**
 * 解析 v1 `时机 [分野] [编号] [命名参数…]` 块头（`rest` 已剥块尾冒号）。
 *
 * 三条判据（每条都**不猜**）：
 * 1. 命名参数（`成否:` / `类型:` / `参数:` / `args:`）⇒ unsupported：2.0 `# 机` 只写 `<事件> [编号]`，
 *    这些是 adapter 事件配置（§3.5 / §15.2.3）；台账里点名是哪几个参数，不静默丢；
 * 2. 面词白名单（**只有调用方给了 `eventNames` 才判**）：不在 adapter `eventCatalog` 里 ⇒ unsupported，
 *    提示列出可迁的事件名。core 不内置任何事件名（零游戏知识，§3.5）；
 * 3. 形状（多余冒号 / 超过 3 段）⇒ unsupported。没给目录时沿用 v1 形状判定（调用方自行负责事后校验）。
 */
export function parseTimingHead(rest: string, eventNames?: readonly string[]): TimingHeadParse {
  const text = rest.trim();
  if (text.length === 0) {
    return {
      ok: false,
      construct: '`时机` 块头（缺事件名）',
      hint: '写 `# 机 <事件> [编号]`；事件名取 adapter 的 `eventCatalog`（§3.5）。',
    };
  }
  const tokens = text.split(/[ \t\u3000]+/).filter((token) => token.length > 0);
  const named = namedTimingParams(tokens);
  if (named.length > 0) {
    return {
      ok: false,
      construct: `\`时机\` 块头（命名参数 ${named.map((name) => `\`${name}:\``).join(' / ')}）`,
      hint: '命名参数搬到 adapter 事件配置（§15.2.3）：2.0 `# 机` 只写 `<事件> [编号]`（§3.5）。',
    };
  }
  // 不在命名参数闭集里的冒号：形状不认识（与旧判据同一口径，避免把 `a:b` 当事件名产出去）
  if (/[:：]/u.test(text)) {
    return {
      ok: false,
      construct: '`时机` 块头（事件形状不认识）',
      hint: '改成 `# 机 <事件> [编号]`；`成否:` / `类型:` / `参数:` 等命名参数搬到 adapter 事件配置（§3.5 / §15.2.3）。',
    };
  }
  const face = tokens[0]!;
  if (eventNames !== undefined && !eventNames.includes(face)) {
    const available = eventNames.length === 0 ? '(adapter 未声明任何事件)' : eventNames.join('、');
    return {
      ok: false,
      construct: `\`时机\` 面词「${face}」不在 adapter 事件目录`,
      hint:
        eventNames.length === 0
          ? '当前 adapter 的 `eventCatalog` 是空的：先补 adapter 契约（§3.5），再迁移 `时机`。'
          : `2.0 \`# 机\` 只认 adapter 声明的事件：${available}（§3.5 / 附录 B.1）。「${face}」这个 v1 面词 2.0 暂无落点：请按挂点拆文件或放进 \`@原生\`。`,
    };
  }
  if (tokens.length > 3) {
    return {
      ok: false,
      construct: '`时机` 块头（段数超过 `<事件> <编号>`）',
      hint: '改成 `# 机 <事件> [编号]`：v1 的额外子句 2.0 没有落点（§3.5）。',
    };
  }
  return { ok: true, machine: tokens.join(' ') };
}

/** 块头里的命名参数名（`成否:` 形，或行尾空值形 `… 参数`——v1 的块尾冒号会吃掉那个 `:`） */
function namedTimingParams(tokens: readonly string[]): readonly string[] {
  const found: string[] = [];
  tokens.forEach((token, index) => {
    if (index === 0) return; // 第 0 段是面词，不可能是命名参数
    const bare = token.replace(/[:：]$/u, '');
    if (!TIMING_NAMED_PARAM_KEYS.has(bare)) return;
    const hasColon = bare !== token;
    // 值位置的裸词（如 `类型: 类型` 的取值）不算命名参数：只认 `名字:` 形或块尾空值形
    if (hasColon || index === tokens.length - 1) found.push(bare);
  });
  return found;
}

/**
 * 旧入口（导出面保留）：`时机` 块头 → 机器串；形状不认识 → null。
 *
 * 不传 `eventNames` ⇒ 只判形状、不判面词（与 `parseTimingHead(rest)` 同义）。
 */
export function normalizeMachine(rest: string): string | null {
  const parsed = parseTimingHead(rest);
  return parsed.ok ? parsed.machine : null;
}

/**
 * v1 心形实际打印的文本（与 kojo-sugar `codegen.ts::stripQuotesForHeart` 同一判据）：
 * 首个闭合引号**收在行尾**才剥一层引号；多段文本（`「甲」「乙」`）原样——v1 也原样打印。
 */
function heartPrintedText(text: string): string {
  const trimmed = text.trim();
  const pairs: readonly (readonly ['「' | '｢', '」' | '｣'])[] = [
    ['「', '」'],
    ['｢', '｣'],
  ];
  for (const [open, close] of pairs) {
    if (!trimmed.startsWith(open)) continue;
    const closeAt = trimmed.indexOf(close, open.length);
    if (closeAt === trimmed.length - close.length) return trimmed.slice(open.length, closeAt);
    return text;
  }
  return text;
}

/** `$名` / `*名` → 名（v1 显示层剥离口径；2.0 `@标` / `@跳` 只写名） */
function stripLabelPrefix(name: string): string {
  return name.replace(/^[$*]+/, '').trim();
}

/** `「标签」：` 归一（半角旧引号 `｢｣` → 「」；冒号统一全角） */
function normalizeChoiceItem(body: string): string {
  const trimmed = body.trimEnd();
  const quoted = trimmed.replace(/^｢/, '「').replace(/｣(?=\s*[:：]\s*$)/, '」');
  return quoted.replace(/[:：]\s*$/, '：');
}

/** 条件文本归一（重叠判据；只折叠空白，不做符号求值） */
function normalizeCondition(condition: string): string {
  return condition.replace(/[ \t\u3000]+/g, ' ').trim();
}

/** 恒真条件（可证：`真` / `1` / `true`） */
function isLiteralTrue(condition: string): boolean {
  const t = normalizeCondition(condition);
  return t === '真' || t === '1' || /^true$/i.test(t);
}

/* ============================== 公共入口 ============================== */

/**
 * 迁移 v1 `.kojo` 源文本到 2.0（纯函数；不读盘、不写盘、不产生副作用）。
 *
 * 已迁移完成的 2.0 文本再次传入 → `ok=true` 且 `code` 逐字节不变（幂等）。
 */
export function migrateKojoSource(source: string, options: MigrateOptions = {}): MigrateResult {
  if (typeof source !== 'string') {
    throw new TypeError('migrateKojoSource 的输入必须是字符串（v1 .kojo 源文本）');
  }
  const src = readSource(source);
  const migrator = new Migrator(src, options);
  return migrator.migrate();
}

/** 供调用方（CLI / UI）展示的迁移报告摘要（纯函数；不参与判定） */
export function summarizeMigration(result: MigrateResult): {
  readonly ok: boolean;
  readonly unsupportedCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly firstBlockedLine: number | null;
} {
  return {
    ok: result.ok,
    unsupportedCount: result.unsupported.length,
    warningCount: result.diagnostics.filter((d) => d.severity === 'warning').length,
    errorCount: result.diagnostics.filter((d) => d.severity === 'error').length,
    firstBlockedLine: result.unsupported.length > 0 ? Math.min(...result.unsupported.map((u) => u.line)) : null,
  };
}

/* 供测试与后续批次的导出（不重复造第二份判别表） */
export { classifyV1, hasWaitMark, isChoiceItem, isKojo2Line, rewriteWaitAlias, TARGET_HINTS } from './classify.js';
export { readSource } from './source.js';
export type { Classified, V1Kind } from './classify.js';
export type { Eol, V1Line, V1Source } from './source.js';
