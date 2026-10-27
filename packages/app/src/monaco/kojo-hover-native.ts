import type {
  KojoCounterTable,
  KojoFaceTable,
  KojoFaceTemplate,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import { kojoIndexNameOf, resolveKojoIndexName } from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/kojo-vocab/types';
import { lookupFunctionName } from '@kojo/kojo-vocab/system-functions';
import { STATEMENT_FUNCTIONS } from '@kojo/kojo-vocab/statement-functions';
import { SUGAR_LEXICON_WORDS, TIMING_NAMED_PARAMS } from '@kojo/kojo-vocab/keywords';
import { buildFunctionName } from '@kojo/plugin-kojo-sugar';

/**
 * ZH-D3 · 悬停**原生形态**反查（中文 → 原文，显示线的第三面）。
 *
 * 姊妹模块 `kojo-hover.ts` 做的是**正向**（原生记号 → 中文名）；作者在 `.kojo` 里写的却是
 * **中文**（族头 `现在:`、函数名 `意识清醒(...)`、块头 `时机 指令 摸屁股：`），正向面对它
 * 一无所出 ⇒ 改产物、和游戏侧对照、问人都卡在"这个名字到底是哪个原生形态"。本模块补上反向路。
 *
 * ## 数据源（**零新表**：每一条都是降糖 / 拼名链上已经在用的那张表）
 *
 * - 族头：契约 `VariableSchema.familyAlias`（中文名 → 引擎族头；表住 adapter），
 *   经 `makeLookup` 转发到 `DictionaryLookup.familyAlias`；
 * - 函数名：`kojo-sugar` 的 `lookupFunctionName`（**系统函数表优先、再查 adapter 基础库表**
 *   ——与降糖**同一个函数**，故"能降糖的必能反查"构造性成立）；
 * - 语句形函数名：`STATEMENT_FUNCTIONS`（严格 3 枚白名单，与系统表同源）；
 * - 时机分野：adapter `KojoFaceTable.faces[*].template` + **转译器的 `buildFunctionName`**
 *   （`{t}` 家族段 / `{n}` 角色号 / `{i}` 编号）——本模块不拼一个字符；
 * - 段取值 / 成否位值：`KojoFaceTemplate.segments`、`KojoFaceTable.successFlag.values`；
 * - 指令中文名 → 编号：`KojoInstructionTable.lookupByName`（计数器名走 `KojoCounterTable`）。
 *
 * ## 纪律
 *
 * 1. **不猜**：表查不到 ⇒ 不显示；缺角色号 / 缺编号 ⇒ 只给模板、不给拼出来的名字
 *    （半个函数名比没有更坏）；
 * 2. **只读**：纯函数，零 IO、零事件、不碰诊断与产物字节；
 * 3. 词形（`角色:` / `口上:` / `时机`）**不硬编码**，由语言层词表 `SUGAR_LEXICON_WORDS` 派生；
 * 4. 段求值与编号求值的口径逐条对齐转译器（`resolveFace` / `resolveTimingIndex`），
 *    只在**上游同一张表**上取值。
 */

/** 反查所需的数据表（全部**可选**；缺席 = 该路不反查，与正向同一条纪律） */
export interface NativeHoverTables {
  /** 变量字典（`makeLookup(adapter.variableSchema)`）：族头中文别名反查 */
  readonly dictionary?: DictionaryLookup;
  /** 基础库 / 常用函数名表（adapter）：中文函数名 → 原生函数名 */
  readonly libraryTable?: KojoLibraryTable;
  /** 指令名表（adapter）：中文指令名 → 编号 */
  readonly instructionTable?: KojoInstructionTable;
  /** 计数器值域表（adapter；宿主未注入 = 计数器名这一路不反查） */
  readonly counterTable?: KojoCounterTable;
  /** 时机分野模板表（adapter）：分野关键字 → 函数名模板 */
  readonly faceTable?: KojoFaceTable;
  /** 适配器变量 schema 本体：族级说明 / 具名索引 → 编号 */
  readonly variableSchema?: VariableSchema;
}

/** 文件头事实（拼 `{n}` / `{t}` 用；由装配点从模型只读解析，作者没写就没有） */
export interface KojoDocHeader {
  /** `角色:` 声明的角色编号（未声明 = 拼不出函数名，只给模板） */
  readonly charNo?: string;
  /** 家族段（标准版空串、别人版 `_口上名`；口径同转译器的家族段求值） */
  readonly familySeg?: string;
}

/** 一次反查的产物：主原生形态 + 类别 + 附加行 + 命中列区间（1 基） */
export interface NativeHoverHit {
  readonly name: string;
  readonly kind: string;
  readonly startColumn: number;
  readonly endColumn: number;
  /** 附加行（markdown；只在表里真有这一项时才出现） */
  readonly lines?: readonly string[];
}

/**
 * 汉字 / 假名run（**不含**标点与 ASCII）——正向那条路的 `spanAround` 只认 ASCII，
 * 两条路各扫各的字符集，互不抢道。
 */
const CJK_RE = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const isCjk = (ch: string): boolean => CJK_RE.test(ch);
const WHITESPACE_RE = /\s/;

/** 空白切分的词元（保留行内绝对下标，供"光标落在第几枚令牌"判定） */
interface HeadToken {
  readonly start: number;
  readonly end: number;
  /** 原文（含尾冒号） */
  readonly raw: string;
  /** 去掉尾冒号（全 / 半角）的文本 */
  readonly text: string;
  /** 是否以冒号收尾 */
  readonly colon: boolean;
}

/** 时机块头的结构化读法（`时机 <分野> [编号] [命名参数: 取值]…：`） */
interface TimingHead {
  readonly face: string;
  /** 编号位令牌（分野之后第一枚、且不是命名参数键） */
  readonly indexText?: string;
  /** 命名参数键 → 取值（`类型: 副指令` → `类型 → 副指令`） */
  readonly params: ReadonlyMap<string, string>;
  /** 值令牌 → 它的键（反查取值时用它定位键） */
  readonly valueKeyAt: ReadonlyMap<number, string>;
  /** 块头词元（`时机` 关键字之后；下标用于光标定位） */
  readonly tokens: readonly HeadToken[];
}

/** 语言层词表派生的关键字集合（零硬编码词形；英文别名同样认） */
const wordsOf = (id: string): readonly string[] =>
  SUGAR_LEXICON_WORDS.filter((w) => (w.id as string) === id).map((w) => w.word);
const keySet = (id: string): ReadonlySet<string> => new Set(wordsOf(id));
const TIMING_KEYS = keySet('block.timing');
const CHAR_KEYS = keySet('head.char');
const FAMILY_KEYS = keySet('head.family');

/** `成否` 规范名（不硬编码：取自命名参数键表的 `successFlag` 条目） */
const SUCCESS_PARAM: string | undefined = TIMING_NAMED_PARAMS.find((p) => p.valueSource === 'successFlag')?.name;

/** 文件头最多向前扫这么多行（块体里不再出现头声明；防 pathological 长文件） */
const HEADER_SCAN_LINES = 240;

/** 命中光标的最长汉字段（与正向 `spanAround` 同口径：先取光标处、否则取左邻；无则 null） */
function cjkSpanAround(line: string, col0: number): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (col0 < line.length && isCjk(line[col0]!)) {
    start = col0;
    end = col0 + 1;
  } else if (col0 > 0 && isCjk(line[col0 - 1]!)) {
    start = col0 - 1;
    end = col0;
  } else {
    return null;
  }
  while (start > 0 && isCjk(line[start - 1]!)) start--;
  while (end < line.length && isCjk(line[end]!)) end++;
  return { start, end };
}

