import type * as Monaco from './entry';
import type {
    ErbDim,
    ErbFunction,
    ErbFunctionRef,
    ErbIndex,
    KojoCounterTable,
    KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import { symbolTokenAt, unicodeTokenAt } from '@kojo/plugin-api';
import type { DialectCarrier } from '@kojo/kojo-core';
import { parseDimDeclaration } from '@kojo/plugin-erb-parser';
import { isErbDimNameChar as isDimNameChar, normalizePathKey } from '@kojo/plugin-erb-parser';
import type { DictionaryLookup } from '@kojo/kojo-vocab/types';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/kojo-vocab/system-functions';
import { livePanes } from '../ui/editor-pane-registry';
import { erbBitHoverName } from './erb-completion-bits';
import { resolveErbMarkHover } from './kojo-hover-marks';
import { BLANK_CLASS_STR } from './kojo-completion-position';
import { type KojoDocHeader, docHeaderOf, resolveNativeHover } from './kojo-hover-native';
import { registerForLanguageServices } from './register-dialects';

/**
 * 悬停**中文名**（ZH-F2，显示线第二面）—— 把光标下的**原生记号**显示其中文名。
 *
 * 三张真源（**只读**，绝不新造名字；查不到即原样、不猜——与投影反糖同一纪律）：
 * - 数值变量索引（`CFLAG:TARGET:1088` → 好感度）：变量字典 `nameAt`（`makeLookup(schema)`，
 *   宿主按当前项目 adapter 在运行时构造）；
 * - 英文函数名（`GETBIT` → 获取标记）：系统函数表反向 `SYSTEM_FUNCTION_REVERSE` +
 *   基础库表反查 `KojoLibraryTable.lookupByFunction`；
 * - 指令编号（`时机 指令 310：` 的 `310` → 指令表中文名）：`KojoInstructionTable.lookupByNo`；
 * - 位号（D7，`.erb`）：`GETBIT/SETBIT/CLEARBIT/INVERTBIT` 第二实参的位号 → 变量 schema 里
 *   该变量的 `VariableInfo.bits[].label`（中文位名）。
 *
 * 本模块是**只读显示**：不产生编辑、不写盘、不发事件。纯逻辑（`resolveHoverName`）与
 * Monaco 绑定（`installHover`）分离——前者可单测，后者只做位置 → 内容的薄翻译。
 *
 * **ZH-D3 反向面**（中文 → 原生形态）在同一入口末尾接上 `kojo-hover-native.ts`：
 * 上面四条正向路都只认 ASCII 记号，作者在 `.kojo` 里写的中文词（族头 / 中文函数名 /
 * 时机分野与指令名）此前查不到原生形态。反查**不新建任何映射**，只复用降糖与拼名链上
 * 已在用的那几张表（详见 `kojo-hover-native.ts` 头注）；正向命中优先，正向无果才走反向。
 */
export interface HoverTables {
  /** 变量字典（`makeLookup(adapter.variableSchema)` 产物）；缺席 = 不做变量反查 */
  readonly dictionary?: DictionaryLookup;
  /** 基础库 / 常用函数名表（adapter）；缺席 = 不做基础库函数名反查 */
  readonly libraryTable?: KojoLibraryTable;
  /** 指令名表（adapter）；缺席 = 不做指令编号反查 */
  readonly instructionTable?: KojoInstructionTable;
  /**
   * 适配器变量 schema 本体（D7，additive 可选）——位名悬停用它把 `GETBIT/SETBIT/…` 第二实参
   * 的位号反查成中文位名（`VariableInfo.bits`）。缺席 = 不做位名反查（不猜）。
   */
  readonly variableSchema?: VariableSchema;
  /**
     * ERB 函数索引通道（additive 可选）——宿主装配时注入，数据来自 `erb.parser` 服务的
     * `currentIndex()`（**每次悬停现取**：索引随项目开闭重建，缓存会带来上一个项目的脏索引，
     * 与 `getTables` 同款纪律）。通道缺席 / 索引未建 / 求值抛错 ⇒ 本路不产结果（不猜）。
     */
    readonly erbIndex?: () => ErbIndex | null | undefined;
    /**
     * 时机分野模板表（adapter `kojoFaceTemplates`；ZH-D3，additive 可选）——中文分野名反查
     * **拼出来的原生函数名**用它。缺席 = 不做分野反查（不猜）。
     */
    readonly faceTable?: KojoFaceTable;
    /**
     * 计数器值域表（adapter `kojoCounterTable`；ZH-D3，additive 可选）——
     * `时机 计数器 <中文名>：` 的中文名 → 原生编号。缺席 = 该路不反查（不猜），
     * 由宿主 `editorTables()` 从当前 adapter 现取注入。
     */
    readonly counterTable?: KojoCounterTable;
    /**
     * 载体注册壳前缀（LAU-D3，additive 可选）——方言在 `carriers[].shells` 里声明的
     * "这个载体在 ERB 上的注册壳函数前缀"。命中即给一句「这条事件在 xml」，
     * 而不是让壳函数看起来像"没实现的口上"（DoD 第 4 条）。数据来自 2.0 adapter 的
     * **声明**，宿主不认识任何一族名字；缺席 = 不做提示（不猜）。
     */
    readonly carrierShells?: readonly CarrierShellHint[];
}

/**
 * 一条载体注册壳声明（`CarrierBinding.shells` 的宿主投影）。
 *
 * `prefixes` 是**方言事实**（`KOJO_DEFINE_K` 一族），宿主只做前缀 + 数字的匹配，
 * 不解释含义、不据此改任何诊断。匹配口径与 `CarrierBinding.shells` 的注一致：
 * 函数名（大小写不敏感）以某一项为前缀，且**紧跟数字**（`_K{编号}` 锚点）。
 */
export interface CarrierShellHint {
  readonly carrier: DialectCarrier;
  /** 正文所在的载体 glob（相对项目根）——提示里原样给作者 */
  readonly glob: string;
  readonly prefixes: readonly string[];
}

/** 一次解析的产物：显示名 + 类别 + 命中的列区间（1 基，供 hover 高亮）+ 附加行 */
export interface HoverHit {
  readonly name: string;
  readonly kind: string;
  readonly startColumn: number;
  readonly endColumn: number;
  /**
    /**
     * 附加正文行（additive 可选）——命中带可读正文时逐行给出：ERB 函数的 docComment / 形参签名 /
     * 定义位置，或中文反查出的**拼出来的函数名 / 模板 / 含义 / 原文对照**。每行渲染为独立的
     * markdown 块。缺省 = 只显示名字行（正向各路的行为与改前逐字一致）。
     */
    readonly lines?: readonly string[];
  /**
   * 声明 / 定义的**源坐标**（additive 可选）——派生预览面（`.kojo` 糖面）上，`startColumn` /
   * `endColumn` 属于**显示面**（预览那一行），而这条事实永远指回源文件：文件路径 + 源行号。
   * 缺省 = 本行内没有可跳的落点（变量反查 / 中文反查那几路只换名字、不指位置）。
   */
  readonly source?: { readonly filePath: string; readonly line: number };
}

/**
 * 悬停所在的**显示面**事实（additive 可选；缺省 = 源面、行号 1、不读原文）。
 *
 * 存在的理由只有一条：`.kojo` 糖面（升糖预览）是一份**派生文本**，它的行号不是源行号。
 * 于是「最近声明」不能用它来比行距，声明原文也不能在预览 model 的同一行号上读——那会读到
 * 另一个名字。源面（盘上的 `.erb` / `.kojo`）与派生面在这里分开，判据只写一遍。
 */
export interface HoverSurface {
  /** 光标所在行（1 基，**显示面**坐标）；缺省 1 */
  readonly line?: number;
  /** true = 显示面是派生预览（`.kojo` 糖面），`line` 不参与「最近声明」判定 */
  readonly derived?: boolean;
  /**
   * 读**源文件**某一行（1 基）。源面 = 当前 model；派生面由宿主翻到原文 model 后交进来。
   * 缺席 = 读不到声明原文（不显示声明原文与初值，**不猜**）。
   */
  readonly readSourceLine?: (line: number) => string | undefined;
}

/**
 * 取词的两把尺子（DRIFT-APP 2，2026-10-19：**字符集一个字都不在本文件写**）。
 *
 * 两把尺子服务两条不同的取词路，各取其契约层的单一真源，不是"一把用错"：
 * - **变量引用路** `族名:段`（`isRefChar` + `REF_RE`，本文件唯一保留的字面字符集，
 *   判的是"带冒号的引用形状"而不是标识符）；
 * - **反查表路**（系统函数 / 基础库 / 指令编号：查的都是**原生 ASCII 记号**）⇒ 用契约
 *   `symbolTokenAt`（`plugin-api/symbol-token`，那张表刻意只认 ASCII——反查表的键就是 ASCII
 *   原生名，本文件的注释不许把它写成 Unicode）；同一点位两条路都答得出时的**优先序**
 *   不在尺子上，在 `echoYieldsToIndex` 那一枚裁决函数里（恒等回显让位给函数索引）；
 * - **函数索引路 / `#DIM` 声明路**（查的是作者自己起的名字，语料里约两成函数名含 CJK）
 *   ⇒ 用契约 `unicodeTokenAt`（`MODEL_TOKEN_CLASS` 那一把，与 F2 改名 / 引用面板同源；
 *   F12-TOKEN 2026-10-19 起转到定义与查找引用也走这一把，悬停与 F12 从此对称）。
 *
 * 改前函数索引路错用了反查表那把 ASCII 尺，症状 = 中文函数名在 `.erb` 里悬停什么都不出。
 */
const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** 变量引用：`族名` + 至少一段 `:段`（段可含角色号 / 索引 / 作用域名） */
const REF_RE = /^([A-Za-z][A-Za-z0-9_]*):(.+)$/;
/** 指令编号的**上下文**：糖的 `时机 <分野> <编号>：` 块头，编号前是 `时机 <分野> `（空白类走单源，含全角空格） */
const TIMING_PREFIX_RE = new RegExp(`^\\s*时机[${BLANK_CLASS_STR}]+\\S+[${BLANK_CLASS_STR}]+$`);

/** 命中光标（含其左右邻接同类字符）的最长一段（`col0` = 0 基字符下标；无同类字符返回 null） */
export function spanAround(line: string, col0: number, isChar: (ch: string) => boolean): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (col0 < line.length && isChar(line[col0]!)) {
    start = col0;
    end = col0 + 1;
  } else if (col0 > 0 && isChar(line[col0 - 1]!)) {
    start = col0 - 1;
    end = col0;
  } else {
    return null;
  }
  while (start > 0 && isChar(line[start - 1]!)) start--;
  while (end < line.length && isChar(line[end]!)) end++;
  return { start, end };
}

