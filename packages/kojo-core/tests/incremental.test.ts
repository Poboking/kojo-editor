/**
 * 增量编译护栏：**增量结果必须与全量 compile 逐字等价** + keystroke 墙钟读数 + 退化路径。
 *
 * 本文件同时含计时用例（`performance.now` + 墙钟预算断言），会被 `tools/perf-suite.mjs`
 * 自动分进串行静默池（与 bench 用例同池），避免并行池互相饿死导致随机红。因此：
 * 用主配置直接点名本文件会得到 "No test files found"（它被 mainExclude 排除），
 * 正确跑法是 `--config vitest.perf.config.ts`，或直接 `pnpm test`（unit + perf 两池）。
 *
 * 计时口径（写死，别改松）：
 * - 预算 = 60fps 的单帧 16ms；CI/慢机允许放宽到 30ms（`CI=true` 时生效），
 *   依据是本仓计时池的既有口径（`vitest.perf.config.ts` 串行静默池）。
 * - 同时钉一条**相对**护栏：增量中位数必须 < 全量中位数的 25%——绝对预算在超快机器上
 *   没有区分度，相对比例才证明"真的只重算了脏区间"，而不是整条流水线变快了。
 * - 三种 keystroke 各测 10 次取中位数：插入 1 字符 / 删除 1 字符 / 中间行替换 1 字符；
 *   测量前做预热（含一次全量构建）。
 */
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { compileKojoSource } from '../src/compile.js';
import type { CompileKojoSourceResult } from '../src/compile.js';
import { createIncrementalCompiler } from '../src/incremental.js';
import type { IncrementalEdit } from '../src/incremental.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import type { EmitResult, KojoEmitBackend } from '../src/lower/backend.js';

const BACKEND: KojoEmitBackend = {
  ...FIXTURE_BACKEND,
  wrapMachine: (request): EmitResult => [`@EVENT_${request.machine.event}`, ...request.body, '@EVENT_END'],
};

function fullCompile(source: string): CompileKojoSourceResult {
  return compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend: BACKEND });
}

function applyEdit(source: string, edit: IncrementalEdit): string {
  return source.slice(0, edit.offset) + edit.insertedText + source.slice(edit.offset + edit.removedLength);
}

function expectSameSourceMap(actual: CompileKojoSourceResult, expected: CompileKojoSourceResult): void {
  expect(actual.sourceMap.lineCount).toBe(expected.sourceMap.lineCount);
  expect(actual.sourceMap.segmentCount).toBe(expected.sourceMap.segmentCount);
  for (let line = 1; line <= expected.sourceMap.lineCount; line++) {
    expect(actual.sourceMap.lineAt(line)).toEqual(expected.sourceMap.lineAt(line));
  }
}

