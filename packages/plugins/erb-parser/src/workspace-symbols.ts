import type { EditorWorkspaceSymbol, ErbIndex, ErbScopeStamp } from '@kojo/plugin-api';
import { CANDIDATE_BUDGETS, candidateBudget, candidateRank, pathInScope } from '@kojo/plugin-api';

/**
 * 工作区符号查询（D2，2026-10-15 工作区符号批）——`byName` 的**只读投影**。
 *
 * ## 为什么判据只能住在这里
 *
 * "工作区里谁叫这个名字"的唯一真源是 `ErbIndex.byName`（归一化名 → 定义列表），
 * 而索引的主人只有解析器。放进宿主 = 宿主得认识 ERB 的名字口径；放进别的插件 =
 * 同一份判据抄第二遍。所以本模块是**纯函数**（索引进、符号出，不读盘不写盘），
 * 注册成 `ui.editor.languageService` 的 `workspaceSymbol` 应答方即可。
 *
 * ## 十万条名字的钱怎么花（实测见 `tests/workspace-symbols.test.ts`）
 *
 * 语料规模 99,104 个函数 / 2,316 个文件，故**一次查询只允许两趟线性扫**：
 * 1. `byName` 键（≈ 名字总数）——一次 `includes`，命中才展开 refs；
 * 2. `files` 键（≈ 文件数）——一次 `includes`，命中才展开该文件的 functions。
 *
 * 三条纪律都为此而设：
 * - **产出预算**（`limit`）：命中桶满后只**计数不再造对象**（计数是 `++`，造对象是
 *   字符串拼接 + 对象分配，量级差一个数量级）；总数照常给宿主显示"另有 N 条未列出"，
 *   所以上限是渲染预算，不是把结果丢掉（铁律 4）。预算档位与兜底单源
 *   `CANDIDATE_BUDGETS` / `candidateBudget`（W7 NAV-SCOPE：此前 100/200/200/50 四个
 *   裸数字分散在四个文件里，谁是谁的上一档没人说得出）。
 * - **名字命中与路径命中天然不相交**：路径段**跳过**名字已命中的函数，于是两段
 *   结果无需去重集（10 万条的 `Set` 插入本身就是一次可感代价）。
 * - **空查询不给全表**：返回空。VSCode 的 `Ctrl+T` 同样是"先打字再出项"；
 *   宿主此时显示提示文案，不是"按了没反应"。
 *
 * ## 排序与范围（W7 NAV-SCOPE）
 *
 * - **比较器只有一份**：桶序由 `candidateRank`（契约层）给出，宿主 `pickWorkspaceSymbols`
 *   用同一个函数——两侧同桶同序，宿主不再"按自己的口径重排一次"。
 * - **范围戳只有一份**：`scope` 参数（宿主给的当前选择）或 `index.scope`（同一选择
 *   的派生索引视图）走同一个 `pathInScope`；范围外的定义不进产出**也不进命中总数**。
 *
 * ## 匹配口径
 *
 * 归一化用 `toUpperCase()`（与 `ErbFunction.normalizedName` 同源：Emuera 函数名
 * **大小写不敏感**，索引键本就是大写形态）。中文函数名不受大小写影响，因此
 * 中文名与原生大写名走同一条 `includes`——这是本域最高频的检索入口，两者都必须
 * 查得到（逐条断言在测试里）。
 */

/** 提供方侧缺省产出预算（宿主另给 `limit` 时以宿主为准；档位单源 `CANDIDATE_BUDGETS`） */
export const DEFAULT_WORKSPACE_SYMBOL_LIMIT = CANDIDATE_BUDGETS.providerQuery;

/** 一次查询的产出：至多 `limit` 条 + **命中总数**（可更大 = 被预算截断） */
export interface WorkspaceSymbolQueryResult {
  readonly symbols: readonly EditorWorkspaceSymbol[];
  readonly totalMatched: number;
  /**
   * 本次查询**实际生效**的范围戳（W7 NAV-SCOPE）。
   * `null` = 未收窄。原样回显给宿主：面板要能说"这轮只看了哪个范围"，
   * 而那句范围话只能由真正按它过滤过的那一侧给出（宿主自己再说一遍就是第二份口径）。
   */
  readonly scope: ErbScopeStamp | null;
}

