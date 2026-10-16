import type {
  EditorDecoratePayload,
  ErbFile,
  ErbIndex,
  ErbReference,
  ErbReferenceIndex,
  ErbReferenceKind,
  LineDecoration,
} from '@kojo/plugin-api';
import { isErbDialectPath, MODEL_TOKEN_CLASS } from '@kojo/plugin-api';

/**
 * 反向引用索引（H2 批，2026-10-15）：**谁提到了这个名字**。
 *
 * find-references / rename 的共同前置——`byName` 只回答"名字→定义"，
 * "引用→名字"此前全仓不存在。本模块补齐反向边，纪律两条：
 * - **构建只读索引期已流过的文本**（stale 文件重读一次，412 万行文本绝不整份留驻）；
 * - **查询是纯函数**：`referencesOf` 只读 `index.references`，不读盘、不改状态。
 *
 * 引用面（取舍，详见契约 `ErbReference.kind`）：
 * 可证明的只有"函数名作为**可见代码记号整串**出现"这一条——
 * 注释（整行与行内尾巴）、字符串内容、`[SKIPSTART…SKIPEND]`、`#DIM`/``$`` 标签行
 * 一律**不算**引用；`JUMP`/`GOTO` 目标是行号/标签、`*CALLFORM` 参数是表达式，
 * 解析它们要数据流，超出可证明边界，宁可少报不误报。
 * 可见性规则与 `parseErbText` 逐条对齐（两套屏蔽规则分叉 = 漂移源）。
 *
 * 2026-10-16 语言服务批起，本模块同时是**未定义 CALL 目标波浪线**（T3）的判据真源：
 * `scanUndefinedCallTargets` / `erbReferenceDecorations` 与 `scanFileRefs` 共用
 * 同一条可见行遍历（`visibleCodeLines`）、同一张 `CALL_FAMILY` 表、同一个记号字符集
 * ——"哪些字符算引用"只有一把尺子。
 */

/** 行首直系调用关键字（参数位就是**函数名**的那些；FORM / GOTO / JUMP 系不在内，理由见头注） */
const CALL_FAMILY: ReadonlySet<string> = new Set(['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']);

const KIND_DEFINITION = 0;
const KIND_CALL = 1;
const KIND_MENTION = 2;
const KIND_BY_FLAG: readonly ErbReferenceKind[] = ['definition', 'call', 'mention'];

/**
 * 盘上/内存共用的紧凑格式：`[归一化名, 行, 列, 种类旗标]`。
 * `endColumn` 不落盘（= column + 名字长度，可派生——快照瘦身 v3 的同一条纪律）。
 * 名字统一存**归一化大写**：引用原文可以小写，但索引键只有大写形态。
 */
export type RefRun = readonly [name: string, line: number, column: number, kind: 0 | 1 | 2];

/** 单文件的引用流水（按行、列升序；构建序确定 ⇒ 聚合序确定） */
export type FileRefs = readonly RefRun[];

/** 行内换行归一（与 scanner 同规则；插件内自带，不依赖 kernel） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 一行的"代码视野"：字符串内容与引号外的 `;` 注释尾巴**等长刷白**。
 * 等长是为了保住列坐标（引用点要能回指原文位置）；PRINT 字符串里的 `;` 不当注释
 * （与 `sliceExpression` 同一口径）。未闭合引号按"到行尾都是字符串"处理——
 * 那种文本引擎本来就编译不过，刷白是安全方向。
 */
function codeViewOf(line: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      out += ' ';
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += ' ';
      continue;
    }
    if (c === ';') return out + ' '.repeat(line.length - i);
    out += c;
  }
  return out;
}

