/**
 * 装饰热路径批（PERF-4）· 条件表达式波浪线的**可搬运任务**接线。
 *
 * 钉三件事：
 * 1. 任务表里的 kind 与装饰器用的是同一个纯函数（两条走法不许给出两种波浪线）；
 * 2. 适用性判据留在本插件（只认正文 `.erb`/`.erm`，`.erh`/`.kojo`/其它一律空）；
 * 3. 造表器吃进去的扫描器就是唯一那条依赖缝——装配层用 erb-parser 的纯函数填它，
 *    本插件不 cross-import erb-parser（审计 C 项由这张表的存在本身证明是被绕开的）。
 */
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, LineDecoration } from '@kojo/plugin-api';
import { EXPR_SYNTAX_DECORATIONS_TASK, conditionExtractorTasks, exprSyntaxDecorations } from '../src/offload';
import { collectExprSyntaxDecorations } from '../src/decorator';

/** 假骨架：一条残句 IF + 一条正常的 WHILE */
const SCAN = (): readonly ControlFlowStatement[] => [
  { kind: 'IF', expression: 'CFLAG:100 &&', depth: 0, line: 3 },
  { kind: 'WHILE', expression: '1 = 1', depth: 0, line: 9 },
];

const viaTask = (path: string, text: string): LineDecoration[] =>
  (
    conditionExtractorTasks(SCAN)[EXPR_SYNTAX_DECORATIONS_TASK] as unknown as (p: {
      path: string;
      text: string;
    }) => LineDecoration[]
  )({ path, text });

describe('condition-extractor · 可搬运任务 erb.exprSyntaxDecorations', () => {
  it('kind 常量与表键一致（写错会静默退化成"宿主异步就地"，所以钉住）', () => {
    expect(Object.keys(conditionExtractorTasks(SCAN))).toEqual([EXPR_SYNTAX_DECORATIONS_TASK]);
    expect(EXPR_SYNTAX_DECORATIONS_TASK).toBe('erb.exprSyntaxDecorations');
  });

  it('任务实现 === 既有管线（collectExprSyntaxDecorations + 同一扫描器）', () => {
    const text = 'PRINTL 甲\nIF CFLAG:100 &&\nPRINTL 乙\n';
    expect(viaTask('C:/game/ERB/a.erb', text)).toEqual(
      collectExprSyntaxDecorations(text, SCAN).map((d) => ({
        line: d.line,
        severity: 'warning',
        message: d.message,
        code: d.code,
      })),
    );
  });

  it('只认正文：`.erb`/`.erm` 出装饰，`.erh`/`.kojo`/其它扩展名一律空', () => {
    const text = 'IF CFLAG:100 &&\n';
    // 只喂一条残句，好把"出不出装饰"这件事完全交给扩展名判据
    const oneBad = (): readonly ControlFlowStatement[] => [{ kind: 'IF', expression: 'CFLAG:100 &&', depth: 0, line: 1 }];
    const via = (path: string): LineDecoration[] =>
      exprSyntaxDecorations({ path, text }, oneBad);
    expect(via('C:/game/ERB/a.ERB')).toHaveLength(1);
    expect(via('C:/game/ERB/a.erm')).toHaveLength(1);
    expect(via('C:/game/ERB/a.erh')).toEqual([]);
    expect(via('C:/kojo/a.kojo')).toEqual([]);
    expect(via('C:/notes/a.md')).toEqual([]);
  });

  it('空正文不扫描（与改动前逐字一致）', () => {
    expect(viaTask('C:/game/ERB/a.erb', '')).toEqual([]);
    expect(exprSyntaxDecorations({ path: 'C:/game/ERB/a.erb', text: '' }, SCAN)).toEqual([]);
  });

  it('扫描器抛错按"无发现"处理（保守口径住在 decorator，本层不另立）', () => {
    const boom = (): readonly ControlFlowStatement[] => {
      throw new Error('扫描炸了');
    };
    expect(exprSyntaxDecorations({ path: 'C:/game/ERB/a.erb', text: 'IF A &&\n' }, boom)).toEqual([]);
  });
});
