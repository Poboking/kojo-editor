import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { ERB_SEMANTIC_FACET, ERB_SEMANTIC_LEGEND } from '../src/monaco/tree-sitter/erb-semantic';
import { ERB_STRUCTURE_RUNTIME } from '../src/monaco/tree-sitter/erb-runtime';
import { erbEnterRulePatterns } from '@kojo/erb-lang/enter';
import {
  disposeAllEngines,
  errorReplies,
  lastReply,
  resetFacetLedgers,
  runEngine,
} from './helpers/erb-ts-facets-kit';

/**
 * ERB-TS-FULL 面②的**第二档**：结构诊断 / 捕获注入 / 运行时常量（真 wasm）。
 *
 * 为什么从 `erb-ts-facets-engine.test.ts` 再拆一枚（2026-11-07）：web-tree-sitter 0.27 的
 * `Language` 没有 free API，`StructureEngine.dispose()` 只关 Parser、**不还文法**——
 * 同一 worker 里攒到 10 枚上下就 `Fatal process out of memory: Zone`（PITFALLS §249 / §138）。
 * 原文件 15 例、引擎装载 14 次，单跑连炸三次（`Tests 9~10 passed (15)` + `Errors 1 error`，
 * 缺口的用例既不算红也不算跳）。按 PITFALLS 自己的正解再拆：本枚只装 6 次，
 * 语义/缩进那一档留 8 次，两枚各自远低于阈值。**断言与用例名一字未改**。
 */

afterEach(disposeAllEngines);
afterAll(resetFacetLedgers);

describe('ERB 引擎 facets · 结构诊断与运行时常量', () => {
  it('结构诊断：嵌套错配 ⇒ ERROR 一条（不逐子节点重复报）', async () => {
    const { replies } = await runEngine('IF X\n  SELECTCASE Y\n  ENDIF\n');
    const syntax = lastReply(replies, 'syntax');
    if (!syntax) throw new Error('没有 syntax 回话');
    expect(syntax.faults).toHaveLength(1);
    expect(syntax.faults[0]!.kind).toBe('unexpected-token');
  });

  it('结构诊断：[SKIPSTART] 死区里的坏行不报（体内不解析）', async () => {
    const { replies } = await runEngine('[SKIPSTART]\nIF X\n"未闭合\n[SKIPEND]\n');
    const syntax = lastReply(replies, 'syntax');
    if (!syntax) throw new Error('没有 syntax 回话');
    expect(syntax.faults).toEqual([]);
  });

  it('捕获表由语言入口注入：表外捕获报一次，其余照常着色', async () => {
    const { replies } = await runEngine('IF X\nENDIF\n', {
      highlightsQuery: '(if_line) @mystery\n(comment_line) @comment\n',
    });
    const errors = errorReplies(replies).filter((e) => e.capability === 'semantic');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('@mystery');
    const semantic = lastReply(replies, 'semantic');
    expect(semantic?.tokens.every((t) => t.tier === 'role.comment')).toBe(true);
  });

  it('`@none` 是有意不着色的哨兵：不产生回落告警', async () => {
    const { replies } = await runEngine('IF X\nENDIF\n', { highlightsQuery: '(if_line) @none\n' });
    expect(errorReplies(replies)).toEqual([]);
    const semantic = lastReply(replies, 'semantic');
    expect(semantic?.tokens).toEqual([]);
  });

  it('四条腿各自缺省：没有 indents 查询时不出 indent 回话，也不报错', async () => {
    const { replies } = await runEngine('IF X\nENDIF\n', { indentsQuery: undefined });
    expect(replies.some((r) => r.type === 'indent')).toBe(false);
    expect(errorReplies(replies)).toEqual([]);
  });

  it('ERB_STRUCTURE_RUNTIME 声明 semantic + baseIndentPatterns 两面', () => {
    expect(ERB_STRUCTURE_RUNTIME.semantic).toBe(ERB_SEMANTIC_FACET);
    expect(typeof ERB_STRUCTURE_RUNTIME.baseIndentPatterns).toBe('function');
    expect(ERB_STRUCTURE_RUNTIME.semantic?.legend).toBe(ERB_SEMANTIC_LEGEND);
    expect(ERB_STRUCTURE_RUNTIME.grammarWasmUrl).toContain('tree-sitter-erb.wasm');
  });

  it('ERB_STRUCTURE_RUNTIME 的基底接 erb-enter 既有层级（含 SIF / 注释两格）', () => {
    const base = ERB_STRUCTURE_RUNTIME.baseIndentPatterns!();
    const reference = erbEnterRulePatterns();
    expect(base.indentOnEnter.map((r) => r.source)).toEqual(reference.indentOnEnter.map((r) => r.source));
    expect(base.increaseIndentPattern.source).toBe(reference.increaseIndentPattern.source);
    expect(base.decreaseIndentPattern.source).toBe(reference.decreaseIndentPattern.source);
    expect(base.indentNextLinePattern?.source).toBe(reference.indentNextLinePattern?.source);
    expect(base.unIndentedLinePattern?.source).toBe(reference.unIndentedLinePattern?.source);
  });
});
