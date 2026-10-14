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

import type { ErbIndex, FamilyIndexRule, FamilyMatch, StateDependency } from '@kojo/plugin-api';

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
        match = familyIndex ? familyIndex.match(fn.normalizedName) : null;
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
  /** 该状态在全角色函数中被响应的总次数（= 各单元格 count 之和） */
  readonly totalCount: number;
  /** 全行比较集合（去重、首见序） */
  readonly comparisons: string[];
  /** 面 → 单元格（未命中的面直接从记录中缺席） */
  readonly cells: Record<string, MatrixCell>;
}

/** 矩阵一列（一个时机面） */
export interface MatrixColumn {
  readonly face: string;
  readonly label: string;
}

/** 单个角色的条件矩阵 */
export interface ConditionMatrix {
  readonly charaNo: number;
  readonly columns: MatrixColumn[];
  readonly rows: MatrixRow[];
  readonly totalFunctions: number;
  /** 含 ≥1 状态依赖的函数数（分母口径） */
  readonly depsFunctions: number;
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
  cells: Record<string, MutableCell>;
};

/**
 * 从单个角色的聚合构建矩阵。
 *
 * - 列 = `entry.faces`；
 * - 行 = 按 `dep.key` 聚合的状态变量；`cells[fn.face]` 记一次响应（count+1，
 *   并压入该函数的贡献条目）；
 * - 行序：`totalCount` 降序，同数按 `key` 升序（确定性）；
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
): ConditionMatrix {
  const columns: MatrixColumn[] = entry.faces.map((face) => ({ face, label: faceLabel(face, faceLabels) }));
  const acc = new Map<string, RowAcc>();
  let depsFunctions = 0;

  for (const fn of entry.functions) {
    let deps: StateDependency[] = [];
    try {
      deps = depsOf(fn.normalizedName) ?? [];
    } catch {
      deps = [];
    }
    if (deps.length > 0) depsFunctions++;

    for (const dep of deps) {
      if (!dep) continue;
      let row = acc.get(dep.key);
      if (!row) {
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
          cells: {},
        };
        acc.set(dep.key, row);
      }

      const comps = (dep.comparisons ?? []).map((c) => `${c.op} ${c.text}`);
      let cell = row.cells[fn.face];
      if (!cell) {
        cell = { present: true, count: 0, functions: [] };
        row.cells[fn.face] = cell;
      }
      cell.count += 1;
      cell.functions.push({
        name: fn.name,
        filePath: fn.filePath,
        startLine: fn.startLine,
        comparisons: comps,
      });
      row.totalCount += 1;

      for (const s of comps) {
        if (!row.seen.has(s)) {
          row.seen.add(s);
          row.comparisons.push(s);
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
    cells: r.cells,
  }));

  rows.sort((a, b) => {
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  return {
    charaNo: entry.no,
    columns,
    rows,
    totalFunctions: entry.functions.length,
    depsFunctions,
  };
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
