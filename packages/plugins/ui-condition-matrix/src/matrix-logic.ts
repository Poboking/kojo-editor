/**
 * 条件矩阵纯逻辑（零 React，可单测）。
 *
 * 数据模型：行 = 状态变量键（如 `CFLAG:318`，经变量字典给出人读标签），
 * 列 = 该角色的**时机面**（face；系统时机 + 作者自定指令/自定事件都以 face 呈现）。
 * 单元格 = 「该角色在该时机有函数响应了这个状态」——填色即存在响应，点击可跳源；
 * 空白 = 这个时机还没有针对该状态写过的反应。
 *
 * 归属规则：家族解析结果 `FamilyMatch.characterNo` 是唯一归属依据；无法归属的
 * 函数只计数不展开（与函数树导航同一口径）。所有聚合都是**单次全量遍历 + 分桶**，
 * 不解释任何游戏知识（面的语义排序与本插件自带的 `FACE_ORDER` 一份同口径）。
 */

import type {
  ErbIndex,
  FamilyIndexRule,
  FamilyMatch,
  FamilyParseKind,
  StateDependency,
} from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';

/* ------------------------------ 面语义排序 ------------------------------ */

/**
 * 面的语义顺序（与函数树导航同口径；本插件不得跨插件 import，故自带一份）。
 * 未列出的面排在最后按字母序，'' 归「其它」，declare 单独成面。
 */
export const FACE_ORDER: readonly string[] = [
  'FLAGSETTING',
  'ENCOUNTER',
  'CUSTOM_EVENT',
  'EVENT',
  'SPEVENT',
  'DAILY_EVENT',
  'CUSTOM_BUTTON_CONDITION',
  'CAN_COM',
  'COM_ABLE',
  'CUSTOM_BUTTON',
  'COM_NAME',
  'COMMAND',
  'COM',
  'SUCCESS',
  'SUCCESS_COM',
  'SUCCESS_SCOM',
  'MESSAGE',
  'MESSAGE_COM',
  'MESSAGE_SCOM',
  'MESSAGE_COUNTER',
  'MESSAGE_PALAMCNG',
  'MESSAGE_MARKCNG',
  'MESSAGE_ENDING',
  'MESSAGE_CUSTOM_COM',
  'MESSAGE_CUSTOM_SCOM',
  'EXTRASOURCE',
  'EXTRASOURCE_COM',
  'EXTRASOURCE_SCOM',
  'COLOR',
  'IMAGE',
  'IMAGE_EX',
  'SF_CONTRACT',
  'SF_CONTRACT_EVENT',
  'IRAI',
  'OPTION',
  'OPTION_EXIST',
  'VERSION_UPDATE',
  'UPDATE',
  'VERSION',
  'CUSTOM_TALENT_SET',
  'DIARY',
  'BEFORETRAIN',
  'declare',
];

/** 面排序键；未列入 → 大数（排最后） */
function faceRank(face: string): number {
  const i = FACE_ORDER.indexOf(face);
  return i >= 0 ? i : FACE_ORDER.length;
}

/* ------------------------------ 角色聚合 ------------------------------ */

/** 参与矩阵的函数（含其归属面与家族解析结果） */
export interface FaceFunction {
  readonly name: string;
  readonly normalizedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly face: string;
  readonly match: FamilyMatch;
}

/** 单个角色的聚合结果（面清单 + 全部归属函数） */
export interface CharacterEntry {
  readonly no: number;
  /** 该角色出现过的面（已按 FACE_ORDER 排序，未知面在后按字母序） */
  readonly faces: string[];
  readonly functions: FaceFunction[];
}

/** 全量角色索引（一次遍历同时给出角色选择列表与每人数据） */
export interface CharacterIndex {
  readonly entries: Map<number, CharacterEntry>;
  readonly hasFamilyIndex: boolean;
  readonly orphanCount: number;
  readonly totalFunctions: number;
}

function emptyIndex(hasFamilyIndex: boolean): CharacterIndex {
  return { entries: new Map(), hasFamilyIndex, orphanCount: 0, totalFunctions: 0 };
}

/**
 * 单次全量遍历：把 `ErbIndex` 按「角色 → 面 → 函数」聚合。
 *
 * 无法归属（无家族规则 / `characterNo === null`）的函数进 `orphanCount`，不展开。
 * 对缺字段的畸形输入宽容降级（返回空索引），绝不抛错中断。
 */
