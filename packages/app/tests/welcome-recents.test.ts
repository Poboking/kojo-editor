// @vitest-environment happy-dom
/**
 * 欢迎页「最近文件」区（MM-7）的渲染用例：空态 / 列表 / missing 标记 / 点击回调参数。
 * 探测（statPath）与探测键的纯函数半边也钉在这里（同文件同口径）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileStat, RecentProject } from '@kojo/plugin-api';
import {
  recentRowState,
  recentStatKey,
  removeRecentOptimistic,
  recentFileStatKey,
  WelcomeView,
} from '../src/ui/WelcomeView';
import type { RecentFileRecord } from '../src/ui/recent-files';
import type { AppPhase } from '../src/ui/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 欢迎页最近列表管理（A4 UI 批 + MM-7 最近文件批）的纯函数半边：
 * 「recents + stat 结果 → 行渲染态」、探测缓存键、乐观移除；
 * 「最近文件」区另有渲染用例（happy-dom，见本文件尾部）。
 */

const entry = (rootDir: string, lastOpenedAt = 1000, adapterId = 'eratw'): RecentProject => ({
  rootDir,
  adapterId,
  lastOpenedAt,
});

describe('recentRowState：stat 结果 → 行渲染态（三态，不许吞成两态）', () => {
  it('undefined = 尚未探测 / 探测不可用 → unknown（行内不标记）', () => {
    expect(recentRowState(undefined)).toBe('unknown');
  });

  it('null = 目录不存在 → missing（灰态标记的依据）', () => {
    expect(recentRowState(null)).toBe('missing');
  });

  it('拿到 FileStat = 目录还在 → ok', () => {
    expect(recentRowState({} as FileStat)).toBe('ok');
  });
});

describe('recentStatKey：pathKey + lastOpenedAt 的探测缓存键', () => {
  it('同一路径两种写法（大小写 / 分隔符）折成同一个键——不重复探测', () => {
    expect(recentStatKey(entry('C:\\Game\\eraTW'))).toBe(recentStatKey(entry('c:/game/eratw')));
  });

  it('重开过 ⇒ lastOpenedAt 变 ⇒ 键变 ⇒ 重扫（旧探测结果不钉死新状态）', () => {
    expect(recentStatKey(entry('C:\\Game', 1))).not.toBe(recentStatKey(entry('C:\\Game', 2)));
  });
});

describe('removeRecentOptimistic：乐观移除（与内核 removeRecent 同判等口径）', () => {
  it('按 pathKey 摘条目：大小写 / 分隔符差异不漏删', () => {
    const list = [entry('C:\\Game\\eraTW', 3, 'a'), entry('D:\\其他', 2, 'b')];
    expect(removeRecentOptimistic(list, 'c:/game/eratw')).toEqual([entry('D:\\其他', 2, 'b')]);
  });

  it('其余条目顺序与内容逐字保留', () => {
    const list = [entry('C:\\A', 3), entry('C:\\B', 2), entry('C:\\C', 1)];
    expect(removeRecentOptimistic(list, 'C:\\B')).toEqual([entry('C:\\A', 3), entry('C:\\C', 1)]);
  });

  it('未命中 = 原样返回（内核幂等 no-op 的 UI 侧对齐）', () => {
    const list = [entry('C:\\A', 3)];
    expect(removeRecentOptimistic(list, 'C:\\不存在')).toEqual(list);
  });
});

describe('recentFileStatKey：最近文件的探测缓存键（MM-7，同款口径）', () => {
  const file = (path: string, rootDir: string, openedAt: number): RecentFileRecord => ({ path, rootDir, openedAt });

  it('同一路径两种写法（大小写 / 分隔符）折成同一个键——不重复探测', () => {
    expect(recentFileStatKey(file('C:\\Game\\a.ERB', 'C:/p', 1))).toBe(recentFileStatKey(file('c:/game/a.erb', 'C:/p', 1)));
  });

  it('重开过 ⇒ openedAt 变 ⇒ 键变 ⇒ 重扫（旧探测结果不钉死新状态）', () => {
    expect(recentFileStatKey(file('C:/a.ERB', 'C:/p', 1))).not.toBe(recentFileStatKey(file('C:/a.ERB', 'C:/p', 2)));
  });
});

/* ---------------------------- 最近文件区渲染（MM-7） ---------------------------- */