/**
 * 可见代码记号：Unicode 字母/数字/下划线。
 * **刻意不锁 ASCII**——真实语料 99,118 条 `@` 定义里 20,805 条（21%）名字含 CJK
 * （`M_KOJO_無個性_…` 一族，eraTW 作者手写），ASCII 字符集会静默漏掉两成定义的反向边。
 * 与 `plugin-api/symbol-token` 的 ASCII 集**不同**是有意分歧：那张表服务"光标命中"
 * （宁可窄），这张表服务"全库反向索引"（漏了就是错）。
 *
 * 字符集**字面量只住在 `plugin-api/semantic-locate` 的 `MODEL_TOKEN_CLASS`**：着色落点
 * （`locateIdentifier`）与本条反向索引回答的是同一个事实——"什么字符算一个记号"。
 * 两处各写一遍就是第二判据，漂移表现是"引用面板说有引用、着色却不亮"（反之亦然）。
 */
const TOKEN_RE = new RegExp(`${MODEL_TOKEN_CLASS}+`, 'gu');

/** 定义名截断（与 `parseFunctionDefinition` 同一组终止符；名字在这里只按解析器口径取） */
const DEF_STOP = new Set(['(', ' ', '\t', ';']);

/** 变量成员访问的分隔冒号（半/全角）：`FLAG:NAME` 里 NAME 引用的是 FLAG 的成员，不是函数 */
const isMemberColon = (c: string | undefined): boolean => c === ':' || c === '：';

/**
 * 一条**可见代码行**的形状（`visibleCodeLines` 的产出；列坐标与原文逐位对齐）。
 */
interface VisibleCodeLine {
  /** 1 基行号 */
  readonly line: number;
  /** 行原文（未 trim；列对齐的基准） */
  readonly raw: string;
  /** 代码视野（字符串内容与行内注释尾巴等长刷白；与 `raw` 等长同位） */
  readonly code: string;
  /** `@` 定义行（定义名按解析器口径截，调用方自理） */
  readonly isDefinition: boolean;
  /** 行首是 CALL 直系族（名字槽判据，同一张 `CALL_FAMILY` 表） */
  readonly isCallLine: boolean;
  /** CALL 关键字之后的行内 0 基偏移（非调用行 = -1） */
  readonly keywordEnd: number;
}

/**
 * 可见代码行的**唯一**遍历（2026-10-16 语言服务批）：
 * `scanFileRefs`（反向索引）与 `scanUndefinedCallTargets`（未定义 CALL 波浪线）共用
 * ——屏蔽规则（`[SKIPSTART]` 区、空行、整行 `;`、`#` 指令、`$` 标签、`@` 定义行）
 * 与"哪行有名字槽"只写在这里。两处各写一遍就是第二判据，漂移的表现是
 * "引用面板说没有、波浪线却红"（反之亦然）。
 */
function* visibleCodeLines(text: string): Generator<VisibleCodeLine> {
  const lines = normalizeEol(text).split('\n');
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('$')) {
      continue;
    }

    if (trimmed.startsWith('@')) {
      // 定义行：名字提取按解析器口径（调用方自理）；调用判据一概不适用
      yield { line: i + 1, raw, code: '', isDefinition: true, isCallLine: false, keywordEnd: -1 };
      continue;
    }

    // 行首是 CALL 直系族 ⇒ 关键字之后的**第一个记号**是引擎"按名调用"的名字槽位
    const lead = /^[A-Za-z_]+/.exec(trimmed);
    const isCallLine = lead !== null && CALL_FAMILY.has(lead[0]!.toUpperCase());
    // 名字槽起点（行内 0 基偏移）= 缩进 + 关键字长度；缩进只算行首空白（trailing 会干扰差值）
    const keywordEnd = isCallLine ? raw.length - raw.trimStart().length + lead![0]!.length : -1;
    yield { line: i + 1, raw, code: codeViewOf(raw), isDefinition: false, isCallLine, keywordEnd };
  }
}

/** 归一化快路径：无小写拉丁（半/全角）就不分配 toUpperCase 副本（412 万行的热路径）。 */
function normalizedUpper(run: string): string {
  return /[a-zａ-ｚ]/.test(run) ? run.toUpperCase() : run;
}

