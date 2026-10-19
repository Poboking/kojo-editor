/**
 * 「切到最近使用的标签」的意图通道（1020 编辑器体感批）。
 *
 * 为什么不注册成内核事件：`plugin-api` 的事件表是**跨层契约**（插件也看得见），
 * 而这条只有壳层自己生产、壳层自己消费——为它抬契约等于给插件一个它无法兑现的入口。
 * 为什么不塞进 props 链：命令注册在 `ShellLayout`（那里有键位表与命令注册表），
 * 而标签真源在 `App`——中间隔着 `ProjectView`，一路加 props 就是把两个模块的私事缝在一起。
 * 所以：一条模块级的"意图发布/订阅"，两端各自是本模块的既有职责，不新增第三种状态。
 */

export type TabCycleDirection = 'next' | 'prev';

type Listener = (dir: TabCycleDirection) => void;

const listeners = new Set<Listener>();

/** 发一次切标签意图（无订阅者 = 什么都不发生；调用方是命令面板/键位分发，不会静默失败，因为 App 常驻） */
export function requestTabCycle(dir: TabCycleDirection): void {
  for (const l of listeners) l(dir);
}

/** 订阅（返回退订函数；App 的挂载/卸载即这条命令的可用期） */
export function subscribeTabCycle(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
