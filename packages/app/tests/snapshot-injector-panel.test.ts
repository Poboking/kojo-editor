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
    // 口上调试 UI 打磨批：面板会把自己"上次改的那一档"落进本插件存储域
    // （切走再切回不必重选），桩补上最小域，别让缺件把 effect 打崩。
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      keys: async () => [],
    },
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
    // ② 自愈扫描回来后，空态说清**真实成因**（扫到了目录、零个可解析存档），
    //    而不是旧文案「打开项目并扫描到存档后可用（存档列表来自「归档浏览器」面板）」
    //    ——那个面板已封存，照做只会更困惑（W-1 空态细分）。
    expect(host.textContent).toContain('没有找到可解析的存档文件');

    // ③ 订阅到达（扫到档）⇒ 重渲成「请从上方选择要改写的存档」（旧实现停在第一步不动）
    await act(async () => {
      emit(ONE_ENTRY_SCAN);
    });
    expect(host.textContent).toContain('请从上方选择要改写的存档');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('「重新扫描」可点：再扫一次且不并发（引擎 inFlight 去重）', async () => {
    const { source, state } = makeSource(EMPTY_SCAN);
    const Panel = makePanel(source);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(Panel as never, {} as never));
    });
    expect(state.scans).toBe(0);

    const btn = host.querySelector('.inj-rescan') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    expect(state.scans).toBe(1);

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

/**
 * 「常用」卡端到端钉（quickEditFields 批）：零基础作者的完整路径——
 * 选档 → 卡上「好感度 350」直接填 600 → 待写入清单用人话（#0 灵梦）确认。
 * 族头 / 下标 / 作用域全程不出现；变量目录的中文搜索顺带钉一条。
 */