/**
 * 解析光标下的中文名（**纯函数**）。`lineText` = 该行文本，`column` = Monaco 的 1 基列。
 * `header`（ZH-D3，additive）= 文件头的 `角色:` / `口上:` 事实，反向路用它拼原生函数名；
 * 缺省 = 只给模板、不拼半个名字。
 * 返回 `undefined` = 该处没有可显示的名字（**不猜**：查不到一律不显示）。
 */
export function resolveHoverName(
  lineText: string,
  column: number,
  tables: HoverTables,
  header: KojoDocHeader = {},
  filePath: string | null = null,
  surface: HoverSurface = {},
): HoverHit | undefined {
  const hit = resolveHoverNameCore(lineText, column, tables, header, filePath, surface);
  // LAU-D3 最后一路：载体注册壳前缀（方言声明）⇒ 「这条事件在 xml」。
  // 只在其它各路**都没答案**或**答在同一段记号上**时接管：它不抢已有事实，
  // 只给壳函数补一句"正文不在这里"（DoD 第 4 条）。
  return withCarrierShellHint(hit, lineText, column, tables.carrierShells);
}

/**
 * 载体注册壳提示（LAU-D3；纯函数）。
 *
 * 判据 = 方言在 `carriers[].shells` 里声明的**前缀 + 紧跟数字**（大小写不敏感）：
 * 与 `CarrierBinding.shells` 的注逐字同口径（`KOJO_DEFINE_K1099` 命中 `KOJO_DEFINE_K`，
 * `KOJO_DEFINE_KOJO_INFO_K1099` 只命中长前缀那一条）。命中返回屏上区间与提示行；
 * 没声明 / 没命中 ⇒ `undefined`（不猜）。
 */
