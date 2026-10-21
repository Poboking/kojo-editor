/**
 * Kojo 2.0 **一键迁移 code action**（K2-CODE-ACTIONS，设计稿 §16.7 U6.4 / §12.2 第 3 条）。
 *
 * ## 这一层解决什么
 *
 * 2.0 编译器对旧写法**只报错、不解释**（§4.10 / §12.1），于是作者看到的是一条红线加一句
 * "请按 §12.1 迁移"。本模块把那句话变成**可点的动作**：诊断 + 请求区间进，动作（标题 + 编辑 +
 * 诊断关联）出。覆盖 §12.1 里"能机械说清"的那批：
 *
 * | 诊断码 | 动作 | 改写来源 |
 * |---|---|---|
 * | `core/narrative/bare-narration` | 裸旁白补 `>` | core 迁移器（同一行单独迁） |
 * | `core/narrative/bare-quote` | 裸引号补说话人 | core 迁移器（`speaker` 选项） |
 * | `core/migration/heart` | `心形` → 行尾 `(心形)` | 单行：core 迁移器；块：见下「心形块」 |
 * | `core/migration/color` | `着色` 块 → `@着色` | core 迁移器（整块单独迁） |
 * | `core/migration/random` | `随机：` / `组：` → `@随机` / `@组` | core 迁移器（整块单独迁） |
 * | `core/migration/branch` | `分支：` + `[条件]` → `# 池` + `! 池名` | core 语义升级层（`migrateKojoSourceSemantic`） |
 * | `core/migration/switch` | `当 / 是` → `# 表` + 引用点 | core 语义升级层 |
 * | `core/migration/ask` | `初回 / 询问 / 确认` → `@原生` | core 语义升级层 |
 * | `core/table/missing-default` | 补 `否 <末行值>` | 本层（core 无"补兜底"改写） |
 * | `core/pool/no-default` | 补 `? 否` + 末条分支正文 | 本层（core 无"补兜底"改写） |
 * | `core/template/unexpected-slot` | 模板体补 `[插槽]` | 本层（core 无"补插槽"改写） |
 * | `core/lex/indent` | 缩进按层级改成 4 空格倍数 | 本层（core 无"修缩进"改写） |
 *
 * ## 纪律一：改写规则只有 core 一份（本层不写第二套迁移表）
 *
 * 凡是"v1 写法 → 2.0 写法"的映射，本层**一律把目标片段交给 core 迁移器**
 * （`migrateKojoSourceSemantic`，它内部先跑语义升级层再跑机械层）并把产物搬回原位：
 * 行级动作迁**一行**、块级动作迁**一个块**（去基准缩进 → 迁 → 按原缩进搬回）。
 * 本层只做三件 core 不做的事：**定位**（诊断行 → 块范围）、**搬运**（缩进/提升声明）、
 * **收口判据**（下面纪律二）。core 说不行的（`ok === false`、语义升级层 decline）本层
 * 一律**不产动作**——绝不为了"有个按钮"而手写一条 core 不认的改写。
 *
 * `心形` 块是唯一的例外，理由写在 {@link heartBlockFix} 上：2.0 文件里的心形块**体已经是
 * 2.0 台词/旁白**，而 core 的 v1 心形块迁移只接受 v1 文本行（体里有 `角色：「…」` 就整块拒绝，
 * 见 `migrate/index.ts` 的 `isHeartTextCandidate`）——那不是"另一种映射"，是**同一句
 * §12.1 目标**（行尾 `(心形)`）落在 2.0 体上；本层因此只做"摘掉块头 + 逐行补行尾提示"。
 *
 * ## 纪律二：不可解析就不产动作（`core` 的 `parse` 是收口）
 *
 * 每条候选动作都先**应用到自己那份源码上**，再用 core 重新解析（{@link Kojo2CodeActionVerifier}）：
 *
 * 1. `parse` 的 error 数不许比改前多（结构性变坏一票否决）；
 * 2. 改动区间内不许出现**改前全文件都没有过的**错误码（改前就有的老问题不算在这条动作账上——
 *    例如文件本来缺 `# 机`，那是另一条诊断的活）；
 * 3. 触发这条动作的诊断码在改动区间内必须**消失**（"修了但没修好"同样一票否决）。
 *
 * 表 / 池 / 模板三条"补全"类动作的判据在 `parse` 之后还要过一遍**全链编译**
 * （`compileKojoSource`）：`core/table/missing-default` 这类码是编译期才报的，`parse` 看不见。
 * 全链那一步只用 fixture 事实，且**只判"目标码是否消失"**——不拿 fixture 的游戏事实去否决
 * 作者文件（那会把"这台 adapter 不支持颜色"记到迁移动作头上，见 {@link defaultVerifier}）。
 *
 * ## 纪律三：与宿主同一条落地通道（undo 停点）
 *
 * 本层**不碰编辑器**：动作带的是 `command`（不是 Monaco 的 `edit`），落地由宿主注入的
 * `applyEdits` 端口完成。宿主把它接到既有的 `applyTextEdits`
 * （`ui/editor-global-providers.ts`，前后各一颗 `pushUndoStop`）——机器改写自成一格、
 * `Ctrl+Z` 只退机器那一步（口径见 `tests/code-action-undo-stack.test.ts`）。让 Monaco 自己
 * `apply` 那份 `edit` 会绕开这道停点纪律，所以这里刻意不给 `edit`。
 *
 * ## 分层
 *
 * 纯逻辑（`kojo2CodeActionFacts` / 各 builder / 校验）与 Monaco 翻译层（`install…` /
 * marker 往返）同住本文件但**边界清楚**：前者零 Monaco、零 DOM、可脱离编辑器单测；
 * 后者只做协议翻译与命令登记。flag 关 ⇒ `install` 立即返回空操作（**零注册**）。
 */
import type * as Monaco from './entry';
import type {
  CoreDiagnosticCode,
  DiagnosticCode,
  KojoDiagnostic,
  KojoSpan,
} from '@kojo/kojo-core';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  KOJO_DOMAIN_SYMBOL_NAMES,
  classifyV1,
  compileKojoSource,
  migrateKojoSourceSemantic,
  parseSource,
} from '@kojo/kojo-core';
import type { EditorTextEdit } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from './kojo2-constants';
import { kojo2DiagnosticsToMarkers } from './kojo2-diagnostics';
// Monaco `CodeActionKind` 的两个字面量**只有一处定义**（v1 那条宿主适配腿）：
// 本层引用它们而不是再写一遍 `'quickfix'` / `'refactor'`，避免两套声明漂移。
import { QUICK_FIX_KIND, REFACTOR_KIND } from './kojo-code-action';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';

/* ============================== 公共形状 ============================== */

/** 动作类别：迁移（改写旧写法）/ 补全（补缺失的必填件）/ 修缩进 */
export type Kojo2CodeActionKind = 'migrate' | 'complete' | 'indent';

/** 三类动作的人话标签（宿主 / 测试按它上屏；本层不写界面文案） */
export const KOJO2_CODE_ACTION_KIND_LABELS: Readonly<Record<Kojo2CodeActionKind, string>> = {
  migrate: '迁移',
  complete: '补全',
  indent: '修缩进',
};

