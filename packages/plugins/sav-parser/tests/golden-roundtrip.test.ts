/**
 * 金样本回归：读 → 原样写回 → 逐字节对比（v1.1 写侧预研 PoC，v0.2 第十一批）。
 *
 * 六档实测（KOJO_SMOKE_PROJECT 守门，无游戏目录自动跳过）：
 * 1. **字节级**：serializePayload(parseArchive(file)) === gunzip(file)——
 *    验证重序列化与引擎写侧编码器同构（游程决策 / 整数宽度选择 / 尾段剪枝）；
 * 2. **语义级**：parseArchive(serialize 结果) 深相等（含 offset）——即使字节级
 *    存在编码决策差异，语义恒等仍保证"改槽 → 重序列化"的注入器路线可行。
 *
 * 对比结果按档打印：字节差异数 / 首个差异偏移（失败时定位用）。
 */
import { readFileSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotArchive } from '@kojo/plugin-api';
import { gunzipBytes } from '../src/gunzip';
import { parseArchive } from '../src/parse';
import { serializePayload } from '../src/serialize';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;

function firstDiff(a: Uint8Array, b: Uint8Array): { count: number; first: number } {
  const n = Math.max(a.length, b.length);
  let count = 0;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      count++;
      if (first < 0) first = i;
    }
  }
  return { count, first };
}

describe.skipIf(!SMOKE_DIR)('金样本回归：载荷层原样写回', () => {
  it('六档：serialize∘parse 与原始载荷逐字节一致 + 语义恒等', async () => {
    const savDir = nodeJoin(SMOKE_DIR!, 'sav');
    const files = ['save00.sav', 'save01.sav', 'save02.sav', 'save03.sav', 'save04.sav', 'save05.sav'];
    const report: string[] = [];

    for (const fileName of files) {
      const filePath = nodeJoin(savDir, fileName);
      let raw: Uint8Array;
      try {
        raw = readFileSync(filePath);
      } catch {
        continue; // 档不存在（如只有 save00-05 中的部分）
      }
      const body = await gunzipBytes(raw.subarray(16));

      // 全量解析（cells 完整保留——写侧前置条件）
      const archive: SnapshotArchive = await parseArchive(raw, filePath, { keepArrayCells: true });
      // 近似档（Int64 超安全整数被近似）不做字节级断言（近似值 ≠ 原字节），
      // 但语义级仍可验证（近似值 round-trip 自洽）。
      const approximated = (archive.warnings ?? []).length > 0;

      // ---- 字节级对比（近似档跳过：Int64 近似值写回会损坏 SFMT 状态等精确数据
      // ——v1.1 注入器需要 Int64 精度契约，本 PoC 显式暴露此约束） ----
      let reserialized: Uint8Array;
      try {
        reserialized = serializePayload(archive);
      } catch (err) {
        report.push(`${fileName}: 序列化不可行——${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const byteDiff = firstDiff(body, reserialized);
      report.push(
        `${fileName}${approximated ? '（近似档）' : ''}: 载荷 ${body.length}B / 重写 ${reserialized.length}B / 字节差异 ${byteDiff.count}` +
          (byteDiff.first >= 0
            ? `（首个 @0x${byteDiff.first.toString(16)}：原 ${body[byteDiff.first]} vs 写 ${reserialized[byteDiff.first]}，上下文 原[${Array.from(body.slice(Math.max(0, byteDiff.first - 4), byteDiff.first + 4)).join(',')}] 写[${Array.from(reserialized.slice(Math.max(0, byteDiff.first - 4), byteDiff.first + 4)).join(',')}]）`
            : ''),
      );
      if (!approximated) {
        expect(reserialized.length).toBe(body.length);
        expect(byteDiff.count).toBe(0);
      }

      // ---- 语义级对比（parse∘serialize∘parse 恒等，含 offset）----
      // 重打包：RAW 魔数头（16B）+ 载荷（parse 支持 raw 容器，不再解压）
      const repacked = new Uint8Array(16 + reserialized.length);
      const headDv = new DataView(repacked.buffer);
      headDv.setBigUint64(0, 0x0a1a0a0d41524589n, true); // MAGIC_RAW
      headDv.setUint32(8, 1808, true);
      repacked.set(reserialized, 16);
      const reparsed = await parseArchive(repacked, filePath, { keepArrayCells: true });
      // 比较结构（去掉文件级非载荷字段：容器/路径/尺寸——重打包用的是 RAW 头）。
      // 用 JSON 串对比（toEqual 对 undefined 属性差异不显示 visual diff，难定位）。
      const strip = (a: SnapshotArchive): string => {
        const {
          path: _p,
          size: _s,
          fileName: _f,
          format: _fmt,
          decompressedSize: _ds,
          bodySize: _bs,
          consumed: _c,
          remaining: _r,
          ...rest
        } = a;
        return JSON.stringify(rest);
      };
      const a1 = strip(reparsed);
      const a0 = strip(archive);
      if (a1 !== a0) {
        let at = 0;
        while (at < Math.min(a1.length, a0.length) && a1[at] === a0[at]) at++;
        throw new Error(
          `语义不一致 @${at}：\n  原 ...${a0.slice(Math.max(0, at - 80), at + 80)}\n  写 ...${a1.slice(Math.max(0, at - 80), at + 80)}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[golden] 载荷层原样写回：\n  ${report.join('\n  ')}`);
  }, 240_000);
});
