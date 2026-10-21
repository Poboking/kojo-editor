/**
 * 引擎字面量编码器 + 全角标点唯一入口。
 *
 * ## 为什么必须只有这一个编码器（设计稿 §4.8 规范级约束）
 * 任何"作者文本进入引擎字面量"的路径——`(心形)` 的 `HPH_PRINT(@"…")`、`# 表` 引号值、
 * `# 模` 参数替换、`# 池` 台词、PRINTFORM 文本体——都必须走这里，**不允许逐处手写转义**：
 * 逐处手写 = N 份会漂移的判据，迟早有一条路径把 `"` 或 `\` 漏进产物。
 *
 * ## 引擎语义（不是猜的：本机 Emuera 源码 `LexicalAnalyzer.cs` 逐行核过）
 * - 普通串 `"…"`：`ReadString`。`\` 吃掉自己后按下一字符分派——
 *   `\n`→换行、`\s`→半角空格、`\S`→全角空格 U+3000、`\t`→tab、
 *   `\<EOL>`→结束串、其余（含 `"` `\` `%` `{` `}`）→**原样追加该字符**。
 * - 格式串 `@"…"`：`AnalyseFormattedString`。除上面同一套 `\` 语义外：
 *   `%…%` / `{…}` / `\@…?…#…\@` 是插值记号，`$ * + / =` **连三枚**是三元符号指令
 *   （`$` `*` `+` `/` `=` 各一族）。
 * - 所以：`" \ % { } #` 全部可用反斜杠安全表达成字面量；真正表达不了的只有
 *   **U+0000**（`\0` 直接抛 `MissingCharacterAfterEscape` / 在 ReadString 里终止）、
 *   **CR U+000D**（ERB 以换行分逻辑行，字面量里放不进去）、
 *   **未配对代理项**（源文本不是合法 UTF-16，落盘/上屏必被替换）。
 *   ——闸只挡这三类，不为了"保守"把可编码字符报错。
 *
 * ## 全角标点（§4.13 唯一入口）
 * `reportFullwidthExprPunct(text, span)` 是表达式/条件/声明位置全角标点的**唯一实现**；
 * 消费方只负责把纯代码切片传进来（叙事正文、表值列、台词文本不传）。
 * 它跳过 `"…"` 字符串内部——引号里的全角标点是正文，不是笔误。
 *
 * 纯函数、零 IO、零 Monaco。
 */
import type { KojoPosition, KojoSpan } from './ast.js';
import type { DiagnosticSink, KojoDiagnostic } from './diagnostics.js';
import { offsetToPosition } from './positions.js';

/** 引擎字面量的两种形态：普通 `"…"` / 格式 `@"…"` */
export type EngineLiteralForm = 'plain' | 'formatted';

/** 不可安全表达的三类事实（闭集；新增必须同时改上面的头注与诊断文案） */
export type EngineLiteralFailureReason = 'nul' | 'carriage-return' | 'unpaired-surrogate';

export interface EngineLiteralFailure {
  readonly reason: EngineLiteralFailureReason;
  /** 作者文本内的 UTF-16 偏移（0 基） */
  readonly offset: number;
  /** 出问题的码元（未配对代理项会给出 0x 码点描述） */
  readonly char: string;
}

/** 编码成功：`literal` 是可直接拼进产物的带引号串；`body` 是无引号文本体（PRINTFORM 体用） */
export interface EngineLiteralSuccess {
  readonly ok: true;
  readonly form: EngineLiteralForm;
  readonly literal: string;
  readonly body: string;
}

/** 编码失败（fail-closed）：不返回任何产物片段，只返回诊断 + 机器可读事实 */
export interface EngineLiteralFailureResult {
  readonly ok: false;
  readonly form: EngineLiteralForm;
  readonly failures: readonly EngineLiteralFailure[];
  readonly diagnostics: readonly KojoDiagnostic[];
}

export type EngineLiteralResult = EngineLiteralSuccess | EngineLiteralFailureResult;

