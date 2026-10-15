/**
 * S6 批 · 列级源映射单测（产物 行+列 ↔ 源 行+列）。
 *
 * 三条判据各自自证，别混：
 * 1. **列 = UTF-16 码元、1 基**（与 Monaco 同口径）——用码点数会在这里挂：
 *    中文/全角 1 码元、emoji 2 码元、TAB 1 码元；
 * 2. **只记逐码元恒等区段**：降糖改写区没有区段 ⇒ 正查 null、反查退行级，绝不编列；
 * 3. **行级判据零改动**：两参 `sourceOf` 与 `span` 语义逐字不变（旧消费方零改动）。
 */

import { describe, expect, it } from 'vitest';
import type { SugarPosition, SugarTranspileResult } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { sourceLineViews, splitLogicalLines } from '../src/lexer';
import { buildColumnRuns, clipAndShift, generatedPositionOf, sourceColumnOfEntry } from '../src/column-map';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ faceTable: stubFaceTable(), dictionary: stubDict });
const t = (src: string) => svc().transpile(src);

/** 产物行数组（末尾换行不算一行） */
const rows = (r: SugarTranspileResult): string[] => r.erb.split('\n').slice(0, -1);

/** 找第一个含 `needle` 的产物行（1 基行号） */
function genLine(r: SugarTranspileResult, needle: string): number {
  const at = rows(r).findIndex((l) => l.includes(needle));
  if (at < 0) throw new Error(`产物里找不到 ${needle}：\n${r.erb}`);
  return at + 1;
}

/** 折行源文本（`\` 续行）：`\\` 是行尾折行标记，换行用 \n 显式拼——避免源码里写续行 */
const NL = '\n';
const B = '\\';

const SRC =
  '角色: 12\n时机 指令 310：\n    「呀。」\n    今天很开心。\n    CFLAG:123 = 1\n    ;注释文本\n' +
  '    如果 日子 = 3：\n        「分支。」\n    否则：\n        「别的。」\n    endif：\n';

const entry = (r: SugarTranspileResult, generatedLine: number) =>
  r.sourceMap.find((e) => e.generatedLine === generatedLine);

/** `generatedOf` 是契约的**可选能力**，本包实现必给 ⇒ 测试里非空断言一次就好 */
const genOf = (r: SugarTranspileResult, source: SugarPosition): SugarPosition | null => svc().generatedOf!(r, source);

/** 源位置 → 产物位置 → 源位置（往返逐字相等） */
function roundTrip(r: SugarTranspileResult, source: SugarPosition): void {
  const forward = genOf(r, source);
  expect(forward, `源位置 ${JSON.stringify(source)} 应当可正查`).not.toBeNull();
  expect(svc().sourceColumnOf(r, forward!.line, forward!.column)).toEqual(source);
}

/** 每条区段都自证恒等：产物切片 == 源切片（逐码元；折行按所属物理行切出那一段） */
function assertVerbatim(r: SugarTranspileResult, src: string, generatedLine: number): void {
  const gen = rows(r)[generatedLine - 1]!;
  for (const run of entry(r, generatedLine)!.runs ?? []) {
    const logical = [...sourceLineViews(src).values()].find(
      (v) => v.segments.some((s) => s.line === run.source.line),
    );
    expect(logical, `区段指认的源行 ${run.source.line} 必须属于某条逻辑行`).toBeDefined();
    const seg = logical!.segments.find((s) => s.line === run.source.line)!;
    const start = seg.offset + (run.source.column - seg.column);
    // 区段不得越过物理行边界（跨行就必须拆段）
    const next = logical!.segments[logical!.segments.indexOf(seg) + 1];
    expect(next === undefined || start + run.length <= next.offset).toBe(true);
    expect(logical!.text.slice(start, start + run.length)).toBe(
      gen.slice(run.generatedColumn - 1, run.generatedColumn - 1 + run.length),
    );
  }
}

