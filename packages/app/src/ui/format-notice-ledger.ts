import type { Notify, NoticeInput } from './NotificationCenter';
import type { FormatDegradationNotice } from '../monaco/kojo-format-range';

/**
 * 格式化让路的**一次性台账 + 作者面文案表**（FMT-TOAST）。
 *
 * ## 要修的是哪一种哑
 *
 * `monaco/kojo-format-range.ts` 有五处"这次不格式化"的让路点（`resolve` / `compute` /
 * `resolveRange` / `windowCompute` / `anchor`），上一批把出口备好了（`onDegraded`），
 * 但现网没人接 ⇒ 症状仍是"按了没反应"。本文件就是那条接到屏幕上的线：
 * 让路 ⇒ 一条 toast；同一次会话里同一处让路 ⇒ 只那一条。
 *
 * ## 两条口径（形状照 `monaco/tree-sitter/fallback.ts` 的一次性台账，不自创算法）
 *
 * - **去重键 = `where` + 行区间**，即"同一次让路"的判据：换一个让路点、或同一段区间换成
 *   另一段行区间，还是会说。`stage` 与 `reason` **不进键**——`stage` 不进键是"一次只说
 *   一遍"的字面要求（选区格式化与打字撞到同一处不重复刷屏），`reason` 不进键是因为同一个
 *   身份第二次再报只是换一种失败说法，那一格已经亮了；技术原文（含逐字 `reason`）全进悬停。
 * - **会话级内存，不持久化**：台账是一张模块级 `Set`，重启后允许同一处再说一次。
 *   有界（超过 {@link FORMAT_NOTICE_LEDGER_MAX} 整表清空），长跑会话不把内存喂给一张只增的表。
 *
 * ## 分层（文案为什么住这一侧）
 *
 * 提供方（`monaco/kojo-format-range.ts`）**只有** `console.warn` + 回调两件事，上屏文案
 * 一个字都不许长在那一侧——句子只住本文件这张表（`tests/format-notice-ledger.test.ts`
 * 的静态闸按源码形态反查，多一处即红）。宿主侧的接线也只有两处：安装点把
 * {@link reportFormatDegradation} 递给 `onDegraded`（`editor-global-providers.ts`），
 * 壳层把通知中心那枚 `notify` 订上来（`EditorPane.tsx`）。
 *
 * 呈现面**绝不打断编辑**：`degrade()` 已把回调包在 try/catch 里，本文件对每一条订阅也各自
 * 包一次 ⇒ 通知链路炸了最多是少一条 toast，格式化请求照旧走完、返回值语义一字不动。
 */

/** 让路点的闭集（与 `FormatDegradationNotice['where']` 一一对应；补点忘了补表 ⇒ 测试当场红） */
type FormatWhere = FormatDegradationNotice['where'];

/** 哪一次请求（选区格式化 / 打字规范化）撞上的让路 */
type FormatStage = FormatDegradationNotice['stage'];

/** 台账整表清空的阈值（有界性；照 `fallback.ts`"超过上限整表换新"同一做法） */
export const FORMAT_NOTICE_LEDGER_MAX = 200;

/** 一次让路在会话台账里的身份：`where` + 行区间（口径见模块头注） */
export function formatNoticeKey(notice: FormatDegradationNotice): string {
  return `${notice.where}\u0000${notice.startLine}\u0000${notice.endLine}`;
}

export interface FormatNoticeClaim {
  /** `true` = 这个身份本次会话还没说过（调用方该上屏）；`false` = 说过，什么都不做 */
  readonly said: boolean;
  readonly key: string;
}

/**
 * 台账的**纯函数内核**：输入 notice 与"已说过的键集合"，输出这次该不该说。
 * 集合由调用方持有（会话台账是模块级那张，测试可以自带一张）；命中即登记，不重复登记。
 */
export function claimFormatNotice(
  notice: FormatDegradationNotice,
  seen: Set<string>,
): FormatNoticeClaim {
  const key = formatNoticeKey(notice);
  if (seen.has(key)) return { said: false, key };
  if (seen.size >= FORMAT_NOTICE_LEDGER_MAX) seen.clear();
  seen.add(key);
  return { said: true, key };
}

/**
 * 作者面文案表：**五个让路点 × 两种请求**各一句人话（模块级纯函数 ⇒ 可单测，
 * 范式抄 `ui-kojo-navigator/src/panel-copy.ts`）。
 *
 * 两档语气按"这次到底有没有改动"分：
 * - `resolve` / `compute` / `windowCompute` ⇒ 请求真的空手而归（"没有生效"），按 error 常驻；
 * - `resolveRange` / `anchor` ⇒ 只是**换了一条腿**（分段视角问不到 ⇒ 退回整篇判断），
 *   结果可能照常，按 info 自动消失——这种情况甩一条常驻 error 是假警报。
 *
 * 正文里不许出现任何内部词（`windowCompute` / `anchor` 之类）；机器面（`where` / `stage` /
 * 逐字 `reason`）原样进悬停。
 */
