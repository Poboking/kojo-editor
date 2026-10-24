// @vitest-environment happy-dom
/**
 * 调试面 · DOM 结构快照的真 DOM 判据（2026-10-24 调试模式批）。
 *
 * 与 `debug-surface.test.ts` 分文件：那份跑 node 池（读源码 / 纯函数），这份要真
 * `document`。真浏览器全链路由 `tools/debug-web-smoke.mjs` 兜（phase=project 断言），
 * 这里钉的是**快照结构学**：相位判别、各面的结构锚、文本截断、主题读数。
 */
import { describe, expect, it } from 'vitest';
import { snapshotDocument } from '../src/debug/dom-snapshot';

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('调试面 · DOM 结构快照', () => {
  it('欢迎页：phase=welcome，卡片计数与动作按钮读数', () => {
    const doc = mount(`
      <div class="welcome welcome-screen" data-context-surface="welcome">
        <div class="welcome-card" role="region"></div>
        <button class="primary big welcome-open">打开文件夹…</button>
        <p class="notice warn welcome-notice">一条通知</p>
      </div>`);
    const snap = snapshotDocument(doc);
    expect(snap.phase).toBe('welcome');
    expect(snap.welcome?.count).toBe(1);
    expect(snap.welcome?.items?.[0]).toContain('打开');
    expect(snap.notices.count).toBe(1);
    expect(snap.tabs.count).toBe(0);
  });

  it('项目态：phase=project，标签 / 文件树 / 面板 / 状态栏 / 弹窗全读', () => {
    const doc = mount(`
      <div class="file-tree"><ul class="tree-groups"><li class="tree-file" title="X.ERB">X.ERB</li></ul></div>
      <div class="editor-tabs-bar"><span class="tab-label">X.ERB</span></div>
      <div class="panel panel-convention-report">报告</div>
      <div class="panel panel-kojo-navigator">导航</div>
      <span data-status-cell="">UTF-8</span>
      <div class="modal-mask"><div class="modal" role="dialog" aria-label="写权限确认"></div></div>`);
    const snap = snapshotDocument(doc);
    expect(snap.phase).toBe('project');
    expect(snap.tabs.count).toBe(1);
    expect(snap.treeFiles.count).toBe(1);
    expect(snap.panels.items).toEqual(['convention-report', 'kojo-navigator']);
    expect(snap.statusbar.count).toBe(1);
    expect(snap.modals.count).toBe(1);
    expect(snap.modals.items?.[0]).toBe('写权限确认');
  });

  it('主题档从 documentElement 读；超长文本截断带省略号', () => {
    document.documentElement.setAttribute('data-theme', 'mint-dark');
    const doc = mount(`<p class="notice">${'长'.repeat(300)}</p>`);
    const snap = snapshotDocument(doc);
    expect(snap.theme).toBe('mint-dark');
    expect(snap.notices.items?.[0]).toMatch(/…$/);
    expect((snap.notices.items?.[0] as string).length).toBeLessThan(130);
    document.documentElement.removeAttribute('data-theme');
  });

  it('什么都没有 ⇒ unknown 相位，读数全零不抛', () => {
    const snap = snapshotDocument(mount(''));
    expect(snap.phase).toBe('unknown');
    expect(snap.welcome).toBeNull();
    expect(snap.tabs.count).toBe(0);
  });
});