/** 数字 / ASCII 词语 run（只服务时机块头**编号位的纯数字令牌**反向查名，见 `resolveNativeHover`） */
const WORD_RE = /[A-Za-z0-9_]/;

/** 命中光标的最长数字 / ASCII 词 run（口径同 {@link cjkSpanAround}） */
function wordSpanAround(line: string, col0: number): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (col0 < line.length && WORD_RE.test(line[col0]!)) {
    start = col0;
    end = col0 + 1;
  } else if (col0 > 0 && WORD_RE.test(line[col0 - 1]!)) {
    start = col0 - 1;
    end = col0;
  } else {
    return null;
  }
  while (start > 0 && WORD_RE.test(line[start - 1]!)) start--;
  while (end < line.length && WORD_RE.test(line[end]!)) end++;
  return { start, end };
}

/** 空白切分词元（`时机 指令 310 类型: 副指令：` → 四枚） */
function tokenizeFrom(line: string, from: number): HeadToken[] {
  const out: HeadToken[] = [];
  let i = from;
  while (i < line.length) {
    if (WHITESPACE_RE.test(line[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < line.length && !WHITESPACE_RE.test(line[i]!)) i++;
    const raw = line.slice(start, i);
    out.push({ start, end: i, raw, text: raw.replace(/[：:]+$/, ''), colon: /[：:]$/.test(raw) });
  }
  return out;
}

/**
 * 解析时机块头。**不是**块头（行首不是 `时机` 关键字）→ `undefined`——
 * 分野名 / 编号位只在可证明的块头里认，别处的中文词一律不猜。
 */
function parseTimingHead(line: string): TimingHead | undefined {
  const lead = /^[ \t]*/.exec(line)![0].length;
  const all = tokenizeFrom(line, lead);
  if (all.length === 0 || !TIMING_KEYS.has(all[0]!.text)) return undefined;
  const tokens = all.slice(1);
  if (tokens.length === 0) return undefined;
  // `键:` 的判据 = 冒号收尾**且后面还有取值**（块头收尾的全角 `：` 挂在最后一枚上，不是键）
  const isKey = (i: number): boolean => tokens[i]!.colon && i < tokens.length - 1;
  const params = new Map<string, string>();
  const valueKeyAt = new Map<number, string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!isKey(i)) continue;
    params.set(tokens[i]!.text, tokens[i + 1]!.text);
    valueKeyAt.set(i + 1, tokens[i]!.text);
  }
  const indexText = tokens.length > 1 && !isKey(1) ? tokens[1]!.text : undefined;
  return { face: tokens[0]!.text, indexText, params, valueKeyAt, tokens };
}

