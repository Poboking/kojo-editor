// @vitest-environment happy-dom
/**
 * 归档浏览器面板的行键盘（kw8b 1102 行键盘批 · 四只懒边面板之二）。
 *
 * 判据是**行为级**（真挂载、真派发 KeyboardEvent、看焦点落在哪一行），照
 * `panel-row-nav-convention-report.test.ts` 的接线范式：
 * - ↑↓ 只在画出来的档位之间移焦点（边界回绕），一条 `kojo.snapshotSelected` 都不发；
 * - F8 移过去并**当场敲那一枚档位钮**——展开走行的既有 `onClick`（`toggle` = 展开角色区摘要
 *   + 广播选中），Shift 反向，不留第二条揭示通路；
 * - 没画出来的东西不在名单：档位的展开体（两个「取出」按钮 + 角色摘要）不是行；
 *   扫描失败态整列表缺席 ⇒ 名单为空、一个键都不吞；
 * - 输入法合成期一律放行；Enter/Tab/Escape/← 不吞；
 * - roving tabindex：整段名单只留一枚 0。
 *
 * 本面板没有 `select`/`textarea`（一个输入控件都没有）⇒ 契约层那条"字段里方向键让位"
 * 在这里无从真挂（由 `plugin-api/tests/panel-row-nav.test.ts` 与带真下拉的函数树面板钉）；
 * 这里钉它的补集：焦点在**行外控件**（工具条「刷新」钮）时 ↓ 进名单第一行，
 * 且那枚钮自己不在名单上。
 *
 * 判据真源在契约层；本文件钉的是**面板接线**（行标记、容器键盘腿、漫游位对齐）。
 * 为什么住 app 侧：react-dom 与 happy-dom 只有 app 包依赖（本包 devDeps 只有 react，
 * 点不了按钮——理由见 `../../plugins/ui-archive-browser/src/panel-logic.ts` 头注）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ArchiveMeta,
  ArchiveReaderService,
  ComputePool,
  GameProject,
  Plugin,
  PluginContext,
  ProjectService,
  SnapshotArchiveEntry,
  UIPanelProps,
} from '@kojo/plugin-api';
import { ArchiveServices, KernelServices } from '@kojo/plugin-api';
import { createUiArchiveBrowserPlugin } from '../../plugins/ui-archive-browser/src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAV = 'C:/Game/proj/sav';
const noop = (): void => undefined;

function entry(fileName: string, saveMes: string, failed = false): SnapshotArchiveEntry {
  const meta = { saveMes, charCount: 3 } as unknown as ArchiveMeta;
  return {
    path: `${SAV}/${fileName}`,
    fileName,
    size: 1024,
    mtimeMs: 1_700_000_000_000,
    meta: failed ? null : meta,
    ...(failed ? { error: '浅解析失败：头部不对' } : {}),
  };
}

let container: HTMLDivElement;
let root: Root;
let emitSpy: ReturnType<typeof vi.fn>;
let extractSpy: ReturnType<typeof vi.fn>;
let Panel: ((props: UIPanelProps) => unknown) | null;

/** 装一只归档浏览器：`opts.fail` = `scan()` 直接炸（整列表没画出来的降级态） */
async function activateWith(
  entries: SnapshotArchiveEntry[],
  opts: { fail?: boolean } = {},
): Promise<void> {
  emitSpy = vi.fn();
  extractSpy = vi.fn(() => Promise.resolve({ cancelled: true, bytes: 0, landing: '' }));
  Panel = null;
  const reader = {
    current: () => (opts.fail ? null : { dir: SAV, entries, scannedAt: 0, durationMs: 0 }),
    scan: () =>
      opts.fail
        ? Promise.reject(new Error('目录读不动'))
        : Promise.resolve({ dir: SAV, entries, scannedAt: 0, durationMs: 0 }),
    parseEntry: () => Promise.resolve({ chars: [] }),
    extractEntry: extractSpy,
  } as unknown as ArchiveReaderService;
  const project = { rootDir: 'C:/Game/proj', savDir: SAV, charaIndex: new Map() } as unknown as GameProject;
  const projectService = { current: () => project } as unknown as ProjectService;
  const compute = {
    runLatest: (_k: string, _o: unknown, fn: () => unknown) => Promise.resolve(fn()),
  } as unknown as ComputePool;
  const slots = {
    register: (kind: string, def: { id: string; component?: (props: UIPanelProps) => unknown }) => {
      if (kind === 'ui.panel' && def.id === 'archive-browser') Panel = def.component ?? null;
    },
    query: () => [],
  };
  const ctx = {
    inject: (key: string) =>
      key === ArchiveServices.Reader
        ? reader
        : key === KernelServices.Project
          ? projectService
          : key === KernelServices.Compute
            ? compute
            : undefined,
    tryInject: () => undefined,
    slots,
    bus: { emit: emitSpy, on: () => noop },
    log: { warn: noop, info: noop, error: noop, debug: noop },
    onDispose: noop,
  };
  (createUiArchiveBrowserPlugin() as Plugin).activate(ctx as unknown as PluginContext);
  expect(Panel, 'ui.panel 槽必须注册出面板组件').toBeTruthy();
  // 激活即发的那一趟重扫先落地（含失败腿：reject → catch → finally 三跳），
  // 否则首帧只有"扫描中…"那句降级文案
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const Comp = Panel as unknown as (props: UIPanelProps) => ReactElement;
  await act(async () => {
    root.render(h(Comp, {}));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

/** 名单（契约层行标记）按 DOM 序 */
function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-panel-row]'));
}

function rowFiles(list: HTMLElement[]): string[] {
  return list.map((r) => r.querySelector('.ab-file')?.textContent ?? '');
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? container;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function focusOn(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.focus();
  });
}