/** 请求区间（1 基行 / 1 基列，尾列半开；与 Monaco `IRange` 同口径） */
export interface Kojo2CodeActionRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * 一条编辑：`{range, newText}`。
 *
 * **整行替换**（`startColumn === 1`、`endColumn === 行宽 + 1`）：这样它能逐字映到宿主
 * `EditorTextEdit`（`{fromLine, toLine, newText}`）而**不丢信息**，也就能走同一条
 * `applyTextEdits`（多段合成一次 `executeEdits` + 前后停点）。插入 = 把目标行替换成
 * "新内容 + 原行"，删除 = `newText === ''`。
 */
export interface Kojo2CodeActionEdit {
  readonly range: Kojo2CodeActionRange;
  readonly newText: string;
}

/** 一条动作的**中性事实**（宿主只翻译、不解释；测试直接钉它） */
export interface Kojo2CodeActionFact {
  readonly kind: Kojo2CodeActionKind;
  readonly title: string;
  /** 便利字段 = `edits[0]`（单段动作的常态；多段见 `edits`） */
  readonly edit: Kojo2CodeActionEdit;
  /** 全部编辑（升序行号；表 / 池那条"提升声明 + 原处引用"是两段） */
  readonly edits: readonly Kojo2CodeActionEdit[];
  /** 这条动作认领的诊断（**同一批对象引用**，宿主据此画关联高亮） */
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 触发这条动作的诊断码（也是校验时"必须消失"的那个码） */
  readonly code: CoreDiagnosticCode;
  /** 编辑覆盖的行区间（1 基、含端点；宿主 / 测试判"改到哪了"） */
  readonly span: { readonly startLine: number; readonly endLine: number };
}

/** 校验端口：`parse` = 结构面（词法 + 文法），`compile` = 全链（含表 / 池 / 模板展开） */
export interface Kojo2CodeActionVerifier {
  parse(source: string): readonly KojoDiagnostic[];
  compile(source: string): readonly KojoDiagnostic[];
}

/** 一次请求的输入 */
export interface Kojo2CodeActionInput {
  readonly source: string;
  /** 本次请求区间内的诊断（Monaco `context.markers` 反翻译来的；空数组 = 这里没有波浪线） */
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly range: Kojo2CodeActionRange;
  /** 文件身份（只喂校验用的编译入口；core 不读盘） */
  readonly filePath?: string;
  /** 裸引号的说话人兜底（缺省 = 文件有 `# 视` 时用 `我`，见 {@link resolveSpeaker}） */
  readonly speaker?: string;
  /** 替换校验入口（测试注入假 parse / 假 compile；缺省走 core） */
  readonly verifier?: Kojo2CodeActionVerifier;
  /** 显式关闭（缺省开）；false ⇒ 一条都不产 */
  readonly enabled?: boolean;
}

/** 本层认领的诊断码（其余一律不产动作） */
export const KOJO2_CODE_ACTION_CODES: ReadonlySet<string> = new Set<string>([
  'core/narrative/bare-narration',
  'core/narrative/bare-quote',
  'core/migration/heart',
  'core/migration/color',
  'core/migration/random',
  'core/migration/branch',
  'core/migration/switch',
  'core/migration/ask',
  'core/table/missing-default',
  'core/pool/no-default',
  'core/template/unexpected-slot',
  'core/lex/indent',
]);

/**
 * 判据在**全链编译**而不在 `parse` 的诊断码：这三条的目标件（`否` 行 / `? 否` 分支 /
 * `[插槽]`）是降糖与展开阶段才校验的，`parse` 过了不代表修好（见模块头「纪律二」）。
 */
const COMPILE_STAGE_CODES: ReadonlySet<string> = new Set<string>([
  'core/table/missing-default',
  'core/pool/no-default',
  'core/template/unexpected-slot',
]);

/* ============================== 源文本模型 ============================== */

/** 一份源文本的行视图（EOL 与末行换行都记住，回写时逐字还原） */
interface SourceDoc {
  readonly lines: readonly string[];
  readonly eol: string;
  readonly finalNewline: boolean;
}

function readDoc(source: string): SourceDoc {
  const match = /\r\n|\r|\n/.exec(source);
  const eol = match === null ? '\n' : match[0];
  let body = source;
  let finalNewline = false;
  if (body.endsWith('\r\n')) {
    body = body.slice(0, -2);
    finalNewline = true;
  } else if (body.endsWith('\n') || body.endsWith('\r')) {
    body = body.slice(0, -1);
    finalNewline = true;
  }
  return { lines: body.split(/\r\n|\r|\n/), eol, finalNewline };
}

function renderDoc(doc: SourceDoc, lines: readonly string[]): string {
  return lines.join(doc.eol) + (doc.finalNewline ? doc.eol : '');
}

/** 一条整行替换的 range（列取整行：`1` → 行宽 + 1） */
function lineRange(doc: SourceDoc, fromLine: number, toLine: number): Kojo2CodeActionRange {
  const last = doc.lines[toLine - 1] ?? '';
  return { startLine: fromLine, startColumn: 1, endLine: toLine, endColumn: last.length + 1 };
}

/** 把 `[fromLine, toLine]` 换成 `newLines`（`newLines` 为空 = 删掉这几行） */
function replaceLines(
  doc: SourceDoc,
  fromLine: number,
  toLine: number,
  newLines: readonly string[],
): Kojo2CodeActionEdit {
  return { range: lineRange(doc, fromLine, toLine), newText: newLines.join('\n') };
}

/** 一次应用的结果：文本 + 每段编辑在**新文本里**占的行区间（校验判区域用） */
interface AppliedEdits {
  readonly text: string;
  readonly lines: readonly string[];
  readonly ranges: readonly { readonly startLine: number; readonly endLine: number }[];
}

/** 按行应用整行编辑（升序；`newText` 里的 `\n` 展开成多行） */
function applyLineEdits(doc: SourceDoc, edits: readonly Kojo2CodeActionEdit[]): AppliedEdits {
  const sorted = [...edits].sort((a, b) => a.range.startLine - b.range.startLine);
  const out: string[] = [];
  const ranges: { startLine: number; endLine: number }[] = [];
  let cursor = 1;
  for (const edit of sorted) {
    const max = Math.max(1, doc.lines.length);
    const from = Math.min(Math.max(1, Math.trunc(edit.range.startLine) || 1), max);
    const to = Math.min(Math.max(from, Math.trunc(edit.range.endLine) || from), max);
    if (from < cursor) continue; // 重叠编辑：先到先得（本层自己产的多段编辑不重叠）
    while (cursor < from) {
      out.push(doc.lines[cursor - 1] ?? '');
      cursor += 1;
    }
    const startLine = out.length + 1;
    if (edit.newText.length > 0) for (const line of edit.newText.split('\n')) out.push(line);
    ranges.push({ startLine, endLine: Math.max(startLine, out.length) });
    cursor = to + 1;
  }
  while (cursor <= doc.lines.length) {
    out.push(doc.lines[cursor - 1] ?? '');
    cursor += 1;
  }
  return { text: renderDoc(doc, out), lines: out, ranges };
}

/**
 * 把一条动作的全部编辑应用到源码上（**导出仅为可单测 / 宿主预览**：落地仍走宿主
 * `applyTextEdits`，本层不写第二个编辑应用机制）。
 */
export function kojo2EditedSource(source: string, edits: readonly Kojo2CodeActionEdit[]): string {
  return applyLineEdits(readDoc(source), edits).text;
}

/* ============================== 行级小工具 ============================== */

