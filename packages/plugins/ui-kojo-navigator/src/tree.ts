/**
 * 口上函数树构建（纯逻辑，零 React 依赖——便于单测与未来复用）。
 *
 * 三维导航（HANDOFF §6.2）：
 *   角色（K{no}）→ 家族（FamilyMatch.family，'' = 初始家族）→ 面（face，语义排序）→ 函数（slot 排序）。
 *
 * 归属规则（W7 NAV-SCOPE 批：一条，不是两条）：
 *   - **有范围目录时按目录**：`owners`（= 检索范围提供方给出的"这个范围住哪些位置"）
 *     是归属的唯一判据，判定走契约层 `pathInScope`——与全文检索、`Ctrl+T`、`Ctrl+P`
 *     同一条尺子。此前这里另有一份**按函数名**推角色的判据（`FamilyMatch.characterNo`），
 *     于是选定"只看某个范围"后搜索面板只扫该目录、函数树仍扫全量十万函数，
 *     两处对"谁属于谁"还给出不一致的答案。现在名字判据只供**家族/面/槽位**的结构，
 *     不再供角色归属。
 *   - 提供方**没给**目录（无适配器 / 契约字段缺失）⇒ 退回名字形态，但**状态行明写**
 *     「角色归属：按名字（无角色目录）」（`NavigatorTree.attribution`）——两份判据
 *     不许在同一棵树里同时生效（按目录有值的函数一律按目录），也不许静默切换。
 *   - orphans **只计数**不展开（全项目 99k 函数里非口上域占大头，渲染会拖垮面板）；
 *     定位它们用面板顶部的搜索框（搜索覆盖全部函数，含 orphans）。
 */

import type {
  CharaInfo,
  ErbFunction,
  ErbIndex,
  ErbScopeStamp,
  FamilyIndexRule,
  FamilyMatch,
  RenderWindow,
} from '@kojo/plugin-api';
import {
  CANDIDATE_BUDGETS,
  candidateBudget,
  candidateRank,
  nextWindow,
  pathInScope,
  pathProbe,
  sepOf,
  type PathProbe,
  windowSize,
} from '@kojo/plugin-api';

/* ------------------------------ 数据形状 ------------------------------ */

/**
 * 「未识别家族归属」的 null-object 哨兵（有意保留，不是历史事故）：
 * 挡下游 `node.match.xxx` 裸读 NPE。**冻结 + 单一引用**——所有空归属节点共用它，
 * `toStrictEqual` / 引用比较 / 渲染 memo 才不会各拿各的"长得一样的新对象"。
 */
export const NO_FAMILY_MATCH: FamilyMatch = Object.freeze({
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
});

/** 叶子：单个函数定义 */
export interface FunctionNode {
  readonly name: string;
  readonly normalizedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** 家族解析结果（未匹配口上命名 ⇒ `NO_FAMILY_MATCH` 哨兵，恒非 null；null-object 口径） */
  readonly match: FamilyMatch;
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
  /**
   * 本轮角色归属**用的是哪一条判据**（状态行原样转述；铁律 4：两种判据不许同时生效，
   * 也不许静默切换）。`'dir'` = 按提供方给的角色目录（缺省、唯一正解）；
   * `'name'` = 目录一条腿没数据可用，退回按函数名（少见，必须看得见）；`'none'` = 全没有。
   */
  readonly attribution: 'dir' | 'name' | 'none';
  /** 本轮生效的"只看"范围 key（`''` = 不限；与全文检索 / `Ctrl+T` / `Ctrl+P` 同一个戳） */
  readonly scopeKey: string;
  /** 本轮**实际进入建树**的文件数（范围外的一条没扫——状态行的"扫了多少"说得出真话） */
  readonly filesScanned: number;
}

/* ------------------------------ 范围与归属（判据单源） ------------------------------ */

/** 一个角色的口上目录（`roots` = 提供方给的位置集合，宿主与本插件都不解释其含义） */
export interface CharaOwner {
  readonly no: number;
  readonly roots: readonly string[];
}

/**
 * 角色清单 → 归属目录表（**投影**，不是判据：判据只有契约层 `pathInScope` 那一条，
 * 与全文检索范围用的是同一个字段、同一个谓词 ⇒ 角色归属只剩一份）。
 * 没有口上目录的角色不产条目——文件树那侧本来也看不见它。
 */
export function charaOwnersOf(charaIndex: ReadonlyMap<number, CharaInfo>): CharaOwner[] {
  const out: CharaOwner[] = [];
  for (const info of charaIndex.values()) {
    const dir = info.kojoDir;
    if (typeof dir !== 'string' || dir === '') continue;
    out.push({ no: info.no, roots: [dir] });
  }
  return out;
}

