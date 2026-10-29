/**
 * 增量编译护栏：**增量结果必须与全量 compile 逐字等价** + keystroke 墙钟读数 + 退化路径。
 *
 * 本文件同时含计时用例（`performance.now` + 墙钟预算断言），会被 `tools/perf-suite.mjs`
 * 自动分进串行静默池（与 bench 用例同池），避免并行池互相饿死导致随机红。因此：
 * 用主配置直接点名本文件会得到 "No test files found"（它被 mainExclude 排除），
 * 正确跑法是 `--config vitest.perf.config.ts`，或直接 `pnpm test`（unit + perf 两池）。
 *
 * 计时口径（写死，别改松）：
 * - keystroke 预算 = 60fps 的单帧 16ms；CI/慢机允许放宽到 30ms（`CI=true` 时生效），
 *   依据是本仓计时池的既有口径（`vitest.perf.config.ts` 串行静默池）。
 * - **结构化增量（K2-PERF-INCR-FALLBACK）预算**：5.2k 行 fixture 上
 *   纯换行插入/删除中位数 < 60ms、单个声明单元内编辑中位数 < 100ms（CI/慢机 ×2：
 *   120ms / 200ms）——口径是"`IncrementalUpdate.ms` 墙钟、每种 11 次取中位数、
 *   测量前预热"；对照组是同一份文本的**整份缓存重建**（修前 ~200–350ms）。
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
import type {
  EmitResult,
  ForEachEmitRequest,
  ForeachCollectionDecl,
  ForeachDeclarations,
  GameAdapter,
  KojoEmitBackend,
  ProgramFeatures,
} from '../src/index.js';

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
# 视角 灵梦

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
# 视角 灵梦
# 设 上限 整数 = 5
# 对照表 亲密度 依据 好感
    0..2 -> = "疏远"
    3..4 -> = "点头"
    5.. -> = "亲近"
    否 -> = "陌生"
> 现在的关系：{亲密度}
灵梦：「表值也能进台词：{亲密度}。」
`;

const SAMPLE_POOL_TEMPLATE = `# 机 开场
# 视角 灵梦
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
# 视角 灵梦
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
# 视角 灵梦
> 序章的一行。
# 幕 第一幕
> 第一幕的一行。
# 幕 第二幕
> 第二幕的一行。
灵梦：「第二幕的台词。」
`;

const SAMPLE_NATIVE = `# 机 开场
# 视角 灵梦
@原生
    #DIM X, 0
    PRINTFORM 原生行
> 正文一行。
`;

const SAMPLE_ERRORS = `# 机 不存在的机
# 视角 灵梦
「裸引号」
未知的写法行
> 正文{未闭合的插值
`;

const SAMPLE_LEGACY = `# 机 开场
# 视角 灵梦
; 旧注释
如果 恋慕 > 1
    > 旧写法
> 正文一行。
`;

const SAMPLE_MISSING_MACHINE = `# 视角 灵梦
> 第一行（挂点缺失的诊断落在这行）。
> 第二行可以安全地增量编辑。
`;

const SAMPLE_OPTIONS = `# 机 开场
# 视角 灵梦
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
  it('纯换行插入走行号平移增量；跨行删除（跨多行正文）走结构化增量', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const eol = SAMPLE_BASIC.indexOf('\n') + 1;
    const newlineEdit: IncrementalEdit = { offset: eol, removedLength: 0, insertedText: '\n' };
    const withNewline = applyEdit(SAMPLE_BASIC, newlineEdit);
    const inserted = compiler.update(withNewline, newlineEdit);
    // 纯换行 = 行号平移路径（K2-PERF-INCR-FALLBACK）：复用全部单元缓存，只重算被新行碰到的单元
    expect(inserted.stats.fallbackFull).toBe(false);
    expect(inserted.stats.fallbackReason).toBe(null);
    expect(inserted.stats.reparsedUnits).toBeLessThanOrEqual(3);
    expectSameResult(inserted.result, fullCompile(withNewline));

    // K2-INCR-HOLES ②：跨行删不再整份重建。删掉一整段正文（不动声明 / 视点 ⇒ 平移 + halo 可证）：
    const cutStart = withNewline.indexOf('> 神社的清晨');
    const cutEnd = withNewline.indexOf('灵梦：「早上好。」');
    const range: IncrementalEdit = { offset: cutStart, removedLength: cutEnd - cutStart, insertedText: '' };
    const carved = applyEdit(withNewline, range);
    const removed = compiler.update(carved, range);
    expect(removed.stats.fallbackFull).toBe(false);
    expect(removed.stats.fallbackReason).toBe(null);
    expect(removed.stats.reparsedUnits).toBeGreaterThan(0);
    expectSameResult(removed.result, fullCompile(carved));
  });

  it('改声明单元（模板体）→ 只重建该单元 + 依赖它的展开点（不再全量）', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_POOL_TEMPLATE);
    const line = SAMPLE_POOL_TEMPLATE.indexOf('今天也一起吧。');
    const edit: IncrementalEdit = { offset: line + 2, removedLength: 0, insertedText: '好' };
    const text = applyEdit(SAMPLE_POOL_TEMPLATE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.fallbackReason).toBe(null);
    expect(update.stats.reparsedUnits).toBeLessThanOrEqual(4);
    expectSameResult(update.result, fullCompile(text));
  });

  it('全文替换 → fallbackFull = true 且结果正确', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const replacement = `# 机 开场
# 视角 灵梦
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
  const lines: string[] = ['# 机 开场', '# 视角 灵梦', '# 设 上限 整数 = 5'];
  lines.push('# 对照表 亲密度 依据 好感');
  lines.push('    0..2 -> = "疏远"');
  lines.push('    3.. -> = "亲近"');
  lines.push('    否 -> = "陌生"');
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

/* ============================== 结构化增量：行号平移 ============================== */

function slotNames(result: CompileKojoSourceResult): readonly string[] {
  return result.slots.map((slot) => slot.name);
}

/** 会把隐藏槽声明进产物的 backend（`#DIM` / `#DIMS`）：用来钉"槽名引用同步改名" */
const SLOT_BACKEND: KojoEmitBackend = {
  ...FIXTURE_BACKEND,
  wrapMachine: (request): EmitResult => [
    `@EVENT_${request.machine.event}`,
    ...request.slots.map((slot) => `#${slot.valueType === 'int' ? 'DIM' : 'DIMS'} ${slot.name}`),
    ...request.body,
    '@EVENT_END',
  ],
};

function fullCompileWith(source: string, backend: KojoEmitBackend): CompileKojoSourceResult {
  return compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend });
}

/** 在行首插入一个空行（Enter 的两种落点之一）；返回编辑与结果文本 */
function insertBlankLineAt(text: string, lineIndex: number): { edit: IncrementalEdit; text: string } {
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) offset = text.indexOf('\n', offset) + 1;
  const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '\n' };
  return { edit, text: applyEdit(text, edit) };
}

const SAMPLE_SHIFT_RANDOM = `# 机 开场
# 视角 灵梦
> 第一段正文。
@随机
    > 风很轻。
    > 云在走。
> 第二段正文。
@随机
    > 雨很冷。
    > 雪很白。
> 收尾。
`;

