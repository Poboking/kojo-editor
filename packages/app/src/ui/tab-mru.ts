/**
 * 标签的「最近使用」顺序（1020 编辑器体感批，用户反馈项 5 的 Ctrl+Tab 那一半）。
 *
 * 零 React、零 IO：MRU 是**组内**的会话态（与 pin 同档，不落盘），App 是唯一状态所有者，
 * 这里只回答"怎么挪、怎么跳"。判据放这一层才能单测（同 `tabs-ops.ts` 的先例）。
 *
 * 一份 MRU = 路径数组，**越靠前 = 越近使用**。三条纪律：
 * - 只记还开着的标签（关掉即剔除，不留"按过去打不开"的幽灵项）；
 * - 激活/打开 = 提到最前，不在表里则插入最前（不重排其它相对顺序——作者记的是"上一个用的"）；
 * - 同一条命令连按是在这份序里继续走，不是反复跳回同一个（`offset` 由调用方按连按次数给）。
 */

/** 把 path 提到最前（不在表里 = 插入最前；其余相对顺序不动 —— 作者记的是"上一个用的"） */
export function touchMru(mru: readonly string[], path: string): string[] {
  return [path, ...mru.filter((p) => p !== path)];
}

/** 剔除已关闭 / 已不在栈内的标签（传当前 tabs 即可）：不留"按过去打不开"的幽灵项 */
export function pruneMru(mru: readonly string[], openTabs: readonly string[]): string[] {
  const open = new Set(openTabs);
  return mru.filter((p) => open.has(p));
}

/**
 * Ctrl+Tab 走一步：在当前活动标签**之外**的 MRU 序里取第 `offset` 枚。
 *
 * - `next` = 沿"最近用过"往后走（第 1 下就是上一个用的标签，与 VS Code 一致）；
 * - `prev` = 反方向走（Ctrl+Shift+Tab）；
 * - 只剩当前一张 / MRU 空 ⇒ `null`（调用方必须给一句人话，不许按下去没反应）。
 */
export function stepMru(
  mru: readonly string[],
  current: string | null,
  dir: 'next' | 'prev',
  offset = 0,
): string | null {
  const others = mru.filter((p) => p !== current);
  if (others.length === 0) return null;
  const order = dir === 'next' ? others : [...others].reverse();
  const step = Math.abs(Math.trunc(offset)) % order.length;
  return order[step] ?? null;
}
