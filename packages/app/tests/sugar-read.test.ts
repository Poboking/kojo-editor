/**
 * 糖视图阅读模式（.kojo 预览「稿纸化」）的显示层单测（2026-10 Wave2 S-1）。
 *
 * 钉死四件事：
 * 1. **「显示语法标记」默认关 = 阅读态**（偏好记住，与糖视图开关同款纪律）；
 * 2. **角色 → 弱化档位表**（`续` 最低档、语法骨架降档可辨、结构性标点退边界、台词中性前景）——
 *    弱化**只按角色**（LAU-2 起 Monarch 发 `role.*`，不再发 `sugar.*` 旧 token 名），
 *    投影文本零改动这条铁律的显示侧表达；
 * 3. **装饰区间算术**（分词产物 → 1 基行列；越界夹取、乱序跳过、空白与无归属 token 不产区间）；
 * 4. **阅读排版补丁**（栏宽 ≈44 个中日文可见宽度、行距倍数、留白；撤预览写回位有常量真源）。
 *
 * 口径与 `sugar-view.test.ts` 同源：这里是纯函数 + 假 window，不起 Monaco。
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLE } from '@kojo/kojo-lang/semantic-roles';
import {
  EDITOR_PADDING_DEFAULT,
  SUGAR_MARKS_DEFAULT,
  SUGAR_READ_CLASS_DELIMITER,
  SUGAR_READ_CLASS_MARK,
  SUGAR_READ_CLASS_SPEECH,
  SUGAR_READ_CLASS_SYNTAX,
  SUGAR_READ_MARK_MAX_LINES,
  SUGAR_READ_WRAP_COLUMN,
  loadSugarMarksPref,
  saveSugarMarksPref,
  sugarReadClassFor,
  sugarReadDecorations,
  sugarReadTypography,
} from '../src/ui/sugar-view';

/** 假 localStorage（与 sugar-view.test.ts 同款：键值袋足够测"记忆"） */
function fakeWindow(seed: Record<string, string> = {}) {
  const bag = new Map(Object.entries(seed));
  return {
    localStorage: {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
      clear: () => bag.clear(),
      key: () => null,
      length: 0,
    },
    bag,
  };
}

const w = globalThis as unknown as { window?: unknown };
afterEach(() => {
  delete w.window;
});

describe('阅读模式 / 「显示语法标记」偏好', () => {
  it('默认关（= 阅读态）；无 window 回缺省且不抛', () => {
    expect(SUGAR_MARKS_DEFAULT).toBe(false);
    expect(loadSugarMarksPref()).toBe(false);
    expect(() => saveSugarMarksPref(true)).not.toThrow();
  });

  it('写过之后按记录走（开=高对比恢复，关=阅读态），键与糖视图开关分家', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadSugarMarksPref()).toBe(false);
    saveSugarMarksPref(true);
    expect(f.bag.get('kojo.ui.sugarView.marks.v1')).toBe('1');
    expect(loadSugarMarksPref()).toBe(true);
    saveSugarMarksPref(false);
    expect(loadSugarMarksPref()).toBe(false);
    // 与 `.kojo 预览` 总开关两把键：预览开着不代表标记要开着（两轴正交）
    expect(f.bag.has('kojo.ui.sugarView.v1')).toBe(false);
  });

  it('localStorage 抛错 → 缺省阅读态，不让编辑器崩', () => {
    w.window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    expect(loadSugarMarksPref()).toBe(false);
    expect(() => saveSugarMarksPref(true)).not.toThrow();
  });
});