describe('incremental：纯换行 = 行号平移（复用全部单元缓存）', () => {
  it('插入空行：`@随机` 槽名按平移后的行号重算，产物行同步改名', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: SLOT_BACKEND });
    const built = compiler.update(SAMPLE_SHIFT_RANDOM);
    expect(slotNames(built.result)).toEqual(['__kojo_rand_4', '__kojo_rand_8']);
    expect(built.result.erb).toContain('#DIM __kojo_rand_4');

    // 在第 3 行（0 基 2）之前插一个空行：两个 `@随机` 各自 +1 行
    const { edit, text } = insertBlankLineAt(SAMPLE_SHIFT_RANDOM, 2);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.fallbackReason).toBe(null);
    expect(update.stats.reparsedUnits).toBeLessThanOrEqual(3);
    // 槽名不是"留着旧名再补一个"：旧行号必须整体消失
    expect(slotNames(update.result)).toEqual(['__kojo_rand_5', '__kojo_rand_9']);
    expect(update.result.erb).toContain('#DIM __kojo_rand_5');
    expect(update.result.erb).toContain('#DIM __kojo_rand_9');
    expect(update.result.erb).not.toContain('#DIM __kojo_rand_4');
    expect(update.result.erb).not.toContain('#DIM __kojo_rand_8');
    expectSameResult(update.result, fullCompileWith(text, SLOT_BACKEND));
  });

  it('删除空行：槽名按平移后的行号回填（与全量逐字节等价）', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: SLOT_BACKEND });
    const withBlank: string = `# 机 开场
# 视角 灵梦

> 第一段正文。
@随机
    > 风很轻。
    > 云在走。
> 收尾。
`;
    compiler.update(withBlank);
    // 删掉第 2 行那个空行：删的是**它前面**那个换行（删空行只有这一种证得出来的形态）
    const firstBreak = withBlank.indexOf('\n');
    const offset = withBlank.indexOf('\n', firstBreak + 1);
    const edit: IncrementalEdit = { offset, removedLength: 1, insertedText: '' };
    const text = applyEdit(withBlank, edit);
    expect(text.split('\n').length).toBe(withBlank.split('\n').length - 1);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(slotNames(update.result)).toEqual(['__kojo_rand_4']);
    expect(update.result.erb).toContain('#DIM __kojo_rand_4');
    expectSameResult(update.result, fullCompileWith(text, SLOT_BACKEND));
  });

  it('调用点在平移点之前、`# 模` 体里的 `@随机` 在之后：复用单元里的槽名引用被改写', () => {
    const source = `# 机 开场
# 视角 灵梦
! 招呼()
> 正文甲。
> 正文乙。
> 正文丙。
> 正文丁。
# 模 招呼()
    @随机
        > 甲的招呼。
        > 乙的招呼。
> 收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: SLOT_BACKEND });
    const built = compiler.update(source);
    expect(built.result.ok).toBe(true);
    expect(slotNames(built.result)).toEqual(['__kojo_rand_9']);
    // 在第 3 行（0 基 2）之前插空行：模整体 +1 行，但调用点单元自己没动
    const { edit, text } = insertBlankLineAt(source, 2);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull, update.stats.fallbackReason ?? '').toBe(false);
    expect(slotNames(update.result)).toEqual(['__kojo_rand_10']);
    expect(update.result.erb).toContain('#DIM __kojo_rand_10');
    expect(update.result.erb).not.toContain('__kojo_rand_9');
    expectSameResult(update.result, fullCompileWith(text, SLOT_BACKEND));
  });

  it('平移点之后的诊断 span 跟着平移（与全量一致，不是"旧行号留在诊断里"）', () => {
    const source = `# 机 开场
# 视角 灵梦
「裸引号在第三行」
> 正文一行。
> 正文二行。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(source);
    const bareQuote = built.result.diagnostics.find((diagnostic) => diagnostic.code === 'core/narrative/bare-quote');
    expect(bareQuote?.span?.start.line).toBe(3);

    const { edit, text } = insertBlankLineAt(source, 2);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    const shifted = update.result.diagnostics.find((diagnostic) => diagnostic.code === 'core/narrative/bare-quote');
    expect(shifted?.span?.start.line).toBe(4);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`@巡` 槽名（`__kojo_foreach_<行>_i/_e/_n`）同口径平移', () => {
    const rig = foreachRig();
    const source = `# 机 开场
# 视角 灵梦
@巡 队伍
    > 轮到{名}。
    ? {角} >= 2
        > 二号位以上。
> 收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: rig.adapter, backend: rig.backend });
    const built = compiler.update(source);
    expect(slotNames(built.result)).toEqual([
      '__kojo_foreach_3_i',
      '__kojo_foreach_3_e',
      '__kojo_foreach_3_n',
    ]);
    const { edit, text } = insertBlankLineAt(source, 2);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(slotNames(update.result)).toEqual([
      '__kojo_foreach_4_i',
      '__kojo_foreach_4_e',
      '__kojo_foreach_4_n',
    ]);
    expect(update.result.erb).toContain('#DIM __kojo_foreach_4_e');
    expect(update.result.erb).not.toContain('__kojo_foreach_3_e');
    expectSameResult(update.result, rig.fullCompile(text));
  });

  it('连续 Enter（同一处连按 4 次）：每一步都走增量且等价（槽名逐次 +1）', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_SHIFT_RANDOM);
    let text = SAMPLE_SHIFT_RANDOM;
    for (let step = 1; step <= 4; step++) {
      const { edit: nextEdit, text: nextText } = insertBlankLineAt(text, 2);
      const update = compiler.update(nextText, nextEdit);
      text = nextText;
      expect(update.stats.fallbackFull).toBe(false);
      expect(slotNames(update.result)).toEqual([
        `__kojo_rand_${4 + step}`,
        `__kojo_rand_${8 + step}`,
      ]);
      expectSameResult(update.result, fullCompile(text));
    }
  });
});

/* ============================== 结构化增量：声明单元 → 只重建受影响展开点 ============================== */

const FOREACH_TEAM: ForeachCollectionDecl = {
  name: '队伍',
  kind: 'characters',
  elementType: 'character',
  base: 1,
  keyType: null,
  length: { kind: 'engine', counter: 'CHARANUM', minus: 1 },
  bindings: ['角', '名'],
  nameAccessor: 'CALLNAME',
};

const ALL_PROGRAM_FEATURES: ProgramFeatures = {
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
};

function foreachRig(): { adapter: GameAdapter; backend: KojoEmitBackend; fullCompile: (source: string) => CompileKojoSourceResult } {
  const declarations: ForeachDeclarations = {
    collections: [FOREACH_TEAM],
    arrayRule: { base: 0, bindings: ['值', '下标'] },
  };
  const adapter: GameAdapter = {
    ...FIXTURE_ADAPTER,
    profile: { ...FIXTURE_ADAPTER.profile, features: ['program'] },
    programFeatures: ALL_PROGRAM_FEATURES,
    foreachCollections: declarations,
  };
  const base = { ...FIXTURE_BACKEND, profile: { ...FIXTURE_BACKEND.profile, programFeatures: ALL_PROGRAM_FEATURES } };
  const backend: KojoEmitBackend = {
    ...base,
    wrapMachine: (request): EmitResult => [
      `@EVENT_${request.machine.event}`,
      ...request.slots.map((slot) => `#${slot.valueType === 'int' ? 'DIM' : 'DIMS'} ${slot.name}`),
      ...request.body,
      '@EVENT_END',
    ],
    program: {
      ...base.program,
      forEachLoop(request: ForEachEmitRequest): EmitResult {
        const lines: string[] = [`LOOP|${request.plan.kind}|${request.plan.collection}`];
        for (const binding of request.plan.bindings) lines.push(`BIND|${binding.name}|${binding.slot}`);
        for (const line of request.body) lines.push(line);
        lines.push('LOOP.END');
        return lines;
      },
    },
  };
  return {
    adapter,
    backend,
    fullCompile: (source: string): CompileKojoSourceResult =>
      compileKojoSource({ source, adapter, backend }),
  };
}

