/**
 * MK-SMOKE-RECAL 判据叶子的最小单测（`tools/lib/market-smoke-rules.mjs`）。
 *
 * 三条路各打一顿，外加一条**源形状闸**：
 *   ① `parseIndexBytes` —— schema 合规，且**注册表长大不该判红**（这是本卡的根因）；
 *   ② `resolveInstallTarget` —— 装包目标从当前索引现场解析，不钉外部包；
 *   ③ `rowLagToleranceMs` / `uninstallTailProblems` —— 容差恒 > 2× 采样周期、功能面一条不松；
 *   ④ 源形状闸 —— `smoke-tauri-market.mjs` 的**代码行**里不许再出现钉外部内容的锚点常量、
 *      也不许把 ②→③ 的差值拿去比一个常数毫秒（旧判据踩在采样噪声面上的那种写法）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ROW_LAG_FLOOR_MS,
  hostAllowlisted,
  parseIndexBytes,
  resolveInstallTarget,
  rowLagToleranceMs,
  sortRows,
  uninstallTailProblems,
} from '../lib/market-smoke-rules.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const SHA = 'a'.repeat(64);

/** 一条形状合法的索引条目（覆盖只体现在 `name` / `id` / `version` 上） */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'kojo-pack',
    id: 'demo.era-tw',
    version: '1.0.3',
    name: '演示口上包',
    author: 'demo',
    license: 'MIT',
    minAppVersion: '0.4.0',
    zip: { url: 'https://github.com/poboking/kojo-market/releases/download/demo/demo.zip', sha256: SHA, bytes: 1024 },
    fileCount: 1,
    unpackedBytes: 471,
    ...over,
  };
}

function indexOf(packs: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, generatedAt: '2026-10-19T08:40:41.000Z', packs, ...over };
}

const bytesOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