export function buildCharacterIndex(index: ErbIndex, familyIndex: FamilyIndexRule | null): CharacterIndex {
  const hasFamilyIndex = familyIndex !== null;
  const files = index?.files;
  if (!files) return emptyIndex(hasFamilyIndex);

  const acc = new Map<number, { faces: Set<string>; functions: FaceFunction[] }>();
  let orphanCount = 0;
  let totalFunctions = 0;

  for (const file of files.values()) {
    const fns = file?.functions;
    if (!fns) continue;
    for (const fn of fns) {
      if (!fn) continue;
      totalFunctions++;
      let match: FamilyMatch | null = null;
      try {
        // 附文件路径供适配器把占位符形态对齐到文件编号（additive；无家族规则时仍 null）
        match = familyIndex ? familyIndex.match(fn.normalizedName, fn.filePath) : null;
      } catch {
        match = null;
      }
      if (!match || match.characterNo === null) {
        orphanCount++;
        continue;
      }
      const face = match.kind === 'declare' ? 'declare' : match.face;
      let entry = acc.get(match.characterNo);
      if (!entry) {
        entry = { faces: new Set<string>(), functions: [] };
        acc.set(match.characterNo, entry);
      }
      entry.faces.add(face);
      entry.functions.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        face,
        match,
      });
    }
  }

  const entries = new Map<number, CharacterEntry>();
  for (const [no, e] of acc) {
    const faces = [...e.faces].sort((a, b) => faceRank(a) - faceRank(b) || a.localeCompare(b));
    entries.set(no, { no, faces, functions: e.functions });
  }

  return { entries, hasFamilyIndex, orphanCount, totalFunctions };
}

/* ------------------------------ 矩阵构建 ------------------------------ */

/** 单元格里的一条函数贡献 */
export interface MatrixCellFunction {
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  /** 该函数中针对本状态键的直接阈值比较（`op text` 形态） */
  readonly comparisons: string[];
  /** 家族段（标准口上为 ''；填空生成时据此换成本包的家族名） */
  readonly family: string;
  /** 前缀域（M_KOJO / KOJO / DIARY / RUN_INTO / ''） */
  readonly prefix: string;
  /** 解析形态（ok / declare / placeholder / kn / beforetrain） */
  readonly kind: FamilyParseKind;
  readonly face: string;
  /** K{no} 之后的时机号/子号（已去前导下划线） */
  readonly slot: string;
  readonly isMessageCheck: boolean;
}

/**
 * 矩阵列上的一条函数（**不含**状态比较——列是「时机」，函数本身属于哪一列
 * 与它响应了哪些状态无关）。`functions` = 本作用域（口上包）内的函数，
 * `universeFunctions` = 全角色的函数（无包作用域时两者同一批实例）。
 *
 * 填空生成需要两批：本包有没有函数决定「并入片段 vs 完整骨架」，
 * 全角色的函数用来在整列缺席时仍知道这个时机长什么样。
 */
export interface MatrixColumnFunction {
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly family: string;
  readonly prefix: string;
  readonly kind: FamilyParseKind;
  readonly face: string;
  readonly slot: string;
  readonly isMessageCheck: boolean;
}

function columnFunctionOf(fn: FaceFunction): MatrixColumnFunction {
  return {
    name: fn.name,
    filePath: fn.filePath,
    startLine: fn.startLine,
    family: fn.match.family,
    prefix: fn.match.prefix,
    kind: fn.match.kind,
    face: fn.match.face,
    slot: fn.match.slot,
    isMessageCheck: fn.match.isMessageCheck,
  };
}

/** 单元格：该角色在该时机是否有函数响应了这个状态 */
export interface MatrixCell {
  readonly present: boolean;
  /** 该时机下响应此状态的函数数 */
  readonly count: number;
  readonly functions: MatrixCellFunction[];
}

/** 矩阵一行（一个状态变量键） */
export interface MatrixRow {
  /** 规范化键（如 `CFLAG:318`） */
  readonly key: string;
  /** 变量名（大写，如 `CFLAG`） */
  readonly name: string;
  readonly indices: string[];
  /** 语义标签（变量字典提供；缺省 null = 无标签） */
  readonly label: string | null;
  /** 该状态在**当前作用域**（口上包）中被响应的总次数（= 各单元格 count 之和） */
  readonly totalCount: number;
  /** 当前作用域内的比较集合（去重、首见序） */
  readonly comparisons: string[];
  /** 全角色（不限口上包）的比较集合——空包的缺口行据此给出条件提示 */
  readonly universeComparisons: string[];
  /** 面 → 单元格（未命中的面直接从记录中缺席） */
  readonly cells: Record<string, MatrixCell>;
  /** 缺口格数 = 列总数 - 有响应的列数（按当前作用域） */
  readonly gapCount: number;
}

