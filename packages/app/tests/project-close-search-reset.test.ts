// @vitest-environment happy-dom
/**
 * KW-31 的**行为面**判据：检索面一族退出开机图（那条静态边改成动态取）之后，
 * 关项目这一拍**仍然**要把旧检索结果清掉，而且**仍按原序**清。
 *
 * 为什么要有这一格：本批的减法只动一条边的形状（`closeProject` 在拆除序之前
 * `await import('./search-store')` 取到 `resetSearch`）。字节侧由
 * `ps10-eager-graph.test.ts` 的「检索面一族只在懒边之下」钉住；但"摘出去以后还在不在清"
 * 是另一件事——这一格原先**没有任何判据覆盖**（静态时代也没测过），拆完之后不能继续欠着：
 * 少清一次 = 项目关了、旧结果里的路径还留在屏后头，下一次开项目被当成自己的现场（铁律 4）。
 *
 * 两格各管一头：
 * ① **清了**：动态取到的 `resetSearch` 真跑到（经 `subscribe` 观察状态变化，不靠文案）；
 * ② **序没变**：拆除序仍 close → watchStop → 状态复位（含检索）→ recent。
 *   `project-close.ts` 给 `reset` 的契约是**同步执行完毕**；哪天有人把 `await import()`
 *   挪进 `reset` 里面，这一拍就会掉到 `recent` 之后 —— ② 当场红。
 *
 * 装载失败那一支（唯一现场＝项目界面根本没装起来）**不在这里测**：它要 mock 掉模块解析本身，
 * 而本文件静态引着同一枚模块，mock 会把用例的取证面一起打瞎。那一支由两处既有形状负责——
 * `ps10-eager-graph.test.ts` 的「懒而不丢」封口（catch 体里必须有 notify）钉"必须出声"，
 * `project-close.test.ts` 钉"每一步失败都不阻断后一步"。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Kernel } from '@kojo/kernel';
import type { GameProject, RecentProject } from '@kojo/plugin-api';
import { setQuery, snapshot, subscribe } from '../src/ui/search-store';
import { emptySessionRecord } from '../src/ui/session-store';
import {
  useProjectSession,
  type ProjectSession,
  type ProjectSessionHost,
  type RefLike,
} from '../src/ui/use-project-session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DIR = 'C:/Game/eraTW';

interface Harness {
  readonly order: string[];
  readonly notices: { kind: string; message: string }[];
  readonly phases: string[];
  readonly kernel: Kernel;
}

/** 最小假内核：只实现关项目这条路真会碰到的格子（别的格子一概不给，免得测到不存在的行为） */
function makeHarness(): Harness {
  const order: string[] = [];
  const notices: { kind: string; message: string }[] = [];
  const phases: string[] = [];
  const noop = (): void => {};
  const kernel = {
    workspaces: { projectDirs: () => [], list: () => [] },
    bus: { on: () => noop, emit: noop },
    services: { get: () => ({ ensureIndex: async () => null }) },
    storage: { global: () => ({ get: async () => null, set: async () => {} }) },
    io: { isWritable: () => true, exists: async () => true },
    fileWatch: {
      start: noop,
      stop: () => {
        order.push('watchStop');
      },
    },
    project: {
      current: () => null,
      close: async () => {
        order.push('close');
      },
      recent: async (): Promise<RecentProject[]> => {
        order.push('recent');
        return [];
      },
      approvedWritableFor: async () => null,
      approveWritablePaths: async () => {},
    },
  } as unknown as Kernel;
  return { order, notices, phases, kernel };
}

function useRefLike<T>(value: T): RefLike<T> {
  return { current: value };
}

/**
 * 宿主事实逐格按 `ProjectSessionHost` 的类型交（字段名拼错 / 少交一格都由 tsc 当场叫，
 * 不拿 `as never` 蒙过去）。
 */
function makeHost(hs: Harness): ProjectSessionHost {
  return {
    kernel: hs.kernel,
    project: { rootDir: DIR, adapterId: 'eratw', kojoPaths: [], savDir: null } as never,
    workspaceSession: null,
    sessionRoot: DIR,
    dirtyRef: useRefLike<ReadonlySet<string>>(new Set()),
    extraRoots: [],
    notify: (notice) => hs.notices.push({ kind: notice.kind, message: notice.message }),
    cancelPrefetchRef: useRefLike<(() => void) | null>(null),
    requestOpenFileRef: useRefLike<((path: string) => void) | null>(null),
    resetProjectUiState: () => hs.order.push('resetUi'),
    sessionRecordRef: useRefLike(() => {
      throw new Error('本批不读会话记录');
    }) as never,
    pendingRecoverRef: useRefLike(false),
    setPhase: (phase) => hs.phases.push(phase),
    setError: () => {},
    raiseError: (message) => hs.notices.push({ kind: 'error', message }),
    setProject: () => {},
    setWorkspaceSession: () => {},
    setIndex: () => {},
    setIndexing: () => {},
    setIndexError: () => {},
    setWritable: () => {},
    setRecent: () => {},
    setPendingApproval: () => {},
    setPendingProjectSwitch: () => {},
    setEditorGroups: () => {},
    setPinnedPaths: () => {},
    setSplitSizes: () => {},
    setExtraRoots: () => {},
    setReveal: () => {},
    pendingApproval: null,
  };
}

describe('关项目仍清检索态（KW-31：检索面出图以后这一拍不许丢）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  async function mountSession(host: ProjectSessionHost): Promise<ProjectSession> {
    let captured: ProjectSession | null = null;
    function Probe(): null {
      captured = useProjectSession(host);
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(h(Probe));
    });
    if (captured === null) throw new Error('hook 没挂载上');
    return captured;
  }

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    setQuery('');
  });

  it('① 清了：动态取到的 resetSearch 真跑到，检索态回到初始且成功路径不出声', async () => {
    const hs = makeHarness();
    const session = await mountSession(makeHost(hs));
    // 先留一次真实检索态（模块级单源：面板卸载也活得比面板久，正是它需要在关项目时被清）
    setQuery('上一轮的词');
    expect(snapshot().query).toBe('上一轮的词');

    const fired: string[] = [];
    const un = subscribe(() => fired.push('search'));
    await act(async () => {
      await session.closeProject();
    });
    un();

    expect(snapshot().query).toBe('');
    expect(fired).toContain('search');
    expect(hs.phases).toContain('welcome');
    // 成功路径不许有条通知冒充失败
    expect(hs.notices).toEqual([]);
  });

  it('② 序没变：检索清除落在 reset 体内、且在 recent 之前（await 不许挪进 reset）', async () => {
    const hs = makeHarness();
    const session = await mountSession(makeHost(hs));
    setQuery('要清掉的词');

    const un = subscribe(() => hs.order.push('search'));
    await act(async () => {
      await session.closeProject();
    });
    un();

    const resetUi = hs.order.indexOf('resetUi');
    const cleared = hs.order.indexOf('search');
    const recent = hs.order.indexOf('recent');
    expect(hs.order.indexOf('close')).toBeLessThan(cleared);
    expect(hs.order.indexOf('watchStop')).toBeLessThan(cleared);
    expect(resetUi).toBeLessThan(cleared);
    expect(cleared).toBeLessThan(recent);
  });
});
