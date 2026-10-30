/**
 * ERB 控制流**配对表**的唯一真源（`@kojo/erb-vocab/control-flow`）——为什么住在这里、
 * 两个读者是谁，见包桶 `./index.ts` 的头注。
 *
 * 逐条对齐引擎 `FunctionIdentifier.cs` 的 `funcMatch`：IF→ENDIF / SELECTCASE→ENDSELECT /
 * REPEAT→REND / FOR→NEXT / WHILE→WEND / DO→LOOP / TRYC 六个→CATCH→ENDCATCH /
 * PRINTDATA 系 9 个→ENDDATA / DATALIST→ENDLIST / STRDATA→ENDDATA / NOSKIP→ENDNOSKIP /
 * TRYCALLLIST·TRYGOTOLIST·TRYJUMPLIST→ENDFUNC（配对类 funclist）；`TRYCALL` / `TRYCALLFORM`
 * / `TRYGOTO` / `TRYJUMP` 等是单行语句、不开块（BUG-2 修复）。
 *
 * 硬约束：**零运行时 import**（裸 node 类型擦除档要能直接解析）、纯数据 / 纯函数、零游戏名词。
 */

/** 开块语句：kind → 配对类别 */
const OPEN_KINDS: Readonly<Record<string, string>> = {
  IF: 'if',
  SELECTCASE: 'select',
  FOR: 'for',
  WHILE: 'while',
  REPEAT: 'repeat',
  DO: 'do',
  DATALIST: 'list',
  STRDATA: 'data',
  NOSKIP: 'noskip',
};

/** 分支语句：与所配对的开块语句同深度 */
const BRANCH_KINDS: Readonly<Record<string, string>> = {
  ELSEIF: 'if',
  ELSE: 'if',
  CASE: 'select',
  CASEELSE: 'select',
  CATCH: 'try',
};

/** 闭合语句 */
const CLOSE_KINDS: Readonly<Record<string, string>> = {
  ENDIF: 'if',
  ENDSELECT: 'select',
  NEXT: 'for',
  WEND: 'while',
  REND: 'repeat',
  LOOP: 'do',
  ENDDATA: 'data',
  ENDLIST: 'list',
  ENDNOSKIP: 'noskip',
  ENDCATCH: 'try',
  ENDFUNC: 'funclist',
};

/** 单行语句（不配对、不开块；如 SIF = Single IF） */
const LEAF_KINDS = new Set(['SIF']);

/**
 * TRY 系精确三档（funcMatch :460-487）：
 * - 配 CATCH 的恰为 6 个：TRYCGOTO / TRYCJUMP / TRYCCALL（±FORM）；
 * - 配 ENDFUNC 的恰为 3 个：TRYCALLLIST / TRYGOTOLIST / TRYJUMPLIST（配对类 funclist）；
 * - 其余 TRY*（TRYCALL / TRYCALLFORM / TRYGOTO / TRYGOTOFORM / TRYJUMP / TRYJUMPFORM）
 *   是**单行语句**，不开块——旧版 startsWith('TRY') 把它们误当开块，产生幻影深度。
 */
const TRY_CATCH_OPEN: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
]);
const TRY_LIST_OPEN: ReadonlySet<string> = new Set(['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST']);

/** PRINTDATA 系精确 9 个（funcMatch :477-485；DATALIST / STRDATA 在 OPEN_KINDS 单列） */
const PRINTDATA_OPEN: ReadonlySet<string> = new Set([
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAKL',
  'PRINTDATAKW',
  'PRINTDATAD',
  'PRINTDATADL',
  'PRINTDATADW',
]);

/**
 * 引擎语句词表：由上面四张开 / 分支 / 闭合表 + TRY 三档 + PRINTDATA 系**派生**——不是另抄
 * 一份清单：配对表增删一词，本表自动跟随。宿主的 ERB 高亮拿它补 `ERB_DIRECTIVES`（口上高频
 * 子集）之外的引擎语句，补全候选**不**消费本表（低频语句不进补全）。
 *
 * 排序确定（UTF-16 码元序）+ 大小写归一去重，同一引擎表恒得同一顺序。
 */
export const ERB_CONTROL_STATEMENTS: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of [
    ...Object.keys(OPEN_KINDS),
    ...Object.keys(BRANCH_KINDS),
    ...Object.keys(CLOSE_KINDS),
    ...LEAF_KINDS,
    ...TRY_CATCH_OPEN,
    ...TRY_LIST_OPEN,
    ...PRINTDATA_OPEN,
  ]) {
    const key = word.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
})();

/**
 * 控制流角色（配对表的唯一出口）。
 *
 * 为什么不直接 export 那几个 Record：骨架扫描（`scanControlFlow`）与结构体检（`structure.ts`）
 * **必须用同一份配对表**——两处各持一份就必然漂移，而漂移的表现为"波浪线指错了行"。
 */
export type ControlFlowRole = 'open' | 'branch' | 'close' | 'leaf';

/**
 * 配对分类（逐条对齐引擎 `FunctionIdentifier.cs` 的 funcMatch）。
 * 骨架扫描、结构体检、高亮、扩选都走这道门——**这是配对表的单一真源**。
 */
export function classifyControlFlow(kind: string): { role: ControlFlowRole; pair: string } | null {
  if (LEAF_KINDS.has(kind)) return { role: 'leaf', pair: '' };
  if (OPEN_KINDS[kind] !== undefined) return { role: 'open', pair: OPEN_KINDS[kind]! };
  if (BRANCH_KINDS[kind] !== undefined) return { role: 'branch', pair: BRANCH_KINDS[kind]! };
  if (CLOSE_KINDS[kind] !== undefined) return { role: 'close', pair: CLOSE_KINDS[kind]! };
  if (PRINTDATA_OPEN.has(kind)) return { role: 'open', pair: 'data' };
  if (TRY_CATCH_OPEN.has(kind)) return { role: 'open', pair: 'try' };
  if (TRY_LIST_OPEN.has(kind)) return { role: 'open', pair: 'funclist' };
  return null;
}

/**
 * 配对类别 → 该类别的闭合语句原词（结构体检的话术要用）。
 * 从 `CLOSE_KINDS` **反查**得到——不抄第二份表；每个类别只有一个闭合词，所以是单值。
 * 查不到返回空串（调用方要能容忍"说不出闭合词"）。
 */
export function closerNameForPair(pair: string): string {
  for (const [closer, p] of Object.entries(CLOSE_KINDS)) {
    if (p === pair) return closer;
  }
  return '';
}
