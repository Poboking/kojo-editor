/**
 * 大文件降级必须可见（批次十 S6，铁律 4）：档位一切换，作者就该知道**关掉了什么**。
 *
 * ## 要修的是哪一种哑
 *
 * `editor-options.ts` 按行数把 Monaco 的一批便利特性分层关掉（≥5,000 关全文级扫描、
 * ≥50,000 再关视口级装饰），但从来不出声：作者看到折痕没了、同词不亮了、缩略图不见了，
 * 无从判断"文件太大"还是"编辑器坏了"。本文件就是那条接到屏幕上的线：落档 ⇒ 一条 toast，
 * 列出这一档关掉的功能；**同一份文件同一档只提示一次**（同文件不重复骚扰）。
 *
 * ## 身份与一次性（形状照 `ui/format-notice-ledger.ts` 的 claim/ledger）
 *
 * - **去重键 = 文件路径 + 档位 + 原文/预览**：同一份文件同一档说一遍就够；切到另一档
 *   （large → huge）会再说一遍，因为这一档**又多关了东西**；预览是派生文本，按投影行数
 *   落档，身份与原文分开记，免得它替原文吞掉提示。
 * - **会话级内存，不持久化**：模块级 `Set`，重启后允许再说一次。有界
 *   （超过 {@link LARGE_FILE_NOTICE_LEDGER_MAX} 整表清空），长跑会话不把内存喂给只增的表。
 *
 * ## 阈值与文案表都只有一份
 *
 * 阈值**直接引用** `editor-options.ts` 的 `LARGE_FILE_LINES` / `HUGE_FILE_LINES`（这里只
 * 转出，不再抄数字）。档位判定同样走 `editorProfileTierForLineCount`；本文件只回答
 * "这一档关了什么、怎么说"。降级清单里每条都带档位表上的键名，测试拿它反查真表，
 * 表里改了键名而清单没跟上 ⇒ 当场红。
 *
 * 呈现面**绝不打断编辑**：`reportLargeFileTier` 对每条订阅各自包一次 try/catch，
 * 通知链路炸了最多是少一条 toast，落档照旧。
 */

import type { Notify, NoticeInput } from './NotificationCenter';
import {
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  editorProfileTierForLineCount,
  type EditorProfileTier,
} from './editor-options';

export { HUGE_FILE_LINES, LARGE_FILE_LINES };

/** 台账整表清空的阈值（有界性；与 `format-notice-ledger.ts` 同一做法） */
export const LARGE_FILE_NOTICE_LEDGER_MAX = 200;

/** 落在档位表上的降级项（`since` = 从哪一档起算"关"） */
export interface LargeFileDegradation {
  readonly id: string;
  /** 作者面短名（进"已为大文件关闭 X、Y、Z"那句，零内部词） */
  readonly label: string;
  readonly since: Exclude<EditorProfileTier, 'small'>;
  /** 这条降级落在档位表的哪些键上（测试拿它反查 `editorOptionsForLineCount`） */
  readonly keys: readonly string[];
  /** 只在 `.kojo` 上让路：ERB 的打字整理在大档仍然有效（见 `formatOnTypeForDocument`） */
  readonly kojoOnly?: boolean;
}

/**
 * 降级清单（顺序 = 提示里的列出顺序，先 large 后 huge）。
 *
 * `folding` 仍列（huge 档仍关：PS-4 实测一开就多一次整篇 copy）；不列 `stickyScroll` /
 * `wordWrap`：2026-10-23 重估后它们在 huge 档**不再关**（粘性滚动只看可见区间、折行是
 * 用户偏好），提示里说关掉它们是假话。
 */
const DEGRADATIONS: readonly LargeFileDegradation[] = [
  {
    id: 'same-word',
    label: '同词高亮',
    since: 'large',
    keys: ['occurrencesHighlight', 'selectionHighlight'],
  },
  {
    id: 'bracket-guides',
    label: '括号对着色与缩进引导线',
    since: 'large',
    keys: ['bracketPairColorization', 'guides'],
  },
  {
    id: 'links-colors',
    label: '链接与颜色装饰',
    since: 'large',
    keys: ['links', 'colorDecorators'],
  },
  {
    id: 'motion',
    label: '平滑滚动与光标动画',
    since: 'large',
    keys: ['smoothScrolling', 'cursorBlinking', 'cursorSmoothCaretAnimation'],
  },
  {
    id: 'indent-probe',
    label: '缩进自动探测',
    since: 'large',
    keys: ['detectIndentation'],
  },
  {
    id: 'line-highlight',
    label: '失焦时的整行高亮',
    since: 'large',
    keys: ['renderLineHighlight', 'renderLineHighlightOnlyWhenFocus'],
  },
  {
    id: 'format-on-type',
    label: '打字时自动整理',
    since: 'large',
    keys: ['formatOnType'],
    kojoOnly: true,
  },
  {
    id: 'bracket-match',
    label: '括号配对高亮',
    since: 'huge',
    keys: ['matchBrackets'],
  },
  {
    id: 'minimap',
    label: '缩略图',
    since: 'huge',
    keys: ['minimap'],
  },
  {
    id: 'folding',
    label: '代码折叠',
    since: 'huge',
    keys: ['folding'],
  },
];

/** 一次提示的输入：屏幕上这份文档是哪份、多少行、是不是预览、是不是 ERB */
export interface LargeFileNoticeFacts {
  /** 文件路径（去重键的一部分；只在悬停的技术原文里展示） */
  readonly path: string;
  readonly lineCount: number;
  /** 糖视图投影（派生只读文本）：身份与原文分开记 */
  readonly preview?: boolean;
  /** ERB 不走"打字时自动整理"那条让路，提示里不列它 */
  readonly isErb?: boolean;
}

