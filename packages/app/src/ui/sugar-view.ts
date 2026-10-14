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
 * - **本地算术**：区间归一 / 整份糖文本拼装（`composeSugarDoc`）/ 偏好读写都在这里，
 *   Monaco 交互留在 `EditorPane`（与 `lift-preview.ts` 同款分层，便于单测钉死拼装口径）。
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

/**
 * 去掉糖段**首尾**的空行，段内的空行原样保留。
 *
 * 为什么：投影器按原文行逐行映射，段首常带着一两行空行（原文的分隔空行）。拼进整份
 * 糖文本后就是"段首一大块空白"——读者读到的是"这段糖没内容"，而它离上一段代码之间
 * 本来就还有真实行距。段内空行是**分节**，不能动。
 *
 * 全空的一段原样返回：那是"这段确实只有空行"的事实，不在这里把内容删成零行。
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
 * 把投影出的糖段**拼进整份文档**：逐行 1..N 走，第 i 行落在某糖段区间内 → 输出该段的
 * `sugarText`（整段文本按 `\n` 拆成多行一并输出），并跳到 `toLine + 1`；否则输出第 i 行原文。
 *
 * 这是「糖文本写进编辑器本身」的核心：换 `ed.setModel(...)` 的那份只读内存 model 的内容
 * 即由此而来（Monaco 用原生行渲染，字号 / 行高 / 折行 / 缩进 / 行号槽全部原生）。
 * 纯函数、零 Monaco 依赖，便于单测钉死拼接口径。
 *
 * ## 健壮性（segment 是外部数据，不能假定它算准了）
 * - **排序**：先按 `fromLine` 升序（乱序段也能正确落位）；
 * - **丢弃**：`fromLine > toLine`（反向区间）或**完全落在 [1,N] 之外**的段丢弃；
 * - **夹取**：部分越界的段夹到 `[1, N]`（如 `fromLine 0` → 1），不报错；
 * - **重叠**：以**先到者优先**——已被前一段覆盖到的后到段整段丢弃（投影正常不产生重叠，
 *   这条只是防"下游意外重叠"时既不崩、也不重复铺内容）；
 * - 本函数**不做首尾空行修剪**（那是 `trimSegmentBlanks` 的职责，留在调用点做）。
 */
export function composeSugarDoc(
  originalLines: string[],
  segments: { fromLine: number; toLine: number; sugarText: string }[],
): string {
  const n = originalLines.length;
  // 归一：排序 → 丢弃反向/完全越界 → 夹取到 [1, N] → 丢弃与前段重叠者（先到者优先）
  const applied: { fromLine: number; toLine: number; sugarText: string }[] = [];
  let coveredTo = 0; // 已被糖覆盖到的最大原文行（0 = 尚未覆盖）
  for (const seg of [...segments].sort((a, b) => a.fromLine - b.fromLine)) {
    if (!Number.isFinite(seg.fromLine) || !Number.isFinite(seg.toLine)) continue;
    if (seg.fromLine > seg.toLine) continue; // 反向区间：丢弃
    const from = Math.max(1, Math.trunc(seg.fromLine));
    const to = Math.min(n, Math.trunc(seg.toLine));
    if (from > to) continue; // 完全落在 [1, N] 之外：丢弃
    if (from <= coveredTo) continue; // 重叠：先到者优先，后到者整段丢弃
    applied.push({ fromLine: from, toLine: to, sugarText: seg.sugarText });
    coveredTo = to;
  }
  // 逐行拼装：落在某个已应用段内 → 输出整段糖文本并跳过被覆盖的原文行
  const out: string[] = [];
  let ai = 0;
  for (let i = 1; i <= n; i++) {
    const seg = ai < applied.length ? applied[ai] : undefined;
    if (seg && seg.fromLine <= i && i <= seg.toLine) {
      for (const l of seg.sugarText.split('\n')) out.push(l);
      i = seg.toLine; // 跳过整段覆盖的原文行（循环末尾 i++ → toLine + 1）
      ai++;
    } else {
      out.push(originalLines[i - 1] ?? '');
    }
  }
  return out.join('\n');
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
 * 铁律只有一条：**同一份文件不能一边被改、一边被投影**——糖视图靠"整份文件换成只读
 * 内存 model"工作，可编辑的原文必须始终看得见，否则用户改到自己看不见的行。
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
