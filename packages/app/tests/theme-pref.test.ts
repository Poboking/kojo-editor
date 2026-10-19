import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_PREF_DEFAULT,
  applyThemePref,
  loadManualChoice,
  loadThemeChoice,
  loadThemePref,
  normalizeChoice,
  normalizeTheme,
  resolveThemeChoice,
  setFollowSystem,
  setThemeChoice,
  setThemePref,
  subscribeThemePref,
  systemPrefersDark,
} from '../src/ui/theme-pref';

/**
 * 主题偏好单测（2026-10-17 主题系统；2026-10 批扩「跟随系统」）。环境是 node（无 window / document），
 * 用假 localStorage + 假根元素钉死两条与 glass/motion 同款契约：
 * ①读不到/非法/抛错一律回默认 dark、绝不抛；②applyThemePref 只写根元素一个 data-theme 属性。
 *
 * 本批新增钉三件事：
 * ③**向后兼容**——老用户存的 'dark'|'light'|'mint-dark' 在四档模型里逐字照常（抬档前的原断言
 *    一条不改、原样跑绿就是这条的验收面）；④**system 态解析**——生效值按系统深浅在深色/浅色间取，
 *    薄荷永远不来自系统回退；⑤**手选备份与还原**——关闭跟随系统回到最近一次手动档（含薄荷），
 *    备份缺席/脏存储也不抛。系统监听的挂/撤/实时通知走假 matchMedia 全生命周期钉一条。
 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

function stubWindow(storage: Storage | undefined): void {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
}

/** 假 MediaQueryList（'prefers-color-scheme: dark'）：matches 可现场翻，fire 模拟系统档变化 */
function fakeMql(matches: boolean) {
  const handlers = new Set<(ev?: unknown) => void>();
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, handler: (ev?: unknown) => void) => void handlers.add(handler),
    removeEventListener: (_type: string, handler: (ev?: unknown) => void) => void handlers.delete(handler),
    /** 系统深浅变了：逐个调已挂的 change 回调（没挂 ⇒ 空转） */
    fire: () => {
      for (const handler of [...handlers]) handler();
    },
    get count(): number {
      return handlers.size;
    },
  };
}
type FakeMql = ReturnType<typeof fakeMql>;

/** 带 matchMedia 的假 window（系统深浅读数 + 监听挂撤都从这里走） */
function stubWindowWithMedia(storage: Storage, mql: FakeMql): void {
  vi.stubGlobal('window', { localStorage: storage, matchMedia: () => mql });
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeTheme：非法值归一', () => {
  it('三档原样，其余（含 null/未知串）→ dark', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('mint-dark')).toBe('mint-dark');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('solar')).toBe('dark');
    expect(normalizeTheme('')).toBe('dark');
    expect(normalizeTheme(null)).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
  });
});

describe('loadThemePref：缺省与回落', () => {
  it('缺省是 dark（不替用户默认换主题）', () => {
    expect(THEME_PREF_DEFAULT).toBe('dark');
  });

  it('无 window / 无 localStorage / 空存储 → 回 dark，不抛', () => {
    vi.unstubAllGlobals();
    expect(loadThemePref()).toBe('dark');
    stubWindow(undefined);
    expect(loadThemePref()).toBe('dark');
    stubWindow(fakeStorage());
    expect(loadThemePref()).toBe('dark');
  });

  it('存了合法值读到该值；未知值 → dark', () => {
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'light' }));
    expect(loadThemePref()).toBe('light');
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'mint-dark' }));
    expect(loadThemePref()).toBe('mint-dark');
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'weird' }));
    expect(loadThemePref()).toBe('dark');
  });

  it('getItem 抛错（隐私模式）→ 回 dark，不抛', () => {
    stubWindow({
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage);
    expect(loadThemePref()).toBe('dark');
  });
});

describe('setThemePref：写入、归一与往返', () => {
  it('写入后能被 load 读回；非法值先归一再存', () => {
    stubWindow(fakeStorage());
    setThemePref('light');
    expect(loadThemePref()).toBe('light');
    setThemePref('mint-dark');
    expect(loadThemePref()).toBe('mint-dark');
    // 越界值经 set 归一为 dark 落盘（不往存储里塞脏值）
    stubWindow(fakeStorage());
    setThemePref('nope' as never);
    expect(loadThemePref()).toBe('dark');
  });

  it('setItem 抛错 / localStorage 不可用时静默降级，不向上抛', () => {
    stubWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage);
    expect(() => setThemePref('light')).not.toThrow();
    stubWindow(undefined);
    expect(() => setThemePref('light')).not.toThrow();
  });
});