describe('incremental：声明单元内编辑（只重建该单元 + 依赖它的展开点）', () => {
  it('`# 对照表` 行内编辑：只重建引用它的单元，结果与全量逐字等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(SAMPLE_TABLE);
    expect(built.result.ok).toBe(true);
    const offset = SAMPLE_TABLE.indexOf('点头') + 1;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '点' };
    const text = applyEdit(SAMPLE_TABLE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.fallbackReason).toBe(null);
    // 表被 2 个叙事单元引用（`{亲密度}`）：只有它们 + 声明单元自己重算
    expect(update.stats.reloweredUnits).toBeGreaterThanOrEqual(2);
    expect(update.stats.reparsedUnits).toBeLessThanOrEqual(3);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 池` 体编辑：调用点的展开产物跟着变，其余单元复用（列级分段一起搬）', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(SAMPLE_POOL_TEMPLATE);
    // 池展开的产物行带列级分段（调用处 + 定义处锚点）：拼接必须原样搬，不能只搬行级
    expect(built.result.sourceMap.segmentCount).toBeGreaterThan(0);
    const offset = SAMPLE_POOL_TEMPLATE.indexOf('普通的招呼。') + 2;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '新' };
    const text = applyEdit(SAMPLE_POOL_TEMPLATE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.result.ok).toBe(true);
    expect(update.result.erb).toContain('普通新的招呼。');
    expect(update.result.sourceMap.segmentCount).toBeGreaterThan(0);
    expectSameResult(update.result, fullCompile(text));
  });

  it('声明链条：`# 池` 体引用 `# 对照表`，改表时池的调用点也要重算（跨声明依赖闭包）', () => {
    const source = `# 机 开场
# 视角 灵梦
# 对照表 语气 依据 好感
    0..2 -> = "淡"
    否 -> = "近"
# 池 寒暄
    ? 好感 > 1
        > 你好（{语气}）。
    ? 否
        > 嗯（{语气}）。
! 寒暄
> 收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(source);
    expect(built.result.ok, JSON.stringify(built.result.diagnostics)).toBe(true);
    expect(built.result.erb).toContain('淡');
    const offset = source.indexOf('"淡"') + 1;
    const edit: IncrementalEdit = { offset, removedLength: 1, insertedText: '浓' };
    const text = applyEdit(source, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull, update.stats.fallbackReason ?? '').toBe(false);
    expect(update.result.erb).toContain('浓');
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 模` 体编辑：调用点（含插槽体）重建，插槽内容原样保留', () => {
    const source = `# 机 开场
# 视角 灵梦
# 模 包装(值)
    > {值}
    [插槽]
    > 尾巴。
! 包装(甲)
    > 插槽里的正文。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(source);
    const offset = source.indexOf('尾巴。');
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '长' };
    const text = applyEdit(source, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.result.erb).toContain('长尾巴。');
    expect(update.result.erb).toContain('插槽里的正文。');
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 设` 参与 `# 对照表` 端点：改常量时表引用点跟着重建', () => {
    const source = `# 机 开场
# 视角 灵梦
# 设 门槛 整数 = 3
# 对照表 语气 依据 好感
    0..{门槛} -> = "淡"
    否 -> = "近"
> 现在：{语气}
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(source);
    const offset = source.indexOf('整数 = 3') + '整数 = '.length;
    const edit: IncrementalEdit = { offset, removedLength: 1, insertedText: '4' };
    const text = applyEdit(source, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 池` 改名：旧调用点按未知符号重算（依赖闭包按名字取，旧名也在集合里）', () => {
    const source = `# 机 开场
# 视角 灵梦
# 池 招呼
    > 招呼一声。
! 招呼
> 收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(source);
    const offset = source.indexOf('招呼\n') !== -1 ? source.indexOf('# 池 招呼') + '# 池 '.length : 0;
    const edit: IncrementalEdit = { offset, removedLength: 2, insertedText: '问候' };
    const text = applyEdit(source, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 机` 事件名编辑：单元 IR 全部复用，只重装配事件头', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    // 开场 → 收场（两个都是 fixture adapter 声明过的事件）
    const offset = SAMPLE_BASIC.indexOf('开场');
    const edit: IncrementalEdit = { offset, removedLength: 2, insertedText: '收场' };
    const text = applyEdit(SAMPLE_BASIC, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.reloweredUnits).toBeLessThanOrEqual(2);
    expect(update.result.erb.startsWith('@EVENT_收场')).toBe(true);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 幕` 标题编辑：只换场景标题，叙事单元复用', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_SCENES);
    const offset = SAMPLE_SCENES.indexOf('第二幕') + '第二幕'.length;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '改' };
    const text = applyEdit(SAMPLE_SCENES, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.reloweredUnits).toBeLessThanOrEqual(2);
    expect(update.result.file.scenes.map((scene) => scene.title)).toEqual([null, '第一幕', '第二幕改']);
    expectSameResult(update.result, fullCompile(text));
  });

  it('改 `# 视角`（视点变化会改所有 `{我}`/池内裸引号）→ 回退全量', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_POOL_TEMPLATE);
    const offset = SAMPLE_POOL_TEMPLATE.indexOf('灵梦') + 1;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: 'x' };
    const text = applyEdit(SAMPLE_POOL_TEMPLATE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(true);
    expect(update.stats.fallbackReason).toBe('view-changed');
    expectSameResult(update.result, fullCompile(text));
  });

  it('`# 对照表` 里 Enter 加一行（换行 + 声明变更）：只重建该表 + 引用它的单元', () => {
    const source = `# 机 开场
# 视角 灵梦
# 对照表 亲密度 依据 好感
    0..2 -> = "疏远"
    5.. -> = "亲近"
    否 -> = "陌生"
> 现在：{亲密度}
> 收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(source);
    expect(built.result.ok, JSON.stringify(built.result.diagnostics)).toBe(true);
    expect(built.result.erb).toContain('亲近');
    // 在第 4 行（0 基 3，表体第一行之前）插入一行新档位
    const offset = source.indexOf('    0..2');
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '    3..4 -> = "点头"\n' };
    const text = applyEdit(source, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull, update.stats.fallbackReason ?? '').toBe(false);
    expect(update.result.erb).toContain('点头');
    expectSameResult(update.result, fullCompile(text));
  });

  it('`@织` 监听 + 纯换行：`@织` 产物按平移（含槽名引用）且与全量一致', () => {
    const source = `# 机 开场
# 视角 灵梦
@织 开场
    > 监听里的一行。
@随机
    > 候选甲。
    > 候选乙。
> 正文收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: SLOT_BACKEND });
    const built = compiler.update(source);
    expect(built.result.ok, JSON.stringify(built.result.diagnostics)).toBe(true);
    expect(built.result.erb).toContain('监听里的一行。');

    const { edit, text } = insertBlankLineAt(source, 2);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull, update.stats.fallbackReason ?? '').toBe(false);
    // `@随机` 块行 5 → 6：槽名跟着平移，且必须出现在产物里（含 `@织` 自己的行）
    expect(slotNames(update.result)).toEqual(['__kojo_rand_6']);
    expect(update.result.erb).toContain('#DIM __kojo_rand_6');
    expect(update.result.erb).not.toContain('__kojo_rand_5');
    expectSameResult(update.result, fullCompileWith(text, SLOT_BACKEND));
  });

  it('CRLF 文件（Windows 作者）：行尾插入换行走增量且与全量逐字节等价', () => {
    const source = ['# 机 开场', '# 视角 灵梦', '@随机', '    > 风很轻。', '    > 云在走。', '> 收尾。', ''].join(
      '\r\n',
    );
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: SLOT_BACKEND });
    const built = compiler.update(source);
    expect(built.result.ok, JSON.stringify(built.result.diagnostics)).toBe(true);
    expect(slotNames(built.result)).toEqual(['__kojo_rand_3']);

    // 在第 4 行（0 基 3，`@随机` 之后）的行内容末尾插一个 LF（混行尾不影响编译结果）
    const starts: number[] = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    const lineEnd = starts[4] ?? source.length;
    let contentEnd = lineEnd;
    if (source[contentEnd - 1] === '\n') contentEnd -= 1;
    if (source[contentEnd - 1] === '\r') contentEnd -= 1;
    const insert: IncrementalEdit = { offset: contentEnd, removedLength: 0, insertedText: '\n' };
    const insertedText = applyEdit(source, insert);
    const inserted = compiler.update(insertedText, insert);
    expect(inserted.stats.fallbackFull, inserted.stats.fallbackReason ?? '').toBe(false);
    expectSameResult(inserted.result, fullCompileWith(insertedText, SLOT_BACKEND));

    // 删掉新插入的空行（删整行：行 L 的行尾 + 行 L+1 的全部内容）
    const afterStarts: number[] = [0];
    for (let i = 0; i < insertedText.length; i++) if (insertedText[i] === '\n') afterStarts.push(i + 1);
    const emptyLineStart = afterStarts[4] ?? insertedText.length;
    let emptyLineContentEnd = afterStarts[5] ?? insertedText.length;
    if (emptyLineContentEnd > emptyLineStart && insertedText[emptyLineContentEnd - 1] === '\n') {
      emptyLineContentEnd -= 1;
    }
    if (emptyLineContentEnd > emptyLineStart && insertedText[emptyLineContentEnd - 1] === '\r') {
      emptyLineContentEnd -= 1;
    }
    const remove: IncrementalEdit = {
      offset: contentEnd, // 行 L 的行尾（= 新插入的那个 `\n`）
      removedLength: emptyLineContentEnd - contentEnd,
      insertedText: '',
    };
    const restored = applyEdit(insertedText, remove);
    const removed = compiler.update(restored, remove);
    expect(removed.stats.fallbackFull, removed.stats.fallbackReason ?? '').toBe(false);
    expectSameResult(removed.result, fullCompileWith(restored, SLOT_BACKEND));
    expect(restored).toBe(source);
  });

  it('`@原生` 体内插空行：整块重算，与全量一致', () => {
    const source = `# 机 开场
# 视角 灵梦
@原生
    #DIM X, 0
    PRINTFORM 原生行
> 正文收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(source);
    expect(built.result.erb).toContain('PRINTFORM 原生行');
    // 在 PRINTFORM 那行的**行尾**插一个带缩进的新行（Enter + 自动缩进）
    const offset = source.indexOf('PRINTFORM 原生行') + 'PRINTFORM 原生行'.length;
    const edit: IncrementalEdit = { offset, removedLength: 0, insertedText: '\n    ' };
    const text = applyEdit(source, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull, update.stats.fallbackReason ?? '').toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('声明编辑后接随机编辑：每一步都与全量等价（确定性种子）', () => {
    const mixed = `${SAMPLE_POOL_TEMPLATE}
# 对照表 亲密度 依据 好感
    0..2 -> = "疏远"
    3.. -> = "亲近"
    否 -> = "陌生"
@随机
    > 候选甲。
    > 候选乙。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(mixed);
    let text = mixed;
    const random = makeRandom(0x51ed7a + mixed.length);
    for (let step = 0; step < 40; step++) {
      const edit = randomEdit(text, random);
      text = applyEdit(text, edit);
      const update = compiler.update(text, edit);
      expectSameResult(update.result, fullCompile(text));
      if (compiler.degraded) break;
      expect(compiler.degraded, compiler.degradedReason ?? '').toBe(false);
    }
  });
});

