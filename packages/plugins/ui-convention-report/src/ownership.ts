/**
 * 修法条目的**归属与聚合**（纯逻辑：条目 → 分组键 → 有序分组 + 计数）。
 *
 * ## 为什么住在这一侧
 *
 * 作者心里的量词是「朱鷺子有 4 条要改」，不是「规则 X 有 137 条」。角色/家族的归属
 * 数据本来就存在于真源里，本模块只做搬运与三级判据的**取序**：
 * 1. `ConventionIssue.characterNo / .family` —— 由**游戏适配器自己的规则**填写
 *    （通用引擎的规则天生不知道角色为何物，这是铁律 2/3 的结果，不是缺陷）；
 * 2. 条目所在行的**外围函数** —— 经 `functionAt`（erb-parser 的索引）+
 *    `FamilyIndexRule.match`（适配器提供）还原，判据一律不在此处复刻；
 * 3. 条目所在文件的**角色目录** —— 前缀比对 `CharaInfo.kojoDir`（适配器填的表），
 *    只回答「该在谁家里改」，不冒充前两级回答「谁被伤了」。
 *
 * 本模块不认识任何游戏名词、不解析任何函数名形状（第 2/3 级的判据全部经参数注入）。
 *
 * ## 三条不可让步的纪律
 *
 * 1. **未归属是显式状态**（铁律 4）：它自成一个分组、恒排最后、计数进总账，
 *    绝不悄悄并进某个角色里，也绝不被丢掉 —— 不变量
 *    `sum(groups.count) === total === issues.length` 且 `sourceCounts` 四档相加 === total，
 *    单测与真实语料基线各钉一遍；
 * 2. **`family === ''` 与 `family === null` 不同义**：前者 = 初始家族（真源给的答案），
 *    后者 = 无从判定。合并它们等于替适配器编造结论，因此家族视角分出**三档**；
 * 3. **分组序确定**：先按组内最严重级别（错误在前），再按条数降序，再按角色编号升序，
 *    再按同角色内的档位，最后按标签/键的码点序。不用 `Object.keys` 的插入序碰运气，
 *    也不用 `localeCompare`（跨主机 ICU 结果不保证一致）。
 */

import type { CharaInfo, ConventionIssue, ConventionSeverity, FamilyIndexRule, FamilyMatch } from '@kojo/plugin-api';
import { CONVENTION_SEVERITY_ORDER } from '@kojo/plugin-api';

/* ============================ 归属判定 ============================ */

/** 角色归属是**怎么**来的（三种判据的出处必须区分：作者要能看出这一档靠不靠谱） */
export type OwnershipSource =
  /** 规则自己声明的（适配器规则填的字段，最高优先级） */
  | 'rule'
  /** 由条目所在行的外围函数还原的（索引 + 家族规则） */
  | 'function'
  /** 由条目所在文件的**角色目录**归属的（`CharaInfo.kojoDir` 前缀；只说"该改哪儿"，不宣称"伤了谁"） */
  | 'dir';

export interface Ownership {
  /** 角色号；null = 无法归属 */
  readonly characterNo: number | null;
  /** 家族名；`''` = 初始家族，null = 无从判定（两者不同义，见文件头纪律 2） */
  readonly family: string | null;
  /** 角色归属出处；null = 未归属 */
  readonly source: OwnershipSource | null;
}

/** 位置 → 所在函数（`ErbParserService.functionAt` 的中性形状；消费方注入，本模块不认服务） */
export type FunctionAt = (path: string, line: number) => { readonly normalizedName: string; readonly filePath: string } | undefined;

/** 角色目录条目（由 `charaDirOwners` 从 `charaIndex` 导出，长前缀在前） */
export interface DirOwner {
  readonly prefix: string;
  readonly characterNo: number;
}

export interface OwnershipDeps {
  readonly familyIndex: FamilyIndexRule | null;
  readonly functionAt?: FunctionAt | undefined;
  /**
   * 角色目录归属表（**最后一级判据**，缺席则该档不参与）。
   * 数据真源仍是适配器填的 `CharaInfo.kojoDir`；本模块只做前缀比较，不认识任何目录形状。
   */
  readonly dirOwners?: readonly DirOwner[] | undefined;
}

