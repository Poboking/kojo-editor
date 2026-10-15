import type {
  GameProject,
  SearchScopeContribution,
  SearchScopeOption,
} from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';
import { isUnderAnyRoot } from './workspace-roots';

/**
 * 检索范围（"只看某个范围内的结果"）的**纯逻辑**（无 React、无 IPC；C3 领域限定检索批）。
 *
 * 分层纪律（本文件存在的全部理由）：**"哪个范围对应哪些目录"是领域判据，住提供方**
 * （提供方注册在 `search.scope` 槽上，本仓当前是 era 系适配器包的 `search-scope.ts`）。
 * 宿主只三件事——把候选摊平、把检索根按候选**收窄**、把"扫了什么/没扫什么"
 * 翻成人话。这里没有一行按名字或目录形状判归属的代码：那种判据抄第二份就抄进了
 * 全仓最不该有它的一层（守卫见 `packages/app/tests/search-scope.layering.test.ts`）。
 *
 * 收窄发生在**发请求之前**（少扫就是少扫），不是"全扫一遍再挑"——扫描代价在原生侧，
 * 事后过滤既付了全量读盘的钱，又要宿主认识"结果属于谁"。
 */

/** 宿主侧的一条范围候选（`key` = 命名空间化后的稳定标识，检索状态里存的是它） */
export interface SearchScopeItem {
  readonly key: string;
  /** 下拉项文本（提供方生成，宿主原样显示） */
  readonly label: string;
  /** 悬浮补充（提供方生成；缺省 = 无） */
  readonly detail: string;
  /** 该范围的检索根（宿主只当"更小的检索根"用，不理解其含义） */
  readonly roots: readonly string[];
}

/** 范围候选目录 + 提供方侧的可见故障说明（铁律 4：坏在明处） */
export interface SearchScopeCatalog {
  readonly items: readonly SearchScopeItem[];
  /** 提供方抛错 / 产出非法候选时的人话说明（渲染成一行提示；空 = 一切正常） */
  readonly notices: readonly string[];
}

const EMPTY_CATALOG: SearchScopeCatalog = { items: [], notices: [] };

/**
 * 各提供方的候选 → 一张下拉清单。
 *
 * `query` 出来的顺序已按 `order` 排好，这里只摊平；`key` 叠一层 `pluginId` 命名空间
 * （同槽多注册是常态，两个提供方各自都可能叫 `a:1`）。
 * 非法候选（无 id / 空根 / 同提供方内 id 重复）**丢掉并出声**，不静默修正。
 */
