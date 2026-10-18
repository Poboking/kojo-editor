// @vitest-environment happy-dom
/**
 * 状态注入面板的**扫描订阅**回归钉（2026-10-19 实机审计）。
 *
 * 真实故障：面板只在 render 里读一次 `snapshots.current()`，而 `project.opened` 的扫描是
 * 异步的；面板又挂在记忆化容器里（`PanelHost` 的 `PanelBody`），壳层重渲不会带着它重算。
 * ⇒ 面板若先于扫描挂载，`rows` 永远是空数组，阶段永远停在「没有存档」，且没有刷新入口。
 * 作者的观感就是「状态注入一次都没成功过」。
 *
 * 本用例钉两条：
 * ① 挂载时 `current()` 为空 ⇒ 主动补一次 `scan()`（空态自愈，不靠切标签重挂载）；
 * ② 扫描结果经 `subscribe` 到达 ⇒ 面板**真的重渲**到「请选择存档」（订阅接线生效）。
 */
import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  PluginContext,
  ProjectService,
  SnapshotScanResult,
  SnapshotSourceService,
  SnapshotWriteService,
  SlotRegistry,
  UIPanelProps,
} from '@kojo/plugin-api';
import { createInjectorPanel } from '../../plugins/ui-snapshot-injector/src/injector-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_SCAN: SnapshotScanResult = { dir: '/g/sav', entries: [], scannedAt: 0, durationMs: 0 };

const ONE_ENTRY_SCAN: SnapshotScanResult = {
  dir: '/g/sav',
  entries: [
    {
      path: '/g/sav/save00.sav',
      fileName: 'save00.sav',
      size: 1024,
      mtimeMs: 1,
      meta: {
        path: '/g/sav/save00.sav',
        fileName: 'save00.sav',
        size: 1024,
        format: 'gzip',
        version: 1808,
        fileType: 'normal',
        uniqueCode: '0',
        gameVersion: '0',
        saveMes: '第 1 日',
        charCount: 1,
        decompressedSize: 2048,
      },
    },
  ],
  scannedAt: 1,
  durationMs: 1,
};

function makeSource(initial: SnapshotScanResult | null) {
  let current = initial;
  const subs = new Set<(r: SnapshotScanResult | null) => void>();
  const state = { scans: 0 };
  const source = {
    scan: async (): Promise<SnapshotScanResult> => {
      state.scans++;
      current ??= EMPTY_SCAN;
      return current;
    },
    current: (): SnapshotScanResult | null => current,
    parse: async (): Promise<never> => {
      throw new Error('本用例不触深解析');
    },
    subscribe: (cb: (r: SnapshotScanResult | null) => void): (() => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  } as unknown as SnapshotSourceService;
  return {
    source,
    state,
    emit(result: SnapshotScanResult): void {
      current = result;
      for (const cb of subs) cb(result);
    },
  };
}

function makePanel(source: SnapshotSourceService) {
  const ctx = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    bus: { on: () => () => {} },
  } as unknown as PluginContext;
  const project = {
    current: () => ({ adapterId: 'eratw', savDir: '/g/sav', rootDir: '/g' }),
  } as unknown as ProjectService;
  const slots = { query: () => [] } as unknown as SlotRegistry;
  const writer = { inject: async (): Promise<never> => { throw new Error('unused'); } } as unknown as SnapshotWriteService;
  return createInjectorPanel({ ctx, snapshots: source, writer, project, slots });
}

describe('状态注入面板：扫描结果必须订阅（不是一次性读）', () => {
  it('挂载时无扫描结果 → 主动 scan；订阅到达后重渲到「请选择存档」', async () => {
    const { source, state, emit } = makeSource(null);
    const Panel = makePanel(source);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const props = {} as UIPanelProps;

    await act(async () => {
      root.render(createElement(Panel as never, props as never));
    });

    // ① 空态自愈：挂载即补一次 scan（引擎侧幂等）
    expect(state.scans).toBe(1);
    expect(host.textContent).toContain('打开项目并扫描到存档后可用');

    // ② 订阅到达 ⇒ 真实重渲（旧实现停在上面的空态不动）
    await act(async () => {
      emit(ONE_ENTRY_SCAN);
    });
    expect(host.textContent).toContain('请从上方选择要改写的存档');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('已有扫描结果时不再补扫（不制造额外 IO）', async () => {
    const { source, state } = makeSource(ONE_ENTRY_SCAN);
    const Panel = makePanel(source);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(Panel as never, {} as never));
    });

    expect(state.scans).toBe(0);
    expect(host.textContent).toContain('请从上方选择要改写的存档');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
