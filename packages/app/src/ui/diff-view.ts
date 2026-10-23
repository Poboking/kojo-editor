import type { DiffViewSide, KernelEventMap } from '@kojo/plugin-api';
import { compareContent, type ContentEquality } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { diffPaneKeyOf, pushDiff, type DiffRequest } from './diff-core';
import { languageFor } from './editor-model-pool';
import type { ContextMenuItem } from './context-menu-model';

/**
 * 通用 diff 视图的宿主接线（2026-10-15 比对/历史批；W10 第 2 点改多开栈）。
 *
 * 形态照 `search-store.ts`：状态单源 + 订阅，组件只读投影，意图经内核事件
 * `ui.diffView.open` 进来（插件发意图、宿主落地）。
 *
 * 本文件只留**校验 / 取侧语言 / 事件落地**三件事；"开着哪几组比对"的状态格子
 * 住在 `diff-core.ts`（比对栈），所以这里不再有任何单例字段。判等口径按组长
 * 收窄令**保持原样**，不在本批动。零 React、零 Monaco import，node 可单测。
 */

/** 宿主 overlay 贡献 id（`App.tsx` 接线注册；`ui.overlay.open` 按此找组件） */
export const DIFF_VIEW_OVERLAY_ID = 'kojo.diffView';

export type { DiffPane, DiffRequest, DiffStateInput, DiffViewState } from './diff-core';
export {
  clearDiff,
  closeDiffPane,
  diffPaneKeyOf,
  focusDiffPane,
  getDiffPanes,
  getDiffState,
  pushDiff,
  setDiffState,
  subscribeDiff,
  topDiffPane,
} from './diff-core';

/**
 * 校验 diff 请求，返回拒绝原因（null = 合法）。
 * 判据只有一条硬规则：每一侧至少要有 `text` 或可用 `path` 之一，
 * 否则视图打开后是一片读不出内容的空白——那比不打开更坏。
 */
export function validateDiffRequest(r: DiffRequest): string | null {
  const bad = (side: DiffViewSide, which: string): string | null => {
    const hasText = typeof side.text === 'string';
    const hasPath = typeof side.path === 'string' && side.path.length > 0;
    if (!hasText && !hasPath) return `${which}侧既没有内联文本也没有可读路径，无法对比。`;
    return null;
  };
  return bad(r.original, '左') ?? bad(r.modified, '右') ?? null;
}

/**
 * 一侧的 Monaco 语言 id（DRIFT-APP 1，2026-10-19：**判据不在此另立**）。
 *
 * 此前这里自写一份尾正则当方言清单，比编辑器侧少了一整个正文扩展名——症状是同一份
 * 大写正文文件在编辑器里是 ERB 高亮、在差异视图里是纯文本。差异视图回答的问题与
 * 编辑器一模一样（"这个路径该用哪门语言显示"），所以**直接复用
 * `editor-model-pool.languageFor`**：那份函数自己指回契约层的方言谓词，契约清单一动
 * 两侧同时跟着动，第二处抄本从根上没有了。
 *
 * 复用带来的两处口径对齐（都是"向编辑器看齐"，不是新判据）：
 * - JSON 侧走 JSON 语言（此前落纯文本）；
 * - 判据取 `extname(basename)` 最后一段，多点名与点文件两侧一致判否（旧尾正则会把
 *   点文件误判成方言）。
 *
 * 对拍判据见 `tests/diff-view.test.ts`：同一份路径在编辑器侧与差异视图侧必须给出
 * **同一个** language id——这条断言不依赖本文件写没写对，回退即红。
 */
export function languageIdForSide(side: DiffViewSide): string {
  return languageFor(side.path ?? side.label);
}

/* ------------------------------ 判等（W17 DIFF-EQ） ------------------------------ */

/** 一侧已解析的内容证据：文本必有（行态）；路径侧还能拿到原始字节（字节态） */
export interface DiffContentSide {
  readonly text: string;
  readonly bytes?: Uint8Array;
}

