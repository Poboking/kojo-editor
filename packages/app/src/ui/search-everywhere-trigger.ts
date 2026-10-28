/**
 * 双击 Shift 呼出「全局搜索（Search Everywhere）」的**判定纯函数**（体验对等批，对标 IDEA 的
 * Search Everywhere）。
 *
 * ## 为什么是一段裸时间窗特判而不是键位注册表条目
 *
 * `plugin-api/commands.ts` 的 `chordFromEvent` 对**纯修饰键**（`key === 'Shift'`）返回 null——
 * 注册表的键位形态（修饰键 + 主键）表达不了「同一个修饰键连击两下」。仓里有先例：
 * Ctrl+K Z 和弦就是在 `ShellLayout` 的全局键盘处理器里用 `Date.now()` 时间窗特判实现的
 * （注册表外、不改 `chordFromEvent` 的判据——那是契约面，牵动所有键位测试）。
 * 本模块把这条腿的**语义**从组件里摘出来：判定只吃「键down 现场读数 + 时钟」，零 DOM、零 React，
 * 单测能钉住窗口/抑制条件而不依赖真实浏览器。壳层只保留：喂事件、消费返回值。
 *
 * ## 语义（IDEA 同款四条）
 *
 * 1. 两发**纯 Shift** keydown（按下时没有 ctrl/alt/meta 搭车）且间隔 ≤ `DOUBLE_SHIFT_WINDOW_MS` ⇒ 触发；
 * 2. 两发之间出现**任何其它键**（字母、数字、Esc……）⇒ 连击作废，重新数；
 * 3. `ctrl+shift+p` 这类组合里的 Shift **不计数也不触发**（它属于组合键的一部分）；
 * 4. 触发后清单清空（这组连击被**吃掉**）：第三下 Shift 只是下一组连击的第一下，
 *    不会「面板还开着又被第二组掀一次」。
 *
 * 抑制条件（面板/浮层/设置已开、偏好关了）由 opts 传入——判定仍在这一处，壳层不留第二份 if 阶梯。
 * 编辑器里**允许**触发（IDEA 的行为，本功能的价值所在）：Monaco 的隐藏 textarea 在壳层全局键的
 * 三层早退里被放行（`shell-keys.isEditableKeyTarget`），所以事件会走到这里；
 * 而树内改名框 / 过滤框这类真输入面被早退挡在门外，压根到不了本函数。
 */

/** 连击窗口（IDEA 默认同款量级：两下 Shift 间隔超过它就算两次独立按键，不是一次连击） */
export const DOUBLE_SHIFT_WINDOW_MS = 400;

/** 一次 keydown 的现场读数（字段与 DOM KeyboardEvent 同名同形，壳层原样转递；测试手搓替身） */
export interface ShiftKeyFrame {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** 事件时刻（epochMs，由调用方注入——判定不自己读钟，测试不吃真实时间） */
  readonly atMs: number;
  /**
   * 自动重复（按住不放的 keydown 连发）。**按住 Shift 不是双击**：repeat 拍既不计数
   * 也不断链（数了就误触发，断了会把合法连击洗没）——IDEA 同款抑制。
   */
  readonly repeat?: boolean;
}

/** 判定入参里的环境位（都归这里单源判，壳层不留第二份） */
export interface DoubleShiftOptions {
  /** 偏好「双击 Shift 呼出」是否开着（关掉 ⇒ 命令仍在，只是这条腿不响应） */
  readonly enabled: boolean;
  /** 面板 / 浮层 / 设置页已在前台 ⇒ 不重复触发（IDEA 同款：呼出键在模态前台让位） */
  readonly frontBusy: boolean;
}

