/**
 * 口上函数树构建（纯逻辑，零 React 依赖——便于单测与未来复用）。
 *
 * 三维导航（HANDOFF §6.2）：
 *   角色（K{no}）→ 家族（FamilyMatch.family，'' = 初始家族）→ 面（face，语义排序）→ 函数（slot 排序）。
 *
 * 归属规则：
 *   - `FamilyMatch.characterNo` 是唯一归属依据；无法归属的函数进 `orphans`
 *     （占位符残留 KX / 与口上无关的通用函数 / 适配器未提供家族规则时的全部函数）。
 *   - orphans **只计数**不展开（全项目 99k 函数里非口上域占大头，渲染会拖垮面板）；
 *     定位它们用面板顶部的搜索框（搜索覆盖全部函数，含 orphans）。
 */

import type {
  CharaInfo,
  ErbIndex,
  FamilyIndexRule,
  FamilyMatch,
} from '@kojo/plugin-api';

/* ------------------------------ 数据形状 ------------------------------ */

/** 叶子：单个函数定义 */
export interface FunctionNode {
  readonly name: string;
  readonly normalizedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** 家族解析结果（null = 未匹配口上命名） */
  readonly match: FamilyMatch | null;
  /** 函数上方紧邻的作者注释块（悬停提示用；见 ErbFunction.docComment） */
  readonly docComment?: string;
}

/** 面：调用语义分组（同一面内按 slot 排序） */
export interface FaceNode {
  /** 面名（'' = 未识别，显示为「其它」） */
  readonly face: string;
  readonly functions: FunctionNode[];
}

/** 家族：'' = 初始家族 */
export interface FamilyNode {
  readonly family: string;
  readonly faces: FaceNode[];
}

/** 角色：K{no}（charaIndex 提供显示名；无映射时用 K{no}） */
export interface CharaNode {
  readonly no: number;
  /** 显示名（`K1 霊夢` 形态） */
  readonly label: string;
  /** 有口上目录时提供（用于 tooltip） */
  readonly name?: string;
  readonly families: FamilyNode[];
  /** 该角色名下函数总数 */
  readonly functionCount: number;
}

/** 全量导航树 */
export interface NavigatorTree {
  /** 按角色号升序；只含有归属函数的角色 */
  readonly charas: CharaNode[];
  /** 无法归属角色的函数总数（不展开，用搜索定位） */
  readonly orphanCount: number;
  /** 适配器是否提供了家族规则（false 时树为空，只能用搜索） */
  readonly hasFamilyIndex: boolean;
  /** 全部函数总数（状态栏显示） */
  readonly totalFunctions: number;
}

/* ------------------------------ 面语义排序 ------------------------------ */

/**
 * 面的语义顺序（按游戏调用时机粗排，来自《口上机制深挖》的 CASE 路由表；
 * 未列出的面排在最后按字母序，'' 归「其它」）。
 */
const FACE_ORDER: readonly string[] = [
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

/** slot 排序：前导数字按数值比较（30 > 2），否则字符串比较 */
function compareSlot(a: string, b: string): number {
  const na = /^\d+/.exec(a);
  const nb = /^\d+/.exec(b);
  if (na && nb) {
    const d = Number(na[0]) - Number(nb[0]);
    if (d !== 0) return d;
    return a.slice(na[0].length).localeCompare(b.slice(nb[0].length));
  }
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b);
}

/** 函数显示序：startLine（同文件内天然有序）为主，slot 为辅 */
function compareFunctions(a: FunctionNode, b: FunctionNode): number {
  if (a.match && b.match) {
    const s = compareSlot(a.match.slot, b.match.slot);
    if (s !== 0) return s;
  }
  return a.startLine - b.startLine || a.filePath.localeCompare(b.filePath);
}

/* ------------------------------ 主构建 ------------------------------ */

/**
 * 是否需要重建导航树（2026-10-12 内核优化批）。
 *
 * `project.opened` 与 `kojo.functionChanged` 会**双双触发**面板刷新，而两条路径最终
 * 拿到的是**同一个 `ErbIndex` 实例**（erb-parser 构建完成后只替换一次引用）。
 * 按引用比较即可去重——避免在 95k 函数上把 `buildNavigatorTree`（单次近秒级）白跑第二遍。
 */
export function shouldRebuildIndex(prev: ErbIndex | null, next: ErbIndex | null): boolean {
  return prev !== next;
}

/** 角色显示名：charaIndex 命中 → `K{no} {name}`，否则 `K{no}` */
function charaLabel(no: number, charaIndex: ReadonlyMap<number, CharaInfo>): { label: string; name?: string } {
  const info = charaIndex.get(no);
  if (!info) return { label: `K${no}` };
  return { label: `K${no} ${info.name}`, name: info.name };
}

/**
 * 从索引构建导航树。
 * 单次全量遍历（99k 函数实测 < 1s），每次 `kojo.functionChanged` 重建一次
 * （同一索引实例重复调用由 `shouldRebuildIndex` 在调用方去重）。
 */
