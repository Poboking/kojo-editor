// @vitest-environment happy-dom
/**
 * W7-B：检索面板**连续回车逐项跳不抢焦点**（2026-10-20）。
 *
 * 缺陷形态：检索框带结果时回车 = 逐项跳，但 `editor.revealLocation` 的宿主落地
 * （`EditorPane.applyReveal`）每次都 `ed.focus()` ⇒ 第一跳焦点就离开检索框，
 * 第二次回车落在编辑器里，一条结果都跳不动。
 *
 * 判据两条腿：
 * ① 行为：连续两次回车都发出跳转请求，且每次都是 `focus:false`（定位后不许把焦点
 *    交给编辑器）——测试桩模拟"不带 focus:false 就会被编辑器抢走焦点"，两跳之后
 *    焦点必须仍在检索框；
 * ② 形状：`applyReveal` 的 `ed.focus()` 只许挂在 `revealFocusesEditor(target)` 之下
 *    （2,700 行组件无挂载设施，形态判据同 `editor-pane-dataflow.test.ts` 口径），
 *    并钉住焦点选项从事件载荷一路带到编辑器的四处接线。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SearchResult } from '../src/bridge/search';
import type { RevealSpan } from '../src/monaco/reveal-position';
import { revealFocusesEditor } from '../src/monaco/reveal-position';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, runSearch, setQuery, setSearchRunner } from '../src/ui/search-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_OF = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'ui', rel), 'utf8');

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  files: [],
  totalMatches: 0,
  truncated: false,
  cancelled: false,
  filesScanned: 0,
  skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
  elapsedMs: 0,
  ...over,
});

/** 两条命中（同一文件第 2 / 9 行）：逐项跳的显示序就按它走 */
async function primeTwoMatches(): Promise<void> {
  setSearchRunner(async () =>
    result({
      totalMatches: 2,
      filesScanned: 1,
      files: [
        {
          path: 'C:\\game\\ERB\\事件.ERB',
          matches: [
            { line: 2, column: 5, preview: '二行目にABC', start: 4, end: 7 },
            { line: 9, column: 1, preview: 'ABC 开头', start: 0, end: 3 },
          ],
        },
      ],
    }),
  );
  setQuery('ABC');
  await runSearch(['C:\\game']);
}

describe('检索框连续回车：每一次都逐项跳，且焦点留在检索框', () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: HTMLTextAreaElement;

  beforeEach(async () => {
    resetSearch();
    await primeTwoMatches();
    container = document.createElement('div');
    document.body.appendChild(container);
    editor = document.createElement('textarea');
    document.body.appendChild(editor);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    editor.remove();
    setSearchRunner(null);
    resetSearch();
  });

  it('两次 Enter（含 Shift+Enter）都发跳转请求且都带 focus:false；焦点两跳后仍在检索框', async () => {
    const calls: { line: number; focus: boolean | undefined }[] = [];
    /**
     * 测试桩模拟宿主：**不带 `focus:false` 就把焦点交给编辑器**（等价于
     * `EditorPane.applyReveal` 里的 `ed.focus()`）。它是本判据能红的关键——
     * 旧行为下第一跳焦点就离开检索框。
     */
    const onReveal = (_path: string, line: number, _span?: RevealSpan, options?: { focus?: boolean }): void => {
      calls.push({ line, focus: options?.focus });
      if (options?.focus !== false) editor.focus();
    };

    await act(async () => {
      root.render(createElement(SearchPanel, { roots: ['C:\\game'], onReveal }));
    });
    const input = container.querySelector<HTMLInputElement>('.search-input');
    expect(input, '检索输入框必须在场').toBeTruthy();
    input!.focus();
    expect(document.activeElement).toBe(input);

    const press = async (shiftKey = false): Promise<void> => {
      await act(async () => {
        input!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }),
        );
      });
    };

    await press();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.focus, '逐项跳必须带 focus:false（否则焦点被编辑器抢走）').toBe(false);
    expect(calls[0]!.line).toBe(2);
    expect(document.activeElement, '第一跳后焦点仍在检索框').toBe(input);

    await press();
    expect(calls, '第二次回车必须还能触发第二项').toHaveLength(2);
    expect(calls[1]!.focus).toBe(false);
    expect(calls[1]!.line).toBe(9);
    expect(document.activeElement, '第二跳后焦点仍在检索框').toBe(input);

    // Shift+回车（上一项）同一条腿，同样不抢焦点
    await press(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.focus).toBe(false);
    expect(calls[2]!.line).toBe(2);
    expect(document.activeElement).toBe(input);
  });
});

describe('applyReveal：focus:false 不调用 ed.focus，缺省仍聚焦', () => {
  const SOURCE = SOURCE_OF('EditorPane.tsx');

  /** 截 `const NAME = ...` 到下一个顶层两空格缩进 `const`（同 editor-pane-dataflow 口径） */
  function sliceFn(name: string): string {
    const start = SOURCE.indexOf(`const ${name} =`);
    expect(start, `找不到 ${name}`).toBeGreaterThanOrEqual(0);
    const rest = SOURCE.slice(start + `const ${name} =`.length);
    const end = rest.search(/\n  const [A-Za-z_]/);
    return rest.slice(0, end === -1 ? rest.length : end);
  }

  it('ed.focus 只在唯一判据 `revealFocusesEditor(target)` 之下（且全函数只有这一处）', () => {
    const body = sliceFn('applyReveal');
    expect(body).toContain('if (revealFocusesEditor(target)) ed.focus();');
    expect(body.match(/ed\.focus\(\)/g)).toHaveLength(1);
    // 唯一的判据本体：显式 false 不聚焦，缺席 / true 保持现行行为
    expect(revealFocusesEditor({ focus: false })).toBe(false);
    expect(revealFocusesEditor({})).toBe(true);
    expect(revealFocusesEditor({ focus: true })).toBe(true);
  });

  it('焦点选项从事件载荷一路带到编辑器：App → ProjectView → EditorPane prop', () => {
    const app = SOURCE_OF('App.tsx');
    const project = SOURCE_OF('ProjectView.tsx');
    const panel = SOURCE_OF('SearchPanel.tsx');
    // 总线消费：ev.focus 透传给 openFile 链
    expect(app).toContain('requestOpenFile(ev.filePath, ev.line ?? 1, ev.column, ev.span, false, ev.focus)');
    expect(app).toMatch(/revealTargetOf\(\{ line, column, span, focus \}, Date\.now\(\)\)/);
    // 面板腿：focus 走同一个载荷出口；编辑器腿：目标上的 focus 落到 prop
    expect(project).toContain('focus: options?.focus');
    expect(project).toContain('revealFocus={focused ? reveal?.focus : undefined}');
    expect(SOURCE).toContain('...(revealFocus !== undefined ? { focus: revealFocus } : {}),');
    // 发起方：键盘逐项跳点明 focus:false（鼠标点行不传 = 老行为）
    expect(panel).toContain(
      'onReveal(target.path, target.match.line, searchMatchSpan(target.match), { focus: false })',
    );
  });
});