/**
 * 扫描单文件文本的全部引用流水（**纯函数**：文本进、紧凑记录出，不读盘）。
 *
 * `hasName` 是"这个名字是不是项目里的某个函数"的唯一判据——由调用方拿
 * `ErbIndex.byName` 提供，本模块因此对"项目里有哪些函数"零知识、可独立单测。
 * 行可见性与 `parseErbText` 对齐：`[SKIPSTART]…[SKIPEND]` 屏蔽、整行 `;`、
 * `#` 指令、`$` 标签、`@` 定义行（只取名字记号，形参不扫）。
 */
export function scanFileRefs(text: string, hasName: (normalizedName: string) => boolean): FileRefs {
  const out: RefRun[] = [];
  for (const { line, raw, code, isDefinition, isCallLine, keywordEnd } of visibleCodeLines(text)) {
    if (isDefinition) {
      // 定义行：名字按**解析器的口径**截（终止符 `(`/空白/`;` + 截后 trim，与
      // `parseFunctionDefinition` 逐字符对齐——真语料实测 4 条定义名带全角空白，
      // 不对齐这条口径 `defSites === 函数总数` 就差 4，反向边静默漏定义）。
      // 形参表与行内注释都不扫。
      const at = raw.indexOf('@');
      let j = at + 1;
      while (j < raw.length && !DEF_STOP.has(raw[j]!)) j++;
      const slice = raw.slice(at + 1, j);
      const name = slice.trim();
      if (name.length > 0) {
        const upper = name.toUpperCase();
        if (hasName(upper)) out.push([upper, line, at + 2 + (slice.length - slice.trimStart().length), KIND_DEFINITION]);
      }
      continue;
    }

    let slotTaken = !isCallLine; // 非调用行没有槽位概念，全部走 mention

    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      const run = m[0]!;
      const inSlot = !slotTaken && m.index >= keywordEnd;
      if (inSlot) slotTaken = true; // 槽位记号无论命不命中名字都被消耗
      // 变量成员访问整体不算函数引用：`CFLAG:ALPHA` 两段都是变量世界（基名紧邻冒号，
      // 如 `ALPHA:CFLAG` 的 ALPHA，即便撞上函数名也不算提及）。
      if (isMemberColon(code[m.index - 1]) || isMemberColon(code[m.index + run.length])) continue;
      const upper = normalizedUpper(run);
      if (!hasName(upper)) continue;
      out.push([upper, line, m.index + 1, (inSlot ? KIND_CALL : KIND_MENTION) as 0 | 1 | 2]);
    }
  }
  return out;
}

/* ---------------- 未定义 CALL 目标（T3，2026-10-16 语言服务批） ---------------- */

/** CALL 名字槽里一处**未收录**的裸标识符（波浪线装饰的数据面） */
export interface UndefinedCallTarget {
  /** 1 基行号 */
  readonly line: number;
  /** 名字首字符（1 基列） */
  readonly column: number;
  /** 原样记号 */
  readonly name: string;
}

/**
 * 扫出全部"CALL 直系族 + 裸标识符 + 名字不在名录"的槽位（**纯函数**：文本 + 名字集进、
 * 数据出；单遍线性扫描，不做二次全文件解析）。
 *
 * `hasName` 与 `scanFileRefs` 同一判据（调用方拿 `ErbIndex.byName` 提供）；
 * 行可见性与记号字符集与它**逐字共用**（`visibleCodeLines` / `TOKEN_RE`，单一真源）。
 * fail-open 全在判据里，一条都不报（**不猜**；错标比不标危险）：
 * - FORM 动态拼接：关键字与记号之间出现 `(`、`"`、`{`、`%` 等任何非空白字符；
 * - 成员访问占槽（`CALL FLAG:X`——变量世界，与 `scanFileRefs` 同判据不向后顺延）；
 * - `CALLFORM` 全族（不在 `CALL_FAMILY` 表里）、字符串 / 注释 / `[SKIPSTART]` 区、
 *   `$` 标签行（`visibleCodeLines` 屏蔽面）；
 * - 名字在名录里的（那不是"未定义"）。
 */