/* ============================================================================ */
/* 折行段（逻辑行 → 物理行）：列级映射的地基                                       */
/* ============================================================================ */

describe('折行段 · 逻辑偏移 → 物理 (行, 列)', () => {
  it('折行合并后每段带自己的物理行与列（续接列跳过行首空白，含全角空格）', () => {
    const lines = splitLogicalLines('角色: 12' + NL + '「今天' + B + NL + '　很开心。」' + NL);
    const folded = lines[1]!;
    expect(folded.line).toBe(2);
    expect(folded.endLine).toBe(3);
    expect(folded.text).toBe('「今天很开心。」');
    expect(folded.segments).toEqual([
      { offset: 0, line: 2, column: 1 },
      // 首段去行尾 `\` 后长 3（「今天）；续接行的全角空格 `　` 被 trimStart 跳过 ⇒ 源列 2
      { offset: 3, line: 3, column: 2 },
    ]);
  });

  it('未折行的行 = 单段（恒等：列 = 偏移 + 1）', () => {
    const [first, second] = splitLogicalLines('角色: 12' + NL + '「一天。」' + NL);
    expect(first!.segments).toEqual([{ offset: 0, line: 1, column: 1 }]);
    expect(second!.segments).toEqual([{ offset: 0, line: 2, column: 1 }]);
  });
});

/* ============================================================================ */
/* 区段构造与查询（纯函数层）                                                     */
/* ============================================================================ */