/* ============================== 结构化增量：性能护栏（回退路径的增量版） ============================== */

function lineEndOffsets(source: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const physical of source.split('\n')) {
    offset += physical.length;
    offsets.push(offset);
    offset += 1;
  }
  return offsets;
}

function buildDeclPerfSource(count: number): { source: string; poolBodyOffset: number } {
  const lines: string[] = [
    '# 机 开场',
    '# 视角 灵梦',
    '# 设 上限 整数 = 5',
    '# 池 招呼',
    '    ? 恋慕 > 1',
    '        > 亲近的招呼。',
    '    ? 否',
    '        > 普通的招呼。',
    '# 对照表 亲密度 依据 好感',
    '    0..2 -> = "疏远"',
    '    3.. -> = "亲近"',
    '    否 -> = "陌生"',
    '',
  ];
  for (let i = 0; i < count; i++) {
    if (i % 7 === 0) lines.push('! 招呼');
    else if (i % 11 === 0) lines.push(`灵梦：「第${i}行的台词，关系{亲密度}。」`);
    else lines.push(`> 第${i}行的叙事文本，带一个插值{恋慕}。`);
  }
  const source = `${lines.join('\n')}\n`;
  return { source, poolBodyOffset: source.indexOf('亲近的招呼。') + 2 };
}

describe('incremental：结构编辑随机 golden（Enter / 删整行 / 声明行内改）', () => {
  it('每一步增量 === 全量（确定性种子；覆盖平移窗口、声明重建、真回退）', () => {
    const startsOf = (text: string): number[] => {
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
      return starts;
    };
    const contentEndOf = (text: string, start: number, end: number): number => {
      let contentEnd = end;
      if (contentEnd > start && text[contentEnd - 1] === '\n') contentEnd -= 1;
      if (contentEnd > start && text[contentEnd - 1] === '\r') contentEnd -= 1;
      return contentEnd;
    };
    const bases: string[] = [];
    for (const [, source] of SAMPLES) bases.push(source);
    bases.push(
      `# 机 开场
# 视角 灵梦
# 设 上限 整数 = 5
# 对照表 亲密度 依据 好感
    0..2 -> = "疏远"
    3.. -> = "亲近"
    否 -> = "陌生"
# 池 招呼
    ? 恋慕 > 1
        > 亲近的招呼（{亲密度}）。
    ? 否
        > 普通的招呼。
# 模 包装(值)
    > {值}
    [插槽]
    > 尾巴。
! 招呼
! 包装(甲)
    > 插槽里的正文。
@巡 队伍
    > 轮到{名}。
> 收尾。
`,
    );
    let steps = 0;
    let incremental = 0;
    let fallback = 0;
    for (const base of bases) {
      for (const rigKind of ['plain', 'foreach'] as const) {
        const rig = rigKind === 'plain' ? null : foreachRig();
        const adapter = rig === null ? FIXTURE_ADAPTER : rig.adapter;
        const backend = rig === null ? BACKEND : rig.backend;
        const compile = (src: string): CompileKojoSourceResult =>
          compileKojoSource({ source: src, adapter, backend });
        const compiler = createIncrementalCompiler({ adapter, backend });
        compiler.update(base);
        let text = base;
        const random = makeRandom(0x9e3779b1 + base.length + rigKind.length);
        for (let step = 0; step < 30; step++) {
          const starts = startsOf(text);
          const lineIndex = random(starts.length);
          const lineStart = starts[lineIndex] ?? 0;
          const lineEnd = starts[lineIndex + 1] ?? text.length;
          const contentEnd = contentEndOf(text, lineStart, lineEnd);
          const kind = random(5);
          let edit: IncrementalEdit;
          if (kind === 0) {
            // Enter：行内容末尾插一个换行
            edit = { offset: contentEnd, removedLength: 0, insertedText: '\n' };
          } else if (kind === 1) {
            // Enter + 自动缩进：新行只有缩进（仍算空行）
            edit = { offset: contentEnd, removedLength: 0, insertedText: '\n    ' };
          } else if (kind === 2 && lineIndex + 2 < starts.length) {
            // 删整行：行 L 的行尾 + 行 L+1 的全部内容
            const nextStart = starts[lineIndex + 1]!;
            const nextEnd = starts[lineIndex + 2] ?? text.length;
            const nextContentEnd = contentEndOf(text, nextStart, nextEnd);
            edit = { offset: contentEnd, removedLength: nextContentEnd - contentEnd, insertedText: '' };
          } else {
            // 单字符编辑（不含换行）：声明单元里走"声明重建"，叙事单元里走单行快路
            const offset = contentEnd > lineStart ? lineStart + random(contentEnd - lineStart) : lineStart;
            const removedLength = offset < text.length ? 1 : 0;
            edit = { offset, removedLength, insertedText: 'x' };
          }
          text = applyEdit(text, edit);
          const update = compiler.update(text, edit);
          steps += 1;
          if (update.stats.fallbackFull) fallback += 1;
          else incremental += 1;
          expectSameResult(update.result, compile(text));
          // 模型自检失败 = 全量 parse 与单元模型不等价（退化路径，之后永远全量）：停在这一格
          if (compiler.degraded) break;
          expect(compiler.degraded, compiler.degradedReason ?? '').toBe(false);
        }
      }
    }
    expect(steps).toBeGreaterThan(400);
    expect(incremental).toBeGreaterThan(300);
    expect(fallback).toBeGreaterThan(0);
  });
});