describe('状态注入面板：常用卡与中文搜索', () => {
  const ARCHIVE = {
    path: '/g/sav/save00.sav',
    fileName: 'save00.sav',
    size: 1,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '1',
    gameVersion: '0',
    saveMes: '第 1 日',
    charCount: 1,
    decompressedSize: 1,
    bodySize: 1,
    consumed: 1,
    remaining: 0,
    chars: [
      {
        index: 0,
        dimSepIndex: null,
        vars: [
          { type: 'int', key: 'NO', value: 0, offset: 0 },
          { type: 'str', key: 'CALLNAME', value: '灵梦', offset: 0 },
          {
            type: 'int-array-1d',
            key: 'CFLAG',
            saveLen: [10],
            cursor: [10],
            nonEmpty: 1,
            cells: [{ index: [2], value: 350 }],
            offset: 0,
          },
        ],
      },
    ],
    vars: [
      {
        type: 'int-array-1d',
        key: 'MONEY',
        saveLen: [2],
        cursor: [2],
        nonEmpty: 1,
        cells: [{ index: [0], value: 1200 }],
        offset: 0,
      },
    ],
    emVars: [],
  };

  /** 变量词典：CFLAG:2 = 好感度（运行时显示名优先词典）；家族级 CFLAG = 角色标志 */
  const SCHEMA = {
    version: '1',
    inputDigest: 'x',
    lookup: (name: string, index?: number | string) => {
      if (name === 'CFLAG' && index === 2) return { name, index, description: '好感度' };
      if (name === 'CFLAG') return { name, description: '角色标志' };
      return { name };
    },
    names: () => [],
  };

  const QUICK_FIELDS = [
    { id: 'aff', label: '好感度', family: 'CFLAG', index: 2, scope: 'chara' },
    { id: 'money', label: '所持金', family: 'MONEY', index: 0, scope: 'global' },
  ];

  function makeSourceWithParse() {
    const base = makeSource(ONE_ENTRY_SCAN);
    const source = {
      ...base.source,
      parse: async () => ARCHIVE,
    } as unknown as SnapshotSourceService;
    return { ...base, source };
  }

  function makePanelWithAdapter(source: SnapshotSourceService) {
    const ctx = {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      bus: { on: () => () => {} },
      // 同上：面板会读/写自己的"上次改的那一档"
      storage: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        keys: async () => [],
      },
    } as unknown as PluginContext;
    const project = {
      current: () => ({ adapterId: 'eratw', savDir: '/g/sav', rootDir: '/g' }),
    } as unknown as ProjectService;
    const slots = {
      query: () => [{ adapter: { gameId: 'eratw', quickEditFields: QUICK_FIELDS, variableSchema: SCHEMA } }],
    } as unknown as SlotRegistry;
    const writer = { inject: async (): Promise<never> => { throw new Error('unused'); } } as unknown as SnapshotWriteService;
    return createInjectorPanel({ ctx, snapshots: source, writer, project, slots });
  }

  /**
   * React 的 select / input onChange 在 happy-dom 下经原生事件触发。两道门槛：
   * ① 必须走 **原生 value setter**（React 的 value tracker 挂在实例属性上，直接
   *    `el.value =` 不算“变了”，onChange 会被去重吞掉）；② 事件必须 bubbles。
   */
  function changeValue(el: HTMLSelectElement | HTMLInputElement, value: string): void {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('选档 → 常用卡按词典名显示当前值 → 填新值入清单 → 清单位置是人话', async () => {
    const { source } = makeSourceWithParse();
    const Panel = makePanelWithAdapter(source);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(Panel as never, {} as never));
    });

    // 选档（自绘组合框：点开字段行 → 点唯一真档位；2026-11-07 档位下拉批换 KitCombobox，
    // 原生 select 的 change 事件路径不复存在）→ 深解析回包 → 常用卡就位
    const field = host.querySelector('.inj-toolbar .kit-combobox-field') as HTMLButtonElement;
    await act(async () => {
      field.click();
    });
    const opt = [...host.querySelectorAll('.kit-combobox-opt')].find((o) =>
      o.textContent?.includes('save00.sav'),
    ) as HTMLButtonElement;
    await act(async () => {
      opt.click();
    });
    await act(async () => {});

    // 默认作用域 = 第一个角色块：角色项在卡上，全局项（所持金）不在此刻出现
    const card = host.querySelector('.inj-quick');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('常用 · #0 灵梦');
    expect(card!.textContent).toContain('好感度');
    expect(card!.textContent).toContain('350');
    expect(card!.textContent).not.toContain('所持金');

    // 填 600 → 入清单 → 待写入行：位置白话（#0 灵梦.CFLAG[2]）+ 改前/改后
    const input = host.querySelector('.inj-quick-row input') as HTMLInputElement;
    await act(async () => {
      changeValue(input, '600');
    });
    const addBtn = host.querySelector('.inj-quick-row button') as HTMLButtonElement;
    expect((addBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      addBtn.click();
    });

    const diffRow = host.querySelector('.inj-diff-row');
    expect(diffRow).not.toBeNull();
    expect(diffRow!.textContent).toContain('#0 灵梦.CFLAG[2]');
    expect(diffRow!.textContent).toContain('好感度');
    expect(diffRow!.textContent).toContain('350');
    expect(diffRow!.textContent).toContain('600');

    // 中文搜索（此时还在角色块作用域）：搜「角色标志」命中 CFLAG——旧过滤只按键名，
    // 这条永远搜空；且搜索框 2026-11-02 前根本没渲染（varFilter 是死状态）
    const filterInput = host.querySelector('.inj-var-filter') as HTMLInputElement;
    expect(filterInput).not.toBeNull();
    await act(async () => {
      changeValue(filterInput, '角色标志');
    });
    const rows = [...host.querySelectorAll('.inj-var-row')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textContent!.includes('CFLAG'))).toBe(true);

    // 清掉过滤再换主变量区：全局项（所持金 1200）顶替角色项
    await act(async () => {
      changeValue(filterInput, '');
    });
    // 换主变量区（自绘组合框：点开字段行 → 点「主变量区」；2026-11-07 作用域同迁 KitCombobox）
    const scopeField = host.querySelector('.inj-left .kit-combobox-field') as HTMLButtonElement;
    await act(async () => {
      scopeField.click();
    });
    const scopeOpt = [...host.querySelectorAll('.inj-left .kit-combobox-opt')].find((o) =>
      o.textContent?.includes('主变量区'),
    ) as HTMLButtonElement;
    await act(async () => {
      scopeOpt.click();
    });
    expect(host.querySelector('.inj-quick')!.textContent).toContain('所持金');
    expect(host.querySelector('.inj-quick')!.textContent).toContain('1200');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
