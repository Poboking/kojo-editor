/**
 * P2-12 · 补全排名**模糊族三档**的判据钉（`rankKey` / `mergeSuggestions`）。
 *
 * 硬判据（BOARD P2-12，改前必红）：
 *
 * `前缀精确(0|) > 前缀命中(1|) > 子序列(2a|) > 拼音首字母(2b|) > 全拚(2c|) > 其它(2|)`
 *
 * - **既有三档键形逐字不变**：空前缀仍是 `2|<sortText>|<label>`（不排序），
 *   `label === prefix` 仍 `0|`，`startsWith` 仍 `1|`——既有测试零回归的前提；
 * - **三档锚串刻意不同**（坍缩论证见 `completion-core.ts` 的 `rankKey` 头注）：
 *   a 锚 label 原文、b 锚拼音**首字母串**、c 锚拼音**全拼串**。首字母串恒为全拼串的
 *   子序列，若两档同锚全拼串，「首字母」档先判先得、永不可能触发；
 * - **`hs` 匹配路径推演**（本批缺陷词，结论写进提交信息）：
 *   「好感度系统」= 全拼 `haoganduxitong` + 首字母 `hgdxt`。输入 `hs` **不是**首字母子序列
 *   （键里没有 `s`）、**不是**全拼子序列（`hao` 后接 `s` 不连续）、也不是原文子序列
 *   （中文 label 无 ASCII）⇒ 按所有三档都进不了「好感度系统」，落 `2|`——**不猜**：
 *   任何把 `hs` 硬凑到这五个字的方案都在编造不存在的读音。`hs` 能命中的是拼音键里
 *   真含 `h…s` 跨词边界的候选（如「好感度上升」首字母 `hgdss`）——本文件各钉一条。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { mergeSuggestions, rankKey, type CompletionMergeOptions, type CompletionSource } from '../src/monaco/completion-core';

/* ============================== 桩 ============================== */

function stubMonaco(): typeof Monaco {
  return { languages: { CompletionItemKind: { Keyword: 2, Variable: 1 } } } as unknown as typeof Monaco;
}

function modelOf(): Monaco.editor.ITextModel {
  return {
    getValue: () => '',
    getLineContent: () => '',
    getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
  } as unknown as Monaco.editor.ITextModel;
}

function item(label: string, sortText?: string): Monaco.languages.CompletionItem {
  return {
    label,
    kind: 2,
    insertText: label,
    ...(sortText !== undefined ? { sortText } : {}),
  } as Monaco.languages.CompletionItem;
}

function ctx(): Parameters<typeof mergeSuggestions>[1] {
  return {
    monaco: stubMonaco(),
    model: modelOf(),
    position: { lineNumber: 1, column: 1 } as Monaco.Position,
    range: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 } as Monaco.IRange,
    tables: {},
  };
}

function merge(sources: readonly CompletionSource[], prefix: string): Monaco.languages.CompletionItem[] {
  const opts: CompletionMergeOptions = { reported: new Set<string>(), tag: '[fuzzy-rank-test]' };
  return mergeSuggestions(sources, ctx(), prefix, opts);
}

function sourceOf(items: readonly Monaco.languages.CompletionItem[]): CompletionSource {
  return { id: 'test-src', provide: () => [...items] };
}

/* ============================== ① 既有三档键形逐字不变 ============================== */

describe('P2-12 · 既有三档键形零回归（改前必红的兼容判据）', () => {
  it('空前缀 ⇒ 整表平铺，键形逐字 = `2|<sortText>|<label>`（模糊档绝不触发）', () => {
    expect(rankKey(item('好感度系统', '9_a'), '')).toBe('2|9_a|好感度系统');
    expect(rankKey(item('CALL_A'), '')).toBe('2||CALL_A');
  });

  it('前缀精确仍 `0|`、前缀命中仍 `1|`（中英候选各钉一条）', () => {
    expect(rankKey(item('好感度系统', '9_a'), '好感度系统')).toMatch(/^0\|/);
    expect(rankKey(item('好感度系统', '9_a'), '好感')).toMatch(/^1\|/);
    expect(rankKey(item('CALL_A', '1_x'), 'CALL_A')).toMatch(/^0\|/);
    expect(rankKey(item('CALL_A', '1_x'), 'CALL')).toMatch(/^1\|/);
  });

  it('与模糊档无关的「其它」键形逐字不变：`hs` 对「好感度系统」任何档都不命中 ⇒ 仍 `2|`', () => {
    // 推演见文件头注：hs 在原文 / 首字母串 hgdxt / 全拼串 haoganduxitong 里都不连续存在
    expect(rankKey(item('好感度系统', '9_a'), 'hs')).toMatch(/^2\|/);
    expect(rankKey(item('好感度系统', '9_a'), 'xyz')).toMatch(/^2\|/);
  });
});

/* ============================== ② 模糊族三档 + 次序硬判据 ============================== */

