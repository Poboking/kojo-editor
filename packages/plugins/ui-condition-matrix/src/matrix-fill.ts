/**
 * 条件矩阵「填格子」的**模板生成**（零 React、零 IO，可单测）。
 *
 * 输入 = 一批空格（状态行 × 时机列）+ 目标口上包；输出 = 可直接落盘的文本。
 * 两条生成路径按「本包在这个时机有没有函数」分：
 *   - **已有函数**（占列）：生成一段条件分支，注释里指明应并入哪个函数——同名时机
 *     不能再写一个完整函数（引擎撞重复定义 / 糖编译报 function-name-duplicate）；
 *   - **整列缺席**：生成完整函数骨架（ERB）或完整 `时机` 块（.kojo）。
 *
 * 语言知识边界：
 *   - ERB 侧只用本文件里的最小骨架（PRINTFORMW / IF / ENDIF / RETURN），不复制转译器；
 *   - .kojo 侧的分野关键字**从 adapter 的分野表反查**（渲染模板与真实函数名比对），
 *     不猜、不把某个游戏的关键字写死。反查不到时退回原生 ERB 骨架并显式注明
 *     （.kojo 允许原生直通），绝不产出看起来像糖、编译却失败的半成品。
 *
 * 首版按用户要求「先生成统一的示例注释」：条件用本行已有比较集合的首条做示例，
 * 台词统一是 `「……」` 占位；骨架结构（并入点 / 完整时机 / 家族段替换）已按后续
 * 自动并入、按阈值分组、按角色语气生成留好扩展位。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';
import type {
  CharacterEntry,
  ConditionMatrix,
  MatrixColumn,
  MatrixColumnFunction,
  MatrixRow,
} from './matrix-logic';

export type FillLanguage = 'erb' | 'kojo';

/** 一次填空请求里的一格（行键 + 列键） */
export interface FillCellRef {
  readonly rowKey: string;
  readonly columnKey: string;
}

/** 目标口上包（面板从 AuthorPack 投影而来） */
export interface FillPack {
  readonly key: string;
  readonly dirName: string;
  readonly label: string;
  readonly dirPath: string | null;
  /** 本包统一家族段（无 = ''，即初始家族） */
  readonly family: string;
  /** 家族选择器（「别人版」> 0；新 .kojo 文件头用，缺省 0 = 标准版） */
  readonly selector?: number;
}

/** 角色最小信息（生成注释与家族名替换用） */
export interface FillChara {
  readonly no: number;
  readonly name: string;
}

/** 一个时机列的生成计划 */
export interface FillColumnPlan {
  readonly column: MatrixColumn;
  readonly rows: readonly MatrixRow[];
  /** merge = 本包已有该时机的函数，只生成并入片段；new = 整列缺席，生成完整骨架 */
  readonly mode: 'merge' | 'new';
  /** merge 时的目标函数（无可用目标 → null，生成器会降级为注释提示） */
  readonly target: MatrixColumnFunction | null;
}

export interface FillPlan {
  readonly language: FillLanguage;
  readonly columns: readonly FillColumnPlan[];
  readonly code: string;
  readonly mergeCount: number;
  readonly newCount: number;
  readonly cellCount: number;
  /** 目标包里其实已填 / 行或列不存在 → 被跳过的格数（面板显式告知，不静默吞） */
  readonly skipped: number;
  /** `skipped` 的子集：新建文件装不下的「并入片段」格（追加模式下不会出现） */
  readonly skippedMerge: number;
}

/** 一条渲染请求的完整输入 */
export interface BuildFillPlanOptions {
  readonly matrix: ConditionMatrix;
  readonly cells: readonly FillCellRef[];
  readonly language: FillLanguage;
  readonly pack: FillPack;
  readonly chara: FillChara;
  /** adapter 的分野表（.kojo 生成用；缺省 → 原生 ERB 兜底） */
  readonly faceTable?: KojoFaceTable;
  /**
   * 生成结果将写进**新文件**（缺省 false = 追加到既有文件）。
   * 新文件装不下「并入片段」（片段必须落进已有函数体内），故这类格会被跳过并计数；
   * .kojo 新文件还要补 `角色:` / `口上:` 文件头，否则糖层读不到角色号与家族段。
   */
  readonly standalone?: boolean;
}