describe('阅读模式 / 角色 → 弱化档位表', () => {
  it('不等待标记（续/~/⏎）归最低档 MARK', () => {
    expect(sugarReadClassFor(ROLE.cont)).toBe(SUGAR_READ_CLASS_MARK);
  });

  it('语法骨架（关键字/别名/运算符/系统函数）同档 SYNTAX——含 `空行` `等待` 这类词表关键字形', () => {
    for (const t of [ROLE.keyword, ROLE.keywordAlias, ROLE.operatorWord, ROLE.call]) {
      expect(sugarReadClassFor(t)).toBe(SUGAR_READ_CLASS_SYNTAX);
    }
  });

  it('结构性标点（：与台词引号同为 role.punctuation）归 DELIMITER；台词正文归 SPEECH', () => {
    expect(sugarReadClassFor(ROLE.punctuation)).toBe(SUGAR_READ_CLASS_DELIMITER);
    expect(sugarReadClassFor(ROLE.speech)).toBe(SUGAR_READ_CLASS_SPEECH);
  });

  it('未登记的角色原样高对比（代词/插值/名字层/原生档不弱化——弱化反而丢信息）', () => {
    for (const t of [ROLE.pronoun, ROLE.interp, ROLE.interpDelimiter, ROLE.slot, ROLE.engine, ROLE.raw, ROLE.text, '']) {
      expect(sugarReadClassFor(t)).toBeUndefined();
    }
  });

  it('层级形态（`a.b` 叠父 scope / Monarch 追加语言后缀）跟随最深一档的前缀走', () => {
    expect(sugarReadClassFor(`${ROLE.keyword}.foo`)).toBe(SUGAR_READ_CLASS_SYNTAX);
    expect(sugarReadClassFor(`${ROLE.cont}.foo`)).toBe(SUGAR_READ_CLASS_MARK);
    // 真 tokenize 产物的形态：Monarch 会在角色名后追加语言 id 后缀
    expect(sugarReadClassFor(`${ROLE.speech}.kojo-legacy`)).toBe(SUGAR_READ_CLASS_SPEECH);
    // 前缀匹配必须带点边界：`role.contents` 不是 `role.cont` 的孩子
    expect(sugarReadClassFor('role.contents')).toBeUndefined();
  });
});

describe('阅读模式 / 装饰区间算术（纯显示层，投影零改动的判据）', () => {
  it('token 区间 = 本 offset 到下一 offset；1 基行列与 Monaco Range 同口径', () => {
    const lines = ['甲 续'];
    const tokens = [[{ offset: 0, type: ROLE.slot }, { offset: 1, type: '' }, { offset: 2, type: ROLE.cont }]];
    expect(sugarReadDecorations(lines, tokens)).toEqual([
      { lineNumber: 1, startColumn: 3, endColumn: 4, className: SUGAR_READ_CLASS_MARK },
    ]);
  });

  it('行尾 token 吃到行末；多行各归各行', () => {
    const lines = ['她说「甲」', '空行 续'];
    const tokens = [
      [
        { offset: 0, type: ROLE.slot },
        { offset: 2, type: ROLE.punctuation },
        { offset: 3, type: ROLE.speech },
        { offset: 4, type: ROLE.punctuation },
      ],
      [
        { offset: 0, type: ROLE.keyword },
        { offset: 2, type: '' },
        { offset: 3, type: ROLE.cont },
      ],
    ];
    expect(sugarReadDecorations(lines, tokens)).toEqual([
      { lineNumber: 1, startColumn: 3, endColumn: 4, className: SUGAR_READ_CLASS_DELIMITER },
      { lineNumber: 1, startColumn: 4, endColumn: 5, className: SUGAR_READ_CLASS_SPEECH },
      { lineNumber: 1, startColumn: 5, endColumn: 6, className: SUGAR_READ_CLASS_DELIMITER },
      { lineNumber: 2, startColumn: 1, endColumn: 3, className: SUGAR_READ_CLASS_SYNTAX },
      { lineNumber: 2, startColumn: 4, endColumn: 5, className: SUGAR_READ_CLASS_MARK },
    ]);
  });

  it('外部数据不可信（与 composeSugarDoc 同款健壮性）：越界夹取、乱序空区间跳过', () => {
    // offset 超行末 ⇒ 夹到行末；下一 token offset 比本 token 小（乱序）⇒ 区间为空，跳过
    expect(
      sugarReadDecorations(['短'], [[{ offset: 0, type: ROLE.cont }, { offset: 99, type: ROLE.cont }]]),
    ).toEqual([{ lineNumber: 1, startColumn: 1, endColumn: 2, className: SUGAR_READ_CLASS_MARK }]);
    expect(sugarReadDecorations(['短'], [[{ offset: 5, type: ROLE.cont }]])).toEqual([]);
  });

  it('token 行数与文本行数不齐不抛（缺文本行按空行处理 → 整行区间为空即跳过）', () => {
    expect(sugarReadDecorations([], [[{ offset: 0, type: ROLE.cont }]])).toEqual([]);
    expect(sugarReadDecorations(['a'], [])).toEqual([]);
  });

  it('行数上限常量在册（超限保持高对比是**可见的取舍**，不许悄悄半弱化）', () => {
    expect(SUGAR_READ_MARK_MAX_LINES).toBeGreaterThan(1000);
  });
});

