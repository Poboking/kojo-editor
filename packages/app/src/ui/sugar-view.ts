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

import { ROLE } from '../monaco/semantic-roles';

/** 偏好键（壳层私事，localStorage；与布局同款——不进内核存储域） */
const PREF_KEY = 'kojo.ui.sugarView.v1';
/**
 * "已问过用户"标记键（与偏好分开存）。
 *
 * 为什么不让"偏好有值"兼任"已问过"：本轮引入了**首次打开 ERB 时的询问**，而偏好读不到
 * 时回的是缺省值——若用偏好兼任，"没存过"就分不清是"还没问"还是"问过但没动过"，
 * 询问要么永不出现、要么每次打开都重问。两个语义必须分开存。
 */
const PROMPTED_KEY = 'kojo.ui.sugarView.prompted.v1';

/**
 * 默认**关闭**。
 *
 * 预览已是一件常态功能，不再替作者做主：作者打开一份文件，默认看到的应当就是盘上
 * 那份内容（要存成什么样，屏上就是什么样），想看表层写法的人自己点一下即可——
 * 发现路径是首次打开游戏目录 ERB 时的那一次询问，以及工具条按钮 / Ctrl+Alt+T。
 * **选择会被记住**，问一次就只问一次。
 */
export const SUGAR_VIEW_DEFAULT = false;

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
 * 与 `trimSegmentBlanks` **同一次剪**行文本与行映射。
 *
 * 必须成对：剪掉两行段首空行却留着映射表，预览行号就整体错位——而错位是静默的
 * （跳到隔壁那一行也是"跳了"）。没有映射表时退化成 `trimSegmentBlanks` 的结果。
 */
export function trimSegmentBlanksWithMap(
  sugarText: string,
  sourceLines: readonly number[] | undefined,
): { sugarText: string; sourceLines?: number[] } {
  const lines = sugarText.split('\n');
  if (sourceLines === undefined || sourceLines.length !== lines.length) {
    return { sugarText: trimSegmentBlanks(sugarText) };
  }
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim() === '') from++;
  while (to > from && lines[to - 1]!.trim() === '') to--;
  if (from >= to) return { sugarText, sourceLines: [...sourceLines] }; // 全空段原样返回
  return { sugarText: lines.slice(from, to).join('\n'), sourceLines: sourceLines.slice(from, to) };
}

/** 拼装输入：投影段（外部数据，形状由契约 `SugarProjectSegment` 收窄而来） */
export interface SugarSegmentInput {
  readonly fromLine: number;
  readonly toLine: number;
  readonly sugarText: string;
  /**
   * 段内第 k 行（0 基）糖文本对应的**源行号**（1 基）；`0` = 这一行没有源行（纯收束/装饰）。
   * 缺省时按 `min(fromLine + k, toLine)` 退化——宁可指回段首，也不给一个不存在的行号。
   */
  readonly sourceLines?: readonly number[];
}

