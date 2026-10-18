import type * as Monaco from './entry';
import type {
    ErbDim,
    ErbIndex,
    KojoCounterTable,
    KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/plugin-kojo-sugar';
import { erbBitHoverName } from './erb-completion-bits';
import { BLANK_CLASS_STR } from './kojo-completion-position';
import { type KojoDocHeader, docHeaderOf, resolveNativeHover } from './kojo-hover-native';
import { registerForKojoDialects } from './register-dialects';

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
}

const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:]/.test(ch);
const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
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

  // 2) 英文函数名：`GETBIT` → 获取标记（系统表反向优先，再查 adapter 基础库表反查）。
  const identSpan = spanAround(lineText, col0, isIdentChar);
  if (identSpan) {
    const token = lineText.slice(identSpan.start, identSpan.end);
    const cn = SYSTEM_FUNCTION_REVERSE.get(token) ?? tables.libraryTable?.lookupByFunction?.(token);
    if (cn !== undefined && cn.length > 0) {
      return { name: cn, kind: `函数 · ${token}`, startColumn: identSpan.start + 1, endColumn: identSpan.end + 1 };
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
  const erbFn = resolveErbFunctionHover(lineText, col0, tables.erbIndex);
  if (erbFn !== undefined) return erbFn;

  // 5.5) 本文件 `#DIM` 声明（EC-DECL 的悬停半边，2026-10-19）：`#DIM 好感度` 声明过之后，
  //      正文里写这个名字时显示「声明行 + 指令」。数据源 = 同一份 `ErbIndex.files`（不扫全文、
  //      不写第二份正则）；文件不在索引 / 声明表缺席 ⇒ 不显示（不猜）。
  const erbDim = resolveErbDimHover(lineText, col0, tables.erbIndex, filePath);
  if (erbDim !== undefined) return erbDim;

  // 6) 中文 → **原生形态**反查（ZH-D3；`kojo-hover-native.ts`）：族头中文别名、中文函数名 /
  //    语句形调用、时机块头的分野与中文指令名。前五路只认 ASCII 记号与位槽，本路只认中文，
  //    两条路天然不撞；同样「查不到即不显示」（不猜）。
  return resolveNativeHover(lineText, column, tables, header);
}

/**
 * ERB 函数路（**纯函数**）：光标词在 `ErbIndex.byName` 里 ⇒ 产出带正文的命中。
 *
 * - 名词查表用**归一化大写**（Emuera 函数名大小写不敏感，与 `byName` 键同口径）；
 * - 正文 = docComment（有则按行拆开）+ 形参签名（参数取自同一索引的 `files` 全量定义，
 *   文件不在索引 ⇒ 只省签名这一行，不猜）+ 定义位置（`文件路径:行号`）；
 * - 同名多处定义：显示首条的正文与位置，并追加一行注明剩余处数（重名事实不藏）。
 */
function resolveErbFunctionHover(
  lineText: string,
  col0: number,
  getIndex: (() => ErbIndex | null | undefined) | undefined,
): HoverHit | undefined {
  if (typeof getIndex !== 'function') return undefined;
  let index: ErbIndex | null | undefined;
  try {
    index = getIndex();
  } catch {
    return undefined;
  }
  if (!index) return undefined;
  const span = spanAround(lineText, col0, isIdentChar);
  if (!span) return undefined;
  const token = lineText.slice(span.start, span.end);
  const defs = index.byName.get(token.toUpperCase());
  if (!defs || defs.length === 0) return undefined;

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
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    lines,
  };
}

/**
 * `#DIM` 声明名悬停（2026-10-19，EC-DECL 的显示半边）。
 *
 * 与函数路共用同一份 `ErbIndex.files`（**不扫全文、不写第二份 `#DIM` 正则**）：先按
 * 路径归一（分隔符 / 大小写）找到当前文件，再在 `dims` 里按大小写不敏感整词匹配。
 * 文件不在索引 / 索引缺席 / 词不是声明名 ⇒ `undefined`（不猜）。
 *
 * 名字字符集比 ASCII 标识符宽：`#DIM 好感度` / 全角字母都是合法声明名，
 * 故 span 用"非空白 + 非运算符"判据，而不是函数路的 `[A-Za-z0-9_]`。
 */
function resolveErbDimHover(
  lineText: string,
  col0: number,
  getIndex: (() => ErbIndex | null | undefined) | undefined,
  filePath: string | null,
): HoverHit | undefined {
  if (typeof getIndex !== 'function' || !filePath) return undefined;
  let index: ErbIndex | null | undefined;
  try {
    index = getIndex();
  } catch {
    return undefined;
  }
  if (!index) return undefined;
  const span = spanAround(lineText, col0, isDimNameChar);
  if (!span) return undefined;
  const token = lineText.slice(span.start, span.end);
  if (token.length === 0) return undefined;
  const key = normalizePathKey(filePath);
  let file: { path: string; dims?: readonly ErbDim[] } | undefined;
  for (const [p, f] of index.files) {
    if (normalizePathKey(p) === key) {
      file = f as { path: string; dims?: readonly ErbDim[] };
      break;
    }
  }
  if (!file) return undefined;
  const dim = (file.dims ?? []).find((d) => d.name.toUpperCase() === token.toUpperCase());
  if (!dim) return undefined;
  return {
    name: dim.name,
    kind: `#${dim.directive} 声明`,
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    lines: [`声明于 \`${file.path}:${dim.line}\``],
  };
}

/** 路径比较键（Windows 分隔符 + 大小写不敏感；索引键与 model.uri 来自不同腿） */
export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** `#DIM` 名字字符：非空白、非运算符/分隔符（中文与全角字母都是合法声明名） */
export const isDimNameChar = (ch: string): boolean => !/[\s,;:()[\]{}=+\-*/<>%!&|'"`]/.test(ch);

/**
 * 为 ERB 方言（`.erb` / `.erh` / `.erd`）与 `.kojo` 两种语言注册**只读** hover provider。
 *
 * `getTables` 每次悬停时才调用（表按当前项目 adapterId 实时取，同 `refreshMarkers` 纪律）。
 * 文件头事实（`角色:` / `口上:`）同样**当场从模型读**（只读 `getLineContent` /
 * `getLineCount`，不缓存、不改文档），反向路据此拼出原生函数名。
 * 返回可释放句柄——宿主在编辑器卸载时调用 `dispose()`。
 */
export function installHover(monaco: typeof Monaco, getTables: () => HoverTables): Monaco.IDisposable {
  const provider: Monaco.languages.HoverProvider = {
    provideHover(model, position) {
      const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : position.lineNumber;
      const header = docHeaderOf((n) => model.getLineContent(n), lineCount);
      // 当前文件的路径（`#DIM` 声明悬停要在索引里找"本文件"）：桩 model 无 uri ⇒ null（该路不做）
      const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
      const filePath =
        uri !== null && typeof uri === 'object'
          ? typeof uri.fsPath === 'string' && uri.fsPath.length > 0
            ? uri.fsPath
            : typeof uri.path === 'string' && uri.path.length > 0
              ? uri.path
              : null
          : null;
      const hit = resolveHoverName(
        model.getLineContent(position.lineNumber),
        position.column,
        getTables(),
        header,
        filePath,
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
  return registerForKojoDialects(monaco, (m, id) => m.languages.registerHoverProvider(id, provider));
}