export function carrierShellHintOf(
  lineText: string,
  column: number,
  shells: readonly CarrierShellHint[] | undefined,
): { startColumn: number; endColumn: number; lines: string[] } | undefined {
  if (shells === undefined || shells.length === 0) return undefined;
  const span = unicodeTokenAt(lineText, column);
  if (!span) return undefined;
  const upper = span.text.toUpperCase();
  for (const shell of shells) {
    for (const prefix of shell.prefixes) {
      if (typeof prefix !== 'string' || prefix.length === 0) continue;
      const head = prefix.toUpperCase();
      if (!upper.startsWith(head)) continue;
      const next = upper.charAt(head.length);
      if (!(next >= '0' && next <= '9')) continue; // `_K{编号}` 锚点：前缀后必须紧跟数字
      return {
        startColumn: span.startColumn,
        endColumn: span.endColumn,
        lines: [
          `这条事件在 ${shell.carrier}：正文在 \`${shell.glob}\`（这里只是注册壳，不是"没实现的口上"）。`,
        ],
      };
    }
  }
  return undefined;
}

/** 把壳提示并进悬停结果（纯函数；没有提示 / 命中落在别的记号上 ⇒ 原样返回） */
function withCarrierShellHint(
  hit: HoverHit | undefined,
  lineText: string,
  column: number,
  shells: readonly CarrierShellHint[] | undefined,
): HoverHit | undefined {
  const hint = carrierShellHintOf(lineText, column, shells);
  if (hint === undefined) return hit;
  if (hit === undefined) {
    return {
      name: unicodeTokenAt(lineText, column)?.text ?? '注册壳',
      kind: '口上注册壳',
      startColumn: hint.startColumn,
      endColumn: hint.endColumn,
      lines: hint.lines,
    };
  }
  // 已有命中但落在别的记号（列区间不相交）⇒ 壳提示不接管，免得张冠李戴。
  if (hit.endColumn <= hint.startColumn || hit.startColumn >= hint.endColumn) return hit;
  return { ...hit, lines: [...(hit.lines ?? []), ...hint.lines] };
}

/**
 * 悬停第 1–6 路的本体（原 `resolveHoverName`；LAU-D3 只在其外**追加**一路壳提示，
 * 六路的判定与优先序一个字未动）。
 */
