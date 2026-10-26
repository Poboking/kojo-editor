/**
 * 身份带插槽（VIS-10 · D-1）：三条等高 36px 横带收成两条的关键一环。
 *
 * 背景：`WindowChrome`（自绘标题栏）只在**真壳**里存在——浏览器 dev 下 `isTauri()` 为假，
 * 组件返回 `null`，一条标题栏都不画。而工具条住在 `ShellLayout` 里，两棵 React 树
 * （App 根部 vs 懒加载的项目壳）碰不到彼此。要把工具条并进标题栏成一条 40px「身份带」，
 * 又不能因为"标题栏没了"就把工具条一起弄丢（调试宿与真壳必须长同一张脸，否则调试模式
 * 验出来的东西不算数），这里就做**唯一一件事**：
 *
 * - 真壳：`WindowChrome` 挂载时把带内那一段插槽元素登记进来 → `ShellLayout` 把自己的
 *   工具条 `createPortal` 进去 ⇒ 一行里依次是 品牌记号 · 窗口标题 · 项目身份 · 全局动作 · 窗控；
 * - 浏览器 dev / node 测试：没有登记者 ⇒ 插槽为 `null` ⇒ 工具条按原位渲染，
 *   一条带变两条带，但**内容一项不少**（少的是那三枚窗控，它们本来就点不动）。
 *
 * 刻意不做的事：不猜 DOM 结构、不用 `querySelector` 轮询、不加 MutationObserver——
 * 插槽是组件自己用 ref 登记的，卸载即注销；`useSyncExternalStore` 保证订阅者拿到的
 * 永远是"当前真在不在场"，不会出现 portal 进一个已卸的节点。
 */
import { useSyncExternalStore } from 'react';

let slotElement: HTMLElement | null = null;
/** 插槽里当前有没有住人（= 工具条有没有并进身份带） */
let bandFilled = false;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const notify of subscribers) notify();
}

/** 标题栏一侧登记 / 注销插槽元素（ref 回调直接调用；卸载时 React 传 `null`） */
export function registerIdentityBandSlot(el: HTMLElement | null): void {
  if (slotElement === el) return;
  slotElement = el;
  emit();
}

/** 壳层一侧登记"插槽已被占用"（工具条 portal 进来 / 摘走时调用） */
export function setIdentityBandFilled(filled: boolean): void {
  if (bandFilled === filled) return;
  bandFilled = filled;
  emit();
}

/** 仅供测试：清场，避免用例间串插槽 */
export function resetIdentityBandSlotForTest(): void {
  const dirty = slotElement !== null || bandFilled;
  slotElement = null;
  bandFilled = false;
  if (dirty) emit();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

function getSnapshot(): HTMLElement | null {
  return slotElement;
}

/** 服务端渲染 / node 环境没有带 ⇒ 恒 `null`（getServerSnapshot 与初值同一条路） */
export function useIdentityBandSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 身份带此刻有没有住人（VIS-11 · D-8 的一半）：住人时带里已经报过一遍项目目录名，
 * 标题栏那串 `<项目名> — kojo-editor` 就只留后半截——同一行里同一个名字不许说两遍。
 */
export function useIdentityBandFilled(): boolean {
  return useSyncExternalStore(subscribe, () => bandFilled, () => bandFilled);
}
