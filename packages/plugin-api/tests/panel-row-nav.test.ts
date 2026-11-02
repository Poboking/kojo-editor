import { describe, expect, it } from 'vitest';
import {
  applyPanelRowNav,
  applyPanelRowNavFromEvent,
  nextRovingIndex,
  PANEL_ROW_ATTR,
  PANEL_ROW_SELECTOR,
  PANEL_ROW_TRIGGER_ATTR,
  PANEL_ROW_TRIGGER_NONE,
  PANEL_ROW_TRIGGER_OPEN,
  rowNavDecision,
  syncRovingTabIndexes,
  type PanelRovingRowElement,
  type RowNavDomEvent,
} from '../src/index';

/**
 * 面板行键盘协议（契约层单源；kw8a 1102 行键盘批从宿主上提）。
 *
 * 宿主 `packages/app/tests/panel-row-nav.test.ts` / `shell-keys.test.ts` 的既有判据
 * **一条不改**（它们从这里吃同一份实现）；本文件钉的是契约自己的口径：
 * 回绕 / 空集合 / `select`+`textarea` 让位 / F4·F8 的 Shift 反向 /
 * "打开只给事实不给路径" / 合成期放行 / 漫游 tabindex。DOM 层照旧用桩，不起 jsdom。
 */

const base = { shiftKey: false, current: 0, count: 5, inField: false };

describe('nextRovingIndex：唯一一把漫游尺子（回绕 / 夹取 / 空集合）', () => {
  it('前进后退与 Home/End；边界一律回绕', () => {
    expect(nextRovingIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(nextRovingIndex(1, 3, 'ArrowUp')).toBe(0);
    expect(nextRovingIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextRovingIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextRovingIndex(2, 5, 'Home')).toBe(0);
    expect(nextRovingIndex(1, 5, 'End')).toBe(4);
  });

  it('空集合 = null；current 越界先夹取', () => {
    expect(nextRovingIndex(0, 0, 'ArrowDown')).toBeNull();
    expect(nextRovingIndex(-1, 3, 'ArrowDown')).toBe(1); // -1 夹到 0 → 前进 = 1
    expect(nextRovingIndex(99, 3, 'ArrowUp')).toBe(1); // 99 夹到 2 → 后退 = 1
  });

  it('非漫游键让位（Enter/Tab/字母一律 null）', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'F8']) {
      expect(nextRovingIndex(1, 3, key), key).toBeNull();
    }
  });
});

describe('rowNavDecision：键 → 落点（只给事实，不给跳转路径）', () => {
  it('↑↓ 只移焦点，不打开东西', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown' })).toEqual({ index: 1, open: false });
    expect(rowNavDecision({ ...base, key: 'ArrowUp' })).toEqual({ index: 4, open: false });
  });

  it('F4 与 F8 走同一条腿：移过去并当场打开；Shift 反向', () => {
    expect(rowNavDecision({ ...base, key: 'F4', current: 2 })).toEqual({ index: 3, open: true });
    expect(rowNavDecision({ ...base, key: 'F8', current: 2 })).toEqual({ index: 3, open: true });
    expect(rowNavDecision({ ...base, key: 'F4', shiftKey: true, current: 2 })).toEqual({ index: 1, open: true });
    expect(rowNavDecision({ ...base, key: 'F8', shiftKey: true, current: 2 })).toEqual({ index: 1, open: true });
  });

  it('决策的形状只有 {index, open} 两格——打开永远走该行自己的 onClick，不留第二条跳转路径', () => {
    const decision = rowNavDecision({ ...base, key: 'F8' });
    expect(Object.keys(decision ?? {}).sort()).toEqual(['index', 'open']);
  });

  it('焦点不在行上（-1）：↓ 进第一行、↑ 进末行；边界回绕走同一条尺子', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', current: -1 })).toEqual({ index: 0, open: false });
    expect(rowNavDecision({ ...base, key: 'ArrowUp', current: -1 })).toEqual({ index: 4, open: false });
    expect(rowNavDecision({ ...base, key: 'ArrowDown', current: 4 })).toEqual({ index: 0, open: false });
  });

  it('下拉框 / 多行框里的方向键让位；同一处的 F4/F8 不让（那是面板级命令）', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', inField: true })).toBeNull();
    expect(rowNavDecision({ ...base, key: 'ArrowUp', inField: true })).toBeNull();
    expect(rowNavDecision({ ...base, key: 'F4', inField: true })).toEqual({ index: 1, open: true });
  });

  it('空列表 = 没有可导航的行；非导航键一律让位', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', count: 0 })).toBeNull();
    expect(rowNavDecision({ ...base, key: 'F8', count: 0 })).toBeNull();
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'ArrowLeft', 'f', 'F7']) {
      expect(rowNavDecision({ ...base, key })).toBeNull();
    }
  });
});