function resolveHoverNameCore(
  lineText: string,
  column: number,
  tables: HoverTables,
  header: KojoDocHeader,
  filePath: string | null,
  surface: HoverSurface,
): HoverHit | undefined {
  if (!Number.isFinite(column) || column < 1) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  // 1) 数值变量索引：`CFLAG:TARGET:1088` → nameAt(族, 末段)。具名索引 `description == 索引`
  //    时等于回显（名字本就是中文），无增益 → 跳过。
  const refSpan = spanAround(lineText, col0, isRefChar);
  if (refSpan) {
    const token = lineText.slice(refSpan.start, refSpan.end);
    const m = REF_RE.exec(token);
    if (m) {
      const family = m[1]!;
      const segs = m[2]!.split(':');
      const index = segs[segs.length - 1]!;
      const name = tables.dictionary?.nameAt?.(family, index);
      if (name !== undefined && name.length > 0 && name !== index) {
        return {
          name,
          kind: `变量 · ${token}`,
          startColumn: refSpan.start + 1,
          endColumn: refSpan.end + 1,
        };
      }
    }
  }

  // 2) 原生函数名（ASCII 记号）：`GETBIT` → 获取标记（系统表反向优先，再查 adapter 基础库表反查）。
  //    尺子 = 契约 `symbolTokenAt` 的缺省记号集（**原生名字查表**那一路的尺，本文件不再自己
  //    写字符集）。中文词在这一路**必然**判不出记号——那是有意口径（反查表的键就是 ASCII
  //    原生名），中文名字另有第 5 路与第 6 路。
  //    `!echoYieldsToIndex` 是本路与第 5 路的**优先序裁决**（一条判据一枚函数，见该函数）：
  //    库里只有回显、而项目函数索引认这个名字时，本路让位——让位给带 docComment / 定义位的那条。
  const fnToken = symbolTokenAt(lineText, col0 + 1);
  if (fnToken) {
    const cn = SYSTEM_FUNCTION_REVERSE.get(fnToken.text) ?? tables.libraryTable?.lookupByFunction?.(fnToken.text);
    if (cn !== undefined && cn.length > 0 && !echoYieldsToIndex(cn, fnToken.text, tables)) {
      return { name: cn, kind: `函数 · ${fnToken.text}`, startColumn: fnToken.startColumn, endColumn: fnToken.endColumn };
    }
  }

  // 3) 指令编号：只在糖的 `时机 <分野> <编号>：` 块头里认（上下文可证明，别处一个数不敢认）。
  const digitSpan = spanAround(lineText, col0, isDigit);
  if (digitSpan && tables.instructionTable) {
    const token = lineText.slice(digitSpan.start, digitSpan.end);
    if (TIMING_PREFIX_RE.test(lineText.slice(0, digitSpan.start))) {
      const cn = tables.instructionTable.lookupByNo(Number(token));
      if (cn !== undefined && cn.length > 0) {
        return {
          name: cn,
          kind: `指令 · 编号 ${token}`,
          startColumn: digitSpan.start + 1,
          endColumn: digitSpan.end + 1,
        };
      }
    }
  }

  // 4) 位号（D7）：`GETBIT/SETBIT/CLEARBIT/INVERTBIT` 第二实参的位号 → 中文位名。
  //    只在可证明的位槽里认；非位槽 / 查不到位表一律不显示（不猜）。
  const bit = erbBitHoverName(lineText, column, tables.variableSchema);
  if (bit !== undefined) {
    return { name: bit.name, kind: `位号 · ${bit.bit}`, startColumn: bit.startColumn, endColumn: bit.endColumn };
  }

  // 5) ERB 函数定义（宿主注入 `erbIndex` 通道）：光标词 ∈ `ErbIndex.byName`（归一化大写名）
  //    ⇒ docComment（多行正文）+ 形参签名 + 定义位置。定义行与调用点同词同命中——查表只认词，
  //    不认语法位。通道缺席 / 索引未建 / 词不在索引 ⇒ 本路不产结果（不猜）。
  //    取词尺 = 契约 `unicodeTokenAt`（DRIFT-APP 2：作者自定的函数名大量是中文，ASCII 尺
  //    量不出记号 ⇒ 整路查不到；F2 改名与引用面板早就是这把 Unicode 尺，两路现在同源）。
  const erbFn = resolveErbFunctionHover(lineText, column, tables.erbIndex);
  if (erbFn !== undefined) return erbFn;

  // 5.5) 本文件 `#DIM` 声明（EC-DECL 的悬停半边，2026-10-19）：`#DIM 好感度` 声明过之后，
  //      正文里写这个名字时显示「声明处 + 声明原文 + 初值（可判时）」；同文件重名取最近的
  //      声明（当前函数内优先），函数形参遮蔽同名变量时报形参。数据源 = 同一份
  //      `ErbIndex.files`（不扫全文、不写第二份正则）；文件不在索引 / 声明表缺席 ⇒ 不显示（不猜）。
  const erbDim = resolveErbDimHover(lineText, col0, tables.erbIndex, filePath, surface);
  if (erbDim !== undefined) return erbDim;

  // 6) 中文 → **原生形态**反查（ZH-D3；`kojo-hover-native.ts`）：族头中文别名、中文函数名 /
  //    语句形调用、时机块头的分野与中文指令名。前五路只认 ASCII 记号与位槽，本路只认中文，
  //    两条路天然不撞；同样「查不到即不显示」（不猜）。
  // 6.5) 原生标记分类（v1.9 P2）：`[IF …]` / `#DIM` / `{` `}` / 行首大写 ERB 语句。
  //    前六路的事实优先；这里只补"这是什么"，不给逐词文档（见 `kojo-hover-marks.ts`）。
  const mark = resolveErbMarkHover(lineText, column);
  if (mark !== undefined) return mark;

  return resolveNativeHover(lineText, column, tables, header);
}

/**
 * 函数索引通道的**唯一**取法：通道缺席 / 索引未建 / 求值抛错 ⇒ `null`
 * （不猜、fail-open；本文件其余地方一律不碰 `getIndex` 本身）。
 */
function erbIndexOf(
  getIndex: (() => ErbIndex | null | undefined) | undefined,
): ErbIndex | null {
  if (typeof getIndex !== 'function') return null;
  try {
    return getIndex() ?? null;
  } catch {
    return null;
  }
}

/**
 * 「项目函数索引认不认这个名字」的**唯一**查询（第 2 路的裁决与第 5 路的取正文共用它，
 * 两条腿各写一遍 `byName.get` 就是第二判据）。名录里没有 ⇒ `undefined` = **不认领**。
 */
function erbDefsOf(index: ErbIndex, upper: string): ErbFunctionRef[] | undefined {
  const defs = index.byName.defsOf(upper);
  return defs.length === 0 ? undefined : defs;
}

