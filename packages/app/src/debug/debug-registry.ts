/**
 * 调试面登记簿（2026-10-24 调试模式批）。
 *
 * 只做一件事：给「懒装载的调试面」（`install-debug.ts`，仅在 `?kojo-debug=1` 时进页面）
 * 一个**常驻的、可先到先等的**握手点。装配层（bootstrap / ShellLayout）在产品路径上
 * 往这里登记引用；调试面晚到时按 promise 取，不来时这里只是几格空指针——
 * **不装载调试面就没有任何开销**（本模块零运行期依赖，type import 会被擦除）。
 *
 * 与 `editor-pane-registry.ts` 同一形态的取舍：登记簿必须是模块级单表，
 * 因为 kernel / 命令注册表的生命周期在 React 组件里，而调试面要在组件树外读它们。
 */
import type { Kernel } from '@kojo/kernel';

/** 命令面板注册表的调试投影（`CommandEntry` 去掉不可序列化的函数面，只留可读元数据） */
export interface DebugCommandMeta {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keybinding?: string;
}

/** ShellLayout 登记进来的命令通道：读注册表 + 以当上下文跑一条命令 */
export interface DebugCommandRunner {
  list(): readonly DebugCommandMeta[];
  run(id: string): Promise<void>;
}

let kernel: Kernel | null = null;
let kernelWaiters: Array<(k: Kernel) => void> = [];
let commandRunner: DebugCommandRunner | null = null;

/** 装配完成时登记 kernel（bootstrap.ts 的 `kernel.start()` 之后调用一次） */
export function registerDebugKernel(next: Kernel): void {
  kernel = next;
  for (const w of kernelWaiters.splice(0)) w(next);
}

/** 同步取（可能为 null——调试面先于装配到达时）；列表 / 面板类只读动作用它 */
export function getDebugKernel(): Kernel | null {
  return kernel;
}

/** 等到 kernel 在场（已在场则立即 resolve）。调试面的 `kernel` / `services` 面用它。 */
export function whenDebugKernel(): Promise<Kernel> {
  if (kernel) return Promise.resolve(kernel);
  return new Promise((resolve) => {
    kernelWaiters.push(resolve);
  });
}

/** ShellLayout 挂载后登记命令通道（注册表本身随渲染重建，通道读 ref 永远拿最新值） */
export function registerDebugCommandRunner(runner: DebugCommandRunner): void {
  commandRunner = runner;
}

export function getDebugCommandRunner(): DebugCommandRunner | null {
  return commandRunner;
}