/** 拼装箱：糖文本 + 「预览行 → 源行」的行映射 */
export interface SugarDoc {
  readonly text: string;
  /**
   * `lineMap[i]` = 预览第 `i + 1` 行对应的源行号（1 基），`0` = 无源行。
   *
   * 为什么必须与 `text` 同批产出：糖段是 N 源行 ⇄ M 糖行，第一段多行糖一出现，预览行号就
   * 与源行号分叉。预览面上的定位（点行、F12、错误跳转）只有拿这张表才回得到源文件；
   * 让每个消费方各自 `split('\n')` 重算行数，就是第二次分叉的开始。
   */
  readonly lineMap: readonly number[];
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
 * - 本函数**不做首尾空行修剪**（那是 `trimSegmentBlanks` 的职责，留在调用点做）；
 * - `sourceLines` 长度与糖行数不等时按缺省处理（外部数据不许假定它算准了）。
 */
export function composeSugarDoc(
  originalLines: string[],
  segments: readonly SugarSegmentInput[],
): SugarDoc {
  const n = originalLines.length;
  // 归一：排序 → 丢弃反向/完全越界 → 夹取到 [1, N] → 丢弃与前段重叠者（先到者优先）
  const applied: SugarSegmentInput[] = [];
  let coveredTo = 0; // 已被糖覆盖到的最大原文行（0 = 尚未覆盖）
  for (const seg of [...segments].sort((a, b) => a.fromLine - b.fromLine)) {
    if (!Number.isFinite(seg.fromLine) || !Number.isFinite(seg.toLine)) continue;
    if (seg.fromLine > seg.toLine) continue; // 反向区间：丢弃
    const from = Math.max(1, Math.trunc(seg.fromLine));
    const to = Math.min(n, Math.trunc(seg.toLine));
    if (from > to) continue; // 完全落在 [1, N] 之外：丢弃
    if (from <= coveredTo) continue; // 重叠：先到者优先，后到段整段丢弃
    applied.push({ ...seg, fromLine: from, toLine: to });
    coveredTo = to;
  }
  // 逐行拼装：落在某个已应用段内 → 输出整段糖文本并跳过被覆盖的原文行
  const out: string[] = [];
  const lineMap: number[] = [];
  let ai = 0;
  for (let i = 1; i <= n; i++) {
    const seg = ai < applied.length ? applied[ai] : undefined;
    if (seg && seg.fromLine <= i && i <= seg.toLine) {
      const sugarLines = seg.sugarText.split('\n');
      const declared = seg.sourceLines;
      const usable = declared !== undefined && declared.length === sugarLines.length;
      for (let k = 0; k < sugarLines.length; k++) {
        out.push(sugarLines[k]!);
        lineMap.push(usable ? declared![k]! : Math.min(seg.fromLine + k, seg.toLine));
      }
      i = seg.toLine; // 跳过整段覆盖的原文行（循环末尾 i++ → toLine + 1）
      ai++;
    } else {
      out.push(originalLines[i - 1] ?? '');
      lineMap.push(i); // 透传行：预览这一行就是源的那一行
    }
  }
  return { text: out.join('\n'), lineMap };
}

/** 预览行（1 基）→ 源行（1 基）；越界或该行没有源行（收束/装饰行）= `null` */
export function sugarLineToSource(lineMap: readonly number[], previewLine: number): number | null {
  const src = lineMap[previewLine - 1];
  return src === undefined || src <= 0 ? null : src;
}

/**
 * 源行（1 基）→ 预览行（1 基）；表空 = `null`。
 *
 * `lineMap` 单调不减（逐行拼装按源行顺序产出），所以：
 * - 精确命中优先，且取**第一次**出现——一个源行被多行糖覆盖时跳到这段糖的开头；
 * - 源行被折进糖里没有独立成行（N 源行 → M 糖行，M < N）时，退化成**它前面最近的那一行**，
 *   即"停在包住它的那段糖上"。退化是有意的：跳到隔壁一行远比什么都不做有用，
 *   而"宁可不动"的旧口径让预览面上的每一条定位请求都静默失效。
 */
export function sourceLineToSugar(lineMap: readonly number[], sourceLine: number): number | null {
  if (sourceLine <= 0) return null;
  let best: number | null = null;
  for (let i = 0; i < lineMap.length; i++) {
    const src = lineMap[i]!;
    if (src <= 0) continue;
    if (src === sourceLine) return i + 1;
    if (src < sourceLine) best = i + 1;
  }
  return best;
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
  const base = `.kojo 显示 ${projectedLines} 行`;
  return hiddenLines > 0 ? `${base}｜已收起 ${hiddenLines} 行（可展开）` : base;
}

/**
 * 工具条那颗「.kojo 预览」开关的悬停文案——**三档同一源**（NATIVE-UX 2026-10-20）。
 *
 * 存在理由（实测，不是猜想）：`langDoc: native` 的起手包 8 份 `.ERB` **每一份都投出零段**
 * （整份都是透传行 ⇒ `EditorPane` 拿到零段直接 return，糖 model 根本不挂），而改前那颗
 * 开关只要偏好是开着的就说「已开启：当前显示的是 .kojo 写法」——屏上正是原文，
 * 那句话是假话。口径照 `ui-kojo-navigator/src/panel-copy.ts`：**第一眼人话，
 * 原始读数逐字进悬停**（这里宿主真正持有的读数就是投影段数，不编造别的数字）。
 *
 * - `on = false`：与改前那句逐字相同（纯 Promise，不承诺已经发生的事）；
 * - `on = true ∧ segments = null`：还没算过（点击那一拍到 `applySugarView` 落算之间）
 *   ⇒ 保持改前那句，既有观感零改动；
 * - `on = true ∧ segments = 0`：这一档是本笔新增，只说"这份文件没投出东西"这个事实。
 */
export const SUGAR_TOGGLE_TITLE_OFF =
  '把这份文件显示成 .kojo 写法——台词读起来像剧本、条件变成「如果 …：」。只改显示，不改动文件。';
export const SUGAR_TOGGLE_TITLE_ON =
  '已开启：当前显示的是 .kojo 写法。点击切回原生代码（这是显示偏好，文件内容一字未动）。';
export const SUGAR_TOGGLE_TITLE_EMPTY =
  '这份文件里没有能显示成 .kojo 写法的句子——屏幕上仍是原文（投影段数 0），文件内容一字未动。点击可关掉这一格。';

/** 该说哪一句（纯函数 ⇒ 可单测；渲染层只做拼装，不另立文案） */
export function sugarToggleTitle(input: {
  readonly on: boolean;
  /** 本文件交回的投影段数；`null` = 还没有读数（开关关着时不去算，`null` 不是 0） */
  readonly segments: number | null;
}): string {
  if (!input.on) return SUGAR_TOGGLE_TITLE_OFF;
  if (input.segments === 0) return SUGAR_TOGGLE_TITLE_EMPTY;
  return SUGAR_TOGGLE_TITLE_ON;
}

/**
 * **预览可用门**（ADR-0005：目录分野 × 显式解锁 两道正交轴的派生判定；LAU-3 起多一道封存轴）。
 *
 * 铁律只有一条：**同一份文件不能一边被改、一边被投影**——预览靠"整份文件换成只读
 * 内存 model"工作，可编辑的原文必须始终看得见，否则用户改到自己看不见的行。
 * 于是可用门由"可编辑态"派生，而不是另立一套开关：
 *
 * | 文件 | 可编辑性（轴一 / 轴二） | 预览 |
 * |---|---|---|
 * | `.kojo` | 恒可编辑（表层源码） | **否**——本身就是表层，再投影一遍没有意义 |
 * | 工作区内 `.ERB` | **恒可编辑**（作者的创作源文件） | **否**——自己正在写的东西看投影没有意义，要写表层请直接写 `.kojo` |
 * | 游戏目录 `.ERB` | 默认只读（写保护铁律） | **是**——本功能的主场景：读懂别人的口上 |
 * | 游戏目录 `.ERB` 已解锁 | 这一次可写（轴二的破例） | **否**——回到互斥规则 |
 *
 * 这道门**不看封存总闸**（`sealed.ts`）：预览已交付为常态功能，总闸如今只管两个面板。
 *
 * ## 第三道轴：kojo1 封存（LAU-3，用户 2026-10-27 口径）
 *
 * 预览投影的**目标语法就是 kojo1**——`composeSugarDoc` 认的是 v1 的 `;` / 全角空格 / 台词行
 * 那一套写法。kojo1 成为封存层之后，"语法关了但预览还开着"会产出一份**用不存在的语法解释
 * 出来的只读投影**（词法挂 `plaintext`，投影里却还有糖化标记），比直接没有预览更误导。
 * 所以：`legacySyntaxOn === false` ⇒ 一律不许，且**排在其他轴之前**（先答"这门语法还在不在"，
 * 再答"这份文件该不该投影"）。真源是 `ui/kojo2-flag.ts::isKojoLegacySyntaxEnabled`
 * （＝切流三档里的 `kojo2StageAllowsLegacy`），本函数只收布尔、不读设置、不订阅。
 *
 * 偏好值**不清零**：作者切回 v1 / 双轨档，原来开着的预览照旧生效（设置页那一行同理，
 * 只禁用不改值）。
 *
 * 纯函数：宿主用它同时门控"自动应用"、"首次询问"与工具条入口，三处口径不会分叉。
 */
export function sugarViewAllowed(input: {
  isErbLike: boolean;
  inWorkspace: boolean;
  unlocked: boolean;
  /** kojo1（封存层）此刻开没开；`false` ⇒ 预览一起封（判据见上） */
  legacySyntaxOn: boolean;
}): boolean {
  if (!input.legacySyntaxOn) return false;
  if (!input.isErbLike) return false;
  if (input.inWorkspace) return false;
  if (input.unlocked) return false;
  return true;
}

/* ===================== 阅读模式（稿纸化）：标记弱化 · 栏宽 · 台词分层 ===================== */

/**
 * 「显示语法标记」开关偏好键（壳层私事，localStorage，与上面两键同一族）。
 *
 * 它**不进设置页**（`editor-display-prefs.ts` 不归本线动），就近放在糖视图工具条上：
 * 这是预览专属的阅读态，离开预览就没有意义，摆在设置页反而是两处状态。
 */
const MARKS_KEY = 'kojo.ui.sugarView.marks.v1';

/**
 * 缺省**关** = 阅读态：`续` / `空行` / `等待` / `：` 这类语法标记降到低对比，
 * 台词成为屏上唯一的高对比内容。想看逐字语法（学习对照、找投影没糖化的行）
 * 就打开这格，恢复现在的高对比主题色。
 */
export const SUGAR_MARKS_DEFAULT = false;

/** 读「显示语法标记」偏好（读不到回缺省，绝不抛——与糖视图开关同款纪律） */
export function loadSugarMarksPref(): boolean {
  const s = storage();
  if (!s) return SUGAR_MARKS_DEFAULT;
  try {
    const raw = s.getItem(MARKS_KEY);
    return raw === null ? SUGAR_MARKS_DEFAULT : raw === '1';
  } catch {
    return SUGAR_MARKS_DEFAULT;
  }
}

/** 写「显示语法标记」偏好（写不进去只影响下次启动的默认值） */
export function saveSugarMarksPref(on: boolean): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(MARKS_KEY, on ? '1' : '0');
  } catch {
    /* 静默降级为"本次会话有效" */
  }
}