/**
 * 两条**名字查表路**在同一位置的优先序（F12-TOKEN 2026-10-19；一条判据一枚函数，
 * 第 2 路与第 5 路不许各写自己的 `if`）。
 *
 * 判据一条：库表那条**只是回显**（`中文名 === 原生名`）时让位给函数索引——回显给不出
 * docComment、形参签名与定义位置，索引那条结果是它的严格超集；库表给的是**真翻译**
 * （两个名字不同）时库表先答，因为那个中文名是函数索引里根本不存在的信息。
 *
 * 为什么这条判据必须由数据形状决定、而不是由取词尺决定（实测语料，`eratw-adapter` 库表
 * 471 条）：原生名含 CJK 的正好 **13** 条，且 **13/13 都是恒等条目**（`充填率` → `充填率`），
 * 且 13 条**全部**在项目函数索引里有 `@` 定义（它们本就是基础库函数）；而原生名为 ASCII
 * 且同时在库表与索引里的 458 条**全部**带真翻译（`CURRENT_CLOTHES_SET` → 当前衣装套）。
 * ⇒ 把两路的尺子合成一把 Unicode 尺，抢掉正文的正好是那 13 条回显；而一句"索引优先"
 * 会打沉另外 458 条真翻译（占库表 97.2%）。恒等/翻译这一条判据把两半精确切开。
 */
function echoYieldsToIndex(cn: string, token: string, tables: HoverTables): boolean {
  if (cn !== token) return false;
  const index = erbIndexOf(tables.erbIndex);
  return index !== null && erbDefsOf(index, token.toUpperCase()) !== undefined;
}

/**
 * ERB 函数路（**纯函数**）：光标词在 `ErbIndex.byName` 里 ⇒ 产出带正文的命中。
 *
 * - 取词尺 = 契约 `unicodeTokenAt`（字母 / 数字 / 下划线的 Unicode 记号，与 F2 改名、
 *   引用面板、结构化着色同一把）——函数索引里存的就是作者自己起的名字，**含中文的
 *   函数名是常态不是例外**，用 ASCII 尺量出的记号在 `byName` 里根本查不到（DRIFT-APP 2）；
 *   F12-TOKEN 2026-10-19 起转到定义 / 查找引用两条腿也用这一把（`erb-parser/references.ts`
 *   的 `functionNameTokenAt` = 本尺 + 成员冒号退让），悬停与 F12 从此对称；
 * - 名词查表用**归一化大写**（Emuera 函数名大小写不敏感，与 `byName` 键同口径），
 *   认领判据走 `erbDefsOf`（与第 2 路的裁决同一枚函数）；
 * - 正文 = docComment（有则按行拆开）+ 形参签名（参数取自同一索引的 `files` 全量定义，
 *   文件不在索引 ⇒ 只省签名这一行，不猜）+ 定义位置（`文件路径:行号`）；
 * - 同名多处定义：显示首条的正文与位置，并追加一行注明剩余处数（重名事实不藏）。
 */
function resolveErbFunctionHover(
  lineText: string,
  column: number,
  getIndex: (() => ErbIndex | null | undefined) | undefined,
): HoverHit | undefined {
  const index = erbIndexOf(getIndex);
  if (index === null) return undefined;
  const span = unicodeTokenAt(lineText, column);
  if (!span) return undefined;
  const defs = erbDefsOf(index, span.text.toUpperCase());
  if (defs === undefined) return undefined;

  const def = defs[0]!;
  const lines: string[] = [];
  if (def.docComment !== undefined && def.docComment.length > 0) {
    lines.push(...def.docComment.split('\n').filter((l) => l.trim().length > 0));
  }
  const file = index.files.get(def.filePath);
  const fn = file?.functions.find((f) => f.normalizedName === def.normalizedName && f.startLine === def.startLine);
  if (fn && fn.params.length > 0) {
    lines.push(`\`${def.name}(${fn.params.map((p) => p.name).join(', ')})\``);
  }
  lines.push(`定义于 \`${def.filePath}:${def.startLine}\``);
  if (defs.length > 1) lines.push(`另有 ${defs.length - 1} 处同名定义`);

  return {
    name: def.name,
    kind: 'ERB 函数',
    startColumn: span.startColumn,
    endColumn: span.endColumn,
    lines,
    // 定义落点永远是**源坐标**：派生预览面上 `span` 是预览列，这一条指回真文件
    source: { filePath: def.filePath, line: def.startLine },
  };
}

/**
 * `#DIM` 声明名悬停（2026-10-19，EC-DECL 的显示半边；2026-10-20 补值 / 最近声明 / 派生面）。
 *
 * 与函数路共用同一份 `ErbIndex.files`（**不扫全文、不写第二份 `#DIM` 正则**）：先按
 * 路径归一（分隔符 / 大小写）找到当前文件，再在 `dims` 里按大小写不敏感整词匹配
 * （索引里的名字可能带数组后缀 `配列[10]`，匹配与显示都按裸名）。
 * 文件不在索引 / 索引缺席 / 词不是声明名 ⇒ `undefined`（不猜）。
 *
 * **声明处 + 值/类型**（`HoverSurface.readSourceLine`）：声明的值只能从**源文件那一行**读
 * （`#DIM 好感度 = 100`）；读不到 / 那一行不是同名声明 ⇒ 只给落点。派生预览面由宿主
 * 把读行腿接到**原文 model**，绝不拿预览同号行凑值（见 `HoverSurface`）。
 *
 * **最近声明**：同文件多处同名声明时，当前函数内的那条优先，其次函数外的文件级声明，
 * 最后才按行距退让；函数形参遮蔽同名变量时直接报形参（源面才可判——派生面的行号不是源行号）。
 *
 * 名字字符集比函数路那把 Unicode 尺还宽：`#DIM 好感度[10]` 这类声明名允许带冒号 /
 * 括号 / 空白以外的任意字符，故 span 用"非空白 + 非运算符"判据（`isDimNameChar`），
 * 不复用函数路的记号集——两把尺各自服务一条取词路，合成一把就一定有一侧判错。
 */