function expectSameResult(actual: CompileKojoSourceResult, expected: CompileKojoSourceResult): void {
  expect(actual.ok).toBe(expected.ok);
  expect(actual.erb).toBe(expected.erb);
  expect(actual.diagnostics).toEqual(expected.diagnostics);
  expect(actual.slots).toEqual(expected.slots);
  expect(actual.file).toEqual(expected.file);
  expectSameSourceMap(actual, expected);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/* ============================== 样本文本 ============================== */

const SAMPLE_BASIC = `# 机 开场
# 视 灵梦

# 幕 神社清晨
> 神社的清晨，带一个插值{恋慕}。
灵梦：「早上好。」
空行 等待
? 恋慕 > 5
    > 有点吵。
? 否
    > 安静。
> 收尾。
`;

const SAMPLE_TABLE = `# 机 开场
# 视 灵梦
# 常量 上限 整数 = 5
# 表 亲密度 由 好感
    0..2 = "疏远"
    3..4 = "点头"
    5.. = "亲近"
    否 = "陌生"
> 现在的关系：{亲密度}
灵梦：「表值也能进台词：{亲密度}。」
`;

const SAMPLE_POOL_TEMPLATE = `# 机 开场
# 视 灵梦
# 池 招呼
    ? 恋慕 > 5
        > 亲近的招呼。
    ? 否
        > 普通的招呼。
# 模 开场白(称呼)
    > {称呼}，早上好。
    [插槽]
    > 今天也一起吧。
! 招呼
! 开场白(灵梦)
    > 插槽里的一行。
> 结束。
`;

const SAMPLE_RANDOM_COLOR = `# 机 开场
# 视 灵梦
@随机
    > 风很轻。
    @组
        > 云在走。
        > 鸟在叫。
@着色 0xFF8080
    > 彩色的一行。
@颜绘 我 微笑
@颜绘 你 害羞
> 收尾。
`;

const SAMPLE_SCENES = `# 机 开场
# 视 灵梦
> 序章的一行。
# 幕 第一幕
> 第一幕的一行。
# 幕 第二幕
> 第二幕的一行。
灵梦：「第二幕的台词。」
`;

const SAMPLE_NATIVE = `# 机 开场
# 视 灵梦
@原生
    #DIM X, 0
    PRINTFORM 原生行
> 正文一行。
`;

const SAMPLE_ERRORS = `# 机 不存在的机
# 视 灵梦
「裸引号」
未知的写法行
> 正文{未闭合的插值
`;

const SAMPLE_LEGACY = `# 机 开场
# 视 灵梦
; 旧注释
如果 恋慕 > 1
    > 旧写法
> 正文一行。
`;

const SAMPLE_MISSING_MACHINE = `# 视 灵梦
> 第一行（挂点缺失的诊断落在这行）。
> 第二行可以安全地增量编辑。
`;

const SAMPLE_OPTIONS = `# 机 开场
# 视 灵梦
选项：
    「甲」：
        > 甲的正文。
`;

const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['basic', SAMPLE_BASIC],
  ['table', SAMPLE_TABLE],
  ['pool+template', SAMPLE_POOL_TEMPLATE],
  ['random+color', SAMPLE_RANDOM_COLOR],
  ['scenes', SAMPLE_SCENES],
  ['native', SAMPLE_NATIVE],
  ['errors', SAMPLE_ERRORS],
  ['legacy', SAMPLE_LEGACY],
  ['missing-machine', SAMPLE_MISSING_MACHINE],
];

/* ============================== 确定性伪随机 ============================== */