/** 矩阵一列（可细到「一个指令」；`instructionNo` = 该面的指令编号，无则 null） */
export interface MatrixColumn {
  /** 列键（唯一）：整面成列时 = face，细分为指令时 = `${face}#${no}` */
  readonly key: string;
  /** 归属面（大时机类） */
  readonly face: string;
  /** 列显示标签（细分时 = 指令中文名 / `#编号`，整面时 = 面标签） */
  readonly label: string;
  /** 指令编号（细分列才有；整面列 = null） */
  readonly instructionNo: number | null;
  /** 本作用域（口上包）内该列的函数（填空生成判断「并入 vs 新建」） */
  readonly functions: readonly MatrixColumnFunction[];
  /** 全角色该列的函数（本包整列缺席时仍知道这个时机的命名形态） */
  readonly universeFunctions: readonly MatrixColumnFunction[];
  /** 当前作用域内该列已填的格数 */
  readonly fillCount: number;
  /** 当前作用域内该列的缺口格数 = 行总数 - fillCount */
  readonly gapCount: number;
}

/** 列的时机分组（一个大时机类下的若干子列） */
export interface MatrixColumnGroup {
  readonly face: string;
  readonly label: string;
  readonly columns: MatrixColumn[];
}

/** 构建作用域（additive）：列/行取自「全角色」，填色取自当前口上包 */
export interface MatrixUniverse {
  /** 列集合的真源（缺省 = entry）——按包查看时传全角色，于是整列缺席也可见 */
  readonly columnsFrom?: CharacterEntry;
  /** 行集合的真源（缺省 = entry）——按包查看时传全角色，于是「别人写过、我没写」也成行 */
  readonly rowsFrom?: CharacterEntry;
}

/** 单个角色的条件矩阵 */
export interface ConditionMatrix {
  readonly charaNo: number;
  /** 扁平列表（按 groups 展平序；渲染序） */
  readonly columns: MatrixColumn[];
  /** 按大时机类聚合的分组（条件矩阵表头两行用；组内子列已定序） */
  readonly groups: MatrixColumnGroup[];
  readonly rows: MatrixRow[];
  readonly totalFunctions: number;
  /** 含 ≥1 状态依赖的函数数（分母口径） */
  readonly depsFunctions: number;
  /** 已填格数 / 总格数 / 缺口格数（当前作用域；面板状态条与剧情线快选用） */
  readonly filledCells: number;
  readonly totalCells: number;
  readonly gapCells: number;
}

/**
 * 取 `FamilyMatch.slot` 首位数字（= 指令承载面上的指令编号）。
 * `'88_1'` → 88、`'310'` → 310；无前导数字 → null（消费方据此整面成列，不猜）。
 */
export function instructionNoOfSlot(slot: string): number | null {
  const m = /^(\d+)/.exec(slot);
  return m ? Number(m[1]) : null;
}

/** 消费方对某函数的列描述（`columnOf` 回调返回；`label` 缺省 = 面标签） */
export interface ColumnDesc {
  readonly key: string;
  readonly instructionNo: number | null;
  readonly label?: string;
}

/** 构建期可变中间体（最终以只读形态对外） */
type MutableCell = { present: boolean; count: number; functions: MatrixCellFunction[] };
type RowAcc = {
  key: string;
  name: string;
  indices: string[];
  label: string | null;
  totalCount: number;
  comparisons: string[];
  seen: Set<string>;
  universeComparisons: string[];
  universeSeen: Set<string>;
  cells: Record<string, MutableCell>;
  /** 已响应列数（免去逐行 `Object.keys(cells).length` 的数组分配） */
  filled: number;
};
type ColumnAcc = {
  key: string;
  face: string;
  instructionNo: number | null;
  label: string;
  functions: MatrixColumnFunction[];
  universeFunctions: MatrixColumnFunction[];
};