describe('applyThemePref：只写根元素的 data-theme', () => {
  it('在给定根元素上设置 data-theme，且非法值先归一', () => {
    const root = { setAttribute: vi.fn() };
    applyThemePref('light', root);
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    applyThemePref('nope' as never, root);
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'dark');
  });

  it('根元素为 null / node 无 document → 安全跳过，不抛', () => {
    expect(() => applyThemePref('light', null)).not.toThrow();
    expect(typeof document).toBe('undefined');
    expect(() => applyThemePref('light')).not.toThrow();
  });
});

/* ============================ 本批新增：跟随系统 ============================ */

describe('normalizeChoice：四档归一（含 system）', () => {
  it('三档具体与 system 原样；其余（含 null/未知串）→ dark', () => {
    expect(normalizeChoice('dark')).toBe('dark');
    expect(normalizeChoice('light')).toBe('light');
    expect(normalizeChoice('mint-dark')).toBe('mint-dark');
    expect(normalizeChoice('system')).toBe('system');
    expect(normalizeChoice('solar')).toBe('dark');
    expect(normalizeChoice('')).toBe('dark');
    expect(normalizeChoice(null)).toBe('dark');
    expect(normalizeChoice(undefined)).toBe('dark');
  });

  it('【向后兼容】具体档语境（normalizeTheme）里 system 折缺省 dark——生效联合永远不含 system', () => {
    expect(normalizeTheme('system')).toBe('dark');
  });
});

describe('resolveThemeChoice：纯解析', () => {
  it('system 按系统深浅取 dark / light', () => {
    expect(resolveThemeChoice('system', true)).toBe('dark');
    expect(resolveThemeChoice('system', false)).toBe('light');
  });

  it('薄荷不参与系统回退：system 的产出永远不是 mint-dark；具体档原样通过、与系统深浅无关', () => {
    expect(resolveThemeChoice('system', true)).not.toBe('mint-dark');
    expect(resolveThemeChoice('system', false)).not.toBe('mint-dark');
    expect(resolveThemeChoice('mint-dark', true)).toBe('mint-dark');
    expect(resolveThemeChoice('mint-dark', false)).toBe('mint-dark');
    expect(resolveThemeChoice('dark', false)).toBe('dark');
    expect(resolveThemeChoice('light', true)).toBe('light');
  });
});

describe('systemPrefersDark：系统深浅读数', () => {
  it('读不到 matchMedia（node / 无 window）→ 一律按 dark 折（与基础 :root 缺省同向，绝不抛）', () => {
    vi.unstubAllGlobals();
    expect(systemPrefersDark()).toBe(true);
    stubWindow(undefined);
    expect(systemPrefersDark()).toBe(true);
  });

  it('有 matchMedia 时取现场 matches', () => {
    stubWindowWithMedia(fakeStorage(), fakeMql(true));
    expect(systemPrefersDark()).toBe(true);
    stubWindowWithMedia(fakeStorage(), fakeMql(false));
    expect(systemPrefersDark()).toBe(false);
  });
});

describe('落盘读回：system 解析 + 旧值向后兼容', () => {
  it('【向后兼容】老存储值 dark / light / mint-dark 在四档模型里逐字照常（零迁移）', () => {
    for (const stored of ['dark', 'light', 'mint-dark'] as const) {
      // 系统深浅刻意设成与存储值"相反"：具体档生效值不许被系统带跑
      stubWindowWithMedia(fakeStorage({ 'kojo.ui.theme.v1': stored }), fakeMql(stored !== 'light'));
      expect(loadThemeChoice(), stored).toBe(stored);
      expect(loadThemePref(), stored).toBe(stored);
    }
  });

  it('【向后兼容】存储缺席 / 脏值 ⇒ 选择与生效值都仍缺省 dark', () => {
    stubWindow(fakeStorage());
    expect(loadThemeChoice()).toBe('dark');
    expect(loadThemePref()).toBe('dark');
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'weird' }));
    expect(loadThemeChoice()).toBe('dark');
  });

  it('system：选择保留 system，生效档随系统深浅现场解析（翻了 matches 当场翻档）', () => {
    const mql = fakeMql(true);
    stubWindowWithMedia(fakeStorage({ 'kojo.ui.theme.v1': 'system' }), mql);
    expect(loadThemeChoice()).toBe('system');
    expect(loadThemePref()).toBe('dark');
    mql.matches = false;
    expect(loadThemePref()).toBe('light');
  });
});

