import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UpdateDialog } from '../src/ui/UpdateDialog';
import { UPDATE_NOTE_LINE_LIMIT, type UpdateDialogPhase } from '../src/ui/update-check';

/**
 * 更新弹窗的渲染面（用户反馈第 1 条）。
 *
 * 环境是 node + `renderToStaticMarkup`：不跑 effect、不碰 DOM，只钉**静态可读性**的那几条——
 * 标题 / 当前版本 / 发布日期 / 说明逐行、空说明的人话、超长说明的截断提示、进度与按钮态、
 * dialog 的 aria 骨架。焦点陷阱与 Esc 走的是浏览器生命周期，交给真壳冒烟，不在这假装。
 */

const noop = (): void => {};

const html = (phase: UpdateDialogPhase): string =>
  renderToStaticMarkup(createElement(UpdateDialog, { phase, onClose: noop, onInstall: noop }));

/** 本地正午的 ISO：任何时区渲染回来都还是同一天 */
const DATE = new Date(2026, 9, 17, 12, 0, 0).toISOString();

describe('UpdateDialog：found', () => {
  it('标题 / 当前版本 / 发布日期 / 说明逐行渲染，右下两颗动作齐备', () => {
    const out = html({
      kind: 'found',
      version: '0.5.0',
      currentVersion: '0.4.0',
      date: DATE,
      notes: '## 修复\r\n\r\n- 甲\r\n- 乙',
    });
    expect(out).toContain('发现新版本 v0.5.0');
    expect(out).toContain('当前版本 v0.4.0');
    expect(out).toContain('发布于 2026-10-17');
    expect(out).toContain('<p class="update-dialog-note-line">## 修复</p>');
    expect(out).toContain('<p class="update-dialog-note-line">- 甲</p>');
    expect(out).toContain('<p class="update-dialog-note-line is-blank" aria-hidden="true"></p>');
    expect(out).toContain('>稍后<');
    expect(out).toContain('>下载并安装<');
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby=');
  });

  it('说明为空 ⇒ 一句人话，不留空白井', () => {
    const out = html({ kind: 'found', version: '0.5.0', currentVersion: '0.4.0' });
    expect(out).toContain('这个版本没有附更新说明。');
    expect(out).not.toContain('class="update-dialog-notes"');
    // 当前版本在、日期不在：元信息行只画那一格，不出现空分隔
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
});

describe('UpdateDialog：downloading / done / failed', () => {
  it('downloading：进度条 + 百分比/字节；主按钮禁用，关闭出口仍在（后台下载）', () => {
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
    expect(out).toMatch(/<button type="button" class="primary" disabled="">正在下载…<\/button>/);
    expect(out).toContain('aria-label="关闭更新面板"');
  });

  it('总量未知：进度条转不定态，仍报已下载字节', () => {
    const out = html({
      kind: 'downloading',
      version: '0.5.0',
      received: 512,
      total: null,
    });
    expect(out).toContain('data-indeterminate="true"');
    expect(out).toContain('正在下载安装…');
    expect(out).toContain('已下载 512 B');
  });

  it('done：重启应用后生效，只留一个关闭', () => {
    const out = html({ kind: 'done', version: '0.5.0', currentVersion: '0.4.0' });
    expect(out).toContain('已安装 v0.5.0');
    expect(out).toContain('重启应用后生效');
    expect(out).toContain('>关闭<');
    expect(out).not.toContain('下载并安装');
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
