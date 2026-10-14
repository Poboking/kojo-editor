/**
 * 糖视图宿主侧纯逻辑单测（2026-10-12 语法糖批）。
 *
 * 钉死的是"读者视角"的四件事：
 * - **默认开**：不熟悉 EraBasic 的人打开别人的 ERB 就该直接看到人话（本功能的存在理由）；
 * - **偏好记住**：关了它就不会每次重开又冒出来（否则默认开就变成骚扰）；
 * - **锚点在原文上方**：糖落在原区间的位置上，隐藏原文后读者看到的位置不变；
 * - **着色回退**：Monarch 给出更细的 token（`sugar.speech.delimiter`）时逐级回退，
 *   主题没覆盖的 token 交回正文色（旁白 = 正文色是刻意的，不是漏配）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  SUGAR_VIEW_DEFAULT,
  loadSugarViewPref,
  needsZoneRelayout,
  saveSugarViewPref,
  sugarSummary,
  sugarViewAllowed,
  sugarZonePlan,
  trimSegmentBlanks,
} from '../src/ui/sugar-view';
import { SUGAR_DEFAULT_COLOR, tokenColor } from '../src/monaco/sugar-render';

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

describe('糖视图 / ViewZone 计划', () => {
  it('锚点在原区间**上方一行**（隐藏原文后读者看到的位置不变）', () => {
    expect(sugarZonePlan({ fromLine: 12, sugarText: '甲\n乙' }).afterLineNumber).toBe(11);
  });

  it('首行段锚点落在 0（文件顶部；Monaco 接受，绝不落到负行号）', () => {
    expect(sugarZonePlan({ fromLine: 1, sugarText: '甲' }).afterLineNumber).toBe(0);
  });

  it('高度 = 糖行数 + 1 行呼吸', () => {
    const p = sugarZonePlan({ fromLine: 3, sugarText: '甲\n乙\n丙' });
    expect(p.lineCount).toBe(3);
    expect(p.heightInLines).toBe(4);
  });
});

describe('糖视图 / 摘要文案', () => {
  it('只报已覆盖的行数（未覆盖含注释与空行，加总会误导）', () => {
    expect(sugarSummary(123)).toBe('语法糖 123 行');
    expect(sugarSummary(0)).toBe('语法糖 0 行');
  });

  it('面向作者的读数不含实现术语（用户反馈 5：别拿内部说法当文案）', () => {
    // 「映射 / 投影 / 降级 / 覆盖」是糖投影器的词表，口上作者没有一个会说。
    for (const jargon of ['映射', '投影', '降级', '覆盖']) {
      expect(sugarSummary(312)).not.toContain(jargon);
    }
  });
});

describe('糖视图 / 配色回退', () => {
  it('精确命中主题规则', () => {
    expect(tokenColor('sugar.keyword')).toBe('#c678dd');
    expect(tokenColor('sugar.speech.delimiter')).toBe('#7f9cc0');
  });

  it('更细的 token 未单独配色 → 逐级回退到父级', () => {
    // `sugar.speech.xxx` 主题里没有 → 回退到 `sugar.speech`
    expect(tokenColor('sugar.speech.quoted')).toBe(tokenColor('sugar.speech'));
    // `sugar.keyword.unknown` → `sugar.keyword`
    expect(tokenColor('sugar.keyword.unknown')).toBe('#c678dd');
  });

  it('主题未覆盖的 token → 正文色（旁白 = 正文色，是刻意口径）', () => {
    expect(tokenColor('')).toBe(SUGAR_DEFAULT_COLOR);
    expect(tokenColor('identifier')).toBe(SUGAR_DEFAULT_COLOR);
    expect(tokenColor('nonsense.dotted.type')).toBe(SUGAR_DEFAULT_COLOR);
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
describe('sugarViewAllowed（糖视图可用门 = 不可编辑态的派生）', () => {
  it('游戏目录 ERB、未解锁 → 唯一放行的组合', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: false, sealed: false })).toBe(true);
  });

  it('.kojo 不放糖视图（本身就是糖，再投影一遍没有意义）', () => {
    expect(sugarViewAllowed({ isErbLike: false, inWorkspace: false, unlocked: false, sealed: false })).toBe(false);
  });

  it('工作区 ERB 不放糖视图（轴一：恒可编辑 ⟹ 原文必须看得见）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: false, sealed: false })).toBe(false);
    // 解锁态不影响结论（工作区根本走不到解锁这条路）
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: true, sealed: false })).toBe(false);
  });

  it('游戏目录 ERB 一旦解锁 → 该份糖视图禁用（轴二与互斥规则一致）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: true, sealed: false })).toBe(false);
  });

  it('封存总闸开启 → 封存优先于一切（本来放行的组合也返回 false）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: false, sealed: true })).toBe(false);
  });
});

/* ============ 糖段首尾空行（2026-10-13 目视体检：高亮块开头一大块空白） ============ */