/**
 * 文件头 → 拼名所需事实（`角色:` 与 `口上:`）。
 *
 * 只读到**第一个时机块头**为止（头声明按规范全在块前），逐行读、不复制全文；
 * 行尾注释（`角色: 12 ; 必填`）与同行 `选择器:`（`口上: 破空 选择器: 1`）都不误收。
 */
export function docHeaderOf(readLine: (lineNumber: number) => string, lineCount: number): KojoDocHeader {
  let charNo: string | undefined;
  let family: string | undefined;
  const limit = Math.min(lineCount, HEADER_SCAN_LINES);
  for (let n = 1; n <= limit; n++) {
    const trimmed = (readLine(n) ?? '').trim();
    if (trimmed.length === 0) continue;
    const first = tokenizeFrom(trimmed, 0)[0];
    if (first !== undefined && TIMING_KEYS.has(first.text)) break;
    // `@` 函数头 / `#` 预处理行 = 已经走出文件头声明区（`.erb` 里第一行就撞上 ⇒ 不空转）
    if (trimmed.startsWith('@') || trimmed.startsWith('#')) break;
    if (trimmed.startsWith(';')) continue;
    const decl = /^([^\s:：]+)[ \t]*[:：][ \t]*(.*)$/.exec(trimmed);
    if (decl === null) continue;
    const key = decl[1]!;
    const rest = decl[2]!;
    if (charNo === undefined && CHAR_KEYS.has(key)) {
      const m = /^(\d+)/.exec(rest);
      if (m !== null) charNo = m[1];
    }
    if (family === undefined && FAMILY_KEYS.has(key)) {
      const head = rest.split(';')[0]!.trim().split(/\s+/)[0];
      if (head !== undefined && head.length > 0) family = head;
    }
    if (charNo !== undefined && family !== undefined) break;
  }
  return {
    ...(charNo !== undefined ? { charNo } : {}),
    ...(family !== undefined ? { familySeg: familySegmentOf(family) } : {}),
  };
}