/** 两侧内容 → 同一份判等核的两态读数（字节态 + 行态从同一次比对派生） */
export function diffEqualityOf(a: DiffContentSide, b: DiffContentSide): ContentEquality {
  return compareContent({ bytes: a.bytes, text: a.text }, { bytes: b.bytes, text: b.text });
}

export interface DiffEqualityBanner {
  /** 行级无差异 ⇒ 不必建 diff 编辑器（Monaco 会给出空 diff，白占一整块） */
  readonly noLineDiff: boolean;
  readonly message: string;
}

/**
 * 「无差异」横幅的**唯一判据**（宿主侧不再各写 if 链）。
 *
 * - 行态不同 / 判不了 ⇒ null（交给 Monaco 行级 diff；判不了时不冒充一致）；
 * - 行态相同、字节态也相同 ⇒ 完全一致；
 * - 行态相同、字节态不同 ⇒ 行级看不出差异，但**按字节并不相同**（编码 / 换行风格）——
 *   必须说出来，否则"完全一致"是假话；
 * - 行态相同、字节态判不了（内联文本侧没有字节）⇒ 只说行级一致。
 */
export function diffEqualityBanner(eq: ContentEquality): DiffEqualityBanner | null {
  if (eq.linesEqual !== true) return null;
  if (eq.bytesEqual === true) return { noLineDiff: true, message: '两侧内容完全一致（无差异）。' };
  if (eq.bytesEqual === false) {
    return {
      noLineDiff: true,
      message: '两侧行内容一致，但字节不同（编码或换行风格差异）——按字节看并不相同。',
    };
  }
  return { noLineDiff: true, message: '两侧行内容一致（无差异）。' };
}

/* ------------------------------ 内核接线 ------------------------------ */

type DiffOpenPayload = KernelEventMap['ui.diffView.open'];

function toRequest(p: DiffOpenPayload): DiffRequest {
  return { title: p.title, original: p.original, modified: p.modified };
}

/**
 * 订阅 `ui.diffView.open` → 入栈一格比对 → 打开宿主 overlay。
 * 返回卸载函数。校验失败**照样开窗**（rejected 态由 overlay 呈现原因）——
 * 拒绝如果只进控制台，用户看到的仍是"点了没反应"。
 *
 * 多开：不同内容各占一格（`diffPaneKeyOf` 派生身份），同一对内容重开只把那一格
 * 置顶刷新；关掉当前这格回到上一格比对。事件形态未变 ⇒ 既有发起方零改动。
 */