/** 从本包聚合里取统一家族段（面板建 FillPack 时用） */
export function dominantFamilyOfEntry(entry: CharacterEntry): string {
  return dominantFamily(
    entry.functions.map((fn) => ({
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      family: fn.match.family,
      prefix: fn.match.prefix,
      kind: fn.match.kind,
      face: fn.match.face,
      slot: fn.match.slot,
      isMessageCheck: fn.match.isMessageCheck,
    })),
  );
}

/**
 * 本包统一家族段对应的选择器（「别人版」> 0）。
 * 只统计与主导家族相同的函数——混合包里别的家族的选择器不该带进来。
 */
export function dominantSelectorOfEntry(entry: CharacterEntry): number {
  const family = dominantFamilyOfEntry(entry);
  const counts = new Map<number, number>();
  for (const fn of entry.functions) {
    if (fn.match.family !== family) continue;
    counts.set(fn.match.selector, (counts.get(fn.match.selector) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [selector, count] of counts) {
    if (count > bestCount) {
      best = selector;
      bestCount = count;
    }
  }
  return best;
}

/** 从本包函数里取统一家族段：最常见的非空家族；全空 = 初始家族 '' */
export function dominantFamily(functions: readonly MatrixColumnFunction[]): string {
  const counts = new Map<string, number>();
  for (const fn of functions) {
    if (!fn.family) continue;
    counts.set(fn.family, (counts.get(fn.family) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [family, count] of counts) {
    if (count > bestCount) {
      best = family;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 选 merge 的目标函数：优先正文（slot 更具体，如 `301_1`），其次最近的函数；
 * MESSAGECHECK 钩子永远不选（它不是台词正文）。
 */
export function pickMergeTarget(
  functions: readonly MatrixColumnFunction[],
): MatrixColumnFunction | null {
  const usable = functions.filter((fn) => !fn.isMessageCheck);
  const pool = usable.length > 0 ? usable : functions;
  if (pool.length === 0) return null;
  return [...pool].sort(
    (a, b) => b.slot.length - a.slot.length || b.startLine - a.startLine,
  )[0]!;
}

/** 示例条件：优先本包比较集合，其次全角色比较集合，最后 `!= 0` */
export function sampleCondition(row: MatrixRow): string {
  const comps = row.comparisons.length > 0 ? row.comparisons : row.universeComparisons;
  const comp = comps[0];
  return comp ? `${row.key} ${comp}` : `${row.key} != 0`;
}

/** 一条行注释：标签 / 键 / 参考比较 */
function rowNote(row: MatrixRow): string {
  const label = row.label ? `${row.label}（${row.key}）` : row.key;
  const comps = row.comparisons.length > 0 ? row.comparisons : row.universeComparisons;
  return comps.length > 0 ? `${label} · 参考条件：${comps.join('、')}` : label;
}

/** 本包函数里的家族段替换（无法安全替换 → null，绝不猜名字） */
export function substituteFamily(
  name: string,
  fn: Pick<MatrixColumnFunction, 'prefix' | 'family'>,
  toFamily: string,
): string | null {
  const prefix = fn.prefix;
  if (!prefix || !name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (fn.family) {
    const marker = `_${fn.family}`;
    if (!rest.startsWith(marker)) return null;
    return prefix + (toFamily ? `_${toFamily}` : '') + rest.slice(marker.length);
  }
  if (!rest.startsWith('_')) return null;
  return prefix + (toFamily ? `_${toFamily}` : '') + rest;
}

/* ------------------------------ .kojo 分野反查 ------------------------------ */

export interface FaceTimingRef {
  /** 分野关键字（`指令` / `事件` / …） */
  readonly keyword: string;
  /** `{i}` 令牌（数字编号 / 字面名；模板不含 `{i}` 时为空串） */
  readonly index: string;
}

/** 模板里的 `${段}` 名字（去重、保持出现序） */
function segmentNames(template: string): string[] {
  const out: string[] = [];
  const re = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 段取值的笛卡尔积（上限 32 种，防止病态模板炸开） */
function segmentCombos(
  names: readonly string[],
  table: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
): Array<Record<string, string>> {
  let combos: Array<Record<string, string>> = [{}];
  for (const name of names) {
    const values = Object.values(table?.[name] ?? {});
    if (values.length === 0) return []; // 模板要段、表里没有：不猜
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [name]: value });
        if (next.length >= 32) break;
      }
      if (next.length >= 32) break;
    }
    combos = next;
  }
  return combos;
}

/**
 * 反查列对应的糖分野关键字。
 *
 * 判据：把 adapter 的每个模板代入「家族段 / 角色号 / 段值 / 候选编号」，与**真实
 * 函数名**逐字比对——命中才算，绝不凭 face token 猜关键字。编号候选只收：
 * 列上已知的数字编号；或模板声明 `indexKind: 'literal'` 时的字面 slot 首段
 * （`时机 图像 特殊服装：` 这类）。默认 `'command'` 模板不接受非数字 token。
 */
export function resolveFaceTiming(
  faceTable: KojoFaceTable | undefined,
  column: Pick<MatrixColumn, 'face' | 'instructionNo'>,
  universeFunctions: readonly MatrixColumnFunction[],
  charNo: number,
): FaceTimingRef | null {
  if (!faceTable) return null;
  const names = new Set(universeFunctions.map((fn) => fn.name));
  if (names.size === 0) return null;

  const slotTokens = new Set<string>();
  for (const fn of universeFunctions) {
    const first = fn.slot.split('_')[0] ?? '';
    if (first) slotTokens.add(first);
  }

  for (const [keyword, face] of Object.entries(faceTable.faces)) {
    const template = face.template;
    const hasIndex = template.includes('{i}');
    const combos = segmentCombos(segmentNames(template), face.segments);
    if (combos.length === 0) continue;
    const indexCandidates = new Set<string>();
    if (!hasIndex) {
      indexCandidates.add('');
    } else {
      if (column.instructionNo !== null) indexCandidates.add(String(column.instructionNo));
      for (const token of slotTokens) {
        if (/^\d+$/.test(token) || face.indexKind === 'literal') indexCandidates.add(token);
      }
    }
    const familySeg = columnFamilySegment(universeFunctions);
    for (const index of indexCandidates) {
      for (const combo of combos) {
        let rendered = template
          .replaceAll('{t}', familySeg)
          .replaceAll('{n}', String(charNo))
          .replaceAll('{i}', index);
        for (const [name, value] of Object.entries(combo)) rendered = rendered.replaceAll(`\${${name}}`, value);
        if (names.has(rendered)) return { keyword, index };
      }
    }
  }
  return null;
}

/** 模板 `{t}` 的家族段：`{t}` 本身带前导下划线（标准 = 空串） */
function columnFamilySegment(functions: readonly MatrixColumnFunction[]): string {
  const family = dominantFamily(functions);
  return family ? `_${family}` : '';
}

/** 生成一段 `.kojo` 时机的头：`时机 指令 310：` */
function kojoTimingHead(ref: FaceTimingRef): string {
  return `时机 ${ref.keyword}${ref.index ? ` ${ref.index}` : ''}：`;
}

/* ------------------------------ 模板生成 ------------------------------ */

/** ERB 里的示例台词行（4 空格缩进，与仓内既有示例一致） */
const ERB_DIALOGUE = '    PRINTFORMW 「……」';
/** `.kojo` 里的示例台词行（4 空格缩进） */
const KOJO_DIALOGUE = '    「……」';

function buildErbMerge(plan: FillColumnPlan, pack: FillPack, chara: FillChara): string[] {
  const out: string[] = [];
  const target = plan.target;
  out.push(`; ── 条件矩阵填空 · ${chara.name}（K${chara.no}） · ${plan.column.label} ──`);
  if (target) {
    out.push(`; 目标函数：@${target.name}`);
    out.push(`; 位置：${target.filePath}:${target.startLine}（本包已有该时机，请把下面的分支并入该函数）`);
  } else {
    out.push('; 本包在该时机只有 MESSAGECHECK 钩子，没有可并入的台词函数——请人工确认后再并入。');
  }
  if (pack.family) out.push(`; 家族段：${pack.family}`);
  out.push('');
  for (const row of plan.rows) {
    out.push(`; ${rowNote(row)}`);
    out.push(`IF ${sampleCondition(row)}`);
    out.push(ERB_DIALOGUE);
    out.push('ENDIF');
    out.push('');
  }
  return out;
}

function buildErbNew(
  plan: FillColumnPlan,
  pack: FillPack,
  chara: FillChara,
  note?: string,
): string[] {
  const out: string[] = [];
  const universe = plan.column.universeFunctions;
  const target = pickMergeTarget(universe);
  out.push(`; ── 条件矩阵填空 · ${chara.name}（K${chara.no}） · ${plan.column.label} ──`);
  out.push('; 本包在这个时机还没有函数——下面是一份完整骨架，填入台词即可。');
  if (pack.family) out.push(`; 家族段：${pack.family}`);
  if (note) out.push(note);
  out.push('');

  if (!target) {
    out.push('; ⚠ 没有可参照的函数命名（该列在全部口上包里都没有可解析的函数）。');
    out.push('; 请按本游戏的命名规范手写函数头；条件骨架如下：');
    out.push('');
    for (const row of plan.rows) {
      out.push(`; ${rowNote(row)}`);
      out.push(`IF ${sampleCondition(row)}`);
      out.push(ERB_DIALOGUE);
      out.push('ENDIF');
      out.push('');
    }
    return out;
  }

  const no = plan.column.instructionNo;
  const wrapper = universe.find(
    (fn) => !fn.isMessageCheck && no !== null && fn.slot === String(no),
  );
  const body = universe.find(
    (fn) => !fn.isMessageCheck && no !== null && fn.slot.startsWith(`${no}_`),
  );
  const primary = body ?? target;
  const primaryName = substituteFamily(primary.name, primary, pack.family) ?? primary.name;
  const wrapperName = wrapper ? substituteFamily(wrapper.name, wrapper, pack.family) ?? wrapper.name : null;

  if (wrapperName && primaryName !== wrapperName) {
    out.push(`@${wrapperName}`);
    out.push(`CALL ${primaryName}`);
    out.push('RETURN RESULT');
    out.push('');
  }
  out.push(`@${primaryName}`);
  out.push(';-------------------------------------------------');
  out.push(';記入チェック（=0, 非表示、1, 表示）');
  out.push('LOCAL = 1');
  out.push(';-------------------------------------------------');
  for (const row of plan.rows) {
    out.push(`; ${rowNote(row)}`);
    out.push(`IF ${sampleCondition(row)}`);
    out.push(ERB_DIALOGUE);
    out.push('ENDIF');
    out.push('');
  }
  out.push('RETURN 1');
  return out;
}

function buildKojoMerge(plan: FillColumnPlan, chara: FillChara): string[] {
  const out: string[] = [];
  const target = plan.target;
  out.push(`; ── 条件矩阵填空 · ${chara.name}（K${chara.no}） · ${plan.column.label} ──`);
  if (target) {
    out.push(`; 目标函数：@${target.name}`);
    out.push(`; 位置：${target.filePath}:${target.startLine}（本包已有该时机，请把下面的分支并入该函数）`);
  } else {
    out.push('; 本包在该时机只有 MESSAGECHECK 钩子，没有可并入的台词函数——请人工确认后再并入。');
  }
  out.push('');
  for (const row of plan.rows) {
    out.push(`; ${rowNote(row)}`);
    out.push(`    如果 ${sampleCondition(row)}：`);
    out.push(`        「……」`);
    out.push('');
  }
  return out;
}

function buildKojoNew(plan: FillColumnPlan, pack: FillPack, chara: FillChara, faceTable?: KojoFaceTable): string[] {
  const timing = resolveFaceTiming(faceTable, plan.column, plan.column.universeFunctions, chara.no);
  if (!timing) {
    return buildErbNew(
      plan,
      pack,
      chara,
      '; ⚠ 无法把该时机映射到语法糖分野——已退回原生 ERB 写法（.kojo 允许原生直通）。',
    );
  }
  const out: string[] = [];
  out.push(`; ── 条件矩阵填空 · ${chara.name}（K${chara.no}） · ${plan.column.label} ──`);
  out.push('; 本包在这个时机还没有函数——下面是一份完整骨架，填入台词即可。');
  if (pack.family) out.push(`; 家族段：${pack.family}（由糖文件头 / 登记声明决定）`);
  out.push('');
  out.push(kojoTimingHead(timing));
  for (const row of plan.rows) {
    out.push(`    ; ${rowNote(row)}`);
    out.push(`    如果 ${sampleCondition(row)}：`);
    out.push(`        「……」`);
  }
  return out;
}

/**
 * 生成填空代码。
 *
 * 列按矩阵列序、行按矩阵行序输出（确定性）；同一列的多行合成一个时机块 /
 * 一段并入片段。目标函数选择、条件示例、家族段替换都走上面的纯函数。
 */
export function buildFillPlan(opts: BuildFillPlanOptions): FillPlan {
  const { matrix, cells, language, pack, chara, faceTable, standalone = false } = opts;
  const rowByKey = new Map(matrix.rows.map((r) => [r.key, r]));
  const columnByKey = new Map(matrix.columns.map((c) => [c.key, c]));
  const byColumn = new Map<string, MatrixRow[]>();
  let skipped = 0;
  let skippedMerge = 0;
  for (const cell of cells) {
    const row = rowByKey.get(cell.rowKey);
    const column = columnByKey.get(cell.columnKey);
    if (!row || !column) {
      skipped++;
      continue;
    }
    // 目标包里这一格已经有响应 → 不是空缺；不拿「全包视图的缺口」去覆盖别人的函数
    if (row.cells[cell.columnKey]?.present) {
      skipped++;
      continue;
    }
    // 新文件装不下并入片段（片段没有函数体可落）；显式计数，由浮层提示改用追加
    if (standalone && column.functions.length > 0) {
      skipped++;
      skippedMerge++;
      continue;
    }
    const list = byColumn.get(cell.columnKey);
    if (list) list.push(row);
    else byColumn.set(cell.columnKey, [row]);
  }

  const plans: FillColumnPlan[] = [];
  for (const column of matrix.columns) {
    const rows = byColumn.get(column.key);
    if (!rows || rows.length === 0) continue;
    const target = pickMergeTarget(column.functions);
    plans.push({
      column,
      rows,
      mode: column.functions.length > 0 ? 'merge' : 'new',
      target,
    });
  }

  const chunks: string[][] = [];
  // 糖层靠文件头拿角色号与家族段（函数名里的 K{no} / {t} 由它渲染）；
  // 追加模式不补——既有文件已有文件头，重复声明只会制造两份真相。
  if (language === 'kojo' && standalone && plans.some((p) => p.mode === 'new')) {
    const familyHead = pack.family
      ? [`口上: ${pack.family}${pack.selector ? ` 选择器: ${pack.selector}` : ''}`]
      : [];
    chunks.push([`角色: ${chara.no}`, ...familyHead, '']);
  }
  for (const plan of plans) {
    if (language === 'erb') {
      chunks.push(
        plan.mode === 'merge'
          ? buildErbMerge(plan, pack, chara)
          : buildErbNew(plan, pack, chara),
      );
    } else {
      chunks.push(
        plan.mode === 'merge'
          ? buildKojoMerge(plan, chara)
          : buildKojoNew(plan, pack, chara, faceTable),
      );
    }
  }

  const code = chunks
    .map((lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd())
    .join('\n\n');

  let cellCount = 0;
  let mergeCount = 0;
  let newCount = 0;
  for (const plan of plans) {
    cellCount += plan.rows.length;
    if (plan.mode === 'merge') mergeCount++;
    else newCount++;
  }

  return { language, columns: plans, code, mergeCount, newCount, cellCount, skipped, skippedMerge };
}
