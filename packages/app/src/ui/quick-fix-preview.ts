import type { EditorCodeAction, EditorTextEdit } from '@kojo/plugin-api';

/**
 * 💡 快速修复的**预览层**（P2-14）：quick fix 先出 preview diff、确认才落、取消不写。
 *
 * 本模块是**纯逻辑**：零 React、零 Monaco import（类型除外）、零 IPC，node 可单测。
 * 三件事：
 *
 * 1. {@link previewTextFor} —— 把 edits 应用到**一份字符串**上，与
 *    `editor-global-providers.ts` 的 `applyTextEdits` **同一套夹取 / 降序规则**
 *    （最大行号起应用、行号夹取、`to` 夹到 `from` 之后）。硬判据：**预览看到的**与
 *    **落下的**必须是同一件事——对拍测试（`tests/quick-fix-preview.test.ts`）用同一份
 *    输入分别走两条路，结果逐字相等。
 * 2. pending 注册表 —— `pushPreview` / `takePreview` / `peekPreview`，按
 *    paneId + actionId 认领（actionId 本身就带 paneId 前缀）。**过期条目不静默**：
 *    被顶掉 / 已被认领 / 已被取消的条目进"去向账"（{@link takePreview} 的 miss 结果
 *    说得出原因），查询与认领永不静默丢失。
 * 3. {@link quickFixPreviewTitle} —— 预览标题文案（中文）。
 *
 * ## 与执行通道的关系
 *
 * 应用永远走**既有** `applyTextEdits`（一次撤销步，Ctrl+Z 可撤）；本模块只回答
 * "落下之前长什么样"。注册表里的条目自带 edits 快照，应用时按**当下**的 model 落——
 * 预览打开期间用户又编辑了 ⇒ 落地时夹取（与今天直接应用同一口径，陈旧行号不崩）。
 */

/** 宿主 overlay 贡献 id（`shell-overlays.ts` 注册；`ui.overlay.open` 按此找组件） */
export const QUICK_FIX_PREVIEW_OVERLAY_ID = 'kojo.quickFixPreview';

/** 一份待确认的修复预览（push 时定稿；应用与取消都按 actionId 认领） */
export interface QuickFixPreviewEntry {
  /** 归属编辑器实例（actionId 首段与它一致；应用时据此反查活实例） */
  readonly paneId: string;
  /** Monaco 命令反查 id（`pendingActionsRef` 的 key，全局唯一不复用） */
  readonly actionId: string;
  /** 预览标题（{@link quickFixPreviewTitle} 的结果，作者面中文） */
  readonly title: string;
  /** push 时 model 的语言 id（diff 两侧同语言；糖视图不产预览，不会出现派生语言） */
  readonly languageId: string;
  /** 左侧：当前全文快照 */
  readonly originalText: string;
  /** 右侧：edits 应用后的样子（{@link previewTextFor} 的结果） */
  readonly previewText: string;
  /** 落地时用的 edits（应用走既有 `applyTextEdits`，按当下 model 夹取） */
  readonly edits: readonly EditorTextEdit[];
}

/** 预览标题（作者面：说清这是"应用前的样子"，不是已生效） */
export function quickFixPreviewTitle(action: Pick<EditorCodeAction, 'title'>): string {
  return `修复预览：${action.title}`;
}

/* ------------------------------ 预览文本（与 applyTextEdits 同一套规则） ------------------------------ */

/** 与 Monaco model 的行语义一致：按 EOL 切行；空文本 = 一条空行（getLineCount() === 1） */
function splitLines(text: string): string[] {
  return text.length === 0 ? [''] : text.split(/\r\n|\r|\n/);
}

/**
 * 把 edits 应用到一份字符串上（**纯函数**，不碰任何 model）。
 *
 * 夹取 / 降序规则与 `applyTextEdits` 逐字同源（那边落在 model 上，这边落在行数组上）：
 * - 行号先 `Math.trunc`，非数（NaN）落回 1 / `from`，再夹进 `1..行数`；
 * - `to` 夹到 `from` 之后（倒置区间不扩大破坏面）；
 * - **最大行号起应用**：前面的行号才不会因替换而位移；
 * - 新文本可多行（`\n` 分隔），落进来就是多行。
 *
 * 换行符口径：结果以 `\n` 连接。Monaco 在 `executeEdits` 落地时会把插入文本的换行
 * 归一到 model 自己的 EOL——diff 视图按行呈现，EOL 差异不可见；对拍测试按同一行语义
 * （LF model）钉住逐字相等。
 */