export interface DoubleShiftDecision {
  /** 这一拍是否该呼出综合档 */
  readonly fire: boolean;
  /**
   * 本拍之后调用方要存回去的「窗口内纯 Shift 连击清单」。
   * 触发后 / 被抑制后都是**空清单**（连击被吃掉）；其它键之后同样是空（序列断掉）。
   */
  readonly pending: readonly ShiftKeyFrame[];
  /** 判定去向（读数与单测用；壳层只消费 fire，分支不靠它） */
  readonly reason:
    | 'fired'
    | 'first-tap'
    | 'tap-expired'
    | 'not-shift'
    | 'shift-with-modifier'
    | 'key-repeat'
    | 'suppressed-front-busy'
    | 'suppressed-disabled';
}

/** 这一发是不是「没搭车的 Shift」 */
function isPureShift(frame: ShiftKeyFrame): boolean {
  return frame.key === 'Shift' && !frame.ctrlKey && !frame.altKey && !frame.metaKey;
}

/** 窗口内还活得着的连击（旧于 `nowMs - DOUBLE_SHIFT_WINDOW_MS` 的直接掉出账面） */
function liveWithinWindow(pending: readonly ShiftKeyFrame[], nowMs: number): ShiftKeyFrame[] {
  return pending.filter((f) => nowMs - f.atMs <= DOUBLE_SHIFT_WINDOW_MS);
}

/**
 * 全局搜索呼出的连击判定（**纯函数**）。
 *
 * 契约：`events` = 已存的窗口内连击清单（可能为空）**加上本拍这一发**（恒为最后一枚，
 * `atMs` 即 `nowMs`）。调用方每次 keydown 都问一次——非 Shift 事件也要问，
 * 「中间没有其它键」这条判据要求本函数看得见每一次按键（清单清空就是断链的方式）。
 */
export function planDoubleClickShift(
  events: readonly ShiftKeyFrame[],
  nowMs: number,
  opts: DoubleShiftOptions,
): DoubleShiftDecision {
  const current = events.length > 0 ? (events[events.length - 1] as ShiftKeyFrame) : null;
  // 没喂事件（不该发生，兜底成无事发生）
  if (current === null) return { fire: false, pending: [], reason: 'not-shift' };
  // 偏好关：连击账本直接不记（关掉后命令仍在、只是这条腿彻底不响应）
  if (!opts.enabled) return { fire: false, pending: [], reason: 'suppressed-disabled' };

  if (current.key !== 'Shift') return { fire: false, pending: [], reason: 'not-shift' };
  if (current.repeat === true) {
    // 按住 Shift 不放的自动重复：不计数（否则长按=双击）、也不断链（账本照常老化）
    return {
      fire: false,
      pending: liveWithinWindow(events.slice(0, -1), nowMs).filter(isPureShift),
      reason: 'key-repeat',
    };
  }
  if (current.ctrlKey || current.altKey || current.metaKey) {
    // `ctrl+shift+p` 里的 Shift：不算连击，也把已数的半截清零（组合键打断纯击意图）
    return { fire: false, pending: [], reason: 'shift-with-modifier' };
  }

  // 清单里只有纯 Shift 才作数（防调用方喂进来的历史里混过别的）
  const allPrior = events.slice(0, -1).filter(isPureShift);
  const cleanPrior = liveWithinWindow(allPrior, nowMs);
  if (allPrior.length === 0) {
    // 账上本来就没有前拍 ⇒ 这一发是新组的第一发
    return { fire: false, pending: [current], reason: 'first-tap' };
  }
  if (cleanPrior.length === 0) {
    // 有过前拍但都出了窗口 ⇒ 上一组连击作废，这一发改记为新组第一发
    return { fire: false, pending: [current], reason: 'tap-expired' };
  }
  // 走到这里：窗口内确有前拍（`liveWithinWindow` 已按 `<=` 兜住窗口判据）
  if (opts.frontBusy) {
    // 前台已有面板/浮层/设置：不重复呼出，且这组连击**吃掉**（第三下不会又顶一次）
    return { fire: false, pending: [], reason: 'suppressed-front-busy' };
  }
  return { fire: true, pending: [], reason: 'fired' };
}
