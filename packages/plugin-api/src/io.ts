/**
 * 文件 IO 契约——**运行时面**（越权写错误）。
 *
 * 类型面（`FileIO` / `TextFile` / 备份与回收站条目形状）已整块拆到 `./io-types`
 * （2026-11-07 MCP-PERF-S17）：类型经 `import type` / `export type` 擦除、不进开机图，
 * 本文件只留运行时真源。旧导入路径不变——文件尾 `export type *` 原样转出全部类型。
 */

/** 类型面已拆到 ./io-types（图外文件）：这里 re-export 只为保持旧的 ./io 导入路径可用。
 *  `export type *` 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './io-types';

/** 越权写入错误（内核抛出、UI 捕获展示） */
export class WriteNotAllowedError extends Error {
  constructor(
    public readonly path: string,
    public readonly writableRoots: readonly string[],
  ) {
    super(`这个位置在只读范围内，不能写入：${path}（要写就先在「只读」徽章处批准该目录）。`);
    this.name = 'WriteNotAllowedError';
  }
}