function indentOf(text: string): string {
  return /^[ \t\u3000]*/.exec(text)![0];
}

function bodyOf(text: string): string {
  const indent = indentOf(text);
  return text.slice(indent.length);
}

/** 前导空白宽度（Tab 按 4 空格算：只用于"这不是一级倍数"的判据，不参与文本改写） */
function indentWidth(text: string): number {
  return indentOf(text).replace(/\t/g, '    ').length;
}

function isEmptyLine(text: string): boolean {
  return text.trim().length === 0;
}

/** 块的缩进体终点（**含**最深的那一行；空行不算体、也不算结束） */
function blockEndLine(doc: SourceDoc, headLine: number): number {
  const headIndent = indentWidth(doc.lines[headLine - 1] ?? '');
  let last = headLine;
  for (let i = headLine + 1; i <= doc.lines.length; i += 1) {
    const text = doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) continue;
    if (indentWidth(text) <= headIndent) break;
    last = i;
  }
  return last;
}

/** 去掉块头的基准缩进（`headIndent`）；有非空行不以它开头 ⇒ null（结构不可证，不猜） */
function dedentBlock(
  doc: SourceDoc,
  fromLine: number,
  toLine: number,
  headIndent: string,
): string[] | null {
  const out: string[] = [];
  for (let i = fromLine; i <= toLine; i += 1) {
    const text = doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) {
      out.push('');
      continue;
    }
    if (!text.startsWith(headIndent)) return null;
    out.push(text.slice(headIndent.length));
  }
  return out;
}

function indentLines(lines: readonly string[], prefix: string): string[] {
  return lines.map((line) => (line.length === 0 ? '' : `${prefix}${line}`));
}