/** 组内子列定序：`instructionNo` 升序（无编号排最后），同号按 `key` 定序。 */
function compareColumn(
  a: { readonly instructionNo: number | null; readonly key: string },
  b: { readonly instructionNo: number | null; readonly key: string },
): number {
  const an = a.instructionNo;
  const bn = b.instructionNo;
  if (an === null && bn !== null) return 1;
  if (an !== null && bn === null) return -1;
  if (an !== null && bn !== null && an !== bn) return an - bn;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

/**
 * 从单个角色的聚合构建矩阵。
 *
 * - 列集合来自 `columnEntry.functions`（缺省 = `entry`）**全量**（凡写过的面/指令
 *   都成列），经 `columnOf` 解析成列描述；`columnOf` 缺省 = 每个面一列；
 * - 行集合来自 `rowEntry.functions`（缺省 = `entry`）。按口上包查看时，行/列都传
 *   全角色、只有 `entry` 是单包——于是「别的包写过、这个包没写」也会成为可见缺口；
 * - 面顺序沿用 `FACE_ORDER`/`faceRank`，组内子列按 `instructionNo` 升序；
 * - 行 = 按 `dep.key` 聚合的状态变量；`cells[列键]` 记一次响应（count+1，
 *   并压入该函数的贡献条目）；
 * - 行序：当前作用域 `totalCount` 降序，同数按 `key` 升序（确定性）；
 * - 未命中的单元格直接从 `cells` 记录中缺席（面板按 off 渲染）。
 *
 * `depsOf`/`labelOf` 由调用方注入（本纯逻辑不认识抽取服务与变量字典）；对二者抛错
 * 宽容降级，绝不中断。
 */
export function buildMatrix(
  entry: CharacterEntry,
  depsOf: (normalizedName: string) => StateDependency[],
  labelOf: (key: string) => string | null,
  faceLabels?: Readonly<Record<string, string>>,
  columnOf?: (fn: FaceFunction) => ColumnDesc,
  universe?: MatrixUniverse,
): ConditionMatrix {
  const resolveColumn =
    columnOf ?? ((fn: FaceFunction): ColumnDesc => ({ key: fn.face, instructionNo: null }));
  const columnEntry = universe?.columnsFrom ?? entry;
  const rowEntry = universe?.rowsFrom ?? entry;

  // ---- 列聚合（列集合的真源 = columnEntry）----
  // 同时缓存每个函数的列键——第二轮聚合单元格时直接取用，`columnOf` 只解析一次。
  const byFace = new Map<string, Map<string, ColumnAcc>>();
  const colDescOf = new Map<FaceFunction, ColumnDesc>();
  /** 列函数对象缓存：作用域模式下同一函数会出现在 universe 与包两批里，对象只造一次 */
  const colFnOf = new Map<FaceFunction, MatrixColumnFunction>();
  const columnFn = (fn: FaceFunction): MatrixColumnFunction => {
    let out = colFnOf.get(fn);
    if (!out) {
      out = columnFunctionOf(fn);
      colFnOf.set(fn, out);
    }
    return out;
  };
  const scopedColumns = columnEntry !== entry;
  const accOf = (fn: FaceFunction): ColumnAcc => {
    let desc = colDescOf.get(fn);
    if (!desc) {
      desc = resolveColumn(fn);
      colDescOf.set(fn, desc);
    }
    let cols = byFace.get(fn.face);
    if (!cols) {
      cols = new Map<string, ColumnAcc>();
      byFace.set(fn.face, cols);
    }
    let col = cols.get(desc.key);
    if (!col) {
      col = {
        key: desc.key,
        face: fn.face,
        instructionNo: desc.instructionNo,
        label: desc.label ?? faceLabel(fn.face, faceLabels),
        functions: [],
        universeFunctions: [],
      };
      cols.set(desc.key, col);
    }
    return col;
  };

  for (const fn of columnEntry.functions) {
    accOf(fn).universeFunctions.push(columnFn(fn));
  }

  const groupsAcc = [...byFace.entries()]
    .map(([face, cols]) => ({
      face,
      label: faceLabel(face, faceLabels),
      columns: [...cols.values()].sort(compareColumn),
    }))
    .sort((a, b) => faceRank(a.face) - faceRank(b.face) || a.face.localeCompare(b.face));
  const columnKeyOfFace = groupsAcc;
  const columnCount = columnKeyOfFace.reduce((n, g) => n + g.columns.length, 0);

  // ---- 行聚合（行集合的真源 = rowEntry；填色只来自 entry）----
  const acc = new Map<string, RowAcc>();
  const depsCache = new Map<string, StateDependency[]>();
  const depsFor = (fn: FaceFunction): StateDependency[] => {
    const hit = depsCache.get(fn.normalizedName);
    if (hit) return hit;
    let deps: StateDependency[] = [];
    try {
      deps = depsOf(fn.normalizedName) ?? [];
    } catch {
      deps = [];
    }
    depsCache.set(fn.normalizedName, deps);
    return deps;
  };

  const ensureRow = (dep: StateDependency): RowAcc => {
    let row = acc.get(dep.key);
    if (row) return row;
    let label: string | null = null;
    try {
      label = labelOf(dep.key);
    } catch {
      label = null;
    }
    row = {
      key: dep.key,
      name: dep.name,
      indices: dep.indices,
      label,
      totalCount: 0,
      comparisons: [],
      seen: new Set<string>(),
      universeComparisons: [],
      universeSeen: new Set<string>(),
      cells: {},
      filled: 0,
    };
    acc.set(dep.key, row);
    return row;
  };

  // 先按全角色播种行（含「这个包没写过」的状态键）——只在 rowEntry 与 entry 不同时做，
  // 否则下面的填色循环本来就会建出同一批行。
  if (rowEntry !== entry) {
    for (const fn of rowEntry.functions) {
      for (const dep of depsFor(fn)) {
        if (!dep) continue;
        const row = ensureRow(dep);
        for (const s of (dep.comparisons ?? []).map((c) => `${c.op} ${c.text}`)) {
          if (!row.universeSeen.has(s)) {
            row.universeSeen.add(s);
            row.universeComparisons.push(s);
          }
        }
      }
    }
  }

  const columnFills = new Map<string, number>();
  let depsFunctions = 0;

  for (const fn of entry.functions) {
    const deps = depsFor(fn);
    if (deps.length > 0) depsFunctions++;

    const col = accOf(fn);
    // 无作用域时 `functions` 与 `universeFunctions` 收口为同一数组，这里不必重复收
    if (scopedColumns) col.functions.push(columnFn(fn));

    for (const dep of deps) {
      if (!dep) continue;
      const row = ensureRow(dep);
      const comps = (dep.comparisons ?? []).map((c) => `${c.op} ${c.text}`);

      let cell = row.cells[col.key];
      if (!cell) {
        cell = { present: true, count: 0, functions: [] };
        row.cells[col.key] = cell;
        row.filled += 1;
        columnFills.set(col.key, (columnFills.get(col.key) ?? 0) + 1);
      }
      cell.count += 1;
      cell.functions.push({
        name: fn.name,
        filePath: fn.filePath,
        startLine: fn.startLine,
        comparisons: comps,
        family: fn.match.family,
        prefix: fn.match.prefix,
        kind: fn.match.kind,
        face: fn.match.face,
        slot: fn.match.slot,
        isMessageCheck: fn.match.isMessageCheck,
      });
      row.totalCount += 1;

      for (const s of comps) {
        if (!row.seen.has(s)) {
          row.seen.add(s);
          row.comparisons.push(s);
        }
        if (!row.universeSeen.has(s)) {
          row.universeSeen.add(s);
          row.universeComparisons.push(s);
        }
      }
    }
  }

  const rows: MatrixRow[] = [...acc.values()].map((r) => ({
    key: r.key,
    name: r.name,
    indices: r.indices,
    label: r.label,
    totalCount: r.totalCount,
    comparisons: r.comparisons,
    universeComparisons: r.universeComparisons,
    cells: r.cells,
    gapCount: columnCount - r.filled,
  }));

  rows.sort((a, b) => {
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  // ---- 收口：列统计（行总数已定）+ 只读形态 ----
  // 无作用域时包函数与全角色函数是同一批：共享同一个数组实例，省一份引用。
  const shared = columnEntry === entry;
  const groups: MatrixColumnGroup[] = groupsAcc.map((g) => ({
    face: g.face,
    label: g.label,
    columns: g.columns.map((c) => {
      const fillCount = columnFills.get(c.key) ?? 0;
      return {
        key: c.key,
        face: c.face,
        instructionNo: c.instructionNo,
        label: c.label,
        functions: shared ? c.universeFunctions : c.functions,
        universeFunctions: c.universeFunctions,
        fillCount,
        gapCount: rows.length - fillCount,
      };
    }),
  }));
  const columns: MatrixColumn[] = groups.flatMap((g) => g.columns);
  const filledCells = columns.reduce((n, c) => n + c.fillCount, 0);

  return {
    charaNo: entry.no,
    columns,
    groups,
    rows,
    totalFunctions: entry.functions.length,
    depsFunctions,
    filledCells,
    totalCells: rows.length * columns.length,
    gapCells: Math.max(0, rows.length * columns.length - filledCells),
  };
}

/* ------------------------------ 渲染记忆化 ------------------------------ */

/**
 * 矩阵结果记忆化（纯逻辑，单测钉住）：key 相同直接返回缓存，避免「选择 / 过滤 / 折叠 /
 * 外部刷新」等**不改变数据**的重渲重复整表重算（角色函数多时，每次选择都要全量遍历一遍）。
 *
 * key 由调用方拼（本模块不认识角色号 / 依赖版本）：约定为 `${角色号}|${依赖版本}|${适配器}`；
 * 依赖版本（抽取索引代次）一变即换 key，旧条目随容量上限淘汰——上限兜住内存，来回切角色
 * 也不至于把大矩阵反复重算。
 */
export interface MatrixMemo {
  resolve(key: string, build: () => ConditionMatrix): ConditionMatrix;
  clear(): void;
}

export function createMatrixMemo(capacity = 8): MatrixMemo {
  const cache = new Map<string, ConditionMatrix>();
  return {
    resolve(key, build) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const value = build();
      cache.set(key, value);
      if (cache.size > capacity) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    },
    clear() {
      cache.clear();
    },
  };
}

/* ------------------------------ 分隔线钳制 ------------------------------ */

/** 详情区最小高度（拖到极限也要留住：至少几行 + 空态提示） */
export const DETAIL_MIN_H = 96;
/** 拖拽时给网格区保留的最小可视高度（工具条 / 状态条 + 若干行都在里面） */
export const GRID_MIN_RESERVE = 160;

/**
 * 网格区 ←→ 详情区拖拽分隔线的钳制（纯函数，单测钉住）：下限兜住详情区、
 * 上限 = 面板可视高度 - 网格区保留高度——两区都不能被拖没。
 *
 * panelHeight 未知（≤0 / 非有限值，如无 DOM 环境）时钳到下限——宁可不拖，也不把两区
 * 挤没（与 eratw-adapter 的 `clampTutorialHeight` 同口径）。
 */
export function clampDetailHeight(height: number, panelHeight: number): number {
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return DETAIL_MIN_H;
  const max = Math.max(DETAIL_MIN_H, panelHeight - GRID_MIN_RESERVE);
  return Math.min(max, Math.max(DETAIL_MIN_H, height));
}

/* ------------------------------ 行头列宽钳制 ------------------------------ */

/** 首列（「状态 \ 时机」行头）最小宽度：拖到极限也留住标签首段 */
export const ROWHEAD_MIN_W = 72;
/** 首列最大宽度：占屏过半即无意义（与 `.cm-subth` 的 110px 上限同族，取保守常量） */
export const ROWHEAD_MAX_W = 360;

/**
 * 首列列宽拖拽的钳制（纯函数，单测钉住）：落在 [下限, 上限] 内，非有限值
 * （无 DOM 环境 / 度量失败）→ 回落下限——宁可不拖，也不把首列挤没。
 */
export function clampRowheadWidth(width: number): number {
  if (!Number.isFinite(width)) return ROWHEAD_MIN_W;
  return Math.min(ROWHEAD_MAX_W, Math.max(ROWHEAD_MIN_W, Math.round(width)));
}

/* ------------------------------ 视口化窗口数学 ------------------------------ */

/**
 * 视口化路径的**兜底行高**（px）——只在量不到真实行高时使用（SSR / 首帧 / 隐藏态）。
 *
 * 22 = 单元格（20px 方钮）+ 行单元格上下各 1px 内边距。
 *
 * ⚠ 这个名字过去是**唯一**行高真源，窗口数学与 CSS 变量都由它算，于是字号 / 缩放偏好一改，
 * 占位块与真实行就错位（滚到第 100 行、画出来的却是第 109 行）。PS-7 起它只是回退值：
 * 真源是**实测行高**（面板用 ResizeObserver 量首行，经 `resolveRowHeight` 收敛）。
 */
export const MATRIX_ROW_H = 22;

/** 窗口上下各预留的缓冲行数（滚出即撤、滚入即建；过量只多画几行，不重复计数） */
export const MATRIX_OVERSCAN = 8;

/** 实测行高合法域（px）：低于下限 = 没布局出来（量到 0），高于上限 = 量到的不是「一行」 */
export const ROW_H_MIN = 8;
export const ROW_H_MAX = 200;

/**
 * 把**实测**行高收敛成窗口数学可用的值（纯函数，单测钉住）。
 *
 * `null` / `undefined` / 非有限值 / 低于下限（节点还没布局、面板被隐藏）→ 回落 `fallback`
 * （= `MATRIX_ROW_H`，改动前行为，宁可不准也不炸）；超过上限（一次量到整块 / tbody）→ 钳到上限。
 * 不四舍五入到整数：字号缩放后的行高本来就是半像素，取整会把漂移重新请回来。
 */
export function resolveRowHeight(measured: number | null | undefined, fallback: number = MATRIX_ROW_H): number {
  if (measured === null || measured === undefined) return fallback;
  if (!Number.isFinite(measured) || measured < ROW_H_MIN) return fallback;
  return Math.min(ROW_H_MAX, measured);
}

/**
 * 行高是否已经**偏离兜底值**到必须重画（纯函数，单测钉住）。
 *
 * 亚像素抖动（0.3px）不该惊动 React：滚动容器每帧都可能回一个略有差异的读数，
 * 每记差异都抬一次 state 就等于每帧一次全表重渲。阈值给 0.5px——够抓住字号档位
 * 带来的整像素变化（行高 22 → 26 必须跟上），又滤掉布局取整的噪声。
 */
export function rowHeightChanged(prev: number | null, next: number, threshold = 0.5): boolean {
  if (prev === null) return true;
  return Math.abs(prev - next) > threshold;
}

/** 视口化窗口 + 该行高下每行的几何（一个算式产两样，杜绝窗口与占位各抄一个行高） */
export interface MatrixLayout {
  readonly win: ViewportWindow;
  /** 本次窗口实际采用的行高（实测收敛后的值） */
  readonly rowHeight: number;
}

/**
 * 面板的**唯一**视口化布局入口（纯函数，单测钉住）：收敛实测行高 → 算窗口。
 *
 * 存在的理由：窗口起点、占位高、键盘跨窗跳转三处都按同一个行高走，
 * 少一处传实测值就是「滚到 A 行、画的是 B 行」的错位（PS-7 修的就是这个）。
 */
export function planMatrixWindow(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  measuredRowHeight: number | null | undefined,
  overscan: number = MATRIX_OVERSCAN,
): MatrixLayout {
  const rowHeight = resolveRowHeight(measuredRowHeight);
  return {
    win: computeViewportWindow(scrollTop, viewportHeight, rowHeight, totalRows, overscan),
    rowHeight,
  };
}

/** 第 `index` 行内容顶边在滚动内容里的偏移（px）——占位块与真实行必须共用这一条算式 */
export function rowTopOf(layout: MatrixLayout, index: number): number {
  return layout.win.topPad + (index - layout.win.start) * layout.rowHeight;
}

/** 把第 `index` 行滚到视口上沿所需的 scrollTop（键盘跨窗导航用；行高与窗口数学同源） */
export function rowScrollTop(layout: MatrixLayout, index: number): number {
  return index * layout.rowHeight;
}

/** 滚动位置对应的顶行索引（实测行高下的判据：滚动条落在哪一行） */
export function firstVisibleRow(scrollTop: number, rowHeight: number): number {
  if (!(rowHeight > 0)) return 0;
  const scroll = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  return Math.floor(scroll / rowHeight);
}

/* ------------------------------ 角色清单（全部角色） ------------------------------ */

/** 角色搜索器的一项（`count` = 该角色的口上函数数；0 = 还没有口上） */
export interface CharaOption {
  readonly no: number;
  readonly name: string;
  readonly count: number;
}

/**
 * 角色清单 = 游戏角色表 ∪ 已有函数的角色，按编号升序。
 *
 * 游戏角色表是**全集**：0 函数的角色也要出现在搜索器里（「还没有口上」本身就是
 * 最大的缺口，旧实现只从函数索引反推角色，等于把从未写过口上的角色藏起来）。
 * 索引里多出来的编号（CSV 没登记但确有函数）也一个不漏。
 */
export function buildCharaOptions(
  charas: Iterable<{ readonly no: number; readonly name: string }>,
  functions: Iterable<{ readonly no: number; readonly count: number }>,
): CharaOption[] {
  const byNo = new Map<number, CharaOption>();
  for (const c of charas) byNo.set(c.no, { no: c.no, name: c.name, count: 0 });
  for (const f of functions) {
    const base = byNo.get(f.no);
    byNo.set(f.no, { no: f.no, name: base?.name ?? '', count: f.count });
  }
  return [...byNo.values()].sort((a, b) => a.no - b.no);
}

/* ------------------------------ 渲染策略（自动视口化） ------------------------------ */

/**
 * 自动视口化阈值（角色函数数）：达到即只渲染可见窗口。
 *
 * 函数数大 ⇒ 行/列都可能上千，一张表动辄 1–2 万个 DOM 格。视口化是**面板自己的
 * 渲染策略**（不隐藏数据：滚到哪画到哪，滚动条与键盘仍覆盖全部行），所以不必等
 * 用户先去设置页打开全局开关；小角色仍走全量路径，避免窗口计算的反向开销。
 */
export const AUTO_VIRTUALIZE_FUNCTIONS = 48;
/** 粗估格数阈值：宽表（面多）即使函数不多也可能铺出几千格 */
export const AUTO_VIRTUALIZE_CELLS = 3000;

/**
 * 是否走视口化：宿主偏好开 → 恒开；否则按角色函数数 / 面数粗估，大矩阵自动开。
 * 纯函数（单测钉阈值），面板只在渲染期读它，不改数据面口径。
 */
export function shouldVirtualizeMatrix(
  functionCount: number,
  faceCount: number,
  pref: boolean,
): boolean {
  if (pref) return true;
  return functionCount >= AUTO_VIRTUALIZE_FUNCTIONS || functionCount * faceCount >= AUTO_VIRTUALIZE_CELLS;
}

/** 视口化窗口：要渲染的行区间 + 上下占位块高度（撑出完整滚动高度） */
export interface ViewportWindow {
  /** 起始行索引（含） */
  readonly start: number;
  /** 结束行索引（不含） */
  readonly end: number;
  /** 顶部占位块高度（px）= `start * rowHeight` */
  readonly topPad: number;
  /** 底部占位块高度（px）= `(totalRows - end) * rowHeight` */
  readonly bottomPad: number;
}

/**
 * 由滚动位置算出视口窗口（纯函数，单测钉住）。
 *
 * 两端**钳制**：`start` 不越出 `[0, totalRows]`、`end` 不越出 `[0, totalRows]` 且
 * `end >= start`；滚到顶 `topPad === 0`、滚到底 `bottomPad === 0`；`totalRows <= 0`
 * 或行高非法 → 空窗口（全 0，不炸）；`overscan` 大于总数也不会重复计数
 * （`end` 被钳到 `totalRows`）。占位高按行高等比还原，故滚动条长度与「全部行都渲染」
 * 时一致。
 */
export function computeViewportWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  totalRows: number,
  overscan: number,
): ViewportWindow {
  if (!(totalRows > 0) || !(rowHeight > 0)) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  }
  const scroll = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const view = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  const over = Number.isFinite(overscan) && overscan > 0 ? Math.floor(overscan) : 0;

  const firstVisible = Math.floor(scroll / rowHeight);
  const visibleCount = Math.ceil(view / rowHeight);

  let start = firstVisible - over;
  let end = firstVisible + visibleCount + over;
  if (start < 0) start = 0;
  if (start > totalRows) start = totalRows;
  if (end > totalRows) end = totalRows;
  if (end < start) end = start;

  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: (totalRows - end) * rowHeight,
  };
}

