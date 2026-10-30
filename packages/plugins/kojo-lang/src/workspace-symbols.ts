/**
 * `workspaceSymbol` 供方（ERB-PARITY G4，2026-10-31）——`Ctrl+T` 里的 2.0 符号。
 *
 * ## 判据从哪来
 *
 * 与文档大纲**同一份事实**：`@kojo/kojo-lang/symbols` 的 `kojo2DocumentSymbols`（纯函数，
 * 一次 `lex + parse`）。本模块不新写"什么算符号"——只把一堆文件里的平铺事实摊成
 * 契约的 `EditorWorkspaceSymbol`，再按宿主给的查询串筛、按契约的桶序排。
 *
 * ## 文件从哪来（这条腿与 ERB 唯一的形态差异）
 *
 * 工作区符号请求**没有文件**（契约如此：问题问的是"整个工作区谁叫这个名字"）。ERB 的索引
 * 由解析器插件自持，所以它不需要外来的文件；2.0 的项目索引是**宿主**缓存（扫描喂进来的
 * 文本），插件既拿不到它、也不许读盘 ⇒ 宿主把文件快照当**数据**随请求递进来
 * （`EditorWorkspaceSymbolRequest.projectFiles`，additive）。
 *
 * 快照缺席 ⇒ **弃权**（`undefined`），不是空作答：那表示"这轮没有名录"，不是"项目里没有
 * 这个名字"（铁律 4：两者都必须能从屏上分辨出来，前者由宿主的空结果文案说）。
 *
 * ## 匹配口径（与 ERB 那条腿同形，不做第二套）
 *
 * - 大小写不敏感（`toUpperCase` 两侧归一；中文不受影响）的子串命中，名字优先、**路径次之**
 *   （与 `erb-parser/workspace-symbols.ts` 的两段扫描同义：名字已命中的文件不再按路径展开）；
 * - 排序走契约层的 `candidateRank`（与宿主 `pickWorkspaceSymbols` 同一个比较器），桶内保持
 *   源码序；宿主不再重排；
 * - 产出预算 = `candidateBudget('providerQuery', limit)`，**命中总数照常报**（`totalMatched`
 *   可大于产出条数 —— 上限是渲染预算，不是把结果丢掉）；
 * - 空 / 全空白查询 → 空作答（"先打字再出项"，与 ERB 腿同一条）。
 *
 * ## 缓存（同文本命中，不改变任何判据）
 *
 * `Ctrl+T` 每击键问一次，而每份文本的符号事实只取决于文本本身。本模块按路径记一份
 * `{text, facts}`，**文本逐字相同才命中**（不同就重算）——所以它不会让两次不同输入给出
 * 不同的答案，只是不再对同一份文本重复 `lex + parse`。表有上限（超出整体清空，不做 LRU：
 * 一次冷启动的代价远小于维护淘汰序的复杂度）。
 */
import type {
  EditorLanguageServiceRequest,
  EditorWorkspaceSymbol,
  EditorWorkspaceSymbolResult,
} from '@kojo/plugin-api';
import { CANDIDATE_BUDGETS, candidateBudget, candidateRank } from '@kojo/plugin-api';
import { kojo2DocumentSymbols, type Kojo2SymbolFact } from '@kojo/kojo-lang/symbols';
import { isKojo2Request } from './request';
import { editorSymbolKindOf } from './symbols';

/** 提供方侧缺省产出预算（宿主另给 `limit` 时以宿主为准；档位单源 `CANDIDATE_BUDGETS`） */
export const DEFAULT_KOJO2_WORKSPACE_SYMBOL_LIMIT = CANDIDATE_BUDGETS.providerQuery;

/** 逐文件符号事实的缓存条目（文本逐字相同才复用） */
interface FactsEntry {
  readonly text: string;
  readonly facts: readonly Kojo2SymbolFact[];
}