/**
 * `charaIndex` → 目录归属表（长前缀优先：`…/001 A/裏` 必须盖过 `…/001 A`，
 * 否则嵌套角色目录里的文件会被归给外层角色）。
 */
export function charaDirOwners(charaIndex: ReadonlyMap<number, CharaInfo> | null): DirOwner[] {
  const out: DirOwner[] = [];
  if (!charaIndex) return out;
  for (const c of charaIndex.values()) {
    if (c.kojoDir) out.push({ prefix: c.kojoDir, characterNo: c.no });
  }
  return out.sort((a, b) => b.prefix.length - a.prefix.length || a.characterNo - b.characterNo);
}

/** 路径是否落在该目录下（前缀之后必须是分隔符 —— `…/001 A` 不该盖住 `…/001 A2/…`） */
function insideDir(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest === '' || rest[0] === '/' || rest[0] === '\\';
}

/** `functionAt` 命中的函数 → 家族结构（无家族规则 / 无位置 / 家族规则不认识 ⇒ null） */
function matchAtLocation(issue: ConventionIssue, deps: OwnershipDeps): FamilyMatch | null {
  const { filePath, line } = issue;
  if (!filePath || !line || !deps.familyIndex || !deps.functionAt) return null;
  const fn = deps.functionAt(filePath, line);
  if (!fn) return null;
  // 归一化名（引擎大小写不敏感）+ 文件路径（占位符形态由适配器据此还原编号）——
  // 与导航树、条件矩阵同一调用口径，本模块不解释返回值的任何字段含义。
  return deps.familyIndex.match(fn.normalizedName, fn.filePath) ?? null;
}

/**
 * 单条归属。优先级：**规则声明 > 所在函数还原 > 所在目录**。
 * 前两级说「这条问题属于哪个角色的哪个家族」；第三级只说「这条问题该在谁家里改」
 * ——真实语料里这一档专门接住 KX 占位符（函数名里的角色号压根没替换，谁都不知道它本想
 * 是谁，但文件就躺在某个角色目录里，出处标 `dir` 就是这个意思，不冒充前两级）。
 * 家族取规则声明，声明缺席时用位置的（位置的 `''` 是有效答案 = 初始家族）。
 */
export function attributeIssue(issue: ConventionIssue, deps: OwnershipDeps): Ownership {
  const at = matchAtLocation(issue, deps);
  const family = issue.family ?? (at ? at.family : null);
  if (typeof issue.characterNo === 'number') {
    return { characterNo: issue.characterNo, family, source: 'rule' };
  }
  if (at && typeof at.characterNo === 'number') {
    return { characterNo: at.characterNo, family, source: 'function' };
  }
  const dir = ownerOfPath(issue.filePath, deps.dirOwners);
  if (dir) return { characterNo: dir.characterNo, family, source: 'dir' };
  return { characterNo: null, family, source: null };
}

/** 文件 → 所属角色目录（**最长匹配**；无路径 / 无表 / 不在任何角色目录下 ⇒ null） */
function ownerOfPath(path: string | undefined, owners: readonly DirOwner[] | undefined): DirOwner | null {
  if (!path || !owners) return null;
  let best: DirOwner | null = null;
  // 取最长而非取第一个：调用方的表顺序不该影响判定（`charaDirOwners` 已排序，这里只是
  // 不把"忘了排序"变成静默的错归属）
  for (const o of owners) {
    if (o.prefix.length > (best?.prefix.length ?? -1) && insideDir(path, o.prefix)) best = o;
  }
  return best;
}

/* ============================ 分组聚合 ============================ */

/** 视角：与作者面上的三个切换项一一对应 */
export type RollupMode = 'character' | 'family';

