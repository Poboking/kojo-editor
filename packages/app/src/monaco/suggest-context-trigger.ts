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

/**
 * CTX-SUGGEST · 「光标刚落到名字位 ⇒ 主动弹一次补全」的**宿主侧观察者**。
 *
 * ## 为什么要有这一条路（而不是把 quickSuggestions 打开）
 *
 * `editor-options.ts` 的 `CJK_TYPING_BASELINE` 把 `quickSuggestions` 钉在**所有档位**为 `false`：
 * 中文台词行连打字就会弹一堆无关列表，实测是纯噪声。而 vendor 取证（monaco 0.57
 * `contrib/suggest/browser/suggestModel.js:303`）——`QuickSuggestionsOptions.isAllOff(...)` 时
 * `_doTriggerQuickSuggest` 直接 return ⇒ **"打字自动弹"这条路整条关闭**，只有触发字符
 * （`canShowSuggestOnTriggerCharacters`，`:81-91` 不受该门控）与显式 trigger 还有效。
 * 可两门语言的触发字符合计只有 `{` `：` `#` `[` 四枚，**最高频的落点一个都不在内**
 * （`时机 <分野>`、`是 <指令名>`、`时机 计数器 <名>`、`调用 <函数名>`、`@<函数名>`、`CALL <函数名>`），
 * 而且 `：` 挂在构造**尾部**、分野名要补在它**之前** ⇒ 连唯一相关的落点都指错了。
 * 作者不按 Ctrl+Space 就永远看不到候选，体感就是"这编辑器没补全"。
 *
 * 于是走**唯一不违反上面那条基线**的路：宿主自己判断"光标刚进入一个名字位"，替作者按一下
 * `editor.action.triggerSuggest`。**只读门、派生视图、串/注释内、widget 已开、同位置重复**
 * 一律抑制；判据一律复用候选源那几枚（见 {@link nameSlotProbesOf}），宿主侧零抄本。
 *
 * ## 为什么不会骚扰作者
 *
 * 触发权只交给**"刚敲下的一枚字符"**：观察者只认"单字符纯插入"的内容事件（删除 / 粘贴 /
 * 撤销重做 / `setValue` 全不算），且该字符必须能把光标**推进**一个名字槽
 * （{@link isSlotOpeningChar}：空白 / `@` / 逗号 / 半角冒号 / `的`）。纯移动光标（点击、方向键、撤销、跳行）
 * 根本没有内容事件，`CursorChangeReason` 落在 Explicit/Undo/Redo/Paste/ContentFlush 时也一律
 * 撤销已排程的那一拍 ⇒ 不会"一点就到处弹窗"。名字位判据又只覆盖行首关键字之后的那一位，
 * 台词行、注释、字符串里的空白什么都打不开。
 */

/* ============================== 常量（Monaco 侧数值一律附来源） ============================== */

/** 主动触发的 `source` 串（便于在 Monaco 事件链里认出是宿主按的，不是作者按的） */
export const CONTEXT_TRIGGER_SOURCE = 'kojo-context-suggest';

/** 显式触发补全的动作 id（与 Ctrl+Space 同一条动作；standalone 由 `suggestController` 注册） */
export const SUGGEST_ACTION_ID = 'editor.action.triggerSuggest';

/**
 * 防抖窗口缺省值 = **0**：同拍的内容事件 + 光标事件合并成一次评估即可，任何额外延迟都会被
 * 作者看成"补全慢半拍"。（可调：`host.debounceMs`。）
 */
export const DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS = 0;

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

/* ============================== 名字位判据（全部复用候选源，宿主零抄本） ============================== */

/** 一枚名字位探针：命中返回该源的槽对象（形状各异，这里只问"是不是名字位"），不命中 `null` */
type NameSlotProbe = (line: string, column: number) => unknown;