describe('① 索引 schema 形状闸：钉形状，不钉外部内容', () => {
  it('合规索引零问题，并给出逐条归一后的行', () => {
    const r = parseIndexBytes(bytesOf(indexOf([entry(), entry({ kind: 'dict-pack', id: 'demo.dict', version: '1.0.0', fileCount: 1, unpackedBytes: 77 })])));
    expect(r.problems).toEqual([]);
    expect(r.packs).toHaveLength(2);
    expect(r.packs[0]).toMatchObject({ kind: 'kojo-pack', id: 'demo.era-tw', version: '1.0.3', fileCount: 1, unpackedBytes: 471 });
    expect(r.packs[0].zipSha256).toBe(SHA);
  });

  it('注册表长大（2 → 6 条 + 封面 + 不同体量）不产生任何问题——"长大了"不是"回归了"', () => {
    const packs = [
      entry(),
      entry({ kind: 'dict-pack', id: 'demo.dict', version: '1.0.0', unpackedBytes: 77, fileCount: 1 }),
      entry({ id: 'demo.worker', version: '1.0.0', fileCount: 2, unpackedBytes: 18 }),
      entry({ id: 'kojo.letty', version: '0.0.3', fileCount: 4, unpackedBytes: 140936 }),
      entry({ id: 'kojo.pmv', version: '1.0.0', unpackedBytes: 471 }),
      entry({ id: 'kojotest007', version: '1.0.0', fileCount: 10, unpackedBytes: 13133, cover: { url: 'https://poboking.github.io/kojo-market/cover.png', bytes: 2048 } }),
    ];
    const r = parseIndexBytes(bytesOf(indexOf(packs)));
    expect(r.problems).toEqual([]);
    expect(r.packs).toHaveLength(6);
  });

  it('但坏包必须点名判红：schema 版本 / generatedAt / packs 形态', () => {
    expect(parseIndexBytes(bytesOf(indexOf([entry()], { schema: 2 }))).problems.join('|')).toMatch(/schema=2/);
    expect(parseIndexBytes(bytesOf(indexOf([entry()], { generatedAt: '不是时间' }))).problems.join('|')).toMatch(/generatedAt/);
    expect(parseIndexBytes(bytesOf(indexOf('nope' as unknown as unknown[]))).problems.join('|')).toMatch(/packs 不是数组/);
    expect(parseIndexBytes(Buffer.from('<html>not json</html>', 'utf8')).problems.join('|')).toMatch(/不是合法 JSON/);
    expect(parseIndexBytes(Buffer.alloc(0)).problems.join('|')).toMatch(/空字节/);
  });

  it('每条的五项事实与 zip 锚逐项校验（kind / version / fileCount / unpackedBytes / zip）', () => {
    const bad = entry({
      kind: 'exe-pack',
      version: '1.0',
      fileCount: 0,
      unpackedBytes: -1,
      zip: { url: 'http://github.com/x.zip', sha256: 'xyz', bytes: 0 },
    });
    const text = parseIndexBytes(bytesOf(indexOf([bad]))).problems.join('|');
    expect(text).toMatch(/kind="exe-pack"/);
    expect(text).toMatch(/version="1\.0"/);
    expect(text).toMatch(/fileCount=0/);
    expect(text).toMatch(/unpackedBytes=-1/);
    expect(text).toMatch(/zip\.url 协议是 http:/);
    expect(text).toMatch(/zip\.sha256/);
    expect(text).toMatch(/zip\.bytes=0/);
  });

  it('同一条 (kind,id,version) 出现两次要点名（索引里同一条只能有一条）', () => {
    const r = parseIndexBytes(bytesOf(indexOf([entry(), entry()])));
    expect(r.problems.join('|')).toMatch(/packs\[1\].*同一个 kojo-pack\/demo\.era-tw@1\.0\.3/);
  });

  it('体积上限仍判（本仓能负责的那条锚）', () => {
    const r = parseIndexBytes(bytesOf(indexOf([entry()])), { maxBytes: 16 });
    expect(r.problems.join('|')).toMatch(/超过上限/);
  });

  it('hostAllowlisted 只认 GitHub 系（终止 URL 的形态闸）', () => {
    expect(hostAllowlisted('poboking.github.io')).toBe(true);
    expect(hostAllowlisted('github.com')).toBe(true);
    expect(hostAllowlisted('evil.example.com')).toBe(false);
    expect(hostAllowlisted('github.io.evil.com')).toBe(false);
    expect(hostAllowlisted('')).toBe(false);
  });

  it('sortRows 与输入顺序无关（对平不靠顺序）', () => {
    const a = parseIndexBytes(bytesOf(indexOf([entry(), entry({ id: 'z', version: '2.0.0' })])));
    const b = parseIndexBytes(bytesOf(indexOf([entry({ id: 'z', version: '2.0.0' }), entry()])));
    expect(sortRows(a.packs)).toEqual(sortRows(b.packs));
  });
});

describe('② 装包目标：从当前索引现场解析（不钉外部包）', () => {
  const preferred = { kind: 'kojo-pack', id: 'demo.era-tw', version: '1.0.3' };
  const row = (o: Record<string, unknown>): Record<string, unknown> => ({
    kind: 'kojo-pack', id: 'x', version: '1.0.0', fileCount: 1, unpackedBytes: 10, zipSha256: SHA, zipBytes: 100, ...o,
  });

  it('首选那条还在 ⇒ 用它', () => {
    const picked = resolveInstallTarget([row({ id: 'other', unpackedBytes: 1 }), row({ id: 'demo.era-tw', version: '1.0.3' })], preferred);
    expect(picked?.entry.id).toBe('demo.era-tw');
    expect(picked?.why).toMatch(/仍有/);
  });

  it('首选那条没了 ⇒ 退回同种类最小的包（社区大包不往下载路上带）', () => {
    const picked = resolveInstallTarget([row({ id: 'big', unpackedBytes: 9_000_000 }), row({ id: 'small', unpackedBytes: 18 })], preferred);
    expect(picked?.entry.id).toBe('small');
    expect(picked?.why).toMatch(/改用/);
  });

  it('一条可装的都没有 ⇒ null（调用方报 SKIP，不假装测过）', () => {
    expect(resolveInstallTarget([], preferred)).toBeNull();
    expect(resolveInstallTarget(null as unknown as Record<string, unknown>[], preferred)).toBeNull();
  });
});

