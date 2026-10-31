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
import {
  isErbDimNameChar as isDimNameChar,
  normalizePathKey,
  resolveErbHoverAt,
  type ErbHoverHit,
  type ErbHoverSurface,
} from '@kojo/plugin-erb-parser';
import type { DictionaryLookup } from '@kojo/kojo-vocab/types';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/kojo-vocab/system-functions';
import { type KojoDocHeader, docHeaderOf, resolveNativeHover } from '@kojo/kojo-vocab/native-hover';
import { buildFunctionName } from '@kojo/plugin-kojo-sugar';
import { livePanes } from '../ui/editor-pane-registry';
import { classifyKojoLine } from './kojo-native-zone';
import { BLANK_CLASS_STR } from './kojo-completion-position';
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
 * **ZH-D3 反向面**（中文 → 原生形态）在同一入口末尾接上 `@kojo/kojo-vocab/native-hover`：
 * 上面四条正向路都只认 ASCII 记号，作者在 `.kojo` 里写的中文词（族头 / 中文函数名 /
 * 时机分野与指令名）此前查不到原生形态。反查**不新建任何映射**，只复用降糖与拼名链上
 * 已在用的那几张表（详见 `kojo-vocab/src/native-hover.ts` 头注）；正向命中优先，正向无果才走反向。
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

/**
 * 一次解析的产物：显示名 + 类别 + 命中的列区间（1 基，供 hover 高亮）+ 附加行。
 *
 * 形状的真源在 `@kojo/plugin-erb-parser`（判据搬进插件后，宿主只做别名——不再长出第二份）。
 */
export type HoverHit = ErbHoverHit;

/**
 * 悬停所在的**显示面**事实（additive 可选；缺省 = 源面、行号 1、不读原文）。
 *
 * 存在的理由只有一条：`.kojo` 糖面（升糖预览）是一份**派生文本**，它的行号不是源行号
 * ——「最近声明」不能用它比行距，声明原文也不能在预览 model 的同一行号上读。形状与判据
 * 都住在 `@kojo/plugin-erb-parser`（`ErbHoverSurface`），宿主只是别名的消费方。
 */
export type HoverSurface = ErbHoverSurface;

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
 * 悬停第 1–6 路的**本体**（ERB-PARITY G1，2026-10-31：判据整块搬进 `@kojo/plugin-erb-parser`
 * 的 `completion.ts`；宿主这一层只剩把**宿主事实**递进去）。
 *
 * 递进去的三格全是宿主才知道、且判据并不解释的数据：
 * - 表（变量字典 / 基础库 / 指令表 / 位表 / 函数索引通道）来自当前项目的 adapter；
 * - `timingPrefixRe` 是 v1 糖的 `时机 <分野> <编号>：` 块头判据（`.erb` 里没有这种块头）；
 * - `isRawLine` 是 `.kojo` 的糖区 / 原生区分型（`.erb` 恒原生行）。
 *
 * 六路的判定与优先序在插件里**一个字都没动**；本函数不再有第二份实现。
 */
function resolveHoverNameCore(
  lineText: string,
  column: number,
  tables: HoverTables,
  header: KojoDocHeader,
  filePath: string | null,
  surface: HoverSurface,
): HoverHit | undefined {
  return resolveErbHoverAt(
    lineText,
    column,
    {
      ...(tables.dictionary !== undefined ? { dictionary: tables.dictionary } : {}),
      ...(tables.libraryTable !== undefined ? { libraryTable: tables.libraryTable } : {}),
      ...(tables.instructionTable !== undefined ? { instructionTable: tables.instructionTable } : {}),
      ...(tables.variableSchema !== undefined ? { variableSchema: tables.variableSchema } : {}),
      ...(tables.erbIndex !== undefined ? { erbIndex: tables.erbIndex } : {}),
      timingPrefixRe: TIMING_PREFIX_RE,
      isRawLine: (line) => classifyKojoLine(line).kind === 'rawLine',
    },
    filePath,
    surface,
  ) ?? resolveNativeFallback(lineText, column, tables, header);
}

/**
 * 中文 → **原生形态**反查（ZH-D3；判据整块住 `@kojo/kojo-vocab/native-hover`，NAT-HOV 搬家批）
 * ——**只服务 `.kojo1` 的糖写形**：作者在 `.kojo` 里写的中文词（族头 / 中文函数名 / 时机分野与
 * 指令名）不在任何 ERB 判据里。宿主这一层只剩两格注入：转译器的拼名通道（词包不得值引插件）
 * 与当前项目的表。查不到即不显示（不猜）。
 */
function resolveNativeFallback(
  lineText: string,
  column: number,
  tables: HoverTables,
  header: KojoDocHeader,
): HoverHit | undefined {
  return resolveNativeHover(lineText, column, { ...tables, buildFunctionName }, header);
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
 * 为 `.kojo1`（封存的 v1 糖面）注册**只读** hover provider。
 *
 * ERB-PARITY G1（2026-10-31）之后 ERB 不再由本安装器挂：判据整块搬进
 * `@kojo/plugin-erb-parser`，ERB 的悬停由共享收口那一枚（槽 `ui.editor.languageService`
 * 的 `hover` 腿）回答。本模块剩给自己的只有 `.kojo1` 的两条**糖写形**事实
 * （中文 → 原生形态反查、载体注册壳提示）——它们不是 ERB 判据，且作者只在 `.kojo` 里写。
 * 挂载口径用 `excludeNamed: 'hover'`：descriptor 点名了这一格的语言（今天的 ERB）
 * 不再叠一枚旧桥 provider（否则 Monaco 会把两份悬停正文同时摊开）。
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
  return registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerHoverProvider(id, provider),
    undefined,
    { excludeNamed: 'hover' },
  );
}
