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
 *
 * **2026-10-12 用真实存档复测**（§5.64 合流与 §5.65 快照 v3 之后，回放线一次没重测过）：
 * 逐字节同构 2 档（`global` + `save00`，save00 载荷 571,185B 与 §5.17 记录一字不差）、
 * 近似档 4 档（`save01–03` + `save1000`，16/34/43/43 条 Int64 近似警告）、
 * 方案 B passthrough **六档全部**逐字节一致。这两组数字被写死成断言，见下方 `GOLDEN_ARCHIVES`。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotArchive } from '@kojo/plugin-api';
import { assembleArchiveFile } from '../src/container';
import { gunzipBytes } from '../src/gunzip';
import { parseArchive } from '../src/parse';
import { serializePayload } from '../src/serialize';
import { verifyOverrides } from '../src/verify';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;
const SAV_DIR = SMOKE_DIR ? nodeJoin(SMOKE_DIR, 'sav') : '';

/**
 * **金样本档集的身份清单**（不是"目录里有什么就验什么"）。
 *
 * 2026-10-12 用真实存档复测时确认：本机与 `integration-plugins.test.ts`
 * 的 `scan.entries.length === 6` 同源的那一组是
 * `global + save00–save03 + save1000`。本文件旧版硬编码的是 `save00–save05`
 * （**另一套槽位编号**），且对不存在的档 `catch { continue }` 静默跳过——
 * 结果是"标题写六档、实际只验四档"仍然全绿。这是一处**假绿面**，不是档的问题。
 *
 * 现在的口径：**缺任何一档就红**（并指名缺哪档）；一个 `.sav` 都没有时
 * 显式 skip（CI 与无存档机器安全，跳过在报告里可见，不静默）。
 */
const GOLDEN_ARCHIVES = [
  'global.sav',
  'save00.sav',
  'save01.sav',
  'save02.sav',
  'save03.sav',
  'save1000.sav',
];

/** 目录里到底有没有存档（目录不存在 / 为空 都算"没有"——那是语料条件，不是代码缺陷） */
const HAS_SAV = (() => {
  if (!SAV_DIR) return false;
  try {
    return readdirSync(SAV_DIR).some((n) => n.toLowerCase().endsWith('.sav'));
  } catch {
    return false;
  }
})();