describe('列区段 · 校验、裁剪与夹紧', () => {
  const view = sourceLineViews('头' + NL + '    源文本' + NL).get(2)!;

  it('产物与源逐码元不等 ⇒ 该段丢弃（宁缺勿编）', () => {
    expect(buildColumnRuns([{ generatedOffset: 4, length: 3, sourceOffset: 4 }], 'IF 不一样', 0, 2, view)).toEqual([]);
  });

  it('缩进 TAB 按 1 码元计入产物列（显示宽度不参与列口径）', () => {
    const runs = buildColumnRuns([{ generatedOffset: 0, length: 3, sourceOffset: 4 }], '源文本', 1, 2, view);
    expect(runs).toEqual([{ generatedColumn: 2, length: 3, source: { line: 2, column: 5 } }]);
  });

  it('越界 / 空规格 / 无源侧视图 ⇒ 一律不记', () => {
    expect(buildColumnRuns([{ generatedOffset: 9, length: 3, sourceOffset: 4 }], '源文本', 1, 2, view)).toEqual([]);
    expect(buildColumnRuns([], '源文本', 1, 2, view)).toEqual([]);
    expect(buildColumnRuns([{ generatedOffset: 0, length: 0, sourceOffset: 4 }], '源文本', 1, 2, view)).toEqual([]);
    expect(buildColumnRuns([{ generatedOffset: 0, length: 3, sourceOffset: 4 }], '源文本', 1, 2, undefined)).toEqual([]);
  });

  it('clipAndShift：窗口外的部分裁掉，窗口内平移到产物坐标', () => {
    const specs = [{ generatedOffset: 0, length: 6, sourceOffset: 4 }];
    expect(clipAndShift(specs, 2, 6, 11)).toEqual([{ generatedOffset: 11, length: 4, sourceOffset: 6 }]);
    expect(clipAndShift(specs, 6, 6, 11)).toEqual([]); // 空窗口
    expect(clipAndShift(specs, 0, 6, -1)).toEqual([]); // 负产物基准 = 坐标未知 ⇒ 不记
  });

  it('行内逐码元平移 + 三处夹紧（段前 / 空洞 / 行尾越界）', () => {
    const fake = {
      generatedLine: 1,
      sourceLine: 9,
      runs: [{ generatedColumn: 3, length: 4, source: { line: 9, column: 2 } }],
    };
    expect(sourceColumnOfEntry(fake, 1)).toEqual({ line: 9, column: 2 }); // 产物前缀 → 首段源起点
    expect(sourceColumnOfEntry(fake, 3)).toEqual({ line: 9, column: 2 });
    expect(sourceColumnOfEntry(fake, 4)).toEqual({ line: 9, column: 3 }); // 段内平移
    expect(sourceColumnOfEntry(fake, 6)).toEqual({ line: 9, column: 5 });
    expect(sourceColumnOfEntry(fake, 7)).toEqual({ line: 9, column: 6 }); // 段尾（半开）→ 夹到末段源尾
    expect(sourceColumnOfEntry(fake, 99)).toEqual({ line: 9, column: 6 });
  });

  it('空洞按「就近」取邻段边界；无区段退行级；纯生成行 null', () => {
    const gapped = {
      generatedLine: 1,
      sourceLine: 9,
      runs: [
        { generatedColumn: 2, length: 2, source: { line: 9, column: 2 } },
        { generatedColumn: 20, length: 2, source: { line: 9, column: 40 } },
      ],
    };
    expect(sourceColumnOfEntry(gapped, 5)).toEqual({ line: 9, column: 4 }); // 贴近前段尾
    expect(sourceColumnOfEntry(gapped, 18)).toEqual({ line: 9, column: 40 }); // 贴近后段头
    expect(sourceColumnOfEntry({ generatedLine: 1, sourceLine: 9 }, 5)).toEqual({ line: 9, column: 1 });
    expect(sourceColumnOfEntry({ generatedLine: 1, sourceLine: null }, 5)).toBeNull();
    expect(
      sourceColumnOfEntry(
        { generatedLine: 1, sourceLine: 9, span: { start: { line: 9, column: 4 }, end: { line: 9, column: 1 } } },
        5,
      ),
    ).toEqual({ line: 9, column: 4 }); // 旧 `span` 口径原样保留（未记列时）
  });

  it('正向索引：区内命中、区外 null（不猜）', () => {
    const r: SugarTranspileResult = {
      erb: '',
      sourceMap: [
        { generatedLine: 2, sourceLine: 9, runs: [{ generatedColumn: 3, length: 2, source: { line: 9, column: 5 } }] },
      ],
      diagnostics: [],
    };
    expect(generatedPositionOf(r, { line: 9, column: 5 })).toEqual({ line: 2, column: 3 });
    expect(generatedPositionOf(r, { line: 9, column: 6 })).toEqual({ line: 2, column: 4 });
    expect(generatedPositionOf(r, { line: 9, column: 7 })).toBeNull(); // 段尾之外
    expect(generatedPositionOf(r, { line: 4, column: 5 })).toBeNull(); // 别的源行
  });
});

/* ============================================================================ */
/* 端到端 · 台词（含折行 / 插值 / emoji / 自机 / 心形）                            */
/* ============================================================================ */

