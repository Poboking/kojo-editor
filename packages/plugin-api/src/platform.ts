/**
 * 平台桥契约——**运行时面**（解码标签表与解码判序策略两张共享常量表）。
 *
 * 类型面（`PlatformBridge` / `FileEncoding` / 远程面形状）已整块拆到 `./platform-types`
 * （2026-11-07 MCP-PERF-S17）：类型经 `import type` / `export type` 擦除、不进开机图，
 * 本文件只留运行时真源。旧导入路径不变——文件尾 `export type *` 原样转出全部类型。
 */
import type { DecodeProbePolicy, FileEncoding } from './platform-types';

/** 类型面已拆到 ./platform-types（图外文件）：这里 re-export 只为保持旧的 ./platform 导入路径可用。
 *  `export type *` 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './platform-types';

/**
 * `FileEncoding` → WHATWG Encoding Standard 解码标签（**单源**，W12 ENC-SRC）。
 * 两具平台桥（Tauri / Node）都 import 这一张表——旧局是两份手抄，PITFALLS 73 同族教训：
 * 同形守卫只要有一边手抄就必然漂。`utf-8-bom` 走 `utf-8`：TextDecoder 默认剥前导 BOM。
 */
export const DECODE_LABEL: Record<FileEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  shift_jis: 'shift_jis',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

/** TS 侧的策略常量（解释者 = `packages/kernel/src/encoding.ts` 的 `decodeWithProbe` / `probeEncoding`） */
export const DECODE_PROBE_POLICY: DecodeProbePolicy = {
  version: 1,
  bomRules: [
    { bom: [0xef, 0xbb, 0xbf], encoding: 'utf-8-bom' },
    { bom: [0xff, 0xfe], encoding: 'utf-16le' },
    { bom: [0xfe, 0xff], encoding: 'utf-16be' },
  ],
  fallbackEncoding: 'shift_jis',
};
