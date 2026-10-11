/**
 * 升糖预览（前端透镜）宿主侧的**零 Monaco 纯逻辑**（可单测）。
 *
 * 定位（2026-10-12 升糖重定位批）：升糖只服务于"看"——把原生 ERB 片段在编辑器里
 * **折叠原文 + 就地打字机显示糖写法**，全程**不写盘**。本模块只做可测的算术与
 * 判定（区间归一、ViewZone 计划、只读判定），Monaco 交互留在 EditorPane。
 */

/** 是否原生 ERB（`.erb` / `.erm`）——默认只读预览对象（`.kojo` 不在此列） */
export function isErbLike(path: string): boolean {
  return /\.er[bm]$/i.test(path);
}

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