describe('incremental：回退路径的增量版性能护栏（5.2k 行）', () => {
  it('纯换行插入/删除中位数 < 60ms，声明单元内编辑中位数 < 100ms（CI ×2），且等价', () => {
    const ciScale = process.env.CI === 'true' ? 2 : 1;
    const newlineBudgetMs = 60 * ciScale;
    const declBudgetMs = 100 * ciScale;
    const { source, editOffsets } = buildPerfSource(PERF_LINES);
    const ends = lineEndOffsets(source);
    const middle = Math.floor(editOffsets.length / 2);

    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(source);
    expect(compiler.degraded, compiler.degradedReason ?? '').toBe(false);
    expect(built.result.ok).toBe(true);

    // 取中间 11 个正文行的**行尾**（Enter 的真实落点）
    const targets: number[] = [];
    for (let i = middle; i < editOffsets.length && targets.length < 11; i++) {
      // editOffsets[i] = 行首 + 2（"> " 之后）；行尾用行首偏移 + 行宽
      const lineStart = editOffsets[i]! - 2;
      const end = ends.find((value) => value > lineStart)!;
      targets.push(end);
    }
    expect(targets.length).toBe(11);

    let text = source;
    // 预热：插入 + 删除各 2 次（不计数）
    for (const offset of targets.slice(0, 2)) {
      const insert: IncrementalEdit = { offset, removedLength: 0, insertedText: '\n' };
      text = applyEdit(text, insert);
      compiler.update(text, insert);
      const remove: IncrementalEdit = { offset, removedLength: 1, insertedText: '' };
      text = applyEdit(text, remove);
      compiler.update(text, remove);
    }

    const insertTimes: number[] = [];
    const deleteTimes: number[] = [];
    for (const offset of targets) {
      const insert: IncrementalEdit = { offset, removedLength: 0, insertedText: '\n' };
      const withBlank = applyEdit(text, insert);
      const inserted = compiler.update(withBlank, insert);
      insertTimes.push(inserted.stats.ms);
      if (inserted.stats.fallbackFull) {
        throw new Error(`纯换行插入未走增量（${inserted.stats.fallbackReason ?? 'no-reason'}）`);
      }
      expect(inserted.stats.reparsedUnits).toBeLessThanOrEqual(3);
      const remove: IncrementalEdit = { offset, removedLength: 1, insertedText: '' };
      text = applyEdit(withBlank, remove);
      const removed = compiler.update(text, remove);
      deleteTimes.push(removed.stats.ms);
      if (removed.stats.fallbackFull) {
        throw new Error(`纯换行删除未走增量（${removed.stats.fallbackReason ?? 'no-reason'}）`);
      }
      text = withBlank;
      // 还原：把空行再删掉，回到原始文本（下一次测量从同一份文本出发）
      const revert: IncrementalEdit = { offset, removedLength: 1, insertedText: '' };
      text = applyEdit(text, revert);
      compiler.update(text, revert);
    }
    const insertMedianMs = median(insertTimes);
    const deleteMedianMs = median(deleteTimes);

    // 等价抽检：Structure 路径一次换行后 === 全量
    const spotEdit: IncrementalEdit = { offset: targets[0]!, removedLength: 0, insertedText: '\n' };
    const spotText = applyEdit(source, spotEdit);
    const spot = compiler.update(spotText, spotEdit);
    expectSameResult(spot.result, fullCompile(spotText));

    // ── 声明单元内编辑（池体里改 1 字符）：只重建被改的声明 + 调用它的展开点 ──
    const declFixture = buildDeclPerfSource(PERF_LINES);
    const declCompiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const declBuilt = declCompiler.update(declFixture.source);
    expect(declCompiler.degraded, declCompiler.degradedReason ?? '').toBe(false);
    expect(declBuilt.result.ok).toBe(true);
    const declUnitCount = declBuilt.stats.reparsedUnits;
    let declText = declFixture.source;
    const declTimes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const insert: IncrementalEdit = { offset: declFixture.poolBodyOffset, removedLength: 0, insertedText: 'x' };
      const withChar = applyEdit(declText, insert);
      const update = declCompiler.update(withChar, insert);
      declTimes.push(update.stats.ms);
      if (update.stats.fallbackFull) {
        throw new Error(`声明单元内编辑未走增量（${update.stats.fallbackReason ?? 'no-reason'}）`);
      }
      const revert: IncrementalEdit = { offset: declFixture.poolBodyOffset, removedLength: 1, insertedText: '' };
      declText = applyEdit(withChar, revert);
      declCompiler.update(declText, revert);
    }
    const declMedianMs = median(declTimes);
    const declSpot: IncrementalEdit = { offset: declFixture.poolBodyOffset, removedLength: 0, insertedText: 'y' };
    const declSpotText = applyEdit(declFixture.source, declSpot);
    const declChecked = declCompiler.update(declSpotText, declSpot);
    expectSameResult(declChecked.result, fullCompile(declSpotText));
    // 只重算被改声明所在的单元（1 个）+ 依赖它的展开点（~1/7 的正文），远少于整份单元数
    expect(declChecked.stats.reparsedUnits).toBeLessThanOrEqual(3);
    expect(declChecked.stats.reloweredUnits).toBeGreaterThan(100);
    expect(declChecked.stats.reloweredUnits).toBeLessThan(declUnitCount / 2);

    // 对照组：不带 edit 的 `update(text)` = 整份缓存重建（旧回退路径的真实口径）
    const rebuildTimes: number[] = [];
    for (let i = 0; i < 2; i++) {
      const rebuildStarted = performance.now();
      declCompiler.update(declFixture.source);
      rebuildTimes.push(performance.now() - rebuildStarted);
    }
    const rebuildMedianMs = median(rebuildTimes);

    // eslint-disable-next-line no-console
    console.log(
      `[incremental-fallback] ${source.split('\n').length} 行：纯换行插入 ${insertMedianMs.toFixed(1)}ms、` +
        `删除 ${deleteMedianMs.toFixed(1)}ms（${targets.length} 次）；声明单元内编辑 ${declMedianMs.toFixed(1)}ms` +
        `（重解析 ${declChecked.stats.reparsedUnits} 个单元 / 重 lower ${declChecked.stats.reloweredUnits} 个，` +
        `首次构建 ${declUnitCount} 个单元）；对照：整份缓存重建 ${rebuildMedianMs.toFixed(0)}ms`,
    );
    expect(insertMedianMs).toBeLessThan(newlineBudgetMs);
    expect(deleteMedianMs).toBeLessThan(newlineBudgetMs);
    expect(declMedianMs).toBeLessThan(declBudgetMs);
    // 相对护栏（绝对预算在超快 / 超慢机器上都没有区分度）：两条路径都必须显著低于整份重建
    expect(insertMedianMs).toBeLessThan(rebuildMedianMs * 0.2);
    expect(declMedianMs).toBeLessThan(rebuildMedianMs * 0.4);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * K2-INCR-HOLES ①：结构行插入不再永久 degraded
 * ════════════════════════════════════════════════════════════════════════════ */

const SAMPLE_BLOCK_BODY = `# 机 开场
# 视角 灵梦
> 开场白。
? 恋慕 > 5
    > 有点吵。
    ? 否
        > 嵌套里的安静。
? 否
    > 安静。
> 收尾。
`;

/** 在 anchor 之后插入（contentEnd 落点）；anchor 必须唯一（测试样本里都是唯一的） */
function insertAfter(source: string, anchor: string, inserted: string): IncrementalEdit {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  return { offset: at + anchor.length, removedLength: 0, insertedText: inserted };
}

/** 用 anchor 起点的替换 */
function editAnchor(source: string, anchor: string, removedLength: number, inserted: string): IncrementalEdit {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  return { offset: at, removedLength, insertedText: inserted };
}

/** 文本的 0 基行首偏移（Lone CR 也按一个物理行处理，与 incremental 的行号口径一致） */
function lineStartsOfText(text: string): number[] {
  if (text.length === 0) return [];
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (code === 10) {
      starts.push(i + 1);
    }
  }
  if (starts.length > 1 && starts[starts.length - 1] === text.length) starts.pop();
  return starts;
}

describe('incremental：结构行插入不再永久降级（K2-INCR-HOLES ①）', () => {
  it('块体内插入 `# 幕`：走增量、degraded 不置位、场景头出现在 AST 里', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    const edit = insertAfter(SAMPLE_BLOCK_BODY, '    > 有点吵。', '\n# 幕 临时');
    const text = applyEdit(SAMPLE_BLOCK_BODY, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.fallbackReason).toBe(null);
    expect(compiler.degraded).toBe(false);
    expect(compiler.degradedReason).toBe(null);
    expect(compiler.lastUnmodelledReason).toBe(null);
    expect(update.result.file.scenes.some((scene) => scene.title === '临时')).toBe(true);
    expectSameResult(update.result, fullCompile(text));
  });

  it('块体内插入 `? 否` + 缩进体：走增量、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    const edit = insertAfter(
      SAMPLE_BLOCK_BODY,
      '        > 嵌套里的安静。',
      '\n? 否\n        > 临时分支。',
    );
    const text = applyEdit(SAMPLE_BLOCK_BODY, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    // 粘贴进来的体比链分支基准深一级（8 > 4）：parser 会报 `core/lex/indent` 并跳过该行，
    // 增量必须复现同一条诊断（而不是悄悄把节点留下 / 丢掉）
    expect(update.result.diagnostics.some((diagnostic) => diagnostic.code === 'core/lex/indent')).toBe(true);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`?` 头与缩进体之间插入空行（旧实现 10 步内永久 degraded 的最小复现）：仍走增量', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    const edit = insertAfter(SAMPLE_BLOCK_BODY, '? 恋慕 > 5', '\n');
    const text = applyEdit(SAMPLE_BLOCK_BODY, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expect(compiler.lastUnmodelledReason).toBe(null);
    // 模型必须像 parser 一样把空行吸收进上一分支的体 ⇒ 仍是一条 IF/ELSE/ENDIF 链
    expect(update.result.erb.match(/IF \{/g)?.length).toBe(1);
    expect(update.result.erb).toContain('ELSE');
    expect(update.result.erb).toContain('ENDIF');
    expectSameResult(update.result, fullCompile(text));
  });

  it('`?` 头与缩进体之间插入纯空白行（4 空格）：同口径', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    const edit = insertAfter(SAMPLE_BLOCK_BODY, '? 恋慕 > 5', '\n    ');
    const text = applyEdit(SAMPLE_BLOCK_BODY, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expect(update.result.erb.match(/IF \{/g)?.length).toBe(1);
    expectSameResult(update.result, fullCompile(text));
  });

  it('行尾直接粘贴结构行（无前导换行，`? 否` 接到 `?` 头行尾）：不降级、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    const edit = insertAfter(SAMPLE_BLOCK_BODY, '? 恋慕 > 5', '? 否\n    > 临时分支。\n');
    const text = applyEdit(SAMPLE_BLOCK_BODY, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('10 步真实编辑序列（Enter / 结构行 / 粘贴 / 跨行删 / 行内改）：全程不降级且逐步等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    let text = SAMPLE_BLOCK_BODY;
    let degradedCount = 0;
    let fallbackCount = 0;
    const steps: Array<(current: string) => IncrementalEdit> = [
      (current) => insertAfter(current, '> 收尾。', '\n'),
      (current) => insertAfter(current, '    > 有点吵。', '\n# 幕 临时'),
      (current) => insertAfter(current, '        > 嵌套里的安静。', '\n? 否\n        > 临时分支。'),
      (current) => insertAfter(current, '    > 安静。', '\n> 粘贴甲。\n> 粘贴乙。\n> 粘贴丙。'),
      (current) => {
        const at = current.indexOf('开场白') + 1;
        return { offset: at, removedLength: 0, insertedText: '呀' };
      },
      (current) => {
        const start = current.indexOf('> 粘贴甲。');
        const end = current.indexOf('> 粘贴乙。');
        return { offset: start, removedLength: end - start, insertedText: '' };
      },
      (current) => insertAfter(current, '> 粘贴丙。', '\n? 否\n    > 追加分支。'),
      (current) => {
        const start = current.indexOf('    > 追加分支。');
        const end = current.indexOf('\n', start) + 1;
        return { offset: start, removedLength: end - start, insertedText: '' };
      },
      (current) => insertAfter(current, '> 收尾。', '\n# 幕 收场\n> 收场正文。'),
      (current) => {
        const at = current.indexOf('收场正文') + 2;
        return { offset: at, removedLength: 0, insertedText: '！' };
      },
    ];
    for (const step of steps) {
      const edit = step(text);
      text = applyEdit(text, edit);
      const update = compiler.update(text, edit);
      if (update.stats.fallbackFull) fallbackCount += 1;
      if (compiler.degraded) degradedCount += 1;
      expectSameResult(update.result, fullCompile(text));
    }
    expect(degradedCount).toBe(0);
    expect(fallbackCount).toBe(0);
    expect(compiler.degraded).toBe(false);
    expect(compiler.lastUnmodelledReason).toBe(null);
  });

  it('200 步真实编辑序列：每一步与全量等价、degraded 计数为 0', () => {
    const BASE = `# 机 开场
# 视角 灵梦
# 幕 第一场
> 神社的清晨，带一个插值{恋慕}。
灵梦：「早上好。」
? 恋慕 > 5
    > 有点吵。
? 否
    > 安静。
@随机
    > 风很轻。
    > 云在走。
> 收尾。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(BASE);
    const random = makeRandom(0x6b1_1a3);
    let text = BASE;
    let degradedCount = 0;
    let fallbackCount = 0;
    const pasteLines = (current: string): IncrementalEdit => {
      const starts = lineStartsOfText(current);
      const line = random(starts.length);
      const count = 2 + random(3);
      const body = Array.from({ length: count }, (_, i) =>
        i % 3 === 0 ? `> 粘贴第${i}行。` : i % 3 === 1 ? `灵梦：「粘贴${i}。」` : `    ? 否\n        > 分支${i}。`,
      ).join('\n');
      return { offset: starts[line]!, removedLength: 0, insertedText: `${body}\n` };
    };
    const deleteLines = (current: string): IncrementalEdit => {
      const starts = lineStartsOfText(current);
      if (starts.length < 4) return { offset: 0, removedLength: 0, insertedText: '' };
      const line = 1 + random(starts.length - 2);
      const count = 1 + random(3);
      const end = Math.min(starts.length - 1, line + count);
      return { offset: starts[line]!, removedLength: starts[end]! - starts[line]!, insertedText: '' };
    };
    const operations: Array<(current: string) => IncrementalEdit> = [
      // Enter（行首 / 行尾两种落点）
      (current) => {
        const starts = lineStartsOfText(current);
        const line = random(starts.length);
        const next = line + 1 < starts.length ? starts[line + 1]! : current.length;
        const lineStart = starts[line]!;
        const contentEnd =
          next > lineStart && current.charCodeAt(next - 1) === 10
            ? next - 1 - (next - 2 >= lineStart && current.charCodeAt(next - 2) === 13 ? 1 : 0)
            : next;
        return { offset: random(2) === 0 ? lineStart : contentEnd, removedLength: 0, insertedText: '\n' };
      },
      pasteLines,
      deleteLines,
      // 粘贴结构行（`# 幕` / `? 否`）
      (current) => {
        const starts = lineStartsOfText(current);
        const line = random(starts.length);
        const anchor = current.slice(starts[line]!, Math.min(current.length, starts[line]! + 12));
        const inserted = random(2) === 0 ? `\n# 幕 临时${random(9)}` : `\n? 否`;
        return { offset: starts[line]! + anchor.length, removedLength: 0, insertedText: inserted };
      },
      // 行内改（结构等价类不变：leaf → leaf）
      (current) => {
        const offset = 1 + random(Math.max(1, current.length - 1));
        return { offset, removedLength: 0, insertedText: ['灵', '。', '{', '}', '：', ' '][random(6)]! };
      },
      // 行内删
      (current) => {
        const offset = random(Math.max(1, current.length));
        return { offset, removedLength: 1, insertedText: '' };
      },
    ];
    for (let step = 0; step < 200; step++) {
      const edit = operations[random(operations.length)]!(text);
      const safe: IncrementalEdit = {
        offset: Math.max(0, Math.min(edit.offset, text.length)),
        removedLength: Math.max(0, Math.min(edit.removedLength, text.length - Math.max(0, Math.min(edit.offset, text.length)))),
        insertedText: edit.insertedText,
      };
      text = applyEdit(text, safe);
      const update = compiler.update(text, safe);
      if (update.stats.fallbackFull) fallbackCount += 1;
      if (compiler.degraded) degradedCount += 1;
      expectSameResult(update.result, fullCompile(text));
    }
    expect(degradedCount).toBe(0);
    expect(compiler.degraded).toBe(false);
    // 真实序列里允许偶尔"证不出"（如删掉视点），但不该是常态
    expect(fallbackCount).toBeLessThan(20);
  });

  it('把 `> x` 改成 legacy 行（快速路径会误判的边界形态）：结果不多一条链、不降级', () => {
    const BASE = `# 机 开场
# 视角 灵梦
? 恋慕 > 5
    > 有点吵。
> 中间行。
? 否
    > 安静。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(BASE);
    const edit = editAnchor(BASE, '> 中间行。', '> 中间行。'.length, '如果 恋慕 > 1');
    const text = applyEdit(BASE, edit);
    const update = compiler.update(text, edit);
    expect(compiler.degraded).toBe(false);
    // 全量里 legacy 行会被链循环 continue：两条 `?` 链实际是同一条 ⇒ 只允许一个 conditionChain
    const chains = update.result.file.scenes[0]!.items.filter((item) => item.kind === 'conditionChain');
    expect(chains.length).toBe(1);
    expectSameResult(update.result, fullCompile(text));
  });

  it('空行→注释（跨单元链合并）：快速路径不接管，拼接结果与全量逐字一致', () => {
    const BASE = `# 机 开场
# 视角 灵梦
? 恋慕 > 5
    > 有点吵。

? 否
    > 安静。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(BASE);
    const at = BASE.indexOf('\n\n') + 1;
    // 只有一行空行 → 插 3 个字符保留行数变化为 0 的"行内改"形状（class blank → comment）
    const edit: IncrementalEdit = { offset: at, removedLength: 0, insertedText: '// x' };
    const text = applyEdit(BASE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    // 注释不断链 ⇒ 全量是一条 IF/ELSE/ENDIF，增量必须同形（旧快速路径会拼成两条链）
    expect(update.result.erb.match(/IF \{/g)?.length).toBe(1);
    expect(update.result.erb).toContain('ELSE');
    expectSameResult(update.result, fullCompile(text));
  });

  it('结构行插入之后继续打字：降级不粘，第二步仍走增量', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BLOCK_BODY);
    const first = insertAfter(SAMPLE_BLOCK_BODY, '    > 有点吵。', '\n? 否\n        > 临时分支。');
    let text = applyEdit(SAMPLE_BLOCK_BODY, first);
    const firstUpdate = compiler.update(text, first);
    expect(firstUpdate.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);

    const second: IncrementalEdit = { offset: text.indexOf('开场白') + 1, removedLength: 0, insertedText: '呀' };
    text = applyEdit(text, second);
    const secondUpdate = compiler.update(text, second);
    expect(secondUpdate.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(secondUpdate.result, fullCompile(text));
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * degradedReason 细分：粘性（BOM / 选项）vs 非粘性（这一帧证不出）
 * ════════════════════════════════════════════════════════════════════════════ */

describe('incremental：degradedReason 细分与恢复', () => {
  it('`选项` → 粘性 degraded，degradedReason 细分为 options-block，lastUnmodelledReason 为 null', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(SAMPLE_OPTIONS);
    expect(compiler.degraded).toBe(true);
    expect(compiler.degradedReason).toBe('options-block');
    expect(compiler.lastUnmodelledReason).toBe(null);
    expectSameResult(built.result, fullCompile(SAMPLE_OPTIONS));
    // 粘性：后续编辑仍全量（`选项` 的全局计数诊断不在单元模型里）
    const edit: IncrementalEdit = { offset: SAMPLE_OPTIONS.indexOf('甲的正文') + 1, removedLength: 0, insertedText: '新' };
    const text = applyEdit(SAMPLE_OPTIONS, edit);
    const update = compiler.update(text, edit);
    expect(compiler.degraded).toBe(true);
    expect(compiler.degradedReason).toBe('options-block');
    expect(update.stats.fallbackFull).toBe(true);
    expectSameResult(update.result, fullCompile(text));
  });

  it('BOM → 粘性 degraded，degradedReason 细分为 bom-source，之后每轮仍是正确的全量', () => {
    const BOM_SOURCE = `\uFEFF# 机 开场\n# 视角 灵梦\n> 正文一行。\n`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(BOM_SOURCE);
    expect(compiler.degraded).toBe(true);
    expect(compiler.degradedReason).toBe('bom-source');
    expect(compiler.lastUnmodelledReason).toBe(null);
    expectSameResult(built.result, fullCompile(BOM_SOURCE));
    const edit: IncrementalEdit = {
      offset: BOM_SOURCE.indexOf('正文一行') + 1,
      removedLength: 0,
      insertedText: '新',
    };
    const text = applyEdit(BOM_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(compiler.degraded).toBe(true);
    expect(update.stats.fallbackFull).toBe(true);
    expectSameResult(update.result, fullCompile(text));
  });

  it('整份替换（证不出，但不降级）：lastUnmodelledReason = whole-file-replacement，下一轮恢复增量', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const replacement = `# 机 开场\n# 视角 灵梦\n> 完全换过的正文。\n`;
    const edit: IncrementalEdit = { offset: 0, removedLength: SAMPLE_BASIC.length, insertedText: replacement };
    const update = compiler.update(replacement, edit);
    expect(update.stats.fallbackFull).toBe(true);
    expect(update.stats.fallbackReason).toBe('whole-file-replacement');
    expect(compiler.degraded).toBe(false);
    expect(compiler.lastUnmodelledReason).toBe('whole-file-replacement');
    expectSameResult(update.result, fullCompile(replacement));
    // 下一轮普通编辑：恢复增量、非粘性读数清空
    const next: IncrementalEdit = { offset: replacement.indexOf('正文') + 1, removedLength: 0, insertedText: '新' };
    const text = applyEdit(replacement, next);
    const recovered = compiler.update(text, next);
    expect(recovered.stats.fallbackFull).toBe(false);
    expect(compiler.lastUnmodelledReason).toBe(null);
    expectSameResult(recovered.result, fullCompile(text));
  });

  it('改 `# 视角`（视点变化波及所有 `{我}`）：lastUnmodelledReason = view-changed、不降级、下一轮恢复', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const edit: IncrementalEdit = { offset: SAMPLE_BASIC.indexOf('灵梦'), removedLength: '灵梦'.length, insertedText: '魔理沙' };
    const text = applyEdit(SAMPLE_BASIC, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(true);
    expect(update.stats.fallbackReason).toBe('view-changed');
    expect(compiler.degraded).toBe(false);
    expect(compiler.lastUnmodelledReason).toBe('view-changed');
    expectSameResult(update.result, fullCompile(text));
    const next: IncrementalEdit = { offset: text.indexOf('早上好') + 1, removedLength: 0, insertedText: '呀' };
    const nextText = applyEdit(text, next);
    const recovered = compiler.update(nextText, next);
    expect(recovered.stats.fallbackFull).toBe(false);
    expect(compiler.lastUnmodelledReason).toBe(null);
    expectSameResult(recovered.result, fullCompile(nextText));
  });

  it('普通行内编辑：与两个降级读数都隔离（degraded / lastUnmodelledReason 恒为 null）', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const edit: IncrementalEdit = { offset: SAMPLE_BASIC.indexOf('神社') + 1, removedLength: 0, insertedText: '大' };
    const text = applyEdit(SAMPLE_BASIC, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expect(compiler.degradedReason).toBe(null);
    expect(compiler.lastUnmodelledReason).toBe(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * K2-INCR-HOLES ②：多行替换 / 跨行删 = 结构化增量
 * ════════════════════════════════════════════════════════════════════════════ */

describe('incremental：多行替换 / 跨行删走结构化增量（K2-INCR-HOLES ②）', () => {
  const POOL_SOURCE = `# 机 开场
# 视角 灵梦
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

  it('粘贴多行块（行数 +k）：增量、等价（不再整份重建）', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(POOL_SOURCE);
    const start = POOL_SOURCE.indexOf('! 招呼');
    const end = POOL_SOURCE.indexOf('! 开场白');
    const edit: IncrementalEdit = {
      offset: start,
      removedLength: end - start,
      insertedText: '! 招呼\n! 招呼\n> 粘贴甲。\n> 粘贴乙。\n',
    };
    const text = applyEdit(POOL_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.fallbackReason).toBe(null);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('同行数多行替换（delta = 0 但含换行）：增量、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(POOL_SOURCE);
    const anchor = '        > 普通的招呼。';
    const edit: IncrementalEdit = {
      offset: POOL_SOURCE.indexOf(anchor),
      removedLength: anchor.length,
      insertedText: '        > 新的招呼甲。\n        > 新的招呼乙。',
    };
    const text = applyEdit(POOL_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('跨行删整行区间：增量、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(POOL_SOURCE);
    const start = POOL_SOURCE.indexOf('! 招呼');
    const end = POOL_SOURCE.indexOf('! 开场白');
    const edit: IncrementalEdit = { offset: start, removedLength: end - start, insertedText: '' };
    const text = applyEdit(POOL_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('跨行替换（删 2 行插入 3 行、行数 -1）：增量、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(POOL_SOURCE);
    const start = POOL_SOURCE.indexOf('> 结束。');
    const edit: IncrementalEdit = {
      offset: start,
      removedLength: '> 结束。\n'.length,
      insertedText: '> 换掉的收尾。\n> 第二行收尾。\n> 第三行收尾。',
    };
    const text = applyEdit(POOL_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('行中间粘贴多行（offset 落在行中部）：增量、场景标题不变、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_SCENES);
    const edit: IncrementalEdit = {
      offset: SAMPLE_SCENES.indexOf('第一幕的一行') + 1,
      removedLength: 0,
      insertedText: '甲。\n> 插入的乙。\n灵梦：「丙。」',
    };
    const text = applyEdit(SAMPLE_SCENES, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expect(update.result.file.scenes.map((scene) => scene.title)).toEqual([null, '第一幕', '第二幕']);
    expectSameResult(update.result, fullCompile(text));
  });

  it('粘贴一整段 `# 模` + 调用点（新声明名进依赖闭包）：增量、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(POOL_SOURCE);
    const edit: IncrementalEdit = {
      offset: POOL_SOURCE.indexOf('> 结束。'),
      removedLength: 0,
      insertedText: '# 模 包装2(值)\n    > {值}。\n! 包装2(3)\n',
    };
    const text = applyEdit(POOL_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    // 模板展开把 `{值}` 换成实参：产物里出现 "TELL: 3。"（模板名本身不进 erb）
    expect(update.result.erb).toContain('TELL: 3。');
    expectSameResult(update.result, fullCompile(text));
  });

  it('CRLF 源上的跨行删：增量且逐字节等价', () => {
    const CRLF_SOURCE = SAMPLE_BASIC.replace(/\n/g, '\r\n');
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(CRLF_SOURCE);
    const start = CRLF_SOURCE.indexOf('> 神社的清晨');
    const end = CRLF_SOURCE.indexOf('灵梦：「早上好。」');
    const edit: IncrementalEdit = { offset: start, removedLength: end - start, insertedText: '' };
    const text = applyEdit(CRLF_SOURCE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('`@原生` 块内多行替换：整块重算、等价', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_NATIVE);
    const anchor = '    #DIM X, 0\n    PRINTFORM 原生行';
    const edit: IncrementalEdit = {
      offset: SAMPLE_NATIVE.indexOf(anchor),
      removedLength: anchor.length,
      insertedText: '    #DIM Y, 1\n    PRINTFORM 甲\n    PRINTFORM 乙',
    };
    const text = applyEdit(SAMPLE_NATIVE, edit);
    const update = compiler.update(text, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('等价性 golden：结构行插入 + 多行替换后，erb / 场景标题 / 诊断序逐字等于字面量', () => {
    const GOLDEN_BASE = `# 机 开场
# 视角 灵梦
# 幕 第一场
> 甲。
# 幕 第二场
> 乙。
`;
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(GOLDEN_BASE);
    const first = insertAfter(GOLDEN_BASE, '> 甲。', '\n? 否\n    > 丙。');
    let text = applyEdit(GOLDEN_BASE, first);
    const firstUpdate = compiler.update(text, first);
    expect(firstUpdate.stats.fallbackFull).toBe(false);
    expect(firstUpdate.result.erb).toBe(
      '@EVENT_开场\nTELL: 甲。 /WAIT\nTELL: 丙。 /WAIT\nTELL: 乙。 /WAIT\n@EVENT_END\n',
    );
    const second: IncrementalEdit = {
      offset: text.indexOf('> 乙。'),
      removedLength: '> 乙。\n'.length,
      insertedText: '灵梦：「丁。」\n> 戊。\n',
    };
    text = applyEdit(text, second);
    const update = compiler.update(text, second);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.result.erb).toBe(
      '@EVENT_开场\nTELL: 甲。 /WAIT\nTELL: 丙。 /WAIT\nSAY 灵梦: 丁。 /WAIT\nTELL: 戊。 /WAIT\n@EVENT_END\n',
    );
    expect(update.result.file.scenes.map((scene) => scene.title)).toEqual(['第一场', '第二场']);
    expect(update.result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([]);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(text));
  });

  it('空编辑（insertedText 为空、区间为 0）：不重算、不降级、结果一致', () => {
    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    compiler.update(SAMPLE_BASIC);
    const edit: IncrementalEdit = { offset: SAMPLE_BASIC.indexOf('神社'), removedLength: 0, insertedText: '' };
    const update = compiler.update(SAMPLE_BASIC, edit);
    expect(update.stats.fallbackFull).toBe(false);
    expect(update.stats.reparsedUnits).toBe(0);
    expect(compiler.degraded).toBe(false);
    expectSameResult(update.result, fullCompile(SAMPLE_BASIC));
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 多行替换性能护栏（5.7k 行）
 * ════════════════════════════════════════════════════════════════════════════ */

describe('incremental：多行替换 / 跨行删性能护栏（5.7k 行）', () => {
  it('粘贴多行 / 跨行删中位数 < 120ms（CI ×2）且 < 整份缓存重建的 50%，且逐字等价', () => {
    // 预算口径（写死，别改松）：5.7k 行 fixture、每种 11 次取中位数、测量前预热；
    // K2-INCR-HOLES ② 的目标是 < 120ms（旧回退路径实测 185–195ms），CI / 慢机 ×2。
    const ciScale = process.env.CI === 'true' ? 2 : 1;
    const budgetMs = 120 * ciScale;
    const { source } = buildPerfSource(PERF_LINES);
    const sourceLines = source.split('\n').length;
    expect(sourceLines).toBeGreaterThanOrEqual(5_500);

    const starts = lineStartsOfText(source);
    const lineOf = (needle: string): number => {
      const index = source.indexOf(needle);
      expect(index).toBeGreaterThan(0);
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1]! <= index) line += 1;
      return line;
    };
    // 302 / 701 都是普通叙事行（避开 5 / 7 / 13 的倍数）
    const pasteLine = lineOf('> 第302行的叙事文本');
    const deleteLine = lineOf('> 第701行的叙事文本');
    const pasteBody = '> 粘贴甲。\n> 粘贴乙。\n> 粘贴丙。\n> 粘贴丁。\n> 粘贴戊。\n';

    const compiler = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
    const built = compiler.update(source);
    expect(compiler.degraded, compiler.degradedReason ?? '').toBe(false);
    expect(built.result.ok).toBe(true);

    let text = source;
    const pasteForward = (current: string): IncrementalEdit => {
      const s = lineStartsOfText(current);
      return { offset: s[pasteLine]!, removedLength: s[pasteLine + 3]! - s[pasteLine]!, insertedText: pasteBody };
    };
    const pasteBack = (current: string): IncrementalEdit => {
      const s = lineStartsOfText(current);
      return {
        offset: s[pasteLine]!,
        removedLength: s[pasteLine + 5]! - s[pasteLine]!,
        insertedText: source.slice(starts[pasteLine]!, starts[pasteLine + 3]!),
      };
    };
    const deleteForward = (current: string): IncrementalEdit => {
      const s = lineStartsOfText(current);
      return { offset: s[deleteLine]!, removedLength: s[deleteLine + 3]! - s[deleteLine]!, insertedText: '' };
    };
    const deleteBack = (current: string): IncrementalEdit => {
      const s = lineStartsOfText(current);
      return { offset: s[deleteLine]!, removedLength: 0, insertedText: source.slice(starts[deleteLine]!, starts[deleteLine + 3]!) };
    };

    const drive = (forward: (text: string) => IncrementalEdit, back: (text: string) => IncrementalEdit): number[] => {
      const times: number[] = [];
      for (let i = 0; i < 11; i++) {
        const fwd = forward(text);
        const next = applyEdit(text, fwd);
        const update = compiler.update(next, fwd);
        times.push(update.stats.ms);
        if (update.stats.fallbackFull) {
          throw new Error(`多行编辑未走增量（${update.stats.fallbackReason ?? 'no-reason'}）`);
        }
        text = next;
        const rev = back(text);
        const restored = applyEdit(text, rev);
        const reverted = compiler.update(restored, rev);
        times.push(reverted.stats.ms);
        if (reverted.stats.fallbackFull) {
          throw new Error(`多行逆编辑未走增量（${reverted.stats.fallbackReason ?? 'no-reason'}）`);
        }
        text = restored;
      }
      return times;
    };

    // 预热（不计数）
    for (let i = 0; i < 2; i++) {
      const fwd = pasteForward(text);
      text = applyEdit(text, fwd);
      compiler.update(text, fwd);
      const back = pasteBack(text);
      text = applyEdit(text, back);
      compiler.update(text, back);
      const del = deleteForward(text);
      text = applyEdit(text, del);
      compiler.update(text, del);
      const undo = deleteBack(text);
      text = applyEdit(text, undo);
      compiler.update(text, undo);
    }

    const pasteMedianMs = median(drive(pasteForward, pasteBack));
    const deleteMedianMs = median(drive(deleteForward, deleteBack));

    // 等价抽检（各一次正向编辑；每次抽检后还原，保证下一条 edit 相对当前缓存文本）
    const pasteCheck = pasteForward(source);
    const pasteText = applyEdit(source, pasteCheck);
    const pasteChecked = compiler.update(pasteText, pasteCheck);
    if (pasteChecked.stats.fallbackFull) throw new Error(`等价抽检未走增量：${pasteChecked.stats.fallbackReason ?? ''}`);
    expectSameResult(pasteChecked.result, fullCompile(pasteText));
    const pasteUndo = pasteBack(pasteText);
    const pasteRestored = applyEdit(pasteText, pasteUndo);
    expect(pasteRestored).toBe(source);
    compiler.update(pasteRestored, pasteUndo);
    const deleteCheck = deleteForward(source);
    const deleteText = applyEdit(source, deleteCheck);
    const deleteChecked = compiler.update(deleteText, deleteCheck);
    if (deleteChecked.stats.fallbackFull) throw new Error(`等价抽检未走增量：${deleteChecked.stats.fallbackReason ?? ''}`);
    expectSameResult(deleteChecked.result, fullCompile(deleteText));
    const deleteUndo = deleteBack(deleteText);
    compiler.update(applyEdit(deleteText, deleteUndo), deleteUndo);

    // 对照组：整份缓存重建（= 旧回退路径付的代价；与增量同一份文本）
    const rebuildTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const control = createIncrementalCompiler({ adapter: FIXTURE_ADAPTER, backend: BACKEND });
      const started = performance.now();
      control.update(source);
      rebuildTimes.push(performance.now() - started);
    }
    const rebuildMedianMs = median(rebuildTimes);

    // eslint-disable-next-line no-console
    console.log(
      `[incremental-multiline] ${sourceLines} 行：粘贴多行中位 ${pasteMedianMs.toFixed(1)}ms、` +
        `跨行删中位 ${deleteMedianMs.toFixed(1)}ms（各 11 次往返）；` +
        `对照：整份缓存重建 ${rebuildMedianMs.toFixed(0)}ms`,
    );

    expect(pasteMedianMs).toBeLessThan(budgetMs);
    expect(deleteMedianMs).toBeLessThan(budgetMs);
    // 相对护栏：必须显著低于整份重建（旧回退路径与整份重建同量级）
    expect(pasteMedianMs).toBeLessThan(rebuildMedianMs * 0.5);
    expect(deleteMedianMs).toBeLessThan(rebuildMedianMs * 0.5);
  });
});
