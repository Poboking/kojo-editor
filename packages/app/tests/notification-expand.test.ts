// @vitest-environment happy-dom
/**
 * 1028 错误弹窗批的**行为**闸（静态切片在 `shell-notice-density.test.ts`，这里真实挂载点一遍）。
 *
 * 为什么另开一份而不是只留静态断言：「结构在源码里」和「点下去真会展开」是两件事——
 * 上一批就有过产物字面全绿、运行时不动手的例子。这里用 happy-dom 真点一遍：
 * 收起两行 → 点 ⌄ → 原文整段与技术原文上屏 → 再点收回，且展开不关通知。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NotificationCenter, useNotify, type Notify } from '../src/ui/NotificationCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG =
  '打开项目失败：无法写入项目目录，可能是磁盘只读、路径已被占用，或当前账号没有这个文件夹的写入权' +
  '限。请检查目标文件夹的属性后重试。';

describe('通知收起两行 + ⌄ 展开原文', () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: Notify | null = null;

  function Capture(): null {
    captured = useNotify();
    return null;
  }

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    captured = null;
    await act(async () => {
      root.render(h(NotificationCenter, null, h(Capture)));
    });
    expect(captured).toBeTruthy();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const expandButton = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button.toast-expand');
  const fullText = (): HTMLElement | null => container.querySelector<HTMLElement>('.toast-full');
  const detail = (): HTMLElement | null => container.querySelector<HTMLElement>('.toast-detail');
  const toast = (): HTMLElement | null => container.querySelector<HTMLElement>('.toast');

  it('长错误收起时只露标题 + 摘要，原文与技术原文本轮都不可见', async () => {
    await act(async () => {
      captured!({ kind: 'error', message: LONG, detail: 'EACCES: permission denied' });
    });
    expect(toast()?.querySelector('.toast-head')?.textContent).toBe('打开项目失败');
    expect(toast()?.querySelector('.toast-summary')).toBeTruthy();
    expect(fullText()?.hasAttribute('hidden')).toBe(true);
    expect(detail()?.hasAttribute('hidden')).toBe(true);
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('点 ⌄ = 原文整段 + 技术原文上屏，标题/摘要退场；再点收回', async () => {
    await act(async () => {
      captured!({ kind: 'error', message: LONG, detail: 'EACCES: permission denied' });
    });

    await act(async () => {
      expandButton()!.click();
    });
    // 展开档渲染的是**调用方原文**（不是 head + rest 拼回去：`：` 不会被拼丢）
    expect(fullText()?.textContent).toBe(LONG);
    expect(fullText()?.hasAttribute('hidden')).toBe(false);
    expect(detail()?.hasAttribute('hidden')).toBe(false);
    expect(toast()?.querySelector('.toast-head')).toBeNull();
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('true');
    // 展开只是换一档画面，通知本身还在
    expect(container.querySelector('.notification-center')).toBeTruthy();

    await act(async () => {
      expandButton()!.click();
    });
    expect(fullText()?.hasAttribute('hidden')).toBe(true);
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('没有可展开的东西就不给 ⌄（不做点不出反应的假按钮）', async () => {
    await act(async () => {
      captured!({ kind: 'error', message: '保存失败' });
    });
    expect(expandButton()).toBeNull();
    expect(container.querySelector('.toast-close')).toBeTruthy();
  });

  it('动作按钮住在正文下方独立一行，动作多时正文不被挤窄', async () => {
    await act(async () => {
      captured!({
        kind: 'error',
        message: LONG,
        actions: [
          { label: '看看差异', run: () => undefined },
          { label: '放弃我的修改', run: () => undefined },
        ],
      });
    });
    const row = container.querySelector('.toast-actions');
    expect(row).toBeTruthy();
    expect(row?.querySelectorAll('button.toast-action')).toHaveLength(2);
    // 正文列里才有动作行；右侧栏只有 ⌄ 与 ✕
    expect(row?.closest('.toast-main')).toBeTruthy();
  });
});
