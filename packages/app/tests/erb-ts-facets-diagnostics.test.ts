import { afterEach, afterAll, describe, expect, it } from 'vitest';
import {
  erbCstDiagnostics,
  erbMissingName,
  erbSkipTagDiagnostics,
  erbStructureDiagnostics,
} from '../src/monaco/tree-sitter/erb-diagnostics';
import { disposeAllEngines, lastReply, resetFacetLedgers, runEngine } from './helpers/erb-ts-facets-kit';

/**
 * ERB-TS-FULL 面⑤：结构诊断映射——CST 事实 + 停用区标签。
 * 四枚用例喂真 wasm 引擎（afterEach 真 teardown），其余为纯映射判据。
 */

afterEach(disposeAllEngines);
afterAll(resetFacetLedgers);

/* ======================================================================== */
/* ⑤ 结构诊断映射：CST 事实 + 停用区标签                                     */
/* ======================================================================== */

describe('ERB 结构诊断 · 残缺标签 / 嵌套错误 / 死区不误报', () => {
  it('记号名 → 人话名（`endif_line` / `skip_end`；表外不编）', () => {
    expect(erbMissingName('endif_line')).toBe('ENDIF');
    expect(erbMissingName('endselect_line')).toBe('ENDSELECT');
    expect(erbMissingName('skip_end')).toBe('[SKIPEND]');
    expect(erbMissingName(undefined)).toBeNull();
    expect(erbMissingName('some_new_token')).toBeNull();
  });

  it('未配对块 ⇒ 一条 unclosed-block（文案带行号与收束词）', async () => {
    const { replies } = await runEngine('IF X\n  PRINTL hi\n');
    const syntax = lastReply(replies, 'syntax')!;
    const diagnostics = erbCstDiagnostics(syntax.faults);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ line: 1, kind: 'unclosed-block', code: 'erb.unclosed-block' });
    expect(diagnostics[0]!.message).toContain('「IF」');
    expect(diagnostics[0]!.message).toContain('「ENDIF」');
    expect(diagnostics[0]!.message).toContain('第 3 行'); // faultRow = 2（0 基）→ 3
  });

  it('读不通的内容 ⇒ unexpected-token 文案（不冒充缺收束词）', async () => {
    const { replies } = await runEngine('IF X\n  SELECTCASE Y\n  ENDIF\n');
    const syntax = lastReply(replies, 'syntax')!;
    const diagnostics = erbCstDiagnostics(syntax.faults);
    expect(diagnostics[0]!.kind).toBe('unexpected-token');
    expect(diagnostics[0]!.code).toBe('erb.unexpected-token');
    expect(diagnostics[0]!.message).toContain('读不通');
  });

  it('同一行多处 CST 残缺只留第一条（一处一行）', () => {
    const faults = [
      { row: 2, endRow: 2, column: 0, endColumn: 4, faultRow: 2, kind: 'unexpected-token' as const },
      { row: 2, endRow: 2, column: 8, endColumn: 10, faultRow: 2, kind: 'unterminated-interp' as const },
      { row: 1, endRow: 1, column: 0, endColumn: 3, faultRow: 1, kind: 'unexpected-token' as const },
    ];
    const diagnostics = erbCstDiagnostics(faults);
    expect(diagnostics.map((d) => d.line)).toEqual([2, 3]);
  });

  it('[SKIPSTART] 没有 [SKIPEND] ⇒ unpaired-skip（语法层 close 可选，这条由文本判据补）', () => {
    const diagnostics = erbSkipTagDiagnostics('[SKIPSTART]\nIF X\nPRINTL hi\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ line: 1, endLine: 3, kind: 'unpaired-skip', code: 'erb.unpaired-skip' });
    expect(diagnostics[0]!.message).toContain('[SKIPEND]');
  });

  it('落单的 [SKIPEND] ⇒ 一条 unpaired-skip；配对齐全 ⇒ 空', () => {
    const stray = erbSkipTagDiagnostics('PRINTL x\n[SKIPEND]\n');
    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatchObject({ line: 2, kind: 'unpaired-skip' });
    expect(erbSkipTagDiagnostics('[SKIPSTART]\nIF X\n[SKIPEND]\n')).toEqual([]);
  });

  it('停用区里再写 [SKIPSTART] 不算新开区（与 scanner 的当前区判据同口径）', () => {
    const diagnostics = erbSkipTagDiagnostics('[SKIPSTART]\n[SKIPSTART]\n[SKIPEND]\n');
    expect(diagnostics).toEqual([]);
  });

  it('CST + 停用区合表：同码同行去重、按行排序', () => {
    const faults = [{ row: 0, endRow: 0, column: 0, endColumn: 3, faultRow: 0, kind: 'unexpected-token' as const }];
    const diagnostics = erbStructureDiagnostics(faults, 'IF X\n[SKIPEND]\n');
    expect(diagnostics.map((d) => [d.line, d.kind])).toEqual([
      [1, 'unexpected-token'],
      [2, 'unpaired-skip'],
    ]);
  });

  it('死区不误报：引擎 facts 为空 + 停用区标签配对齐全 ⇒ 一份诊断都不出', async () => {
    const text = '[SKIPSTART]\nIF X\n"未闭合\n[SKIPEND]\n';
    const { replies } = await runEngine(text);
    const syntax = lastReply(replies, 'syntax')!;
    expect(syntax.faults).toEqual([]);
    expect(erbStructureDiagnostics(syntax.faults, text)).toEqual([]);
  });

  it('残缺标签 [IF_DEBUG（少右括号）不被语法层当成块错误', async () => {
    const { replies } = await runEngine('[IF_DEBUG\nPRINTL x\n');
    const syntax = lastReply(replies, 'syntax')!;
    expect(syntax.faults).toEqual([]);
  });
});