export function collectSearchScopes(
  contributions: readonly SearchScopeContribution[],
  project: GameProject | null,
): SearchScopeCatalog {
  if (contributions.length === 0) return EMPTY_CATALOG;
  const items: SearchScopeItem[] = [];
  const notices: string[] = [];
  for (const contribution of contributions) {
    const owner = contribution.pluginId ?? contribution.id;
    let options: readonly SearchScopeOption[];
    try {
      options = contribution.provide(project);
    } catch (e: unknown) {
      notices.push(`范围提供方「${owner}」没能给出候选：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (option.id === '' || seen.has(option.id)) {
        notices.push(`范围提供方「${owner}」给出了重复或空的候选编号，已忽略：${option.id || '(空)'}`);
        continue;
      }
      seen.add(option.id);
      if (option.roots.length === 0) {
        notices.push(`范围「${option.label}」没有可用的检索位置，已忽略`);
        continue;
      }
      items.push({
        key: `${owner}:${option.id}`,
        label: option.label,
        detail: option.detail ?? '',
        roots: [...option.roots],
      });
    }
  }
  return { items, notices };
}

/** 按 `key` 取候选（`''` / 找不到的陈旧 key 一律按"不限范围"处理，不猜） */
export function findSearchScope(
  items: readonly SearchScopeItem[],
  key: string,
): SearchScopeItem | null {
  if (key === '') return null;
  return items.find((i) => i.key === key) ?? null;
}

/** 一次收窄的产出：实际检索根 + 落不进现有检索根的那部分范围条目 */
export interface ScopeNarrowing {
  readonly roots: readonly string[];
  readonly unreachable: readonly string[];
}

/**
 * 把检索根**收窄**到某条范围内（无候选 ⇒ 原样返回，与今天逐字一致）。
 *
 * 两条边界，都是刻意的：
 * 1. **只允许收窄，不许扩权**。落不进任何一个现有检索根的范围条目记为"不可达"并**不**
 *    进请求——检索根 = 项目根 ∪ 工作区根，是宿主唯一认可的读取面；选择器不该变成
 *    第二条"任意路径"通道（绕开法定出口的那一类形状）。
 * 2. 范围条目整体盖住了某个现有根时，**保留那个根本身**（`roots` 交给原生侧会去重，
 *    切成两半只会让同一份文件有两个候选写法）。
 */
export function narrowRoots(
  roots: readonly string[],
  scope: SearchScopeItem | null,
): ScopeNarrowing {
  if (scope === null) return { roots: [...roots], unreachable: [] };
  if (roots.length === 0) return { roots: [], unreachable: [...scope.roots] };

  const out: string[] = [];
  const unreachable: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    const k = pathKey(p);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  for (const target of scope.roots) {
    const covering = roots.filter((r) => isPathUnder(target, r));
    if (covering.length > 0) {
      for (const r of covering) push(r);
      continue;
    }
    if (isUnderAnyRoot(roots, target)) {
      push(target);
      continue;
    }
    unreachable.push(target);
  }
  return { roots: out, unreachable };
}

/**
 * 一次检索**实际用到**的范围（发请求那一刻的快照）。
 *
 * 为什么要单独存一份、而不是渲染时现查选择器：作者换了下拉但没重新搜，屏幕上的
 * 结果还是旧范围搜出来的——那句"只扫了这些"必须说的是**结果**，不是选择器。
 */
export interface AppliedSearchScope {
  readonly key: string;
  readonly label: string;
  /** 实际进入本次检索的范围根（目录或文件；宿主不理解其含义，只转述） */
  readonly roots: readonly string[];
  /** 落不进现有检索根、本次没扫的那部分 */
  readonly unreachable: readonly string[];
}

export function describeAppliedScope(
  scope: SearchScopeItem | null,
  narrowing: ScopeNarrowing,
): AppliedSearchScope | null {
  if (scope === null) return null;
  return {
    key: scope.key,
    label: scope.label,
    roots: [...narrowing.roots],
    unreachable: [...narrowing.unreachable],
  };
}

/* ------------------------------ 上屏文案 ------------------------------ */

/**
 * 已限定范围时的一行说明：扫了什么、**范围外的没扫**（这句不许省，
 * 否则"0 条结果"会被读成"整个项目里没有"）。
 *
 * 量词用「处」不用「个目录」：范围落到目录还是落到文件由提供方决定，
 * 宿主不替它断言形状（今天到目录，家族级若落地就到文件）。
 */
export function scopeStatusText(a: AppliedSearchScope): string {
  const parts = [`只看「${a.label}」：本次只检索 ${a.roots.length} 处，范围外的文件没有搜`];
  if (a.unreachable.length > 0) {
    parts.push(`另有 ${a.unreachable.length} 处不在当前项目里，也没扫`);
  }
  return parts.join(' · ');
}

/**
 * 范围内一个文件都没枚举到：说清是"没文件"，不是"没匹配"。
 *
 * `filtered` = 原生侧扩展名跳过的条数（`SearchSkipped.filtered`，与过滤框同一个数）。
 * 有它就不许说"这一处本来就没文件"：那里有文件，只是被扩展名挡在检索门外。
 */
export function scopeEmptyText(a: AppliedSearchScope, filtered = 0): string {
  const head = `「${a.label}」这一处没有进入检索的文件`;
  if (filtered > 0) {
    return `${head}：${filtered} 个文件因扩展名不符被跳过（改下面的扩展名试试），不是没有匹配`;
  }
  return `${head}（不是没有匹配，是这一处本来就没文件）`;
}

/** 范围完全落不进检索根：这条检索根本没发出去，要说人话 */
export function scopeUnreachableText(a: AppliedSearchScope): string {
  return `「${a.label}」不在当前项目的检索目录里，没有可检索的范围`;
}

/** 选择器已经换了、结果还是旧范围搜的：不许让两者共用一句读数 */
export function scopeStaleText(scopeKey: string, applied: AppliedSearchScope | null): string | null {
  if (applied === null || scopeKey === applied.key) return null;
  return scopeKey === ''
    ? `上面这份结果只来自「${applied.label}」；不限范围要重新搜索`
    : `范围已改动，重新搜索才生效`;
}

/** 悬浮提示：把实际进入检索的根原样列出来（宿主不理解它们，只是转述） */
export function scopeRootsTitle(a: AppliedSearchScope): string {
  return a.roots.length > 0 ? `本次检索的位置：\n${a.roots.join('\n')}` : '本次检索没有可用位置';
}
