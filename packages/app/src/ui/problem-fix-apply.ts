/**
 * 行内修复的 **Monaco 落地层**（P2-13）——把 `planLineEdits` 折好的改写计划认领到
 * 编辑器上真落一笔。
 *
 * 为什么独立成文件且由调用方**动态 import**：`applyTextEdits`（宿主 💡 的落地通道）
 * 静态挂着 Monaco，而 `ProblemPanel` 的静态模块图必须零 Monaco（`tests/ps6-rows.test.ts`
 * 在 node 里直接渲染本面板，Monaco 的模块图一加载就摸 `window`）。面板点击"修复"的
 * 那一刻才 `import()` 本文件——模块图干净照旧，落点纪律照旧。
 *
 * 判据**全部**住在别处，这里零判据：
 * - 计划（夹取 / 降序 / 单次落地）＝ `problem-fix.ts` 的 `planLineEdits`；
 * - 落地（Range 构造 / 一次 `executeEdits` / 撤销步）＝ `editor-global-providers.ts`
 *   的 `applyTextEdits`（宿主 💡 同一条通道，**不抄第二份**——预览看到的与落下的
 *   是同一件事的判据从根上成立）；
 * - 认领（哪个编辑器开着这个文件）＝ `editor-pane-registry.ts` 的活实例表。
 */

import { livePanes } from './editor-pane-registry';
import { applyTextEdits } from './editor-global-providers';
import type { PlannedLineEdit } from './problem-fix';

/**
 * 把改写计划落到 `path` 对应的 live model 上。
 *
 * 认领规则：在活实例表里找**打开表命中该路径**的编辑器（与 `openModelAcrossGroups`
 * 同一张表、同一条 `matchOpenedPath` 口径——"这个文件开在哪个组"只有一个答案）。
 * 命中却拿不到编辑器实例 / 文件根本没开 ⇒ `false`（调用方显式说"文件已不在打开的
 * 标签里"，不静默；铁律 4）。
 */
export function applyPlannedLineEdits(
  path: string,
  planned: readonly PlannedLineEdit[],
): boolean {
  if (planned.length === 0) return false;
  for (const ctx of livePanes.values()) {
    if (!ctx.entriesRef.current.has(path)) continue;
    const ed = ctx.editorRef.current;
    if (!ed) continue;
    const model = ed.getModel();
    if (!model || model.isDisposed()) continue;
    return applyTextEdits(ed, planned);
  }
  return false;
}