describe('③ 卸载尾巴判据：容差 > 2× 采样周期，功能面不松', () => {
  it('容差地板 = 3 × 300ms，且随实测采样周期放大（恒 > 2×）', () => {
    expect(ROW_LAG_FLOOR_MS).toBe(900);
    expect(rowLagToleranceMs(300)).toBe(900);
    expect(rowLagToleranceMs(300)).toBeGreaterThan(2 * 300);
    expect(rowLagToleranceMs(1_000)).toBeGreaterThan(2 * 1_000);
    expect(rowLagToleranceMs(0)).toBe(ROW_LAG_FLOOR_MS);
  });

  it('撤行与「已卸掉…」结果句同拍（10ms 差）⇒ 通过', () => {
    expect(uninstallTailProblems({ rowGoneMs: 210, doneMs: 200, dirGoneMs: 180, samplingMs: 300 })).toEqual([]);
  });

  it('撤行比结果句晚过容差 ⇒ 判红，且读数带毫秒', () => {
    const probs = uninstallTailProblems({ rowGoneMs: 3_000, doneMs: 200, dirGoneMs: 180, samplingMs: 300 });
    expect(probs.join('|')).toMatch(/晚 2800ms/);
    expect(probs.join('|')).toMatch(/≤ 结果句 \+ 900ms/);
  });

  it('行根本没消失 / 结果句没上屏 / 屏上先于盘上消失 ⇒ 各判红（不是"只比时间差"）', () => {
    expect(uninstallTailProblems({ rowGoneMs: null, doneMs: 200, dirGoneMs: 180, samplingMs: 300 }).join('|')).toMatch(/行没消失/);
    expect(uninstallTailProblems({ rowGoneMs: 300, doneMs: null, dirGoneMs: 180, samplingMs: 300 }).join('|')).toMatch(/没有上屏/);
    expect(uninstallTailProblems({ rowGoneMs: 100, doneMs: 200, dirGoneMs: 5_000, samplingMs: 300 }).join('|')).toMatch(/屏上先于盘上/);
    expect(uninstallTailProblems({ rowGoneMs: 300, doneMs: 200, dirGoneMs: 180, samplingMs: 300, failNote: '卸载没有成功：xx' }).join('|')).toMatch(/卸载没有成功/);
  });

  it('③−② 本身不再是判据：卸载尾巴再长，只要 ③ 与 ④ 同拍就通过', () => {
    // 记账写盘 + 祖先目录 + 暂存清扫把 ② 拖到 100ms、③④ 同拍在 2,100ms —— 这正是旧口径每跑皆红的那一跑
    expect(uninstallTailProblems({ rowGoneMs: 2_100, doneMs: 2_095, dirGoneMs: 100, samplingMs: 300 })).toEqual([]);
  });
});

describe('④ 源形状闸：冒烟脚本不许把外部内容钉回去', () => {
  const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
  /** 剥注释（口径照 `smoke-port-single-source.test.ts`）：块注释先摘掉，再逐行去行注释 */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .filter((line) => {
        const t = line.trim();
        return t !== '' && !t.startsWith('*');
      })
      .join('\n');

  const code = stripComments(read('tools/smoke-tauri-market.mjs'));

  it('剥注释器自检：代码位上的字面量可命中，注释里的历史说法不命中', () => {
    expect(code).toContain('INDEX_URL');
    expect(code).not.toContain('旧口径「③ ≤ ② + 300ms」');
  });

  it('不再钉外部注册表的字节数 / sha256 / 包条数 / 容器摘要', () => {
    expect(code).not.toMatch(/ANCHOR_(BYTES|SHA256|PACKS)/);
    expect(code).not.toMatch(/K_CONTAINER_SHA/);
    expect(code).not.toMatch(/f1b72c01|d88a4a24/);
  });

  it('判据走规则模块（形状闸 / 目标解析 / 尾巴判据都在那边，可单测）', () => {
    expect(code).toMatch(/from '\.\/lib\/market-smoke-rules\.mjs'/);
    expect(code).toContain('parseIndexBytes(');
    expect(code).toContain('resolveInstallTarget(');
    expect(code).toContain('uninstallTailProblems(');
  });

  it('k 项的两处毫秒差不再拿常数去卡（旧写法 = 判据踩在采样噪声面上）', () => {
    expect(code).not.toMatch(/(kGoneMs|kDirMs)\s*[<>]=?\s*(kGoneMs|kDirMs)\s*\+\s*\d+/);
    expect(code).toContain('rowLagToleranceMs(');
  });
});