/** 家族段（口径 = 转译器的家族段求值：标准版空串、别人版 `_名`；名已带下划线时不重复加） */
function familySegmentOf(family: string): string {
  if (family.length === 0) return '';
  return `_${family.startsWith('_') ? family.slice(1) : family}`;
}

/** `${段名}` → 段文本（口径同转译器 `resolveFace`：先命名参数声明值、未声明取**首个候选**） */
function applySegments(template: string, segments: Readonly<Record<string, string>>): string {
  return template.replace(/\$\{([^}]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(segments, name) ? segments[name]! : whole,
  );
}

/** 命名参数键 → 块头上的取值（中文规范名与英文别名同样认） */
function declaredValue(head: TimingHead, paramName: string | undefined): string | undefined {
  if (paramName === undefined) return undefined;
  const spec = TIMING_NAMED_PARAMS.find((p) => p.name === paramName || p.alias === paramName.toLowerCase());
  if (spec === undefined) return undefined;
  return head.params.get(spec.name) ?? (spec.alias === undefined ? undefined : head.params.get(spec.alias));
}

/** 分野模板的段求值表（`类型:` 声明优先、否则取该段第一个候选 = 转译器的缺省段规则） */
function segmentValues(spec: KojoFaceTemplate, head: TimingHead): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [segName, candidates] of Object.entries(spec.segments ?? {})) {
    const paramName = TIMING_NAMED_PARAMS.find((p) => p.segmentName === segName)?.name;
    const declared = declaredValue(head, paramName);
    const keys = Object.keys(candidates);
    const chosen = declared !== undefined && candidates[declared] !== undefined ? declared : keys[0];
    if (chosen !== undefined) out[segName] = candidates[chosen]!;
  }
  return out;
}

/**
 * `{i}` 槽的取值（IX-1：口径收拢到契约纯函数 `resolveKojoIndexName`——与转译器
 * `resolveTimingIndex` / 编号槽补全 `kojoIndexCompletionItems` **同一真源**；数字直通 /
 * `literal` 原样 / 名查表全在那一份里；查不到 ⇒ 不拼）。
 */
function resolveIndex(
  spec: KojoFaceTemplate,
  indexText: string | undefined,
  tables: NativeHoverTables,
): string | undefined {
  if (indexText === undefined || indexText.length === 0) return undefined;
  const probe = resolveKojoIndexName(spec.indexKind, indexText, {
    instructionTable: tables.instructionTable,
    counterTable: tables.counterTable,
  });
  return probe.ok ? probe.index : undefined;
}

/**
 * 分野 → **拼出来的函数名**（占位符求值全交转译器的 `buildFunctionName`；
 * 本模块只做段求值与编号取值）。`want = 'success'` 走该面的成否子模板。
 * 拼不出（缺角色号 / 缺编号 / 无成否子模板）⇒ `undefined`。
 */
function renderFaceName(
  spec: KojoFaceTemplate,
  head: TimingHead,
  tables: NativeHoverTables,
  header: KojoDocHeader,
  want: 'main' | 'success',
): string | undefined {
  if (header.charNo === undefined) return undefined;
  if (want === 'success' && spec.success === undefined) return undefined;
  const segments = segmentValues(spec, head);
  const rawTemplate = want === 'success' ? spec.success!.template : spec.template;
  const template = applySegments(rawTemplate, segments);
  const index = resolveIndex(spec, head.indexText, tables);
  const paramIndex = want === 'success' ? true : template.includes('{i}');
  if (paramIndex && index === undefined) return undefined;
  return buildFunctionName(template, header.familySeg ?? '', header.charNo, index, paramIndex);
}

/** 光标落在第几枚词元（不在任何词元内 ⇒ -1） */
function tokenIndexOf(tokens: readonly HeadToken[], start: number, end: number): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.start <= start && end <= t.end) return i;
  }
  return -1;
}

const code = (text: string): string => `\`${text}\``;

