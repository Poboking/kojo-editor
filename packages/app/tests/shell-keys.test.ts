import { describe, expect, it } from 'vitest';
import {
  ESC_PRIORITY,
  IME_PROCESS_KEY_CODE,
  isComposingEvent,
  nextRovingIndex,
  resolveEscLayer,
  type EscLayers,
} from '../src/ui/shell-keys';

/**
 * Esc 优先级链单测（2026-10-12 P4 补测批）。
 *
 * 这条链是「一次按键关掉哪一层」的唯一裁决点，历史欠账是 P4 落地时零新增测试。
 * 断言口径刻意**不看「按了有没有反应」，只看「反应落在哪一层」**：链上任何一档退化
 * （例如 overlay 关掉后连带把全禅也退出）都必须让这里变红——只占一处的行为混在大
 * 指标里不会红，这是本项目守门口径的一贯教训。
 */

/** 按名铺层：缺省全不在场，测试里只写与本轮相关的那几档 */
function layers(on: readonly (keyof EscLayers)[] = []): EscLayers {
  return {
    picker: on.includes('picker'),
    modal: on.includes('modal'),
    overlay: on.includes('overlay'),
    settings: on.includes('settings'),
    zen: on.includes('zen'),
  };
}

/** 全 2^5 种在场组合（幂集，按位枚举），用于穷举断言「命中层 = 最靠前的在场层」 */
function allCombos(): EscLayers[] {
  return Array.from({ length: 1 << ESC_PRIORITY.length }, (_, mask) =>
    layers(ESC_PRIORITY.filter((_, i) => (mask & (1 << i)) !== 0)),
  );
}

describe('逐档：单独在场', () => {
  it('只有命令面板/快速打开在前台 → 由 picker 承接，全局侧不动任何布局状态', () => {
    expect(resolveEscLayer(layers(['picker']))).toBe('picker');
  });

  it('只有宿主模态在栈顶 → 由模态承接（HK-2：Esc 关得掉对话框）', () => {
    expect(resolveEscLayer(layers(['modal']))).toBe('modal');
  });

  it('只有 ui.overlay 浮层在场 → 关浮层', () => {
    expect(resolveEscLayer(layers(['overlay']))).toBe('overlay');
  });

  it('只有设置 overlay 在场 → 关设置页', () => {
    expect(resolveEscLayer(layers(['settings']))).toBe('settings');
  });

  it('只有全禅在场 → 退出全禅', () => {
    expect(resolveEscLayer(layers(['zen']))).toBe('zen');
  });

  it('五层全不在场 → null（Esc 是空操作，绝不"顺手"改布局）', () => {
    expect(resolveEscLayer(layers())).toBeNull();
  });
});

describe('逐档：对撞时只关最靠前的一层', () => {
  it('picker 在场时优先关 picker——即使模态/overlay/设置/全禅都开着', () => {
    expect(resolveEscLayer(layers(['picker', 'modal', 'overlay', 'settings', 'zen']))).toBe('picker');
  });

  it('模态优先于向导：对话框正在问一个当下就要答案的问题', () => {
    expect(resolveEscLayer(layers(['modal', 'overlay']))).toBe('modal');
  });

  it('模态优先于设置页与全禅：关对话框不该把背景流程一起退掉', () => {
    expect(resolveEscLayer(layers(['modal', 'settings', 'zen']))).toBe('modal');
  });

  it('设置 overlay 开着 + 全禅开着 → 只关设置页，全禅状态原样（§5.54 记录的链路）', () => {
    expect(resolveEscLayer(layers(['settings', 'zen']))).toBe('settings');
  });

  it('ui.overlay 与设置 overlay 同开 → 槽浮层优先，设置页不动', () => {
    expect(resolveEscLayer(layers(['overlay', 'settings']))).toBe('overlay');
  });

  it('ui.overlay 优先于全禅：退出全禅不能把浮层一起吞掉', () => {
    expect(resolveEscLayer(layers(['overlay', 'zen']))).toBe('overlay');
  });

  it('已承接时第二次 Esc 才轮到下一层（链是逐步退出，不是一步到底）', () => {
    const first = layers(['modal', 'overlay', 'settings', 'zen']);
    expect(resolveEscLayer(first)).toBe('modal');
    // 浮层已被关掉，同一份状态里 overlay 变 false
    expect(resolveEscLayer({ ...first, modal: false })).toBe('overlay');
    expect(resolveEscLayer({ ...first, modal: false, overlay: false })).toBe('settings');
    expect(
      resolveEscLayer({ ...first, modal: false, overlay: false, settings: false }),
    ).toBe('zen');
    expect(
      resolveEscLayer({ ...first, modal: false, overlay: false, settings: false, zen: false }),
    ).toBeNull();
  });
});