/**
 * 投影按原文行逐行映射，段首常带空行；落在 ViewZone 里就是"这块糖没内容"的错觉。
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

  it('整段皆空 ⇒ 原样返回（剪成零行会让 ViewZone 高度与折叠柄算错）', () => {
    const t = '\n  \n';
    expect(trimSegmentBlanks(t)).toBe(t);
  });

  it('剪完之后 ViewZone 计划按剩余行数给高（呼吸位仍是 +1）', () => {
    const raw = '\n\n她说「甲」\n她说「乙」\n';
    const plan = sugarZonePlan({ fromLine: 5, sugarText: trimSegmentBlanks(raw) });
    expect(plan.lineCount).toBe(2);
    expect(plan.heightInLines).toBe(3);
    expect(plan.afterLineNumber).toBe(4);
  });
});

/* ============ 盒高自洽（折行后内容变高 → 把 ViewZone 估算高换成实测高） ============ */

/**
 * 真机反馈的病根：ViewZone 的盒子高按"糖逻辑行数 × 编辑器行高"估，一旦糖文本按 `wordWrap`
 * 折行，实测渲染高度就超出估算——原来靠 `overflow: hidden` 兜，结果尾部台词被裁。
 * 这里钉的是**只放大、不缩小**的判定：折行导致超高才重设，呼吸位 / 柄行的刻意留白不许被压掉。
 */
describe('needsZoneRelayout · 折行超高才重设（只放大不缩小）', () => {
  const LH = 19; // 编辑器 fontSize 14 → 行高约 19px

  it('折行后内容明显超出估算 → 需要重设', () => {
    // 估算 5 行（95px），实测折行后 8 行（152px）——必须重设，否则尾部被裁
    expect(needsZoneRelayout(5 * LH, 8 * LH, LH)).toBe(true);
  });

  it('内容与估算相当（差不足半行）→ 不动，省掉亚像素抖动引发的反复重排', () => {
    expect(needsZoneRelayout(5 * LH, 5 * LH, LH)).toBe(false);
    expect(needsZoneRelayout(5 * LH, 5 * LH + LH / 2 - 1, LH)).toBe(false);
  });

  it('内容比估算矮（没折行）→ 绝不缩小：呼吸位与折叠柄行必须留住', () => {
    expect(needsZoneRelayout(5 * LH, 4 * LH, LH)).toBe(false);
    expect(needsZoneRelayout(5 * LH, LH, LH)).toBe(false);
  });

  it('量不到 / 非法值 → 不重设（宁可保留估算，也不拿脏数据乱动盒高）', () => {
    expect(needsZoneRelayout(5 * LH, 0, LH)).toBe(false);
    expect(needsZoneRelayout(5 * LH, Number.NaN, LH)).toBe(false);
    expect(needsZoneRelayout(5 * LH, 8 * LH, 0)).toBe(false);
    expect(needsZoneRelayout(5 * LH, 8 * LH, Number.NaN)).toBe(false);
  });
});
