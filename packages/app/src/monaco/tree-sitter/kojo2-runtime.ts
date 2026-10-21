/**
 * Kojo 2.0 tree-sitter 运行时的**主线程懒加载单例**（+ 可判别的失败面）。
 *
 * ## 为什么是单例，且只在这一层碰 wasm
 *
 * `web-tree-sitter` 的 `Parser.init()` 是**进程级**的（wasm 模块装一次，后续 `init` 直接返回
 * 同一个模块，连 `locateFile` 都只认第一次），所以运行时天然只能有一份。做成单例之后：
 * 并发调用共享同一条 `Promise`（第二个调用方 `===` 第一个，不会各 fetch 一遍 47KB wasm），
 * `dispose()` 之后下一次调用才重新装载。
 *
 * ## 为什么内核在 `kojo2-runtime-core.ts`
 *
 * worker 的 iife 产物不接受动态 import 切 chunk，而本文件的默认装载器必须动态 `import()`
 * 模块与资源（主线程懒加载的交付面）。所以真正的装配/解析/查询住在 **零动态 import** 的
 * `kojo2-runtime-core.ts`；本文件只保留"懒加载 + 单例"这一层，并且**不在 worker 模块图里**：
 * worker 入口静态 import 资源后直接调 `createKojo2Runtime()`。
 *
 * ## 装载策略
 *
 * 1. `kojo2-assets.ts` 里是 Vite 的 `?url`（两枚 wasm）与 `?raw`（三份查询）。
 *    **只有本模块的默认装载器动态 `import()` 它**——flag 关着 / 没人要结构层时，
 *    这些资源连字符串都不进主线程模块图（测试都不走这条路）。
 * 2. 两枚 wasm 各是谁的：`runtimeWasmUrl` = `web-tree-sitter` 自己的运行时
 *    （0.27 包内实名 `web-tree-sitter.wasm`，`Parser.init({locateFile})` 找它）；
 *    `grammarWasm` = `@kojo/kojo-syntax-tree` 包根的 `tree-sitter-kojo2.wasm`（47,116 B）。
 * 3. Node 侧（测试 / 无 Vite）：把**文件路径**当 `runtimeWasmUrl` 传进来即可——
 *    Emscripten 在 Node 下走 `fs.readFileSync`；语法 wasm 直接喂 `Uint8Array` 或路径，
 *    `Language.load` 在 Node 下同样走 `fs`，**不联网**。
 *
 * 失败面、增量口径、所有权都在 `kojo2-runtime-core.ts` 头注（单一真源，不在这里抄第二份）。
 */
import type { Kojo2RuntimeAssets, Kojo2TreeSitterModule } from './kojo2-runtime-core';
import { createKojo2Runtime } from './kojo2-runtime-core';

export * from './kojo2-runtime-core';

/**
 * 依赖注入缝（测试用；生产走默认装载器）。
 * `loadAssets` 覆盖资源来源、`loadModule` 覆盖 `web-tree-sitter` 模块本身。
 */
export interface Kojo2RuntimeDeps {
  readonly loadModule?: () => Promise<Kojo2TreeSitterModule>;
  readonly loadAssets?: () => Promise<Kojo2RuntimeAssets>;
  /** 装载总超时（毫秒），缺省 {@link KOJO2_RUNTIME_TIMEOUT_MS} */
  readonly timeoutMs?: number;
}

type Kojo2RuntimeResult = import('./kojo2-runtime-core').Kojo2RuntimeResult;

let pendingRuntime: Promise<Kojo2RuntimeResult> | null = null;

async function loadWebTreeSitter(): Promise<Kojo2TreeSitterModule> {
  return import('web-tree-sitter');
}

async function loadV2Assets(): Promise<Kojo2RuntimeAssets> {
  const assets = await import('./kojo2-assets');
  return assets.KOJO2_TREE_SITTER_ASSETS;
}

/**
 * 取（必要时装载）**唯一**的 2.0 tree-sitter 运行时。
 *
 * - 并发调用共享同一条 Promise（普通函数而非 `async`：`===` 成立，异步函数会另包一层）；
 * - 成功与失败都会被记住：失败之后编辑器按 `reason` 降级，需要重试时先
 *   `disposeKojo2TreeSitterRuntime()`（例如作者手动打开结构层）；
 * - `deps` 只在**第一次**调用（真正创建）时生效，后续调用忽略，避免单例被不同资源半路改写。
 */
export function getKojo2TreeSitterRuntime(deps: Kojo2RuntimeDeps = {}): Promise<Kojo2RuntimeResult> {
  if (pendingRuntime !== null) return pendingRuntime;
  pendingRuntime = createKojo2Runtime(
    deps.loadModule ?? loadWebTreeSitter,
    deps.loadAssets ?? loadV2Assets,
    deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs },
  );
  return pendingRuntime;
}

/**
 * 丢掉当前单例（无论已就绪、失败还是在途）。返回的 Promise 在**已就绪**的运行时
 * 真正 `dispose()` 之后 resolve；在途的那条会在迟到后自己 dispose（不会重新装回来）。
 */
export function disposeKojo2TreeSitterRuntime(): Promise<void> {
  const current = pendingRuntime;
  pendingRuntime = null;
  if (current === null) return Promise.resolve();
  return current.then(
    (result) => {
      if (result.ok) result.runtime.dispose();
    },
    () => {
      /* 失败结果没有资源可放 */
    },
  );
}
