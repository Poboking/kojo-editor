/**
 * **已知结构的显示形 + 段行数 1:1**（2026-10-19 包，投影读面止血）。
 *
 * 背景：投影过去对任何 pass 表没命中的 native 行一律盖 `未识别语句 · <原文>`，
 * 真语料 77,329 行兜底里注释 / SKIP 区 / PRINT 台词族是**正常 ERB**——工具把
 * "我不认识"错标成了"这行有错"。本包把这三类**已知结构**从兜底分支里拿出来：
 *
 * - 注释 / 空行：`buildRecs` 的 passthrough（本来就是原文，不入 native）；
 * - `[SKIPSTART]…[SKIPEND]`：首行 `停用区（引擎不执行）`、区内其余行空串占位；
 * - `PRINT[A-Z]*` 表外变体：`台词 · <原文体>` / 空体 `空行[ 等待]`；
 * - `DATAFORM` / `DATA` 已进 native 的条目行：pass 词形（`条目`）/ `台词 · <体>`，
 *   **结构判据不动**（仍是 native，不进糖段）。
 *
 * 真未知语句仍然只有 `未识别语句 · <原文>` 这一种词形（红线契约一个字没改）。
 *
 * 另钉一条硬性质：**1:1 行数**。宿主按段区间行数对齐，任何一段
 * `sugarText.split('\n').length !== toLine-fromLine+1` 都会让对齐静默跳过——
 * 注释 / SKIP / PRINT 三类段各写一条死钉。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarProjectSegment } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import type { LiftDeps } from '../src/lift';
import { liftProject } from '../src/project';

const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影是只读显示面，不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
});

const project = (source: string): ReturnType<typeof liftProject> => liftProject(deps(), { source });

const segLines = (s: SugarProjectSegment): string[] => s.sugarText.split('\n');

/** 段必须与源区间**逐行对齐**（1:1）——宿主 ViewZone 的硬前提 */
const expectOneToOne = (s: SugarProjectSegment): void => {
  expect(segLines(s).length, `段 ${s.fromLine}-${s.toLine} 行数`).toBe(s.toLine - s.fromLine + 1);
};

describe('已知结构 · 注释 / 空行不再兜底', () => {
  it('注释与空行是 passthrough：并入相邻糖段时 1:1，且一个兜底前缀都不带', () => {
    const src = ['PRINTFORMW 甲', ';注释一', '', '\t;缩进注释', 'PRINTFORMW 乙'].join('\n');
    const r = project(src);
    expect(r.segments.map((s) => [s.fromLine, s.toLine])).toEqual([[1, 5]]);
    const seg = r.segments[0]!;
    expectOneToOne(seg);
    expect(segLines(seg)).toEqual(['甲', ';注释一', '', ';缩进注释', '乙']);
    expect(seg.sugarText).not.toContain('未识别语句');
    expect(r.stats.nativeLines).toBe(0);
  });
});

describe('已知结构 · SKIP 停用区（1:1 占位，不盖兜底）', () => {
  it('首行标签 + 区内空串；标记行/注释/空行/正文都各占一条投影行', () => {
    const src = [
      '[SKIPSTART]',
      ';停用区注释',
      '',
      'PRINTFORMW 停用正文',
      '[SKIPEND]',
      'PRINTFORMW 正常',
    ].join('\n');
    const r = project(src);
    expect(r.segments.map((s) => [s.fromLine, s.toLine, s.nativeOnly === true])).toEqual([
      [1, 5, true],
      [6, 6, false],
    ]);
    const skip = r.segments[0]!;
    expectOneToOne(skip);
    expect(segLines(skip)).toEqual([
      '停用区（引擎不执行）',
      ';停用区注释',
      '',
      '停用 · PRINTFORMW 停用正文',
      '停用区（结束）',
    ]);
    expect(skip.sugarText).not.toContain('未识别语句');
    expect(segLines(r.segments[1]!)).toEqual(['正常']);
    // 成因口径不动：区内 5 行仍记 `data-or-skip`，只是显示词形换了
    expect(r.stats.nativeByReason).toEqual([{ reason: 'data-or-skip', count: 5 }]);
  });

  it('停用区在块内时同样 1:1（缩进保留；正文按 `停用 · 原文` 显形）', () => {
    const src = ['IF A', '\t[SKIPSTART]', '\tPRINTFORMW 停用', '\t[SKIPEND]', 'ENDIF'].join('\n');
    const r = project(src);
    const skip = r.segments.find((s) => s.sugarText.includes('停用区'));
    expect(skip).toBeDefined();
    expect(skip!.fromLine).toBe(2);
    expect(skip!.toLine).toBe(4);
    expectOneToOne(skip!);
    expect(segLines(skip!)[0]!.trim()).toBe('停用区（引擎不执行）');
    expect(segLines(skip!).slice(1)).toEqual(['停用 · PRINTFORMW 停用', '停用区（结束）']);
  });
});

