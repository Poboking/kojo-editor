import type * as Monaco from './entry';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';
import { erbCompletionGate, erbLabelSlot } from './erb-completion-context';
import { erbFunctionNameSlot } from './erb-completion-functions';
import { erbBitSlotOpen } from './erb-completion-bits';
import { erbVariableSlotAt } from './erb-completion-variables';
import { insideStringOrComment, isBlank, lineAt } from './kojo-completion-position';
import { caseValueSlotAt, timingNumberSlotAt } from './kojo-completion-instructions';
import { timingFaceSlot, timingNamedParamValueSlot } from './kojo-completion-faces';
import { kojoFunctionNameSlot } from './kojo-completion-functions';
import { kojoVariableNameSlot } from './kojo-completion-variables';
import { kojoRenameBracketSlotAt } from './kojo-completion';
import { kojoNativeSlotAt } from './kojo-native-zone';
import { isComposingEvent } from '../ui/shell-keys';

/**
 * CTX-SUGGEST · 「光标刚落到名字位 ⇒ 主动弹一次补全」的**宿主侧观察者**。
 *
 * SUGGEST-2B（2026-10-18）起触发权从"只认打开名字槽的那几枚字符"放宽为**任意单字符纯插入**：
 * 名字槽里继续打字（widget 被过滤到零后自动关闭）也会重开一轮；落点仍然只由 gate ⑩ 的
 * 候选源探针决定（台词行 / 普通文本 / 字符串 / 注释里的任意字符都不弹）。防骚扰的第一道
 * 闸从"字符白名单"换成 gate ⑥（widget 已开 ⇒ 不重触发，否则会把候选选择重置回第一条）。
 * 防抖窗口改为**每次排程现取**（`host.getDebounceMs`），设置页改延迟下一次击键即生效。
 *
 * ## 为什么还要有这一条路（quickSuggestions 已全局打开之后）
 *
 * QSUG-1 起 `quickSuggestions` 在可写代码位是打开的，Monaco 自己会在键入后触发建议。
 * 但自动触发有前置判据（vendor `suggestModel.js` 的 `LineContext.shouldAutoTrigger`：
 * 光标处必须有一个**词**，且词尾恰在光标）——`时机 |` / `调用 |` / `是 |` 这类由**空白**
 * 打开的名字槽，光标处没有词，Monaco 不会弹；两门语言自己的触发字符又只有 `{` `：` `#` `[`
 * 四枚，覆盖不到这些槽。于是宿主继续在"刚敲下一枚把光标推进名字位"时替作者按一下
 * `editor.action.triggerSuggest`。**只读门、派生视图、串/注释内、widget 已开、同位置重复**
 * 一律抑制；判据一律复用候选源那几枚（见 {@link nameSlotProbesOf}），宿主侧零抄本。
 * 设置页关掉「输入时自动弹出补全」时本观察者同步沉默（gate ⑪）——"关"必须是真的不弹，
 * 而不是只关 Monaco 那一半。
 *
 * ## 输入法合成期（IME ↔ 补全互斥，2026-10-20）
 *
 * 中文作者在名字位用 IME 时，`compositionstart`→`compositionend` 之间 Enter / Tab / Esc
 * 是输入法的：Enter 提交候选、Tab 选词、Esc 取消合成。这两件事必须与补全互斥，否则
 * "上字"会变成"接受建议"或"关掉 widget"。观察者因此在这段时间整轮沉默：
 * - 内容腿 / 光标腿看到 `composing` 一律不排程（`compositionupdate` 会把拼音逐字写进 model，
 *   那不是"作者敲下的一枚字符"）；`evaluate` 的 gate ⑫ 再兜一层；
 * - Enter / Tab / Esc 的 keydown 在编辑器容器 **capture** 段只做 `stopPropagation`，把这一拍
 *   从 Monaco 的键位命令面摘掉，**不 `preventDefault`**（候选窗的提交 / 取消靠默认行为，
 *   一旦 preventDefault 就是吞键）；capture 还赶在 Monaco textarea 对 Escape 的无条件
 *   preventDefault 之前，否则"先取消合成"也会被一并吞掉。
 *
 * 判据**复用** `shell-keys` 的 `isComposingEvent` 单源（`isComposing` / `keyCode 229` /
 * 会话标志三证）。Monaco 0.57 的键位服务已按 `KEY_IN_COMPOSITION` 归一前两证，但第三方
 * 输入法两者都不带、只剩会话标志时它不认——本观察者补的就是这一层。
 *
 * ## 为什么不会骚扰作者
 *
 * 触发权只交给**"刚敲下的一枚字符"**：观察者只认"单字符纯插入"的内容事件（删除 / 粘贴 /
 * 撤销重做 / `setValue` 全不算），纯移动光标（点击、方向键、撤销、跳行）根本没有内容事件，
 * `CursorChangeReason` 落在 Explicit/Undo/Redo/Paste/ContentFlush 时也一律撤销已排程的那一拍
 * ⇒ 不会"一点就到处弹窗"。
 *
 * 字符本身不再设白名单（SUGGEST-2B：名字槽里继续打字也要能重开一轮），**位置**仍是唯一判据：
 * gate ⑩ 只认候选源自己认的名字位（行首关键字之后 / `{` 插值里 / ERB 的 `CALL`·`GOTO` 等），
 * 台词行、普通文本、字符串、注释里的任意字符都过不了。真正防"重弹重置选择"的是 gate ⑥：
 * 补全 widget 已开（`SuggestController.model.state !== 0`，含供应商还在取词的 Loading 态）
 * 一律不重触发，Monaco 自己边打字边过滤。
 */