/**
 * 阅读栏宽（折行列数）。口径：Monaco 的列 = 等宽单元，一个中日文字符占 2 列
 * ⇒ 88 列 ≈ 44 个中日文可见宽度，落在"稿纸一栏 40–50 字"的区间中央。
 * 折行模式配 `bounded`（栏宽与视口取**较窄**者）：窄窗口不会横向滚，
 * 宽窗口不会把一栏拉成通栏。
 */
export const SUGAR_READ_WRAP_COLUMN = 88;

/** 阅读行距倍数（同字号下最舒展的可读节奏；等宽编辑器换不了字体，节奏靠行距） */
export const SUGAR_READ_LINE_HEIGHT_RATIO = 1.8;

/** 阅读态上下留白（首行不贴工具条、末行有退气） */
export const SUGAR_READ_PADDING = { top: 24, bottom: 24 } as const;

/**
 * 编辑器创建路径的默认留白（`EditorPane` create options 里那一份的抄本）。
 * 存在理由：撤下预览时要把阅读态盖掉的 `padding` **显式写回**——`updateOptions`
 * 只覆写发过去的键，不写回 = 阅读留白骑到下一份真文件上（档位漂移同款）。
 */
export const EDITOR_PADDING_DEFAULT = { top: 6, bottom: 16 } as const;