export interface EngineLiteralOptions {
  readonly form?: EngineLiteralForm;
  /** 诊断落点：作者文本在源文件里的 span（缺省 → 诊断 span 为 null，仍不静默） */
  readonly span?: KojoSpan | null;
}

/** 常见全角 → 半角对照（唯一一份；`reportFullwidthExprPunct` 与编辑器共用） */
export const FULLWIDTH_EXPR_PUNCT: ReadonlyMap<string, string> = new Map<string, string>([
  ['：', ':'],
  ['＝', '='],
  ['？', '?'],
  ['，', ','],
  ['（', '('],
  ['）', ')'],
  ['＜', '<'],
  ['＞', '>'],
  ['！', '!'],
  ['；', ';'],
  ['＋', '+'],
  ['－', '-'],
  ['＊', '*'],
  ['／', '/'],
  ['％', '%'],
  ['＆', '&'],
  ['｜', '|'],
  ['～', '~'],
]);

/** 格式串里必须反斜杠化的元字符（`$*+/=` 三连是三元符号指令，`#` 会截断 `\@…?…#…\@` 分支） */
const FORMAT_METACHARS: ReadonlySet<string> = new Set<string>([
  '%',
  '{',
  '}',
  '#',
  '$',
  '*',
  '+',
  '/',
  '=',
]);

const EMPTY_DIAGNOSTICS: readonly KojoDiagnostic[] = Object.freeze([]);

function describeFailure(reason: EngineLiteralFailureReason, char: string): string {
  switch (reason) {
    case 'nul':
      return '作者文本里含 U+0000（NUL）：引擎 ReadString/格式化串解析遇 \\0 直接终止或抛错，无法安全表达；请删除该字符。';
    case 'carriage-return':
      return '作者文本里含回车符 U+000D：ERB 以换行分逻辑行，单行字面量表达不了 CR；请改用换行（会编码为 \\n）或删除。';
    case 'unpaired-surrogate':
      return `作者文本里含未配对的 UTF-16 代理项（${char}）：源文本不是合法 UTF-16，落盘/上屏必被替换成 U+FFFD，无法安全表达。`;
  }
}

