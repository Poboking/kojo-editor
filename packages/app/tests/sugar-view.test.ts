/**
 * 糖视图宿主侧纯逻辑单测（2026-10-12 语法糖批；2026-10-14 改为「整份糖文本写进内存 model」）。
 *
 * 钉死的是"读者视角"的几件事：
 * - **默认开**：不熟悉 EraBasic 的人打开别人的 ERB 就该直接看到人话（本功能的存在理由）；
 * - **偏好记住**：关了它就不会每次重开又冒出来（否则默认开就变成骚扰）；
 * - **整份拼装口径**：`composeSugarDoc` 把糖段拼进原文——被覆盖的行换成糖文本、未覆盖的行
 *   原样留，这是"糖文本写进编辑器本身"的核心算术。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  SUGAR_VIEW_DEFAULT,
  composeSugarDoc,
  loadSugarViewPref,
  saveSugarViewPref,
  sugarSummary,
  sugarViewAllowed,
  trimSegmentBlanks,
} from '../src/ui/sugar-view';

/** 假 localStorage：只是键值袋，够测"记忆"这一件事 */
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

describe('糖视图 / 偏好', () => {
  it('无 window（测试环境 / 非浏览器）→ 回默认（且不抛）', () => {
    expect(loadSugarViewPref()).toBe(SUGAR_VIEW_DEFAULT);
    expect(SUGAR_VIEW_DEFAULT).toBe(true);
    expect(() => saveSugarViewPref(true)).not.toThrow();
  });

  it('首次（无记录）→ 默认开；写过之后按记录走', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadSugarViewPref()).toBe(true);

    saveSugarViewPref(false);
    expect(f.bag.get('kojo.ui.sugarView.v1')).toBe('0');
    expect(loadSugarViewPref()).toBe(false);

    saveSugarViewPref(true);
    expect(loadSugarViewPref()).toBe(true);
  });

  it('localStorage 抛错（隐私模式 / 配额满）→ 降级为默认值，不让编辑器崩', () => {
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
    expect(loadSugarViewPref()).toBe(SUGAR_VIEW_DEFAULT);
    expect(() => saveSugarViewPref(false)).not.toThrow();
  });
});

describe('.kojo 预览 / 摘要文案', () => {
  it('只报已覆盖的行数（未覆盖含注释与空行，加总会误导）', () => {
    expect(sugarSummary(123)).toBe('.kojo 显示 123 行');
    expect(sugarSummary(0)).toBe('.kojo 显示 0 行');
  });

  it('面向作者的读数不含实现术语（用户反馈 5：别拿内部说法当文案）', () => {
    // 「映射 / 投影 / 降级 / 覆盖」是糖投影器的词表，口上作者没有一个会说。
    for (const jargon of ['映射', '投影', '降级', '覆盖']) {
      expect(sugarSummary(312)).not.toContain(jargon);
    }
  });
});

/**
 * 糖视图可用门（ADR-0005：目录分野 × 显式解锁）。
 *
 * 这条门是两组**合流点**：口上项目组把"游戏目录 ERB 只读 / 工作区 ERB 恒可编辑"
 * 落成了轴一，本线把"解锁弹窗"落成轴二，ADR 定的是"糖视图与可编辑态互斥"。
 * 钉死它，是为了防止后来者把糖视图重新做成"任何 ERB 都能开"——那会让用户
 * 在**看不见原文**的情况下编辑自己的工作区文件。
 *
 * 2026-10-13 试用反馈批给这条门加了**最高优先级否决轴**：封存总闸（`sealed.ts`）。
 */
describe('sugarViewAllowed（.kojo 预览可用门 = 不可编辑态的派生）', () => {
  it('游戏目录 ERB、未解锁 → 唯一放行的组合', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: false, sealed: false })).toBe(true);
  });

  it('.kojo 不开预览（本身就是 .kojo，再投影一遍没有意义）', () => {
    expect(sugarViewAllowed({ isErbLike: false, inWorkspace: false, unlocked: false, sealed: false })).toBe(false);
  });

  it('工作区 ERB 不开 .kojo 预览（轴一：恒可编辑 ⟹ 原文必须看得见）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: false, sealed: false })).toBe(false);
    // 解锁态不影响结论（工作区根本走不到解锁这条路）
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: true, sealed: false })).toBe(false);
  });

  it('游戏目录 ERB 一旦解锁 → 该份 .kojo 预览禁用（轴二与互斥规则一致）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: true, sealed: false })).toBe(false);
  });

  it('封存总闸开启 → 封存优先于一切（本来放行的组合也返回 false）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: false, sealed: true })).toBe(false);
  });
});

/* ============ 糖段首尾空行（2026-10-13 目视体检：糖块开头一大块空白） ============ */

/**
 * 投影按原文行逐行映射，段首常带空行；拼进整份糖文本就是"这块糖没内容"的错觉。
 * 这里钉的是**只剪首尾、段内空行一根不动**——段内空行是分节，删了等于把剧本排成一行。
 */
