/**
 * 糖视图的折叠与展开（零 React / 零 monaco，2026-10-13 UI 反馈 5）。
 *
 * 用户报「点糖视图下面展开被折叠的 ERB 原文，功能是失效的」——读代码的结论更诚实：
 * **那个控件从来没有被实现过**。糖视图把已投影区间的原文整批 `setHiddenAreas` 藏起来，
 * 而段区的 `<pre>` 是个纯展示节点，没有任何监听器；`lineCount === 0` 的骨架段更是
 * **只藏不显**——原文不见了，界面上连一处痕迹都没有。
 *
 * 这与 ADR-0006 的三条口径直接冲突：「收起 ≠ 删除」「折叠处留一行可读的占位」
 * 「折叠数可见、可整体关掉」。本模块只做**可判定的算术**（该藏哪些行、某段现在什么状态、
 * 占位行该写什么），渲染与事件仍留在宿主组件里——这样这几条判据才有尺子可管。
 *
 * 边界：本模块**不决定什么可以被折叠**（那是投影 `sugar.lift` 的口径，归语法糖组），
 * 它只负责"已经决定要收起来的每一段，都必须能被读者原地展开"。
 */

/** 一个可折叠段（来自投影的最小形状，不依赖契约类型以便单测） */
export interface FoldableSegment {
  /** 稳定键：段位置变了就该换键（由调用方按 `fromLine:toLine` 生成） */
  readonly key: string;
  readonly fromLine: number;
  readonly toLine: number;
  /** 投影出来的糖行数；0 = 只藏不显的骨架段（包装三联 / 信封之类） */
  readonly lineCount: number;
}

/** 区间端点（1 基行号，闭区间） */
export interface HiddenRange {
  readonly fromLine: number;
  readonly toLine: number;
}

/** 段键：位置即身份（同一份文件里两个段不会撞，位置变了就是另一段） */
export function foldKey(fromLine: number, toLine: number): string {
  return `${fromLine}:${toLine}`;
}

/**
 * 当前应该被藏起来的原文区间。
 *
 * 展开的段落**整段退出隐藏**——不是"隐藏到一半"，因为半隐藏会让读者看到断头代码。
 */
export function hiddenRanges(segments: readonly FoldableSegment[], expanded: ReadonlySet<string>): HiddenRange[] {
  const out: HiddenRange[] = [];
  for (const s of segments) {
    if (expanded.has(s.key)) continue;
    out.push({ fromLine: s.fromLine, toLine: s.toLine });
  }
  return out;
}

/** 展开态切换（返回新集合，不改入参——ViewZone 批次里要用不可变语义） */
export function toggleFolded(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * 已收起的行数（只算**真的没有糖区可看**的段之外的隐藏行）。
 *
 * 口径：糖区存在时，原文被糖文本"替代"，行数按被替掉的原文行数计；
 * `lineCount === 0` 的骨架段同样是原文行数——它只是没有替代文本。
 */
export function hiddenLineCount(segments: readonly FoldableSegment[], expanded: ReadonlySet<string>): number {
  let n = 0;
  for (const s of segments) {
    if (expanded.has(s.key)) continue;
    n += Math.max(0, s.toLine - s.fromLine + 1);
  }
  return n;
}

/** 骨架段（只藏不显）——它们**必须**得到一行占位，否则等于对读者静默删码 */
export function skeletonSegments(segments: readonly FoldableSegment[]): FoldableSegment[] {
  return segments.filter((s) => s.lineCount === 0);
}

/** 折叠柄文案：展开前说清"这里收了多少行"，展开后给一个反向动作 */
export function foldLabel(seg: FoldableSegment, isExpanded: boolean): string {
  const lines = Math.max(0, seg.toLine - seg.fromLine + 1);
  return isExpanded ? `收起原文（${lines} 行）` : `展开原文（${lines} 行）`;
}

/** 占位行文案（骨架段专用：没有糖文本可看，读者只剩这一行提示） */
export function skeletonLabel(seg: FoldableSegment, isExpanded: boolean): string {
  const lines = Math.max(0, seg.toLine - seg.fromLine + 1);
  return isExpanded ? `收起这段代码（${lines} 行）` : `此处 ${lines} 行代码已收起 · 点击展开`;
}
