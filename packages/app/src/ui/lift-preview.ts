/**
 * 升糖预览（前端透镜）宿主侧的**零 Monaco 纯逻辑**（可单测）。
 *
 * 定位（2026-10-12 升糖重定位批）：升糖只服务于"看"——把原生 ERB 片段在编辑器里
 * **折叠原文 + 就地打字机显示糖写法**，全程**不写盘**。本模块只做可测的算术与
 * 判定（区间归一、ViewZone 计划、只读判定），Monaco 交互留在 EditorPane。
 */

import { isErbDialectPath } from '@kojo/plugin-api';

/**
 * ERB 方言扩展名 / 谓词的**单一真源**在 `@kojo/plugin-api/erb-ext`（FT-2 收口，2026-10-14）：
 * 这里只留一个**同义别名**给 EditorPane 的既有读法，判定逻辑零副本。
 *
 * 口径自本批起**含 `.ERH`**（引擎预载白名单认它、盘上实测口上根内 31 份，内容只有
 * `#DIM` / `#DIMS`）——所以"是否只读预览对象"这条轴与"是否进索引"这条轴**必须同源**，
 * 否则就是"索引里有、面上开不了"的分裂。
 */
export function isErbLike(path: string): boolean {
  return isErbDialectPath(path);
}

/**
 * 编辑器只读门已搬去 `monaco/language-guard.ts`（ERB-PARITY G6）：它的语言面判据是
 * descriptor 声明（`gameDirReadOnly`），要读语言注册表——而本模块在**开机图**内
 * （`ShellLayout → file-area` 这条边），把表拖到首屏是 PS-10 字节闸不许的事。
 * 这里只留升糖预览自己的"是不是 ERB 方言"（`isErbLike`）。
 */

/** ViewZone 计划（插入点 + 高度；纯函数，便于断言"不会把预览插到第 0 行之前"） */
export interface LiftZonePlan {
  /** 插入锚点行（ViewZone 显示在该行**之后**；0 = 文件顶部） */
  afterLineNumber: number;
  /** 占位高度（行数）：糖文本行数 + 标题行 + 留白 */
  heightInLines: number;
  /** 糖文本行数 */
  lineCount: number;
}

/**
 * 由预览项推导 ViewZone 计划。
 *
 * 锚点取 `fromLine - 1`：预览显示在**原文区间上方**，于是"糖在上、原 ERB 在下"
 * 与用户预期一致（折叠时只见糖，展开时糖 + 原文同现）。`fromLine === 1` 时锚点
 * 落到 0（文件顶部），Monaco 接受。
 */
export function liftZonePlan(item: { fromLine: number; sugarText: string }): LiftZonePlan {
  const lineCount = item.sugarText.split('\n').length;
  return {
    afterLineNumber: Math.max(0, item.fromLine - 1),
    heightInLines: lineCount + 2,
    lineCount,
  };
}

/**
 * 区间归一（夹到 [1, maxLine]，并保证 from ≤ to）。
 * 越界输入来自"预览供给与执行之间用户又编辑了"的竞态——夹取而非报错，
 * 保证前端预览不因陈旧行号而崩。
 */
export function clampRange(
  fromLine: number,
  toLine: number,
  maxLine: number,
): { fromLine: number; toLine: number } {
  const m = Math.max(1, maxLine);
  const from = Math.min(Math.max(1, Math.trunc(fromLine) || 1), m);
  const to = Math.min(Math.max(from, Math.trunc(toLine) || from), m);
  return { fromLine: from, toLine: to };
}