function makeRandom(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

const INSERTIONS: readonly string[] = [
  'a',
  '灵',
  '> ',
  '。',
  '「',
  '」',
  '{',
  '}',
  '：',
  ' ',
  '0',
  '? 否',
  '# 幕 临时',
  '@着色 ',
  '\n',
  '\n    > 新行',
  '    ',
];

function randomEdit(text: string, random: (limit: number) => number): IncrementalEdit {
  const offset = random(text.length + 1);
  const maxRemove = Math.min(text.length - offset, 5);
  const removedLength = maxRemove === 0 ? 0 : random(maxRemove + 1);
  const insertedText = INSERTIONS[random(INSERTIONS.length)]!;
  return { offset, removedLength, insertedText };
}

/* ============================== 正确性：增量 === 全量 ============================== */

describe('incremental：增量 === 全量', () => {
  it('首次构建与全量逐字一致（含诊断 / source map / 隐藏槽 / AST）', () => {
    for (const [label, source] of SAMPLES) {
      const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
      const update = compiler.update(source);
      const expected = fullCompile(source);
      expectSameResult(update.result, expected);
      expect(update.stats.fallbackFull).toBe(true); // 首次没有上一轮可复用
      expect(update.stats.fallbackReason).toBe('initial-build');
      if (label === 'options') {
        expect(compiler.degraded).toBe(true);
        continue;
      }
      expect(compiler.degraded).toBe(false);
    }
  });

  it('随机构造编辑：每一步增量 === 全量（确定性种子）', () => {
    let sawIncremental = false;
    for (const [label, source] of SAMPLES) {
      const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
      compiler.update(source);
      let text = source;
      const random = makeRandom(0x2f6e2b1 + label.length);
      for (let step = 0; step < 24; step++) {
        const edit = randomEdit(text, random);
        text = applyEdit(text, edit);
        const update = compiler.update(text, edit);
        if (!update.stats.fallbackFull) sawIncremental = true;
        expectSameResult(update.result, fullCompile(text));
        if (compiler.degraded) break;
      }
    }
    expect(sawIncremental).toBe(true);
  });

  it('普通叙事单元的 1 字符编辑走增量，且读数自洽', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const line = '> 神社的清晨，带一个插值{恋慕}。';
    const offset = SAMPLE_BASIC.indexOf(line) + 2;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '很' };
    const text = applyEdit(SAMPLE_BASIC, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.reparsedUnits).toBe(1);
    expect(update.stats.reloweredUnits).toBe(1);
    expect(update.stats.relexedLines).toBe(1);
    expect(update.stats.reusedNodes).toBeGreaterThan(0);
    expect(update.stats.ms).toBeGreaterThanOrEqual(0);
    expectSameResult(update.result, fullCompile(text));
  });

  it('隐藏槽顺序：随机 / 表 / 模板混合编辑后仍与全量一致', () => {
    const mixed = `${SAMPLE_TABLE}
@随机
    > 候选甲。
    > 候选乙。
# 模 包装(值)
    > {值}
! 包装(1)
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(mixed);
    let text = mixed;
    const edits: IncrementalEdit[] = [
      { offset: mixed.indexOf('候选甲') + 1, removedLength: 0, insertedText: '大' },
      { offset: mixed.indexOf('「表值') + 3, removedLength: 0, insertedText: '新' },
      { offset: mixed.indexOf('包装(1)') + 5, removedLength: 1, insertedText: '2' },
    ];
    for (const edit of edits) {
      text = applyEdit(text, edit);
      const update = compiler.update(text, edit);
      expectSameResult(update.result, fullCompile(text));
    }
  });
});

/* ============================== 退化路径 ============================== */

describe('incremental：退化路径仍必须正确', () => {
  it('插入换行 / 跨行删除 → fallbackFull = true', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const eol = SAMPLE_BASIC.indexOf('\n') + 1;
    const newlineEdit: IncrementalEdit = { offset: eol, removedLength: 0, insertedText: '\n' };
    const withNewline = applyEdit(SAMPLE_BASIC, newlineEdit);
    const inserted = compiler.update(withNewline, newlineEdit);
    expect(inserted.stats.fallbackFull).toBe(true);
    expect(inserted.stats.fallbackReason).toBe('multiline-insert');
    expectSameResult(inserted.result, fullCompile(withNewline));

    const range: IncrementalEdit = { offset: eol, removedLength: 6, insertedText: '' };
    const carved = applyEdit(withNewline, range);
    const removed = compiler.update(carved, range);
    expect(removed.stats.fallbackFull).toBe(true);
    expect(removed.stats.fallbackReason).toBe('multiline-delete');
    expectSameResult(removed.result, fullCompile(carved));
  });

  it('改声明单元（模板 / 池 / 机）→ fallbackFull = true', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_POOL_TEMPLATE);
    const line = SAMPLE_POOL_TEMPLATE.indexOf('今天也一起吧。');
    const edit: IncrementalEdit = { offset: line + 2, removedLength: 0, insertedText: '好' };
    const text = applyEdit(SAMPLE_POOL_TEMPLATE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(true);
    expect(update.stats.fallbackReason).toBe('declaration-unit-edit');
    expectSameResult(update.result, fullCompile(text));
  });

  it('全文替换 → fallbackFull = true 且结果正确', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const replacement = `# 机 开场
# 视 灵梦
> 完全换过的正文。
`;
    const edit: IncrementalEdit = { offset: 0, removedLength: SAMPLE_BASIC.length, insertedText: replacement };
    const update = compiler.update(replacement, edit);
    expect(update.stats.fallbackFull).toBe(true);
    expectSameResult(update.result, fullCompile(replacement));
  });

  it('非法编辑区间（越界 / 负数 / 与文本不一致）→ fallbackFull = true 且结果正确', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const badEdits: IncrementalEdit[] = [
      { offset: SAMPLE_BASIC.length + 10, removedLength: 0, insertedText: 'x' },
      { offset: 3, removedLength: -1, insertedText: 'x' },
      { offset: 3, removedLength: SAMPLE_BASIC.length + 1, insertedText: 'x' },
    ];
    for (const edit of badEdits) {
      const update = compiler.update(SAMPLE_BASIC, edit);
      expect(update.stats.fallbackFull).toBe(true);
      expect(update.stats.fallbackReason).toBe('invalid-edit');
      expectSameResult(update.result, fullCompile(SAMPLE_BASIC));
    }
    // 长度对但内容与 edit 不一致（声称插入却给了未改的文本）
    const inconsistent: IncrementalEdit = { offset: 10, removedLength: 0, insertedText: 'x' };
    const update = compiler.update(SAMPLE_BASIC, inconsistent);
    expect(update.stats.fallbackFull).toBe(true);
    expect(update.stats.fallbackReason).toBe('invalid-edit');
    expectSameResult(update.result, fullCompile(SAMPLE_BASIC));
  });

  it('模型不支持（`选项` 全局计数）→ degraded，之后每轮 fallbackFull 且正确', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(SAMPLE_OPTIONS);
    expect(compiler.degraded).toBe(true);
    expectSameResult(built.result, fullCompile(SAMPLE_OPTIONS));
    const offset = SAMPLE_OPTIONS.indexOf('甲的正文');
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '新' };
    const text = applyEdit(SAMPLE_OPTIONS, edit);
    const update = compiler.update(text, edit);
    expect(compiler.degraded).toBe(true);
    expect(update.stats.fallbackFull).toBe(true);
    expectSameResult(update.result, fullCompile(text));
  });

  it('无 `# 机` 的 trailing 诊断：编辑非诊断行仍可增量且结果一致', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(SAMPLE_MISSING_MACHINE);
    expect(built.result.diagnostics.some((diagnostic) => diagnostic.code === 'core/decl/missing-machine')).toBe(true);
    const secondLine = SAMPLE_MISSING_MACHINE.indexOf('第二行') + 1;
    const edit: IncrementalEdit = { offset: secondLine, removedLength: 0, insertedText: '也' };
    const text = applyEdit(SAMPLE_MISSING_MACHINE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`@原生` 体内单字符编辑走增量且逐字等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_NATIVE);
    const offset = SAMPLE_NATIVE.indexOf('PRINTFORM') + 'PRINTFORM'.length + 1;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: 'X' };
    const text = applyEdit(SAMPLE_NATIVE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('多场景：只重算命中单元，场景边界/标题保持不变', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_SCENES);
    const offset = SAMPLE_SCENES.indexOf('第二幕的台词') + 1;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '好' };
    const text = applyEdit(SAMPLE_SCENES, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expectSameResult(update.result, fullCompile(text));
    expect(update.result.file.scenes.map((scene) => scene.title)).toEqual([null, '第一幕', '第二幕']);
  });

  it('空文件：全量构建正确；首个正文插入回退全量且正确', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update('');
    expect(built.result.ok).toBe(true);
    expect(built.result.erb).toBe('');
    expectSameResult(built.result, fullCompile(''));
    const inserted = '> 空文件来了一行。';
    const edit: IncrementalEdit = { offset: 0, removedLength: 0, insertedText: inserted };
    const update = compiler.update(inserted, edit);
    expect(update.stats.fallbackFull).toBe(true);
    expectSameResult(update.result, fullCompile(inserted));
  });
});

