/**
 * `kojo2` 回车层级（U6）：判据闸。
 *
 * 两件事分开钉：
 * - **静态配置**（`onEnterRules` / `indentationRules`）：块头 `：` 与 `@原生` 栏头 → 下一行 +1；
 *   Enter 上永远只有 `Indent`（绝不 Outdent），且两格与 `increaseIndentPattern` 同源不分叉。
 * - **上下文判据**（`kojo2EnterIndent` 纯函数）：`@原生` 围栏内一律不动——这一条 Monaco 的
 *   `onEnterRules` 拿不到（它只看当前行），所以真正的判据必须在纯函数上，CUTOVER 的 enter
 *   handler 调它，而不是另写一份。
 *
 * B3d（OPT-5）：判据与常量直接取 `@kojo/kojo-lang/language-config`——宿主那枚只转一手的
 * `kojo2-enter.ts` 指针壳同批删除；数据 → 枚举形状的翻译走 `toMonacoOnEnterRules`（宿主唯一落点）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { KOJO_INDENT_WIDTH } from '@kojo/kojo-core';
import {
  KOJO2_BLOCK_HEADER_COLON_RE,
  KOJO2_INDENT_UNIT,
  KOJO2_INDENTATION_RULES,
  KOJO2_ON_ENTER_RULES,
  kojo2EnterIndent,
  kojo2IsNativeFenceHeader,
} from '@kojo/kojo-lang/language-config';
import { toMonacoOnEnterRules } from '../src/monaco/monaco-language-surface';

/** 回车判据不需要真 Monaco：只借 `IndentAction` 的数字档。 */
const monacoStub = {
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
} as unknown as typeof Monaco;

describe('块头 `：` 判据', () => {
  it.each(['选项：', ' 如果 条件：', '# 池 早安问候：', '灵梦：「晚点再说」：'])(
    '%s → 是块头',
    (line) => {
      expect(KOJO2_BLOCK_HEADER_COLON_RE.test(line)).toBe(true);
      expect(kojo2EnterIndent(line)).toBe(1);
    },
  );

  it.each(['> 旁白。', '@算', '灵梦：「早」', '# 表 心情 由 恋慕', '? 恋慕 >= 500', ''])(
    '%s → 不是块头（不自动加缩进）',
    (line) => {
      expect(KOJO2_BLOCK_HEADER_COLON_RE.test(line)).toBe(false);
      expect(kojo2EnterIndent(line)).toBe(0);
    },
  );

  it('行内全角冒号不算块头（只有行尾冒号才缩进）', () => {
    expect(kojo2EnterIndent('灵梦：「早」：')).toBe(1); // 行尾确实是冒号（普通文本也行）
    expect(kojo2EnterIndent('甲：乙')).toBe(0); // 冒号在行中
  });
});

describe('`@原生` 围栏：栏头 +1，体内不动', () => {
  it.each(['@原生', '    @原生', '@原生  '])('%s → 栏头', (line) => {
    expect(kojo2IsNativeFenceHeader(line)).toBe(true);
    expect(kojo2EnterIndent(line)).toBe(1);
  });

  it.each(['@原生x', '@算', '# 原生', 'CALL X', ''])('%s → 不是栏头', (line) => {
    expect(kojo2IsNativeFenceHeader(line)).toBe(false);
    expect(kojo2EnterIndent(line)).toBe(0);
  });

  it('围栏内一律不动（哪怕这一行以全角冒号结尾）', () => {
    expect(kojo2EnterIndent('选项：', { inNativeFence: true })).toBe(0);
    expect(kojo2EnterIndent('@原生', { inNativeFence: true })).toBe(0);
    expect(kojo2EnterIndent('CALL X：', { inNativeFence: true })).toBe(0);
    // 不在围栏里时同一条判据照常生效（对照，证明不是整体关掉缩进）
    expect(kojo2EnterIndent('选项：', { inNativeFence: false })).toBe(1);
  });
});

describe('Monaco 协议装配', () => {
  const rules = toMonacoOnEnterRules(monacoStub, KOJO2_ON_ENTER_RULES, 'kojo2') ?? [];

  it('两格都是 Indent：Enter 上不许 Outdent（收束靠作者回缩）', () => {
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) {
      expect(rule.action.indentAction).toBe(monacoStub.languages.IndentAction.Indent);
    }
  });

  it('拦头规则覆盖 `@原生` 与块头冒号各一枚，且顺序为"更专有的先判"', () => {
    expect(rules[0]!.beforeText.test('@原生')).toBe(true);
    expect(rules[1]!.beforeText.test('选项：')).toBe(true);
  });

  it('onEnterRules 与 indentationRules.increaseIndentPattern 同源（两格不许分叉）', () => {
    const indentation = KOJO2_INDENTATION_RULES;
    expect(indentation.increaseIndentPattern).toBeInstanceOf(RegExp);
    for (const rule of rules) {
      expect(
        indentation.increaseIndentPattern.test(rule.beforeText.source) ||
          indentation.increaseIndentPattern.source.includes(rule.beforeText.source),
        `beforeText.source 未含于 increaseIndentPattern：${rule.beforeText.source}`,
      ).toBe(true);
    }
    // 反证：increaseIndentPattern 真能命中这两类行（不是空集自欺）
    expect(indentation.increaseIndentPattern.test('选项：')).toBe(true);
    expect(indentation.increaseIndentPattern.test('@原生')).toBe(true);
  });

  it('decreaseIndentPattern 永不命中（2.0 没有全局收束词，绝不自动 Outdent）', () => {
    const indentation = KOJO2_INDENTATION_RULES;
    for (const line of ['选项：', '@原生', '# 池 早安问候', '? 否', '循环结束', '']) {
      expect(indentation.decreaseIndentPattern?.test(line) ?? false).toBe(false);
    }
  });

  it('一级缩进 = core 的 4 空格（不写魔数）', () => {
    expect(KOJO2_INDENT_UNIT).toBe(' '.repeat(KOJO_INDENT_WIDTH));
    expect(KOJO2_INDENT_UNIT).toHaveLength(4);
  });
});