describe('穷举：命中层恒等于最靠前的在场层', () => {
  it('全部 32 种组合逐一核对（顺序 = ESC_PRIORITY）', () => {
    const combos = allCombos();
    expect(combos).toHaveLength(32);
    for (const l of combos) {
      const present = ESC_PRIORITY.filter((k) => l[k]).join('+');
      expect(resolveEscLayer(l), present || '(全不在场)').toBe(
        ESC_PRIORITY.find((k) => l[k]) ?? null,
      );
    }
  });

  it('返回值是单层名而非数组 ⇒「一次按键只关一层」由类型结构保证', () => {
    const hit = resolveEscLayer(layers(['picker', 'modal', 'overlay', 'settings', 'zen']));
    expect(ESC_PRIORITY).toContain(hit);
    expect(Array.isArray(hit)).toBe(false);
  });

  it('链顺序钉死为 picker > modal > overlay > settings > zen（改序须走批次记录）', () => {
    expect([...ESC_PRIORITY]).toEqual(['picker', 'modal', 'overlay', 'settings', 'zen']);
  });
});

/**
 * 合成期门的判据真值表。
 *
 * 这里量的是**判据**（三条证据各自够不够、正常 Esc 有没有被误拦）；「闸在壳层里接没接上」
 * 不是一份 node 单测能证的——那部分由真实桌面壳 + CDP 事件注入实测（见 IMPLEMENTATION-LOG
 * 本批记录），别把这里当成分支接线的证据。
 */
describe('合成期门：三条证据的真值表', () => {
  it('合成中的按键（isComposing=true）一律吞掉——撤销拼音候选的 Esc 属于输入法', () => {
    expect(isComposingEvent({ isComposing: true, keyCode: 229 }, false)).toBe(true);
  });

  it('只有 Process 键码（229）也算合成期：部分版本在 Esc 上已把 isComposing 翻回 false', () => {
    expect(isComposingEvent({ isComposing: false, keyCode: IME_PROCESS_KEY_CODE }, false)).toBe(true);
    expect(IME_PROCESS_KEY_CODE).toBe(229);
  });

  it('两条事件属性都没带上、但合成会话仍在 → 仍拦（第三方输入法兜底）', () => {
    expect(isComposingEvent({ isComposing: false, keyCode: 27 }, true)).toBe(true);
  });

  it('三条证据全假 → 放行。**这条是反向守门**：拦错了正常 Esc，Esc 就彻底失效了', () => {
    expect(isComposingEvent({ isComposing: false, keyCode: 27 }, false)).toBe(false);
    expect(isComposingEvent({ keyCode: 66, ctrlKey: true } as never, false)).toBe(false);
  });

  it('全 8 种证据组合逐一核对（isComposing × keyCode229 × 会话标志）', () => {
    const rows: Array<[{ isComposing?: boolean; keyCode?: number }, boolean]> = [];
    for (const comp of [true, false]) {
      for (const process of [true, false]) {
        for (const session of [true, false]) {
          rows.push([{ isComposing: comp, keyCode: process ? 229 : 65 }, session]);
        }
      }
    }
    expect(rows).toHaveLength(8);
    for (const [event, session] of rows) {
      const expected = event.isComposing === true || event.keyCode === 229 || session;
      expect(isComposingEvent(event, session), `${String(event.isComposing)}/${event.keyCode}/${session}`).toBe(expected);
    }
  });

  it('证据缺字段（旧内核不实现 isComposing）时不抛错，按未知处理为放行', () => {
    expect(isComposingEvent({}, true)).toBe(true);
    expect(isComposingEvent({}, false)).toBe(false);
  });
});

