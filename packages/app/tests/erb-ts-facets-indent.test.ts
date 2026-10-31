import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { erbEnterRulePatterns } from '@kojo/erb-lang/enter';
import {
  erbBaseIndentPatterns,
  erbMergedIndentConfig,
} from '../src/monaco/tree-sitter/erb-indent';
import { erbIndentPattern } from '../src/monaco/tree-sitter/erb-indent-patterns';
import type { KojoStructureIndentRules } from '../src/monaco/tree-sitter/types';
import {
  FIXTURE,
  disposeAllEngines,
  lastReply,
  resetFacetLedgers,
  runEngine,
} from './helpers/erb-ts-facets-kit';

/**
 * ERB-TS-FULL 面④：缩进 facet——基底接既有层级 + 合并只做加法。
 * 两枚合并用例喂真 wasm 引擎（afterEach 真 teardown），其余为纯逻辑。
 */

afterEach(disposeAllEngines);
afterAll(resetFacetLedgers);

/* ======================================================================== */
/* ④ 缩进 facet：基底接既有层级 + 合并只做加法                               */
/* ======================================================================== */

describe('ERB 缩进 · 基底接 erb-enter，合并只做加法', () => {
  const emptyRules: KojoStructureIndentRules = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };

  it('基底三格与 erbEnterRulePatterns 逐字相同（不另造）', () => {
    const base = erbBaseIndentPatterns();
    const reference = erbEnterRulePatterns();
    expect(base.indentOnEnter.map((r) => r.source)).toEqual(reference.indentOnEnter.map((r) => r.source));
    expect(base.increaseIndentPattern.source).toBe(reference.increaseIndentPattern.source);
    expect(base.decreaseIndentPattern.source).toBe(reference.decreaseIndentPattern.source);
  });

  it('基底带出 SIF 只抬一行 / 注释不参与继承两格', () => {
    const base = erbBaseIndentPatterns();
    expect(base.indentNextLinePattern).toBeInstanceOf(RegExp);
    expect(base.indentNextLinePattern!.test('SIF A > 1')).toBe(true);
    expect(base.unIndentedLinePattern).toBeInstanceOf(RegExp);
    expect(base.unIndentedLinePattern!.test('; 注释')).toBe(true);
  });

  it('每次调用新建基底（两门语言/两次装配不许串同一个可变对象）', () => {
    expect(erbBaseIndentPatterns()).not.toBe(erbBaseIndentPatterns());
  });

  it('结构规则缺席 / 三腿全空 ⇒ null（与没接这条线同一份行为）', () => {
    expect(erbMergedIndentConfig(null)).toBeNull();
    expect(erbMergedIndentConfig(emptyRules)).toBeNull();
  });

  it('合并：基底规则一条不少，结构规则加在后面，两格 optional 原样带出', async () => {
    const { replies } = await runEngine(FIXTURE);
    const rules = lastReply(replies, 'indent')!.rules;
    const merged = erbMergedIndentConfig(rules);
    if (!merged) throw new Error('结构规则没进合并（indents 查询或派生层漂了）');
    const base = erbBaseIndentPatterns();
    expect(merged.onEnterRules.slice(0, base.indentOnEnter.length).map((r) => r.beforeText.source)).toEqual(
      base.indentOnEnter.map((r) => r.source),
    );
    expect(merged.added).toBeGreaterThan(0);
    expect(merged.rejected).toBe(0);
    expect(merged.indentNextLinePattern?.source).toBe(base.indentNextLinePattern?.source);
    expect(merged.unIndentedLinePattern?.source).toBe(base.unIndentedLinePattern?.source);
    expect(merged.increaseIndentPattern.test('  IF A AND B')).toBe(true);
    expect(merged.increaseIndentPattern.test(base.increaseIndentPattern.source === '' ? '' : 'IF X')).toBe(true);
    console.log(`[erb-ts-facets] merged indent：onEnter=${merged.onEnterRules.length} added=${merged.added}`);
  });

  it('合并键稳定：同一批结构规则两次合并 ⇒ 同一个 key（不重复重发语言配置）', async () => {
    const { replies } = await runEngine(FIXTURE);
    const rules = lastReply(replies, 'indent')!.rules;
    expect(erbMergedIndentConfig(rules)!.key).toBe(erbMergedIndentConfig(rules)!.key);
  });

  it('erbIndentPattern：按节点 kind 取关键字（大小写 / 全角空白 / 词形边界）', () => {
    const ifPattern = erbIndentPattern('indent.begin', 'if_line', 'IF A AND B');
    expect(ifPattern).not.toBeNull();
    expect(new RegExp(ifPattern!).test('IF A AND B')).toBe(true);
    expect(new RegExp(ifPattern!).test('  if x')).toBe(true);
    expect(new RegExp(ifPattern!).test('　IF X')).toBe(true);
    expect(new RegExp(ifPattern!).test('IFX')).toBe(false);
    expect(erbIndentPattern('indent.end', 'endif_line', 'ENDIF')).toContain('[eE][nN][dD][iI][fF]');
    expect(erbIndentPattern('indent.enter', 'sif_line', 'SIF A')).toContain('[sS][iI][fF]');
  });

  it('erbIndentPattern：非缩进捕获 / 非控制行 ⇒ null（不产半成品规则）', () => {
    expect(erbIndentPattern('fold', 'if_block', 'IF X')).toBeNull();
    expect(erbIndentPattern('indent.begin', 'if_block', 'IF X')).toBeNull();
    expect(erbIndentPattern('indent.begin', 'comment_line', '; x')).toBeNull();
  });
});