/** 时机块头的三路反查：分野 → 函数名 / 编号位名 → 编号 / 命名参数取值 → 原生段值 */
function resolveTimingHead(
  head: TimingHead,
  span: { start: number; end: number },
  word: string,
  tables: NativeHoverTables,
  header: KojoDocHeader,
): NativeHoverHit | undefined {
  const hit = (name: string, kind: string, lines: readonly string[] = []): NativeHoverHit => ({
    name,
    kind,
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    ...(lines.length > 0 ? { lines } : {}),
  });
  const idx = tokenIndexOf(head.tokens, span.start, span.end);
  if (idx < 0) return undefined;
  const active = head.tokens[idx]!;
  if (active.text !== word || word.length === 0) return undefined;
  const spec = tables.faceTable?.faces[head.face];
  if (spec === undefined) return undefined;

  // ① 分野关键字 → 原生函数名（拼不出来时只给模板，绝不给半个名字）
  if (idx === 0) {
    const rendered = renderFaceName(spec, head, tables, header, 'main');
    const lines: string[] = [];
    if (rendered !== undefined) lines.push(`函数名模板：${code(spec.template)}`);
    if (declaredValue(head, SUCCESS_PARAM) !== undefined) {
      const successName = renderFaceName(spec, head, tables, header, 'success');
      if (successName !== undefined) lines.push(`成否函数名：${code(successName)}`);
    }
    return hit(
      rendered ?? spec.template,
      rendered !== undefined ? `时机分野 · ${active.text}` : `时机分野 · 函数名模板`,
      lines,
    );
  }

  // ② 编号位上的中文指令名 / 计数器名 → 原生编号；纯数字编号 → 反向回中文名（IX-1）
  if (idx === 1 && head.indexText === active.text) {
    const kind = spec.indexKind ?? 'command';
    const nativeIndex = resolveIndex(spec, active.text, tables);
    if (nativeIndex === undefined) return undefined;
    const rendered = renderFaceName(spec, head, tables, header, 'main');
    // 纯数字编号（`时机 计数器 20：`）：反向查名——作者无从知道 20 是哪条计数器
    //（`lookupByNumber` / `lookupByNo` 自 1016 起在生产侧零消费）。`literal` 面无反向
    //（尾部本就是运行期形态名），号未登记 ⇒ 退回旧行为（见下）。
    if (kind !== 'literal' && /^\d+$/.test(active.text)) {
      const name = kojoIndexNameOf(kind, Number(active.text), tables);
      if (name !== undefined) {
        const label = kind === 'counter' ? '计数器' : '指令';
        return hit(
          name,
          `${label}名 · 编号 ${active.text}`,
          rendered !== undefined ? [`函数名：${code(rendered)}`] : [],
        );
      }
    }
    // 中文名被换算成了编号 ⇒ 给编号 + 函数名
    if (nativeIndex !== active.text) {
      const label = kind === 'counter' ? '计数器' : '指令';
      return hit(
        nativeIndex,
        `原生编号 · ${label}「${active.text}」`,
        rendered !== undefined ? [`函数名：${code(rendered)}`] : [],
      );
    }
    // 名本身就是原生形态（`indexKind: literal` 的运行期形态名 / 未登记数字）⇒ 换成函数名才有
    // 信息量；拼不出函数名时这一路不显示（给一个"翻译了个寂寞"的同形词不如不给）。
    if (rendered === undefined) return undefined;
    return hit(rendered, `时机形态名 · ${active.text}`);
  }

  // ③ 命名参数**取值** → 原生段文本 / 成否位值（`类型: 副指令` → `SCOM`）
  const key = head.valueKeyAt.get(idx);
  if (key === undefined) return undefined;
  const param = TIMING_NAMED_PARAMS.find((p) => p.name === key || (p.alias !== undefined && key.toLowerCase() === p.alias));
  if (param === undefined) return undefined;
  if (param.valueSource === 'segment' && param.segmentName !== undefined) {
    const segText = spec.segments?.[param.segmentName]?.[active.text];
    if (segText === undefined) return undefined;
    return hit(segText, `原生段值 · ${param.name}「${active.text}」`);
  }
  if (param.valueSource === 'successFlag') {
    const value = tables.faceTable?.successFlag?.values?.[active.text];
    if (value === undefined) return undefined;
    return hit(String(value), `成否位值 · ${active.text}`);
  }
  return undefined;
}

