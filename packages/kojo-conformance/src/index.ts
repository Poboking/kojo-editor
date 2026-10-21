/**
 * `@kojo/kojo-conformance` —— adapter conformance kit（纯函数，零 IO）。
 *
 * 唯一公共入口：`runAdapterConformance` + 编码/EOL 与 differential 的可复用工具。
 * 不 import 宿主 / Monaco / kernel；游戏事实只从调用方注入的 adapter 读数。
 */
export * from './kit.js';
export * from './differential.js';
export * from './encoding.js';
