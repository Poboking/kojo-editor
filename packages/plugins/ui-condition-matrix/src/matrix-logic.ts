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
  ConditionComparison,
  ErbFile,
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
 * 单文件的归属事实（按 `ErbFile` **对象身份**缓存）。
 *
 * 为什么按身份就够：`erb.parser` 的增量索引（`applyIndexDelta`）只替换**变过**的文件的
 * `ErbFile`，其余条目原样留用（对象别名、零拷贝）。所以「保存一份文件」之后，只有那一份的
 * 身份变了——按文件缓存就能把「12 万函数 × 适配器 match」从**每次保存都付**降到
 * 「只有变过的文件付」。
 *
 * 为什么这笔钱值得省：实测 124,724 函数 / 4,385 文件的全量聚合 **362ms**（冷）/
 * **89ms**（memo 命中后的纯遍历），而**关掉家族规则**（全部记成孤儿）同一份输入只要
 * **2ms** —— 97% 的时间花在适配器的 `match()` 上（名字解析 + 每个调用一次
 * `name\0path` 拼接的 memo 键）。聚合本身是零成本的，重的是逐函数的判定。
 */
interface FileFacts {
  /** 判定时用的家族规则实例：换了规则（切适配器）⇒ 整份重算，绝不串味 */
  readonly family: FamilyIndexRule | null;
  readonly totalFunctions: number;
  readonly orphanCount: number;
  readonly byChara: readonly {
    readonly no: number;
    readonly faces: readonly string[];
    readonly fns: readonly FaceFunction[];
  }[];
}

const FILE_FACTS = new WeakMap<ErbFile, FileFacts>();

/** 单个文件的「角色 → 面 + 函数」事实（纯函数；对缺字段的畸形输入宽容降级） */
function factsOfFile(file: ErbFile, familyIndex: FamilyIndexRule | null): FileFacts {
  const byNo = new Map<number, { faces: string[]; fns: FaceFunction[] }>();
  let totalFunctions = 0;
  let orphanCount = 0;
  const fns = file?.functions;
  if (fns) {
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
      let rec = byNo.get(match.characterNo);
      if (!rec) {
        rec = { faces: [], fns: [] };
        byNo.set(match.characterNo, rec);
      }
      if (!rec.faces.includes(face)) rec.faces.push(face);
      rec.fns.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        face,
        match,
      });
    }
  }
  const byChara: { no: number; faces: readonly string[]; fns: readonly FaceFunction[] }[] = [];
  for (const [no, rec] of byNo) byChara.push({ no, faces: rec.faces, fns: rec.fns });
  return { family: familyIndex, totalFunctions, orphanCount, byChara };
}

/**
 * 角色 → 函数聚合的**来源文件**（按 `CharacterEntry` 身份，供 `depsFingerprint` 判「这一份
 * 聚合有没有变」）。聚合对象每轮重建即换身份，WeakMap 条目随之退休——不累积。
 */
const ENTRY_SOURCES = new WeakMap<CharacterEntry, readonly ErbFile[]>();

/**
 * 单次全量遍历：把 `ErbIndex` 按「角色 → 面 → 函数」聚合。
 *
 * 无法归属（无家族规则 / `characterNo === null`）的函数进 `orphanCount`，不展开。
 * 对缺字段的畸形输入宽容降级（返回空索引），绝不抛错中断。
 *
 * **增量口径**：逐文件判定走 `FILE_FACTS` 缓存（键 = `ErbFile` 身份），聚合本身只是把
 * 缓存好的函数数组按角色拼接——保存一份文件之后，这一趟只对那一份文件付 `match()`。
 * 语义与「每次都全量重判」逐字相同（缓存键含家族规则实例）。
 */