const fileRec = (path: string, rootDir: string, openedAt = 1000): RecentFileRecord => ({ path, rootDir, openedAt });

const baseProps = {
  phase: 'welcome' as AppPhase,
  error: null,
  recent: [] as RecentProject[],
  tauri: false,
  kernelReady: true,
  onOpenDirectory: () => {},
  onOpenRecent: () => {},
  onRemoveRecent: () => {},
  onClearRecent: () => {},
  recentFiles: [] as readonly RecentFileRecord[],
  onOpenRecentFile: () => {},
  statPath: (): Promise<FileStat | null> => Promise.resolve(null),
  resumeRoot: null,
  onResumeSession: () => {},
  crashRecovery: null,
  onRecoverCrash: () => {},
  onDiscardCrash: () => {},
  closed: false,
  onClose: () => {},
  onReopen: () => {},
  onOpenTutorial: () => {},
};

describe('WelcomeView · 最近文件区（MM-7 渲染）', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  async function mount(props: Partial<typeof baseProps> = {}): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root.render(h(WelcomeView, { ...baseProps, ...props }));
    });
    // 探测是 Promise.all 异步落定：再空转一拍让 statCache 写回去
    await act(async () => {});
  }

  it('空态：还没有最近文件——打开过的文件会出现在这里', async () => {
    await mount({ recentFiles: [] });
    const empty = container.querySelector('.welcome-recent-files .welcome-empty');
    expect(empty?.textContent).toBe('还没有最近文件——打开过的文件会出现在这里。');
    expect(container.querySelector('.welcome-recent-files .welcome-recent-list')).toBeNull();
  });

  it('列表：文件名 + 完整路径（dim 小字）+ 所属项目根徽标', async () => {
    await mount({
      statPath: () => Promise.resolve({} as FileStat),
      recentFiles: [
        fileRec('C:\\Game\\eraTW\\KOJO\\a.ERB', 'C:\\Game\\eraTW', 2000),
        fileRec('D:/其他/b.ERB', 'D:/其他', 1000),
      ],
    });
    const rows = container.querySelectorAll('.welcome-recent-files .welcome-recent-row');
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.querySelector('.welcome-recent-path')?.textContent).toBe('a.ERB');
    expect(first.querySelector('.welcome-recent-sub')?.textContent).toBe('C:\\Game\\eraTW\\KOJO\\a.ERB');
    const badges = first.querySelectorAll('.welcome-recent-badge');
    expect(badges).toHaveLength(1); // stat 正常 ⇒ 无 missing 徽标，只剩项目徽标
    expect(badges[0]?.textContent).toBe('eraTW');
    expect(badges[0]?.getAttribute('title')).toBe('C:\\Game\\eraTW'); // 徽标末段 + title 补全根
  });

  it('missing：stat 为 null ⇒ 行内灰标「文件不存在」，仍可点', async () => {
    await mount({
      statPath: () => Promise.resolve(null), // 文件不在盘上
      recentFiles: [fileRec('C:/gone/a.ERB', 'C:/proj', 1000)],
    });
    const row = container.querySelector('.welcome-recent-files .welcome-recent-row');
    expect(row?.classList.contains('is-missing')).toBe(true);
    const badges = row!.querySelectorAll('.welcome-recent-badge');
    expect(badges[0]?.textContent).toBe('文件不存在');
    expect(badges[0]?.classList.contains('is-missing')).toBe(true);
    const open = row!.querySelector('.welcome-recent-open') as HTMLElement;
    expect(open.getAttribute('title')).toContain('文件不存在，点击重试打开');
  });

  it('点击回调参数：整行按钮把 (path, rootDir) 原样交给 App', async () => {
    const onOpenRecentFile = vi.fn();
    await mount({
      statPath: () => Promise.resolve({} as FileStat),
      recentFiles: [fileRec('C:/proj/a.ERB', 'C:/proj', 1000)],
      onOpenRecentFile,
    });
    const open = container.querySelector('.welcome-recent-files .welcome-recent-open') as HTMLElement;
    expect(open.getAttribute('title')).toContain('（属于项目 C:/proj）');
    await act(async () => {
      open.click();
    });
    expect(onOpenRecentFile).toHaveBeenCalledTimes(1);
    expect(onOpenRecentFile).toHaveBeenCalledWith('C:/proj/a.ERB', 'C:/proj');
  });
});