/* ============================== 常量（Monaco 侧数值一律附来源） ============================== */

/** 主动触发的 `source` 串（便于在 Monaco 事件链里认出是宿主按的，不是作者按的） */
export const CONTEXT_TRIGGER_SOURCE = 'kojo-context-suggest';

/** 显式触发补全的动作 id（与 Ctrl+Space 同一条动作；standalone 由 `suggestController` 注册） */
export const SUGGEST_ACTION_ID = 'editor.action.triggerSuggest';

/**
 * 防抖窗口缺省值 = **0**：同拍的内容事件 + 光标事件合并成一次评估即可，任何额外延迟都会被
 * 作者看成"补全慢半拍"。（可调：`host.getDebounceMs` 每次排程现取 / 旧 host 的 `host.debounceMs`。）
 */
export const DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS = 0;

/**
 * 观察者侧的硬上限（毫秒）：设置页只让作者调到 0–1000，这里再夹一道 2000——手改 localStorage
 * 或未来接别的偏好源时，不会造出一个几十分钟后才响的定时器。**静默夹取，不抛**。
 */
export const CONTEXT_TRIGGER_DEBOUNCE_MAX_MS = 2000;

/**
 * `CursorChangeReason` 的**数值**（monaco 0.57 公开枚举，`esm/vs/editor/editor.api.d.ts:3082`；
 * 本模块按全仓纪律只取 Monaco 的**类型面**，不引运行时枚举，故在这里钉数值并注明出处）：
 * `NotSet=0`（内容编辑带动的光标移动 = 打字）、`ContentFlush=1`、`RecoverFromMarkers=2`、
 * `Explicit=3`（点击 / 方向键 / API 设位）、`Paste=4`、`Undo=5`、`Redo=6`。
 */
const CURSOR_REASON_NOT_SET = 0;
/** 「这一拍不是打字」的光标事件（撤掉待发的一拍；只可能少弹，不可能多弹） */
const CURSOR_REASON_NOT_TYPING: readonly number[] = [1, 3, 4, 5, 6];

/** `SuggestController.ID`（vendor `contrib/suggest/browser/suggestController.js:102`） */
const SUGGEST_CONTROLLER_ID = 'editor.contrib.suggestController';
/** `SuggestModel.state` 的 `State.Idle`（vendor `suggestModel.js:229-239`：`_triggerState === undefined`） */
const SUGGEST_STATE_IDLE = 0;

/* ============================== 输入法合成期门（IME ↔ 补全） ============================== */

/**
 * 补全 widget 会消费的三枚键：Enter / Tab 接受当前项，Esc 关闭 widget（vendor
 * `suggestController.js` 的 `acceptSelectedSuggestion` / `hideSuggestWidget`）。
 */
export const SUGGEST_WIDGET_KEYS: readonly string[] = ['Enter', 'Tab', 'Escape'];

/** 合成期按键证据（`KeyboardEvent` 的最小结构面；测试替身按同一形状构造） */
export interface SuggestKeyEvidence {
  readonly key?: string;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
}

/**
 * 这一枚按键是不是补全 widget 会消费的键（Enter / Tab / Esc）。
 *
 * `key` 在合成期可能缺席或为 `Process`，此时按 legacy `keyCode` 兜底（13 / 9 / 27）。
 * `keyCode 229`（IME Process）**刻意不算**补全动作键：它不是"接受 / 关闭"，而且 Monaco
 * 的键位服务对 `KEY_IN_COMPOSITION` 整拍不派发，轮不到本门处理。
 */
