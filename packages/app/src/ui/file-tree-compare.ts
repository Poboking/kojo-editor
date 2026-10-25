/**
 * 「比较已选文件」→ `ui.diffView.open` 载荷的**唯一构造点**（D 批 · 双文件比较）。
 *
 * 判据只有一条：这里只把两条路径折成既有 diff 意图的载荷，**不读盘、不建视图、不写盘**
 * ——两侧内容由 `DiffViewOverlay.resolveSide` 经内核 `io.readText` / `readBytes` 现读
 * （见 `diff-view.ts` / `DiffViewOverlay.tsx`）。
 *
 * ## 两侧内容来源口径 = **盘上版本**（本批显式定档，可测）
 *
 * 载荷两侧**只给 `path`、不给 `text`** ⇒ 差异视图读的恒是磁盘上那一份：
 * - 某侧在编辑器里有未保存修改时，比较的是**盘上版本**，不是屏上缓冲——Compare
 *   Selected 对标的是"这两份文件",不是"我还没存的两个草稿"；
 * - 与「与剪贴板比较」刻意相反（那一条右=剪贴板、左=屏上 `model.getValue()`，比的是
 *   "我此刻写的东西"）——两条入口回答的是不同问题，故两侧给的东西也不同，别互抄。
 *
 * 取路径侧还有个附带好处：`DiffViewOverlay` 在读取时会顺手取原始字节，判等核的**字节态**
 * （编码 / 换行风格差异）因此有得判，不会因为"两侧都只有行文本"而把编码差异吞掉。
 */
import type { KernelEventMap } from '@kojo/plugin-api';
import { baseName } from './file-tree-model';
import { relativeToRoot } from './file-tree-ops';

/** 意图来源标识（总线日志与测试据此认这条通道） */
export const COMPARE_FILES_SOURCE = 'host:file-tree-compare';

/**
 * 两条已选文件路径 → diff 意图载荷。
 *
 * `left` = 先勾选那一份（原 / 参照侧），`right` = 后勾选那一份（对照侧）——顺序由
 * `file-tree-multi-selection` 的插入序决定，这里不再排序。
 *
 * 标签：有项目根 ⇒ 显示**相对项目根的路径**（读的人一眼知道在哪）；无根（工作区外拖入等）
 * ⇒ 退回文件名（`relativeToRoot` 自带"不在根下原样返回完整路径"的兜底，不会给半截路径）。
 * 标题用两份文件名，便于多处比对时标签条能区分。
 */
export function compareSelectedRequest(
  left: string,
  right: string,
  rootDir?: string,
): KernelEventMap['ui.diffView.open'] {
  const label = (path: string): string => (rootDir === undefined ? baseName(path) : relativeToRoot(path, rootDir));
  return {
    title: `比较已选文件：${baseName(left)} ⇄ ${baseName(right)}`,
    original: { label: label(left), path: left },
    modified: { label: label(right), path: right },
    source: COMPARE_FILES_SOURCE,
  };
}