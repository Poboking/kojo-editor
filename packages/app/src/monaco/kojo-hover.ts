import type * as Monaco from './entry';
import type { KojoInstructionTable, KojoLibraryTable, VariableSchema } from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/plugin-kojo-sugar';
import { erbBitHoverName } from './erb-completion-bits';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

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
}

/** 一次解析的产物：显示中文名 + 类别 + 命中的列区间（1 基，供 hover 高亮） */
export interface HoverHit {
  readonly name: string;
  readonly kind: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:]/.test(ch);
const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** 变量引用：`族名` + 至少一段 `:段`（段可含角色号 / 索引 / 作用域名） */
const REF_RE = /^([A-Za-z][A-Za-z0-9_]*):(.+)$/;
/** 指令编号的**上下文**：糖的 `时机 <分野> <编号>：` 块头，编号前是 `时机 <分野> ` */
const TIMING_PREFIX_RE = /^\s*时机[ \t]+\S+[ \t]+$/;

/** 命中光标（含其左右邻接同类字符）的最长一段（`col0` = 0 基字符下标；无同类字符返回 null） */
function spanAround(line: string, col0: number, isChar: (ch: string) => boolean): { start: number; end: number } | null {
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
 * 返回 `undefined` = 该处没有可显示的中文名（**不猜**：查不到一律不显示）。
 */
export function resolveHoverName(lineText: string, column: number, tables: HoverTables): HoverHit | undefined {
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

  return undefined;
}

/**
 * 为 ERB 方言（`.erb` / `.erh` / `.erd`）与 `.kojo` 两种语言注册**只读** hover provider。
 *
 * `getTables` 每次悬停时才调用（表按当前项目 adapterId 实时取，同 `refreshMarkers` 纪律）。
 * 返回可释放句柄——宿主在编辑器卸载时调用 `dispose()`。
 */
export function installHover(monaco: typeof Monaco, getTables: () => HoverTables): Monaco.IDisposable {
  const provider: Monaco.languages.HoverProvider = {
    provideHover(model, position) {
      const hit = resolveHoverName(model.getLineContent(position.lineNumber), position.column, getTables());
      if (!hit) return undefined;
      return {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: hit.startColumn,
          endColumn: hit.endColumn,
        },
        contents: [{ value: `**${hit.name}**（${hit.kind}）` }],
      };
    },
  };
  const subs = [
    monaco.languages.registerHoverProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerHoverProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