describe('列级源映射 · 台词行', () => {
  const plainSrc = '角色: 12' + NL + '时机 指令 310：' + NL + '    「呀。」' + NL;

  it('PRINTFORMW 行：区段精确、行首/行尾越界夹紧、逐段恒等自证', () => {
    const r = t(plainSrc);
    const line = genLine(r, 'PRINTFORMW 「呀。」');
    expect(entry(r, line)!.runs).toEqual([{ generatedColumn: 13, length: 4, source: { line: 3, column: 5 } }]);
    assertVerbatim(r, plainSrc, line);
    expect(svc().sourceColumnOf(r, line, 1)).toEqual({ line: 3, column: 5 }); // 产物前缀（TAB+PRINTFORMW）
    expect(svc().sourceColumnOf(r, line, 13)).toEqual({ line: 3, column: 5 }); // 体首字符
    expect(svc().sourceColumnOf(r, line, 16)).toEqual({ line: 3, column: 8 });
    expect(svc().sourceColumnOf(r, line, 999)).toEqual({ line: 3, column: 9 }); // 越过行尾
  });

  it('折行 `\\`：一条产物行的列落回**各自物理源行**，不是统统回首行起点', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    「呀' + B + NL + '    哈' + B + NL + '    嘻。」' + NL;
    const r = t(src);
    const line = genLine(r, 'PRINTFORMW 「呀哈嘻。」');
    expect(entry(r, line)!.sourceLine).toBe(3); // 行级仍归首行（既有口径，零改动）
    expect(entry(r, line)!.runs).toEqual([
      { generatedColumn: 13, length: 2, source: { line: 3, column: 5 } }, // 「呀
      { generatedColumn: 15, length: 1, source: { line: 4, column: 5 } }, // 哈（第二物理行）
      { generatedColumn: 16, length: 3, source: { line: 5, column: 5 } }, // 嘻。」（第三物理行）
    ]);
    assertVerbatim(r, src, line);
    expect(svc().sourceColumnOf(r, line, 14)).toEqual({ line: 3, column: 6 });
    expect(svc().sourceColumnOf(r, line, 15)).toEqual({ line: 4, column: 5 });
    expect(svc().sourceColumnOf(r, line, 17)).toEqual({ line: 5, column: 6 });
    expect(svc().sourceColumnOf(r, line, 999)).toEqual({ line: 5, column: 8 });
  });

  it('插值展开区没有区段：两侧原文各自成段，改写掉的源位置正查 null', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    「今天{她}很开心。」' + NL;
    const r = t(src);
    const line = genLine(r, 'PRINTFORMW 「今天%CALLNAME:TARGET%很开心。」');
    expect(entry(r, line)!.runs).toEqual([
      { generatedColumn: 13, length: 3, source: { line: 3, column: 5 } }, // 「今天
      { generatedColumn: 33, length: 5, source: { line: 3, column: 11 } }, // 很开心。」
    ]);
    assertVerbatim(r, src, line);
    expect(svc().sourceColumnOf(r, line, 20)).toEqual({ line: 3, column: 8 }); // 生成区内 → 就近夹到前段尾
    expect(genOf(r, { line: 3, column: 9 })).toBeNull(); // `{她}` 的 `她` 被改写 ⇒ 无区段
    roundTrip(r, { line: 3, column: 12 });
  });

  it('列按 UTF-16 码元：emoji 占 2 列、中文占 1 列（码点口径会在此挂）', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    「😀哈。」' + NL;
    const r = t(src);
    const line = genLine(r, 'PRINTFORMW 「😀哈。」');
    const body = entry(r, line)!.runs![0]!;
    expect(body.length).toBe(6); // 「(1) + 😀(2) + 哈(1) + 。(1) + 」(1) = 6 码元
    expect(body.source).toEqual({ line: 3, column: 5 });
    const gen = rows(r)[line - 1]!;
    const ha = gen.indexOf('哈') + 1;
    expect(ha - body.generatedColumn).toBe(3); // 「 + 😀 跨 3 码元
    expect(svc().sourceColumnOf(r, line, ha)).toEqual({ line: 3, column: 8 });
    expect(genOf(r, { line: 3, column: 8 })).toEqual({ line, column: ha });
    expect(genOf(r, { line: 3, column: 6 })).toEqual({ line, column: body.generatedColumn + 1 });
  });

  it('你：自机台词：剥掉前缀后列照样落回源列', () => {
    const src = '角色: 12' + NL + '自机色: 红' + NL + '时机 指令 310：' + NL + '    你：「呀。」' + NL;
    const r = t(src);
    const line = genLine(r, 'PRINTFORMW 「呀。」');
    expect(entry(r, line)!.runs).toEqual([{ generatedColumn: 13, length: 4, source: { line: 4, column: 7 } }]);
    assertVerbatim(r, src, line);
    expect(svc().sourceColumnOf(r, line, 13)).toEqual({ line: 4, column: 7 });
  });

  it('心形：剥引号进 `@""` 后列照样落回', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    心形：' + NL + '        「嗯。」' + NL;
    const r = t(src);
    const line = genLine(r, 'CALL HPH_PRINT(@"嗯。","w")');
    const body = entry(r, line)!.runs![0]!;
    expect(body).toEqual({ generatedColumn: 19, length: 2, source: { line: 4, column: 10 } });
    assertVerbatim(r, src, line);
    expect(svc().sourceColumnOf(r, line, body.generatedColumn)).toEqual({ line: 4, column: 10 });
  });
});

