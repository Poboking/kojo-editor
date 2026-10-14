/**
 * 糖视图（整文件「显示为糖」）宿主侧的**零 Monaco 纯逻辑**（可单测）。
 *
 * ## 这个功能是干什么的（一句话）
 *
 * **打开别人写的 ERB 口上，也能像看剧本一样读懂它。** ERB 是 Emuera 认识的格式，
 * 但 `PRINTFORMDW` / `%CALLNAME:MASTER%` / `ENDIF` 对不熟悉 EraBasic 的人是一堵墙；
 * 糖视图把整份文件投影成中文表层语法（`她点了点头。` / `如果 …：` / `{你}`），
 * 糖覆盖不到的行**原样留原代码**（少部分是必然，也是学习对照的锚点）。
 *
 * ## 纪律
 *
 * - **纯前端显示**：不改原文件一个字节（ERB 恒只读，见升糖重定位批 §1.1）；
 * - **本地算术**：区间归一 / ViewZone 计划 / 偏好读写都在这里，Monaco 交互留在
 *   `EditorPane`（与 `lift-preview.ts` 同款分层，便于单测钉死"不会插到第 0 行之前"）。
 */

/** 偏好键（壳层私事，localStorage；与布局同款——不进内核存储域） */
const PREF_KEY = 'kojo.ui.sugarView.v1';
/**
 * "已问过用户"标记键（与偏好分开存）。
 *
 * 为什么不让"偏好有值"兼任"已问过"：本轮引入了**首次打开 ERB 时的询问**，
 * 而偏好的缺省是"开"——若用偏好兼任，用户一继承默认值就等于"已问过"，
 * 询问永远不会出现。两个语义必须分开存。
 */
const PROMPTED_KEY = 'kojo.ui.sugarView.prompted.v1';

/**
 * 默认**开启**。
 *
 * 本功能的存在理由就是"打开别人的口上就能读懂"——默认关掉等于让最需要它的人
 * 先去发现一个按钮。而 ERB 已经恒只读，"默认显示成糖"不会干扰任何写工作流；
 * 想看原代码的读者一键（或按快捷键）即可切回，且**选择会被记住**。
 */
export const SUGAR_VIEW_DEFAULT = true;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（缺省 = `SUGAR_VIEW_DEFAULT`；读不到也回默认，绝不抛） */
export function loadSugarViewPref(): boolean {
  const s = storage();
  if (!s) return SUGAR_VIEW_DEFAULT;
  try {
    const raw = s.getItem(PREF_KEY);
    return raw === null ? SUGAR_VIEW_DEFAULT : raw === '1';
  } catch {
    return SUGAR_VIEW_DEFAULT;
  }
}

/** 写偏好（写不进去不算错：只影响下次启动的默认值，不影响本次会话） */
export function saveSugarViewPref(on: boolean): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话有效" */
  }
}

/**
 * 是否已经**问过**用户"要不要用语法糖视图"（首次打开 ERB 时问一次）。
 *
 * 无 `window`（测试 / 非浏览器）→ `true`（视作已问过，绝不弹窗——弹窗在无 UI 环境里
 * 没有意义，而且会让测试路径意外走到模态分支）。
 */
export function loadSugarViewPrompted(): boolean {
  const s = storage();
  if (!s) return true;
  try {
    return s.getItem(PROMPTED_KEY) === '1';
  } catch {
    return true;
  }
}

/** 记下"问过了"（无论用户选了开还是不开，都只问一次） */
export function saveSugarViewPrompted(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PROMPTED_KEY, '1');
  } catch {
    /* 同上：存不下只是下次还会问，不影响本次 */
  }
}

/** ViewZone 计划（插入点 + 高度；纯函数） */
export interface SugarZonePlan {
  /** 插入锚点行（ViewZone 显示在该行**之后**；0 = 文件顶部） */
  afterLineNumber: number;
  /** 占位高度（行数）：糖文本行数 + 1 行呼吸 */
  heightInLines: number;
  /** 糖文本行数 */
  lineCount: number;
}

/**
 * 去掉糖段**首尾**的空行，段内的空行原样保留。
 *
 * 为什么：投影器按原文行逐行映射，段首常带着一两行空行（原文的分隔空行）。落在
 * ViewZone 里就是"高亮块开头一大块空白"——读者读到的是"这段糖没内容"，
 * 而它离上一段代码之间本来就还有真实行距。段内空行是**分节**，不能动
 * （`fillSugarBlock` 特意给每行一个行框，就是为了空行也撑得住）。
 *
 * 全空的一段原样返回：那是"这段确实只有空行"的事实，交给骨架段那条路径处理，
 * 不在这里把内容删成零行（零行会让 ViewZone 高度与折叠柄算错）。
 */
export function trimSegmentBlanks(sugarText: string): string {
  const lines = sugarText.split('\n');
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim() === '') from++;
  while (to > from && lines[to - 1]!.trim() === '') to--;
  return from >= to ? sugarText : lines.slice(from, to).join('\n');
}