export interface RollupGroup {
  /** 稳定键（同一份数据重跑必得同一串；渲染 key 与判据都用它） */
  readonly key: string;
  /** 作者面文本 */
  readonly label: string;
  /** 角色号（未归属档为 null） */
  readonly characterNo: number | null;
  /** 该档是否为「连角色都归不出去」的残余档（恒排最后） */
  readonly residual: boolean;
  readonly count: number;
  readonly counts: Record<ConventionSeverity, number>;
  /** 组内条目：保持入参顺序（引擎已按严重度 + 规则 + 位置排过序） */
  readonly issues: readonly ConventionIssue[];
}

export interface Rollup {
  /** 已排序；未归属档恒在最后 */
  readonly groups: readonly RollupGroup[];
  /** = 入参条目数 = 各分组之和（不变量，测试钉死） */
  readonly total: number;
  /** 归属出处计数（含 none）：这一批条目是靠哪一级判据归上线的，各自多少条 */
  readonly sourceCounts: Record<OwnershipSource | 'none', number>;
}

const UNOWNED_CHARACTER = '未归属角色';
const UNRECORDED_FAMILY = '未记家族';
const INITIAL_FAMILY = '初始家族';

function zeroCounts(): Record<ConventionSeverity, number> {
  return { error: 0, warning: 0, info: 0 };
}

/** 组内最严重级别（排序主键）；空组不可能发生，取最大值兜底 */
function worstRank(issues: readonly ConventionIssue[]): number {
  let worst = Number.MAX_SAFE_INTEGER;
  for (const i of issues) {
    const r = CONVENTION_SEVERITY_ORDER[i.severity];
    if (r < worst) worst = r;
  }
  return worst;
}

/** 码点比较（**不用 localeCompare**：跨主机 ICU 的中文排序结果不保证一致 ⇒ 分组序会抖） */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface GroupDraft {
  key: string;
  label: string;
  characterNo: number | null;
  residual: boolean;
  /** 同角色内的展示次序（家族视角里「未记家族」排在该角色具名家族之后；其余视角恒 0） */
  order: number;
  issues: ConventionIssue[];
}

/** 视角键的规格：`residual` 只管「连角色都归不出去」这一档，它恒排最后 */
interface GroupSpec {
  key: string;
  label: string;
  characterNo: number | null;
  residual: boolean;
  order?: number;
}

/**
 * 分组核（两种视角共用）：`keyOf` 只负责给出 `{key, label, characterNo, residual}`，
 * 排序与计数一律在这里做 —— 视角之间的差别只允许出现在键与标签上。
 */
function rollup(
  issues: readonly ConventionIssue[],
  deps: OwnershipDeps,
  keyOf: (issue: ConventionIssue, own: Ownership) => GroupSpec,
): Rollup {
  const drafts = new Map<string, GroupDraft>();
  const sourceCounts: Record<OwnershipSource | 'none', number> = { rule: 0, function: 0, dir: 0, none: 0 };
  for (const issue of issues) {
    const own = attributeIssue(issue, deps);
    sourceCounts[own.source ?? 'none']++;
    const spec = keyOf(issue, own);
    let draft = drafts.get(spec.key);
    if (!draft) {
      draft = { key: spec.key, label: spec.label, characterNo: spec.characterNo, residual: spec.residual, order: spec.order ?? 0, issues: [] };
      drafts.set(spec.key, draft);
    }
    draft.issues.push(issue);
  }

  const sorted = [...drafts.values()].sort((a, b) => {
    if (a.residual !== b.residual) return a.residual ? 1 : -1; // 未归属档恒最后
    const w = worstRank(a.issues) - worstRank(b.issues); // 组内最严重级别：错误在前
    if (w !== 0) return w;
    if (a.issues.length !== b.issues.length) return b.issues.length - a.issues.length; // 条数降序
    const n = (a.characterNo ?? Number.MAX_SAFE_INTEGER) - (b.characterNo ?? Number.MAX_SAFE_INTEGER);
    if (n !== 0) return n; // 角色号升序
    if (a.order !== b.order) return a.order - b.order; // 同角色内：未记家族排在具名家族之后
    return compareCodepoint(a.label, b.label) || compareCodepoint(a.key, b.key);
  });

  const groups: RollupGroup[] = sorted.map((d) => {
    const counts = zeroCounts();
    for (const i of d.issues) counts[i.severity]++;
    return { key: d.key, label: d.label, characterNo: d.characterNo, residual: d.residual, count: d.issues.length, counts, issues: d.issues };
  });
  return { groups, total: issues.length, sourceCounts };
}