export function isSuggestWidgetKey(event: SuggestKeyEvidence): boolean {
  if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape' || event.key === 'Esc') {
    return true;
  }
  return event.keyCode === 13 || event.keyCode === 9 || event.keyCode === 27;
}

/**
 * 输入法合成期里，这一拍 Enter / Tab / Esc 是否该由输入法独占（补全命令必须让位）。
 *
 * 判据**只复用** `shell-keys` 的 `isComposingEvent`（`isComposing` / `keyCode 229` / 会话标志
 * 三证），本文件不另写第二份：
 * - 非补全动作键 ⇒ `false`（本门不越权处理其它键）；
 * - 补全动作键 + 非合成期 ⇒ `false`（作者真的在按 Enter / Tab / Esc，行为逐字不变）；
 * - 补全动作键 + 合成期 ⇒ `true`：Enter 只提交候选、Tab 只选词、Esc 先取消合成。
 *
 * Monaco 0.57 的键位服务已按 `KeyCode.KEY_IN_COMPOSITION` 整拍不派发，但它只认
 * `isComposing` 与 `keyCode 229` 归一出来的证据（`base/browser/keyboardEvent.js:76`）；
 * 第三方输入法两者都不带、只剩 `compositionstart`→`compositionend` 会话标志时，
 * 需要本判据补上那一层（见 `installSuggestContextTrigger` 的 keydown 护栏）。
 */
export function isImeOwnedSuggestKey(event: SuggestKeyEvidence, sessionComposing: boolean): boolean {
  return isSuggestWidgetKey(event) && isComposingEvent(event, sessionComposing);
}

/* ============================== 名字位判据（全部复用候选源，宿主零抄本） ============================== */

/** 一枚名字位探针：命中返回该源的槽对象（形状各异，这里只问"是不是名字位"），不命中 `null` */
type NameSlotProbe = (line: string, column: number) => unknown;

/**
 * 每门语言**候选源自己认的那几处名字位**（= 弹出来一定有货的位置）：
 * - `.kojo`：分野位（KC-2）/ 编号位（KC-3）/ 分支头值位（KC-3）/ `调用`·`函数` 名槽 /
 *   插值变量名位（KC-1，`的` 转场键在这一枚） / `[[属性名]]` 位 / 命名参数**取值位**（KC-2b，键冒号当拍）；
 * - `.erb`：`@` 定义位与 `CALL` 系调用位（`erbFunctionNameSlot`，语句清单单源在
 *   `erb-completion-context` 的 `ERB_CALL_STATEMENTS`）/ 跳转标签位（`erbLabelSlot`）/
 *   位原语第二实参坑（`erbBitSlotOpen`）/ 变量引用末段（`erbVariableSlotAt`，族冒号当拍）。
 *
 * 刻意**不**在宿主侧再写一条"看起来像名字位"的正则：判据一旦有两份，弹了没货（骚扰）或
 * 有货不弹（缺陷）都无从发现。
 *
 * ⚠ 探针契约是 `probe(...) !== null`：签名定死 `boolean` 的两枚（KC-2b 取值位 / 位坑）
 * **必须**在这里折成 `true | null` 再挂——直接挂会把 `false` 当命中，恒触发。
 */
export const KOJO_NAME_SLOTS: readonly NameSlotProbe[] = [
  timingFaceSlot,
  timingNumberSlotAt,
  caseValueSlotAt,
  kojoFunctionNameSlot,
  kojoVariableNameSlot,
  // `[[ … ]]` 属性名位：探针收 0 基列（其余探针收 Monaco 1 基列），换算口径同 `parseNameContext`
  (line, column) => (column < 1 ? null : kojoRenameBracketSlotAt(line, Math.min(column - 1, line.length))),
  // `timingNamedParamValueSlot` 签名定死 boolean（A3 接线注）⇒ 折一道，见上注
  (line, column) => (timingNamedParamValueSlot(line, column) ? true : null),
];
export const ERB_NAME_SLOTS: readonly NameSlotProbe[] = [
  erbFunctionNameSlot,
  erbLabelSlot,
  // 同折法：`erbBitSlotOpen` 亦为定死 boolean 签名
  (line, column) => (erbBitSlotOpen(line, column) ? true : null),
  erbVariableSlotAt,
];

/** 该语言有没有名字位探针（没有 ⇒ 本观察者对这门语言 entirely 沉默） */
function nameSlotProbesOf(languageId: string): readonly NameSlotProbe[] | null {
  if (languageId === KOJO_LANGUAGE_ID) return KOJO_NAME_SLOTS;
  if (languageId === ERB_LANGUAGE_ID) return ERB_NAME_SLOTS;
  return null;
}

