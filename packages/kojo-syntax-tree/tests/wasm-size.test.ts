import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 出货 wasm 体积棘轮（TSIT3-C「体积账」）。
 *
 * **只读文件，绝不触发构建**：本包 `pnpm` 脚本 `wasm` 要联网拉 wasi-sdk/binaryen（见 PITFALLS 135），
 * 闸若把它串进来，`pnpm test` 就成了会下载工具的闸——红线一条：这里只有 `readFileSync`。
 *
 * 为什么钉"只降不升"：`tree-sitter-kojo.wasm` 是 app 侧 `?url` 直接打进产物的**出货二进制**，
 * grammar 每加一条规则、`scanner.c` 每加一个外部记号，它都跟着涨；二批相对一批 351KB → 748KB
 * 涨了一倍却从没人算过账。体积没有免费的午餐，涨在哪必须写清楚 ⇒ 默认判红，放行要组长点头。
 *
 * 阈值口径（2026-10-19 实测，`node tools/wasm-size-probe.mjs` 可复跑）：
 *   现档 = `tree-sitter build --wasm`（clang -Os + `wasm-opt -Os`）= 747,772 B / gzip 95,322 B。
 *   同一条 wasm-opt 后处理换 `-Oz` 产出**逐字节相同**（binaryen 132），换 `-O3` 为 713,186 B
 *   但 gzip 只省 263 B ⇒ 本批**保持现档**，阈值取现档实测值。
 * 想抬阈值必须：①改这个常量为新实测字节数，②提交信息里写清涨多少、涨在哪个文件（grammar 规则 /
 * scanner 外部记号 / 查询），③经组长点头。只降不升 ⇒ 降了不必改（本测试会顺带打印余量）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');

/** 棘轮阈值：出货 wasm 允许的最大原始字节数（只降不升；抬它 = 体积回退，要组长点头）。 */
const MAX_WASM_BYTES = 747_772;

describe('出货 wasm 体积棘轮（tree-sitter-kojo.wasm）', () => {
  const bytes = readFileSync(wasmPath);

  it('产物存在且是一具合法的 wasm 模块（防 0 字节 / 半成品蒙过棘轮）', () => {
    expect(bytes.length, `${wasmPath} 读出来是空的——构建没跑或产物被截断`).toBeGreaterThan(0);
    // wasm 魔数：\0 a s m，随后版本 1
    expect([...bytes.subarray(0, 8)]).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  });

  it(`原始字节数不超过棘轮 ${MAX_WASM_BYTES.toLocaleString('en-US')} B（只降不升）`, () => {
    const gzipBytes = gzipSync(bytes, { level: 9 }).length;
    const delta = bytes.length - MAX_WASM_BYTES;
    console.log(
      `[wasm-size] 原始 ${bytes.length} B（阈 ${MAX_WASM_BYTES}，余量 ${-delta} B）/ gzip(level 9) ${gzipBytes} B`,
    );
    expect(
      bytes.length,
      `出货 wasm 涨了 ${delta} 字节（实测 ${bytes.length} B > 棘轮 ${MAX_WASM_BYTES} B）。` +
        `它是 app 侧 ?url 打进产物的二进制，涨体积不会无声通过——需要组长点头：` +
        `要么把 grammar.js / src/scanner.c / queries/*.scm 的增量瘦身回去，` +
        `要么改本文件的 MAX_WASM_BYTES 并在提交信息里写清"涨了 N 字节、涨在哪个文件、为什么必须涨"。`,
    ).toBeLessThanOrEqual(MAX_WASM_BYTES);
  });
});
