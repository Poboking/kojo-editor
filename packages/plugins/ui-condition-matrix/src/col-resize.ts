/**
 * 首列列宽拖拽用到的**几何测量件**（从 `index.ts` 的面板组件里原样迁出）。
 *
 * 只依赖滚动容器的最小形状（`./dom-shims` 的 `ScrollBox`），不碰 React 状态：
 *   - `toggleHandles`：拖拽中把整列把手的边界线点亮（直接改 DOM 类，不走 React state
 *     ——理由与实测数字写在调用侧）；
 *   - `measureColSnap`：量当前自然列宽 + 表宽，产出定宽接管的列宽快照。
 * 指针事件的捕获 / 钳制 / commit 仍由面板持有（那是它的会话级状态）。
 */

import type { ColSnap, ScrollBox } from './dom-shims';

/** 拖拽中把**整列**把手的边界线点亮（直接改 DOM 类，不走 React：理由见 onColDown 注释） */
export function toggleHandles(box: ScrollBox | null, on: boolean): void {
  const handles = box?.querySelectorAll('.cm-corner-resize');
  if (!handles) return;
  for (let i = 0; i < handles.length; i++) {
    if (on) handles[i]!.classList.add('cm-on');
    else handles[i]!.classList.remove('cm-on');
  }
}

/** 量当前自然列宽 + 表宽：相邻列（第二行子表头）左缘之差。整列按表宽归一 ⇒ 接管瞬间零漂移 */
export function measureColSnap(box: ScrollBox | null, key: string): ColSnap | null {
  const table = box?.querySelector('.cm-table');
  const subths = box?.querySelectorAll('.cm-subth');
  if (!table || !subths || subths.length === 0) return null;
  const tRect = table.getBoundingClientRect();
  const widths: number[] = [];
  let prevLeft = tRect.left;
  for (let i = 0; i < subths.length; i++) {
    const left = subths[i]!.getBoundingClientRect().left;
    widths.push(left - prevLeft);
    prevLeft = left;
  }
  widths.push(tRect.right - prevLeft);
  // 相邻列左缘之差的和与表宽有亚像素差（折叠边框重叠）：整列同比缩放对齐，
  // 使「快照列宽之和 === 表宽」严格成立 ⇒ 切定宽那一帧不会自己长胖 / 收窄。
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - tRect.width) > 0.5) {
    const k = tRect.width / sum;
    for (let i = 0; i < widths.length; i++) widths[i] = widths[i]! * k;
  }
  return { key, widths, tableW: tRect.width };
}