/**
 * 「这一枚字符能把光标**推进**一个新名字槽」的字符集。
 *
 * SUGGEST-2B 起**不再参与触发判定**（gate ⑦ 已放宽为任意单字符插入，落点由 gate ⑩ 决定）；
 * 保留为字符语义的单一说明面，并钉住"哪些字符会打开槽"这条既有契约（单测逐枚断言）。
 *
 * - 空白（半角 / 全角 / 制表；走 `kojo-completion-position` 的 `isBlank` 单源，口径 = lexer）
 *   ⇒ `时机 |` / `是 |` / `调用 |` / `函数 |` / `时机 本番 |` / `CALL |` / `GOTO |`；
 * - `@` ⇒ ERB 定义位（行首 `@|` 就是函数名槽）；
 * - `,` / `，` ⇒ `是 1,|` 这类"接着起一个值"的分隔位，与位原语第二实参坑
 *   （`GETBIT(变量,|)` / `SETBIT 变量,|`，折过的 `erbBitSlotOpen` 探针收口）；
 * - `:`（半角）⇒ ERB 变量族冒号位（`CFLAG:|`）与 `.kojo` 命名参数键冒号位（`成否:|`，
 *   空格的键冒号位在 kojo 是合法书写）。台词行 / 普通文本里的冒号过不了探针⑩，不弹。
 *   **全角 `：` 刻意不在本集合**：它已是两门语言的 Monaco 触发字符
 *   （`triggerCharacters`，`canShowSuggestOnTriggerCharacters` 路径不受 quickSuggestions
 *   关闭门控），原生触发即可，不走本观察者；
 * - `的` ⇒ `.kojo` 插值 `{代词+的` 的**转场键**：`{她` 当拍 widget 的过滤词就是"她"，
 *   变量全量被滤到只剩代词类候选、零候选即关闭；敲 `的` 时 widget 已死，Monaco 的
 *   "已开只重过滤不重取词"这条路无从恢复 ⇒ 必须由宿主重触发一轮。探针⑩
 *   （`kojoVariableNameSlot`）只在 `{她的` 这类名字位命中，台词里的 `的` 不弹。
 *
 * **名字字符本身不"打开"槽**——但 SUGGEST-2B 之后它们照样会排程一次评估：widget 已被
 * 过滤到零而自动关闭时，继续打名字字符就是作者要的"恢复候选"；widget 还开着时由 gate ⑥
 * 兜住，不会把候选选择重置回第一条（体感 = "我刚打的字被吞了"）。
 */
export function isSlotOpeningChar(ch: string): boolean {
  return isBlank(ch) || ch === '@' || ch === ',' || ch === '，' || ch === ':' || ch === '的';
}

/** 光标是否落在**非代码视野**（字符串 / 注释）里：两门语言各走各的那一枚判据，不自造 */
function isNonCodePosition(languageId: string, line: string, column: number): boolean {
  if (languageId === ERB_LANGUAGE_ID) return erbCompletionGate(line, column) === 'in-string';
  if (languageId === KOJO_LANGUAGE_ID) {
    const col0 = Math.min(Math.max(column - 1, 0), line.length);
    return insideStringOrComment(line, col0);
  }
  return true; // 未知语言（上游已拦）兜底为"不给弹"
}

/** 一次评估的全部事实（纯数据 ⇒ 抑制条件可以逐条单测，不必造 Monaco 运行时） */
export interface SuggestOpenContext {
  readonly languageId: string;
  /** 光标所在行文本 */
  readonly line: string;
  /** Monaco 的 1 基列 */
  readonly column: number;
  /** 刚敲下的那一枚字符（不是"单字符纯插入"⇒ `null`）；字符本身不限，位置由 gate ⑩ 决定 */
  readonly typedChar: string | null;
  /** 有打开的文件（空编辑器一律不弹） */
  readonly hasPath: boolean;
  /** `editor` 处于只读（本仓只读门：游戏目录默认锁；只读时插入会被吞 ⇒ 弹了纯骚扰） */
  readonly readOnly: boolean;
  /** 派生视图（糖预览 / 投影 model）：行号属派生物，绝不主动弹 */
  readonly derivedView: boolean;
  /** 编辑器有文本焦点（焦点在别的分屏 / 面板 ⇒ 不抢） */
  readonly focused: boolean;
  /** 多光标 */
  readonly multiCursor: boolean;
  /** 有选区（作者正在选，不是正在写） */
  readonly selectionActive: boolean;
  /** 补全 widget 已可见 / 正在跑（重弹 = 重置选择） */
  readonly widgetVisible: boolean;
  /**
   * `.kojo` 原生区名字位（`@` 块 / 全大写直通行 / `$标签`；SUGGEST-2A 的路由判据在这里
   * 只多算一枚"值得弹"的位置）。可选：非 `.kojo` / 旧调用方不传 ⇒ `undefined` = 不加分。
   */
  readonly nativeSlot?: boolean;
  /**
   * 设置页「输入时自动弹出补全」总开关（QSUG-2）。`false` ⇒ 本观察者也不替作者触发；
   * 可选：旧调用方不传 = `true`（保持既有行为）。
   */
  readonly quickSuggestionsEnabled?: boolean;
  /**
   * 输入法合成期（`compositionstart`→`compositionend` 的会话态）。`true` ⇒ 本轮自动弹出
   * 整轮沉默：拼音 / 候选还没上字，弹出来只会被下一次 `compositionupdate` 过滤掉，或者
   * 诱使 Enter / Tab 去"接受建议"而不是提交候选。可选：旧调用方不传 = `false`。
   */
  readonly composing?: boolean;
}