/* ============================== 性能护栏 ============================== */

const PERF_LINES = 5_200;

function buildPerfSource(count: number): { source: string; editOffsets: readonly number[] } {
  const lines: string[] = ['# 机 开场', '# 视 灵梦', '# 常量 上限 整数 = 5'];
  lines.push('# 表 亲密度 由 好感');
  lines.push('    0..2 = "疏远"');
  lines.push('    3.. = "亲近"');
  lines.push('    否 = "陌生"');
  lines.push('');
  for (let i = 0; i < count; i++) {
    if (i % 13 === 0) lines.push('空行');
    else if (i % 5 === 0) lines.push(`灵梦：「第${i}行的台词。」`);
    else if (i % 7 === 0) lines.push(`? 恋慕 > ${i % 9}\n    > 分支里的第${i}行。`);
    else lines.push(`> 第${i}行的叙事文本，带一个插值{恋慕}。`);
  }
  const source = `${lines.join('\n')}\n`;
  // 行首偏移直接扫**物理行**（`?` 链条目内部还含一个换行：按数组下标算会整体错位）
  const editOffsets: number[] = [];
  let offset = 0;
  for (const physical of source.split('\n')) {
    if (physical.startsWith('> 第')) editOffsets.push(offset + 2);
    offset += physical.length + 1;
  }
  return { source, editOffsets };
}