/** 缓存上限（条目数；超出整体清空——见模块头「缓存」） */
const FACTS_CACHE_MAX_ENTRIES = 512;

const factsCache = new Map<string, FactsEntry>();

/** 一份文本的符号事实（同文本命中缓存；解析抛错 ⇒ 空事实，不让一家文件带走整条腿） */
function factsOf(path: string, text: string): readonly Kojo2SymbolFact[] {
  const cached = factsCache.get(path);
  if (cached !== undefined && cached.text === text) return cached.facts;
  let facts: readonly Kojo2SymbolFact[];
  try {
    facts = kojo2DocumentSymbols(text);
  } catch {
    facts = [];
  }
  if (factsCache.size >= FACTS_CACHE_MAX_ENTRIES) factsCache.clear();
  factsCache.set(path, { text, facts });
  return facts;
}

/** 测试用：清空缓存（生产不需要——缓存不改变任何答案） */
export function clearKojo2WorkspaceSymbolCache(): void {
  factsCache.clear();
}

/**
 * 交回 `{ kind: 'workspaceSymbol', symbols, totalMatched }`，或 `undefined`（弃权）。
 *
 * 弃权有三种，都不是"没有匹配"：不是 `workspaceSymbol` 请求 / 没有项目文件快照 /
 * 快照里**一枚 2.0 源都没有**（这个查询不归本插件答——例如纯 ERB 项目）。
 */
export function provideWorkspaceSymbols(
  request: EditorLanguageServiceRequest,
): EditorWorkspaceSymbolResult | undefined {
  if (request.kind !== 'workspaceSymbol') return undefined;
  const files = request.projectFiles;
  if (files === undefined) return undefined; // 没有名录 = 弃权（不答"没有匹配"）
  const sources: { readonly path: string; readonly text: string }[] = [];
  for (const file of files) {
    if (typeof file.path !== 'string' || file.path.length === 0) continue;
    if (typeof file.text !== 'string') continue;
    if (!isKojo2Request({ path: file.path })) continue;
    sources.push({ path: file.path, text: file.text });
  }
  if (sources.length === 0) return undefined; // 这个项目里没有 2.0 源：不抢答

  const query = request.query;
  const norm = query.trim().toUpperCase();
  if (norm.length === 0) return { kind: 'workspaceSymbol', symbols: [], totalMatched: 0 };
  const cap = candidateBudget('providerQuery', request.limit ?? DEFAULT_KOJO2_WORKSPACE_SYMBOL_LIMIT);

  /** 五个排序桶（`candidateRank` 的取值域）；桶内保持源码序 */
  const buckets: EditorWorkspaceSymbol[][] = [[], [], [], [], []];
  let matched = 0;
  for (const source of sources) {
    const facts = factsOf(source.path, source.text);
    const pathHit = source.path.toUpperCase().includes(norm);
    for (const fact of facts) {
      const nameHit = fact.name.toUpperCase().includes(norm);
      // 名字与路径两段互斥（名字已命中的不在路径段重复计），与 ERB 腿同一条
      if (!nameHit && !pathHit) continue;
      matched++;
      const bucket = buckets[candidateRank(fact.name, source.path, query)]!;
      if (bucket.length >= cap) continue; // 桶满 = 只计数不造对象
      bucket.push({
        name: fact.name,
        kind: editorSymbolKindOf(fact.kind),
        filePath: source.path,
        line: fact.selectionRange.startLine,
        column: fact.selectionRange.startColumn,
        ...(fact.detail.length > 0 ? { detail: fact.detail } : {}),
      });
    }
  }
  const ranked = buckets.flat();
  return {
    kind: 'workspaceSymbol',
    symbols: ranked.slice(0, cap),
    // 命中总数是**这一份快照里**的读数。快照不完整（宿主截断）时它是一个**下界**——
    // 本模块不替被截掉的文件编数字，也不把"没看到"说成"项目里只有这些"（铁律 4）。
    totalMatched: matched,
  };
}