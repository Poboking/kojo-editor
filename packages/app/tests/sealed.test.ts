/**
 * 封存总闸单测（2026-10-13 试用反馈批；2026-10-14 缩到"只管两只面板"）。
 *
 * 钉死的是"默认封存、可临时恢复、选择被记住"三件事，加上**管辖范围**这一件：
 * 总闸只作用于 `SEALED_PANEL_IDS` 里的面板；`.kojo 预览`（宿主自身的显示功能）
 * 已交付为常态功能，它的可用门不再读 `sealed`（那半边见 `sugar-view.test.ts`）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  SEALED_DEFAULT,
  SEALED_PANEL_IDS,
  filterSealedPanels,
  loadSealed,
  setSealed,
  subscribeSealed,
} from '../src/ui/sealed';

/** 假 localStorage：只是键值袋，够测"记忆"这一件事（与 sugar-view.test.ts 同款） */
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

describe('封存总闸 / 偏好', () => {
  it('无 window（测试环境 / 非浏览器）→ 回默认封存（且不抛）', () => {
    expect(loadSealed()).toBe(SEALED_DEFAULT);
    expect(SEALED_DEFAULT).toBe(true);
    expect(() => setSealed(false)).not.toThrow();
  });

  it('无记录 → 默认封存；写过之后按记录走（1 封存 / 0 显示）', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadSealed()).toBe(true);

    setSealed(false);
    expect(f.bag.get('kojo.ui.sealed.v1')).toBe('0');
    expect(loadSealed()).toBe(false);

    setSealed(true);
    expect(f.bag.get('kojo.ui.sealed.v1')).toBe('1');
    expect(loadSealed()).toBe(true);
  });

  it('坏值（非 0/1，如 abc）→ 回落默认封存（脏偏好不阻塞启动）', () => {
    w.window = fakeWindow({ 'kojo.ui.sealed.v1': 'abc' });
    expect(loadSealed()).toBe(SEALED_DEFAULT);
  });

  it('localStorage 抛错（隐私模式 / 配额满）→ 读回默认、写不抛', () => {
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
    expect(loadSealed()).toBe(SEALED_DEFAULT);
    expect(() => setSealed(false)).not.toThrow();
  });
});

describe('封存总闸 / 订阅', () => {
  it('setSealed 触发监听；取消订阅后不再触发', () => {
    w.window = fakeWindow();
    let hits = 0;
    const un = subscribeSealed(() => hits++);

    setSealed(false);
    expect(hits).toBe(1);

    un();
    setSealed(true);
    expect(hits).toBe(1);
    expect(loadSealed()).toBe(true);
  });
});

describe('封存总闸 / 封存清单', () => {
  it('两个封存面板 id 在册（糖预览 / 归档浏览器）', () => {
    expect(SEALED_PANEL_IDS.has('sugar-preview')).toBe(true);
    expect(SEALED_PANEL_IDS.has('archive-browser')).toBe(true);
  });

  it('清单就是这两只，不多收（.kojo 预览的宿主入口不许被牵连进来）', () => {
    expect([...SEALED_PANEL_IDS].sort()).toEqual(['archive-browser', 'sugar-preview']);
  });
});

/**
 * 封存总闸唯一的管辖面：面板编排（`ShellLayout` 的那句 useMemo 现在只是这一句的包装）。
 * 正面证明"被封存的两只确实消失、其余一只都不动"，反向自证"解封后一只不少"。
 */
describe('封存总闸 / 面板编排', () => {
  const panels = [
    { id: 'kojo.files' },
    { id: 'sugar-preview' },
    { id: 'kojo.problems' },
    { id: 'archive-browser' },
  ];
  const ids = (list: { id: string }[]): string[] => list.map((p) => p.id);

  it('封存态：清单里两只整只滤掉，内建视图一只不动', () => {
    expect(ids(filterSealedPanels(panels, true))).toEqual(['kojo.files', 'kojo.problems']);
  });

  it('解封态：一只不少（反向自证——上面那条通过不是因为恒删）', () => {
    expect(ids(filterSealedPanels(panels, false))).toEqual([
      'kojo.files',
      'sugar-preview',
      'kojo.problems',
      'archive-browser',
    ]);
  });

  it('返回值是新数组，不改写入参（编排 useMemo 的输入来自别处）', () => {
    const input = [{ id: 'sugar-preview' }, { id: 'kojo.files' }];
    filterSealedPanels(input, false);
    expect(input).toHaveLength(2);
    expect(ids(filterSealedPanels(input, true))).toEqual(['kojo.files']);
  });
});