function resolveErbDimHover(
  lineText: string,
  col0: number,
  getIndex: (() => ErbIndex | null | undefined) | undefined,
  filePath: string | null,
  surface: HoverSurface = {},
): HoverHit | undefined {
  if (!filePath) return undefined;
  // 索引通道的取法与函数路同一枚函数（缺席 / 未建 / 抛错 ⇒ 不产结果，不各写一遍）
  const index = erbIndexOf(getIndex);
  if (index === null) return undefined;
  const span = spanAround(lineText, col0, isDimNameChar);
  if (!span) return undefined;
  const token = lineText.slice(span.start, span.end);
  if (token.length === 0) return undefined;
  const key = normalizePathKey(filePath);
  let file: IndexedErbFile | undefined;
  for (const [p, f] of index.files) {
    if (normalizePathKey(p) === key) {
      file = f as IndexedErbFile;
      break;
    }
  }
  if (!file) return undefined;
  const want = token.toUpperCase();
  // 派生面的行号是**显示面**坐标，不是源行号 ⇒ 不参与作用域与「最近」判定
  const useLine = surface.derived === true ? null : sourceLineOf(surface.line);

  // 函数形参遮蔽同名变量（只在源面可判）：最近的声明就是包围当前行的函数形参
  if (useLine !== null) {
    const fn = enclosingFunctionOf(file.functions ?? [], useLine);
    const param = fn?.params.find((p) => p.name.toUpperCase() === want);
    if (fn !== undefined && param !== undefined) {
      return {
        name: param.name,
        kind: '函数形参',
        startColumn: span.start + 1,
        endColumn: span.end + 1,
        lines: [`所在函数：\`@${fn.name}\``, `形参声明于 \`${file.path}:${fn.startLine}\``],
        source: { filePath: file.path, line: fn.startLine },
      };
    }
  }

  const dims = (file.dims ?? []).filter((d) => bareDimNameOf(d.name).toUpperCase() === want);
  if (dims.length === 0) return undefined;
  const dim = nearestDimOf(dims, file.functions ?? [], useLine);
  const dimName = bareDimNameOf(dim.name);
  const lines: string[] = [`声明于 \`${file.path}:${dim.line}\``];
  // 值 / 类型「若可判」：只在**源文件**那一行读（派生面由宿主交原文 model 的读行腿），
  // 读不到 / 那一行不是同名声明 ⇒ 只给落点，绝不拿预览同号行凑一个值。
  const raw = declarationTextOf(readSourceRow(surface.readSourceLine, dim.line), dimName);
  if (raw !== undefined) {
    lines.push(`声明：\`${raw}\``);
    const init = initializerOfDimLine(raw, dimName);
    if (init !== undefined) lines.push(`初值：\`${init}\``);
  }
  if (dims.length > 1) {
    const others = dims
      .filter((d) => d !== dim)
      .map((d) => d.line)
      .sort((a, b) => a - b);
    lines.push(`另有 ${others.length} 处同名声明（第 ${others.join('、')} 行）`);
  }
  return {
    name: dimName,
    kind: `#${dim.directive} 声明`,
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    lines,
    source: { filePath: file.path, line: dim.line },
  };
}

/**
 * 索引里的声明名可能带数组后缀（scanner 的 `parseDimDeclaration` 原样存 `配列[10]`）；
 * 悬停按**裸名**匹配与显示——`[10]` 是规模，不是名字的一部分。
 */
function bareDimNameOf(name: string): string {
  return name.replace(/\[[^\]]*\]$/, '');
}

/** 索引里的一份文件（`ErbIndex.files` 的值；只取悬停用得到的字段） */
type IndexedErbFile = {
  readonly path: string;
  readonly dims?: readonly ErbDim[];
  readonly functions?: readonly ErbFunction[];
};

/** 源行号（1 基、有限、≥1）；派生面 / 缺省 / 坏值 ⇒ `null`（不猜） */
function sourceLineOf(line: number | undefined): number | null {
  return typeof line === 'number' && Number.isFinite(line) && line >= 1 ? Math.trunc(line) : null;
}

/** 光标行落在哪个函数里（多个命中取最内层 = 起点最大的那个）；不在任何函数里 ⇒ `undefined` */
function enclosingFunctionOf(functions: readonly ErbFunction[], line: number): ErbFunction | undefined {
  let best: ErbFunction | undefined;
  for (const fn of functions) {
    if (line < fn.startLine || line > fn.endLine) continue;
    if (best === undefined || fn.startLine > best.startLine) best = fn;
  }
  return best;
}

/**
 * 同名声明的**最近一条**：先看当前函数内部，再看函数外的文件级声明，最后才退到全文件行距。
 *
 * `useLine = null`（派生面 / 调用方没给行号）⇒ 索引首条——派生面的行号不是源行号，
 * 拿它量「最近」只会得到一个看起来很近的错答案；「另有 N 处」那行会把重名事实说清。
 */
function nearestDimOf(
  dims: readonly ErbDim[],
  functions: readonly ErbFunction[],
  useLine: number | null,
): ErbDim {
  if (dims.length === 1 || useLine === null) return dims[0]!;
  const scope = enclosingFunctionOf(functions, useLine);
  if (scope !== undefined) {
    const inside = dims.filter((d) => d.line >= scope.startLine && d.line <= scope.endLine);
    if (inside.length > 0) return nearestByLine(inside, useLine);
    const outside = dims.filter((d) => enclosingFunctionOf(functions, d.line) === undefined);
    if (outside.length > 0) return nearestByLine(outside, useLine);
  }
  return nearestByLine(dims, useLine);
}

