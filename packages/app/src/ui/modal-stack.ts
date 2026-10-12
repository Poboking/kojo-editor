/**
 * 宿主模态栈（HK-2，2026-10-13）：让 Esc 关得掉对话框，且**一次只关最上面那一个**。
 *
 * 为什么要有"栈"而不是每个对话框自己 `window.addEventListener('keydown')`：
 * 五家模态各自监听 Esc 的话，叠着开的时候（保存告警 + 未保存确认，或将来更多）
 * 一次按键会**同时关掉所有层**——作者的直觉是"Esc = 退一层"，不是一锅端。
 *
 * 为什么 Esc 一定落在**不写盘**那一侧：这五家对话框没有一家的 Esc 该是"顺手确认"。
 * 写权限批准 → 只读浏览；未保存确认 → 取消；保存告警 → 取消；糖视图引导 → 不用；
 * ERB 解锁 → 保持只读。每一个都是可逆的那一半，所以各组件在接入时**显式写出**它，
 * 不用"关窗"这种含糊动作兜底（谁改按钮时都会看见这行，不会漏）。
 *
 * 与 overlay（向导）的关系：两者在实践中互斥——模态的遮罩吃掉了点击，开着模态开不了向导；
 * 开着向导时能触发模态的那几条路径（保存 / 关项目 / 在只读文件里打字）也都被遮罩挡住。
 * 因此 Esc 链里模态排在 overlay 之前，不依赖 DOM 顺序（两家的 z-index 目前同为
 * `--z-modal`，靠 DOM 先后决定谁在上面，那是个偶然，不能当依据）。
 */

import { useEffect, useRef } from 'react';

type Closer = () => void;

const stack: Closer[] = [];

/** 入栈一个模态（由 `useModalEscape` 在挂载时调用）；返回注销函数 */
export function pushModal(close: Closer): () => void {
  stack.push(close);
  let alive = true;
  return (): void => {
    if (!alive) return; // 幂等：React 严格模式下 effect 会跑两遍，别把栈删重
    alive = false;
    const i = stack.indexOf(close);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Esc 落到栈顶；返回是否消费了这次按键（空栈 → false，交给下一层） */
export function closeTopModal(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top();
  return true;
}

/** 当前栈深（只给测试与调试用；产品代码不该读它） */
export function modalDepth(): number {
  return stack.length;
}

/**
 * 组件侧钩子：挂载即入栈、卸载即出栈。
 *
 * `onClose` 每次渲染都是新函数（调用方写的是内联箭头），所以走 ref 取最新值、
 * effect 依赖留空——否则每次重渲染都要退栈入栈一次，栈序就乱了。
 */
export function useModalEscape(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => pushModal(() => ref.current()), []);
}