describe('P2-12 · 模糊族三档（次序 = 子序列 > 拼音首字母 > 全拚 > 其它）', () => {
  it('2a 子序列档：锚 label 原文（ASCII 标签跨下划线 / 中文标签跨字界各钉一条）', () => {
    expect(rankKey(item('M_KOJO_A'), 'kjo')).toMatch(/^2a\|/); // `kjo` ⊂ `m_kojo_a`
    expect(rankKey(item('好感度系统'), '感度')).toMatch(/^2a\|/); // 中文前缀的跨字界子序列
  });

  it('2b 拼音首字母档：锚首字母串（「好感度系统」= hgdxt）', () => {
    expect(rankKey(item('好感度系统'), 'hgdxt')).toMatch(/^2b\|/); // 首字母串全等亦是子序列
    expect(rankKey(item('好感度系统'), 'hgdt')).toMatch(/^2b\|/); // 跨字界：h.g.d._t（跳过 x）
    expect(rankKey(item('好感度系统'), 'HGDT')).toMatch(/^2b\|/); // 大小写不敏感
  });

  it('2c 全拼档：锚全拼串（「好感度系统」= haoganduxitong，可跨字边界）', () => {
    expect(rankKey(item('好感度系统'), 'haogan')).toMatch(/^2c\|/); // hao+gan 跨「好/感」字界
    expect(rankKey(item('好感度系统'), 'haoganduxitong')).toMatch(/^2c\|/); // 全拼全等
  });

  it('档位不坍缩：同一前缀只落一档，先判先得（a 压 b 压 c）', () => {
    // `hgdt` 对「好感度系统」：原文不含 ⇒ a 不触发；首字母子序列 ⇒ 恰落 b（不是 c）
    expect(rankKey(item('好感度系统'), 'hgdt')).toMatch(/^2b\|/);
    // `好感` 对「好感度系统」是前缀命中（1|）而非子序列档：既有档先判
    expect(rankKey(item('好感度系统'), '好感')).toMatch(/^1\|/);
  });

  it('次序硬判据：`0| < 1| < 2a| < 2b| < 2c| < 2|`（字符串比较逐对验证）', () => {
    const keys = [
      rankKey(item('好感度系统', 'z'), '好感度系统'), // 0|
      rankKey(item('好感度系统', 'z'), '好感'), // 1|
      rankKey(item('好感度系统', 'z'), '感度'), // 2a|
      rankKey(item('好感度系统', 'z'), 'hgdt'), // 2b|
      rankKey(item('好感度系统', 'z'), 'haogan'), // 2c|
      rankKey(item('好感度系统', 'z'), 'xyz'), // 2|
    ];
    for (let i = 0; i < keys.length - 1; i++) {
      expect(keys[i]! < keys[i + 1]!, `${keys[i]} !< ${keys[i + 1]}`).toBe(true);
    }
    expect(keys[0]).toMatch(/^0\|/);
    expect(keys[1]).toMatch(/^1\|/);
    expect(keys[2]).toMatch(/^2a\|/);
    expect(keys[3]).toMatch(/^2b\|/);
    expect(keys[4]).toMatch(/^2c\|/);
    expect(keys[5]).toMatch(/^2\|/);
  });

  it('`hs` 只命中拼音键真含 `h…s` 的候选（如「好感度上升」首字母 hgdss），不命中「好感度系统」', () => {
    expect(rankKey(item('好感度上升'), 'hs')).toMatch(/^2b\|/); // h.g.d.s.s：跨词界子序列
    expect(rankKey(item('好感度系统'), 'hs')).toMatch(/^2\|/); // 键里没有 s：不猜
  });
});

/* ============================== ③ 经装配路径的排序与 sortText 写回 ============================== */

describe('P2-12 · 模糊档经 mergeSuggestions 的排序（真实装配口径）', () => {
  it('同前缀下模糊档压「其它」档：`hgdt` 让「好感度系统」排到无关候选前，sortText 写回 `2b|`', () => {
    const out = merge(
      [sourceOf([item('无关甲', '1_a'), item('好感度系统', '9_z'), item('无关乙')])],
      'hgdt',
    );
    expect(out.map((i) => i.label)).toEqual(['好感度系统', '无关甲', '无关乙']);
    expect(out[0]!.sortText).toMatch(/^2b\|/);
  });

  it('同档沿用 source 自带 sortText：两条都在 2b 档时按 `2b|<sortText>|<label>` 排', () => {
    const out = merge(
      [sourceOf([item('好感度系统', '9_z'), item('好感度上升', '1_a')])], // 两者首字母串都含 h.g.d
      'hgd',
    );
    expect(out.map((i) => i.label)).toEqual(['好感度上升', '好感度系统']); // 同档 ⇒ sortText 定序
  });

  it('档位压过 sortText：2c 档的全拼命中排在 2| 档的小 sortText 候选前', () => {
    const out = merge([sourceOf([item('AAA', '0_a'), item('好感度系统', '9_z')])], 'haogan');
    expect(out.map((i) => i.label)).toEqual(['好感度系统', 'AAA']);
    expect(out[0]!.sortText).toMatch(/^2c\|/);
    expect(out[1]!.sortText).toMatch(/^2\|/);
  });
});