/* -------------------------- DOM 那层（用桩，不起 jsdom） -------------------------- */

interface StubRow {
  name: string;
  focused: number;
  clicked: number;
  tabIndex?: number;
  inField?: boolean;
  focus(): void;
  click(): void;
  closest(selector: string): unknown;
}

function makeRow(name: string, field = false): StubRow {
  const row: StubRow = {
    name,
    focused: 0,
    clicked: 0,
    inField: field,
    focus() {
      row.focused++;
    },
    click() {
      row.clicked++;
    },
    closest(selector: string) {
      if (selector === PANEL_ROW_SELECTOR) return row.inField ? null : row;
      if (selector === 'select, textarea') return row.inField ? row : null;
      return null;
    },
  };
  return row;
}

function makeHost(rows: StubRow[]) {
  return {
    querySelectorAll(selector: string): ArrayLike<PanelRovingRowElement> {
      expect(selector).toBe(PANEL_ROW_SELECTOR); // 名单只按行标记这一个选择器取
      return rows as unknown as PanelRovingRowElement[];
    },
  };
}

function event(
  target: StubRow | null | undefined,
  key: string,
  init: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {},
): RowNavDomEvent & { prevented: number } {
  const e = {
    key,
    shiftKey: init.shiftKey ?? false,
    target,
    ...(init.isComposing === undefined ? {} : { isComposing: init.isComposing }),
    ...(init.keyCode === undefined ? {} : { keyCode: init.keyCode }),
    prevented: 0,
    preventDefault() {
      e.prevented++;
    },
  };
  return e;
}

describe('applyPanelRowNav：落到行按钮上（含合成期放行与漫游 tabindex）', () => {
  it('↓ 把焦点交给下一行，只 focus 不 click；漫游位跟着走', () => {
    const rows = [makeRow('r0'), makeRow('r1'), makeRow('r2')];
    const host = makeHost(rows);
    const e = event(rows[0], 'ArrowDown');
    expect(applyPanelRowNav(host, e)).toBe(true);
    expect(rows[1]!.focused).toBe(1);
    expect(rows[1]!.clicked).toBe(0);
    expect(e.prevented).toBe(1);
    expect(rows[1]!.tabIndex).toBe(0);
    expect(rows[0]!.tabIndex).toBe(-1);
    expect(rows[2]!.tabIndex).toBe(-1);
  });

  it('F8 移过去并敲那一枚按钮（打开动作仍住在行自己的 onClick）', () => {
    const rows = [makeRow('r0'), makeRow('r1'), makeRow('r2')];
    const e = event(rows[0], 'F8');
    expect(applyPanelRowNav(makeHost(rows), e)).toBe(true);
    expect(rows[1]!.focused).toBe(1);
    expect(rows[1]!.clicked).toBe(1);
  });

  it('Shift+F8 = 反向打开（与 F4 同一格事实）', () => {
    const rows = [makeRow('r0'), makeRow('r1'), makeRow('r2')];
    const e = event(rows[1], 'F8', { shiftKey: true });
    expect(applyPanelRowNav(makeHost(rows), e)).toBe(true);
    expect(rows[0]!.clicked).toBe(1);
    expect(rows[2]!.clicked).toBe(0);
  });

  it('下拉框里的方向键原样让位；同一容器里 F4 仍消费', () => {
    const rows = [makeRow('r0'), makeRow('select', true), makeRow('r2')];
    const host = makeHost(rows);
    const e = event(rows[1], 'ArrowUp');
    expect(applyPanelRowNav(host, e)).toBe(false);
    expect(e.prevented).toBe(0);
    expect(rows.map((r) => r.focused).filter((n) => n > 0)).toEqual([]);
    expect(applyPanelRowNav(host, event(rows[1], 'F4'))).toBe(true);
  });

  it('输入法合成期一律放行：isComposing 与 keyCode 229 各钉一条，不吞键不抢焦点', () => {
    const rows = [makeRow('r0'), makeRow('r1')];
    const host = makeHost(rows);
    const e1 = event(rows[0], 'ArrowDown', { isComposing: true });
    expect(applyPanelRowNav(host, e1)).toBe(false);
    const e2 = event(rows[0], 'ArrowDown', { keyCode: 229 });
    expect(applyPanelRowNav(host, e2)).toBe(false);
    expect(e1.prevented + e2.prevented).toBe(0);
    expect(rows[1]!.focused).toBe(0);
  });

  it('React 合成面不拷贝 isComposing ⇒ nativeEvent 补腿也认（合成期证据两路同源）', () => {
    const rows = [makeRow('r0'), makeRow('r1')];
    const host = makeHost(rows);
    const synthetic = {
      ...event(rows[0], 'ArrowDown'),
      nativeEvent: { isComposing: true },
    };
    expect(applyPanelRowNav(host, synthetic)).toBe(false);
    expect(synthetic.prevented).toBe(0);
    expect(applyPanelRowNav(host, { ...event(rows[0], 'ArrowDown'), nativeEvent: { keyCode: 229 } })).toBe(false);
  });

  it('空容器 / null 容器 / 非导航键都不消费', () => {
    const rows = [makeRow('r0'), makeRow('r1')];
    expect(applyPanelRowNav(makeHost([]), event(null, 'ArrowDown'))).toBe(false);
    expect(applyPanelRowNav(null, event(rows[0], 'F4'))).toBe(false);
    expect(applyPanelRowNav(makeHost(rows), event(rows[0], 'Enter'))).toBe(false);
  });

  it('applyPanelRowNavFromEvent：currentTarget 就是名单容器（接线处一行调用）', () => {
    const rows = [makeRow('r0'), makeRow('r1')];
    const host = makeHost(rows);
    const e = { ...event(rows[0], 'ArrowDown'), currentTarget: host };
    expect(applyPanelRowNavFromEvent(e)).toBe(true);
    expect(rows[1]!.focused).toBe(1);
    expect(applyPanelRowNavFromEvent({ ...e, currentTarget: null })).toBe(false);
  });
});