/** 行距最近（同距时取**声明在前**的那条；之前没有才取之后最早的一条） */
function nearestByLine(dims: readonly ErbDim[], useLine: number): ErbDim {
  let best = dims[0]!;
  for (const d of dims) {
    const beforeD = d.line <= useLine;
    const beforeBest = best.line <= useLine;
    if (beforeD !== beforeBest) {
      if (beforeD) best = d;
      continue;
    }
    if (beforeD ? d.line > best.line : d.line < best.line) best = d;
  }
  return best;
}

/** 读源文件某一行（读腿抛错 / 非字符串一律当读不到） */
function readSourceRow(
  read: ((line: number) => string | undefined) | undefined,
  line: number,
): string | undefined {
  if (read === undefined) return undefined;
  try {
    const text = read(line);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 声明行原文（**校验它确实声明了同名变量**）：索引可能来自上一次落盘的快照，
 * 行号对不上 / 不是 `#DIM*` 行 / 名字不同 ⇒ `undefined`（不拿别的声明冒充）。
 * 超长行截断（悬停块不是正文阅读器）。
 */
function declarationTextOf(line: string | undefined, name: string): string | undefined {
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: { directive: string; name: string } | null;
  try {
    parsed = parseDimDeclaration(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null) return undefined;
  const bare = parsed.name.replace(/\[[^\]]*\]$/, '');
  if (bare.toUpperCase() !== name.toUpperCase()) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

/**
 * 声明行里 `=` 之后的初值（去掉引号外的 `;` 注释尾巴）；数组规模（`[10]` / `, 10`）不算初值。
 * 读不出 / 为空 ⇒ `undefined`（不写「初值：空」这种假事实）。
 */
function initializerOfDimLine(line: string, name: string): string | undefined {
  const head = /^#[A-Za-z]+/.exec(line);
  const from = head === null ? 0 : head[0].length;
  // 索引里的名字大小写可能与这一行不同（Emuera 名字大小写不敏感）⇒ 按小写找起点
  const at = line.toLowerCase().indexOf(name.toLowerCase(), from);
  if (at < 0) return undefined;
  let rest = line.slice(at + name.length);
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return undefined;
    rest = rest.slice(close + 1);
  }
  const eq = rest.indexOf('=');
  if (eq < 0) return undefined;
  const value = stripUnquotedComment(rest.slice(eq + 1)).trim();
  return value.length === 0 ? undefined : value;
}

/** 去掉第一个**引号外**的 `;` 及其后内容（ERB 注释；字符串里的 `;` 不算） */
function stripUnquotedComment(text: string): string {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inStr = !inStr;
    else if (ch === ';' && !inStr) return text.slice(0, i);
  }
  return text;
}

/**
 * 路径比较键 / `#DIM` 名字字符：判据**单源**在 `@kojo/plugin-erb-parser`（`symbols.ts`）
 * （导航、补全、改名、引用四条腿共用同一份；这里只 re-export，不许长出第二个字符集）。
 *
 * - `normalizePathKey`：Windows 分隔符 + 大小写不敏感（索引键与 model.uri 来自不同腿）；
 * - `isDimNameChar`：非空白、非运算符/分隔符（中文与全角字母都是合法声明名）。
 */
export { isDimNameChar, normalizePathKey };

/** 读 model 某一行（1 基；抛错 / 非字符串 ⇒ 读不到） */
function safeModelLine(model: Monaco.editor.ITextModel, line: number): string | undefined {
  try {
    const text = model.getLineContent(line);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 桩 model 可能压根没有 uri；`fsPath` 与 `path` 来自不同腿（Windows 盘符 / URI 编码），各认一次 */
function modelUriPath(model: Monaco.editor.ITextModel): string | null {
  const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return null;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  return null;
}

/**
 * 这份**派生预览** model 属于哪个实例、原文 model 是哪一份（登记簿的官方反查）。
 *
 * 这是 `.kojo` 糖面唯一需要而 Monaco 给不出的事实：投影 URI（`inmemory://sugar/…`）上没有文件，
 * 索引里也没有它。归属知识只问登记簿，本模块不猜。多实例同开一份文件时，`sugarModelRef`
 * 是全表比对里唯一不会认错的键（每个实例只持有自己那份投影）。
 */
function sugarSurfaceOf(
  model: Monaco.editor.ITextModel,
): { readonly path: string | null; readonly source?: Monaco.editor.ITextModel } | null {
  for (const pane of livePanes.values()) {
    if (pane.sugarModelRef.current !== model) continue;
    const path = pane.filePathRef.current.length > 0 ? pane.filePathRef.current : null;
    let source = path === null ? undefined : pane.entriesRef.current.get(path)?.model;
    if (source === undefined && path !== null) {
      // 打开表的键与 `filePathRef` 可能来自不同腿（分隔符 / 大小写）——同一条归一
      const key = normalizePathKey(path);
      for (const [opened, entry] of pane.entriesRef.current) {
        if (normalizePathKey(opened) === key) {
          source = entry.model;
          break;
        }
      }
    }
    return { path, ...(source !== undefined ? { source } : {}) };
  }
  return null;
}

/**
 * `inmemory://sugar/<组>/<编码后的源路径>` → 源路径（登记簿认不出时的退路）。
 * 只解**路径**，不碰行列：投影与原文的行列换算不归悬停管（那会折两遍）。
 */
function sugarPreviewPathFromUri(model: Monaco.editor.ITextModel): string | null {
  const uri = (model as { uri?: { scheme?: unknown; authority?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return null;
  if (uri.scheme !== 'inmemory' || uri.authority !== 'sugar' || typeof uri.path !== 'string') return null;
  const segs = uri.path.split('/').filter((s) => s.length > 0);
  const last = segs[segs.length - 1];
  if (last === undefined) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

/**
 * 屏幕上这份 model 是**源面**还是**派生预览面**，以及「读原文某一行」的读腿。
 *
 * 判据只有两条：
 * - 登记簿说它是某实例的糖投影 ⇒ 派生面；文件身份 = 该实例正在编的源路径，读行腿 = 原文 model；
 * - 否则看 URI scheme：`file:` / 无 scheme = 源面（读行腿 = 当前 model）；其它 scheme = 派生面
 *   （糖 URI 能解出源路径就用，解不出就只给「没有文件身份」——`#DIM` 那路自然闭嘴，不猜）。
 *
 * **派生面绝不把 `readSourceLine` 指向预览 model**：预览第 N 行与源第 N 行是两个名字，
 * 那正是「坐标跨面」的事故形态。
 */
function hoverSurfaceOf(model: Monaco.editor.ITextModel): {
  readonly filePath: string | null;
  readonly derived: boolean;
  readonly readSourceLine?: (line: number) => string | undefined;
} {
  const sugar = sugarSurfaceOf(model);
  if (sugar !== null) {
    const source = sugar.source;
    return {
      filePath: sugar.path,
      derived: true,
      ...(source !== undefined ? { readSourceLine: (n: number) => safeModelLine(source, n) } : {}),
    };
  }
  const uri = (model as { uri?: { scheme?: unknown } }).uri;
  const scheme = uri !== null && typeof uri === 'object' ? uri.scheme : undefined;
  const derived = typeof scheme === 'string' && scheme.length > 0 && scheme !== 'file';
  if (derived) {
    return { filePath: sugarPreviewPathFromUri(model) ?? modelUriPath(model), derived: true };
  }
  return {
    filePath: modelUriPath(model),
    derived: false,
    readSourceLine: (n: number) => safeModelLine(model, n),
  };
}

/**
 * 「本文件是哪一份文件」的注入位（悬停第 5.5 路唯一需要而 Monaco 给不出的事实）。
 *
 * 回 `null` = 宿主不改判据，本模块沿用 `model.uri`。存在理由不是"顺手留个钩子"：
 * 派生面（只读内存 model）的 URI 在 `ErbIndex.files` 里**必然**查不到——那条 URI 上没有文件，
 * 索引里也没有它 ⇒ `#DIM` 悬停在派生面上整路静默。而"这份 model 背后是哪个文件"是
 * **归属**知识（登记簿里那一次反查），本模块一行都不该认识，故由宿主换算后交进来。
 */
export type HoverPathSource = (model: Monaco.editor.ITextModel) => string | null;

/**
 * 注入腿的原始结果（null / 空串 / 抛错 = 没注入）。
 *
 * **不拿 `model.uri` 兜底**：兜底由 `hoverSurfaceOf` 的显示面事实负责（源面 = model.uri，
 * 派生面 = 糖 URI 反解 + 登记簿原文 model）。注入腿抛错不能没收整条悬停。
 */
function injectedHoverPathOf(model: Monaco.editor.ITextModel, sourcePathOf?: HoverPathSource): string | null {
  if (!sourcePathOf) return null;
  try {
    const injected = sourcePathOf(model);
    return injected !== null && injected.length > 0 ? injected : null;
  } catch {
    return null;
  }
}

/**
 * 为 ERB 方言（`.erb` / `.erh` / `.erd`）与 `.kojo` 两种语言注册**只读** hover provider。
 *
 * `getTables` 每次悬停时才调用（表按当前项目 adapterId 实时取，同 `refreshMarkers` 纪律）。
 * 文件头事实（`角色:` / `口上:`）同样**当场从模型读**（只读 `getLineContent` /
 * `getLineCount`，不缓存、不改文档），反向路据此拼出原生函数名。
 * 返回可释放句柄——宿主在编辑器卸载时调用 `dispose()`。
 *
 * `sourcePathOf`（additive 第三参）= **本文件身份**的注入位，详见 {@link HoverPathSource}。
 *
 * 坐标口径：`range` 永远落在**屏幕上那一行**（派生预览面就是预览行列）；声明 / 定义的
 * 落点与原文永远走**源坐标**（`HoverSurface`），两面之间没有行列换算。
 */
export function installHover(
  monaco: typeof Monaco,
  getTables: () => HoverTables,
  sourcePathOf?: HoverPathSource,
): Monaco.IDisposable {
  const provider: Monaco.languages.HoverProvider = {
    provideHover(model, position) {
      const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : position.lineNumber;
      const header = docHeaderOf((n) => model.getLineContent(n), lineCount);
      const surface = hoverSurfaceOf(model);
      // 注入腿（宿主登记簿）优先；缺席时沿用显示面事实（源面 = model.uri，派生面 = 糖 URI 反解）
      const hit = resolveHoverName(
        model.getLineContent(position.lineNumber),
        position.column,
        getTables(),
        header,
        injectedHoverPathOf(model, sourcePathOf) ?? surface.filePath,
        {
          line: position.lineNumber,
          derived: surface.derived,
          ...(surface.readSourceLine !== undefined ? { readSourceLine: surface.readSourceLine } : {}),
        },
      );
      if (!hit) return undefined;
      const contents = [{ value: `**${hit.name}**（${hit.kind}）` }];
      for (const line of hit.lines ?? []) contents.push({ value: line });
      return {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: hit.startColumn,
          endColumn: hit.endColumn,
        },
        contents,
      };
    },
  };
  return registerForLanguageServices(monaco, (m, id) => m.languages.registerHoverProvider(id, provider));
}
