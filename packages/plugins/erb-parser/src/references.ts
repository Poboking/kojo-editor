import type { ErbFile, ErbIndex, ErbReference, ErbReferenceIndex, ErbReferenceKind } from '@kojo/plugin-api';

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
 */
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** 定义名截断（与 `parseFunctionDefinition` 同一组终止符；名字在这里只按解析器口径取） */
const DEF_STOP = new Set(['(', ' ', '\t', ';']);

/** 变量成员访问的分隔冒号（半/全角）：`FLAG:NAME` 里 NAME 引用的是 FLAG 的成员，不是函数 */
const isMemberColon = (c: string | undefined): boolean => c === ':' || c === '：';

/**
 * 扫描单文件文本的全部引用流水（**纯函数**：文本进、紧凑记录出，不读盘）。
 *
 * `hasName` 是"这个名字是不是项目里的某个函数"的唯一判据——由调用方拿
 * `ErbIndex.byName` 提供，本模块因此对"项目里有哪些函数"零知识、可独立单测。
 * 行可见性与 `parseErbText` 对齐：`[SKIPSTART]…[SKIPEND]` 屏蔽、整行 `;`、
 * `#` 指令、`$` 标签、`@` 定义行（只取名字记号，形参不扫）。
 */
export function scanFileRefs(text: string, hasName: (normalizedName: string) => boolean): FileRefs {
  const lines = normalizeEol(text).split('\n');
  const out: RefRun[] = [];
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

    const line = i + 1;

    if (trimmed.startsWith('@')) {
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

    const code = codeViewOf(raw);
    // 行首是 CALL 直系族 ⇒ 关键字之后的**第一个记号**是引擎"按名调用"的名字槽位
    const lead = /^[A-Za-z_]+/.exec(trimmed);
    const isCallLine = lead !== null && CALL_FAMILY.has(lead[0]!.toUpperCase());
    // 名字槽起点（行内 0 基偏移）= 缩进 + 关键字长度；缩进只算行首空白（trailing 会干扰差值）
    const keywordEnd = isCallLine ? raw.length - raw.trimStart().length + lead![0].length : -1;
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
      // 快路径：无小写拉丁（半/全角）就不分配 toUpperCase 副本（412 万行的热路径）。
      // 残余风险只有"西里尔/希腊小写进函数名"这种语料里不存在的形态——真出现也是漏报一条
      // 提及（方向保守），不会错指；CJK 无大小写，不受影响。
      const upper = /[a-zａ-ｚ]/.test(run) ? run.toUpperCase() : run;
      if (!hasName(upper)) continue;
      out.push([upper, line, m.index + 1, (inSlot ? KIND_CALL : KIND_MENTION) as 0 | 1 | 2]);
    }
  }
  return out;
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