export function buildCharacterIndex(index: ErbIndex, familyIndex: FamilyIndexRule | null): CharacterIndex {
  const hasFamilyIndex = familyIndex !== null;
  const files = index?.files;
  if (!files) return emptyIndex(hasFamilyIndex);

  const buckets = new Map<number, { faces: Set<string>; parts: FaceFunction[][]; files: ErbFile[] }>();
  let orphanCount = 0;
  let totalFunctions = 0;

  for (const file of files.values()) {
    if (!file) continue;
    let facts = FILE_FACTS.get(file);
    if (!facts || facts.family !== familyIndex) {
      facts = factsOfFile(file, familyIndex);
      FILE_FACTS.set(file, facts);
    }
    totalFunctions += facts.totalFunctions;
    orphanCount += facts.orphanCount;
    for (const part of facts.byChara) {
      let bucket = buckets.get(part.no);
      if (!bucket) {
        bucket = { faces: new Set<string>(), parts: [], files: [] };
        buckets.set(part.no, bucket);
      }
      for (const face of part.faces) bucket.faces.add(face);
      bucket.parts.push(part.fns as FaceFunction[]);
      bucket.files.push(file);
    }
  }

  const entries = new Map<number, CharacterEntry>();
  for (const [no, bucket] of buckets) {
    // 拼一份**新数组**：缓存里的那份是共享只读事实，绝不能把它的身份交给消费方去改
    const functions: FaceFunction[] =
      bucket.parts.length === 1 ? bucket.parts[0]!.slice() : ([] as FaceFunction[]).concat(...bucket.parts);
    const faces = [...bucket.faces].sort((a, b) => faceRank(a) - faceRank(b) || a.localeCompare(b));
    const entry: CharacterEntry = { no, faces, functions };
    ENTRY_SOURCES.set(entry, bucket.files);
    entries.set(no, entry);
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

/* --------------------- 比较串缓存（建表热路径的唯一派生件） --------------------- */

/**
 * 依赖 → `'op text'` 比较串的缓存（键 = `StateDependency` **对象身份**）。
 *
 * 抽取索引里的依赖对象在一次抽取内是稳定的（重抽换新对象），比较串又是它的纯函数，
 * 所以同一份依赖只该格式化一次。真实语料上「函数 × 依赖」有 **70,699 对**，而独立依赖
 * 只有几千条——原实现每对都 `map()` 出一只新数组、逐条拼字符串，是建表最大的分配来源。
 *
 * `src` 记下当时的 `comparisons` 数组身份：万一有实现原地换掉它（约定上不该有），
 * 身份不等就重算，缓存绝不把旧判定漏进新数据。
 */
const COMPS_CACHE = new WeakMap<
  StateDependency,
  { readonly src: readonly ConditionComparison[] | undefined; readonly out: string[] }
>();

function compsOf(dep: StateDependency): string[] {
  const cached = COMPS_CACHE.get(dep);
  if (cached !== undefined && cached.src === dep.comparisons) return cached.out;
  const src = dep.comparisons ?? [];
  const out = new Array<string>(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    out[i] = `${c.op} ${c.text}`;
  }
  COMPS_CACHE.set(dep, { src: dep.comparisons, out });
  return out;
}

/**
 * 一个函数的依赖数组 → 逐条比较串（外层按**数组身份**缓存）。
 *
 * 为什么再套一层：单次建表有 7 万次「函数 × 依赖」取值，而 `WeakMap.get` 实测约 0.2µs
 * ——7 万次就是 14ms，比它省下的分配还贵。按数组缓存后只剩「函数数」次（3 千），
 * 内层退化成一次数组下标。
 */
const COMPS_BY_DEPS = new WeakMap<readonly StateDependency[], string[][]>();

function compsFor(deps: readonly StateDependency[]): string[][] {
  const hit = COMPS_BY_DEPS.get(deps);
  if (hit !== undefined) return hit;
  const out: string[][] = new Array(deps.length);
  for (let i = 0; i < deps.length; i++) out[i] = compsOf(deps[i]!);
  COMPS_BY_DEPS.set(deps, out);
  return out;
}

/** 一条格子贡献（`MatrixCellFunction` 的唯一构造点） */
function cellFunctionOf(fn: FaceFunction, comparisons: string[]): MatrixCellFunction {
  return {
    name: fn.name,
    filePath: fn.filePath,
    startLine: fn.startLine,
    comparisons,
    family: fn.match.family,
    prefix: fn.match.prefix,
    kind: fn.match.kind,
    face: fn.match.face,
    slot: fn.match.slot,
    isMessageCheck: fn.match.isMessageCheck,
  };
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
  /** 函数 → 它所属的列累加器（一次查找代替「先查描述、再查面、再查列」三跳） */
  const colAccOf = new Map<FaceFunction, ColumnAcc>();
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
    let col = colAccOf.get(fn);
    if (col) return col;
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
    col = cols.get(desc.key);
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
    colAccOf.set(fn, col);
    return col;
  };

  for (const fn of columnEntry.functions) {
    accOf(fn).universeFunctions.push(columnFn(fn));
  }

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
      const deps = depsFor(fn);
      const compsList = compsFor(deps);
      for (let k = 0; k < deps.length; k++) {
        const dep = deps[k];
        if (!dep) continue;
        const row = ensureRow(dep);
        for (const s of compsList[k]!) {
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

    const compsList = deps.length > 0 ? compsFor(deps) : EMPTY_COMPS;
    for (let k = 0; k < deps.length; k++) {
      const dep = deps[k];
      if (!dep) continue;
      const comps = compsList[k]!;
      const row = ensureRow(dep);

      let cell = row.cells[col.key];
      if (!cell) {
        cell = { present: true, count: 0, functions: [] };
        row.cells[col.key] = cell;
        row.filled += 1;
        columnFills.set(col.key, (columnFills.get(col.key) ?? 0) + 1);
      }
      cell.count += 1;
      cell.functions.push(cellFunctionOf(fn, comps));
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

  /**
   * 列集合在**填色循环之后**才收口：作用域模式（口上包 / 工作区包）下作用域函数未必是
   * `columnEntry` 的子集——工作区包可能写了游戏里还没人写过的时机。先前在循环前收口
   * 会让这类列整个消失（格子指向不存在的列），行缺口计数也少算。
   */
  const groupsAcc = [...byFace.entries()]
    .map(([face, cols]) => ({
      face,
      label: faceLabel(face, faceLabels),
      columns: [...cols.values()].sort(compareColumn),
    }))
    .sort((a, b) => faceRank(a.face) - faceRank(b.face) || a.face.localeCompare(b.face));
  const columnCount = groupsAcc.reduce((n, g) => n + g.columns.length, 0);

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

/** 空依赖清单的常量（零分配：多数函数没有状态依赖） */
const EMPTY_COMPS: string[][] = [];
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

/** 自动折叠指令时机的总列数阈值：超过它才启用，避免小表莫名其妙收起 */
export const AUTO_FOLD_COLUMNS = 60;
/** 自动折叠只收「多列且确有指令编号」的组；单列组照常展开 */
const AUTO_FOLD_MIN_GROUP_COLUMNS = 4;

/**
 * 大矩阵的默认折叠面：总列数超过阈值时，把**指令承载面**（多列组）先收起来。
 *
 * 指令面每指令一列，一个角色可以铺出几百列；这是选中角色首帧的最大成本。
 * 折叠是纯呈现策略：表头仍在，点一下即可展开；非指令面 / 小分组保持可见。
 */
export function autoFoldFaces(groups: readonly MatrixColumnGroup[]): Set<string> {
  const out = new Set<string>();
  const total = groups.reduce((n, g) => n + g.columns.length, 0);
  if (total <= AUTO_FOLD_COLUMNS) return out;
  for (const group of groups) {
    if (group.columns.length < AUTO_FOLD_MIN_GROUP_COLUMNS) continue;
    if (group.columns.some((col) => col.instructionNo !== null)) out.add(group.face);
  }
  return out;
}

/**
 * 当前可见列里是否还有空缺——「只看空缺」的唯一判据。
 *
 * 空缺 = 该列在行里没有 `present` 的响应（不是 `count === 0`）；空列清单
 * 视为无空缺（没有可见时机可看时，不该把所有行都留下）。
 */
export function rowHasVisibleGap(row: MatrixRow, visibleColumnKeys: readonly string[]): boolean {
  return visibleColumnKeys.some((key) => !row.cells[key]?.present);
}

/**
 * 两次窗口是否同一行区间。滚动帧据此跳过重渲：区间不变 ⇒ 占位块与已渲染行的落点
 * 都不变，浏览器自己滚即可；只有跨过一行（窗口平移）才需要换 tbody 内容。
 */
export function sameMatrixWindow(
  a: Pick<ViewportWindow, 'start' | 'end'>,
  b: Pick<ViewportWindow, 'start' | 'end'>,
): boolean {
  return a.start === b.start && a.end === b.end;
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
  /**
   * 判据顺序：**先比行号**（整数，绝大多数函数在这里就被排除），再比路径。
   *
   * 这条路径 2026-10-29 性能批**试过三种写法，全部更快失败**，故保持原样：
   * ① 直接比原串（`f.filePath === fn.filePath`）比 `pathKey` 慢 40%——`pathKey` 对已归一
   *    的写法会原样返回同一个字符串对象，`===` 退化成指针比较；直接比原串要逐字符走完整条路径。
   * ② 惰性算 `pathKey`（先比原串、不等再归一）同样更慢（同①）。
   * ③ 按函数建 CSR 索引（函数 → 行/列）：建表要多登记 7 万对下标（+7.5ms/次），
   *    而省下的只是「每次光标跨函数 3ms」——面板已按函数身份记忆化，单次命中一次，
   *    这笔账只有在「一帧内反复换函数」时才划得来，实测不成立。
   */
  for (const row of matrix.rows) {
    const cells = row.cells;
    for (const colKey of Object.keys(cells)) {
      const cell = cells[colKey];
      if (!cell) continue;
      if (cell.functions.some((f) => f.startLine === fn.startLine && pathKey(f.filePath) === key)) {
        out.set(row.key, colKey);
        break; // 一个函数只贡献一格（一行一列）
      }
    }
  }
  return out;
}

/* ------------------------------ 依赖指纹 ------------------------------ */

/** `ErbFile` 的身份编号（WeakMap 计数器；身份变了 = 文件内容变过） */
const FILE_ID = new WeakMap<ErbFile, number>();
let fileIdSeq = 0;
function fileIdOf(file: ErbFile): number {
  let id = FILE_ID.get(file);
  if (id === undefined) {
    id = ++fileIdSeq;
    FILE_ID.set(file, id);
  }
  return id;
}

/** 依赖数组的身份编号（同上；只对非空数组取，空数组每次都是新 `[]`） */
const DEPS_ID = new WeakMap<object, number>();
let depsIdSeq = 0;
function depsIdOf(deps: object): number {
  let id = DEPS_ID.get(deps);
  if (id === undefined) {
    id = ++depsIdSeq;
    DEPS_ID.set(deps, id);
  }
  return id;
}

function fnv(h: number, value: number): number {
  h ^= value;
  return Math.imul(h, 16777619) >>> 0;
}

/**
 * 这一份聚合的**依赖指纹**（矩阵记忆化的失效判据；纯函数，单测钉住）。
 *
 * 存在的理由：面板的矩阵缓存原先按「抽取代次」失效，而抽取在**每次保存**都会跑一遍
 * ——于是「改一句台词」也会让当前角色的矩阵整表重建（建表 + 整窗行重渲）。
 * 实际上绝大多数保存与这个角色无关。指纹把「代次变了」换成「这一份真的变了吗」：
 *
 * - **文件身份**：`CharacterEntry` 由 `buildCharacterIndex` 从逐文件的 `ErbFile` 拼出，
 *   而增量索引只替换变过的文件对象 ⇒ 文件身份 + 函数数就是「这一份聚合的内容有没有变」
 *   的完整判据（改名 / 加函数 / 改函数体都会换对象）；
 * - **依赖身份**：抽取索引里的 `dependencies` 数组在一次抽取内稳定，重抽会换新数组 ⇒
 *   数组身份 + 长度足以判「这个函数的依赖变了没有」。空数组不取身份（服务每次都新建 `[]`），
 *   只哈希长度。
 *
 * 读不到来源文件（手工构造的聚合 / 单测）时退化成「函数名 + 行号 + 面」的哈希——仍然确定，
 * 只是每次多算一点，绝不因此少算一次重建。
 */
export function depsFingerprint(
  entry: CharacterEntry,
  depsOf: (normalizedName: string) => StateDependency[],
): number {
  let h = 2166136261;
  const sources = ENTRY_SOURCES.get(entry);
  if (sources) {
    for (const file of sources) {
      h = fnv(h, fileIdOf(file));
      h = fnv(h, file.functions?.length ?? 0);
    }
  } else {
    for (const fn of entry.functions) {
      const name = fn.name;
      for (let i = 0; i < name.length; i++) h = fnv(h, name.charCodeAt(i));
      h = fnv(h, fn.startLine);
      const face = fn.face;
      for (let i = 0; i < face.length; i++) h = fnv(h, face.charCodeAt(i));
    }
  }
  for (const fn of entry.functions) {
    let deps: StateDependency[];
    try {
      deps = depsOf(fn.normalizedName) ?? [];
    } catch {
      deps = [];
    }
    h = fnv(h, deps.length === 0 ? 0 : depsIdOf(deps));
    h = fnv(h, deps.length);
  }
  return h >>> 0;
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
