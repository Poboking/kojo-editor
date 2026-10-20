// @vitest-environment happy-dom
/**
 * VETO-1：预览（升糖）面上**写类动作被否决必须给出路**。
 *
 * 形态判据（源码切片）+ 通知中心行为判据各钉一半：
 * - 两条总线否决（壳层动作请求 / 一键修复）与两条键位（F2 改名 / Shift+Alt+F 格式化）
 *   都必须走同一枚「切回原文」通知；按钮点击经 `editor.sugarView.set {on:false}` 落地，
 *   通知中心先关 toast 再执行（`NotificationCenter` 既有语义，本文件用 happy-dom 实测）。
 * - 「一键修复」的三种"没落"原因（预览面只读 / 文件被外部改动 / 无可用修法）各一条文案，
 *   只有预览面那条带出路。
 * - **原文面零新增通知**：四条调用点全部在 `if (sugarModelRef.current)` 之内；原文面
 *   只把键位原样交回 Monaco 内建动作。
 *
 * 为什么走源码切片：这些行为都活在 2600 行组件的闭包里，没有挂载设施可跑——与
 * `editor-pane-dataflow.test.ts` / `ps5-editor-pane-wiring.test.ts` 同一套取证方式。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NotificationCenter, useNotify, type Notify } from '../src/ui/NotificationCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'),
  'utf8',
);

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string): string {
  const from = SOURCE.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = SOURCE.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return SOURCE.slice(from, to);
}

/** 截一个总线 effect（从 `kernel.bus.on('事件')` 到该 effect 的依赖数组行） */
function sliceBusEffect(event: string): string {
  const start = SOURCE.indexOf(`kernel.bus.on('${event}'`);
  expect(start, `找不到 ${event} 的订阅`).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('\n  }, [', start);
  expect(end, `${event} 的 effect 没有等到依赖数组行`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

const VETO_HELPER = sliceBetween('const notifyPreviewWriteVeto = useCallback(', 'const themePref = useThemePref');
const ACTION_REQUEST = sliceBusEffect('editor.action.request');
const FIX_ALL_EFFECT = sliceBusEffect('editor.fixAll.request');
const APPLY = sliceBetween(
  'const applyQuickFixEdits = useCallback(',
  "\n  useEffect(() => {\n    return kernel.bus.on('editor.fixAll.request'",
);
const F2 = sliceBetween(
  'ed.addCommand(monaco.KeyCode.F2',
  'ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF',
);
const FORMAT = sliceBetween(
  'ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF',
  'applyNameColorPref(ed);',
);

const PREVIEW_FIX_ALL_MSG = '.kojo 预览是只读显示，改不到原文件——先切回原文再一键修复。';
const EXTERNAL_MSG = '在磁盘上已被外部改动';
const NO_FIX_MSG = '这一份没有可自动补好的修法——不必再按了。';

describe('1 · 两条总线否决都带「切回原文」出路', () => {
  it('唯一出口挂在通知中心上：按钮文字 + 走 `editor.sugarView.set` 关预览', () => {
    expect(VETO_HELPER).toContain("label: '切回原文'");
    expect(VETO_HELPER).toContain("kernel.bus.emit('editor.sugarView.set'");
    expect(VETO_HELPER).toMatch(/on:\s*false/);
    // 目标文件在弹通知那一刻定下（切走标签后点旧通知不误关另一个文件）
    expect(VETO_HELPER).toContain('const target = filePathRef.current');
    expect(VETO_HELPER).toContain('filePath: target');
  });

  it('壳层动作请求的预览否决改走出路出口（旧的"先关掉预览…再执行"文案已消失）', () => {
    expect(ACTION_REQUEST).toContain('if (sugarModelRef.current) {');
    expect(ACTION_REQUEST).toContain('notifyPreviewWriteVeto(PREVIEW_WRITE_VETO)');
    // 两条旧文案（把出路说完就没了）逐字退役
    expect(SOURCE).not.toContain('——先关掉预览再执行。');
    expect(SOURCE).not.toContain('——先关掉预览再一键修复。');
  });

  it('一键修复的预览否决同样改走出路出口', () => {
    expect(APPLY).toContain('if (sugarModelRef.current) {');
    expect(APPLY).toContain("notifyPreviewWriteVeto('.kojo 预览是只读显示，改不到原文件——先切回原文再一键修复。')");
  });

  it('`editor.fixAll.request` 的 effect 只转发给 `applyQuickFixEdits`（不再自带第二套判据）', () => {
    expect(FIX_ALL_EFFECT).toContain('applyQuickFixEdits()');
    expect(FIX_ALL_EFFECT).not.toContain('runFixAll');
    expect(FIX_ALL_EFFECT).not.toContain('notify(');
  });
});

describe('2 · F2 / Shift+Alt+F 在命令层拦，不动全局键位表', () => {
  it('F2：预览面 => 带出路的否决；原文面 => 原样交回 Monaco 内建改名', () => {
    expect(F2).toContain('if (sugarModelRef.current) {');
    const intercept = F2.slice(0, F2.indexOf('void ed.getAction'));
    expect(intercept).toContain('notifyPreviewWriteVeto(PREVIEW_WRITE_VETO)');
    expect(intercept).toContain('return;');
    expect(F2.slice(F2.indexOf('void ed.getAction'))).toContain("ed.getAction('editor.action.rename')");
  });

  it('Shift+Alt+F：预览面 => 同一条带按钮通知；原文面 => 原样交回 Monaco 内建格式化', () => {
    expect(FORMAT).toContain('if (sugarModelRef.current) {');
    const intercept = FORMAT.slice(0, FORMAT.indexOf('void ed.getAction'));
    expect(intercept).toContain('notifyPreviewWriteVeto(PREVIEW_WRITE_VETO)');
    expect(intercept).toContain('return;');
    expect(FORMAT.slice(FORMAT.indexOf('void ed.getAction'))).toContain(
      "ed.getAction('editor.action.formatDocument')",
    );
  });

  it('两条键位都只加在本实例（`ed.addCommand`），全局键位表文件零改动', () => {
    expect(F2).toContain('ed.addCommand(monaco.KeyCode.F2');
    expect(FORMAT).toContain(
      'ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF',
    );
    const keybindings = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'ui', 'keybindings.ts'),
      'utf8',
    );
    // 键位登记表里不许出现这两枚 Monaco 内建键的再次登记（本批只许在编辑器实例上拦）
    expect(keybindings).not.toMatch(/KeyCode\.(F2|KeyF)/);
  });
});