/**
 * 标记弱化的**行数上限**：阅读态要把整篇重新分词一遍再铺装饰，这是同步的 O(全文)
 * 一趟。语料投影超过一万二千行的属于"本来就不是拿来通读的"（那一档连折行都关），
 * 超限就保持高对比原样——宁可少弱化，不可卡首屏。
 */
export const SUGAR_READ_MARK_MAX_LINES = 12000;

/**
 * 阅读态选项补丁（**纯函数**，不 import Monaco：返回的就是 `updateOptions` 吃的形状）。
 *
 * 只动阅读四件套：行距 / 折行模式 / 栏宽 / 上下留白。不动字体（等宽编辑器换比例
 * 字体要逐 token 改宽度，会砸掉命中测试与行号对齐——做不到，见本批交付说明），
 * 不动 `wordWrapColumn` 之外的排版偏好轴（用户显式的折行偏好在 `layoutPrefPatch`
 * 那一层，阅读态是预览的临时盖值，撤下即还原）。
 */
export function sugarReadTypography(fontSize: number): {
  lineHeight: number;
  wordWrap: 'bounded';
  wordWrapColumn: number;
  padding: { top: number; bottom: number };
} {
  return {
    lineHeight: Math.round(fontSize * SUGAR_READ_LINE_HEIGHT_RATIO),
    wordWrap: 'bounded',
    wordWrapColumn: SUGAR_READ_WRAP_COLUMN,
    padding: { ...SUGAR_READ_PADDING },
  };
}

/** 阅读态标记弱化装饰的类名（样式住在 `sugar-read.css`，此处是单一真源） */
export const SUGAR_READ_CLASS_MARK = 'sugar-read-mark';
export const SUGAR_READ_CLASS_SYNTAX = 'sugar-read-syntax';
export const SUGAR_READ_CLASS_DELIMITER = 'sugar-read-delimiter';
export const SUGAR_READ_CLASS_SPEECH = 'sugar-read-speech';