/**
 * 方向键漫游落点单测（2026-10-14 HK-4 UI 批）。
 *
 * 这条规则是「标签条 / 活动栏一组控件怎么用方向键走位」的唯一裁决点。断言刻意覆盖
 * **回绕边界**与**让位契约**：非漫游键必须返回 null（否则 Enter/Space 激活、Tab 跳走
 * 会被壳层吞掉）；空集合必须返回 null（否则调用方会拿到一个不存在的索引去 focus）。
 */
describe('方向键漫游：前进/后退/回绕/Home/End', () => {
  it('ArrowRight / ArrowDown 各前进一格', () => {
    expect(nextRovingIndex(0, 3, 'ArrowRight')).toBe(1);
    expect(nextRovingIndex(1, 3, 'ArrowDown')).toBe(2);
  });

  it('ArrowLeft / ArrowUp 各后退一格', () => {
    expect(nextRovingIndex(2, 3, 'ArrowLeft')).toBe(1);
    expect(nextRovingIndex(1, 3, 'ArrowUp')).toBe(0);
  });

  it('两端回绕：末尾前进 → 0，首位后退 → count-1', () => {
    expect(nextRovingIndex(2, 3, 'ArrowRight')).toBe(0);
    expect(nextRovingIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextRovingIndex(0, 3, 'ArrowLeft')).toBe(2);
    expect(nextRovingIndex(0, 3, 'ArrowUp')).toBe(2);
  });

  it('Home 到 0，End 到 count-1（与当前落点无关）', () => {
    expect(nextRovingIndex(2, 5, 'Home')).toBe(0);
    expect(nextRovingIndex(1, 5, 'End')).toBe(4);
  });

  it('单项集合恒落在 0（前进后退都回绕到自身）', () => {
    expect(nextRovingIndex(0, 1, 'ArrowRight')).toBe(0);
    expect(nextRovingIndex(0, 1, 'ArrowLeft')).toBe(0);
    expect(nextRovingIndex(0, 1, 'Home')).toBe(0);
    expect(nextRovingIndex(0, 1, 'End')).toBe(0);
  });

  it('非漫游键返回 null ⇒ 调用方原样让位（Enter/Space/Tab/Escape 都不该被吞）', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'PageDown']) {
      expect(nextRovingIndex(1, 3, key), key).toBeNull();
    }
  });

  it('空集合（count <= 0）返回 null——没有可漫游的元素', () => {
    expect(nextRovingIndex(0, 0, 'ArrowRight')).toBeNull();
    expect(nextRovingIndex(0, -3, 'ArrowRight')).toBeNull();
    expect(nextRovingIndex(0, 0, 'Home')).toBeNull();
  });

  it('current 越界先夹取再算：-1（indexOf 未命中）当 0，超上界当 count-1', () => {
    expect(nextRovingIndex(-1, 3, 'ArrowRight')).toBe(1); // -1 夹到 0 → 前进 = 1
    expect(nextRovingIndex(-1, 3, 'Home')).toBe(0);
    expect(nextRovingIndex(99, 3, 'ArrowLeft')).toBe(1); // 99 夹到 2 → 后退 = 1
    expect(nextRovingIndex(99, 3, 'End')).toBe(2);
  });

  it('穷举：任意 current × 六个漫游键，落点恒在 [0, count) 内', () => {
    for (const count of [1, 2, 3, 5]) {
      for (let current = -2; current <= count + 2; current++) {
        for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) {
          const next = nextRovingIndex(current, count, key);
          expect(next, `${current}/${count}/${key}`).not.toBeNull();
          expect(next!, `${current}/${count}/${key}`).toBeGreaterThanOrEqual(0);
          expect(next!, `${current}/${count}/${key}`).toBeLessThan(count);
        }
      }
    }
  });
});