describe('incremental：keystroke 性能护栏（5000+ 行）', () => {
  it('插入 / 删除 / 中间行替换的中位数 < 16ms（CI 放宽 30ms）且 < 全量中位数的 25%', () => {
    const { source, editOffsets } = buildPerfSource(PERF_LINES);
    const sourceLines = source.split('\n').length;
    expect(sourceLines).toBeGreaterThanOrEqual(5_000);

    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const buildStarted = performance.now();
    const built = compiler.update(source);
    const buildMs = performance.now() - buildStarted;
    expect(compiler.degraded, compiler.degradedReason ?? '').toBe(false);
    expect(built.result.ok).toBe(true);

    // 基线：全量编译（先预热一次，再取 5 次中位数）
    fullCompile(buildPerfSource(300).source);
    const fullTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      fullCompile(source);
      fullTimes.push(performance.now() - started);
    }
    const fullMedianMs = median(fullTimes);

    // 取文件**中间**的正文行做 keystroke（插入 / 删除 / 替换各 15 次，取中位数）
    const middle = Math.floor(editOffsets.length / 2);
    const measured = editOffsets.slice(middle, middle + 15);
    expect(measured.length).toBe(15);
    let text = source;

    // 预热增量路径（不计数）：插入 + 删除各 4 次
    for (const offset of measured.slice(0, 4)) {
      const insert: IncrementalEdit = { offset, removedLength: 0, insertedText: 'w' };
      text = applyEdit(text, insert);
      compiler.update(text, insert);
      const remove: IncrementalEdit = { offset, removedLength: 1, insertedText: '' };
      text = applyEdit(text, remove);
      compiler.update(text, remove);
    }

    const measure = (kind: 'insert' | 'delete' | 'replace'): number[] => {
      const times: number[] = [];
      for (const offset of measured) {
        const removedText = text.slice(offset, offset + 1);
        const edit: IncrementalEdit =
          kind === 'insert'
            ? { offset, removedLength: 0, insertedText: 'k' }
            : kind === 'delete'
              ? { offset, removedLength: 1, insertedText: '' }
              : { offset, removedLength: 1, insertedText: 'r' };
        text = applyEdit(text, edit);
        const started = performance.now();
        const update = compiler.update(text, edit);
        times.push(performance.now() - started);
        if (update.stats.fallbackFull) {
          throw new Error(`keystroke 未走增量：${kind} @${offset}（${update.stats.fallbackReason ?? 'no-reason'}）`);
        }
        expect(update.stats.reparsedUnits).toBe(1);
        // 还原，保持下一次测量从同一份文本出发（插入的逆是删除，删除/替换的逆是把原字符写回）
        const revert: IncrementalEdit =
          edit.removedLength === 0
            ? { offset, removedLength: edit.insertedText.length, insertedText: '' }
            : { offset, removedLength: edit.insertedText.length, insertedText: removedText };
        text = applyEdit(text, revert);
        compiler.update(text, revert);
      }
      return times;
    };

    const insertMedianMs = median(measure('insert'));
    const deleteMedianMs = median(measure('delete'));
    const replaceMedianMs = median(measure('replace'));

    // 逐字等价抽检：一次编辑后的增量结果 === 全量
    const checkOffset = measured[0]!;
    const checkEdit: IncrementalEdit = { offset: checkOffset, removedLength: 0, insertedText: 'z' };
    const checkedText = applyEdit(source, checkEdit);
    const checked = compiler.update(checkedText, checkEdit);
    expectSameResult(checked.result, fullCompile(checkedText));

    // 绝对预算：60fps 单帧 16ms；CI/慢机 30ms（口径见文件头注释）
    const budgetMs = process.env.CI === 'true' ? 30 : 16;
    const worstMs = Math.max(insertMedianMs, deleteMedianMs, replaceMedianMs);
    // eslint-disable-next-line no-console
    console.log(
      `[incremental] ${sourceLines} 行 / 每种 ${measured.length} 次 keystroke：` +
        `插入 ${insertMedianMs.toFixed(2)}ms、删除 ${deleteMedianMs.toFixed(2)}ms、` +
        `替换 ${replaceMedianMs.toFixed(2)}ms；全量中位数 ${fullMedianMs.toFixed(1)}ms，` +
        `最差比值 ${((worstMs / fullMedianMs) * 100).toFixed(1)}%；首帧建缓存 ${buildMs.toFixed(0)}ms`,
    );
    for (const incrementalMedianMs of [insertMedianMs, deleteMedianMs, replaceMedianMs]) {
      expect(incrementalMedianMs).toBeLessThan(budgetMs);
      expect(incrementalMedianMs).toBeLessThan(fullMedianMs * 0.25);
    }
  });
});
