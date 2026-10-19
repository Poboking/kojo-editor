/**
 * 结构解析（tree-sitter）· **增量 == 全量 随机编辑等价闸**（TSIT3-B）。
 *
 * ## 这道闸存在的唯一理由
 *
 * `engine.ts` 的增量那条腿（`tree.edit` → 有界取字重解 → 脏段窗口 + 三段合并 + 缓存平移）
 * 一旦漂，症状是"**增量结果和全篇重解不一样**"：着色/折叠/诊断悄悄偏移一行，而**没有任何一条
 * 现有用例会红**——`tree-sitter-parse.perf.test.ts` 量的是耗时，它那里只有一条手写编辑序列
 * （`stream`，24 击）在为等价性说话。手写序列的盲区正是缓存类错误最爱的地方（"这一步恰好
 * 没压到边界"）。本闸把判据换成**确定性模糊**：固定种子 × 多夹具 × 200 步随机编辑，
 * **每一步**都拿"增量"与"同一内容从零整篇重解"逐字对账三面。
 *
 * ## 三面（逐字节，不是"没崩"）
 *
 * 1. **行分类序列** = 引擎 `semantic` 回话的 token 数组（`tier` + 起止行列 = 生产代码里那份
 *    按行分类的落屏序列；`classifyLines` 那份 kind↔节点名表由语法包自己的对照闸钉，
 *    本闸钉的是"同一条腿增量与全量是否同解"）；
 * 2. **折叠区间集合** = `folds` 回话（起止行）；
 * 3. **语法诊断位集合** = `syntax` 回话（ERROR/MISSING 的落点行列 + 类别 + 块头行 + 该等的记号名，
 *    连 `truncated` 标记一起比）。
 *
 * 顺序也是判据的一部分：三段拼接的结果必须与整篇重查**逐字等序**（`engine.ts` 头注第 3 条那句
 * "拼出来的序列与整篇重查逐字相等"就是这条断言的书面承诺）。
 *
 * ## 打的是生产代码，且在子进程里打
 *
 * 增量侧走 `edit.ts` 的 `commonEdit()` → `StructureEngine.change()`（`tree.edit` + 脏段窗口那条
 * 真实路），真值侧走 `StructureEngine.parse()`；两者都在 `helpers/tree-sitter-incremental-fuzz.ts`
 * 的子进程里跑（web-tree-sitter 0.27 + Node 24/Windows：解过档的进程退出必 `Fatal process out of
 * memory: Zone`，且每解一次原生 RSS 只涨不还 ⇒ 见该文件头注的实测）。**本文件（vitest fork）
 * 一个字节 wasm 都不碰**，只做纯字符串重放 + 收 stdout 的 JSON 判据。
 * 子进程退出码**不作判据**（崩溃码是环境性质不是结果性质），判据 = 那行 JSON 解析得开、
 * `error` 为 null，并且父进程自己收尾干净（`docs/PITFALLS.md` 第 138 条那条假读数事故）。
 *
 * ## 规模（下限，写死在 helper 里）
 *
 * `FUZZ_EDITS_PER_SEQUENCE = 200` 步 × `FUZZ_SEEDS`（3 枚固定种子）× `FUZZ_FIXTURES`
 * （真实语料形状 1 枚 + 故意残缺 2 枚）= **1,800 步**，每步三面逐元素对账。
 * 每一步的编辑类型都在 `FUZZ_EDIT_KINDS` 里（单行插入 / 跨行整段粘贴 / 整段删除 / 行内插入 /
 * 行内删除 / 块首尾与缩进边界处的空行 / 行内拆行 / 删换行合并），且判据要求**每条序列八类都出现过**
 * ——覆盖率不达标时这条闸自己先红，不许静默空转。
 *
 * ## "这条闸自己有效"的判据（等价判据之外的每一条都是防白跑）
 *
 * · 走上过查询窗口的步数（不然比的其实是"整篇重算 == 整篇重算"）；
 * · 改动过行数的步数（缓存平移那条腿）；
 * · 带回过非空折叠 / 非空诊断的步数（两面有货才谈得上对账）；
 * · 父子两侧的文本长度逐步相等（编辑序列一漂，两边比的就是不同的文档）。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FUZZ_EDIT_KINDS,
  FUZZ_EDITS_PER_SEQUENCE,
  FUZZ_FIXTURES,
  FUZZ_MAX_CHILDREN_PER_SEQUENCE,
  FUZZ_MAX_STEPS_PER_CHILD,
  FUZZ_SEEDS,
  buildFuzzSequence,
  type FuzzChildResult,
  type FuzzEditKind,
  type FuzzFixture,
  type FuzzStepRecord,
} from './helpers/tree-sitter-incremental-fuzz';

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const helperScript = join(here, 'helpers', 'tree-sitter-incremental-fuzz.ts');

/** 子进程回传的是一整条序列的对账记录（token 本体不留，只留条数与差异说明）⇒ 仍给足 maxBuffer */
const CHILD_MAX_BUFFER = 64 * 1024 * 1024;