describe('syncRovingTabIndexes：整段名单只留一枚 tabIndex=0', () => {
  it('焦点不在任何行上（无 document 的桩环境）⇒ 兜底第一行', () => {
    const rows = [makeRow('r0'), makeRow('r1'), makeRow('r2')];
    syncRovingTabIndexes(makeHost(rows));
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('焦点踩住的那一行拿 0，其余 -1', () => {
    const rows = [makeRow('r0'), makeRow('r1'), makeRow('r2')];
    const previousActive = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { activeElement: rows[2] };
    try {
      syncRovingTabIndexes(makeHost(rows));
    } finally {
      if (previousActive === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = previousActive;
    }
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('空名单什么都不做（不留假绿：容器为 null / 无行都不抛）', () => {
    syncRovingTabIndexes(null);
    syncRovingTabIndexes(makeHost([]));
  });

  it('行标记与名单选择器同一个真源', () => {
    expect(PANEL_ROW_ATTR).toBe('data-panel-row');
    expect(PANEL_ROW_SELECTOR).toBe(`[${PANEL_ROW_ATTR}]`);
  });
});

/* ================= kw8c 可触发档批：行级"功能键允许当场打开吗" ================= */

/** 带可触发档的桩行：`getAttribute` 只回报 trigger 那一枚属性，其余缺席（= 默认 `open` 档） */
function makeTriggerRow(name: string, trigger: string | null): StubRow & { getAttribute(n: string): string | null } {
  const row = makeRow(name) as StubRow & { getAttribute(n: string): string | null };
  row.getAttribute = (n: string) => (n === PANEL_ROW_TRIGGER_ATTR ? trigger : null);
  return row;
}

describe('rowNavDecision + triggerable：档只裁功能键落点，↑↓ 名单一字不变', () => {
  const mask = [true, false, false, true]; // 4 行名单，首尾可触发

  it('常量与值域：标记名进契约层，两档值由常量给出（插件侧不写字面量）', () => {
    expect(PANEL_ROW_TRIGGER_ATTR).toBe('data-panel-row-trigger');
    expect(PANEL_ROW_TRIGGER_OPEN).toBe('open');
    expect(PANEL_ROW_TRIGGER_NONE).toBe('none');
  });

  it('↑↓ 完全无视档：落点与不带 mask 时逐字相同（名单不变宽也不变窄）', () => {
    for (const key of ['ArrowDown', 'ArrowUp']) {
      for (const current of [-1, 0, 1, 2, 3]) {
        expect(rowNavDecision({ ...base, count: 4, key, current, triggerable: mask }), `${key}/${current}`).toEqual(
          rowNavDecision({ ...base, count: 4, key, current }),
        );
      }
    }
  });

  it('F4/F8 只在可触发行里找下一个（Shift 反向、边界回绕照旧）', () => {
    // 焦点在 0（可触发）：下一格 1 不可触发 → 2 不可触发 → 落 3 并打开
    expect(rowNavDecision({ ...base, count: 4, key: 'F8', current: 0, triggerable: mask })).toEqual({ index: 3, open: true });
    // 焦点在 1（不可触发）：同样往前找到 3——"踩住 none 行按 F8"绝不在原地开枪
    expect(rowNavDecision({ ...base, count: 4, key: 'F4', current: 1, triggerable: mask })).toEqual({ index: 3, open: true });
    // Shift 反向：从 0 往回绕到 3
    expect(rowNavDecision({ ...base, count: 4, key: 'F8', shiftKey: true, current: 0, triggerable: mask })).toEqual({ index: 3, open: true });
    expect(rowNavDecision({ ...base, count: 4, key: 'F8', shiftKey: true, current: 3, triggerable: mask })).toEqual({ index: 0, open: true });
    // 焦点不在行上：↓ 腿进**第一个可触发行**、↑ 腿进**最后一个**（不是首/末格）
    expect(rowNavDecision({ ...base, count: 4, key: 'F8', current: -1, triggerable: mask })).toEqual({ index: 0, open: true });
    expect(rowNavDecision({ ...base, count: 4, key: 'F8', shiftKey: true, current: -1, triggerable: mask })).toEqual({ index: 3, open: true });
  });

  it('mask 全 true 与缺省同落点（kw8c 前的老形状逐字保留）', () => {
    for (const key of ['F4', 'F8']) {
      for (const current of [-1, 0, 2, 4]) {
        expect(rowNavDecision({ ...base, key, current, triggerable: [true, true, true, true, true] }), `${key}/${current}`).toEqual(
          rowNavDecision({ ...base, key, current }),
        );
      }
    }
  });

  it('整段名单没有一个可触发行：功能键不消费（null——不吞键是不静默铁律的 UI 同构）', () => {
    expect(rowNavDecision({ ...base, count: 4, key: 'F8', current: 0, triggerable: [false, false, false, false] })).toBeNull();
    expect(rowNavDecision({ ...base, count: 4, key: 'F4', current: -1, triggerable: [false, false, false, false] })).toBeNull();
  });
});

describe('applyPanelRowNav + 可触发档：DOM 事实只在这一处读成布尔', () => {
  it('踩住 `none` 行按 F8：焦点落到下一段可触发行并只敲它，`none` 行的 click() 一次没有', () => {
    const rows = [
      makeTriggerRow('install', PANEL_ROW_TRIGGER_NONE),
      makeTriggerRow('readonly', PANEL_ROW_TRIGGER_NONE),
      makeTriggerRow('detail', PANEL_ROW_TRIGGER_OPEN),
    ];
    const e = event(rows[0], 'F8');
    expect(applyPanelRowNav(makeHost(rows), e)).toBe(true);
    expect(rows[0]!.clicked).toBe(0);
    expect(rows[1]!.focused + rows[1]!.clicked).toBe(0); // 直接跳过，不停靠
    expect(rows[2]!.focused).toBe(1);
    expect(rows[2]!.clicked).toBe(1);
    expect(e.prevented).toBe(1);
  });

  it('`none` 行在 ↑↓ 名单里数得出：能聚焦、漫游 tabindex 照走、什么都不会被 click', () => {
    const rows = [makeTriggerRow('r0', PANEL_ROW_TRIGGER_OPEN), makeTriggerRow('r1', PANEL_ROW_TRIGGER_NONE)];
    const host = makeHost(rows);
    expect(applyPanelRowNav(host, event(rows[0], 'ArrowDown'))).toBe(true);
    expect(rows[1]!.focused).toBe(1);
    expect(rows[1]!.clicked).toBe(0);
    expect(rows[1]!.tabIndex).toBe(0); // 踩住的是它，漫游位就给谁
    expect(rows[0]!.tabIndex).toBe(-1);
    // 再下一格回绕仍停在可触发行上（↑↓ 不因档而跳过任何行）
    expect(applyPanelRowNav(host, event(rows[1], 'ArrowDown'))).toBe(true);
    expect(rows[0]!.focused).toBe(1);
    expect(rows[0]!.clicked).toBe(0);
  });

  it('属性缺席 = 默认 `open` 档：老桩行（无 getAttribute）功能键照旧当场 click', () => {
    const rows = [makeRow('r0'), makeRow('r1')]; // 无 getAttribute——老宿主/插件的形状
    expect(applyPanelRowNav(makeHost(rows), event(rows[0], 'F4'))).toBe(true);
    expect(rows[1]!.clicked).toBe(1);
  });

  it('整段全是 `none`：F4/F8 返回 false、preventDefault 一次没调、焦点原地不动', () => {
    const rows = [makeTriggerRow('a', PANEL_ROW_TRIGGER_NONE), makeTriggerRow('b', PANEL_ROW_TRIGGER_NONE)];
    const host = makeHost(rows);
    const e = event(rows[0], 'F8');
    expect(applyPanelRowNav(host, e)).toBe(false);
    expect(e.prevented).toBe(0);
    expect(rows[0]!.focused + rows[0]!.clicked + rows[1]!.focused + rows[1]!.clicked).toBe(0);
    const e2 = event(null, 'F4');
    expect(applyPanelRowNav(host, e2)).toBe(false);
    expect(e2.prevented).toBe(0);
  });
});