/** core 迁移器的输入片段（末尾补一个 EOL，与 `readSource` 的末行口径一致） */
function snippetOf(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** 迁移产物 → 行数组（吃掉末尾那个 EOL 造成的空元素） */
function outputLines(code: string): string[] {
  const parts = code.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function trimTrailingEmpty(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function prevNonBlankLine(doc: SourceDoc, line: number): number | null {
  for (let i = line - 1; i >= 1; i -= 1) {
    if (!isEmptyLine(doc.lines[i - 1] ?? '')) return i;
  }
  return null;
}

function nextNonBlankLine(doc: SourceDoc, line: number): number | null {
  for (let i = line + 1; i <= doc.lines.length; i += 1) {
    if (!isEmptyLine(doc.lines[i - 1] ?? '')) return i;
  }
  return null;
}

/** 往上找最近一条满足 `pred` 的行（行号；找不到 null） */
function nearestPreviousLine(
  doc: SourceDoc,
  line: number,
  pred: (text: string) => boolean,
): number | null {
  for (let i = line - 1; i >= 1; i -= 1) {
    const text = doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) continue;
    if (pred(text)) return i;
  }
  return null;
}

/** 全文件找第一条匹配 `re` 的行（1 基；找不到 null） */
function findLine(doc: SourceDoc, re: RegExp): number | null {
  for (let i = 1; i <= doc.lines.length; i += 1) {
    if (re.test(doc.lines[i - 1] ?? '')) return i;
  }
  return null;
}

/** 从 `at` 起先看本行、再往上找声明头（诊断 span 的起点通常就是声明行） */
function findDeclLineUpward(doc: SourceDoc, at: number, re: RegExp): number | null {
  for (let i = Math.min(at, doc.lines.length); i >= 1; i -= 1) {
    if (re.test(doc.lines[i - 1] ?? '')) return i;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 2.0 的**块头**形态（缩进修正用：判断上一行是否"在等一个缩进体"） */
const BLOCK_HEAD_RE =
  /^(?:\?(?:\s|$)|#\s+(?:表|池|模)(?:\s|$)|@(?:算|随机|着色|组|循|巡|复|函|织|原生)(?:\s|$)|选项\s*：?\s*$)/u;

/** 2.0 的**单行声明**（声明区扫描用；`# 幕` 不提升但仍属声明区形状） */
const SINGLE_DECL_RE = /^#\s+(?:幕|视|机|变量|常量)(?:\s|$)/u;

/** 2.0 叙事文本行（心形块体只接受这两种脸） */
function isNarrativeTextLine(text: string): boolean {
  if (/^>\s?/u.test(text) || text === '>') return true;
  return /^[^「]*：「[\s\S]*」\s*(?:续)?$/u.test(text);
}

/* ============================== 说话人 ============================== */

/**
 * 裸引号的说话人：`input.speaker` 优先，否则**文件有 `# 视` 时用 `我`**。
 *
 * 依据 §7.1：池内裸引号的默认说话人就是 `{我}`（`# 视` 的角色），2.0 写法直接写 `我：`；
 * 没有 `# 视` 时 `我` 解析不到（§3.6）⇒ 不给说话人 ⇒ core 迁移器如实拒绝 ⇒ **不产动作**
 * （不许编一个作者没说过的名字）。`你：` 前缀的裸行同样不产（见模块尾「已知缺口」）。
 */
function resolveSpeaker(input: Kojo2CodeActionInput, doc: SourceDoc): string | null {
  const explicit = input.speaker === undefined ? '' : input.speaker.trim();
  if (explicit.length > 0) return explicit;
  return findLine(doc, /^#\s+视(?:\s|$)/u) === null ? null : '我';
}

function speakerOptions(speaker: string | null): { readonly speaker?: string } {
  return speaker === null ? {} : { speaker };
}

/* ============================== 事实构造 ============================== */

interface BuildCtx {
  readonly doc: SourceDoc;
  readonly input: Kojo2CodeActionInput;
  readonly speaker: string | null;
  readonly verifier: Kojo2CodeActionVerifier;
}

function makeFact(
  kind: Kojo2CodeActionKind,
  title: string,
  edits: readonly Kojo2CodeActionEdit[],
  diagnostics: readonly KojoDiagnostic[],
  code: CoreDiagnosticCode,
): Kojo2CodeActionFact {
  const sorted = [...edits].sort(
    (a, b) => a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn,
  );
  const startLine = Math.min(...sorted.map((edit) => edit.range.startLine));
  const endLine = Math.max(...sorted.map((edit) => edit.range.endLine));
  return {
    kind,
    title,
    edit: sorted[0]!,
    edits: sorted,
    diagnostics,
    code,
    span: { startLine, endLine },
  };
}

/** 标题里的片段预览（过长截断；标题是给人看的，不承载判据） */
function preview(text: string, max = 24): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/* ---------------------------- 裸旁白 / 裸引号 ---------------------------- */

/**
 * 玩家代词（`我 / 你 / 她` 的第二格）与它的块头前缀。
 *
 * **不手抄词形**：`kojo-lexicon-single-source` 守卫要求 monaco 层字符串字面量不得整条等于
 * 词表词形；这里从 core 域符号表按语义位派生，词表改序/改名都不会漂。
 */
const KOJO2_PLAYER_PRONOUN = KOJO_DOMAIN_SYMBOL_NAMES[1] ?? KOJO_DOMAIN_SYMBOL_NAMES[0] ?? '';
const KOJO2_PLAYER_PREFIXES = [`${KOJO2_PLAYER_PRONOUN}：`, `${KOJO2_PLAYER_PRONOUN}:`] as const;

function textLineCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const line = diag.span!.start.line;
  const text = ctx.doc.lines[line - 1];
  if (text === undefined) return [];
  const indent = indentOf(text);
  const body = text.slice(indent.length);
  if (body.length === 0) return [];
  // 玩家代词开头的裸行：§12.1 的目标是「你：「…」」，而 core 迁移器对它的答案是"旁白"（那会
  // 把玩家台词改成旁白）⇒ 宁可不动（见模块尾「已知缺口」），不手写第二条映射。
  if (KOJO2_PLAYER_PREFIXES.some((prefix) => body.startsWith(prefix))) return [];
  const migrated = migrateKojoSourceSemantic(snippetOf([body]), speakerOptions(ctx.speaker));
  if (!migrated.ok) return [];
  const out = outputLines(migrated.code);
  if (out.length !== 1) return [];
  const next = out[0]!;
  if (next === body) return [];
  const isQuote = diag.code === 'core/narrative/bare-quote';
  if (isQuote && !next.includes('：「')) return [];
  if (!isQuote && !next.startsWith('>')) return [];
  const title = isQuote
    ? `补说话人 \`${ctx.speaker ?? '我'}\`：${preview(next)}`
    : `补旁白锚点 \`>\`：${preview(next)}`;
  return [
    makeFact(
      'migrate',
      title,
      [replaceLines(ctx.doc, line, line, [`${indent}${next}`])],
      [diag],
      diag.code as CoreDiagnosticCode,
    ),
  ];
}

/* ---------------------------- 心形 ---------------------------- */

/** 行尾补 `(心形)`（`续` 之前；已有则不重复） */
function withHeartHint(line: string): string {
  if (line.includes('(心形)')) return line;
  const wait = /^(.*?)(\s+续)$/u.exec(line);
  return wait === null ? `${line}(心形)` : `${wait[1]}(心形)${wait[2]}`;
}

/** 心形块体的一行 → 带行尾提示的 2.0 行（null = 这一行本层不敢动） */
function heartBodyLine(content: string, ctx: BuildCtx): string | null {
  if (content.startsWith('//')) return content; // 整行注释原样
  const cls = classifyV1(content);
  if (cls.kind.kind === 'heartLine') {
    // v1 心形行（`心形 …`）：core 自己会补 `(心形)`，别再叠一个
    const migrated = migrateKojoSourceSemantic(snippetOf([content]), speakerOptions(ctx.speaker));
    if (!migrated.ok) return null;
    const out = outputLines(migrated.code);
    return out.length === 1 ? out[0]! : null;
  }
  if (cls.kind.kind === 'kojo2') {
    return isNarrativeTextLine(content) ? withHeartHint(content) : null;
  }
  if (cls.kind.kind === 'text') {
    const migrated = migrateKojoSourceSemantic(snippetOf([content]), speakerOptions(ctx.speaker));
    if (!migrated.ok) return null;
    const out = outputLines(migrated.code);
    return out.length === 1 ? withHeartHint(out[0]!) : null;
  }
  return null;
}

/**
 * `心形` 动作。
 *
 * - 单行 `心形 微笑` / `心形`：**整行交给 core 迁移器**（产物 `> 微笑(心形)`）。
 * - `心形：` 块：core 的 v1 心形块迁移只接受 v1 文本行，而 2.0 文件里的体已经是
 *   `角色：「…」` / `> …`（core 判为"块体混入非文本行"整块拒绝）。这里做的是**同一句
 *   §12.1 目标**：摘掉块头（体上提一级）+ 每行行尾补 `(心形)`；每行都先过 core
 *   迁移器（`text` 脸）或 core 的 2.0 行判据（`kojo2` 脸），任何一行说不清就整块不产。
 */
function heartCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const line = diag.span!.start.line;
  const text = ctx.doc.lines[line - 1];
  if (text === undefined) return [];
  const indent = indentOf(text);
  const body = text.slice(indent.length);
  const cls = classifyV1(body);
  if (cls.kind.kind === 'heartLine') {
    const migrated = migrateKojoSourceSemantic(snippetOf([body]), speakerOptions(ctx.speaker));
    if (!migrated.ok) return [];
    const out = outputLines(migrated.code);
    if (out.length !== 1 || out[0] === body) return [];
    return [
      makeFact(
        'migrate',
        `心形 → 行尾 \`(心形)\`：${preview(out[0]!)}`,
        [replaceLines(ctx.doc, line, line, [`${indent}${out[0]!}`])],
        [diag],
        diag.code as CoreDiagnosticCode,
      ),
    ];
  }
  if (cls.kind.kind !== 'heartHead') return [];
  const end = blockEndLine(ctx.doc, line);
  if (end <= line) return [];
  const bodyPrefix = `${indent}    `;
  const out: string[] = [];
  for (let i = line + 1; i <= end; i += 1) {
    const raw = ctx.doc.lines[i - 1] ?? '';
    if (isEmptyLine(raw)) {
      out.push('');
      continue;
    }
    if (!raw.startsWith(bodyPrefix)) return []; // 体不在恰好一级：结构不可证
    const converted = heartBodyLine(raw.slice(bodyPrefix.length), ctx);
    if (converted === null) return [];
    out.push(`${indent}${converted}`);
  }
  if (out.length === 0) return [];
  return [
    makeFact(
      'migrate',
      `心形块 → 行尾 \`(心形)\`（第 ${line}–${end} 行）`,
      [replaceLines(ctx.doc, line, end, out)],
      [diag],
      diag.code as CoreDiagnosticCode,
    ),
  ];
}

/* ---------------------------- 着色 / 随机 / 初回（整块搬 core 产物） ---------------------------- */

const BLOCK_TITLES: Readonly<Record<string, string>> = {
  'core/migration/color': '`着色` 块 → `@着色`',
  'core/migration/random': '`随机：` / `组：` → `@随机` / `@组`',
  'core/migration/ask': '`初回 / 询问 / 确认` → `@原生`',
};

/**
 * 整块迁移：去基准缩进 → `migrateKojoSourceSemantic` → 按原缩进搬回。
 *
 * 语义升级层在 `初回` 上会自己产出 `@原生` 围栏（`rewrites` 非空是**预期**）；
 * `着色` / `随机` 上它不该改写别的构造（片段里只有这一个块）⇒ 有 `rewrites` 就拒绝，
 * 免得把嵌套构造提升出来的声明搬到错误的缩进上。
 */
function blockMigrateCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const line = diag.span!.start.line;
  const head = ctx.doc.lines[line - 1];
  if (head === undefined) return [];
  const indent = indentOf(head);
  const end = blockEndLine(ctx.doc, line);
  if (end <= line) return [];
  const snippet = dedentBlock(ctx.doc, line, end, indent);
  if (snippet === null) return [];
  const migrated = migrateKojoSourceSemantic(snippetOf(snippet), speakerOptions(ctx.speaker));
  if (!migrated.ok) return [];
  if (diag.code !== 'core/migration/ask' && migrated.rewrites.length > 0) return [];
  const out = outputLines(migrated.code);
  if (out.length === 0) return [];
  const replacement = indentLines(out, indent);
  const original = ctx.doc.lines.slice(line - 1, end);
  if (replacement.join('\n') === original.join('\n')) return [];
  const title = BLOCK_TITLES[diag.code] ?? '旧块 → 2.0 写法';
  return [
    makeFact(
      'migrate',
      `${title}（第 ${line}–${end} 行）`,
      [replaceLines(ctx.doc, line, end, replacement)],
      [diag],
      diag.code as CoreDiagnosticCode,
    ),
  ];
}

/* ---------------------------- 当 → # 表 / 分支 → # 池（提升声明 + 原处引用） ---------------------------- */

/**
 * 声明区插入点：文件顶部连续的 **空行 / `//` 注释 / 单行声明**之后的第一行。
 *
 * §3.2：声明只能写顶层，且单行声明与正文之间空一行。插到"第一条正文行"之前既能保证
 * 顶层，也保住声明区的连续；文件全是声明 ⇒ 追加到末尾之后。
 */
function declarationInsertLine(doc: SourceDoc): number {
  for (let i = 1; i <= doc.lines.length; i += 1) {
    const text = doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) continue;
    if (bodyOf(text).startsWith('//')) continue;
    if (indentWidth(text) === 0 && SINGLE_DECL_RE.test(text)) continue;
    return i;
  }
  return doc.lines.length + 1;
}

/**
 * "把 `decl` 插在 `at` 之前"落成**整行替换**：`at..at` 换成 `decl + 原行`。
 * 块声明前后各空一行（§3.2）：上一条不是空行就补一行；尾部固定补一行空行。
 * `at` 越过末行 ⇒ 追加到最后一行之后（同样是整行替换，不引入"零宽插入"这种无法映射
 * 到 `EditorTextEdit` 的形状）。
 */
function insertionEdit(doc: SourceDoc, at: number, decl: readonly string[]): Kojo2CodeActionEdit {
  const block = declBlockLines(doc, at, decl);
  if (at <= doc.lines.length) {
    return replaceLines(doc, at, at, [...block, doc.lines[at - 1] ?? '']);
  }
  const last = Math.max(1, doc.lines.length);
  return replaceLines(doc, last, last, [doc.lines[last - 1] ?? '', ...block]);
}

/** 声明块的上下空行（`at` 之前那行不是空行就补一行；尾部固定一行） */
function declBlockLines(doc: SourceDoc, at: number, decl: readonly string[]): string[] {
  const block: string[] = [];
  const prev = at > 1 ? doc.lines[at - 2] ?? '' : null;
  if (prev === null || !isEmptyLine(prev)) block.push('');
  block.push(...decl);
  block.push('');
  return block;
}

/**
 * `当 / 是` → `# 表`、`分支：` + `[条件]` → `# 池`：core 语义升级层把声明**提升到片段顶层**、
 * 原块位置换成引用行（`> {表}` / `! 池`）。本层照搬这个形状到真实文件里：
 * ① 声明插进声明区；② 原块换成引用行（保持原缩进）。
 */
function hoistCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const line = diag.span!.start.line;
  const head = ctx.doc.lines[line - 1];
  if (head === undefined) return [];
  const indent = indentOf(head);
  const end = blockEndLine(ctx.doc, line);
  if (end <= line) return [];
  const snippet = dedentBlock(ctx.doc, line, end, indent);
  if (snippet === null) return [];
  const migrated = migrateKojoSourceSemantic(snippetOf(snippet), speakerOptions(ctx.speaker));
  if (!migrated.ok || migrated.rewrites.length !== 1) return [];
  const rewrite = migrated.rewrites[0]!;
  const expected = diag.code === 'core/migration/switch' ? 'switch-table' : 'branch-pool';
  if (rewrite.kind !== expected) return [];
  const out = outputLines(migrated.code);
  const refText = rewrite.reference.trim();
  let refIndex = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if ((out[i] ?? '').trim() === refText) {
      refIndex = i;
      break;
    }
  }
  if (refIndex <= 0) return [];
  const decl = trimTrailingEmpty(out.slice(0, refIndex));
  if (decl.length === 0) return [];
  const insertAt = declarationInsertLine(ctx.doc);
  const title =
    diag.code === 'core/migration/switch'
      ? `\`当\` → \`# 表 ${rewrite.declName ?? ''}\`（第 ${line}–${end} 行）`
      : `\`分支：\` → \`# 池 ${rewrite.declName ?? ''}\`（第 ${line}–${end} 行）`;
  // 声明区就在块头之前（文件顶部没有可跳过的声明 / 注释）⇒ 两段编辑会落在同一行上。
  // 整行替换是"一次 executeEdits 里多段不重叠"的模型，重叠段会被丢弃；这里合成**一段**：
  // 声明块 + 空行 + 引用行，原块头与体一起消失。
  const edits: Kojo2CodeActionEdit[] =
    insertAt >= line
      ? [
          replaceLines(ctx.doc, line, end, [
            ...declBlockLines(ctx.doc, insertAt, decl),
            `${indent}${refText}`,
          ]),
        ]
      : [
          insertionEdit(ctx.doc, insertAt, decl),
          replaceLines(ctx.doc, line, end, [`${indent}${refText}`]),
        ];
  return [makeFact('migrate', title, edits, [diag], diag.code as CoreDiagnosticCode)];
}