export function scanUndefinedCallTargets(text: string, hasName: (upper: string) => boolean): UndefinedCallTarget[] {
  const out: UndefinedCallTarget[] = [];
  for (const { line, raw, code, isCallLine, keywordEnd } of visibleCodeLines(text)) {
    if (!isCallLine) continue;
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      if (m.index < keywordEnd) continue; // 关键字自身
      // 槽位 = 关键字后的第一个记号；与关键字之间只许空白 ⇒ 裸标识符
      if (!/^[\t \u3000]*$/.test(raw.slice(keywordEnd, m.index))) break;
      const run = m[0]!;
      // 成员访问占槽：整槽不算函数名，也不向后顺延
      if (isMemberColon(code[m.index - 1]) || isMemberColon(code[m.index + run.length])) break;
      if (!hasName(normalizedUpper(run))) out.push({ line, column: m.index + 1, name: run });
      break; // 一行至多一个名字槽
    }
  }
  return out;
}

/** 诊断码（问题面板 / 工具提示分组；与糖线 `sugar.*`、表达式线 `erb.expr-*` 同族命名） */
export const UNDEFINED_CALL_CODE = 'erb.call-undefined';

/**
 * 未定义 CALL 目标的波浪线（`ui.editor.decorator` 贡献的**单一真源**，插件接线共用它）。
 *
 * **同步主线程执行、不搬 worker**：判据要读 `ErbIndex.byName`（项目态），搬进 worker
 * 就得复制索引——取舍与 `.kojo` 转译同款（字典/时机表是项目态，硬搬造假错）。
 * 索引缺席（未开项目 / 还没建好）⇒ 调用方（插件）**一条不报**：fail-open 是纪律，
 * "全红"比"没有提示"糟得多；索引几秒后建好，波浪线随之而来。
 * 非方言文件（`.kojo` 的诊断另有糖线管）与空文本 ⇒ 空数组。
 */
export function erbReferenceDecorations(
  { path, text }: EditorDecoratePayload,
  hasName: (upper: string) => boolean,
): LineDecoration[] {
  if (!isErbDialectPath(path) || text.length === 0) return [];
  return scanUndefinedCallTargets(text, hasName).map((t) => ({
    line: t.line,
    severity: 'warning' as const,
    message: `未定义的调用目标「${t.name}」：项目索引里没有这个函数名（动态拼接请改用 CALLFORM 系）`,
    startColumn: t.column,
    endColumn: t.column + t.name.length,
    code: UNDEFINED_CALL_CODE,
  }));
}

/**
 * 聚合为反向索引（与 `aggregateIndex` 同一条**顺序确定**纪律：
 * 入参 `files` 的迭代序 = 本次 walkDir 序 ⇒ 每个名字的引用表按 文件→行→列 确定排序）。
 * `filePath` 复用 `ErbFile.path` 的同一字符串实例——几百万引用点不各拷一份路径。
 */
export function buildReferenceIndex(
  files: Iterable<ErbFile>,
  refsByPath: ReadonlyMap<string, FileRefs>,
): ErbReferenceIndex {
  const bySymbol = new Map<string, ErbReference[]>();
  for (const file of files) {
    const runs = refsByPath.get(file.path);
    if (runs === undefined) continue;
    for (const [name, line, column, kind] of runs) {
      let list = bySymbol.get(name);
      if (list === undefined) {
        list = [];
        bySymbol.set(name, list);
      }
      list.push({ filePath: file.path, line, column, endColumn: column + name.length, kind: KIND_BY_FLAG[kind]! });
    }
  }
  return { bySymbol };
}

/** 查询：谁引用了 `name`（原样/大写均可；无索引 / 无名 ⇒ 空数组。**纯函数，不读盘**） */
export function referencesOf(index: ErbIndex, name: string): ErbReference[] {
  const hit = index.references?.bySymbol.get(name.toUpperCase());
  return hit === undefined ? [] : hit.slice();
}
