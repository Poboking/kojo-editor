/**
 * 标签左侧语义色轨（KW16 标签色轨批 · 第二步，2026-11-02）。
 *
 * 钉两层：
 *  ① `tabRailsOf` 那侧的档位表——它经实例登记簿现扫解锁集合与派生面（真源仍是各 `EditorPane`
 *     自己的 ref），所以这里用假 pane 走同一条读路，不在测试里另拼一份判定；
 *  ② `TabBar` / `TabRow` 的落屏形状——各档各落哪一枚 class（含 KW-16B2 的 `untitled` 一档）、
 *     只读未解锁**不许**带语义 class，
 *     以及固定针 / 标签 / 脏点 / 关闭钮的**顺序一位不动**（色轨是绝对定位伪元素，不进布局）。
 *
 * 形态照 `tabs-bar.test.ts` / `tab-chip.test.ts` 的 SSR 形状锁先例（真组件 + renderToStaticMarkup，
 * 事件不进 HTML ⇒ 只钉结构与文案）。
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TabBar } from '../src/ui/tabs-bar';
import { registerPane, unregisterPane, type PaneRefs } from '../src/ui/editor-pane-registry';
import { tabRailsOf, RAIL_CLASS, type EditorRailGrade } from '../src/ui/editor-editability';
import { WRITABLE_HINTS } from '../src/ui/file-area';
// 未落盘草稿的标签键前缀（单源在 `tabs-ops`，本判据不另抄一份）
import { UNTITLED_PREFIX } from '../src/ui/tabs-ops';

const WORKSPACE = 'D:/works/口上';
const GAME = 'C:/games/eratw';
const AUTHOR_FILE = `${WORKSPACE}/新作.ERB`;
const GAME_LOCKED = `${GAME}/script/借阅.ERB`;
const GAME_UNLOCKED = `${GAME}/script/破例.ERB`;
const GAME_PREVIEW = `${GAME}/script/投影.ERB`;
const GAME_DIRECT = `${GAME}/script/直连.ERB`;
/** 未落盘草稿（KW-16B2）：这一枚**不是路径**，所以不进 `ALL_PATHS`（那五枚都是盘上件，
 *  「四态读数一次看全」那条断言的读数口径不许被一枚非路径键混进去） */
const DRAFT = `${UNTITLED_PREFIX}1`;

const ALL_PATHS = [AUTHOR_FILE, GAME_LOCKED, GAME_UNLOCKED, GAME_PREVIEW, GAME_DIRECT];

/** 判据只认这两把工具（类型从被测函数签名上取，不手抄结构） */
type RailKernel = Parameters<typeof tabRailsOf>[0];

/** 假 kernel（`workspaces.projectDirs()` + `io.isWritable`） */
function fakeKernel(writable: readonly string[] = []): RailKernel {
  const kernel = {
    workspaces: { projectDirs: () => [WORKSPACE] },
    io: { isWritable: (p: string) => writable.includes(p) },
  };
  return kernel as unknown as RailKernel;
}

/** 假 pane 档案：只填色轨要读的那几位（同一批 ref 壳的形态，与 `registerPane` 收的一致） */
function mountPane(over: { path: string; unlocked?: readonly string[]; preview?: boolean }): string {
  const refs = {
    editorRef: { current: null },
    entriesRef: { current: new Map() },
    filePathRef: { current: over.path },
    sugarModelRef: { current: over.preview ? ({ isDisposed: () => false } as never) : null },
    sugarLineMapRef: { current: [] as readonly number[] },
    pendingActionsRef: { current: new Map() },
    actionSeqRef: { current: 0 },
    crumbTreeCacheRef: { current: null },
    unlockedPathsRef: { current: new Set(over.unlocked ?? []) },
  };
  return registerPane(refs as unknown as PaneRefs);
}