/**
 * 角色视角的分组键。
 * `label` 由调用方给（`characterLabel`）—— 角色名来自 `charaIndex`（适配器填的表），
 * 本模块不自行拼名字。`no` 不在 charaIndex 里时标签会显式带「未知角色」，不静默美化。
 */
export function rollupByCharacter(
  issues: readonly ConventionIssue[],
  deps: OwnershipDeps,
  labelOf: (no: number) => string,
): Rollup {
  return rollup(issues, deps, (_issue, own) => {
    if (own.characterNo === null) {
      return { key: '\u0000unowned', label: UNOWNED_CHARACTER, characterNo: null, residual: true };
    }
    const no = own.characterNo;
    return { key: `K\u0000${no}`, label: labelOf(no), characterNo: no, residual: false };
  });
}

/**
 * 家族视角的分组键（三档：具名家族 / 初始家族 / 未记家族，外加未归属角色档）。
 * 家族的作用域是角色，故键含角色号 —— 同名家族分属两个角色时**不合并**
 * （合并了就和导航树的「角色 → 家族」层级对不上，等于造第二个真源）。
 */
export function rollupByFamily(
  issues: readonly ConventionIssue[],
  deps: OwnershipDeps,
  labelOf: (no: number) => string,
): Rollup {
  return rollup(issues, deps, (_issue, own) => {
    if (own.characterNo === null) {
      return { key: '\u0000unowned', label: UNOWNED_CHARACTER, characterNo: null, residual: true };
    }
    const no = own.characterNo;
    const who = labelOf(no);
    if (own.family === null) {
      return { key: `F\u0000${no}\u0000-`, label: `${who} · ${UNRECORDED_FAMILY}`, characterNo: no, residual: false, order: 1 };
    }
    const family = own.family === '' ? INITIAL_FAMILY : own.family;
    return { key: `F\u0000${no}\u0000${own.family}`, label: `${who} · ${family}`, characterNo: no, residual: false };
  });
}

/* ============================ 标签 ============================ */

/**
 * 角色标签：`#编号 名字`（与文件树、部署向导同一口径；名字取自 `charaIndex`，
 * 编号不在表里时显式写「未知角色」而不是编一个 —— 家族规则可以还原出**不在角色表里**
 * 的编号（草稿目录、越界编号），那种情况作者需要看见，而不是被折叠成正常角色）。
 */
export function characterLabel(no: number, charaIndex: ReadonlyMap<number, CharaInfo> | null): string {
  const info = charaIndex?.get(no);
  return info ? `#${no} ${info.name}` : `#编号 ${no}（未知角色）`;
}

/**
 * 归属总账那一句人话（**单一真源**：面板与将来的通知都从这里取，别抄第二份）。
 * 数字必须与作者眼前的总条数逐字对上，缺一档就不叫账。
 */
export function rollupSummary(mode: RollupMode, rollupResult: Rollup): string {
  const view = mode === 'character' ? '按角色' : '按家族';
  const s = rollupResult.sourceCounts;
  const parts = [`${view}：${rollupResult.groups.length} 组 · 合计 ${rollupResult.total} 处`];
  const tiers = [`规则注明 ${s.rule}`, `所在函数 ${s.function}`, `所在目录 ${s.dir}`].filter((t) => !t.endsWith(' 0'));
  const owned = s.rule + s.function + s.dir;
  parts.push(owned > 0 ? `已归属 ${owned} 处（${tiers.join(' / ')}）` : '没有任何条目能归属到角色');
  if (s.none > 0) parts.push(`未归属 ${s.none} 处（单列在最后一组）`);
  return parts.join(' · ');
}