/** 金样本身份清单里**实际缺失**的档名（大小写不敏感）——非空即红 */
function missingFrom(dir: string, wanted: readonly string[]): string[] {
  let present: string[];
  try {
    present = readdirSync(dir).map((n) => n.toLowerCase());
  } catch {
    return [...wanted];
  }
  return wanted.filter((f) => !present.includes(f.toLowerCase()));
}

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
  it.skipIf(!HAS_SAV)('金样本六档（身份清单）：serialize∘parse 与原始载荷逐字节一致 + 语义恒等', async () => {
    // 缺档 = 红（指名缺哪档），不再静默 continue
    expect({ 缺档: missingFrom(SAV_DIR, GOLDEN_ARCHIVES) }).toEqual({ 缺档: [] });
    const report: string[] = [];
    let byteVerified = 0;
    let approximatedCount = 0;

    for (const fileName of GOLDEN_ARCHIVES) {
      const filePath = nodeJoin(SAV_DIR, fileName);
      const raw = readFileSync(filePath);
      const body = await gunzipBytes(raw.subarray(16));

      // 全量解析（cells 完整保留——写侧前置条件）
      const archive: SnapshotArchive = await parseArchive(raw, filePath, { keepArrayCells: true });
      // 近似档（Int64 超安全整数被近似）不做字节级断言（近似值 ≠ 原字节），
      // 但语义级仍可验证（近似值 round-trip 自洽）。
      const approximated = (archive.warnings ?? []).length > 0;
      if (approximated) approximatedCount++;

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
        byteVerified++;
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

    // **这条断言把"到底验到了什么强度"钉死**（2026-10-12 真实六档实测）：
    // `global` + `save00` 无 Int64 近似 → 逐字节同构；`save01–03` + `save1000` 是近似档
    // → 按 §5.19 既有口径跳过字节级（改由下一条"方案 B passthrough"用例覆盖）。
    // 不写死这两个数，"六档逐字节一致"的说法在只剩几档、或引擎换了编码决策时会悄悄成立。
    expect({ 逐字节同构档数: byteVerified, 近似档数: approximatedCount }).toEqual({
      逐字节同构档数: 2,
      近似档数: 4,
    });

    // eslint-disable-next-line no-console
    console.log(`[golden] 载荷层原样写回：\n  ${report.join('\n  ')}`);
  }, 240_000);

  it.skipIf(!HAS_SAV)('方案 B：keepRaw passthrough —— 近似档（Int64）也字节级一致 + 注入与守卫', async () => {
    expect({ 缺档: missingFrom(SAV_DIR, GOLDEN_ARCHIVES) }).toEqual({ 缺档: [] });
    const report: string[] = [];
    let injected = false;
    let guarded = false;
    let passthroughVerified = 0;

    for (const fileName of GOLDEN_ARCHIVES) {
      const filePath = nodeJoin(SAV_DIR, fileName);
      const raw = readFileSync(filePath);
      const body = await gunzipBytes(raw.subarray(16));
      const archive = await parseArchive(raw, filePath, { keepArrayCells: true, keepRaw: true });

      // ---- 无覆盖：passthrough 应字节级一致（含 Int64 近似档——第十一批在此显式拒绝）----
      const reserialized = serializePayload(archive);
      const diff = firstDiff(body, reserialized);
      report.push(`${fileName}: 载荷 ${body.length}B / passthrough 差异 ${diff.count}`);
      expect(reserialized.length).toBe(body.length);
      expect(diff.count).toBe(0);
      passthroughVerified++;

      // ---- 注入验证（只在 save00 做一次：标量覆盖 + RANDDATA 守卫）----
      if (!injected && archive.fileType === 'normal') {
        // 标量：主变量区全是数组（DAY/MONEY/FLAG…），int 标量在角色块（ISASSI/NO）
        const block = archive.chars?.[0];
        const scalar = block?.vars.find((v) => v.type === 'int');
        if (block && scalar) {
          const out = serializePayload(archive, {
            overrides: { chars: new Map([[block.index, new Map([[scalar.key, 123456789]])]]) },
          });
          const reparsed = await parseArchive(wrapRaw(out), filePath, {});
          const hit = reparsed.chars?.[0]?.vars.find((v) => v.key === scalar.key);
          expect(hit && 'value' in hit ? hit.value : undefined).toBe(123456789);
          report.push(`${fileName}: 注入 char${block.index}.${scalar.key}=123456789 ✓ 重解析读回一致`);
          injected = true;
        }
      }
      // ---- 守卫：读侧近似的 Int64 单元（save01+ 的 RESULT/CFLAG/GIFT_GOT 等）
      //      一旦重编码必须拒绝。RANDDATA 是 u32 快照逐值安全，真正的雷在这些变量。
      if (!guarded && archive.fileType === 'normal') {
        const findUnsafe = (vs: { key: string; cells?: { index: number[]; value: number }[] }[] | undefined) =>
          (vs ?? []).map((v) => ({
            v,
            cell: (v.cells ?? []).find((c) => typeof c.value === 'number' && !Number.isSafeInteger(c.value)),
          })).find((x) => x.cell);
        const hitTop = findUnsafe(archive.vars as never);
        const hitChar = (archive.chars ?? [])
          .map((b) => ({ b, hit: findUnsafe(b.vars as never) }))
          .find((x) => x.hit);
        const hc = hitChar?.hit;
        if (hitTop?.v && hitTop.cell) {
          const patch = { index: [...hitTop.cell.index], value: 1 };
          expect(() =>
            serializePayload(archive, { overrides: { vars: new Map([[hitTop.v.key, [patch]]]) } }),
          ).toThrow(/超出安全整数域/);
          guarded = true;
        } else if (hitChar?.b && hc?.v && hc.cell) {
          const patch = { index: [...hc.cell.index], value: 1 };
          expect(() =>
            serializePayload(archive, {
              overrides: { chars: new Map([[hitChar.b.index, new Map([[hc.v.key, [patch]]])]]) },
            }),
          ).toThrow(/超出安全整数域/);
          guarded = true;
        }
        if (guarded) report.push(`${fileName}: Int64 注入守卫 ✓ 拒绝（读侧近似值不可重编码）`);
      }
    }
    expect(injected).toBe(true);
    expect(guarded).toBe(true);
    // 方案 B 的真实强度：**六档全部** passthrough 逐字节一致（近似档靠 raw 原样复制，不重编码）
    expect({ 'passthrough 同构档数': passthroughVerified }).toEqual({ 'passthrough 同构档数': 6 });
    // eslint-disable-next-line no-console
    console.log(`[golden] 方案 B keepRaw passthrough + 注入：\n  ${report.join('\n  ')}`);
  }, 240_000);

  it.skipIf(!HAS_SAV)('第十五批：容器级注入链路（gzip 组装 → 解压回读 → 覆盖值逐条验证）', async () => {
    const filePath = nodeJoin(SAV_DIR, 'save00.sav');
    const raw = readFileSync(filePath);

    // keepRaw 全量解析（注入链路的读侧前置）
    const archive = await parseArchive(raw, filePath, { keepArrayCells: true, keepRaw: true });
    expect(archive.fileType).toBe('normal');

    // 选角色块 0 的首个整数标量作注入目标（动态定位，不硬编码变量名）
    const block = archive.chars![0]!;
    const scalar = block.vars.find((v) => v.type === 'int');
    expect(scalar).toBeTruthy();
    const overrides = {
      chars: new Map([[block.index, new Map([[scalar!.key, 424242]])]]),
    };

    // 完整写链路：serialize → 容器组装（沿用 gzip）→ 直接按存档容器回读
    const payload = serializePayload(archive, { overrides });
    const full = await assembleArchiveFile(payload, archive.format);
    const reparsed = await parseArchive(full, filePath, { keepArrayCells: true });
    expect(reparsed.remaining).toBe(0);

    // 回读验证：覆盖值真实落盘（与 engine.inject 的验证逻辑同函数）
    const report = verifyOverrides(reparsed, overrides);
    expect(report.mismatches).toEqual([]);
    expect(report.checked).toBe(1);
    const hit = reparsed.chars![0]!.vars.find((v) => v.key === scalar!.key)!;
    expect((hit as { value: number }).value).toBe(424242);

    // gzip 容器写回：解压后载荷可再次读出（容器对称性）
    const body2 = await gunzipBytes(full.subarray(16));
    expect(body2.length).toBe(payload.length);
  }, 240_000);
});

/** RAW 头重打包（parse 支持 raw 容器） */
function wrapRaw(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, 0x0a1a0a0d41524589n, true);
  dv.setUint32(8, 1808, true);
  out.set(payload, 16);
  return out;
}