/** 这一档真正关掉的降级项（纯查表 + 方言过滤；small ⇒ 空） */
export function largeFileDegradationsForTier(
  tier: EditorProfileTier,
  isErb = false,
): readonly LargeFileDegradation[] {
  if (tier === 'small') return [];
  const rank = tier === 'huge' ? 2 : 1;
  return DEGRADATIONS.filter((d) => {
    if (d.kojoOnly && isErb) return false;
    return (d.since === 'huge' ? 2 : 1) <= rank;
  });
}

/** 升到 `lineCount` 对应档位时关掉的降级项（small ⇒ 空） */
export function largeFileDegradationsFor(lineCount: number, isErb = false): readonly LargeFileDegradation[] {
  return largeFileDegradationsForTier(editorProfileTierForLineCount(lineCount), isErb);
}

/** 一次提示在会话台账里的身份（口径见模块头注） */
export function largeFileNoticeKey(facts: LargeFileNoticeFacts): string {
  const tier = editorProfileTierForLineCount(facts.lineCount);
  return [facts.path, tier, facts.preview ? 'preview' : 'source'].join('\u0000');
}

export interface LargeFileNoticeClaim {
  /** `true` = 这个身份本次会话还没说过（调用方该上屏）；`false` = 说过 / 小文件，什么都不做 */
  readonly said: boolean;
  readonly key: string;
}

/** 台账的**纯函数内核**：输入事实与"已说过的键集合"，输出这次该不该说 */
export function claimLargeFileNotice(
  facts: LargeFileNoticeFacts,
  seen: Set<string>,
): LargeFileNoticeClaim {
  const key = largeFileNoticeKey(facts);
  if (editorProfileTierForLineCount(facts.lineCount) === 'small') return { said: false, key };
  if (seen.has(key)) return { said: false, key };
  if (seen.size >= LARGE_FILE_NOTICE_LEDGER_MAX) seen.clear();
  seen.add(key);
  return { said: true, key };
}

export interface LargeFileNoticeCopy {
  /** 第一眼：作者读得懂的中文短句；只有小文件才没有 */
  readonly text: string;
  /** 悬停：逐字技术原文（路径 / 档位 / 行数 / 关掉的键） */
  readonly detail: string;
  readonly kind: 'info';
  readonly tier: Exclude<EditorProfileTier, 'small'>;
}

/** 悬停里的技术原文（机器面不动：路径、档位、行数、键名逐字跟在后面） */
function noticeDetail(facts: LargeFileNoticeFacts, items: readonly LargeFileDegradation[]): string {
  const tier = editorProfileTierForLineCount(facts.lineCount);
  const keys = items.flatMap((d) => d.keys).join(', ');
  return (
    `大文件降级 · 文件=${facts.path} · 档=${tier}` +
    ` · 行数=${facts.lineCount}（large ≥ ${LARGE_FILE_LINES} / huge ≥ ${HUGE_FILE_LINES}）` +
    ` · 关闭=${keys}`
  );
}

/**
 * 事实 → 上屏那一格的内容（纯查表，零判定；small ⇒ `undefined`，调用方据此不出声）。
 */
export function largeFileNoticeCopy(facts: LargeFileNoticeFacts): LargeFileNoticeCopy | undefined {
  const tier = editorProfileTierForLineCount(facts.lineCount);
  if (tier === 'small') return undefined;
  const items = largeFileDegradationsForTier(tier, facts.isErb === true);
  // 方言过滤后一项不剩就不说（理论上 large/huge 都还剩得下东西；这里是防御，
  // 免得将来清单改空时甩一条"关闭了："的空话）。
  if (items.length === 0) return undefined;
  const labels = items.map((d) => d.label).join('、');
  return {
    text: `已为大文件关闭：${labels}（这份文件 ${facts.lineCount} 行，切回小文件会自动恢复）。`,
    detail: noticeDetail(facts, items),
    kind: 'info',
    tier,
  };
}

/** 事实 → 通知中心的一条输入（`message` 是人话，`detail` 逐字进悬停） */
export function largeFileNoticeInput(facts: LargeFileNoticeFacts): NoticeInput | undefined {
  const copy = largeFileNoticeCopy(facts);
  if (!copy) return undefined;
  return { kind: copy.kind, message: copy.text, detail: copy.detail };
}

/** 本会话已经说过的降级身份（键见 {@link largeFileNoticeKey}；不落盘，重启即清零） */
const sessionLedger = new Set<string>();

/**
 * 订阅者表：按 `notify` 的函数身份去重 + 引用计数（与 `format-notice-ledger.ts` 同形）。
 * 多个编辑器标签各订一次，同一条提示只上一条 toast；关掉一个标签不会撤掉别人的订阅。
 */
const sinks = new Map<Notify, number>();

/**
 * 档位落定后的**上屏入口**（`EditorPane.tsx` 的三个 `applySizeTier` 写入点各调一次）。
 *
 * 返回 `true` = 这条是新身份、已递给订阅者；`false` = 小文件或本次会话说过同样的话。
 */
export function reportLargeFileTier(facts: LargeFileNoticeFacts): boolean {
  if (!claimLargeFileNotice(facts, sessionLedger).said) return false;
  const input = largeFileNoticeInput(facts);
  if (!input) return false;
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
export function subscribeLargeFileNotices(notify: Notify): () => void {
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
export function resetLargeFileNoticeLedger(): void {
  sessionLedger.clear();
}

/** 降级清单的只读视图（测试与静态闸从这里枚举，不抄第二份清单） */
export function largeFileDegradations(): readonly LargeFileDegradation[] {
  return DEGRADATIONS;
}