/**
 * 角色 → 阅读态装饰类（**只按角色作用**，不碰投影文本一个字符）。
 *
 * 键从 LAU-2 起是**语义角色**（`semantic-roles.ts` 的 `ROLE.*`）：Monarch 自那批起不再发
 * `sugar.*` 旧 token 名，改发角色名；这张表若还按旧名写，阅读态会在无人察觉的情况下
 * 整体失效（`monaco.editor.tokenize` 一个都匹配不上 ⇒ 装饰为零，屏上照常可读）。
 *
 * 分层判据（对应"会说话的稿纸"）：
 * - `role.cont`（`续` / `~` / `⏎`）：行尾行为标记 ⇒ 最低一档（`MARK`）；
 * - 关键字 / 运算符 / 系统函数（含 `空行` `等待` 这些词表关键字形）：语法骨架 ⇒
 *   降一档但仍可辨（`SYNTAX`）；
 * - `：` 与台词引号：结构性标点（同为 `role.punctuation`）⇒ 退到边界感（`DELIMITER`）；
 * - 台词正文：稿纸的主体 ⇒ 换成中性前景色（`SPEECH`），配色层级由它领衔。
 *
 * 没进表的角色（代词 / 插值 / 名字层 / 原生档）阅读态**不动**：代词与插值是
 * 内容的一部分；原生档是"这行还没中文化"的锚点，弱化反而丢信息。
 */
const SUGAR_READ_TOKEN_CLASSES: Readonly<Record<string, string>> = {
  [ROLE.cont]: SUGAR_READ_CLASS_MARK,
  [ROLE.keyword]: SUGAR_READ_CLASS_SYNTAX,
  [ROLE.keywordAlias]: SUGAR_READ_CLASS_SYNTAX,
  [ROLE.operatorWord]: SUGAR_READ_CLASS_SYNTAX,
  [ROLE.call]: SUGAR_READ_CLASS_SYNTAX,
  [ROLE.punctuation]: SUGAR_READ_CLASS_DELIMITER,
  [ROLE.speech]: SUGAR_READ_CLASS_SPEECH,
};

/**
 * 该 token 在阅读态归哪一档（无归属返回 undefined = 原样高对比）。
 * 除精确匹配外还认 `a.b` 形态的父级前缀：Monarch 的 token 若叠了父 scope，
 * 取的是最深一档的色，弱化也必须跟着走，否则规则一改分层就悄悄失效。
 */
export function sugarReadClassFor(tokenType: string): string | undefined {
  const exact = SUGAR_READ_TOKEN_CLASSES[tokenType];
  if (exact !== undefined) return exact;
  for (const [token, cls] of Object.entries(SUGAR_READ_TOKEN_CLASSES)) {
    if (tokenType.startsWith(`${token}.`)) return cls;
  }
  return undefined;
}

/** 分词行（`monaco.editor.tokenize` 的每行产物在此抽象成最小形状，零 Monaco 依赖） */
export interface SugarReadToken {
  readonly offset: number;
  readonly type: string;
}

/** 阅读态装饰区间（1 基行号、1 基列，与 Monaco Range 同口径；纯数据便于单测钉死） */
export interface SugarReadRange {
  readonly lineNumber: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly className: string;
}

/**
 * 把逐行分词产物翻成阅读态弱化装饰（**纯函数**）。
 *
 * token 的区间 = 本 token offset 到下一 token offset（行尾 token 吃到行末）。
 * 健壮性口径与 `composeSugarDoc` 一致：外部数据不能假定算准了——offset 越界夹到
 * 行内、乱序造成区间为空就跳过，绝不抛。无归属 / 空白（type 为空串）的 token 不产区间。
 */
export function sugarReadDecorations(
  lineTexts: readonly string[],
  tokenLines: readonly (readonly SugarReadToken[])[],
): SugarReadRange[] {
  const out: SugarReadRange[] = [];
  for (let li = 0; li < tokenLines.length; li++) {
    const tokens = tokenLines[li];
    if (!tokens) continue;
    const lineLen = (lineTexts[li] ?? '').length;
    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (!t || t.type === '') continue;
      const cls = sugarReadClassFor(t.type);
      if (cls === undefined) continue;
      const start = Math.min(Math.max(0, Math.trunc(t.offset)), lineLen);
      const next = tokens[ti + 1];
      const rawEnd = next ? next.offset : lineLen;
      const end = Math.min(Math.max(start, Math.trunc(rawEnd)), lineLen);
      if (end <= start) continue;
      out.push({ lineNumber: li + 1, startColumn: start + 1, endColumn: end + 1, className: cls });
    }
  }
  return out;
}
