/**
 * 索引扫描根的合成（IDX-ROOT，2026-10-19）：`项目根（口上根 ∪ 只读基座库根）∪ 作者工作区全部根`。
 *
 * 为什么作者作品必须进索引：`我的口上项目` 里写的 `.ERB/.ERM/.ERH` 才是作者**正在编辑**
 * 的那一份，而五条语言服务腿（转到定义 / 查找引用 / 工作区符号 / 用量注解 / 实参提示）
 * 的判据只有一个——`ErbIndex`。根里只有游戏目录时，作者自己那份定义永远进不了名录，
 * 腿就一律"没有定义/没有引用"（不是报错，是**根本看不见**）。
 *
 * 为什么基座库也要进：口上域里的 `CALL` 大多指向口上域之外的基础库函数；只收
 * 口上根时，诊断会把整片基础库调用误报成「未定义的调用目标」。
 *
 * 三条口径都在这里，`plugin.ts` 只做接线：
 * 1. **判等一律走 `pathKey`**（折叠大小写与分隔符）：同一目录的两种写法是一个根，
 *    不折叠就会走两遍同一次遍历、同一份定义在 `byName` 里出现两次；
 * 2. **邻居不算命中**：`<根>-备份` 与 `<根>` 前缀相同、并不同一目录，该各走各的——
 *    这条边界语义归契约的 `isPathUnder`（分隔符边界），本模块**不许另抄一份**；
 * 3. **祖先折叠**：某根整体落在另一根之内时只留祖先那份（父遍历已覆盖子根的全部
 *    方言文件）。折叠判据只看集合本身、不看输入顺序 ⇒ 同一份盘不会因根序不同得到
 *    不同扫描面；而**顺序本身要保留**（项目根在前、工作区新增根在后）：文件按根序
 *    进入 `allFiles`，重排会让既有索引的定义次序跟着变，故签名是**有序**的。
 *
 * 零游戏名词（铁律 1）：这里只有泛型路径，没有任何游戏专有词。
 */

import { isPathUnder, pathKey } from '@kojo/plugin-api';

export interface ScanRootPlan {
  /** 折叠后的扫描根（kojo 根在前，工作区新增根在后） */
  readonly roots: string[];
  /** 被**精确去重**折掉的条数（pathKey 相同的重复根） */
  readonly duplicated: number;
  /** 被**祖先折叠**折掉的条数（整体已在另一保留根之内） */
  readonly nested: number;
}

/**
 * 合成扫描根：`projectRoots ∪ workspaceRoots`，先去重再折祖先。
 *
 * 空串 / 非字符串一律丢弃（平台侧给空根 = 没有这个根，不该让它把整盘遍历带成"根为空"
 * 的怪形态）。根的条数量级 < 20，O(n²) 的折叠不必上索引结构。
 */
export function planScanRoots(projectRoots: readonly string[], workspaceRoots: readonly string[]): ScanRootPlan {
  const candidates = [...projectRoots, ...workspaceRoots].filter((r) => typeof r === 'string' && r.length > 0);

  // 第一趟：pathKey 精确去重（保留**首次出现的写法**，顺序不变）
  const byKey = new Map<string, string>();
  let duplicated = 0;
  for (const r of candidates) {
    const k = pathKey(r);
    if (byKey.has(k)) {
      duplicated++;
      continue;
    }
    byKey.set(k, r);
  }
  const uniq = [...byKey.values()];

  // 第二趟：只留极大根。判等用 pathKey、包含用 isPathUnder（分隔符边界语义单源于契约）
  const keys = uniq.map((r) => pathKey(r));
  const roots: string[] = [];
  let nested = 0;
  for (let i = 0; i < uniq.length; i++) {
    const covered = keys.some((pk, j) => j !== i && pk !== keys[i] && isPathUnder(uniq[j]!, uniq[i]!));
    if (covered) nested++;
    else roots.push(uniq[i]!);
  }
  return { roots, duplicated, nested };
}

/**
 * 扫描根**签名**（活读比对用，2026-10-19 定案）。
 *
 * 今天没有「工作区根变更」的总线事件：授权发生在平台命令内（目录对话框与写进常驻根
 * 清单绑成原子动作），JS 侧只追加写闸 ⇒ 没有任何"根变了"的通知可订阅。
 * 对策不是新开事件，而是**在既有时刻活读比对**：构建起跑时记下签名，`ensureIndex()`
 * 与 `file.changed` 这些既有时刻重新合成并比一次，不一致就走 `generation++` + 异步重扫
 * + 既有广播（`kojo.functionChanged`）。
 *
 * 逐条 `pathKey` 后连接 ⇒ 折叠大小写/分隔符的**写法变体不算换根**（一次对话框重选同一
 * 目录不该引发整树重扫）；顺序变了算（见模块头注第 3 条）。
 */
export function rootsSignature(roots: readonly string[]): string {
  return roots.map((r) => pathKey(r)).join('\n');
}
