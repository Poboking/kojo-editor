/**
 * 投影段的**段内糖行 ↔ 源行号**对账（契约 `SugarProjectSegment.sourceLines`）。
 *
 * 预览第 N 行与源第 N 行在**第一个非 1:1 的糖**之后就永久分叉：收束行（`ENDIF` / 被吸收的
 * 信封）占源区间却不产糖行，函数头一行源产两行糖。区间算术（`fromLine + k`）在这两种形态上
 * 都给出错行号，而错位是**静默**的（跳到隔壁一行也是"跳了"）。本文件把产线口径钉成逐行点名：
 * 每条用例同时钉 ①糖文本 ②映射数组 ③`lineCount` 三者自洽。
 *
 * 与 `project-known-lines.test.ts` 的分工：那边管"1:1 不许破"，这边管"非 1:1 时每一行都得
 * 知道自己来自哪一行"。两侧合起来才是宿主预览定位（点糖行回源行 / 源行找糖行）的正确前提。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarProjectSegment } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import type { LiftDeps } from '../src/lift';
import { liftProject } from '../src/project';
import { stubFaceTable } from './support';

const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影是只读显示面，不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
});

const project = (source: string) => liftProject(deps(), { source });

/** 函数头反解要分野表（与 `project.test.ts` 批 I 同一份桩） */
const withFaces = (source: string) =>
  liftProject(
    {
      transpile: () => {
        throw new Error('x');
      },
      scanControlFlow,
      faceTable: () => stubFaceTable(),
    },
    { source },
  );

const segLines = (s: SugarProjectSegment): string[] => s.sugarText.split('\n');
const mapOf = (s: SugarProjectSegment): number[] => [...(s.sourceLines ?? [])];

/**
 * 段的自洽不变量（每一条产线产物都必须过）：
 * 有映射 · 映射长度 = 糖行数 = `lineCount` · 每个行号要么 0、要么落在本段源区间内 · 单调不减。
 * 单调不均是宿主 `sourceLineToSugar` 退化查找（源行被折进糖里时停在包住它的那段）的前提。
 */
const expectConsistent = (s: SugarProjectSegment): void => {
  const label = `段 ${s.fromLine}-${s.toLine}`;
  const map = s.sourceLines;
  expect(map, `${label} 缺行映射`).toBeDefined();
  expect(map!.length, `${label} 映射长度 = 糖行数`).toBe(segLines(s).length);
  expect(map!.length, `${label} 映射长度 = lineCount`).toBe(s.lineCount);
  for (let k = 0; k < map!.length; k++) {
    const v = map![k]!;
    expect(v === 0 || (v >= s.fromLine && v <= s.toLine), `${label} 第 ${k} 行回指 ${v}`).toBe(true);
    if (k > 0) expect(v >= map![k - 1]!, `${label} 映射倒退`).toBe(true);
  }
};

const all = (r: ReturnType<typeof project>): SugarProjectSegment[] => r.segments;

describe('投影行映射 · 自洽不变量', () => {
  it('每一条段的映射都与糖文本、`lineCount` 三方对齐', () => {
    const src = [
      '@M_KOJO_少女之梦_EVENT_K1_2',
      ';分节标记',
      '',
      'IF TALENT:TARGET:恋慕',
      'PRINTFORMW 甲',
      'ENDIF',
      '[SKIPSTART]',
      'PRINTFORMW 停用',
      '[SKIPEND]',
      'CALL SOME_HELPER',
      'PRINTFORMW 乙',
    ].join('\n');
    const r = withFaces(src);
    expect(all(r).length).toBeGreaterThan(0);
    for (const s of r.segments) expectConsistent(s);
  });
});

describe('投影行映射 · ① 一源行 → 多糖行', () => {
  it('函数头合成的 `口上:` 署名行与块头标签同源：两行都点名那一行 `@` 头', () => {
    const r = withFaces('@M_KOJO_少女之梦_EVENT_K1_2\nPRINTFORMW 甲');
    const seg = r.segments[0]!;
    expectConsistent(seg);
    expect(segLines(seg)).toEqual(['口上: 少女之梦', '时机 事件 2：', '\t甲']);
    // 糖三行、源两行：`fromLine + k` 在这里开始就把第 3 行算成"段外"，逐行点名才是对的
    expect([seg.fromLine, seg.toLine]).toEqual([1, 2]);
    expect(mapOf(seg)).toEqual([1, 1, 2]);
  });

  it('源文件已自行声明 `口上:` ⇒ 不合成署名行，映射退回一行对一行', () => {
    const r = withFaces(['口上: 少女之梦', '@M_KOJO_少女之梦_EVENT_K1_2', 'PRINTFORMW 甲'].join('\n'));
    const seg = r.segments.find((s) => s.sugarText.includes('时机 事件 2：'))!;
    expectConsistent(seg);
    expect(segLines(seg)).toEqual(['时机 事件 2：', '\t甲']);
    expect(mapOf(seg)).toEqual([2, 3]);
  });
});

