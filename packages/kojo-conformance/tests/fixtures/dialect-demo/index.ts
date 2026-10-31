/**
 * 第三列（`--adapter demo`）的注册面：一枚最小 profile + 它自己的机壳。
 *
 * 见 `adapter.ts` / `backend.ts` 的头注。这个包的**唯一**目的是 B5a 的终态判据：
 * 新增一个包 ⇒ conformance 多一列，套件与 CLI 零改动。
 */
export { DEMO_CARRIERS, DEMO_EVENT_CATALOG, DEMO_GAME_ADAPTER } from './adapter.js';
export { createDemoEmitBackend, demoLoweringProfile } from './backend.js';
