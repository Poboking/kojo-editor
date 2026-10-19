import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPanelRowNav,
  PANEL_ROW_ATTR,
  rowNavDecision,
  type PanelRowElement,
  type RowNavDomEvent,
} from '../src/ui/panel-row-nav';

/**
 * 结果面板行导航（1020 编辑器体感批，用户反馈项 9）。
 *
 * 两只面板共用一份判据 ⇒ 单测也只需钉一处：键怎么折成意图、边界怎么走、
 * 什么情况下**必须让位**（下拉框的方向键、非导航键）。DOM 那层用桩，不起 jsdom。
 */

const base = { shiftKey: false, current: 0, count: 5, inField: false };

describe('rowNavDecision：键 → 落点', () => {
  it('↑↓ 只移焦点，不打开东西', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown' })).toEqual({ index: 1, open: false });
    expect(rowNavDecision({ ...base, key: 'ArrowUp' })).toEqual({ index: 4, open: false }); // 0 再后退 = 末行
  });

  it('F4 与 F8 走同一条腿：移过去并当场打开；Shift 反向', () => {
    expect(rowNavDecision({ ...base, key: 'F4', current: 2 })).toEqual({ index: 3, open: true });
    expect(rowNavDecision({ ...base, key: 'F8', current: 2 })).toEqual({ index: 3, open: true });
    expect(rowNavDecision({ ...base, key: 'F4', shiftKey: true, current: 2 })).toEqual({ index: 1, open: true });
    expect(rowNavDecision({ ...base, key: 'F8', shiftKey: true, current: 2 })).toEqual({ index: 1, open: true });
  });

  it('焦点不在结果行上（-1）时：↓ 从第一行走、↑ 从最后一行走（与文件树同一条回绕尺子）', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', current: -1 })).toEqual({ index: 0, open: false });
    expect(rowNavDecision({ ...base, key: 'ArrowUp', current: -1 })).toEqual({ index: 4, open: false });
  });

  it('边界回绕：末行再往下回到第一行', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', current: 4 })).toEqual({ index: 0, open: false });
  });

  it('非导航键一律让位（Enter/Space/Tab 都不该被这条逻辑吞掉）', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'ArrowLeft', 'f', 'F7']) {
      expect(rowNavDecision({ ...base, key })).toBeNull();
    }
  });

  it('下拉框 / 多行框里的方向键让位；同一处的 F4/F8 不让（那是面板级命令）', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', inField: true })).toBeNull();
    expect(rowNavDecision({ ...base, key: 'ArrowUp', inField: true })).toBeNull();
    expect(rowNavDecision({ ...base, key: 'F4', inField: true })).toEqual({ index: 1, open: true });
  });

  it('空列表 = 没有可导航的行（count 0 不落到 0 这一行不存在的下标）', () => {
    expect(rowNavDecision({ ...base, key: 'ArrowDown', count: 0 })).toBeNull();
    expect(rowNavDecision({ ...base, key: 'F8', count: 0 })).toBeNull();
  });
});

/* -------------------------- DOM 那层（用桩，不起 jsdom） -------------------------- */

interface StubRow extends PanelRowElement {
  readonly name: string;
  focused: number;
  clicked: number;
  parent?: StubHost | null;
}

class StubHost {
  readonly rows: StubRow[];
  constructor(rows: StubRow[]) {
    this.rows = rows;
  }
  querySelectorAll(selector: string): ArrayLike<PanelRowElement> {
    expect(selector).toBe(`[${PANEL_ROW_ATTR}]`); // 名单只按这一个属性取（改名要同时改这里与行标记）
    return this.rows;
  }
}

function makeRow(name: string, host: () => StubHost, field = false): StubRow {
  const row: StubRow = {
    name,
    focused: 0,
    clicked: 0,
    focus() {
      row.focused++;
    },
    click() {
      row.clicked++;
    },
    closest(selector: string) {
      if (selector === `[${PANEL_ROW_ATTR}]`) return row;
      if (selector === 'select, textarea') return field ? { tag: name } : null;
      return null;
    },
  };
  return row;
}

function event(target: StubRow | null | undefined, key: string, shiftKey = false): RowNavDomEvent & { prevented: number } {
  const e = {
    key,
    shiftKey,
    target,
    prevented: 0,
    preventDefault() {
      e.prevented++;
    },
  };
  return e;
}

describe('applyPanelRowNav：落到行按钮上', () => {
  const mk = (n: number, fieldAt = -1): { host: StubHost; rows: StubRow[] } => {
    const holder: { host?: StubHost } = {};
    const rows = Array.from({ length: n }, (_, i) => makeRow(`r${i}`, () => holder.host!, i === fieldAt));
    holder.host = new StubHost(rows);
    return { host: holder.host, rows };
  };

  it('↓ 把焦点交给下一行，只 focus 不 click', () => {
    const { host, rows } = mk(3);
    const e = event(rows[0], 'ArrowDown');
    expect(applyPanelRowNav(host, e)).toBe(true);
    expect(rows[1]!.focused).toBe(1);
    expect(rows[1]!.clicked).toBe(0);
    expect(e.prevented).toBe(1);
  });

  it('F8 移过去并敲那一枚按钮（打开动作仍住在行自己的 onClick）', () => {
    const { host, rows } = mk(3);
    const e = event(rows[0], 'F8');
    expect(applyPanelRowNav(host, e)).toBe(true);
    expect(rows[1]!.focused).toBe(1);
    expect(rows[1]!.clicked).toBe(1);
  });

  it('焦点不在行上（在检索框里）时 ↓ 进列表第一行', () => {
    const { host, rows } = mk(3);
    const box = makeRow('input', () => host);
    const e = event(box, 'ArrowDown');
    expect(applyPanelRowNav(host, e)).toBe(true);
    expect(rows[0]!.focused).toBe(1);
  });

  it('下拉框里的方向键原样让位（排序框不许被面板抢键）', () => {
    const { host, rows } = mk(3);
    const select = makeRow('select', () => host, true);
    const e = event(select, 'ArrowUp');
    expect(applyPanelRowNav(host, e)).toBe(false);
    expect(rows.map((r) => r.focused).filter((n) => n > 0)).toEqual([]);
    expect(e.prevented).toBe(0);
  });

  it('非导航键与空容器都不消费', () => {
    const { host, rows } = mk(2);
    expect(applyPanelRowNav(host, event(rows[0], 'Enter'))).toBe(false);
    expect(applyPanelRowNav(null, event(rows[0], 'F4'))).toBe(false);
    const empty = new StubHost([]);
    expect(applyPanelRowNav(empty, event(null, 'ArrowDown'))).toBe(false);
  });
});

/* -------------------------- 接线没被悄悄拆掉（源码形态） -------------------------- */

const UI_DIR = fileURLToPath(new URL('../src/ui', import.meta.url));
const UI = (name: string): string => readFileSync(path.join(UI_DIR, name), 'utf8');

describe('两只面板的行导航接线', () => {
  it('检索面板：结果行带行标记，面板根接住键盘', () => {
    const src = UI('SearchPanel.tsx');
    expect(src).toContain(`${PANEL_ROW_ATTR}=""`);
    expect(src).toContain('applyPanelRowNav(resultsRef.current');
  });

  it('问题面板：同一套（F8 那一条腿），行标记 + 键盘接线', () => {
    const src = UI('ProblemPanel.tsx');
    expect(src).toContain(`${PANEL_ROW_ATTR}=""`);
    expect(src).toContain('applyPanelRowNav(listRef.current');
  });
});