describe('trimSegmentBlanks · 只剪段首尾，段内分节不许动', () => {
  it('段首两个空行剪掉，正文与段内空行原样保留', () => {
    const out = trimSegmentBlanks(['', '', '她说「甲」', '', '她说「乙」'].join('\n'));
    expect(out.split('\n')).toEqual(['她说「甲」', '', '她说「乙」']);
  });

  it('段尾空行（含只有空格的行）也剪', () => {
    expect(trimSegmentBlanks('PRINT A\n\n   \n').split('\n')).toEqual(['PRINT A']);
  });

  it('没有空行的段逐字不变（不制造第二次差异）', () => {
    const t = '如果 恋慕：\n  她说「甲」';
    expect(trimSegmentBlanks(t)).toBe(t);
  });

  it('整段皆空 ⇒ 原样返回（剪成零行会让糖段错位、与原文对不上）', () => {
    const t = '\n  \n';
    expect(trimSegmentBlanks(t)).toBe(t);
  });
});

/* ============ 整份糖文本拼装（composeSugarDoc） ============ */

/**
 * 「糖文本写进编辑器本身」的核心算术：逐行 1..N 走，落在某糖段区间内的行换成该段的糖文本
 * （按 `\n` 拆多行一并输出），其余行原样留。这里钉的是 segment 作为**外部数据**的健壮性：
 * 乱序 / 越界 / 反向 / 重叠都不能让拼装崩，也不能重复铺内容。
 */
describe('composeSugarDoc · 把糖段拼进整份原文', () => {
  it('空 segments ⇒ 原文逐行原样拼接（无糖可铺）', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [])).toBe('a\nb\nc');
  });

  it('空原文（N=0）⇒ 空串；越界糖段被丢弃（不凭空产出）', () => {
    expect(composeSugarDoc([], [])).toBe('');
    expect(composeSugarDoc([], [{ fromLine: 1, toLine: 1, sugarText: 'X' }])).toBe('');
  });

  it('全被覆盖（单段覆盖整份）⇒ 只输出糖文本', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 1, toLine: 2, sugarText: '糖' }])).toBe('糖');
  });

  it('部分覆盖 + 前后留原文：被覆盖区间换成糖，其余行原位保留', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    expect(composeSugarDoc(lines, [{ fromLine: 2, toLine: 3, sugarText: 'X\nY' }])).toBe('a\nX\nY\nd\ne');
  });

  it('段行数 ≠ 原文行数：单行原文可换成多行糖（整段透传，不按行对齐）', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 2, toLine: 2, sugarText: 'X\nY\nZ' }])).toBe('a\nX\nY\nZ');
  });

  it('首段（fromLine=1）正确落位', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 1, toLine: 1, sugarText: 'S' }])).toBe('S\nb\nc');
  });

  it('尾段（toLine=N）正确落位', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 3, toLine: 3, sugarText: 'S' }])).toBe('a\nb\nS');
  });

  it('多段混合（不相邻）各自独立落位', () => {
    const lines = ['1', '2', '3', '4', '5', '6'];
    const segs = [
      { fromLine: 1, toLine: 1, sugarText: 'A' },
      { fromLine: 4, toLine: 4, sugarText: 'D' },
    ];
    expect(composeSugarDoc(lines, segs)).toBe('A\n2\n3\nD\n5\n6');
  });

  it('乱序段先按 fromLine 升序再落位（输入顺序不影响结果）', () => {
    const lines = ['1', '2', '3', '4', '5'];
    const segs = [
      { fromLine: 4, toLine: 4, sugarText: 'D' },
      { fromLine: 1, toLine: 1, sugarText: 'A' },
    ];
    expect(composeSugarDoc(lines, segs)).toBe('A\n2\n3\nD\n5');
  });

  it('重叠段先到者优先：被前段覆盖到的后到段整段丢弃（不重复铺）', () => {
    const lines = ['1', '2', '3', '4', '5'];
    const segs = [
      { fromLine: 1, toLine: 3, sugarText: 'X' },
      { fromLine: 2, toLine: 4, sugarText: 'Y' },
    ];
    expect(composeSugarDoc(lines, segs)).toBe('X\n4\n5');
  });

  it('fromLine > toLine（反向区间）⇒ 丢弃，不动原文', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 2, toLine: 1, sugarText: 'X' }])).toBe('a\nb');
  });

  it('完全越界（整段落在 [1,N] 外）⇒ 丢弃，不动原文', () => {
    expect(composeSugarDoc(['a', 'b'], [{ fromLine: 5, toLine: 6, sugarText: 'X' }])).toBe('a\nb');
  });

  it('部分越界 ⇒ 夹取到 [1,N]（fromLine 0 → 1；toLine 超 N → N）', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 0, toLine: 2, sugarText: 'X' }])).toBe('X\nc');
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 2, toLine: 99, sugarText: 'Y' }])).toBe('a\nY');
  });

  it('单行原文（N=1）覆盖正常', () => {
    expect(composeSugarDoc(['only'], [{ fromLine: 1, toLine: 1, sugarText: 'S' }])).toBe('S');
  });

  it('糖段内空行原样输出（本函数不做首尾修剪，那是 trimSegmentBlanks 的职责）', () => {
    expect(composeSugarDoc(['a', 'b', 'c'], [{ fromLine: 2, toLine: 2, sugarText: '\nX\n' }])).toBe('a\n\nX\n\nc');
  });
});
