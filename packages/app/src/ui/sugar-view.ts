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
 * 工具条/状态栏的糖视图摘要（面向作者，中文；**不含内部术语**）。
 *
 * 口径只说"已映射多少行"，不说"未映射多少行"：未映射的行里既有真正的原生代码，
 * 也有注释与空行——把它们加总成"未映射"会让人以为漏了什么。逐因明细由
 * 「升糖」面板承担（那边有分因标签），工具条只给一个"这文件是人话"的量感。
 */
export function sugarSummary(projectedLines: number): string {
  return `糖视图 · 已映射 ${projectedLines} 行`;
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
