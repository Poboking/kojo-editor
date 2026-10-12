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
  saveSugarViewPref,
  sugarSummary,
  sugarViewAllowed,
  sugarZonePlan,
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
  it('只说"已映射多少行"（未映射含注释空行，加总会误导）', () => {
    expect(sugarSummary(123)).toBe('糖视图 · 已映射 123 行');
    expect(sugarSummary(0)).toBe('糖视图 · 已映射 0 行');
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
 */
describe('sugarViewAllowed（糖视图可用门 = 不可编辑态的派生）', () => {
  it('游戏目录 ERB、未解锁 → 唯一放行的组合', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: false })).toBe(true);
  });

  it('.kojo 不放糖视图（本身就是糖，再投影一遍没有意义）', () => {
    expect(sugarViewAllowed({ isErbLike: false, inWorkspace: false, unlocked: false })).toBe(false);
  });

  it('工作区 ERB 不放糖视图（轴一：恒可编辑 ⟹ 原文必须看得见）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: false })).toBe(false);
    // 解锁态不影响结论（工作区根本走不到解锁这条路）
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: true, unlocked: true })).toBe(false);
  });

  it('游戏目录 ERB 一旦解锁 → 该份糖视图禁用（轴二与互斥规则一致）', () => {
    expect(sugarViewAllowed({ isErbLike: true, inWorkspace: false, unlocked: true })).toBe(false);
  });
});