const NO_RESULT: WorkspaceSymbolQueryResult = { symbols: [], totalMatched: 0, scope: null };

/**
 * 按查询串在索引里找符号定义。
 *
 * 排序（调用方拿到的**即最终顺序**）：走契约里那一份 `candidateRank`
 * （精确名 → 前缀名 → 名含子串 → 仅路径命中 → 认不出；四通道同一个比较器，
 * 同桶内保持索引插入序 = 确定序，重跑一致）。
 * 空 / 全空白查询 → 空结果（见头注「空查询不给全表」）。
 *
 * **范围收窄发生在扫描当时**（`scope.roots` 或索引自带的 `index.scope` 戳，后者是
 * 前者的派生视图 ⇒ 同一个判据）：范围外的定义**连计数都不进** `totalMatched`——
 * 把"被范围挡掉的"报成"溢出未列出"是假读数（铁律 4）。
 */
export function workspaceSymbolsInIndex(
  index: ErbIndex,
  query: string,
  limit: number = DEFAULT_WORKSPACE_SYMBOL_LIMIT,
  scope?: ErbScopeStamp | null,
): WorkspaceSymbolQueryResult {
  const norm = query.trim().toUpperCase();
  const stamp = scope ?? index?.scope ?? null;
  const roots = stamp?.roots ?? [];
  if (norm.length === 0 || !index) return { ...NO_RESULT, scope: stamp };
  const cap = candidateBudget('providerQuery', limit);

  /** 五个排序桶（`candidateRank` 的取值域）；桶内保持插入序 */
  const buckets: EditorWorkspaceSymbol[][] = [[], [], [], [], []];
  let matched = 0;

  /* ---- 第一段：名字命中（`byName` 键，一趟线性扫） ---- */
  // 走 `keys()` + 命中后再 `defsOf()`，**不要** `entries()`：后者会为全部 11 万个名字
  // 各造一组 `ErbFunctionRef` 数组（本查询是热路径，命中通常个位数）。
  for (const key of index.byName.keys()) {
    // 一次 `includes` 挡掉绝大多数键（实测比"先比相等再比前缀"省一半——热路径是**不命中**的那条）
    if (!key.includes(norm)) continue;
    for (const ref of index.byName.defsOf(key)) {
      // 命中总数与产出**同一条范围判据**（`pathInScope` 单源），不在范围内的一条都不算
      if (!pathInScope(ref.filePath, roots)) continue;
      matched++;
      // `candidateRank` 的取值域闭集 0..4，与 `buckets` 逐一对应（越界是契约破口，不是这里的分支）
      const bucket = buckets[candidateRank(ref.name, ref.filePath, query)]!;
      // 桶满 = 预算用完；后面只累计总数，不再造对象
      if (bucket.length >= cap) continue;
      bucket.push({
        kind: 'function',
        name: ref.name,
        filePath: ref.filePath,
        line: ref.startLine,
      });
    }
  }

  /* ---- 第二段：路径命中（命中文件名/目录、但**名字没命中**的那些函数） ---- */
  for (const [path, file] of index.files) {
    if (!path.toUpperCase().includes(norm)) continue;
    if (!pathInScope(path, roots)) continue;
    for (const fn of file.functions) {
      // 与第一段互斥：名字已命中的定义在上一段给过了（省掉一个 10 万级 Set）
      if (fn.normalizedName.includes(norm)) continue;
      matched++;
      const bucket = buckets[candidateRank(fn.name, fn.filePath, query)]!;
      if (bucket.length >= cap) continue;
      bucket.push({ kind: 'function', name: fn.name, filePath: fn.filePath, line: fn.startLine });
    }
  }

  const ranked = buckets.flat();
  return {
    symbols: ranked.slice(0, cap),
    totalMatched: matched,
    scope: stamp,
  };
}
