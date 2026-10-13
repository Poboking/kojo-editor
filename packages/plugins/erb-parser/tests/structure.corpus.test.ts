/**
 * ERB 结构体检 —— 真实语料精度基线（`KOJO_SMOKE_PROJECT` 守门，没有游戏目录自动跳过）。
 *
 * 与 `attribution.corpus.test.ts` 同一性质：**把"在作者实际写出来的东西上到底误报多少"
 * 固化成回归**。单测只能证明"我想到的形态能判对"，证明不了**没想到的形态不会误报**——
 * 而波浪线最怕的正是后者：一次假报告就能让作者从此不信所有提示（包括报对的那些）。
 *
 * 基线来源：2026-10-13 实测本机语料 `ERB/` 全量 3,818 个 `.ERB/.ERM`、4,115,009 行，
 * 体检**零报告**。第二项是**反证**：把最大的那个文件里的一条 `ENDIF` 删掉，必须报出来——
 * 没有这一条，"零报告"可能只是因为判据根本没在工作。
 *
 * ⚠ 这条基线的由来（写给下一个改判据的人）：初版把"`@` 开头的行"直接当函数边界，
 * 当场在 5 个文件上误报 23 条。真因是语料里大量**跨行 CALL 的续行**以 `@"…"` 开头
 * （`K60_2 Update.ERB:39` 那一类），于是"新函数开始了"被误判、上一个还没闭合的 `IF`
 * 被判未闭合、后面真正的 `ENDIF` 又成孤儿——**一次误报连环两条**。
 * 所以边界判据要求函数名是标识符形状；改这里之前先跑本文件。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MAX_STRUCTURE_ISSUES, checkControlFlowStructure } from '../src/structure';

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

function erbFilesUnder(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) erbFilesUnder(p, out);
    else if (/\.er[bm]$/i.test(e.name)) out.push(p);
  }
}

describe.skipIf(!SMOKE)('ERB 结构体检 · 真实语料基线', () => {
  it('全量语料零误报（且判据确实在工作）', async () => {
    const root = join(SMOKE!, 'ERB');
    statSync(root); // 语料在但结构不符预期 ⇒ 显式失败，不静默跳过
    const files: string[] = [];
    erbFilesUnder(root, files);
    expect(files.length, '语料 ERB 文件数').toBeGreaterThan(3000);

    const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));
    const reported: string[] = [];
    let lines = 0;
    let slowest = 0;
    let slowestFile = '';
    let biggest = '';
    let biggestSize = 0;

    for (const f of files) {
      const tf = await io.readText(f);
      lines += tf.text.split('\n').length;
      const size = statSync(f).size;
      if (size > biggestSize) {
        biggestSize = size;
        biggest = f;
      }
      const t0 = performance.now();
      const issues = checkControlFlowStructure(tf.text);
      const ms = performance.now() - t0;
      if (ms > slowest) {
        slowest = ms;
        slowestFile = f;
      }
      if (issues.length > 0) {
        reported.push(`${f.replace(SMOKE!, '')}:${issues[0]!.line} ${issues[0]!.message}`);
      }
    }

    // 逐条打印耗时量级（不判死：机器差异太大，这里只留读数供 BASELINES 对照）
    console.log(
      `语料 ${files.length} 文件 / ${lines} 行；最慢单文件体检 ${slowest.toFixed(1)}ms（${slowestFile.replace(SMOKE!, '')}）`,
    );
    expect(reported, `误报清单（应为空）：\n${reported.join('\n')}`).toEqual([]);

    // 反证：删掉最大文件里的一条 ENDIF，必须报出一条未闭合
    const big = await io.readText(biggest);
    const ls = big.text.split('\n');
    const idx = ls.findIndex((l) => /^\s*ENDIF\s*$/.test(l));
    expect(idx, '最大文件里找不到一条独立成行的 ENDIF（反证前提不成立，别改判据，先看语料）').toBeGreaterThan(0);
    const broken = [...ls.slice(0, idx), ...ls.slice(idx + 1)].join('\n');
    expect(checkControlFlowStructure(big.text)).toHaveLength(0);
    const after = checkControlFlowStructure(broken);
    expect(after.map((i) => [i.kind, i.statement])).toEqual([['unclosed-open', 'IF']]);
    expect(after[0]!.message).toContain('ENDIF');

    // 上限守门：整文件崩坏时不得刷出无封顶的报告
    const storm = checkControlFlowStructure(Array.from({ length: 400 }, () => 'IF A').join('\n'));
    expect(storm).toHaveLength(MAX_STRUCTURE_ISSUES);
  }, 120000);
});