/**
 * 主动触发的**全部闸门**（纯函数；观察者只负责把 Monaco 事件折成 {@link SuggestOpenContext}）。
 * ⑪ 总开关**最先判**（关掉时其余判据都不必算），⑫ 输入法合成期紧随其后（合成期一律不弹），
 * 其后 ①–⑩ 按编号顺序，逐条可测：
 * ①无文件 ②只读 ③派生视图 ④无焦点 ⑤多光标/有选区 ⑥widget 已开 ⑦不是"刚敲下的一枚字符"
 * ⑧这门语言没有名字位判据 ⑨串/注释内 ⑩候选源自己不信这一位。
 */
export function shouldTriggerContextSuggest(c: SuggestOpenContext): boolean {
  if (c.quickSuggestionsEnabled === false) return false; // ⑪（总开关，先判）
  if (c.composing === true) return false; // ⑫ 合成期：输入法还没上字，不许替作者弹
  if (!c.hasPath) return false; // ①
  if (c.readOnly) return false; // ②
  if (c.derivedView) return false; // ③
  if (!c.focused) return false; // ④
  if (c.multiCursor || c.selectionActive) return false; // ⑤
  if (c.widgetVisible) return false; // ⑥
  if (c.typedChar === null) return false; // ⑦ 任意单字符都行（SUGGEST-2B）；位置交给 ⑩
  const probes = nameSlotProbesOf(c.languageId); // ⑧
  if (probes === null) return false;
  if (isNonCodePosition(c.languageId, c.line, c.column)) return false; // ⑨
  // ⑩ 候选源自己认的位置：糖册的名字位探针，或 `.kojo` 原生区里 ERB 门认可的名字位
  //（`CALL ` / `#D` / `CFLAG:` / `GOTO ` / `SETBIT …,`——判据在 `kojo-native-zone.ts`，
  // 不在这里另抄一份 ERB 位置门）。
  return (c.nativeSlot ?? false) || probes.some((probe) => probe(c.line, c.column) !== null);
}

/** 位置签名（含语言 + 路径 + 行 + 列 + 光标前文）：同一签名只弹一次，重复事件与往返移动都吞掉 */
export function positionSignature(
  key: { readonly languageId: string; readonly path: string; readonly lineNumber: number; readonly column: number },
  linePrefix: string,
): string {
  return `${key.languageId}|${key.path}|${key.lineNumber}|${key.column}|${linePrefix}`;
}

/* ============================== 观察者 ============================== */

/** 宿主接线面：EditorPane 交出的三件事（路径 / 是否派生视图 / 可调防抖） */
export interface SuggestContextTriggerHost {
  /** 当前文件路径；未打开文件 ⇒ `undefined`（空编辑器不弹） */
  getPath: () => string | undefined;
  /** 糖预览等**派生视图**（显示的 model 是投影 ⇒ 行号与位置都不属真文件） */
  isDerivedView: () => boolean;
  /**
   * 防抖窗口**现取值**（SUGGEST-2B）：每次排程都调一次 ⇒ 设置页改完延迟，下一次击键即生效。
   * 返回值夹到 0–{@link CONTEXT_TRIGGER_DEBOUNCE_MAX_MS}；抛错 / 非有限数回静态值。
   */
  getDebounceMs?: () => number;
  /**
   * 静态防抖窗口（旧 host 的接线面，缺省 {@link DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS} = 0）。
   * 同时给了 `getDebounceMs` 时以 getter 为准（每次现取）；没有 getter 的旧 host 行为零改动。
   */
  debounceMs?: number;
  /**
   * 设置页「输入时自动弹出补全」**现取值**（QSUG-2）：每次评估调一次。缺省 / 抛错 = 开
   * （旧 host 行为零改动；脏偏好读取不该让补全整条沉默）。
   */
  getQuickSuggestionsEnabled?: () => boolean;
}