describe('3 · 一键修复的三种"没落"原因拆成三条文案', () => {
  it('预览面只读 / 外部改动 / 无可用修法：三条互不相同的文案', () => {
    expect(APPLY).toContain(PREVIEW_FIX_ALL_MSG);
    expect(APPLY).toContain(EXTERNAL_MSG);
    expect(APPLY).toContain(NO_FIX_MSG);
    expect(new Set([PREVIEW_FIX_ALL_MSG, EXTERNAL_MSG, NO_FIX_MSG]).size).toBe(3);
  });

  it('三条原因各有自己的判据分支，不共用一条兜底', () => {
    // ① 预览面：sugarModelRef 判据
    expect(APPLY).toContain('if (sugarModelRef.current) {');
    // ② 外部改动：与 A6 自动保存护栏读同一个信号
    expect(APPLY).toContain('if (externalConflictRef.current.has(path)) {');
    // ③ 无可用修法：runFixAll 的回执全部为零时才说"不必再按"
    expect(APPLY).toContain('const nothingToFix');
    expect(APPLY).toMatch(/if \(nothingToFix\) \{/);
    // 三种原因各一的落地顺序：预览 → 外部 → 只读闸 → 真跑 runFixAll
    expect(APPLY.indexOf('if (sugarModelRef.current)')).toBeLessThan(
      APPLY.indexOf('if (externalConflictRef.current.has(path))'),
    );
    expect(APPLY.indexOf('if (externalConflictRef.current.has(path))')).toBeLessThan(
      APPLY.indexOf('runFixAll({'),
    );
  });

  it('只有"预览面"那条带出路按钮（helper 只被调用一次）', () => {
    expect(APPLY.split('notifyPreviewWriteVeto(').length - 1).toBe(1);
    // 另外两条走普通 notify，不带 action
    const externalBranch = APPLY.slice(
      APPLY.indexOf('if (externalConflictRef.current.has(path))'),
      APPLY.indexOf('const canEdit'),
    );
    expect(externalBranch).not.toContain('actions:');
    const noFixBranch = APPLY.slice(APPLY.indexOf('if (nothingToFix)'), APPLY.indexOf('fixAllSummary(report)'));
    expect(noFixBranch).not.toContain('actions:');
  });

  it('整文件修法仍只有一处 `runFixAll` 调用（从 effect 搬进函数，没有复制第二份）', () => {
    expect(SOURCE.split('runFixAll({').length - 1).toBe(1);
    expect(APPLY).toContain('runFixAll({');
  });
});

describe('4 · 原文面零新增通知', () => {
  it('F2 / Shift+Alt+F 的否决调用都只在糖模型分支里，原文面只交回内建动作', () => {
    for (const [name, block] of [
      ['F2', F2],
      ['Shift+Alt+F', FORMAT],
    ] as const) {
      expect(block.split('notifyPreviewWriteVeto(').length - 1, `${name} 只许一次否决`).toBe(1);
      const delegate = block.slice(block.indexOf('void ed.getAction'));
      expect(delegate, `${name} 原文面不许新增通知`).not.toMatch(/\bnotify\(/);
      expect(delegate, `${name} 原文面不许走否决出口`).not.toContain('notifyPreviewWriteVeto(');
    }
  });

  it('动作请求：糖模型分支之外只剩它自己的既有提示，旧否决文案不再出现', () => {
    const afterGuard = ACTION_REQUEST.slice(ACTION_REQUEST.indexOf("notify({ kind: 'info', message: '当前文件类型不支持这个动作。'"));
    expect(afterGuard).not.toContain('notifyPreviewWriteVeto');
    expect(ACTION_REQUEST.split('notifyPreviewWriteVeto(').length - 1).toBe(1);
  });

  it('一键修复：预览否决在糖模型分支里，原文面走的是既有只读/回执提示', () => {
    const previewGuard = APPLY.slice(
      APPLY.indexOf('if (sugarModelRef.current) {'),
      APPLY.indexOf('if (externalConflictRef.current.has(path))'),
    );
    expect(previewGuard).toContain('notifyPreviewWriteVeto(');
    const originalFace = APPLY.slice(
      APPLY.indexOf('if (externalConflictRef.current.has(path))'),
      APPLY.indexOf('}, [kernel, notify, notifyPreviewWriteVeto]);'),
    );
    expect(originalFace).not.toContain('notifyPreviewWriteVeto(');
  });
});

describe('5 · 「切回原文」按钮的 UI 语义（NotificationCenter 既有通道）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('actions 里的按钮渲染出来；点击先关 toast 再执行（与 sugarView.set 落地同一拍）', async () => {
    let captured: Notify | null = null;
    function Capture(): null {
      captured = useNotify();
      return null;
    }
    await act(async () => {
      root.render(h(NotificationCenter, null, h(Capture)));
    });
    expect(captured).toBeTruthy();

    const run = vi.fn();
    await act(async () => {
      captured!({
        kind: 'info',
        message: '.kojo 预览是只读显示，动作改的是派生文本——先切回原文再执行。',
        actions: [{ label: '切回原文', run }],
      });
    });

    const button = [...container.querySelectorAll('button.toast-action')].find(
      (b) => b.textContent === '切回原文',
    ) as HTMLButtonElement | undefined;
    expect(button, '带出路的通知必须渲染出「切回原文」按钮').toBeTruthy();

    await act(async () => {
      button!.click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    // 通知中心先 dismiss 再 run ⇒ 点击后 toast 消失
    expect(container.querySelector('.notification-center')).toBeNull();
  });

  it('info 通知仍按既有 TTL 自动消失（本批不改通知中心的存活语义）', async () => {
    vi.useFakeTimers();
    try {
      let captured: Notify | null = null;
      function Capture(): null {
        captured = useNotify();
        return null;
      }
      await act(async () => {
        root.render(h(NotificationCenter, null, h(Capture)));
      });
      await act(async () => {
        captured!({ kind: 'info', message: '临时提示', actions: [{ label: '切回原文', run: () => undefined }] });
      });
      expect(container.querySelector('.toast-action')).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(6100);
      });
      expect(container.querySelector('.notification-center')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