/**
 * 糖段 → ViewZone 计划。
 *
 * 锚点取 `fromLine - 1`：糖显示在**原文区间上方**，于是原文被隐藏后，糖正好落在
 * 它原来的位置（读者看到的位置不变，只是内容变成了人话）。`fromLine === 1` 时
 * 锚点落到 0（文件顶部），Monaco 接受。
 *
 * 高度比糖行数多 1 行是**呼吸位**：整文件模式下列与列之间若严丝合缝，长文件会
 * 糊成一片（对照 `lift-preview` 的逐条预览——那边有标题行，故多 2 行）。
 */
export function sugarZonePlan(segment: { fromLine: number; sugarText: string }): SugarZonePlan {
  const lineCount = segment.sugarText.split('\n').length;
  return {
    afterLineNumber: Math.max(0, segment.fromLine - 1),
    heightInLines: lineCount + 1,
    lineCount,
  };
}

/**
 * 编辑器**原生排版度量**（字体族 / 字号 / 行高 / 内容左边距），供糖视图把糖段渲染成
 * 与代码行**同貌同 rhythm**——这是「糖读起来就是文件本身」的前提（用户 2026-10-13 反馈：
 * 现效果「鸡肋、不对齐」）。
 *
 * 为什么必须实测而不是在 CSS 里写死：编辑器字号（本宿主 `fontSize: 14`）、行高（Monaco
 * 由字号派生，约 19px）、字体族、以及 gutter 之后的内容左边距都随配置 / 主题变化，
 * 写死的数字一改就过期：糖行与代码行字号不同、行高不同、文本列对不齐，长段还会顶穿
 * ViewZone 盒子被裁掉尾部。
 *
 * Monaco 0.57 的顶层导出面没有 `EditorOption` 枚举（取不了 `lineHeight` / `contentLeft`
 * 选项），于是直接问 DOM。但**问的必须是 `.view-line`（单数）而不是 `.view-lines`（容器）**：
 * Monaco 把 `height: Npx; line-height: Npx` **内联写在每一条行元素上**，容器 `.view-lines`
 * 的 CSS 里只有 `white-space: nowrap`，读它只会拿到继承来的 `normal`。（Monaco 自己在
 * `viewLines.css` 的注释里就写着 "view-lines in view-zones … they don't set a line height"
 * ——Zone 恰恰是唯一拿不到行高的那一层。）字号 / 字体族则相反：Monaco 对 `.view-lines` 整体
 * `applyFontInfo`，行元素继承之。
 *
 * 内容左边距（`contentLeftPx`）在**挂载后的 DOM** 上量：取某个 `.view-line` 文本左缘相对
 * ViewZone 容器（`.view-zones`，与 `.view-lines` 同属 `.lines-content` 的同一坐标系）左缘的
 * 差值。糖段 `wrap` 正是 `.view-zones` 的子节点、左缘与之对齐，把它作为 `.sugar-zone` 的
 * `padding-left`，糖文本左缘即与代码文本左缘重合——**不假设任何固定值**。
 *
 * 量不到（宿主未挂载 / 模型还没有任何一行 / 计算样式给 `normal`）时返回 `null` 字段，由 CSS
 * 兜底接手，不因此放弃整块糖。
 *
 * 为什么每项都留一份模块级缓存：`applySugarView` 紧跟在 `setModel` 之后跑，**首帧可能还没有
 * 任何 `.view-line`**，于是第一次量会扑空。全应用共用同一套字体设置（宿主写死 `fontSize: 14`），
 * 所以量到一次就可以一直用；不缓存的话，冷启动第一眼就是兜底值，切一次文件才正。
 */
export interface EditorNativeMetrics {
  /** 行高（px）；量不到 = null */
  lineHeightPx: number | null;
  /** 字号（px）；量不到 = null */
  fontSizePx: number | null;
  /** 字体族（computed `font-family`）；量不到 = null */
  fontFamily: string | null;
  /** 内容左边距（px）：代码文本左缘相对 ViewZone 坐标的偏移；量不到 = null */
  contentLeftPx: number | null;
}

let cachedLineHeightPx: number | null = null;
let cachedFontSizePx: number | null = null;
let cachedFontFamily: string | null = null;
let cachedContentLeftPx: number | null = null;