/** 作者文本偏移 → 源文件位置（多行切片也正确；1 基 UTF-16，与 ast 同口径） */
function spanAt(text: string, span: KojoSpan | null | undefined, offset: number, length: number): KojoSpan | null {
  if (span === null || span === undefined) return null;
  const localStart = offsetToPosition(text, offset);
  const localEnd = offsetToPosition(text, offset + length);
  const toGlobal = (local: KojoPosition): KojoPosition =>
    local.line === 1
      ? { line: span.start.line, column: span.start.column + local.column - 1 }
      : { line: span.start.line + local.line - 1, column: local.column };
  return { start: toGlobal(localStart), end: toGlobal(localEnd) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 编码作者文本为引擎文本体（无引号、无外层包装）。
 *
 * 这是整条链路唯一的转义实现：`encodeEngineLiteral` 只是在它外面套 `@"…"` / `"…"`。
 * 转义规则见文件头注（逐条对引擎源码）。
 */
export function encodeEngineText(text: string, options?: EngineLiteralOptions): EngineLiteralResult {
  const form: EngineLiteralForm = options?.form ?? 'plain';
  const span = options?.span ?? null;
  const formatted = form === 'formatted';
  const out: string[] = [];
  const failures: EngineLiteralFailure[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x0000) {
      failures.push({ reason: 'nul', offset: i, char: 'U+0000' });
      i++;
      continue;
    }
    if (code === 0x000d) {
      failures.push({ reason: 'carriage-return', offset: i, char: 'U+000D' });
      i++;
      continue;
    }
    if (isHighSurrogate(code)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (!isLowSurrogate(next)) {
        failures.push({ reason: 'unpaired-surrogate', offset: i, char: `U+${code.toString(16).toUpperCase()}` });
        i++;
        continue;
      }
      // 合法代理对：原样追加（引擎按 UTF-16 码元处理，不经手就不会坏）
      out.push(text[i]!, text[i + 1]!);
      i += 2;
      continue;
    }
    if (isLowSurrogate(code)) {
      failures.push({ reason: 'unpaired-surrogate', offset: i, char: `U+${code.toString(16).toUpperCase()}` });
      i++;
      continue;
    }
    const ch = text[i]!;
    switch (ch) {
      case '\\':
        out.push('\\\\');
        break;
      case '"':
        // ReadString / AnalyseFormattedString 的 default 分支：吃掉 `\`、原样追加 `"`，不闭合串
        out.push('\\"');
        break;
      case '\n':
        // 两种串都认 `\n`（ReadString: case 'n' → '\n'；格式串同）
        out.push('\\n');
        break;
      default:
        if (formatted && FORMAT_METACHARS.has(ch)) out.push('\\', ch);
        else out.push(ch);
        break;
    }
    i++;
  }
  if (failures.length > 0) {
    const diagnostics: KojoDiagnostic[] = failures.map((failure) => ({
      code: 'core/expr/bad-literal' as const,
      severity: 'error' as const,
      message: describeFailure(failure.reason, failure.char),
      span: spanAt(text, span, failure.offset, 1),
    }));
    return { ok: false, form, failures, diagnostics };
  }
  return { ok: true, form, body: out.join(''), literal: '' };
}

/** 编码为可直接拼进产物的带引号引擎字面量（`@"…"` / `"…"`） */
export function encodeEngineLiteral(text: string, options?: EngineLiteralOptions): EngineLiteralResult {
  const encoded = encodeEngineText(text, options);
  if (!encoded.ok) return encoded;
  return {
    ok: true,
    form: encoded.form,
    body: encoded.body,
    literal: encoded.form === 'formatted' ? `@"${encoded.body}"` : `"${encoded.body}"`,
  };
}

/**
 * fail-closed 便捷通道：成功返回带引号字面量，失败把诊断写进 sink 并返回 null。
 * 降糖各发射点用它——**没有第二条"先编码失败再兜底原样输出"的路**。
 */
export function encodeEngineLiteralOrReport(
  text: string,
  options: EngineLiteralOptions | undefined,
  sink: DiagnosticSink,
): string | null {
  const encoded = encodeEngineLiteral(text, options);
  if (encoded.ok) return encoded.literal;
  for (const diagnostic of encoded.diagnostics) sink.report(diagnostic);
  return null;
}

/**
 * 全角标点唯一入口：报告表达式/条件/声明位置的代码切片里出现的全角标点。
 *
 * 契约：
 * - `text` 必须是**纯代码切片**（表达式、条件、声明标题/类型/名字段）；叙事正文、
 *   `# 表` 值列、台词文本**不传**——那里全角标点是正文；
 * - 跳过 `"…"` 字符串内部（引号里的全角标点是正文）；`\` 按 Kojo 转义只跳过 1 个字符；
 * - 每出现一次报一枚 error（码 `core/migration/fullwidth-punct`），span 精确到该字符
 *   （1 基行 / 1 基列、UTF-16 码元；多行切片按物理行列折回）。
 */
export function reportFullwidthExprPunct(text: string, span: KojoSpan): readonly KojoDiagnostic[] {
  const found: KojoDiagnostic[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // 跳过字符串字面量内部：`\` 吃掉下一个字符（Kojo 转义口径）
      i++;
      while (i < text.length) {
        const inner = text[i]!;
        if (inner === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (inner === '"') break;
      }
      continue;
    }
    const replacement = FULLWIDTH_EXPR_PUNCT.get(ch);
    if (replacement !== undefined) {
      found.push({
        code: 'core/migration/fullwidth-punct' as const,
        severity: 'error' as const,
        message: `表达式/条件/声明位置不能写全角「${ch}」，请改成半角「${replacement}」。`,
        span: spanAt(text, span, i, 1),
      });
    }
    i++;
  }
  return found.length === 0 ? EMPTY_DIAGNOSTICS : found;
}
