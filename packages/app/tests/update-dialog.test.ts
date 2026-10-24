import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UpdateDialog } from '../src/ui/UpdateDialog';
import { UPDATE_NOTE_LINE_LIMIT, type UpdateDialogPhase } from '../src/ui/update-check';

/**
 * 更新弹窗（详情模态）的渲染面（用户反馈第 1 条 · 批次十一 L05 重做后同步）。
 *
 * 环境是 node + `renderToStaticMarkup`：不跑 effect、不碰 DOM，只钉**静态可读性**的那几条——
 * 标题 / 当前版本 / 发布日期 / **语义分组**、外链锚点、空说明的人话、超长说明的截断提示、
 * **状态与动作分离**（下载态页脚无假按钮）、完成态重启出口、dialog 的 aria 骨架。
 * 焦点陷阱与 Esc 走的是浏览器生命周期，交给真壳冒烟，不在这假装。
 */

const noop = (): void => {};

const html = (phase: UpdateDialogPhase, extra?: { onRestart?: () => void; forced?: boolean }): string =>
  renderToStaticMarkup(
    createElement(UpdateDialog, { phase, onClose: noop, onInstall: noop, ...extra }) as ReactElement,
  );

/** 本地正午的 ISO：任何时区渲染回来都还是同一天 */
const DATE = new Date(2026, 9, 17, 12, 0, 0).toISOString();

describe('UpdateDialog：found', () => {
  it('标题 / 当前版本 / 发布日期齐备；changelog 按语义分组渲染（组名 + 归组行）', () => {
    const out = html({
      kind: 'found',
      version: '0.5.0',
      currentVersion: '0.4.0',
      date: DATE,
      notes: '## 修复\n- 甲\n## 新增\n- 乙',
    });
    expect(out).toContain('发现新版本 v0.5.0');
    expect(out).toContain('当前版本 v0.4.0');
    expect(out).toContain('发布于 2026-10-17');
    // 分组：已知小节题被组名吸收，行按组落位；展示序「新增」在「修复」前
    expect(out).toContain('data-group="added"');
    expect(out).toContain('data-group="fixed"');
    expect(out).toContain('>新增<');
    expect(out).toContain('<p class="update-dialog-note-line"><span>- 乙</span></p>');
    expect(out.indexOf('data-group="added"')).toBeLessThan(out.indexOf('data-group="fixed"'));
  });

  it('说明里的 URL 渲染成原生外链锚点（target=_blank + rel=noopener），不裸 window.open', () => {
    const out = html({ kind: 'found', version: '0.5.0', notes: '详见 https://example.com/releases，见上' });
    expect(out).toContain(
      '<a class="update-dialog-note-link" href="https://example.com/releases" target="_blank" rel="noopener noreferrer">https://example.com/releases</a>',
    );
  });

  it('破坏性说明：data-severity 顶缘警示 + 标题旁警示牌；forced 时牌上多一句「需确认」', () => {
    const out = html({ kind: 'found', version: '0.5.0', notes: '- 破坏性：存储格式变更' });
    expect(out).toContain('data-severity="breaking"');
    expect(out).toContain('破坏性更新');
    expect(out).not.toContain('需确认');
    const forcedOut = html({ kind: 'found', version: '0.5.0', notes: '- 破坏性：存储格式变更' }, { forced: true });
    expect(forcedOut).toContain('破坏性更新 · 需确认');
  });

  it('说明为空 ⇒ 一句人话，不留空白井', () => {
    const out = html({ kind: 'found', version: '0.5.0', currentVersion: '0.4.0' });
    expect(out).toContain('这个版本没有附更新说明。');
    expect(out).not.toContain('class="update-dialog-notes"');
    expect(out).toContain('当前版本 v0.4.0');
    expect(out).not.toContain('发布于');
    expect(out).not.toContain('update-dialog-meta-sep');
  });

  it('超长说明只画前 N 行，并明说截断（不是悄悄吞）', () => {
    const notes = Array.from({ length: UPDATE_NOTE_LINE_LIMIT + 1 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const out = html({ kind: 'found', version: '0.5.0', notes });
    expect(out).toContain('仅显示前 400 行（共 401 行）');
    expect(out).toContain('第 400 行');
    expect(out).not.toContain('第 401 行');
  });

  it('右下动作齐备：稍后 / 下载并安装；aria 骨架完整', () => {
    const out = html({ kind: 'found', version: '0.5.0' });
    expect(out).toContain('>稍后<');
    expect(out).toContain('>下载并安装<');
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby=');
  });
});

describe('UpdateDialog：downloading / done / failed', () => {
  it('downloading：进度条 + 百分比；状态在正文胶囊、页脚只剩真动作「后台下载」（无禁用假按钮）', () => {
    const out = html({
      kind: 'downloading',
      version: '0.5.0',
      currentVersion: '0.4.0',
      received: 512,
      total: 1024,
    });
    expect(out).toContain('正在下载 v0.5.0');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="50"');
    expect(out).toContain('已下载 512 B / 1.0 KB（50%）');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('后台下载');
    expect(out).toContain('class="update-dialog-status"');
    // 缺陷点：「正在下载…」不再是页脚那颗禁用按钮
    expect(out).not.toContain('disabled');
    expect(out).not.toContain('下载并安装');
    expect(out).toContain('aria-label="关闭更新面板"');
  });

  it('总量未知：进度条转不定态，胶囊仍在，右侧报已下载字节', () => {
    const out = html({
      kind: 'downloading',
      version: '0.5.0',
      received: 512,
      total: null,
    });
    expect(out).toContain('data-indeterminate="true"');
    expect(out).toContain('正在下载 v0.5.0…');
    expect(out).toContain('已下载 512 B');
  });

  it('done（宿主无重启通道）：重启应用后生效 + 只留一个关闭', () => {
    const out = html({ kind: 'done', version: '0.5.0', currentVersion: '0.4.0' });
    expect(out).toContain('已安装 v0.5.0');
    expect(out).toContain('重启应用后生效');
    expect(out).toContain('>关闭<');
    expect(out).not.toContain('立即重启');
    expect(out).not.toContain('下载并安装');
  });

  it('done（宿主给 onRestart）：主行动「立即重启」，出口「稍后重启」——缺按钮形态互斥', () => {
    const out = html({ kind: 'done', version: '0.5.0' }, { onRestart: noop });
    expect(out).toContain('>立即重启<');
    expect(out).toContain('>稍后重启<');
    expect(out).not.toContain('>关闭<');
    expect(out).toContain('请先保存手头的工作');
  });

  it('failed(install)：人话 + 重试 + 版本标题', () => {
    const out = html({
      kind: 'failed',
      stage: 'install',
      release: { version: '0.5.0', currentVersion: '0.4.0' },
    });
    expect(out).toContain('更新 v0.5.0 没有装好');
    expect(out).toContain('可重试');
    expect(out).toContain('>重试<');
    expect(out).toContain('role="alert"');
  });
});