describe('已知结构 · @函数头 / #声明（中性陈述，不冒充糖）', () => {
  it('自定义函数头与预处理声明都不落兜底，名字与参数逐字保留', () => {
    const src = ['@isaac_DISPLAY_COM_IMAGE(COMNO, INDEX)', '#DIM TEMP, 10'].join('\n');
    const r = project(src);
    const seg = r.segments[0]!;
    expectOneToOne(seg);
    expect(segLines(seg)).toEqual([
      '函数 · @isaac_DISPLAY_COM_IMAGE(COMNO, INDEX)',
      '声明数组 TEMP, 大小 10', // pass 表已有中文形 ⇒ 优先于通用 `声明 ·`
    ]);
    expect(seg.sugarText).not.toContain('未识别语句');
  });
});

describe('已知结构 · PRINT 台词族显示形', () => {
  it('表外变体：有体 → `台词 · <原文体>`；空体 → `空行[ 等待]`；体逐字保留（全角标点）', () => {
    const src = [
      'PRINTLC 台词甲',
      'PRINTLC 全角，标点。',
      'PRINTPLAIN 乙',
      'PRINTD',
      'PRINTSINGLEVW',
      'PRINTFORMKW 丙',
    ].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect(seg.nativeOnly).toBe(true);
    expectOneToOne(seg);
    expect(segLines(seg)).toEqual([
      '台词 · 台词甲',
      '台词 · 全角，标点。',
      '台词 · 乙',
      '空行',
      '空行 等待',
      '台词 · 丙',
    ]);
    expect(seg.sugarText).not.toContain('未识别语句');
  });

  it('指令后紧跟 `;`：空行形 + 注释原文（注释不是要打印的字）', () => {
    const r = project('PRINTFORMW ;这是注释');
    expect(segLines(r.segments[0]!)).toEqual(['空行 等待 ;这是注释']);
    expect(r.segments[0]!.sugarText).not.toContain('未识别语句');
  });

  it('数据表体内的 PRINT 系行：结构判据不变（native），显示词形按台词族', () => {
    const src = ['PRINTDATAL', 'PRINTFORML 数据台词', 'ENDDATA'].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect(seg.nativeOnly).toBe(true);
    expectOneToOne(seg);
    expect(segLines(seg)).toEqual(['数据表 原形 PRINTDATAL：', '\t台词 · 数据台词', '数据表结束']);
    expect(seg.sugarText).not.toContain('未识别语句');
    const reasons = Object.fromEntries(r.stats.nativeByReason.map((x) => [x.reason, x.count]));
    expect(reasons['data-or-skip']).toBe(1);
    expect(reasons['unsupported-control-flow']).toBe(2);
  });
});

describe('已知结构 · 数据表条目在 native 回显里的词形', () => {
  it('被结构拒收的 DATAFORM 条目：`条目 …`（不是"未识别语句"），结构判据一个字没动', () => {
    const r = project(['PRINTDATA', '\tDATAFORM 一条', '\tPRINTL 混进来的', 'ENDDATA'].join('\n'));
    expect(r.segments.every((s) => !s.sugarText.includes('数据表 · 择一输出'))).toBe(true);
    const text = r.segments.map((s) => s.sugarText).join('\n');
    expect(text).toContain('条目 一条');
    expect(text).not.toContain('未识别语句');
    expect(r.stats.nativeLines).toBe(4);
  });
});

describe('真未知语句 · 兜底词形不变（红线）', () => {
  it('既不是注释/SKIP/PRINT，也不是 @ 头 / # 声明的行，仍然只有 `未识别语句 · <原文>`', () => {
    // 函数头已归入已知结构（`函数 · @…`），这里换一条真正无从归类的语句做靶。
    const src = 'SOME_UNKNOWN_ENGINE_THING 1';
    const r = project(src);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.nativeOnly).toBe(true);
    expect(r.segments[0]!.sugarText).toBe(`未识别语句 · ${src}`);
  });
});