/** 走上查询窗口的步数下限：真实语料那一档每种子至少三成编辑走窗口（实测远高于此，留余量给别的机器） */
const MIN_WINDOWED_PER_SEED_REAL = 60;

function fixtureText(fixture: FuzzFixture): string {
  return readFileSync(join(repoRoot, fixture.path), 'utf8');
}

/**
 * 跑一台子进程。**退出码不作判据**（见文件头：解过档的进程收尾必被 V8 中止），
 * 只看 stdout 最后一行 JSON；解析不开就把 rc / signal / stderr 尾部一起说出去。
 */
function runChild(fixtureId: string, seed: number, startStep: number): FuzzChildResult {
  const env: Record<string, string | undefined> = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.NODE_OPTIONS; // vitest 注入的旗标不带进子进程（子进程只要 node 本身）
  const result = spawnSync(
    process.execPath,
    [helperScript, '--fuzz-child', fixtureId, String(seed), String(startStep), String(FUZZ_MAX_STEPS_PER_CHILD)],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: CHILD_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  const line = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  let parsed: FuzzChildResult;
  try {
    parsed = JSON.parse(line) as FuzzChildResult;
  } catch {
    throw new Error(
      `子进程（${fixtureId} 种子 ${seed} 起始步 ${startStep}）没有给出合法 JSON：rc=${result.status} signal=${result.signal}\n` +
        `stdout 末行：${line.slice(0, 400)}\nstderr 尾部：\n${(result.stderr ?? '').slice(-800)}`,
    );
  }
  if (parsed.error !== null) {
    throw new Error(`子进程（${fixtureId} 种子 ${seed} 起始步 ${startStep}）内部抛错：\n${parsed.error}`);
  }
  return parsed;
}

interface SequenceRun {
  readonly fixture: FuzzFixture;
  readonly seed: number;
  readonly records: readonly FuzzStepRecord[];
  readonly children: number;
  readonly peakRssMb: number;
  readonly fatal: readonly string[];
  readonly kindCounts: ReadonlyMap<FuzzEditKind, number>;
  readonly windowed: number;
  readonly full: number;
  readonly rowShifting: number;
  readonly withFolds: number;
  readonly withFaults: number;
  readonly comparedElements: number;
}

/** 一条序列 = 200 步，按 RSS 预算切成若干台子进程接力（接力点不影响判据：序列是纯字符串算出来的） */
function runSequence(fixture: FuzzFixture, seed: number): SequenceRun {
  const text = fixtureText(fixture);
  const expected = buildFuzzSequence(text, seed, FUZZ_EDITS_PER_SEQUENCE);
  const records: FuzzStepRecord[] = [];
  const fatal: string[] = [];
  let step = 0;
  let children = 0;
  let peakRssMb = 0;

  while (step < FUZZ_EDITS_PER_SEQUENCE) {
    children += 1;
    if (children > FUZZ_MAX_CHILDREN_PER_SEQUENCE) {
      throw new Error(`${fixture.id} 种子 ${seed}：一条序列换了 ${children} 台子进程还没跑完 ⇒ 切法出问题了`);
    }
    const child = runChild(fixture.id, seed, step);
    if (child.fixtureLength !== text.length) {
      throw new Error(
        `${fixture.id}：子进程读的夹具是 ${child.fixtureLength} 码元，父进程读到 ${text.length} ⇒ 两侧不是同一份夹具`,
      );
    }
    if (child.records.length === 0) {
      throw new Error(`${fixture.id} 种子 ${seed}：起始步 ${step} 的子进程一步都没跑（判据会拿到空表装绿）`);
    }
    fatal.push(...child.fatal);
    peakRssMb = Math.max(peakRssMb, child.memory.peakRssMb);
    for (const record of child.records) {
      if (record.step !== records.length) {
        throw new Error(
          `${fixture.id} 种子 ${seed}：子进程回的第 ${record.step} 步不接在上一步之后（应为第 ${records.length} 步）` +
            ` ⇒ 对账跳步，判据会漏掉中间那几步`,
        );
      }
      const want = expected[record.step];
      if (want === undefined) {
        throw new Error(`${fixture.id} 种子 ${seed}：子进程回了第 ${record.step} 步，父进程这一步没有编辑`);
      }
      if (record.docLength !== want.nextLength) {
        throw new Error(
          `${fixture.id} 种子 ${seed}：第 ${record.step + 1} 步文档长度不等（父 ${want.nextLength} / 子 ${record.docLength}）` +
            ` ⇒ 父子编辑序列漂了，这一步比的是两份不同文本`,
        );
      }
      records.push(record);
    }
    step = records.length;
    if (child.fatal.length > 0) {
      // 增量链整档停用 ⇒ 后续步骤没有可比对象；把"停用"本身交给 fatal 判据去红，别再烧内存
      break;
    }
  }

  const kindCounts = new Map<FuzzEditKind, number>();
  for (const record of records) {
    const kind = record.kind as FuzzEditKind;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  return {
    fixture,
    seed,
    records,
    children,
    peakRssMb,
    fatal,
    kindCounts,
    windowed: records.filter((record) => record.queryScope === 'window').length,
    full: records.filter((record) => record.queryScope === 'full').length,
    rowShifting: records.filter((record) => record.deltaRows !== 0).length,
    withFolds: records.filter((record) => record.folds > 0).length,
    withFaults: records.filter((record) => record.faults > 0).length,
    comparedElements: records.reduce((sum, record) => sum + record.comparedElements, 0),
  };
}

/** 不等价的那一步怎么说人话：第几步 / 什么编辑 / 期望 vs 实际 / 这一趟走的是窗口还是整篇 */
function describeMismatch(run: SequenceRun, record: FuzzStepRecord): string {
  const head = record.step === 0 ? '' : `（上一步：${run.records[record.step - 1]!.kind}）`;
  return (
    `#${record.step + 1} 步 ${record.kind}${head} @行 ${record.row + 1} 偏移 ${record.offset}：` +
    `删 ${record.deleteCount} 码元 ${record.removedPreview}、插 ${record.insertPreview} ⇒ ${record.mismatch}` +
    ` [查询范围 ${record.queryScope}，窗口节点 ${record.windowNodes}，脏段 ${record.changedRanges}` +
    `${record.queryFullReason ? `，退回整篇理由：${record.queryFullReason}` : ''}]`
  );
}

const runs: SequenceRun[] = [];

function runFor(fixture: FuzzFixture): SequenceRun[] {
  return runs.filter((run) => run.fixture.id === fixture.id);
}

describe('结构解析 · 增量 == 全量 随机编辑等价闸（三面逐字节，200 步 × 3 种子 × 夹具）', () => {
  it('父子两侧的编辑序列本身可复现（纯字符串侧先对齐，等价判据才不是比两份不同文本）', () => {
    for (const fixture of FUZZ_FIXTURES) {
      const text = fixtureText(fixture);
      expect(text.length, `${fixture.id}：夹具读出来是空的？`).toBeGreaterThan(0);
      for (const seed of FUZZ_SEEDS) {
        const once = buildFuzzSequence(text, seed, FUZZ_EDITS_PER_SEQUENCE);
        const twice = buildFuzzSequence(text, seed, FUZZ_EDITS_PER_SEQUENCE);
        expect(
          once.map((edit) => `${edit.kind}@${edit.offset}+${edit.deleteCount}:${edit.insert}`).join('|'),
          `种子 ${seed} 的 ${fixture.id} 序列两次算出来不等 ⇒ RNG 或编辑算子不确定，整道闸都不可复现`,
        ).toBe(twice.map((edit) => `${edit.kind}@${edit.offset}+${edit.deleteCount}:${edit.insert}`).join('|'));
        expect(once).toHaveLength(FUZZ_EDITS_PER_SEQUENCE);
        const kinds = new Set(once.map((edit) => edit.kind));
        expect(
          FUZZ_EDIT_KINDS.filter((kind) => !kinds.has(kind)),
          `种子 ${seed} 的 ${fixture.id} 序列缺这些编辑形状 ⇒ 覆盖率判据不达标：`,
        ).toEqual([]);
      }
    }
  });

  for (const fixture of FUZZ_FIXTURES) {
    it(`${fixture.id}（${fixture.shape === 'real' ? '真实语料形状' : '故意残缺'}）：每一击三面都与整篇重解逐字相等`, () => {
      for (const seed of FUZZ_SEEDS) {
        runs.push(runSequence(fixture, seed));
      }
      const group = runFor(fixture);
      const bad = group.flatMap((run) => run.records.filter((record) => record.mismatch !== null).map((record) => describeMismatch(run, record)));
      const fatal = group.flatMap((run) => run.fatal);

      console.log(`\n===== 增量 == 全量 随机编辑对账 · ${fixture.id}（${fixture.shape}）=====`);
      for (const run of group) {
        console.log(
          `种子 0x${run.seed.toString(16)}：${run.records.length} 步 / ${run.children} 台子进程（峰值 RSS ${run.peakRssMb} MB）/ 走窗口 ${run.windowed}、整篇 ${run.full} / 改行数 ${run.rowShifting} / 有折叠 ${run.withFolds} / 有诊断 ${run.withFaults} / 逐元素比较 ${run.comparedElements} 次`,
        );
        console.log(`  形状分布：${[...run.kindCounts].map(([kind, count]) => `${kind}×${count}`).join(' / ')}`);
      }

      // ① 主判据：任何一步、任何一面不等价就红，红里带"第几步/什么编辑/期望 vs 实际"
      expect(
        bad.slice(0, 8),
        `有 ${bad.length} 步的增量结果与整篇重解不等（最多列 8 条）⇒ 脏段窗口 / 缓存平移 / 增量解有一条漂了`,
      ).toEqual([]);
      // ② 引擎不许"悄悄停用后靠空回话装绿"
      expect(fatal, `序列期间出现整档停用级别的错误：${JSON.stringify(fatal.slice(0, 3))}`).toHaveLength(0);
      for (const run of group) {
        expect(run.records, `种子 0x${run.seed.toString(16)} 的步数不足（对账不能少于 ${FUZZ_EDITS_PER_SEQUENCE} 步）`).toHaveLength(
          FUZZ_EDITS_PER_SEQUENCE,
        );
        expect(run.records.map((record) => record.step), '步号必须连续（跳一步就是对账漏一步）').toEqual(
          Array.from({ length: FUZZ_EDITS_PER_SEQUENCE }, (_unused, index) => index),
        );
        expect(
          FUZZ_EDIT_KINDS.filter((kind) => !run.kindCounts.has(kind)),
          `种子 0x${run.seed.toString(16)} 的序列缺这些编辑形状 ⇒ 本闸对该形状没有判据`,
        ).toEqual([]);
        expect(
          run.records.filter((record) => record.tokens < 0 || record.folds < 0 || record.faults < 0).map((record) => `#${record.step + 1}`),
          '有步骤引擎没有回齐三面（-1 = 那一面根本没回话；空表不等于等价）',
        ).toEqual([]);
        // ③ 这条闸自己也必须有效：一次窗口都没走上，比的就不是"增量 vs 全量"
        if (fixture.shape === 'real') {
          expect(
            run.windowed,
            `真实语料那一档走上查询窗口的步数只有 ${run.windowed}（<${MIN_WINDOWED_PER_SEED_REAL}）⇒ 窗口那条腿没被量到，本闸退化成"整篇 == 整篇"`,
          ).toBeGreaterThanOrEqual(MIN_WINDOWED_PER_SEED_REAL);
        } else {
          expect(run.windowed, '残缺档上一次窗口都没走上 ⇒ 缓存拼装那条腿在错误恢复下没被量到').toBeGreaterThan(0);
        }
        expect(run.rowShifting, '整条序列没有一步真的改到行数 ⇒ 缓存平移那条判据是空的').toBeGreaterThan(0);
        expect(run.withFolds, '整条序列没有一步带回过折叠 ⇒ 折叠那一面比的是空气').toBeGreaterThan(0);
        expect(run.withFaults, '整条序列没有一步带回过语法诊断 ⇒ 诊断那一面比的是空气').toBeGreaterThan(0);
      }
    }, 900_000);
  }

  it('汇总读数（规模下限自查：1,800 步 × 三面）', () => {
    const totalSteps = runs.reduce((sum, run) => sum + run.records.length, 0);
    const totalElements = runs.reduce((sum, run) => sum + run.comparedElements, 0);
    const totalChildren = runs.reduce((sum, run) => sum + run.children, 0);
    const worstRss = runs.reduce((max, run) => Math.max(max, run.peakRssMb), 0);
    const windowed = runs.reduce((sum, run) => sum + run.windowed, 0);
    const mismatches = runs.reduce((sum, run) => sum + run.records.filter((record) => record.mismatch !== null).length, 0);
    console.log(
      `\n===== 等价闸总计 =====\n序列 ${runs.length} 条（${FUZZ_FIXTURES.length} 夹具 × ${FUZZ_SEEDS.length} 种子）/ 编辑 ${totalSteps} 步 / 子进程 ${totalChildren} 台（单台峰值 RSS ${worstRss} MB）/ 走窗口 ${windowed} 步 / 逐元素比较 ${totalElements} 次 / 不等价 ${mismatches} 步`,
    );
    expect(runs.length).toBe(FUZZ_FIXTURES.length * FUZZ_SEEDS.length);
    expect(totalSteps, '总编辑步数低于规模下限').toBeGreaterThanOrEqual(
      FUZZ_FIXTURES.length * FUZZ_SEEDS.length * FUZZ_EDITS_PER_SEQUENCE,
    );
    expect(totalElements, '逐元素比较次数少到说明有三面一直在比空表').toBeGreaterThan(100_000);
  });
});