/** 读快建议总开关：getter 缺省 / 抛错 / 非布尔值一律按「开」处理 */
function readQuickSuggestionsEnabled(host: SuggestContextTriggerHost): boolean {
  if (typeof host.getQuickSuggestionsEnabled !== 'function') return true;
  try {
    return host.getQuickSuggestionsEnabled() !== false;
  } catch {
    return true;
  }
}

/**
 * 本次排程的防抖窗口：getter 优先、逐次现取；任何脏值（NaN / 负数 / 超大 / 抛错）都静默回落
 * 到"静态值或默认 0"再夹到 0–2000。**绝不把异常抛进 Monaco 的事件派发链**。
 */
function readDebounceMs(host: SuggestContextTriggerHost): number {
  let raw: unknown = host.debounceMs ?? DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS;
  if (typeof host.getDebounceMs === 'function') {
    try {
      raw = host.getDebounceMs();
    } catch {
      /* 偏好读取器坏掉 ⇒ 沿用静态窗口 */
    }
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS;
  return Math.min(CONTEXT_TRIGGER_DEBOUNCE_MAX_MS, Math.max(0, raw));
}

/** `SuggestController` 的结构面（只读 `model.state`；其余一概不碰） */
interface SuggestControllerLike {
  dispose(): void;
  readonly model?: { readonly state?: number };
}

/**
 * 编辑器容器（`getContainerDomNode()` 就是 Monaco 键位服务挂 keydown 的同一节点；
 * 测试替身按同一最小面构造）。容器拿不到时退到 `getDomNode()`；两者都没有 ⇒ 不做键护栏。
 */
function editorKeyShieldNodeOf(editor: Monaco.editor.IStandaloneCodeEditor): HTMLElement | null {
  const containerOf = (editor as { getContainerDomNode?: () => HTMLElement | null }).getContainerDomNode;
  if (typeof containerOf === 'function') {
    try {
      const node = containerOf.call(editor);
      if (node) return node;
    } catch {
      /* 旧编辑器 / 测试桩没有这一面 ⇒ 退到 getDomNode */
    }
  }
  const domOf = (editor as { getDomNode?: () => HTMLElement | null }).getDomNode;
  if (typeof domOf !== 'function') return null;
  try {
    return domOf.call(editor) ?? null;
  } catch {
    return null;
  }
}

/** 「单字符纯插入」= 打字（删除 / 替换 / 粘贴 / 整篇 setValue 都不是）；返回插入的那一枚字符 */
function singleInsertedChar(e: Monaco.editor.IModelContentChangedEvent): string | null {
  if (e.isFlush === true) return null;
  const changes = e.changes ?? [];
  if (changes.length !== 1) return null;
  const change = changes[0]!;
  if (change.rangeLength !== 0) return null; // 有删除 ⇒ 不是"刚输入"
  const text = change.text ?? '';
  if (text.length !== 1) return null; // 粘贴 / IME 成串上字 / 回车缩进 ⇒ 不算
  if (text === '\n' || text === '\r') return null;
  return text;
}

/**
 * widget 是否已可见：**只认** `SuggestController.model.state`（`State.Idle = 0`）。
 *
 * **不能用 `editor.hasWidgetFocus()`**（2026-10-18 真壳实机抓到的坑）：Monaco 0.57 的该公开面
 * 是 `CodeEditorWidgetFocusTracker`（vendor `view.js` 的 `hasFocus()`）——跟踪的是"焦点落在
 * 编辑器容器 / overflow 区"，**打字时恒为 `true`**（真壳实测：无弹窗时 `hasWidgetFocus=true`、
 * suggest `state=0`）。把它当"弹窗可见"会让观察者**每次击键**都倒在闸门⑥，整条主动触发链
 * 静默全灭（单测直接构造 `widgetVisible:false`，抓不到这种"封装语义错"）。
 *
 * 控制器取不到 ⇒ 视为不可见（宁多弹一次，不整条静默）。
 */
function isSuggestWidgetVisible(editor: Monaco.editor.IStandaloneCodeEditor): boolean {
  const getContribution = (editor as {
    getContribution?: (id: string) => SuggestControllerLike | null;
  }).getContribution;
  if (typeof getContribution !== 'function') return false;
  const state = getContribution.call(editor, SUGGEST_CONTROLLER_ID)?.model?.state;
  return typeof state === 'number' && state !== SUGGEST_STATE_IDLE;
}

/** 编辑器当前是否只读（**公开面** `getRawOptions`：`updateOptions` 会并进去，故与宿主设的值同步） */
function isEditorReadOnly(editor: Monaco.editor.IStandaloneCodeEditor): boolean {
  const getRawOptions = (editor as { getRawOptions?: () => { readOnly?: boolean } }).getRawOptions;
  return typeof getRawOptions === 'function' && getRawOptions.call(editor)?.readOnly === true;
}

/**
 * 装一枚**每编辑器实例**的上下文触发观察者（SPLIT1 分屏 = 每实例各一枚，互不干扰）。
 * 返回句柄只挂监听，不改编辑器、不写 model；`dispose()` 卸干净（含未跑到的那一拍 debounce）。
 */
export function installSuggestContextTrigger(
  editor: Monaco.editor.IStandaloneCodeEditor,
  host: SuggestContextTriggerHost,
): Monaco.IDisposable {
  /** 刚敲下的那一枚字符；一次评估后清空 ⇒ "一次打字只弹一次" */
  let typedChar: string | null = null;
  /**
   * 输入法合成会话（`onDidCompositionStart` → `onDidCompositionEnd`）。
   * 合成期的事件腿一律不排程，`evaluate` 里的 gate ⑫ 再兜一层。
   */
  let composing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSignature: string | null = null;
  let disposed = false;
  /** 触发失败的可见痕迹只留一次（同一环境下的重复失败不刷屏） */
  let failureReported = false;

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const evaluate = (): void => {
    if (disposed) return;
    const ch = typedChar;
    typedChar = null; // 消费：之后再来光标事件也不再评估同一拍
    if (ch === null) return;
    if (composing) return; // ⑫ 排程后立刻进入合成：这一拍作废（事件腿通常已先拦下）
    const model = editor.getModel();
    if (!model) return;
    const position = editor.getPosition();
    if (!position) return;
    const languageId = typeof model.getLanguageId === 'function' ? model.getLanguageId() : '';
    const path = host.getPath() ?? '';
    const line = lineAt(model, position.lineNumber);
    const selections = (typeof editor.getSelections === 'function' ? editor.getSelections() : null) ?? null;
    const primary = editor.getSelection();
    const signature = positionSignature(
      { languageId, path, lineNumber: position.lineNumber, column: position.column },
      line.slice(0, Math.min(Math.max(position.column - 1, 0), line.length)),
    );
    if (signature === lastSignature) return; // 同位置签名：弹过一次就不再重弹
    const ok = shouldTriggerContextSuggest({
      languageId,
      line,
      column: position.column,
      quickSuggestionsEnabled: readQuickSuggestionsEnabled(host),
      typedChar: ch,
      hasPath: path !== '',
      readOnly: isEditorReadOnly(editor),
      derivedView: host.isDerivedView(),
      focused: typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : true,
      multiCursor: Array.isArray(selections) && selections.length > 1,
      selectionActive:
        Array.isArray(selections) && selections.length > 0
          ? selections.some((s) => !!s && !s.isEmpty())
          : !!primary && !primary.isEmpty(),
      widgetVisible: isSuggestWidgetVisible(editor),
      composing,
      // 只有 `.kojo` 需要多问一次原生区（跨装配路由的位置面）；其余语言不付这笔扫描
      nativeSlot: languageId === KOJO_LANGUAGE_ID ? kojoNativeSlotAt(model, position) : false,
    });
    if (!ok) return;
    // 动作走 `editor.trigger` → 命令面（vendor `codeEditorWidget.js:781` 起：`default:` 分支
    // `this._commandService.executeCommand(handlerId, payload)`）。**刻意不用 `editor.getAction`
    // 先探一次**：那条只看得见 `addAction` 注册进实例 `_actions` 的动作，全局 `EditorAction2`
    // 注册的 `editor.action.triggerSuggest` 不在里面 ⇒ 探一次恒 `null`，会把整条功能静默掐死。
    // 弹不出去 = 用户眼里"根本没补全"，故失败必须留一行可见痕迹（一次即可，不刷屏）。
    try {
      editor.trigger(CONTEXT_TRIGGER_SOURCE, SUGGEST_ACTION_ID, undefined);
    } catch (e: unknown) {
      // 没弹成 ⇒ 位置签名不记账（下一拍还会再试）；可见痕迹只留一次，不刷屏
      if (!failureReported) {
        failureReported = true;
        console.warn(
          `[${CONTEXT_TRIGGER_SOURCE}] 主动触发补全失败（后续不再重复报告）：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      return;
    }
    lastSignature = signature;
  };

  const schedule = (): void => {
    if (disposed) return;
    cancelTimer();
    // 每次排程现取：设置页改变延迟后，**下一次击键**就按新值走（不是安装时定死）
    const delayMs = readDebounceMs(host);
    timer = setTimeout(() => {
      timer = null;
      evaluate();
    }, delayMs);
  };

  // 打字腿：只认"单字符纯插入"（任意字符都可排程），其余（删除 / 粘贴 / 撤销重做 / setValue）
  // 撤掉待发的一拍。落点由 evaluate 里的 gate ⑩ 决定 ⇒ 台词行 / 普通文本不会因此多弹。
  const contentSub = editor.onDidChangeModelContent((e) => {
    if (disposed) return;
    if (composing) {
      // 合成期模型也会随 compositionupdate 变化（拼音 / 候选预览）：这不是"作者敲下的一枚字符"
      typedChar = null;
      cancelTimer();
      return;
    }
    if (e.isUndoing === true || e.isRedoing === true) {
      typedChar = null;
      cancelTimer();
      return;
    }
    const inserted = singleInsertedChar(e);
    typedChar = inserted;
    if (inserted !== null) schedule();
    else cancelTimer();
  });

  // 光标腿：打字带动的那次（NotSet）与内容事件同拍合并；移动类一律撤销
  const cursorSub = editor.onDidChangeCursorPosition((e) => {
    if (disposed) return;
    if (composing) {
      typedChar = null;
      cancelTimer();
      return;
    }
    const reason = typeof e.reason === 'number' ? e.reason : CURSOR_REASON_NOT_SET;
    if (CURSOR_REASON_NOT_TYPING.includes(reason)) {
      typedChar = null;
      cancelTimer();
      return;
    }
    if (typedChar !== null) schedule();
  });

  // 换 model = 换文件：位置签名作废（否则"上一份文件同一点弹过"会吞掉这一份的第一次）
  const modelSub = editor.onDidChangeModel(() => {
    lastSignature = null;
    typedChar = null;
    cancelTimer();
  });

  // 输入法合成会话：走 Monaco 的 public composition 事件（与 `SuggestModel` 同一对判据）。
  // 事件序（vendor `textAreaEditContextInput.js` 的 compositionend 分支）：先 fire `_onType`
  // 把提交的那一笔落进 model（宿主 content 腿此时仍在 `composing=true` 里 ⇒ 不会把"上字"
  // 当击键去弹补全），随后才 fire `onDidCompositionEnd` ⇒ 这里清会话。Esc 取消合成没有内容
  // 事件，清会话同样只是"恢复作者原本的键盘行为"。
  const compositionStartSub =
    typeof editor.onDidCompositionStart === 'function'
      ? editor.onDidCompositionStart(() => {
          composing = true;
          typedChar = null;
          cancelTimer();
        })
      : null;
  const compositionEndSub =
    typeof editor.onDidCompositionEnd === 'function'
      ? editor.onDidCompositionEnd(() => {
          composing = false;
          typedChar = null;
          cancelTimer();
        })
      : null;

  // 合成期的 Enter / Tab / Esc 归输入法。护栏挂在编辑器容器的 **capture** 段，必须赶在
  // Monaco 的 textarea 处理之前：vendor `textAreaEditContextInput.js` 对 Escape **无条件**
  // `preventDefault()`（防 IE 的 keypress），合成期若让它跑到，输入法的"取消合成"也会被吞。
  // 这里只 `stopPropagation`、**不 preventDefault**：Enter 提交候选 / Esc 取消合成 / Tab 选词
  // 靠的都是输入法默认行为；事件不进 Monaco 的命令面，但默认动作照常发生。
  // 非合成期一律原样放行（接受建议 / 关闭 widget 仍是 Monaco 自己的键位）。
  const shieldNode = editorKeyShieldNodeOf(editor);
  const onComposingKeyDown = (event: KeyboardEvent): void => {
    if (!isImeOwnedSuggestKey(event, composing)) return;
    event.stopPropagation();
  };
  if (shieldNode) shieldNode.addEventListener('keydown', onComposingKeyDown, true);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      composing = false;
      cancelTimer();
      typedChar = null;
      lastSignature = null;
      contentSub.dispose();
      cursorSub.dispose();
      modelSub.dispose();
      compositionStartSub?.dispose();
      compositionEndSub?.dispose();
      shieldNode?.removeEventListener('keydown', onComposingKeyDown, true);
    },
  };
}
