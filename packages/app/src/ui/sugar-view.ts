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
 * 读编辑器**实测**行高（px），供 `.sugar-zone` 与代码行同 rhythm。
 *
 * 为什么必须实测而不是在 CSS 里写死：`heightInLines` 换算成的盒子高是
 * `行数 × Monaco 行高`，而行高是 Monaco 由 `fontSize` 派生的（本宿主 `fontSize: 14`
 * 时约 19px）。区内 DOM 若按自己的字号排版，每行差 1px，长段就会顶穿盒子被
 * `overflow: hidden` 裁掉尾部——写死的数字会随 `fontSize` 一改就过期。
 *
 * Monaco 0.57 的顶层导出面没有 `EditorOption` 枚举（取不了 `lineHeight` 选项），
 * 于是直接问 DOM。但**问的必须是 `.view-line`（单数）而不是 `.view-lines`（容器）**：
 * Monaco 把 `height: Npx; line-height: Npx` **内联写在每一条行元素上**，容器
 * `.view-lines` 的 CSS 里只有 `white-space: nowrap`，读它只会拿到继承来的 `normal`。
 * （Monaco 自己在 `viewLines.css` 的注释里就写着 "view-lines in view-zones …
 * they don't set a line height"——Zone 恰恰是唯一拿不到行高的那一层。）
 *
 * 量不到（宿主未挂载 / 模型还没有任何一行 / 计算样式给 `normal`）时返回 `null`，
 * 由 CSS 的兜底值接手，不因此放弃整块糖。
 *
 * 为什么留一份模块级缓存：`applySugarView` 紧跟在 `setModel` 之后跑，**首帧可能还
 * 没有任何 `.view-line`**，于是第一次量会扑空。全应用共用同一个 `fontSize`（宿主写死
 * 14），所以量到一次就可以一直用；不缓存的话，冷启动第一眼就是兜底值，切一次文件才正。
 */
let cachedLineHeightPx: number | null = null;

export function editorLineHeightPx(host: HTMLElement | null): number | null {
  const line = host?.querySelector<HTMLElement>('.view-lines .view-line');
  if (!line) return cachedLineHeightPx;
  const px = Number.parseFloat(window.getComputedStyle(line).lineHeight);
  if (!Number.isFinite(px) || px <= 0) return cachedLineHeightPx;
  cachedLineHeightPx = px;
  return px;
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
 * **糖视图可用门**（ADR-0005：目录分野 × 显式解锁 两道正交轴的派生判定）。
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
 * 纯函数：宿主用它同时门控"自动应用"、"首次询问"与工具条入口，三处口径不会分叉。
 */
export function sugarViewAllowed(input: {
  isErbLike: boolean;
  inWorkspace: boolean;
  unlocked: boolean;
}): boolean {
  if (!input.isErbLike) return false;
  if (input.inWorkspace) return false;
  if (input.unlocked) return false;
  return true;
}