export function editorNativeMetrics(host: HTMLElement | null): EditorNativeMetrics {
  const line = host?.querySelector<HTMLElement>('.view-lines .view-line');
  if (line && typeof window !== 'undefined') {
    const cs = window.getComputedStyle(line);
    const lh = Number.parseFloat(cs.lineHeight);
    if (Number.isFinite(lh) && lh > 0) cachedLineHeightPx = lh;
    const fs = Number.parseFloat(cs.fontSize);
    if (Number.isFinite(fs) && fs > 0) cachedFontSizePx = fs;
    if (cs.fontFamily) cachedFontFamily = cs.fontFamily;
  }
  if (line) {
    const lineRect = line.getBoundingClientRect();
    const ref =
      host?.querySelector<HTMLElement>('.view-zones') ??
      host?.querySelector<HTMLElement>('.view-lines');
    // `lineRect.height > 0` = 这一行**真的渲染出来了**（未布局时 rect 全零，差值为 0 会污染缓存）
    if (ref && lineRect.height > 0) {
      const delta = lineRect.left - ref.getBoundingClientRect().left;
      if (Number.isFinite(delta) && delta >= 0) cachedContentLeftPx = delta;
    }
  }
  return {
    lineHeightPx: cachedLineHeightPx,
    fontSizePx: cachedFontSizePx,
    fontFamily: cachedFontFamily,
    contentLeftPx: cachedContentLeftPx,
  };
}

/**
 * 是否需要把糖段盒高从 `heightInLines` **估算**改成**实测**（`heightInPx`）。
 *
 * 口径：**只放大、不缩小**——`heightInLines` 里含的呼吸位与折叠柄行是刻意留白，不能被
 * 实测内容压掉（那会让段与段贴到一起）；只有当折行后的内容比估算高（差 ≥ 半行高）时才
 * 重设，阈值取半行高是为了避免亚像素抖动引发的反复重排。
 *
 * 纯函数（单测钉死）：宿主在分帧填充后用 `wrap.scrollHeight` 实测内容高，与
 * `heightInLines × 行高` 比，命中即 `removeZone` + `addZone({ heightInPx })` 重新落高。
 */
export function needsZoneRelayout(
  allocatedPx: number,
  measuredPx: number,
  lineHeightPx: number,
): boolean {
  if (!Number.isFinite(measuredPx) || measuredPx <= 0) return false;
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) return false;
  return measuredPx - allocatedPx >= lineHeightPx / 2;
}

/**
 * 工具条的糖视图摘要（面向作者，中文；**不含内部术语**）。
 *
 * 术语口径：「映射」是投影器的内部说法，作者词表里没有它——他看到的是"这文件有多少
 * 变成了人话"。所以读数只给「语法糖 N 行」（与紧邻的开关按钮呼应，不必重复动词），
 * 完整解释交给悬停 `title`。
 *
 * 只报**已覆盖**的行数，不报"未覆盖多少行"：未覆盖的行里既有真正的原生代码，也有
 * 注释与空行——把它们加总成一项会让人以为漏了什么。逐因明细**只存在于工具条的悬停
 * `title`**（批 A 已按用户口径删除「升糖」面板，别再往面板上指）。
 */
export function sugarSummary(projectedLines: number, hiddenLines = 0): string {
  // 反馈 5 / ADR-0006 §4「不静默」：收起了多少行必须同屏可见；0 时不提后半句（那是假承诺）
  const base = `语法糖 ${projectedLines} 行`;
  return hiddenLines > 0 ? `${base}｜已收起 ${hiddenLines} 行（可展开）` : base;
}

/**
 * **糖视图可用门**（ADR-0005：目录分野 × 显式解锁 两道正交轴的派生判定
 * ＋封存总闸一条最高优先级否决轴）。
 *
 * 铁律只有一条：**同一份文件不能一边被改、一边被投影**——糖视图靠"原文让位"工作
 * （ViewZone + 隐藏区间），可编辑的原文必须始终看得见，否则用户改到自己看不见的行。
 * 于是可用门由"可编辑态"派生，而不是另立一套开关：
 *
 * | 文件 | 可编辑性（轴一 / 轴二） | 糖视图 |
 * |---|---|---|
 * | `.kojo` | 恒可编辑（糖源码） | **否**——本身就是糖，再投影一遍没有意义 |
 * | 工作区内 `.ERB` | **恒可编辑**（作者的创作源文件） | **否**——自己正在写的东西看投影没有意义，要写糖请直接写 `.kojo` |
 * | 游戏目录 `.ERB` | 默认只读（写保护铁律） | **是**——本功能的主场景：读懂别人的口上 |
 * | 游戏目录 `.ERB` 已解锁 | 这一次可写（轴二的破例） | **否**——回到互斥规则 |
 *
 * 封存总闸（`sealed.ts`）是**最高优先级**的一条轴：封存优先于一切（用户
 * 2026-10-13 试用反馈批——糖视图现效果整件封存，默认隐藏）——封存态下无论文件
 * 落在上表哪一格都不可用；解封后按上表原口径恢复。
 *
 * 纯函数：宿主用它同时门控"自动应用"、"首次询问"与工具条入口，三处口径不会分叉。
 */
export function sugarViewAllowed(input: {
  isErbLike: boolean;
  inWorkspace: boolean;
  unlocked: boolean;
  /** 封存总闸（sealed.ts）：true = 已封存（最高优先级，直接否决） */
  sealed: boolean;
}): boolean {
  if (input.sealed) return false;
  if (!input.isErbLike) return false;
  if (input.inWorkspace) return false;
  if (input.unlocked) return false;
  return true;
}