export function previewTextFor(text: string, edits: readonly EditorTextEdit[]): string {
  if (edits.length === 0) return text;
  const lines = splitLines(text);
  const maxLine = lines.length;
  const ops = edits
    .map((e) => {
      const from = Math.min(Math.max(1, Math.trunc(e.fromLine) || 1), maxLine);
      const to = Math.min(Math.max(from, Math.trunc(e.toLine) || from), maxLine);
      return { from, to, text: e.newText };
    })
    .sort((a, b) => b.from - a.from);
  for (const op of ops) {
    lines.splice(op.from - 1, op.to - op.from + 1, ...splitLines(op.text));
  }
  return lines.join('\n');
}

/* ------------------------------ pending 注册表 ------------------------------ */

/** miss 时说得出去向下标（铁律 4：过期不许静默丢失） */
export type PreviewMissReason =
  | /** 已被「应用修复」认领走（落到 model） */ 'claimed'
  /** 已被「取消」认领走（不落编辑） */ | 'cancelled'
  /** 同 pane 的新预览把它顶掉了（同一时刻每个 pane 至多一份待确认） */ | 'superseded'
  /** 从来没有这条 / 注册表已被整体清空 */ | 'unknown';

/** 认领结果：拿到条目，或**为什么拿不到** */
export type TakePreviewOutcome =
  | { kind: 'taken'; entry: QuickFixPreviewEntry }
  | { kind: 'missing'; reason: PreviewMissReason };

/** 每个 pane 至多一份待确认（键 = paneId；actionId 反查走线性扫，pane 数以个位数计） */
const pendingByPane = new Map<string, QuickFixPreviewEntry>();
/** 去向账：actionId → 它是怎么没的（有界，超限整表清——账是给"刚才那次点击"看的，不是档案） */
const graveyard = new Map<string, PreviewMissReason>();
const GRAVEYARD_CAP = 200;

function bury(actionId: string, reason: PreviewMissReason): void {
  if (graveyard.size >= GRAVEYARD_CAP) graveyard.clear();
  graveyard.set(actionId, reason);
}

/**
 * 登记一份待确认预览（同一 pane 重复 push = 新预览顶掉旧的，旧条目进去向账）。
 * 只在预览打开点调用；**糖视图不产预览**（调用方闸），所以这里不再判。
 */
export function pushPreview(entry: QuickFixPreviewEntry): void {
  const prev = pendingByPane.get(entry.paneId);
  if (prev && prev.actionId !== entry.actionId) bury(prev.actionId, 'superseded');
  pendingByPane.set(entry.paneId, entry);
}

/** 某个 pane 当前待确认的预览（peek **不认领**；overlay 渲染用） */
export function peekPreview(paneId: string): QuickFixPreviewEntry | null {
  return pendingByPane.get(paneId) ?? null;
}

/**
 * 按 actionId 认领（拿走即删）。应用与取消都走这里——条目要么落成编辑、要么明确取消，
 * 不存在"挂着不动"的第三态。拿不到时**说得出原因**（去向账），绝不静默。
 */
export function takePreview(actionId: string): TakePreviewOutcome {
  for (const [paneId, entry] of pendingByPane) {
    if (entry.actionId === actionId) {
      pendingByPane.delete(paneId);
      bury(actionId, 'claimed');
      return { kind: 'taken', entry };
    }
  }
  return { kind: 'missing', reason: graveyard.get(actionId) ?? 'unknown' };
}

/** 明确取消（不落编辑）：条目移除并进去向账；返回是否真有一条被取消 */
export function cancelPreview(actionId: string): boolean {
  for (const [paneId, entry] of pendingByPane) {
    if (entry.actionId === actionId) {
      pendingByPane.delete(paneId);
      bury(actionId, 'cancelled');
      return true;
    }
  }
  return false;
}

/** 整表清空（宿主全局 provider 拆毁时随行；测试隔离也用）——不算"过期"，无去向可记 */
export function resetQuickFixPreviews(): void {
  pendingByPane.clear();
  graveyard.clear();
}