describe('投影行映射 · ② 多源行 → 一糖行', () => {
  it('`ENDIF` 收束不产糖行：它后面的每一行糖都必须跳过它，而不是顺延', () => {
    const src = ['PRINTFORMW 甲', 'IF A', 'PRINTFORMW 乙', 'ENDIF', 'PRINTFORMW 丙'].join('\n');
    const r = project(src);
    expect(all(r).map((s) => [s.fromLine, s.toLine])).toEqual([[1, 5]]);
    const seg = r.segments[0]!;
    expectConsistent(seg);
    expect(segLines(seg)).toEqual(['甲', '如果 A：', '\t乙', '丙']);
    expect(mapOf(seg)).toEqual([1, 2, 3, 5]); // 源第 4 行（ENDIF）被吸收，映射里根本没有它
  });

  it('连续两段之间夹一条兜底行：切段后各段仍逐行点名，段与段之间不错位', () => {
    const src = ['PRINTFORMW 甲', 'IF A', 'PRINTFORMW 乙', 'ENDIF', 'CALL SOME_HELPER', 'PRINTFORMW 丙'].join('\n');
    const r = project(src);
    for (const s of r.segments) expectConsistent(s);
    expect(r.segments.map((s) => [s.fromLine, s.toLine, s.nativeOnly === true])).toEqual([
      [1, 4, false],
      [5, 5, true],
      [6, 6, false],
    ]);
    expect(mapOf(r.segments[0]!)).toEqual([1, 2, 3]);
    expect(mapOf(r.segments[1]!)).toEqual([5]);
    expect(mapOf(r.segments[2]!)).toEqual([6]);
  });
});

describe('投影行映射 · ③ SKIP 停用区（1:1 不破）', () => {
  it('区内标记行 / 注释 / 空行 / 正文各占一行且各自回指自己那一源行', () => {
    const src = ['[SKIPSTART]', ';停用区注释', '', 'PRINTFORMW 停用正文', '[SKIPEND]', 'PRINTFORMW 正常'].join('\n');
    const r = project(src);
    for (const s of r.segments) expectConsistent(s);
    const skip = r.segments[0]!;
    expect(skip.nativeOnly).toBe(true);
    expect([skip.fromLine, skip.toLine]).toEqual([1, 5]);
    expect(segLines(skip)).toEqual([
      '停用区（引擎不执行）',
      ';停用区注释',
      '',
      '停用 · PRINTFORMW 停用正文',
      '停用区（结束）',
    ]);
    expect(mapOf(skip)).toEqual([1, 2, 3, 4, 5]); // 空行那格也有源行可指——它就在源文件第 3 行
    expect(mapOf(r.segments[1]!)).toEqual([6]);
  });
});

describe('投影行映射 · ④ 注释 / 空行透传', () => {
  it('透传行不产新糖、也不吞映射：一行源就是一行糖', () => {
    const src = ['PRINTFORMW 甲', ';注释一', '', '\t;缩进注释', 'PRINTFORMW 乙'].join('\n');
    const r = project(src);
    const seg = r.segments[0]!;
    expectConsistent(seg);
    expect(segLines(seg)).toEqual(['甲', ';注释一', '', ';缩进注释', '乙']);
    expect(mapOf(seg)).toEqual([1, 2, 3, 4, 5]);
    expect(r.stats.nativeLines).toBe(0);
  });
});

describe('投影行映射 · ⑤ `nativeOnly` 兜底段', () => {
  it('真未知语句成段时同样带映射（宿主对兜底段一样要能跳回源行）', () => {
    const r = project('SOME_UNKNOWN_ENGINE_THING 1');
    expect(all(r)).toHaveLength(1);
    const seg = r.segments[0]!;
    expectConsistent(seg);
    expect(seg.nativeOnly).toBe(true);
    expect(mapOf(seg)).toEqual([1]);
  });

  it('连续兜底行各自点名；夹在中间的空行走透传、把段切开也不丢映射', () => {
    const src = ['CALL SOME_HELPER', 'CALL ANOTHER_HELPER', '', 'CALL THIRD_HELPER'].join('\n');
    const r = project(src);
    for (const s of r.segments) expectConsistent(s);
    expect(r.segments.map((s) => [s.fromLine, s.toLine, s.nativeOnly === true])).toEqual([
      [1, 2, true],
      [4, 4, true],
    ]);
    expect(mapOf(r.segments[0]!)).toEqual([1, 2]);
    expect(mapOf(r.segments[1]!)).toEqual([4]);
  });
});