/* ------------------------------ 反向光标联动（C1） ------------------------------ */

/** 光标位点（`editor.cursorMoved` 载荷的消费形状；本模块只关心 文件 + 行 + 是否派生视图） */
export interface CursorSight {
  readonly filePath: string | null;
  readonly line: number;
  readonly derivedView: boolean;
}

/**
 * 行 → 函数判据所需的形状：`ErbFunction` / `FunctionPredicates` 的公共子集（区间三件套 + 路径）。
 *
 * 光标路径上只能同步取数据：`FunctionConditions` 没有 endLine、`functionPredicates`
 * 是按名现拉的异步明细（读盘）——都不可用；`erb.parser` 当前索引的逐文件函数表
 * 本身就是这套区间的真源（谓词明细的 startLine/endLine 正取自它）。
 */
export interface FunctionRange {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * 光标位点 → 所在函数（区间包含，**最紧一层**）。
 *
 * 判据与宿主 `jump-to-state.ts` 的 `functionNameAt` 同思路（同一套折法不建第二套口径），
 * 但数据在面板侧取，不 import app 包。三态一律 `null` = 清高亮（"没有"，不是错误）：
 * 无位点 / 无文件 / **派生视图**（行号不属于真文件）；区间命中多个取最紧，
 * 同宽取靠后定义（确定性）。filePath 判等走 `pathKey`（折叠大小写与分隔符）。
 */
export function functionRangeAt(
  functions: readonly FunctionRange[],
  sight: CursorSight | null,
): FunctionRange | null {
  if (!sight || sight.filePath === null || sight.derivedView) return null;
  const key = pathKey(sight.filePath);
  const span = (f: FunctionRange): number => f.endLine - f.startLine;
  let best: FunctionRange | null = null;
  for (const fn of functions) {
    if (pathKey(fn.filePath) !== key) continue;
    if (fn.startLine > sight.line || sight.line > fn.endLine) continue;
    if (!best || span(fn) < span(best) || (span(fn) === span(best) && fn.startLine > best.startLine)) best = fn;
  }
  return best;
}

/**
 * 命中函数在矩阵里**确实由它贡献**的单元格集合（行键 → 列键）。
 *
 * 高亮必须落在"这个格子真的包含这个函数"上：函数与单元格的对应关系以
 * `MatrixCellFunction`（name + filePath + startLine）为准，与 `buildMatrix` 同源，
 * 不另立"函数 → 列"的推导（那是第二套判据 = 漂移源）。光标函数不在当前矩阵
 * （选了别的角色 / 未归属）→ 空集合 = 不高亮（静默，这是"没有"）。
 */
export function cellKeysOfFunction(
  matrix: ConditionMatrix,
  fn: { readonly filePath: string; readonly startLine: number },
): Map<string, string> {
  const out = new Map<string, string>();
  const key = pathKey(fn.filePath);
  for (const row of matrix.rows) {
    for (const colKey of Object.keys(row.cells)) {
      const cell = row.cells[colKey];
      if (!cell) continue;
      if (cell.functions.some((f) => f.startLine === fn.startLine && pathKey(f.filePath) === key)) {
        out.set(row.key, colKey);
        break; // 一个函数只贡献一格（一行一列）
      }
    }
  }
  return out;
}

/* ------------------------------ 标签 ------------------------------ */

/**
 * '' → '其它'；'declare' → '家族声明'；其余查 `labels`（适配器提供的面 → 中文），
 * 未收录 / 未注入则原样显示面 token（fail-visible，不猜）。
 */
export function faceLabel(face: string, labels?: Readonly<Record<string, string>>): string {
  switch (face) {
    case '':
      return '其它';
    case 'declare':
      return '家族声明';
    default:
      return labels?.[face] ?? face;
  }
}