const NOTICE_TEXT: Record<FormatWhere, Record<FormatStage, string>> = {
  resolve: {
    range: '这次选区格式化没有生效：编辑器没能确认这份文件该不该格式化，改动一条都没有（可以再按一次）。',
    onType: '刚才打字时的自动规范化没有生效：编辑器没能确认这份文件该不该格式化，这一行保持原样。',
  },
  compute: {
    range: '这次选区格式化没有生效：格式化规则在这一段上算不下去了，文件保持原样（可以再按一次）。',
    onType: '刚才打字时的自动规范化没有生效：格式化规则在这一行上算不下去了，这一行保持原样。',
  },
  resolveRange: {
    range: '这次选区格式化改用了整篇判断（只取选区那几行时没能读到文本），结果照常的可能很大。',
    onType: '刚才打字时的自动规范化改用了整篇判断（只取这一行时没能读到文本），结果照常的可能很大。',
  },
  windowCompute: {
    range: '这次选区格式化没有生效：只按选区那几行算的时候规则报错了，文件保持原样（可以再按一次）。',
    onType: '刚才打字时的自动规范化没有生效：只按这一行算的时候规则报错了，这一行保持原样。',
  },
  anchor: {
    range: '这次选区格式化改用了整篇判断（这一段之前的上下文在分段视角里问不到），结果照常的可能很大。',
    onType: '刚才打字时的自动规范化改用了整篇判断（这一段之前的上下文在分段视角里问不到），结果照常的可能很大。',
  },
};

/** 严重度：空手而归 = error（常驻到作者看见）；只是换腿 = info（六秒自己走） */
const NOTICE_KIND: Record<FormatWhere, 'info' | 'error'> = {
  resolve: 'error',
  compute: 'error',
  windowCompute: 'error',
  resolveRange: 'info',
  anchor: 'info',
};

export interface FormatNoticeCopy {
  /** 第一眼：作者读得懂的中文短句，零机器词 */
  readonly text: string;
  /** 悬停：逐字技术原文（`where` / `stage` / 行区间 / `reason`，一条不丢） */
  readonly detail: string;
  readonly kind: 'info' | 'error';
}

/** 悬停里的技术原文（机器面不动：`where` / `stage` 用回内部名，`reason` 逐字跟在后面） */
export function formatNoticeDetail(notice: FormatDegradationNotice): string {
  return (
    `格式化让路 · 位置=${notice.where} · 请求=${notice.stage}` +
    ` · 第 ${notice.startLine}–${notice.endLine} 行 · 原因：${notice.reason}`
  );
}

/**
 * `notice` → 上屏那一格的内容（纯查表，零判定）。
 *
 * 两层防御照 `fallback.ts` 的 `?? '结构解析'`：将来提供方长出第六个让路点而忘了补表，
 * 也要说得出人话（落到 `compute` 那一档），而不是 `undefined` 把通知链路炸掉。
 */
export function formatDegradationCopy(notice: FormatDegradationNotice): FormatNoticeCopy {
  const byStage = NOTICE_TEXT[notice.where] ?? NOTICE_TEXT.compute;
  const text = byStage[notice.stage] ?? byStage.range;
  return {
    text,
    detail: formatNoticeDetail(notice),
    kind: NOTICE_KIND[notice.where] ?? 'error',
  };
}

/** `notice` → 通知中心的一条输入（`message` 是人话，`detail` 逐字进悬停） */
export function formatNoticeInput(notice: FormatDegradationNotice): NoticeInput {
  const copy = formatDegradationCopy(notice);
  return { kind: copy.kind, message: copy.text, detail: copy.detail };
}

/** 本会话已经说过的让路身份（键见 {@link formatNoticeKey}；不落盘，重启即清零） */
const sessionLedger = new Set<string>();

/**
 * 订阅者表：**按 `notify` 的函数身份去重 + 引用计数**。
 *
 * 为什么不是 `Set<回调>`：壳层里订阅的是**根通知中心那枚 `notify`**（全树同一个函数身份），
 * 而多个编辑器标签会各自订一次——按函数身份去重 ⇒ 同一条让路只上一条 toast；
 * 计数 ⇒ 关掉其中一个标签不会把还挂着的标签的订阅一起撤掉。
 */
const sinks = new Map<Notify, number>();

/**
 * 让路台账的**入口**（安装点把它交给 `onDegraded`）。
 *
 * 返回 `true` = 这条是新身份（已递给订阅者）；`false` = 本次会话说过同样的话，
 * 什么都不做——这就是"一次只说一遍"的落点。提供方那侧的 `console.warn` 照常每次都打。
 */
export function reportFormatDegradation(notice: FormatDegradationNotice): boolean {
  if (!claimFormatNotice(notice, sessionLedger).said) return false;
  const input = formatNoticeInput(notice);
  for (const sink of [...sinks.keys()]) {
    try {
      sink(input);
    } catch {
      /* 呈现面抛错不许打断编辑（也不许打断后面几条通知） */
    }
  }
  return true;
}

/**
 * 把通知中心那枚 `notify` 订上台账（`EditorPane.tsx` 的唯一一行接线）。
 * 返回退订函数；同一枚 `notify` 订两次只上屏一次，退订两次才真正撤掉。
 */
export function subscribeFormatNotices(notify: Notify): () => void {
  sinks.set(notify, (sinks.get(notify) ?? 0) + 1);
  let alive = true;
  return () => {
    if (!alive) return;
    alive = false;
    const rest = (sinks.get(notify) ?? 1) - 1;
    if (rest <= 0) sinks.delete(notify);
    else sinks.set(notify, rest);
  };
}

/** 清会话台账（测试复位用；`sinks` 不动——退订由各自的返回函数负责） */
export function resetFormatNoticeLedger(): void {
  sessionLedger.clear();
}

/** 文案表的闭集读数（静态闸拿它对照 `where` 的联合类型，少一格即红；只读视图，改不动本体） */
export function formatDegradationCopyTable(): Readonly<
  Record<FormatWhere, Readonly<Record<FormatStage, string>>>
> {
  return NOTICE_TEXT;
}

/** 机器词名单（静态闸拿它查正文；导出来只为让测试不必抄第二份名单） */
export const FORMAT_NOTICE_MACHINE_WORDS: readonly string[] = [
  'resolve',
  'resolveRange',
  'windowCompute',
  'anchor',
  'onType',
  'degrade',
  'notice',
];