/**
 * 文件路径 → 归属角色号（找不到 ⇒ `null`；一条判据、一处实现）。
 *
 * **取最更深的那一条**：角色目录可能互相嵌套（作者把一个角色的分支放进另一个角色的目录里），
 * `startsWith` 谁都能匹上——按匹配到的根取胜者，才是"这文件住在谁家里"的答案。
 * 判据本身仍是契约层那一条（`pathProbe` / `probeContains` = `isPathUnder` 的预折叠形态）。
 *
 * **实现走"沿路径向上找根"而不是"逐根比一遍"**（P0-2 冷开实测）：旧写法是
 * `文件 × 全部角色目录`（2,120 × ~1,000 ≈ 200 万次包含判定，单帧 self 138ms）。
 * 换过来只需 `文件 × 自身层数`（约 7 次），因为「命中某个根」等价于「该根是这个文件路径的
 * 某个祖先目录」——而"最深的祖先"就是旧写法里"长度最大的根"要的答案。
 * 同一目录挂了多个角色时（同键多条）仍按原表顺序取第一条，与旧写法的 `>` 严格比较一致。
 */
export function ownerNoOfPath(filePath: string, owners: readonly CharaOwner[]): number | null {
  return pickOwner(pathProbe(filePath), indexOwners(owners));
}

/** 一个根折出来的格子：`depth` = **原始根**长度（裁决口径与旧实现一致，见下） */
interface OwnerSlot {
  readonly no: number;
  readonly depth: number;
}

/**
 * 角色目录表 → 「折叠根 → 角色们」的查找表。
 *
 * `depth` 用原始根长度而不是折叠后的：归一化可能缩短字符串（`C:\a\b\..`），
 * 拿折叠长度比会改掉嵌套根之间的胜负——旧实现的裁决位就是这个原始长度，照抄。
 * 按分隔符风格分组：`probeContains` 用**根**的风格取分隔符，分组后每组只走一种分隔符。
 */
interface OwnerIndex {
  readonly groups: readonly { readonly sep: string; readonly byKey: ReadonlyMap<string, readonly OwnerSlot[]> }[];
}

function indexOwners(owners: readonly CharaOwner[]): OwnerIndex {
  const groups = new Map<string, Map<string, OwnerSlot[]>>();
  for (const owner of owners) {
    for (const root of owner.roots) {
      const probe = pathProbe(root);
      if (probe.key === '') continue;
      const sep = sepOf(probe.style);
      let byKey = groups.get(sep);
      if (!byKey) {
        byKey = new Map();
        groups.set(sep, byKey);
      }
      const slot: OwnerSlot = { no: owner.no, depth: root.length };
      const list = byKey.get(probe.key);
      if (list) list.push(slot);
      else byKey.set(probe.key, [slot]);
    }
  }
  return {
    groups: [...groups.entries()].map(([sep, byKey]) => ({ sep, byKey })),
  };
}

/**
 * 沿路径向上列祖先键（含自身）：`C:\a\b\c` → `C:\a\b\c` / `C:\a\b` / `C:\a` / `C:\`。
 * 盘符根与 POSIX 根都要**把分隔符留在键里**（`normalize('C:\\')` 就是 `C:\`）。
 */
function ancestorKeys(key: string, sep: string): string[] {
  const out: string[] = [key];
  let end = key.lastIndexOf(sep);
  while (end > 0) {
    // 盘符根（`c:` + sep）与 POSIX 根（`/`）都是 1~3 字符的特例，保留分隔符
    if (end === 2 && key.charCodeAt(1) === 58 /* ':' */) {
      out.push(key.slice(0, 3));
      break;
    }
    out.push(key.slice(0, end));
    end = key.lastIndexOf(sep, end - 1);
  }
  if (end === 0 && key.charCodeAt(0) === sep.charCodeAt(0)) out.push(sep);
  return out;
}

/** 归属判定本体（`ownerNoOfPath` 与建树热循环共用这一处） */
function pickOwner(file: PathProbe, index: OwnerIndex): number | null {
  for (const group of index.groups) {
    for (const candidate of ancestorKeys(file.key, group.sep)) {
      const slots = group.byKey.get(candidate);
      if (slots === undefined) continue;
      let best: OwnerSlot | null = null;
      for (const slot of slots) if (best === null || slot.depth > best.depth) best = slot;
      return best!.no;
    }
  }
  return null;
}