/* ---------------------------- 补 `否`（表） ---------------------------- */

function tableDefaultCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const at = diag.span!.start.line;
  const headLine = findDeclLineUpward(ctx.doc, at, /^#\s+表(?:\s|$)/u);
  if (headLine === null) return [];
  const head = ctx.doc.lines[headLine - 1] ?? '';
  if (indentWidth(head) !== 0) return [];
  // 表体：头之后缩进 > 0 的非空行；物理空行结束表（§6.1）
  let lastRow = -1;
  let rowIndent = '';
  let hasDefault = false;
  for (let i = headLine + 1; i <= ctx.doc.lines.length; i += 1) {
    const text = ctx.doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) break;
    if (indentWidth(text) === 0) break;
    lastRow = i;
    rowIndent = indentOf(text);
    const rowBody = text.slice(rowIndent.length);
    if (/^否(?:\s|$)/u.test(rowBody)) hasDefault = true;
  }
  if (lastRow < 0 || hasDefault) return [];
  const rowText = (ctx.doc.lines[lastRow - 1] ?? '').slice(rowIndent.length);
  const columns = /^(\S+)\s+(\S.*)$/u.exec(rowText);
  if (columns === null) return [];
  const value = columns[2]!.trim();
  if (value.length === 0) return [];
  const newLine = `${rowIndent}否 ${value}`;
  const name = /^#\s+表\s+(\S+)/u.exec(head)?.[1] ?? '';
  return [
    makeFact(
      'complete',
      `补兜底行 \`否 ${preview(value)}\`（表「${name}」）`,
      [replaceLines(ctx.doc, lastRow, lastRow, [ctx.doc.lines[lastRow - 1] ?? '', newLine])],
      [diag],
      diag.code as CoreDiagnosticCode,
    ),
  ];
}

/* ---------------------------- 补 `? 否`（池） ---------------------------- */

function poolDefaultCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const at = diag.span!.start.line;
  const headLine = findDeclLineUpward(ctx.doc, at, /^#\s+池(?:\s|$)/u);
  if (headLine === null) return [];
  const head = ctx.doc.lines[headLine - 1] ?? '';
  if (indentWidth(head) !== 0) return [];
  let bodyEnd = headLine;
  for (let i = headLine + 1; i <= ctx.doc.lines.length; i += 1) {
    const text = ctx.doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) break;
    if (indentWidth(text) === 0) break;
    bodyEnd = i;
  }
  if (bodyEnd <= headLine) return [];
  const armIndent = `${indentOf(head)}    `;
  let lastArm = -1;
  for (let i = headLine + 1; i <= bodyEnd; i += 1) {
    const text = ctx.doc.lines[i - 1] ?? '';
    if (indentOf(text) !== armIndent) continue;
    if (/^\?(?:\s|$)/u.test(text.slice(armIndent.length))) lastArm = i;
  }
  if (lastArm < 0) return [];
  const armBody = (ctx.doc.lines[lastArm - 1] ?? '').slice(armIndent.length);
  if (/^\?\s*否\s*$/u.test(armBody)) return [];
  // 末条分支的正文（原样沿用；`? 否` 分支不能为空，§7.1）
  const copied: string[] = [];
  let lastBodyLine = -1;
  for (let i = lastArm + 1; i <= bodyEnd; i += 1) {
    const text = ctx.doc.lines[i - 1] ?? '';
    if (isEmptyLine(text)) continue;
    if (indentWidth(text) <= armIndent.length) break;
    copied.push(text);
    lastBodyLine = i;
  }
  if (lastBodyLine < 0 || copied.length === 0) return [];
  const name = /^#\s+池\s+(\S+)/u.exec(head)?.[1] ?? '';
  return [
    makeFact(
      'complete',
      `补兜底分支 \`? 否\`（池「${name}」，正文沿用末条分支）`,
      [
        replaceLines(ctx.doc, lastBodyLine, lastBodyLine, [
          ctx.doc.lines[lastBodyLine - 1] ?? '',
          `${armIndent}? 否`,
          ...copied,
        ]),
      ],
      [diag],
      diag.code as CoreDiagnosticCode,
    ),
  ];
}

/* ---------------------------- 补 `[插槽]`（模板） ---------------------------- */