export function buildNavigatorTree(
  index: ErbIndex,
  familyIndex: FamilyIndexRule | null,
  charaIndex: ReadonlyMap<number, CharaInfo>,
): NavigatorTree {
  // 角色号 → (家族 → (面 → 函数[]))
  const acc = new Map<number, Map<string, Map<string, FunctionNode[]>>>();
  let orphanCount = 0;
  let totalFunctions = 0;

  for (const file of index.files.values()) {
    for (const fn of file.functions) {
      totalFunctions++;
      // 用归一化名解析（Emuera 语义大小写不敏感；正则按大写设计）；附文件路径供
      // 适配器把占位符形态对齐到文件编号（additive：无家族规则的适配器忽略该参）
      const match = familyIndex ? familyIndex.match(fn.normalizedName, fn.filePath) : null;
      if (!match || match.characterNo === null) {
        orphanCount++;
        continue;
      }
      let byFamily = acc.get(match.characterNo);
      if (!byFamily) {
        byFamily = new Map();
        acc.set(match.characterNo, byFamily);
      }
      const family = match.family;
      let byFace = byFamily.get(family);
      if (!byFace) {
        byFace = new Map();
        byFamily.set(family, byFace);
      }
      // declare 形态单独成面（「家族声明」），与功能面分开
      const face = match.kind === 'declare' ? 'declare' : match.face;
      const list = byFace.get(face);
      if (list) list.push(makeNode(fn, match));
      else byFace.set(face, [makeNode(fn, match)]);
    }
  }

  const charas: CharaNode[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, byFamily]) => {
      const families: FamilyNode[] = [...byFamily.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([family, byFace]) => ({
          family,
          faces: [...byFace.entries()]
            .sort((a, b) => faceRank(a[0]) - faceRank(b[0]) || a[0].localeCompare(b[0]))
            .map(([face, fns]) => ({
              face,
              functions: fns.sort(compareFunctions),
            })),
        }));
      let functionCount = 0;
      for (const f of families) for (const fc of f.faces) functionCount += fc.functions.length;
      const { label, name } = charaLabel(no, charaIndex);
      return { no, label, name, families, functionCount };
    });

  return { charas, orphanCount, hasFamilyIndex: familyIndex !== null, totalFunctions };
}

function makeNode(
  fn: {
    name: string;
    normalizedName: string;
    filePath: string;
    startLine: number;
    endLine: number;
    docComment?: string;
  },
  match: FamilyMatch,
): FunctionNode {
  return {
    name: fn.name,
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    endLine: fn.endLine,
    match,
    ...(fn.docComment !== undefined ? { docComment: fn.docComment } : {}),
  };
}

/**
 * 函数行的悬停提示文本（纯函数，可单测）。
 *
 * 用户反馈 9：函数名几乎都是**全大写 + 长前缀**（`M_KOJO_MESSAGE_COM_K1_30`），
 * 初看完全读不出这函数干什么。而作者习惯在函数上方留一行说明
 * （`;660,読書` / `;TFLAG:193(選択肢文学…)`）——实测覆盖 51.5% 的函数。
 * 所以注释放**最前**（那才是人要看的东西），路径与行号垫在后面兜定位用途。
 * 无注释时退回原形态，不硬凑。
 */
export function functionTooltip(fn: {
  filePath: string;
  startLine: number;
  endLine: number;
  docComment?: string;
}, shortPath: (p: string) => string): string {
  const loc = `${shortPath(fn.filePath)}:${fn.startLine}-${fn.endLine}`;
  return fn.docComment ? `${fn.docComment}\n\n${loc}` : loc;
}

/* ------------------------------ 搜索 ------------------------------ */

/** 搜索结果条目（扁平，跨角色/家族） */
export interface SearchHit {
  readonly node: FunctionNode;
  /** 命中角色号（未归属为 null） */
  readonly charaNo: number | null;
}

/**
 * 函数名子串搜索（大小写不敏感；覆盖全部函数含 orphans）。
 * 返回按「文件、行」排序的前 `limit` 条。
 */
export function searchFunctions(
  index: ErbIndex,
  query: string,
  familyIndex: FamilyIndexRule | null,
  limit = 200,
): SearchHit[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const file of index.files.values()) {
    for (const fn of file.functions) {
      if (!fn.normalizedName.includes(q)) continue;
      const match = familyIndex ? familyIndex.match(fn.normalizedName, fn.filePath) : null;
      hits.push({ node: makeNode(fn, match ?? emptyMatch()), charaNo: match?.characterNo ?? null });
      if (hits.length >= limit * 3) break; // 超采后截断排序（保持结果大致确定性）
    }
    if (hits.length >= limit * 3) break;
  }
  hits.sort((a, b) => a.node.filePath.localeCompare(b.node.filePath) || a.node.startLine - b.node.startLine);
  return hits.slice(0, limit);
}

function emptyMatch(): FamilyMatch {
  return {
    kind: 'ok',
    prefix: '',
    family: '',
    characterNo: null,
    selector: 0,
    face: '',
    sub: '',
    isMessageCheck: false,
    slot: '',
    isPlaceholder: false,
  };
}