async function clickRow(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

const panelRoot = (): HTMLElement => container.querySelector<HTMLElement>('.panel-archive-browser')!;

describe('归档浏览器 · 行键盘', () => {
  it('↑↓ 在画出来的档位之间走（边界回绕），一条选中广播都不发', async () => {
    await activateWith([entry('save02.sav', '第三档'), entry('save00.sav', '第一档'), entry('save01.sav', '第二档')]);
    const list = rows();
    // 名单 = 档位钮，按文件名升序（`buildArchiveList` 的排序口径，DOM 序即所见）
    expect(rowFiles(list)).toEqual(['save00.sav', 'save01.sav', 'save02.sav']);

    await focusOn(panelRoot());
    let e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]); // 焦点不在行上 ⇒ ↓ 从第一行走
    e = await press('ArrowUp');
    expect(document.activeElement).toBe(list[2]); // ↑ 从第一行回绕到最后一行
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[0]);
    expect(emitSpy).not.toHaveBeenCalled(); // ↑↓ 不打开任何东西
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('F8 移过去并当场打开：只走档位钮既有的 toggle；Shift 反向；展开体不进名单', async () => {
    await activateWith([entry('save00.sav', '第一档'), entry('save01.sav', '第二档')]);
    const list = rows();
    await focusOn(list[0]!);

    const e = await press('F8');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[1]); // 走到第二档
    expect(emitSpy).toHaveBeenCalledTimes(1); // 打开 = 行自己的 onClick，一条不落第二通道
    expect(emitSpy).toHaveBeenCalledWith('kojo.snapshotSelected', {
      path: `${SAV}/save01.sav`,
      fileName: 'save01.sav',
      source: 'ui-archive-browser',
    });

    // 展开体画出来了（两个「取出」按钮 + 角色摘要）——它们不是行：名单仍是 2
    expect(container.querySelectorAll('.ab-row-btn').length).toBe(2);
    const cluster = Array.from(container.querySelectorAll<HTMLElement>('.ab-detail button'));
    expect(cluster.length).toBeGreaterThan(0);
    expect(cluster.every((b) => !b.hasAttribute('data-panel-row'))).toBe(true);
    expect(rows()).toHaveLength(2);

    await press('F4', { shiftKey: true });
    expect(document.activeElement).toBe(rows()[0]);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(extractSpy).not.toHaveBeenCalled(); // 行键盘不碰取出动作（那是动作簇）
  });

  it('解析失败的档位也画成行（同在一份名单）；扫描失败态整列表缺席 ⇒ 名单空、不吞键', async () => {
    await activateWith([entry('save00.sav', '第一档'), entry('save07.sav', '坏档', true)]);
    const list = rows();
    expect(list).toHaveLength(2); // 正常组 + 「解析失败」组都在名单里（都是行、都能展开）
    expect(container.textContent).toContain('解析失败');
    await focusOn(list[0]!);
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[1]);
    expect(container.querySelectorAll('.ab-failed-head')).toHaveLength(1); // 那枚小标题不是行
    expect(container.querySelector('.ab-failed-head')?.hasAttribute('data-panel-row')).toBe(false);

    await activateWith([], { fail: true });
    expect(rows()).toHaveLength(0);
    await focusOn(panelRoot());
    const e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(false); // 空集合 = 原样让位（降级文案那一格不是行）
  });

  it('合成期一律放行；Enter/Tab/Escape/← 不吞；焦点在行外控件（刷新钮）时 ↓ 进第一行', async () => {
    await activateWith([entry('save00.sav', '第一档'), entry('save01.sav', '第二档')]);
    const list = rows();
    await focusOn(list[1]!);

    const e1 = await press('ArrowDown', { isComposing: true });
    expect(e1.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(list[1]);
    const e2 = await press('ArrowDown', { keyCode: 229 });
    expect(e2.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(list[1]);

    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowLeft']) {
      const e = await press(key);
      expect(e.defaultPrevented, key).toBe(false);
    }

    const scanBtn = container.querySelector<HTMLButtonElement>('.ab-toolbar button')!;
    expect(scanBtn.hasAttribute('data-panel-row')).toBe(false); // 工具条不参与名单
    await focusOn(scanBtn);
    const e3 = await press('ArrowDown');
    expect(e3.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[0]); // 行外 ⇒ ↓ 进第一行（与单行检索框同一档）
  });

  it('roving tabindex：整段名单只留一枚 0，鼠标点行也对齐（焦点可见走全局 --focus-ring，零新色）', async () => {
    await activateWith([entry('save00.sav', '第一档'), entry('save01.sav', '第二档'), entry('save02.sav', '第三档')]);
    const tabbable = () => rows().filter((r) => r.tabIndex === 0);
    expect(tabbable()).toHaveLength(1); // 挂载后兜底第一行

    await clickRow(rows()[2]!); // 鼠标点行（行的既有 `onClick` = 展开 + 广播选中）
    await focusOn(rows()[2]!); // 聚焦落进那一行 ⇒ 容器 focus 腿对齐漫游位
    expect(tabbable()).toEqual([rows()[2]]);
    expect(emitSpy).toHaveBeenCalledTimes(1); // 鼠标那一下也只走同一条通路

    await press('ArrowUp'); // 键盘移动焦点 ⇒ 判据层就地办结
    expect(tabbable()).toEqual([rows()[1]]);
    expect(rows()[2]!.tabIndex).toBe(-1);
  });
});