/** 开门跑一段（直连模式经假 localStorage；离开即擦干净，口径同 direct-mode.test.ts） */
function withDirectMode(on: boolean, run: () => void): void {
  const bag = new Map<string, string>([['kojo.ui.directMode.v1', on ? '1' : '0']]);
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
    },
  };
  try {
    run();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

/* ---------------- ① 档位表（经登记簿现扫，判据仍只有一处） ---------------- */

describe('tabRailsOf · 四态各落哪一档', () => {
  it('作者作品区 = 主色档；游戏目录未解锁**不在表里**（不给语义色）', () => {
    const rails = tabRailsOf(fakeKernel(), ALL_PATHS);
    expect(rails.get(AUTHOR_FILE)?.grade).toBe('author');
    expect(rails.get(AUTHOR_FILE)?.railClass).toBe(RAIL_CLASS.author);
    expect(rails.has(GAME_LOCKED), '只读未解锁不该有色轨：没有额外颜色就是"没有特权"的信号').toBe(false);
  });

  it('本会话已解锁（真源 = 某实例的 unlockedPathsRef）= 警示档', () => {
    const id = mountPane({ path: GAME_UNLOCKED, unlocked: [GAME_UNLOCKED] });
    try {
      const rails = tabRailsOf(fakeKernel(), ALL_PATHS);
      expect(rails.get(GAME_UNLOCKED)?.grade).toBe('unlocked');
      expect(rails.get(GAME_UNLOCKED)?.railClass).toBe(RAIL_CLASS.unlocked);
      // 警示那句要把"你在改游戏库里的东西"说出口，并且带上线下那枚胶囊的原句（同一口径）
      expect(rails.get(GAME_UNLOCKED)?.hint).toContain(WRITABLE_HINTS.gameErb);
      expect(rails.get(GAME_UNLOCKED)?.hint).toContain('本会话已为这一份破例解锁');
    } finally {
      unregisterPane(id);
    }
  });

  it('作者档优先于警示档：工作区文件即使被误登记进解锁集合也不翻成琥珀', () => {
    const id = mountPane({ path: AUTHOR_FILE, unlocked: [AUTHOR_FILE] });
    try {
      expect(tabRailsOf(fakeKernel(), [AUTHOR_FILE]).get(AUTHOR_FILE)?.grade).toBe('author');
    } finally {
      unregisterPane(id);
    }
  });

  it('.kojo 预览挂派生 model 的那一格 = 中性档，且说明里点破"不是盘上那一份"', () => {
    const id = mountPane({ path: GAME_PREVIEW, preview: true });
    try {
      const rail = tabRailsOf(fakeKernel(), [GAME_PREVIEW]).get(GAME_PREVIEW);
      expect(rail?.grade).toBe('derived');
      expect(rail?.railClass).toBe(RAIL_CLASS.derived);
      expect(rail?.hint).toContain('派生只读面');
      expect(rail?.hint).toContain('不是盘上那一份');
    } finally {
      unregisterPane(id);
    }
  });

  it('直连开门 + 写允许域放行 = 同一档警示；没放行就还是无色（直连不扩权）', () => {
    withDirectMode(true, () => {
      const rails = tabRailsOf(fakeKernel([GAME_DIRECT]), [GAME_DIRECT]);
      expect(rails.get(GAME_DIRECT)?.grade).toBe('unlocked');
    });
    withDirectMode(true, () => {
      expect(tabRailsOf(fakeKernel([]), [GAME_DIRECT]).has(GAME_DIRECT)).toBe(false);
    });
    withDirectMode(false, () => {
      expect(tabRailsOf(fakeKernel([GAME_DIRECT]), [GAME_DIRECT]).has(GAME_DIRECT)).toBe(false);
    });
  });

  it('未落盘草稿 = 第四档给色（不给色就等于和只读件同一张脸，那一档才是沉默的）', () => {
    const rails = tabRailsOf(fakeKernel(), [...ALL_PATHS, DRAFT]);
    const rail = rails.get(DRAFT);
    expect(rail?.grade).toBe('untitled');
    expect(rail?.railClass).toBe(RAIL_CLASS.untitled);
    expect(rail?.hint).toContain('未落盘草稿');
    expect(rail?.hint).toContain('写允许域');
    // 同一张表里盘上件的判定一位没让：只读未解锁照旧无轨（草稿那一档不替任何真实路径说话）
    expect(rails.has(GAME_LOCKED)).toBe(false);
  });

  it('表里只收有轨的路径（四态读数一次看全：3 枚有轨 / 1 枚无轨）', () => {
    const id = mountPane({ path: GAME_UNLOCKED, unlocked: [GAME_UNLOCKED] });
    const id2 = mountPane({ path: GAME_PREVIEW, preview: true });
    try {
      const rails = tabRailsOf(fakeKernel([GAME_DIRECT]), ALL_PATHS);
      const grades = ALL_PATHS.map((p) => rails.get(p)?.grade ?? null);
      expect(grades).toEqual(['author', null, 'unlocked', 'derived', null]);
    } finally {
      unregisterPane(id);
      unregisterPane(id2);
    }
  });
});

/* ---------------- ② 落屏形状（真组件 SSR） ---------------- */

const base = {
  openTabs: ALL_PATHS,
  activeFile: GAME_LOCKED as string | null,
  dirtyPaths: new Set<string>(),
  pinnedPaths: new Set<string>(),
  onActivateTab: () => {},
  onRequestCloseTab: () => {},
  onReorderTab: () => {},
  onTogglePin: () => {},
  onBatchCloseTab: () => {},
  onSaveAllClick: () => {},
  hasDirty: false,
};

const render = (props: Partial<typeof base> & { rails?: ReadonlyMap<string, { grade: EditorRailGrade; hint: string; railClass: string }> } = {}): string =>
  renderToStaticMarkup(h(TabBar, { ...base, ...props }));

/** 取某枚标签那一段 HTML：从本行的 `<div role="tab"` 到下一枚标签开头（末枚吃到条尾） */
function tabSlice(html: string, path: string): string {
  const at = html.indexOf(`data-tab-path="${path}"`);
  expect(at, `标签 ${path} 没上屏`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div role="tab"', at);
  const next = html.indexOf('<div role="tab"', at);
  return html.slice(start, next === -1 ? html.length : next);
}

describe('TabRow · 色轨的落屏形状', () => {
  const railsOf = (): ReadonlyMap<string, { grade: EditorRailGrade; hint: string; railClass: string }> => {
    const rails = new Map<string, { grade: EditorRailGrade; hint: string; railClass: string }>([
      [AUTHOR_FILE, { grade: 'author', hint: '作者区说明', railClass: RAIL_CLASS.author }],
      [GAME_UNLOCKED, { grade: 'unlocked', hint: '已解锁说明', railClass: RAIL_CLASS.unlocked }],
      [GAME_PREVIEW, { grade: 'derived', hint: '派生面说明', railClass: RAIL_CLASS.derived }],
    ]);
    return rails;
  };

  it('四种输入各落哪一档 class；未解锁的只读标签一枚语义 class 都没有', () => {
    const html = render({ rails: railsOf() });
    expect(html).toContain('rail-author');
    expect(html).toContain('rail-unlocked');
    expect(html).toContain('rail-derived');
    expect(tabSlice(html, GAME_LOCKED)).not.toMatch(/rail-(author|unlocked|derived|untitled)/);
    // 三档彼此不串门
    expect(tabSlice(html, AUTHOR_FILE)).not.toContain('rail-unlocked');
    expect(tabSlice(html, GAME_UNLOCKED)).not.toContain('rail-author');
  });

  it('不传 rails（缺省）⇒ 与改动前逐字同形：一枚语义 class 都不挂、title 就是路径', () => {
    const html = render();
    expect(html).not.toMatch(/rail-(author|unlocked|derived|untitled)/);
    expect(html).toContain(`title="${GAME_LOCKED}"`);
    expect(html).toContain('data-tab-rail="none"');
  });

  it('悬停说明挂在 title 上（不加新浮层）：路径在前、色轨那句在后', () => {
    const html = render({ rails: railsOf() });
    expect(tabSlice(html, AUTHOR_FILE)).toContain(`title="${AUTHOR_FILE} · 作者区说明"`);
    expect(tabSlice(html, GAME_UNLOCKED)).toContain(`title="${GAME_UNLOCKED} · 已解锁说明"`);
  });

  it('色轨不与固定针 / 脏点 / 关闭钮抢位置：三枚子件的顺序一位不动（固定针仍在最前）', () => {
    const html = render({
      rails: railsOf(),
      pinnedPaths: new Set([AUTHOR_FILE]),
      dirtyPaths: new Set([AUTHOR_FILE, GAME_LOCKED]),
    });
    // 固定 + 脏 + 色轨同框：pin → label → dirty（固定标签按既有语义**不渲染**关闭钮 = 防误关）
    const pinnedSlice = tabSlice(html, AUTHOR_FILE);
    const pinnedOrder = ['tab-pin', 'tab-label', 'tab-dirty'].map((name) => pinnedSlice.indexOf(name));
    expect(pinnedOrder.every((i) => i >= 0), `三枚都在：${JSON.stringify(pinnedOrder)}`).toBe(true);
    expect(pinnedOrder).toEqual([...pinnedOrder].sort((a, b) => a - b));
    expect(pinnedSlice, '固定标签不画关闭钮（改动前既有语义）').not.toContain('tab-close');
    // 非固定的脏标签：label → dirty → close 一位不动
    const slice = tabSlice(html, GAME_LOCKED);
    const order = ['tab-label', 'tab-dirty', 'tab-close'].map((name) => slice.indexOf(name));
    expect(order.every((i) => i >= 0), `三枚都在：${JSON.stringify(order)}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 固定 + 色轨同框时类名并存（active / pinned / preview / 落点 / 色轨五态可叠加）
    expect(pinnedSlice).toContain('editor-tab pinned rail-author');
    expect(pinnedSlice).toContain('（已固定） · 作者区说明');
    // 无轨的只读标签：子件一个不少、语义 class 一个不多
    expect(slice).not.toMatch(/rail-(author|unlocked|derived|untitled)/);
  });

  it('未落盘草稿上屏：既有那一族 class（`rail-untitled`）+ `tabName` 那把尺子的中文名', () => {
    const rails = new Map(railsOf());
    rails.set(DRAFT, { grade: 'untitled', hint: '未落盘草稿说明', railClass: RAIL_CLASS.untitled });
    const html = render({ openTabs: [...ALL_PATHS, DRAFT], rails });
    const slice = tabSlice(html, DRAFT);
    expect(slice).toContain('rail-untitled');
    // 标签正文走 `tab-row.tsx` 的 `tabName` 单源 ⇒ 「未命名草稿 1」，不是一个像 bug 的 `untitled:1`
    const label = /class="tab-label">([^<]*)</.exec(slice)?.[1] ?? '';
    expect(label).toBe('未命名草稿 1');
    // 别一格一位不动：盘上件不会因为这枚新标签的出现而改档
    expect(tabSlice(html, AUTHOR_FILE)).toContain('rail-author');
  });

  it('活动标签顶部指示条与左缘色轨不同槽位：`.active` 与 `rail-*` 可以同框', () => {
    const html = render({ rails: railsOf(), activeFile: GAME_PREVIEW });
    expect(tabSlice(html, GAME_PREVIEW)).toContain('editor-tab active rail-derived');
  });
});