describe('阅读模式 / 排版补丁（稿纸栏宽 + 行距 + 留白）', () => {
  it('行距 = 字号 × 1.8 取整；折行 bounded；栏宽 ≈44 个中日文可见宽度（2 列/字）', () => {
    expect(sugarReadTypography(14)).toEqual({
      lineHeight: 25,
      wordWrap: 'bounded',
      wordWrapColumn: SUGAR_READ_WRAP_COLUMN,
      padding: { top: 24, bottom: 24 },
    });
    expect(SUGAR_READ_WRAP_COLUMN).toBeGreaterThanOrEqual(80);
    expect(SUGAR_READ_WRAP_COLUMN).toBeLessThanOrEqual(100);
  });

  it('字号为 0/负（脏输入）不产出非法行距（Monaco 的 lineHeight 缺省语义由 0 以下不表达，夹到 1 以上即可读）', () => {
    const p = sugarReadTypography(0);
    expect(p.lineHeight).toBeGreaterThanOrEqual(0);
    expect(p.wordWrap).toBe('bounded');
  });

  it('撤预览写回的留白真源在册（档位漂移防线：clearSugarView 写的就是这一份）', () => {
    expect(EDITOR_PADDING_DEFAULT).toEqual({ top: 6, bottom: 16 });
  });
});

describe('阅读模式 / 接线结构（EditorPane 只碰显示层的三条硬证）', () => {
  const src = readFileSync(new URL('../src/ui/EditorPane.tsx', import.meta.url), 'utf8');

  it('样式组件级引入在册（sugar-read.css 只装饰糖 model 上的类名）', () => {
    expect(src).toContain("import './sugar-read.css'");
  });

  it('「显示语法标记」开关只在预览生效时出现，状态由 aria-pressed 表达、标签恒定', () => {
    expect(src).toContain('sugar-marks-toggle');
    expect(src).toContain('aria-pressed={sugarMarks}');
    // 开关随 `sugarView && sugarStats` 渲染（预览没挂就没有这颗按钮）
    const gate = src.indexOf('sugarView && sugarStats');
    const toggle = src.indexOf('sugar-marks-toggle');
    expect(gate).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(gate);
  });

  it('阅读排版盖在档位之后、撤预览显式写回 wordWrapColumn 与 padding（不漂移）', () => {
    expect(src).toContain('sugarReadTypography(loadFontSizePref())');
    expect(src).toContain('wordWrapColumn: 80');
    expect(src).toContain('EDITOR_PADDING_DEFAULT');
  });

  it('投影口径零改动：装饰只吃 tokenize 产物，不碰 composeSugarDoc 的输出', () => {
    // EditorPane 里糖文本的唯一产出口仍是 composeSugarDoc（阅读模式没有第二份文本装配）
    expect(src.match(/composeSugarDoc\(/g)?.length).toBe(1);
    expect(src).toContain('sugarReadDecorations(');
  });
});
