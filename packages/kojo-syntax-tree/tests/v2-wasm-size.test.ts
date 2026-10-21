import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Kojo 2.0 出货 wasm 体积棘轮（U6 语法树 · v2）。
 *
 * **只读文件，绝不触发构建**：`tools/build-v2.mjs` 才会下载 wasi-sdk / binaryen；
 * 测试闸串构建 = `pnpm test` 变成会联网的闸（红线）。
 *
 * 口径（2026-10-21 实测，`node tools/build-v2.mjs` 复跑）：
 *   `tree-sitter build --wasm`（clang -Os）后再 `wasm-opt -Oz`，产出 47,116 B / gzip(9) 13,061 B。
 * 只降不升：抬阈值 = 体积回退，要组长点头并在提交信息里写清涨在哪（grammar 规则 / 外部记号 / 查询）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo2.wasm');

/** 棘轮阈值：出货 wasm 允许的最大原始字节数（只降不升）。 */
const MAX_WASM_BYTES = 47_116;

describe('出货 wasm 体积棘轮（tree-sitter-kojo2.wasm）', () => {
  const bytes = readFileSync(wasmPath);

  it('产物存在且是一具合法的 wasm 模块（防 0 字节 / 半成品蒙过棘轮）', () => {
    expect(bytes.length, `${wasmPath} 读出来是空的——构建没跑或产物被截断`).toBeGreaterThan(0);
    // wasm 魔数：\0 a s m，随后版本 1
    expect([...bytes.subarray(0, 8)]).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  });

  it(`原始字节数不超过棘轮 ${MAX_WASM_BYTES.toLocaleString('en-US')} B（只降不升）`, () => {
    const gzipBytes = gzipSync(bytes, { level: 9 }).length;
    const delta = bytes.length - MAX_WASM_BYTES;
    console.log(`[v2-wasm-size] 原始 ${bytes.length} B（阈 ${MAX_WASM_BYTES}，余量 ${-delta} B）/ gzip(9) ${gzipBytes} B`);
    expect(
      bytes.length,
      `v2 出货 wasm 涨了 ${delta} 字节（实测 ${bytes.length} B > 棘轮 ${MAX_WASM_BYTES} B）。` +
        `它会被 app 侧打进产物；要么瘦回去，要么改本文件常量并说明涨在哪、为什么必须涨。`,
    ).toBeLessThanOrEqual(MAX_WASM_BYTES);
  });
});