/** 族头中文别名 → 引擎族头（带索引段时一并给出原生引用与编号，如 `NOWEX:噴乳` / `193`） */
function resolveFamilyAlias(
  lineText: string,
  span: { start: number; end: number },
  word: string,
  tables: NativeHoverTables,
): NativeHoverHit | undefined {
  const tail = lineText.slice(span.end);
  if (!tail.startsWith(':') && !tail.startsWith('：')) return undefined;
  const native = tables.dictionary?.familyAlias?.(word);
  if (native === undefined || native.length === 0) return undefined;
  const lines: string[] = [];
  // 索引段必须**紧贴**冒号（`NOWEX:噴乳`）——冒号后是空白就不是引用，不敢当索引段读
  const seg = /^[:：]([^\s,;:：()（）「」『』""'']*)/.exec(tail)?.[1];
  if (seg !== undefined && seg.length > 0) {
    lines.push(`原生引用：${code(`${native}:${seg}`)}`);
    const resolvedIndex = tables.variableSchema?.lookup(native, seg)?.resolvedIndex;
    if (resolvedIndex !== undefined) lines.push(`索引编号：${code(String(resolvedIndex))}`);
  }
  const label = tables.variableSchema?.lookup(native)?.description;
  if (label !== undefined && label.length > 0 && label !== native) lines.push(`含义：${label}`);
  return {
    name: native,
    kind: `原生族头 · ${word}`,
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    ...(lines.length > 0 ? { lines } : {}),
  };
}

/** 中文函数名 → 原生函数名（**降糖同一个 `lookupFunctionName`**：系统表优先、再 adapter 基础库表） */
function resolveFunctionName(
  lineText: string,
  span: { start: number; end: number },
  word: string,
  tables: NativeHoverTables,
): NativeHoverHit | undefined {
  const tail = lineText.slice(span.end);
  const base = { startColumn: span.start + 1, endColumn: span.end + 1 };
  if (/^[ \t]*\(/.test(tail)) {
    const native = lookupFunctionName(word, tables.libraryTable);
    if (native === undefined || native.length === 0) return undefined;
    return { name: `${native}()`, kind: `原生函数名 · ${word}`, ...base };
  }
  const statement = STATEMENT_FUNCTIONS.get(word);
  if (statement !== undefined && /^[ \t]+\S/.test(tail)) {
    return { name: statement, kind: `原生语句形 · ${word}`, ...base };
  }
  return undefined;
}

/**
 * 解析光标下的**原生形态**（**纯函数**，与正向 `resolveHoverName` 互补）。
 *
 * `column` = Monaco 的 1 基列；`header` = 文件头事实（`角色:` / `口上:`；缺省 = 不拼函数名）。
 * 返回 `undefined` = 该处没有可证明的原生形态（**不猜**）。
 */
export function resolveNativeHover(
  lineText: string,
  column: number,
  tables: NativeHoverTables,
  header: KojoDocHeader = {},
): NativeHoverHit | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  const col0 = Math.min(column - 1, lineText.length);
  const span = cjkSpanAround(lineText, col0);
  const head = parseTimingHead(lineText);

  // 非 CJK 光标：只服务时机块头**编号位的纯数字令牌**（IX-1 反向查名——作者写
  // `时机 计数器 20：` 时告诉他 20 是哪条计数器）。其余非单词位置照旧不猜。
  if (span === null) {
    if (head === undefined) return undefined;
    const wordSpan = wordSpanAround(lineText, col0);
    if (wordSpan === null) return undefined;
    return resolveTimingHead(head, wordSpan, lineText.slice(wordSpan.start, wordSpan.end), tables, header);
  }

  const word = lineText.slice(span.start, span.end);
  if (head !== undefined) {
    const hit = resolveTimingHead(head, span, word, tables, header);
    if (hit !== undefined) return hit;
  }
  return resolveFamilyAlias(lineText, span, word, tables) ?? resolveFunctionName(lineText, span, word, tables);
}