export function bindDiffView(kernel: Kernel): () => void {
  return kernel.bus.on('ui.diffView.open', (p) => {
    const request = toRequest(p);
    const key = diffPaneKeyOf(request);
    const reason = validateDiffRequest(request);
    pushDiff(reason !== null ? { kind: 'rejected', key, reason } : { kind: 'request', key, request });
    kernel.bus.emit('ui.overlay.open', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' });
  });
}

/* ==================== 右键菜单（WP3.6 · 1023 覆盖面批） ==================== */

/**
 * 面子 id（= 差异视图根元素的 `data-context-surface`；已在清单预登记）。
 *
 * 本视图是**只读**呈现面：没有「接受 / 拒绝」通道（若真有，它得先有一条写盘语义，
 * 而这条语义现在不存在），所以那两项**整项不显示**——不拿只读视图假装能改盘。
 * 菜单只接既有能力：复制（剪贴板）、上一处/下一处差异与并排/内联切换（Monaco 差异
 * 编辑器自己的 `goToDiff` / `updateOptions`）、关闭这组比对（比对栈既有出口）。
 */
export const DIFF_VIEW_SURFACE_ID = 'diff-view';

/** 菜单项 id（面自己分发；不是命令 id，不冒充命令） */
export const DIFF_VIEW_MENU_IDS = {
  copySummary: 'dv.copySummary',
  copyLeftPath: 'dv.copyLeftPath',
  copyRightPath: 'dv.copyRightPath',
  prevDiff: 'dv.prevDiff',
  nextDiff: 'dv.nextDiff',
  toggleLayout: 'dv.toggleLayout',
  closePane: 'dv.closePane',
} as const;

/** 一次菜单构建的全部输入（纯数据；面板状态由组件投影进来） */
export interface DiffViewMenuInput {
  readonly title: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  /** 两侧的盘上路径（内联文本侧没有路径 ⇒ 对应「复制路径」项整项不显示） */
  readonly leftPath: string | null;
  readonly rightPath: string | null;
  /** 差异编辑器已经建起来（上一处 / 下一处、切换布局的前提） */
  readonly editorReady: boolean;
  readonly sideBySide: boolean;
  readonly paneCount: number;
  /** 判等横幅文案（无差异 / 字节不同）；null = 行级确有差异 */
  readonly bannerMessage: string | null;
  readonly clipboardAvailable: boolean;
}

/** 对比摘要的可复制文本（标题 + 两侧标签与路径 + 判等横幅；一处文案两处用） */
export function diffSummaryText(input: DiffViewMenuInput): string {
  const side = (which: string, label: string, path: string | null): string =>
    path === null ? `${which}：${label}` : `${which}：${label} · ${path}`;
  const lines = [
    input.title,
    side('左', input.leftLabel, input.leftPath),
    side('右', input.rightLabel, input.rightPath),
  ];
  if (input.bannerMessage !== null) lines.push(`判等：${input.bannerMessage}`);
  return lines.join('\n');
}

/** 没有画出差异时的统一理由（上一处/下一处、切换布局都吃这一句，别各写一份） */
const NO_EDITOR_REASON = '当前没有画出差异（两侧内容缺失、行级无差异，或已被体量闸拦下）';

/**
 * 差异视图菜单（纯函数）：复制类 → 「跳到差异」（上一处 / 下一处、并排/内联切换）→ 关闭。
 *
 * 只读面**没有**接受 / 拒绝：那两项不出现（铁律 3：不为凑菜单新造写盘语义）。
 */
export function buildDiffViewMenu(input: DiffViewMenuInput): { items: ContextMenuItem[] } | null {
  const items: ContextMenuItem[] = [];
  const copyGate = input.clipboardAvailable
    ? {}
    : { disabled: true, disabledReason: '当前环境没有可用的剪贴板' };

  items.push({
    id: DIFF_VIEW_MENU_IDS.copySummary,
    label: '复制对比摘要',
    icon: 'files',
    group: '复制',
    ...copyGate,
  });
  if (input.leftPath !== null) {
    items.push({ id: DIFF_VIEW_MENU_IDS.copyLeftPath, label: '复制左侧路径', icon: 'files', ...copyGate });
  }
  if (input.rightPath !== null) {
    items.push({ id: DIFF_VIEW_MENU_IDS.copyRightPath, label: '复制右侧路径', icon: 'files', ...copyGate });
  }

  const jumpGate = input.editorReady ? {} : { disabled: true, disabledReason: NO_EDITOR_REASON };
  items.push({
    id: DIFF_VIEW_MENU_IDS.prevDiff,
    label: '上一处差异',
    group: '跳到差异',
    ...jumpGate,
  });
  items.push({ id: DIFF_VIEW_MENU_IDS.nextDiff, label: '下一处差异', ...jumpGate });
  items.push({
    id: DIFF_VIEW_MENU_IDS.toggleLayout,
    label: input.sideBySide ? '切换为上下内联视图' : '切换为左右并排视图',
    icon: 'preview',
    ...jumpGate,
  });

  items.push({
    id: DIFF_VIEW_MENU_IDS.closePane,
    label: input.paneCount > 1 ? `关闭这组对比（还剩 ${input.paneCount - 1} 组）` : '关闭对比',
    icon: 'close',
    dividerBefore: true,
  });
  return { items };
}