/* ============================================================================ */
/* 端到端 · 恒等透传与纯生成行                                                     */
/* ============================================================================ */

describe('列级源映射 · 恒等与生成行', () => {
  it('注释行产物与源同长 ⇒ 一条覆盖整行的恒等区段', () => {
    const r = t(SRC);
    const line = genLine(r, ';注释文本');
    const gen = rows(r)[line - 1]!;
    expect(entry(r, line)!.runs).toEqual([{ generatedColumn: 2, length: 5, source: { line: 6, column: 5 } }]);
    expect(gen.length).toBe(1 + ';注释文本'.length); // 1 TAB + 原文，逐码元等长
    assertVerbatim(r, SRC, line);
    expect(svc().sourceColumnOf(r, line, 2)).toEqual({ line: 6, column: 5 });
    expect(svc().sourceColumnOf(r, line, 6)).toEqual({ line: 6, column: 9 });
  });

  it('赋值行整段恒等（含 ` = `）⇒ 反查/正查双向精确', () => {
    const r = t(SRC);
    const line = genLine(r, 'CFLAG:123 = 1');
    const gen = rows(r)[line - 1]!;
    expect(entry(r, line)!.runs).toEqual([{ generatedColumn: 2, length: 13, source: { line: 5, column: 5 } }]);
    assertVerbatim(r, SRC, line);
    expect(svc().sourceColumnOf(r, line, gen.indexOf('C') + 1)).toEqual({ line: 5, column: 5 });
    expect(svc().sourceColumnOf(r, line, gen.length)).toEqual({ line: 5, column: 17 });
    roundTrip(r, { line: 5, column: 6 });
    roundTrip(r, { line: 5, column: 17 });
  });

  it('如果行的条件原样进 `IF` ⇒ 有列；`ENDIF` 是纯生成行 ⇒ null', () => {
    const r = t(SRC);
    const ifLine = genLine(r, 'IF 日子 = 3');
    expect(entry(r, ifLine)!.runs).toEqual([{ generatedColumn: 5, length: 6, source: { line: 7, column: 8 } }]);
    assertVerbatim(r, SRC, ifLine);
    const endLine = rows(r).findIndex((l) => l === 'ENDIF') + 1;
    expect(endLine).toBeGreaterThan(0);
    expect(entry(r, endLine)!.sourceLine).toBeNull();
    expect(entry(r, endLine)!.runs).toBeUndefined();
    expect(svc().sourceOf(r, endLine)).toBeNull();
    expect(svc().sourceColumnOf(r, endLine, 1)).toBeNull();
  });

  it('包装函数骨架（@头 / CALL / RETURN RESULT）= 纯生成行 ⇒ null', () => {
    const r = t(SRC);
    for (const line of [1, 2, 3]) {
      expect(entry(r, line)!.sourceLine).toBeNull();
      expect(svc().sourceOf(r, line)).toBeNull();
      expect(svc().sourceColumnOf(r, line, 1)).toBeNull();
      expect(svc().sourceColumnOf(r, line, 40)).toBeNull();
    }
  });

  it('原生直通行逐字透传 ⇒ 整行恒等区段', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    PRINTH 一行。' + NL;
    const r = t(src);
    const line = genLine(r, 'PRINTH 一行。');
    expect(entry(r, line)!.runs).toEqual([{ generatedColumn: 2, length: 10, source: { line: 3, column: 5 } }]);
    assertVerbatim(r, src, line);
  });

  it('降糖改写的行（`{她}` 之类）不落在任何区段 ⇒ 反查退行级、正查 null', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    {她}' + NL;
    const r = t(src);
    const rewritten = r.sourceMap.find((e) => e.sourceLine === 3 && (e.runs?.length ?? 0) === 0);
    expect(rewritten, '源行 3 的降糖产物行应无列区段').toBeDefined();
    expect(svc().sourceColumnOf(r, rewritten!.generatedLine, 7)).toEqual({ line: 3, column: 1 });
    expect(svc().sourceOf(r, rewritten!.generatedLine)).toEqual({ line: 3, column: 1 });
    expect(genOf(r, { line: 3, column: 6 })).toBeNull();
  });
});

