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

/**
 * 棘轮阈值：出货 wasm 允许的最大原始字节数（只降不升；抬它 = 体积回退，要组长点头）。
 *
 * 沿革与拆账（**2026-10-20 合流后重测**：上游台词行内插值改规则 + 本批 TRY 写形同时在场）：
 * - 747,772 B（TSIT3-C 出版基线）→ **742,108 B**＝上游把台词串从原子 token 改成带子节点的规则
 *   （`e590c43`），净退 **−5,664 B**；
 * - 742,108 → **821,724 B**＝本批两笔：`native_line` 第三支与等值标记（`[SKIPSTART]` / `[SKIPEND]`
 *   严格等值 + `#DIM` 记号正则，由 `cst-classifyline-parity` 的 18 行真冲突逼出来）＋ `try_statement`
 *   与 `control_malformed` 的 TRY 支，合计 **+79,616 B**；相对上一出版基线净 **+73,952 B**。
 * - 上一轮逐笔拆账（19,910 / 57,137）是在**改规则前**的 grammar 上量的，节点表变了以后逐笔数不再
 *   逐字复现，能站得住的结构性结论保留：九枚名单换成 trie 只退 **471 B**（0.8%）；名单宽度的天花板
 *   （换 `[A-Z]+`）退 9,768 B——那等于不认 TRY，判据不许；`control_malformed` 的 TRY 支值 4,322 B
 *   （parity 承重）；剩下的大头是"多一个行族节点"在 LR 表里的固定价（≈41,800 B 量级）——
 *   要退它只能把 `try_statement` 降级成 `native_line`，那等于取消这枚节点、宿主按 kind 取色与折叠就没有了。
 *   ⇒ 结论不变：这一档体积是"TRY 系写形有 CST 节点"这件事的**结构性代价**，不是实现浪费。
 * 阈值取实测原样（821,724 B / gzip 101,487 B），不放余量：任何新增体积都必须重新对账。
 */
const MAX_WASM_BYTES = 821_724;

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
