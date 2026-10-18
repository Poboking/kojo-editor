/**
 * E2 宿主侧「保存前整理」纯函数单测（`app/src/ui/format-on-save.ts`）。
 *
 * 这里证的是**开关与降级**；"整理过之后还弹不弹"由
 * `packages/plugins/ui-sugar-editor/tests/format-on-save.test.ts` 用真 `planSave` 证
 * （两半合起来才是完整链路，插件包不许伸进宿主包，故分两处）。
 */

import { describe, expect, it, vi } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { applyFormatOnSave } from '../src/ui/format-on-save';

const DOC = ['角色: 12', '时机 指令 310：', `${FULLWIDTH_SPACE}${FULLWIDTH_SPACE}「呀。」`].join('\n');

describe('applyFormatOnSave · 开关', () => {
  it('关着 ⇒ 文本逐字不变、零 edits、changed=false（连规则函数都不进）', () => {
    const format = vi.fn();
    const out = applyFormatOnSave(DOC, 'kojo', false, format);
    expect(out).toEqual({ text: DOC, edits: [], changed: false });
    expect(out.text).toBe(DOC);
    expect(format).not.toHaveBeenCalled();
  });

  it('方言认不出来（null）⇒ 同样一字不动（不猜一套规则去改文件）', () => {
    const format = vi.fn();
    expect(applyFormatOnSave(DOC, null, true, format).changed).toBe(false);
    expect(format).not.toHaveBeenCalled();
  });

  it('开着 ⇒ 走的是注入的规则本体，方言原样递下去', () => {
    const seen: Array<[string, string]> = [];
    const out = applyFormatOnSave(DOC, 'kojo', true, (text, dialect) => {
      seen.push([text, dialect]);
      return { text: text.replace(FULLWIDTH_SPACE, ' '), edits: [{ line: 3, startColumn: 1, endColumn: 4, text: 'x' }] };
    });
    expect(seen).toEqual([[DOC, 'kojo']]);
    expect(out.changed).toBe(true);
    expect(out.edits).toHaveLength(1);
  });

  it('规则说"零改动" ⇒ changed=false，宿主不该去动 model（省一次撤销栈污染）', () => {
    const out = applyFormatOnSave(DOC, 'erb', true, (text) => ({ text, edits: [] }));
    expect(out).toEqual({ text: DOC, edits: [], changed: false });
  });

  it('规则抛错 ⇒ 按原文保存 + warn（整理失败不能挡住保存，也不能静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = applyFormatOnSave(DOC, 'kojo', true, () => {
      throw new Error('boom');
    });
    expect(out).toEqual({ text: DOC, edits: [], changed: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('本模块绝不替作者置 acknowledgeFullwidthSpace：出参里没有这个字段可置', () => {
    // 出参形状只有 (text, edits, changed)——告警的处置权留在保存链路的 choices 入参里
    expect(Object.keys(applyFormatOnSave(DOC, 'kojo', false)).sort()).toEqual(['changed', 'edits', 'text']);
  });
});

/* ═══════════════ P2-14：规则开关随保存链路走（落盘前现读，判据「保存链路现读」） ═══════════════ */

describe('applyFormatOnSave · 规则开关（P2-14）', () => {
  it('rules 原样递给规则本体（替身收到同一引用形状）', () => {
    const seen: unknown[] = [];
    const rules = { fullWidthSpace: false, indent: true };
    applyFormatOnSave(DOC, 'kojo', true, (text, dialect, r) => {
      seen.push({ text, dialect, r });
      return { text, edits: [] };
    }, rules);
    expect(seen[0]).toMatchObject({ dialect: 'kojo', r: { fullWidthSpace: false, indent: true } });
  });

  it('全角折算关掉 ⇒ 保存链路对 U+3000 一个字符都不折（开关不食言）', () => {
    const out = applyFormatOnSave(DOC, 'kojo', true, undefined, { fullWidthSpace: false, indent: true });
    expect(out.changed).toBe(false);
    expect(out.text).toBe(DOC); // 含 U+3000 的台词行与缩进原样
  });

  it('不传 rules（缺省全开）= 与开关出现之前逐字一致（U+3000 缩进照折）', () => {
    const out = applyFormatOnSave(DOC, 'kojo', true);
    expect(out.changed).toBe(true);
    expect(out.text.includes(FULLWIDTH_SPACE)).toBe(false);
  });
});