/* ============================================================================ */
/* 契约兼容（additive）与往返                                                     */
/* ============================================================================ */

describe('契约兼容与往返自证', () => {
  it('两参 `sourceOf` 判据零改动：有源行 → (行, 列 1)，纯生成行 → null', () => {
    const r = t(SRC);
    for (const item of r.sourceMap) {
      const pos = svc().sourceOf(r, item.generatedLine);
      if (item.sourceLine === null) expect(pos).toBeNull();
      else expect(pos).toEqual({ line: item.sourceLine, column: 1 });
    }
  });

  it('条目键集合只可能是 {generatedLine, sourceLine} 或再加 runs（不改判既有字段）', () => {
    const r = t(SRC);
    for (const item of r.sourceMap) {
      expect(Object.keys(item).sort()).toEqual(
        item.runs === undefined ? ['generatedLine', 'sourceLine'] : ['generatedLine', 'runs', 'sourceLine'],
      );
    }
    expect(r.sourceMap.some((e) => e.runs !== undefined)).toBe(true);
  });

  it('sourceMap 行号连续且覆盖全部产物行（列区段不新增/丢失条目）', () => {
    const r = t(SRC);
    const total = rows(r).length;
    expect(r.sourceMap.map((e) => e.generatedLine)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('往返自证：源位置 → 产物位置 → 源位置，逐字相等', () => {
    const r = t(SRC);
    roundTrip(r, { line: 3, column: 6 }); // 「呀。」
    roundTrip(r, { line: 5, column: 7 }); // CFLAG:123
    roundTrip(r, { line: 6, column: 6 }); // ;注释文本
    roundTrip(r, { line: 7, column: 9 }); // 如果 日子 = 3
    roundTrip(r, { line: 8, column: 10 }); // 「分支。」（块体更深一层）
  });

  it('折行往返：三条物理源行各自可往返', () => {
    const src = '角色: 12' + NL + '时机 指令 310：' + NL + '    「呀' + B + NL + '    哈' + B + NL + '    嘻。」' + NL;
    const r = t(src);
    roundTrip(r, { line: 3, column: 5 });
    roundTrip(r, { line: 4, column: 5 });
    roundTrip(r, { line: 5, column: 6 });
  });

  it('列 0 / 列 1 / 超大列一律不抛错、不跨行（产物行有源归属时必给本行映射）', () => {
    const r = t(SRC);
    for (const item of r.sourceMap) {
      if (item.sourceLine === null) continue;
      for (const col of [0, 1, 40, 10_000]) {
        const pos = svc().sourceColumnOf(r, item.generatedLine, col);
        expect(pos).not.toBeNull();
        expect(pos!.line).toBe(item.sourceLine); // 区段不跨行 ⇒ 源行必等于该行归属
        expect(pos!.column).toBeGreaterThan(0);
      }
    }
  });

  it('未接源侧视图的调用（`parse` / 直接 `codegen`）⇒ 产物与 sourceMap 逐字同旧版', () => {
    const r = svc().parse(SRC);
    expect(r.topLevel.length).toBeGreaterThan(0);
    const direct = t('角色: 12' + NL + '时机 指令 310：' + NL + '    「呀。」' + NL);
    expect(rows(direct).length).toBe(direct.sourceMap.length);
  });
});