/**
 * 每门语言**候选源自己认的那几处名字位**（= 弹出来一定有货的位置）：
 * - `.kojo`：分野位（KC-2）/ 编号位（KC-3）/ 分支头值位（KC-3）/ `调用`·`函数` 名槽 /
 *   插值变量名位（KC-1，`的` 转场键在这一枚） / 命名参数**取值位**（KC-2b，键冒号当拍）；
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
 * 「刚敲下这一枚字符」才可能**进入**名字槽的字符集：
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
 * **名字字符本身不算**：widget 已经开着时 Monaco 自己边打字边过滤，宿主再 trigger 一次只会
 * 把候选选择重置回第一条（体感 = "我刚打的字被吞了"）。
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
  /** 刚敲下的那一枚字符（不是"单字符纯插入"⇒ `null`） */
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
}

/**
 * 主动触发的**全部闸门**（纯函数；观察者只负责把 Monaco 事件折成 {@link SuggestOpenContext}）。
 * 顺序即抑制条件的编号，逐条可测：
 * ①无文件 ②只读 ③派生视图 ④无焦点 ⑤多光标/有选区 ⑥widget 已开 ⑦不是"刚敲进槽的那枚字符"
 * ⑧这门语言没有名字位判据 ⑨串/注释内 ⑩候选源自己不信这一位。
 */
export function shouldTriggerContextSuggest(c: SuggestOpenContext): boolean {
  if (!c.hasPath) return false; // ①
  if (c.readOnly) return false; // ②
  if (c.derivedView) return false; // ③
  if (!c.focused) return false; // ④
  if (c.multiCursor || c.selectionActive) return false; // ⑤
  if (c.widgetVisible) return false; // ⑥
  const ch = c.typedChar;
  if (ch === null || !isSlotOpeningChar(ch)) return false; // ⑦
  const probes = nameSlotProbesOf(c.languageId); // ⑧
  if (probes === null) return false;
  if (isNonCodePosition(c.languageId, c.line, c.column)) return false; // ⑨
  return probes.some((probe) => probe(c.line, c.column) !== null); // ⑩
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
  /** 防抖窗口（缺省 {@link DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS} = 0，仅合并同拍事件） */
  debounceMs?: number;
}

/** `SuggestController` 的结构面（只读 `model.state`；其余一概不碰） */
interface SuggestControllerLike {
  dispose(): void;
  readonly model?: { readonly state?: number };
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
  const debounceMs = host.debounceMs ?? DEFAULT_CONTEXT_TRIGGER_DEBOUNCE_MS;
  /** 刚敲下的那一枚字符；一次评估后清空 ⇒ "一次打字只弹一次" */
  let typedChar: string | null = null;
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
    timer = setTimeout(() => {
      timer = null;
      evaluate();
    }, debounceMs);
  };

  // 打字腿：只认"单字符纯插入"，其余（删除 / 粘贴 / 撤销重做 / setValue）撤掉待发的一拍
  const contentSub = editor.onDidChangeModelContent((e) => {
    if (disposed) return;
    if (e.isUndoing === true || e.isRedoing === true) {
      typedChar = null;
      cancelTimer();
      return;
    }
    const inserted = singleInsertedChar(e);
    typedChar = inserted;
    if (inserted !== null && isSlotOpeningChar(inserted)) schedule();
    else cancelTimer();
  });

  // 光标腿：打字带动的那次（NotSet）与内容事件同拍合并；移动类一律撤销
  const cursorSub = editor.onDidChangeCursorPosition((e) => {
    if (disposed) return;
    const reason = typeof e.reason === 'number' ? e.reason : CURSOR_REASON_NOT_SET;
    if (CURSOR_REASON_NOT_TYPING.includes(reason)) {
      typedChar = null;
      cancelTimer();
      return;
    }
    if (typedChar !== null && isSlotOpeningChar(typedChar)) schedule();
  });

  // 换 model = 换文件：位置签名作废（否则"上一份文件同一点弹过"会吞掉这一份的第一次）
  const modelSub = editor.onDidChangeModel(() => {
    lastSignature = null;
    typedChar = null;
    cancelTimer();
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      typedChar = null;
      lastSignature = null;
      contentSub.dispose();
      cursorSub.dispose();
      modelSub.dispose();
    },
  };
}
