import type { EditorWorkspaceSymbol, ErbIndex } from '@kojo/plugin-api';

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
 *   所以上限是渲染预算，不是把结果丢掉（铁律 4）。
 * - **名字命中与路径命中天然不相交**：路径段**跳过**名字已命中的函数，于是两段
 *   结果无需去重集（10 万条的 `Set` 插入本身就是一次可感代价）。
 * - **空查询不给全表**：返回空。VSCode 的 `Ctrl+T` 同样是"先打字再出项"；
 *   宿主此时显示提示文案，不是"按了没反应"。
 *
 * ## 匹配口径
 *
 * 归一化用 `toUpperCase()`（与 `ErbFunction.normalizedName` 同源：Emuera 函数名
 * **大小写不敏感**，索引键本就是大写形态）。中文函数名不受大小写影响，因此
 * 中文名与原生大写名走同一条 `includes`——这是本域最高频的检索入口，两者都必须
 * 查得到（逐条断言在测试里）。
 */

/** 提供方侧缺省产出预算（宿主另给 `limit` 时以宿主为准） */
export const DEFAULT_WORKSPACE_SYMBOL_LIMIT = 200;

/** 一次查询的产出：至多 `limit` 条 + **命中总数**（可更大 = 被预算截断） */
export interface WorkspaceSymbolQueryResult {
  readonly symbols: readonly EditorWorkspaceSymbol[];
  readonly totalMatched: number;
}

const NO_RESULT: WorkspaceSymbolQueryResult = { symbols: [], totalMatched: 0 };

/**
 * 按查询串在索引里找符号定义。
 *
 * 排序（调用方拿到的**即最终顺序**）：精确名 → 前缀名 → 含子串的名 → 仅路径命中；
 * 同桶内保持索引插入序（确定序，重跑一致）。
 * 空 / 全空白查询 → 空结果（见头注「空查询不给全表」）。
 */
export function workspaceSymbolsInIndex(
  index: ErbIndex,
  query: string,
  limit: number = DEFAULT_WORKSPACE_SYMBOL_LIMIT,
): WorkspaceSymbolQueryResult {
  const norm = query.trim().toUpperCase();
  if (norm.length === 0) return NO_RESULT;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_WORKSPACE_SYMBOL_LIMIT;

  /* ---- 第一段：名字命中（`byName` 键，一趟线性扫） ---- */
  const exact: EditorWorkspaceSymbol[] = [];
  const prefix: EditorWorkspaceSymbol[] = [];
  const contains: EditorWorkspaceSymbol[] = [];
  let nameMatched = 0;
  for (const [key, refs] of index.byName) {
    // 一次 `includes` 挡掉绝大多数键（实测比"先比相等再比前缀"省一半——热路径是**不命中**的那条）
    if (!key.includes(norm)) continue;
    const bucketRank = key === norm ? 0 : key.startsWith(norm) ? 1 : 2;
    nameMatched += refs.length;
    const bucket = bucketRank === 0 ? exact : bucketRank === 1 ? prefix : contains;
    // 桶满 = 预算用完；后面只累计总数，不再造对象
    if (bucket.length >= cap) continue;
    for (const ref of refs) {
      if (bucket.length >= cap) break;
      bucket.push({
        kind: 'function',
        name: ref.name,
        filePath: ref.filePath,
        line: ref.startLine,
      });
    }
  }
  const nameHits = [...exact, ...prefix, ...contains].slice(0, cap);

  /* ---- 第二段：路径命中（命中文件名/目录、但**名字没命中**的那些函数） ---- */
  const pathHits: EditorWorkspaceSymbol[] = [];
  let pathMatched = 0;
  for (const [path, file] of index.files) {
    if (!path.toUpperCase().includes(norm)) continue;
    for (const fn of file.functions) {
      // 与第一段互斥：名字已命中的定义在上一段给过了（省掉一个 10 万级 Set）
      if (fn.normalizedName.includes(norm)) continue;
      pathMatched++;
      if (pathHits.length >= cap) continue;
      pathHits.push({ kind: 'function', name: fn.name, filePath: fn.filePath, line: fn.startLine });
    }
  }

  return {
    symbols: [...nameHits, ...pathHits].slice(0, cap),
    totalMatched: nameMatched + pathMatched,
  };
}