function templateSlotCandidates(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const callLine = diag.span!.start.line;
  const call = ctx.doc.lines[callLine - 1] ?? '';
  const called = /^!\s*([^\s(（]+)/u.exec(bodyOf(call));
  if (called === null) return [];
  const name = called[1]!;
  const headLine = findLine(
    ctx.doc,
    new RegExp(`^#\\s+模\\s+${escapeRegExp(name)}(?:\\s*\\(|\\s*$)`, 'u'),
  );
  if (headLine === null) return [];
  const head = ctx.doc.lines[headLine - 1] ?? '';
  if (indentWidth(head) !== 0) return [];
  const end = blockEndLine(ctx.doc, headLine);
  for (let i = headLine; i <= end; i += 1) {
    if (bodyOf(ctx.doc.lines[i - 1] ?? '').trim() === '[插槽]') return [];
  }
  const slotLine = `${indentOf(head)}    [插槽]`;
  const at = end > headLine ? end : headLine;
  return [
    makeFact(
      'complete',
      `补 \`[插槽]\`（模板「${name}」）`,
      [replaceLines(ctx.doc, at, at, [ctx.doc.lines[at - 1] ?? '', slotLine])],
      [diag],
      diag.code as CoreDiagnosticCode,
    ),
  ];
}

/* ---------------------------- 修缩进 ---------------------------- */

/**
 * 缩进候选（按"最可能的层级"排序，逐条交给校验筛）。
 *
 * 为什么不是一条算式：`2 空格` 在 2 空格风格的文件里可能是**一级**，在 4 空格文件里
 * 却可能是"半级"（`? 否` 与链头对齐、体的半级）。单靠宽度分不出来，靠**上下文**先猜、
 * 再让 core `parse` 判决（{@link verifyFact}）——这就是本层不写"缩进推断算法"的原因。
 */
function indentCandidates(doc: SourceDoc, line: number, body: string, current: number): number[] {
  const out: number[] = [];
  const push = (width: number): void => {
    if (!Number.isInteger(width) || width < 0 || width > 256) return;
    if (width % 4 !== 0 || width === current || out.includes(width)) return;
    out.push(width);
  };
  const prev = prevNonBlankLine(doc, line);
  const prevBody = prev === null ? null : bodyOf(doc.lines[prev - 1] ?? '');
  const prevIndent = prev === null ? 0 : indentWidth(doc.lines[prev - 1] ?? '');
  if (/^\?/u.test(body)) {
    // 条件链头：与**最近一条链头**对齐（`? 否` 贴在链尾，不缩进进分支体）
    const chain = nearestPreviousLine(doc, line, (text) => /^\?/u.test(bodyOf(text)));
    if (chain !== null) push(indentWidth(doc.lines[chain - 1] ?? ''));
    push(0);
  } else if (prevBody !== null && BLOCK_HEAD_RE.test(prevBody)) {
    push(prevIndent + 4); // 上一行在等一个缩进体
  } else if (prev !== null) {
    push(prevIndent); // 与上一行同级
  }
  const next = nextNonBlankLine(doc, line);
  if (next !== null) push(indentWidth(doc.lines[next - 1] ?? ''));
  for (const width of [
    Math.round(current / 4) * 4,
    Math.floor(current / 4) * 4,
    Math.ceil(current / 4) * 4,
    0,
    prevIndent,
    prevIndent + 4,
    4,
    8,
  ]) {
    push(width);
  }
  return out;
}

function indentCandidatesOf(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  const line = diag.span!.start.line;
  const text = ctx.doc.lines[line - 1];
  if (text === undefined) return [];
  const indent = indentOf(text);
  const body = text.slice(indent.length);
  if (body.length === 0) return [];
  const current = indentWidth(text);
  const facts: Kojo2CodeActionFact[] = [];
  for (const width of indentCandidates(ctx.doc, line, body, current)) {
    facts.push(
      makeFact(
        'indent',
        `缩进改为 ${width} 空格（第 ${line} 行）`,
        [replaceLines(ctx.doc, line, line, [`${' '.repeat(width)}${body}`])],
        [diag],
        diag.code as CoreDiagnosticCode,
      ),
    );
  }
  return facts;
}

/* ============================== 候选分派 ============================== */

function candidatesFor(diag: KojoDiagnostic, ctx: BuildCtx): Kojo2CodeActionFact[] {
  switch (diag.code) {
    case 'core/narrative/bare-narration':
    case 'core/narrative/bare-quote':
      return textLineCandidates(diag, ctx);
    case 'core/migration/heart':
      return heartCandidates(diag, ctx);
    case 'core/migration/color':
    case 'core/migration/random':
    case 'core/migration/ask':
      return blockMigrateCandidates(diag, ctx);
    case 'core/migration/switch':
    case 'core/migration/branch':
      return hoistCandidates(diag, ctx);
    case 'core/table/missing-default':
      return tableDefaultCandidates(diag, ctx);
    case 'core/pool/no-default':
      return poolDefaultCandidates(diag, ctx);
    case 'core/template/unexpected-slot':
      return templateSlotCandidates(diag, ctx);
    case 'core/lex/indent':
      return indentCandidatesOf(diag, ctx);
    default:
      return [];
  }
}

/* ============================== 校验 ============================== */

function defaultVerifier(filePath: string): Kojo2CodeActionVerifier {
  return {
    parse: (source) => parseSource(source).diagnostics,
    // 全链只用来判"目标码消失"（见模块头「纪律二」）：fixture 事实足够——表 / 池 / 模板的
    // 必填件判据住在 core 的降糖与展开里，与"这台 adapter 支不支持颜色"无关。
    compile: (source) =>
      compileKojoSource({
        source,
        filePath,
        adapter: FIXTURE_ADAPTER,
        backend: FIXTURE_BACKEND,
      }).diagnostics,
  };
}

function safeParse(
  verifier: Kojo2CodeActionVerifier,
  source: string,
): readonly KojoDiagnostic[] | null {
  try {
    return verifier.parse(source);
  } catch {
    return null; // 解析器抛错 = 这份产物不可用（不产动作），绝不外抛给 Monaco
  }
}

function safeCompile(
  verifier: Kojo2CodeActionVerifier,
  source: string,
): readonly KojoDiagnostic[] | null {
  try {
    return verifier.compile(source);
  } catch {
    return null;
  }
}

function touchesSpan(span: KojoSpan | null, ranges: AppliedEdits['ranges']): boolean {
  if (span === null) return false;
  for (const range of ranges) {
    if (span.start.line <= range.endLine && range.startLine <= span.end.line) return true;
  }
  return false;
}

/** 诊断 span 的行区间与请求区间是否有交集 */
function spanTouchesRequest(span: KojoSpan, range: Kojo2CodeActionRange): boolean {
  return span.start.line <= range.endLine && range.startLine <= span.end.line;
}

/**
 * 一条候选动作的收口判据（见模块头「纪律二」三条）。
 *
 * `before` 是**改前全文件**的解析诊断：改前就有的错误码不记在这条动作账上（否则文件里
 * 任何一条历史问题都会把全部动作一起否决）；改后**新出现**的错误码一票否决。
 */
function verifyFact(fact: Kojo2CodeActionFact, ctx: BuildCtx, before: readonly KojoDiagnostic[]): boolean {
  const applied = applyLineEdits(ctx.doc, fact.edits);
  if (applied.text === ctx.input.source) return false;
  const after = safeParse(ctx.verifier, applied.text);
  if (after === null) return false;
  const beforeErrors = before.filter((diagnostic) => diagnostic.severity === 'error');
  const afterErrors = after.filter((diagnostic) => diagnostic.severity === 'error');
  if (afterErrors.length > beforeErrors.length) return false;
  const beforeCodes = new Set<string>(before.map((diagnostic) => diagnostic.code));
  for (const diagnostic of after) {
    if (!touchesSpan(diagnostic.span, applied.ranges)) continue;
    if (diagnostic.code === fact.code) return false; // 目标码必须消失
    if (diagnostic.severity === 'error' && !beforeCodes.has(diagnostic.code)) return false;
  }
  if (COMPILE_STAGE_CODES.has(fact.code)) {
    const compiled = safeCompile(ctx.verifier, applied.text);
    if (compiled === null) return false;
    if (
      compiled.some(
        (diagnostic) =>
          diagnostic.severity === 'error' &&
          diagnostic.code === fact.code &&
          touchesSpan(diagnostic.span, applied.ranges),
      )
    ) {
      return false;
    }
  }
  return true;
}

function factKey(fact: Kojo2CodeActionFact): string {
  return [fact.kind, ...fact.edits.map((edit) => `${edit.range.startLine}:${edit.newText}`)].join('\u0000');
}

/* ============================== 主入口 ============================== */

/**
 * 一次请求 → 动作事实列表（纯函数：同输入同输出；不读盘、不碰编辑器）。
 *
 * 顺序：按诊断行号升序、同一诊断按候选优先级（修缩进的多候选靠这个顺序表达"先猜哪个"）。
 * 去重键 = 类别 + 编辑内容（同一行两条同码诊断只出一条动作；被否决过的候选也不再重复尝试）。
 */
export function kojo2CodeActionFacts(input: Kojo2CodeActionInput): Kojo2CodeActionFact[] {
  if (input.enabled === false) return [];
  const doc = readDoc(input.source);
  const verifier = input.verifier ?? defaultVerifier(input.filePath ?? 'untitled.kojo2');
  const ctx: BuildCtx = { doc, input, speaker: resolveSpeaker(input, doc), verifier };
  const before = safeParse(verifier, input.source) ?? [];
  const ordered = [...input.diagnostics].sort(
    (a, b) => (a.span?.start.line ?? 0) - (b.span?.start.line ?? 0),
  );
  const facts: Kojo2CodeActionFact[] = [];
  const seen = new Set<string>();
  // 同一条诊断可能被报两次（例如 `core/lex/indent` 在同一行同时命中"不是一级倍数"与
  // "比基准深却没有块头"）：一条诊断行只出一条动作，否则 💡 里会出现两条一模一样的修复。
  const handledTargets = new Set<string>();
  for (const diag of ordered) {
    if (!KOJO2_CODE_ACTION_CODES.has(diag.code)) continue;
    const span = diag.span;
    if (span === null) continue;
    if (!spanTouchesRequest(span, input.range)) continue;
    const target = `${diag.code}@${span.start.line}`;
    if (handledTargets.has(target)) continue;
    handledTargets.add(target);
    for (const candidate of candidatesFor(diag, ctx)) {
      const key = factKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      // 被否的候选不再回头试（`seen`），但**继续试下一个**：修缩进的候选是按优先级排的，
      // 第一条不过 core `parse` 就该让位给下一条。
      if (!verifyFact(candidate, ctx, before)) continue;
      facts.push(candidate);
      break;
    }
  }
  return facts;
}

/* ============================== Monaco 翻译层 ============================== */

/** 动作执行命令 id（宿主统一注册一次；参数 = 待落地动作的反查 key） */
export const KOJO2_CODE_ACTION_COMMAND = 'kojo2.codeAction.run';

/** 本 provider 会产出的 Monaco 类别（`providedCodeActionKinds` 的交集判据） */
export const KOJO2_PROVIDED_CODE_ACTION_KINDS: readonly string[] = [QUICK_FIX_KIND, REFACTOR_KIND];

/** 动作类别 → Monaco `CodeActionKind`（迁移 / 补全是 quickfix，改缩进是 refactor） */
export function kojo2CodeActionKindOf(kind: Kojo2CodeActionKind): string {
  return kind === 'indent' ? REFACTOR_KIND : QUICK_FIX_KIND;
}

/** 事实的编辑 → 宿主 `EditorTextEdit`（整行替换，逐字对应） */
export function kojo2EditorEditsOf(fact: Kojo2CodeActionFact): EditorTextEdit[] {
  return fact.edits.map((edit) => ({
    fromLine: edit.range.startLine,
    toLine: edit.range.endLine,
    newText: edit.newText,
  }));
}

/**
 * Monaco marker → core 诊断（`Ctrl+.` 递进来的是**面上画着的那几条**）。
 *
 * 只收有字符串 `code` 的 marker：没码就没法判"这是不是我认领的构造"（不猜）。severity 用
 * marker 自己的（`kojo2DiagnosticsToMarkers` 正向翻译时就取的是 core 的严重级）。
 */
export function kojo2DiagnosticsFromMarkers(
  monaco: Pick<typeof Monaco, 'MarkerSeverity'>,
  markers: readonly Monaco.editor.IMarkerData[],
): KojoDiagnostic[] {
  const out: KojoDiagnostic[] = [];
  for (const marker of markers) {
    const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
    if (typeof code !== 'string' || code.length === 0) continue;
    out.push({
      code: code as DiagnosticCode,
      severity: marker.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'error',
      message: marker.message,
      span: {
        start: { line: marker.startLineNumber, column: marker.startColumn },
        end: { line: marker.endLineNumber, column: marker.endColumn },
      },
    });
  }
  return out;
}

/**
 * 事实 → Monaco `CodeAction[]`。
 *
 * - `command` 而不是 `edit`：落地必须走宿主那条带 undo 停点的通道（见模块头「纪律三」）；
 * - `diagnostics`：把这条动作认领的诊断翻成 marker（Monaco 据此排序 / 画"已修复区间"）；
 * - `isPreferred`：**唯一解才置**——本次请求里恰好只有一条 quickfix 类动作时它直接命中
 *   `Ctrl+.`（多解不替作者选，与 v1 那条腿的 `pickPreferred` 同一产品口径）。
 */
export function kojo2CodeActionsOf(
  monaco: typeof Monaco,
  source: string,
  facts: readonly Kojo2CodeActionFact[],
  keyOf: (fact: Kojo2CodeActionFact) => string,
): Monaco.languages.CodeAction[] {
  const quickFixes = facts.filter((fact) => kojo2CodeActionKindOf(fact.kind) === QUICK_FIX_KIND);
  const preferred = quickFixes.length === 1 ? quickFixes[0] : undefined;
  return facts.map((fact) => {
    const markers = kojo2DiagnosticsToMarkers(monaco, fact.diagnostics, source);
    const action: Monaco.languages.CodeAction = {
      title: fact.title,
      kind: kojo2CodeActionKindOf(fact.kind),
      command: { id: KOJO2_CODE_ACTION_COMMAND, title: fact.title, arguments: [keyOf(fact)] },
    };
    if (markers.length > 0) action.diagnostics = markers;
    if (fact === preferred) action.isPreferred = true;
    return action;
  });
}

/** 宿主注入面（本层不认识 pane / EditorPane；落地与取文全在宿主） */
export interface Kojo2CodeActionHost {
  /**
   * 落地端口：宿主接到**既有** `applyTextEdits`（前后各一颗 undo 停点）。
   * 返回是否真落了（糖视图 / 无归属实例 ⇒ false，本层不解释原因，由宿主自己说）。
   */
  readonly applyEdits: (model: Monaco.editor.ITextModel, edits: readonly EditorTextEdit[]) => boolean;
  /** 裸引号说话人兜底（缺省 = 有 `# 视` 时用 `我`） */
  readonly speaker?: () => string | null | undefined;
  /** 文件身份（喂校验编译入口；缺省 = `model.uri` 的 fsPath） */
  readonly filePath?: (model: Monaco.editor.ITextModel) => string | null;
  /** 替换校验入口（测试注入） */
  readonly verifier?: (filePath: string) => Kojo2CodeActionVerifier;
}

/** 待落地动作表的上限（每次请求登记若干条；超了丢最老的，绝不无界增长） */
const PENDING_ACTION_LIMIT = 256;

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

function uriTextOf(model: Monaco.editor.ITextModel): string {
  const uri = (model as unknown as { uri?: { toString?: () => string } }).uri;
  return uri !== undefined && typeof uri.toString === 'function' ? uri.toString() : '';
}

function filePathOfModel(model: Monaco.editor.ITextModel): string | null {
  const uri = (model as unknown as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === undefined) return null;
  for (const value of [uri.fsPath, uri.path]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * 为 `kojo2` 语言注册**一枚** code action provider（+ 一条执行命令），返回**幂等** disposable。
 *
 * flag 关 ⇒ 空操作（**零注册**）；注册半途抛错 ⇒ 撤回已挂上的再外抛（宿主那一侧的
 * "全有或全无"回滚才有东西可撤）。provider 体内任何抛错都收成"这一轮没有动作"——
 * Monaco 会把 throw 吞成"💡 突然空了"，作者看不到任何原因。
 */
export function installKojo2CodeActionProvider(
  monaco: typeof Monaco,
  host: Kojo2CodeActionHost,
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const pending = new Map<string, { readonly uri: string; readonly edits: readonly EditorTextEdit[] }>();
  const order: string[] = [];
  let seq = 0;

  const remember = (uri: string, edits: readonly EditorTextEdit[]): string => {
    const key = `${++seq}`;
    pending.set(key, { uri, edits });
    order.push(key);
    while (order.length > PENDING_ACTION_LIMIT) {
      const oldest = order.shift();
      if (oldest !== undefined) pending.delete(oldest);
    }
    return key;
  };

  const EMPTY: Monaco.languages.CodeActionList = { actions: [], dispose: () => undefined };

  const provider: Monaco.languages.CodeActionProvider = {
    provideCodeActions(model, range, context) {
      try {
        const languageId = typeof model.getLanguageId === 'function' ? model.getLanguageId() : '';
        if (languageId !== KOJO2_LANGUAGE_ID) return EMPTY; // 只对 2.0 文件生效（v1 面零动作）
        const source = model.getValue();
        if (typeof source !== 'string') return EMPTY;
        const markers = context.markers ?? [];
        const diagnostics = kojo2DiagnosticsFromMarkers(monaco, markers);
        const speaker = host.speaker?.() ?? null;
        const filePath = host.filePath?.(model) ?? filePathOfModel(model);
        const verifier = host.verifier?.(filePath ?? 'untitled.kojo2');
        const facts = kojo2CodeActionFacts({
          source,
          diagnostics,
          range: {
            startLine: range.startLineNumber,
            startColumn: range.startColumn,
            endLine: range.endLineNumber,
            endColumn: range.endColumn,
          },
          ...(typeof speaker === 'string' && speaker.trim().length > 0 ? { speaker } : {}),
          ...(typeof filePath === 'string' && filePath.length > 0 ? { filePath } : {}),
          ...(verifier !== undefined ? { verifier } : {}),
        });
        if (facts.length === 0) return EMPTY;
        const uri = uriTextOf(model);
        const actions = kojo2CodeActionsOf(monaco, source, facts, (fact) =>
          remember(uri, kojo2EditorEditsOf(fact)),
        );
        return { actions, dispose: () => undefined };
      } catch (error: unknown) {
        console.warn(`[kojo2-code-actions] 产出动作时抛错：${errorText(error)}`);
        return EMPTY;
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      monaco.editor.registerCommand(KOJO2_CODE_ACTION_COMMAND, (_accessor, key: unknown) => {
        if (typeof key !== 'string') return;
        const entry = pending.get(key);
        if (entry === undefined) return;
        const model = monaco.editor.getModel(monaco.Uri.parse(entry.uri));
        if (model === null || model.isDisposed()) return;
        try {
          host.applyEdits(model, entry.edits);
        } catch (error: unknown) {
          console.warn(`[kojo2-code-actions] 落地动作时抛错：${errorText(error)}`);
        }
      }),
    );
    registrations.push(
      monaco.languages.registerCodeActionProvider(KOJO2_LANGUAGE_ID, provider, {
        providedCodeActionKinds: KOJO2_PROVIDED_CODE_ACTION_KINDS,
      }),
    );
  } catch (error) {
    for (const registration of registrations) {
      try {
        registration.dispose();
      } catch {
        /* 半途回滚：一枚撤不掉不许带走其余（错误原样外抛给宿主） */
      }
    }
    throw error;
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      order.length = 0;
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          /* 幂等 + 逐枚隔离 */
        }
      }
    },
  };
}