describe('setThemeChoice / setFollowSystem：落盘、手选备份与还原', () => {
  it('system 原样落主键（不折成具体档——向后兼容的"新增一个 system 态"）', () => {
    stubWindowWithMedia(fakeStorage(), fakeMql(false));
    setThemeChoice('system');
    expect(window.localStorage.getItem('kojo.ui.theme.v1')).toBe('system');
    expect(loadThemeChoice()).toBe('system');
    expect(loadThemePref()).toBe('light');
  });

  it('进 system 时副键还没备份过 ⇒ 用当时生效的具体档补一份（老用户零迁移进来、出去不丢档）', () => {
    stubWindowWithMedia(fakeStorage({ 'kojo.ui.theme.v1': 'light' }), fakeMql(true));
    setThemeChoice('system');
    expect(window.localStorage.getItem('kojo.ui.theme.manual.v1')).toBe('light');
  });

  it('手选备份不被进 system 覆盖；关闭跟随系统还原最近一次手选——含薄荷（显式手选可还原，只是不来自系统回退）', () => {
    stubWindowWithMedia(fakeStorage(), fakeMql(true));
    setThemeChoice('dark'); // 先归一监听单例，再从干净的手选态起步
    setThemeChoice('mint-dark'); // 手选 = 薄荷（主键与备份同写）
    setThemeChoice('system'); // 进 system：已有备份 ⇒ 不许动
    setThemeChoice('system'); // 重复进 system 同样不许覆盖
    expect(window.localStorage.getItem('kojo.ui.theme.manual.v1')).toBe('mint-dark');
    expect(loadThemeChoice()).toBe('system');
    setFollowSystem(false); // 关跟随 ⇒ 还原手选
    expect(loadThemeChoice()).toBe('mint-dark');
    expect(loadThemePref()).toBe('mint-dark');
  });

  it('点具体卡 = 主键与备份同写该档，并退出 system 态', () => {
    stubWindowWithMedia(
      fakeStorage({ 'kojo.ui.theme.v1': 'system', 'kojo.ui.theme.manual.v1': 'light' }),
      fakeMql(false),
    );
    setThemeChoice('dark');
    expect(window.localStorage.getItem('kojo.ui.theme.v1')).toBe('dark');
    expect(window.localStorage.getItem('kojo.ui.theme.manual.v1')).toBe('dark');
    expect(loadThemeChoice()).toBe('dark');
  });

  it('开关联动：开 = 落 system；备份缺席（脏存储）⇒ 关回缺省 dark，绝不抛', () => {
    stubWindowWithMedia(fakeStorage(), fakeMql(true));
    setThemeChoice('dark'); // 归一监听单例
    setFollowSystem(true);
    expect(loadThemeChoice()).toBe('system');
    window.localStorage.removeItem('kojo.ui.theme.manual.v1'); // 模拟副键丢失
    expect(loadManualChoice()).toBe('dark');
    setFollowSystem(false);
    expect(loadThemeChoice()).toBe('dark');
  });
});

describe('applyThemePref：system 态的生效写入', () => {
  it('绝不把 system 字符串写进 data-theme——按系统深浅解析成具体档再落', () => {
    stubWindowWithMedia(fakeStorage({ 'kojo.ui.theme.v1': 'system' }), fakeMql(false));
    const root = { setAttribute: vi.fn() };
    applyThemePref('system', root);
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
  });

  it('缺省读数 = 存储选择经系统解析（壳层 effect 传的是已解析具体档，这里钉缺省路径）', () => {
    stubWindowWithMedia(fakeStorage({ 'kojo.ui.theme.v1': 'system' }), fakeMql(true));
    const root = { setAttribute: vi.fn() };
    applyThemePref(undefined, root);
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
  });
});

describe('跟随系统实时切换：监听挂 / 撤 / 变化通知（假 matchMedia 全生命周期）', () => {
  it('非 system 不挂监听；进 system 挂上；系统翻档 ⇒ 订阅者收到通知且生效档当场翻；出 system 撤干净', () => {
    const mql = fakeMql(true);
    stubWindowWithMedia(fakeStorage({ 'kojo.ui.theme.v1': 'dark' }), mql);
    // 先按存储走一遍归一：module 级监听单例可能带着前一个用例的状态进来，setThemeChoice 会自愈撤掉
    setThemeChoice('dark');
    const heard = vi.fn();
    const off = subscribeThemePref(heard);
    expect(mql.count).toBe(0); // dark 态：不该挂在系统监听上

    setThemeChoice('system'); // 进 system：挂监听 + 通知订阅者
    expect(mql.count).toBe(1);
    expect(heard).toHaveBeenCalled();

    mql.matches = false; // 系统切浅色
    heard.mockClear();
    mql.fire();
    expect(heard).toHaveBeenCalled(); // useThemePref 快照随之翻转 ⇒ 壳层/Monaco 零改动跟上
    expect(loadThemePref()).toBe('light');

    setThemeChoice('light'); // 出 system：撤监听
    expect(mql.count).toBe(0);
    heard.mockClear();
    mql.fire();
    expect(heard).not.toHaveBeenCalled(); // 手选态不再被系统变化打扰
    off();
  });
});
