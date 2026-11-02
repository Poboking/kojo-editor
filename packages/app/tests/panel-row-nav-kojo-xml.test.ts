// @vitest-environment happy-dom
/**
 * 口上 XML 树面板的行键盘（kw8b 1102 行键盘批 · 四只懒边面板之三）。
 *
 * 判据是**行为级**（真挂载、真派发 KeyboardEvent、看焦点落在哪一行），照
 * `panel-row-nav-kojo-navigator.test.ts` 的接线范式：
 * - ↑↓ 只在**画出来的行**之间移焦点（边界回绕），什么都不打开；
 * - F4/F8 移过去并**当场敲那一枚按钮**：角色行 / 文件行 = 它自己既有的展开收起 `onClick`
 *   （折叠真源仍只住 `openCharas/openFiles`），条目行 = 它既有那条 `editor.revealLocation`
 *   通路——零第二条跳转；Shift 反向；
 * - 没画出来的行不在名单：折叠着的角色下面的文件与条目、`NAV_WINDOW`（120/240，kw9 规模批
 *   的收口面，语义本批不动）之外没挂 DOM 的条目、条目行右侧那枚「预览」、
 *   「显示更多」哨兵（照 `ui-convention-report` 口径：窗口控制件不是结果行）；
 * - 单行检索框**不让位**（↓ 直接进名单第一行）；Right/Left 明确不接（接了就等于另造
 *   一套折叠态）；输入法合成期一律放行；
 * - roving tabindex：整段名单只留一枚 0。
 *
 * 本面板只有单行输入（`type=search` 检索框 + 预览语境两枚 `type=text`），没有
 * `select`/`textarea` ⇒ 契约层"字段里方向键让位"那条腿在此无从真挂（由
 * `plugin-api/tests/panel-row-nav.test.ts` 与带真下拉的函数树面板钉），面板侧钉补集。
 *
 * 判据真源在契约层；本文件钉的是**面板接线**。
 * 为什么住 app 侧：react-dom 与 happy-dom 只有 app 包依赖（同 `panel-window-kojo-xml.test.ts`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  KojoXmlCommand,
  KojoXmlDiagnostic,
  KojoXmlFile,
  KojoXmlIndex,
  KojoXmlService,
  PluginContext,
  UIPanelProps,
} from '@kojo/plugin-api';
import { createKojoXmlPanel } from '../../plugins/ui-kojo-xml/src/panel';
import { NAV_WINDOW_INITIAL } from '../../plugins/ui-kojo-xml/src/panel-rows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const F1 = 'root/1001_a/KOJO_K1001_COM.xml';
const F2 = 'root/1002_a/KOJO_K1002_COM.xml';

const cmd = (com: string, line: number, index: number): KojoXmlCommand => ({
  index,
  span: { start: { line, column: 3 }, end: { line, column: 12 } },
  contentSpan: null,
  attrs: { com, name: `条目${com}`, kojoPlace: 'TOP' },
  text: `台词 ${com}`,
});

const file = (path: string, charaNo: number, n: number): KojoXmlFile => ({
  path,
  format: 'data',
  encoding: 'utf-8',
  eol: 'crlf',
  charaNo,
  commands: Array.from({ length: n }, (_, i) => cmd(String(i + 1), i + 2, i)),
  diagnostics: [],
});

const diag = (): KojoXmlDiagnostic => ({
  path: F1,
  severity: 'warning',
  code: 'kojo-xml.test.warn',
  message: '这条缺个属性',
  span: { start: { line: 9, column: 1 }, end: { line: 9, column: 5 } },
});

function index(n1 = 3, n2 = 2): KojoXmlIndex {
  const f1 = file(F1, 1001, n1);
  const files = n2 > 0 ? [f1, file(F2, 1002, n2)] : [f1];
  const byChara = new Map<number, readonly KojoXmlFile[]>([[1001, [f1]]]);
  if (n2 > 0) byChara.set(1002, [files[1]!]);
  return {
    files,
    commandCount: n1 + n2,
    byChara,
    byCom: new Map(),
    diagnostics: [diag()],
    scannedAt: 1,
  };
}

let container: HTMLDivElement;
let root: Root;
let emitSpy: ReturnType<typeof vi.fn>;

async function mount(idx: KojoXmlIndex): Promise<void> {
  emitSpy = vi.fn();
  const service = {
    index: () => idx,
    file: (path: string) => idx.files.find((f) => f.path === path) ?? null,
    schema: () => null,
    refresh: () => Promise.resolve(idx),
    preview: () => ({ lines: ['台词一行'], conditions: [], unresolved: [] }),
    subscribe: () => () => undefined,
  } as unknown as KojoXmlService;
  const ctx = {
    bus: { emit: emitSpy, on: () => () => undefined },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  } as unknown as PluginContext;
  const Panel = createKojoXmlPanel({ ctx, service, charaNames: () => new Map([[1001, '阿莉丝']]) });
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

const rowTexts = (): string[] => rows().map((r) => r.textContent ?? '');

const panelRoot = (): HTMLElement => container.querySelector<HTMLElement>('.panel-kojo-nav.panel-kojo-xml')!;
const searchBox = (): HTMLElement => container.querySelector<HTMLInputElement>('input.nav-search')!;

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

/** 只统计 reveal 那一腿的广播（"零第二条通路"的读数口径） */
const revealCalls = (): unknown[][] => emitSpy.mock.calls.filter((c) => c[0] === 'editor.revealLocation');