/** 建树与搜索的一次性输入（additive：不传 ⇒ 与改动前逐字一致的形态仍由调用方决定） */
export interface NavigatorBuildOptions {
  /** 角色归属目录表（缺省 = 由 `charaIndex` 投影；空 ⇒ 名字判据兜底，见文件头） */
  readonly owners?: readonly CharaOwner[];
  /** 当前"只看"范围戳（`null` / `roots` 空 ⇒ 全量） */
  readonly scope?: ErbScopeStamp | null;
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
 *
 * **范围先于遍历**（W7 NAV-SCOPE）：`options.scope` 落在哪个目录，建树就只走哪些文件——
 * 选定"只看某处"后函数树不再扫全量十万条（此前它压根不读选择器）。
 * 角色归属同一条判据：`pathInScope`（契约层），角色目录来自提供方给的泛型事实。
 */
export function buildNavigatorTree(
  index: ErbIndex,
  familyIndex: FamilyIndexRule | null,
  charaIndex: ReadonlyMap<number, CharaInfo>,
  options: NavigatorBuildOptions = {},
): NavigatorTree {
  const owners = options.owners ?? charaOwnersOf(charaIndex);
  const byDir = owners.length > 0;
  // 根表索引一遍（不是逐文件逐根比）；判据仍是契约层那条，见 `indexOwners`
  const ownerIndex = indexOwners(owners);
  const scopeRoots = options.scope?.roots ?? [];
  // 角色号 → (家族 → (面 → 函数[]))
  const acc = new Map<number, Map<string, Map<string, FunctionNode[]>>>();
  let orphanCount = 0;
  let totalFunctions = 0;
  let filesScanned = 0;

  for (const file of index.files.values()) {
    if (!pathInScope(file.path, scopeRoots)) continue;
    filesScanned++;
    const ownerNo = byDir ? pickOwner(pathProbe(file.path), ownerIndex) : null;
    for (const fn of file.functions) {
      totalFunctions++;
      // 家族/面/槽位的结构仍来自适配器规则（那**不是**角色归属——归属只有一条判据）；
      // 附文件路径供适配器把占位符形态对齐到文件编号（additive：无家族规则的适配器忽略该参）
      const match = familyIndex ? familyIndex.match(fn.normalizedName, fn.filePath) : null;
      const characterNo = byDir ? ownerNo : match?.characterNo ?? null;
      if (characterNo === null) {
        orphanCount++;
        continue;
      }
      let byFamily = acc.get(characterNo);
      if (!byFamily) {
        byFamily = new Map();
        acc.set(characterNo, byFamily);
      }
      const family = match?.family ?? '';
      let byFace = byFamily.get(family);
      if (!byFace) {
        byFace = new Map();
        byFamily.set(family, byFace);
      }
      // declare 形态单独成面（「家族声明」），与功能面分开；规则没认出的进「其它」
      const face = match ? (match.kind === 'declare' ? 'declare' : match.face) : '';
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

  return {
    charas,
    orphanCount,
    hasFamilyIndex: familyIndex !== null,
    totalFunctions,
    attribution: byDir ? 'dir' : familyIndex !== null ? 'name' : 'none',
    scopeKey: options.scope?.key ?? '',
    filesScanned,
  };
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
  match: FamilyMatch | null,
): FunctionNode {
  return {
    name: fn.name,
    normalizedName: fn.normalizedName,
    filePath: fn.filePath,
    startLine: fn.startLine,
    endLine: fn.endLine,
    // 空 match 哨兵：null-object 兜底（旧行为，规格钉死——见 search-perf.test.ts :190）
    match: match ?? NO_FAMILY_MATCH,
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
 *
 * **排序轴的分工**（W7 NAV-SCOPE，说清以免被读成"漏了一条没统一"）：相关性分桶是
 * 契约层 `candidateRank` 一份（全文检索候选 / `Ctrl+T` / `Ctrl+P` 三处都用它排）；
 * 这条列表**刻意不按相关性排**——面板把命中按「同一文件里从上往下」呈现，读者顺着行号
 * 走查，相关性插队会打碎那个阅读序。两者共用的是**预算档位**与**范围判据**，不是比较器。
 *
 * 性能口径（UX 感知批，2026-10-16）：99k 函数集上这是**纯扫描**（每击键走一次），
 * 所以三段拆开、把最贵的部分压到最小：
 *   1) 轻量收集：只存函数引用，命中到 `limit*3` 即早停（保持旧实现的超采截断语义）；
 *   2) 排序截断：按「文件、行」排完再切前 `limit` 条——结果与旧实现逐字相同；
 *   3) 物化：只对最终 ≤limit 条做家族解析（正则）+ 建 Node 对象。
 *      旧实现在超采阶段就对最多 `limit*3` 条各跑一次 `familyIndex.match`——这里省掉 2/3。
 * 面板侧另有 `searchFunctionsCached`（按查询串记忆）与 `useDeferredValue`（击键折叠）。
 *
 * `options.scope`（W7 NAV-SCOPE）：**范围外的文件一条不扫**——搜索覆盖全量这件事
 * 只在"不限范围"时才成立；选定范围后这里与全文检索、`Ctrl+T`、`Ctrl+P` 看的是同一堆文件。
 */
export function searchFunctions(
  index: ErbIndex,
  query: string,
  familyIndex: FamilyIndexRule | null,
  limit: number = CANDIDATE_BUDGETS.providerQuery,
  options: NavigatorBuildOptions = {},
): SearchHit[] {
  const cap = candidateBudget('providerQuery', limit);
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const owners = options.owners ?? [];
  const byDir = owners.length > 0;
  const scopeRoots = options.scope?.roots ?? [];
  const picked: ErbFunction[] = [];
  outer: for (const file of index.files.values()) {
    if (!pathInScope(file.path, scopeRoots)) continue;
    for (const fn of file.functions) {
      if (!fn.normalizedName.includes(q)) continue;
      picked.push(fn);
      if (picked.length >= cap * 3) break outer; // 超采后截断排序（保持结果大致确定性）
    }
  }
  picked.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
  const hits: SearchHit[] = [];
  for (const fn of picked.slice(0, cap)) {
    const match = familyIndex ? familyIndex.match(fn.normalizedName, fn.filePath) : null;
    const charaNo = byDir ? ownerNoOfPath(fn.filePath, owners) : match?.characterNo ?? null;
    hits.push({ node: makeNode(fn, match), charaNo });
  }
  return hits;
}

/**
 * 搜索结果会话级 memo（按 `ErbIndex` 实例弱引用存储 ⇒ 索引换代自动失效）。
 *
 * 动机：`useDeferredValue` 只保证"中间击键不落盘"，同一次已提交的 deferred 值在
 * 无关重渲染（徽章刷新 / 面板宿主重渲）里还会被重算——99k 扫描没有理由跑第二遍。
 * 每实例只留最近 `SEARCH_MEMO_CAP` 条（长会话连续打字不背满历史命中）。
 */
const SEARCH_MEMO_CAP = 8;
const searchMemo = new WeakMap<
  ErbIndex,
  { fi: FamilyIndexRule | null; limit: number; owners: readonly CharaOwner[] | undefined; scopeKey: string; hits: Map<string, SearchHit[]> }
>();

export function searchFunctionsCached(
  index: ErbIndex,
  query: string,
  familyIndex: FamilyIndexRule | null,
  limit: number = CANDIDATE_BUDGETS.providerQuery,
  options: NavigatorBuildOptions = {},
): SearchHit[] {
  const owners = options.owners;
  const scopeKey = options.scope?.key ?? '';
  let slot = searchMemo.get(index);
  if (!slot || slot.fi !== familyIndex || slot.limit !== limit || slot.owners !== owners || slot.scopeKey !== scopeKey) {
    slot = { fi: familyIndex, limit, owners, scopeKey, hits: new Map() };
    searchMemo.set(index, slot);
  }
  const key = query.trim().toUpperCase(); // 与 searchFunctions 的归一化同口径（大小写不敏感）
  const hit = slot.hits.get(key);
  if (hit) return hit;
  const res = searchFunctions(index, query, familyIndex, limit, options);
  if (slot.hits.size >= SEARCH_MEMO_CAP) {
    const oldest = slot.hits.keys().next().value;
    if (oldest !== undefined) slot.hits.delete(oldest);
  }
  slot.hits.set(key, res);
  return res;
}

/* ------------------------------ 面渲染窗口 ------------------------------ */

/**
 * 打开面的初始渲染窗口（行）。
 *
 * 旧实现是"每面硬截 300 行 + 其余只给一句提示"——上限存在但不可达（用户点不进去那 300 之外
 * 的第 301 行）。窗口化后 INITIAL 决定**首帧 DOM 上界**，滚动触底自动加窗（STEP/次），
 * 全量可达；步进增长保证浏览器永远不会一次挂一整面（最坏上千行）的行。
 *
 * 数学口径住在契约层 `sugar-panels`（`windowSize` / `nextWindow`，与两块糖面板同一把尺）；
 * 本面板只声明**自己的窗口参数**——取值不变（80/160），首帧行数与旧实现逐字相同。
 */
export const FACE_WINDOW: RenderWindow = { initial: 80, step: 160 };
/** 初始窗口行数（旧导出名，测试与面板都按它钉首帧行数） */
export const FACE_WINDOW_INITIAL = FACE_WINDOW.initial;
/** 触底后每次追加的行数（也是"显示更多"按钮一次的增量） */
export const FACE_WINDOW_STEP = FACE_WINDOW.step;

/** 当前窗口应渲染的行数（纯函数）：[0, min(total, limit ?? INITIAL)] */
export function faceWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, FACE_WINDOW);
}

/**
 * 窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))。
 * 单调不减、单步增量 ≤ STEP、终值 = total——"显示更多"与 IntersectionObserver 共用。
 */
export function nextFaceWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, FACE_WINDOW);
}

/**
 * 面渲染窗口（旧名「窗口口径」）
 */