describe('口上 XML 树面板 · 行键盘', () => {
  it('折叠态：名单只有画出来的行（两个角色 + 诊断汇总），↑↓ 走它们并回绕，什么都不打开', async () => {
    await mount(index());
    const list = rows();
    expect(list).toHaveLength(3);
    expect(rowTexts()[0]).toContain('阿莉丝');
    expect(rowTexts()[1]).toContain('1002'); // 第二个角色回落显示编号
    expect(rowTexts()[2]).toContain('诊断'); // 汇总那一行也收进名单（它的 onClick = 展开诊断）
    // 没展开的角色 ⇒ 文件行与条目行压根没画出来 ⇒ 不在名单
    expect(list.some((r) => (r.textContent ?? '').includes('COM.xml'))).toBe(false);
    expect(container.querySelectorAll('.nav-preview-btn')).toHaveLength(0);

    await focusOn(panelRoot());
    let e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(list[0]);
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[1]);
    await press('ArrowDown');
    expect(document.activeElement).toBe(list[2]);
    await press('ArrowDown'); // 末行再往下 = 回绕到第一行（同一把尺子）
    expect(document.activeElement).toBe(rows()[0]);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('F8 敲的就是这一行既有的 onClick：条目行只发一条 reveal；「预览」钮不进名单', async () => {
    await mount(index());
    await clickRow(rows()[0]!); // 展开角色 1001（行的 onClick，同一通道）
    await clickRow(rows()[1]!); // 再展开它那份文件——条目行这才画得出来
    const list = rows();
    // 角色 + 文件 + 3 条目 + 第二个角色 + 诊断汇总
    expect(list).toHaveLength(7);
    expect(rowTexts()[1]).toContain('KOJO_K1001_COM.xml');

    // 同一行右侧那枚「预览」是动作簇，不是名单位（收进来 ↑↓ 会在同一条口上打转）
    const previews = Array.from(container.querySelectorAll<HTMLElement>('.nav-preview-btn'));
    expect(previews).toHaveLength(3);
    expect(previews.every((b) => !b.hasAttribute('data-panel-row'))).toBe(true);

    await focusOn(list[1]!); // 焦点在文件行
    const e = await press('F8');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[2]); // 走到第一条口上
    expect(revealCalls()).toHaveLength(1);
    expect(emitSpy).toHaveBeenCalledWith('editor.revealLocation', {
      filePath: F1,
      line: 2,
      column: 3,
      source: 'ui-kojo-xml',
    });

    await focusOn(rows()[4]!); // 第三条口上
    await press('F8', { shiftKey: true });
    expect(document.activeElement).toBe(rows()[3]); // 反向挪一格并当场打开
    expect(revealCalls()).toHaveLength(2);
    expect(emitSpy.mock.calls.every((c) => c[0] === 'editor.revealLocation')).toBe(true); // 只有这一条通路
  });

  it('窗口外的条目不在名单（NAV_WINDOW 收口不动）；「显示更多」哨兵不是行', async () => {
    await mount(index(200, 0));
    await clickRow(rows()[0]!);
    await clickRow(rows()[1]!); // 展开那份 200 条的文件
    const list = rows();
    // 角色 + 文件 + 窗口内条目 = INITIAL 行，再加末尾的诊断汇总行
    expect(list).toHaveLength(NAV_WINDOW_INITIAL + 1);
    expect(rowTexts()[NAV_WINDOW_INITIAL - 1]).toContain('条目118'); // 名单末行 = 窗口末行
    expect(rowTexts()[NAV_WINDOW_INITIAL]).toContain('诊断');
    expect(container.textContent).not.toContain('· 条目119'); // 窗口外的条目没挂 DOM

    const more = container.querySelector<HTMLElement>('.nav-more-btn')!;
    expect(more.textContent).toContain('显示更多（还剩 82）');
    expect(more.hasAttribute('data-panel-row')).toBe(false);

    await focusOn(list[NAV_WINDOW_INITIAL - 1]!);
    await press('ArrowDown');
    expect(document.activeElement).toBe(rows()[NAV_WINDOW_INITIAL]); // 下一站是诊断汇总行
    await press('ArrowDown');
    expect(document.activeElement).toBe(rows()[0]); // 回绕——窗口外的条目永远走不到（不留"跳过去但看不见"）
  });

  it('诊断汇总行与条目行同在名单：F8 展开走它自己的 onClick，条目行走同一条 reveal', async () => {
    await mount(index());
    const diagToggle = rows()[2]!;
    expect(rowTexts()[2]).toContain('诊断');
    await clickRow(diagToggle); // 展开诊断（行的 onClick）
    const list = rows();
    expect(list).toHaveLength(4); // 两角色 + 汇总行 + 画出来的那一条诊断
    expect(rowTexts()[3]).toContain('这条缺个属性');

    await focusOn(list[2]!);
    const e = await press('F8');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[3]);
    expect(revealCalls()).toHaveLength(1);
    expect(emitSpy).toHaveBeenCalledWith('editor.revealLocation', {
      filePath: F1,
      line: 9,
      column: 1,
      source: 'ui-kojo-xml',
    });
  });

  it('单行检索框不让位（↓ 进第一行）；Right/Left 不接；合成期一律放行', async () => {
    await mount(index());
    await focusOn(searchBox());
    const e = await press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[0]); // 检索框的方向键本来什么都不做 ⇒ 让给行导航

    const list = rows();
    await focusOn(list[0]!);
    const before = rowTexts();
    for (const key of ['ArrowRight', 'ArrowLeft']) {
      const ev = await press(key);
      expect(ev.defaultPrevented, key).toBe(false); // 折叠键归面板自己那套状态，本批不接
      expect(document.activeElement).toBe(rows()[0]);
    }
    expect(revealCalls()).toHaveLength(0);
    expect(rowTexts()).toEqual(before); // 名单没被改写过 = 没造第二套折叠态

    const e1 = await press('ArrowDown', { isComposing: true });
    expect(e1.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rows()[0]);
    const e2 = await press('ArrowDown', { keyCode: 229 });
    expect(e2.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rows()[0]);

    for (const key of ['Enter', 'Tab', 'Escape']) {
      const ev = await press(key);
      expect(ev.defaultPrevented, key).toBe(false); // 激活/跳出/关闭各归各家，行导航不吞
    }
  });

  it('roving tabindex：整段名单只留一枚 0，鼠标点行也对齐（焦点可见走全局 --focus-ring，零新色）', async () => {
    await mount(index());
    const tabbable = () => rows().filter((r) => r.tabIndex === 0);
    expect(tabbable()).toHaveLength(1); // 挂载后兜底第一行

    await clickRow(rows()[0]!); // 展开首角色：名单从 3 行长到 4
    expect(rows().length).toBeGreaterThan(3);
    await clickRow(rows()[1]!); // 再展开文件：条目行进名单（3 条口上 ⇒ 7 行）
    const list = rows();
    expect(list).toHaveLength(7);
    await focusOn(list[3]!); // 聚焦落进名单中段 ⇒ 容器 focus 腿对齐
    expect(tabbable()).toEqual([rows()[3]]);

    await press('ArrowDown'); // 键盘移动焦点 ⇒ 判据层就地办结
    expect(tabbable()).toEqual([rows()[4]]);
    expect(rows()[0]!.tabIndex).toBe(-1);
    expect(rows()[3]!.tabIndex).toBe(-1);
  });
});
