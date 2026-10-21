// @vitest-environment happy-dom
/**
 * SAVE-BUTTON-IO-SEAM（出路②，2026-10-21）：每个文件那颗保存按钮的可用性判定**同时认宿主那份事实**。
 *
 * 上一批（出路①）把"宿主到底把写域交出来了没有"收成了 `write-domain.ts` 的独立事实，但那只管到
 * **项目级** UI（横幅 / 状态栏胶囊 / 常驻错误条）；`EditorPane` 的保存仍按 `kernel.io.isWritable`
 * （TS 批准记录）判定 ⇒ 宿主拒过的目录里解锁后保存按钮物理上仍可点、按下才吃内核域外拒绝。
 * 本批定案走出路②：**按下去必然失败的动作根本按不了**——按钮置灰 + 可达性指回常驻错误条。
 * 判据红线（本文件逐条钉住）：
 * ① 宿主拒绝态 ⇒ 保存按钮 disabled（DOM 断言）；
 * ② 已在册可写目录（宿主交付成功 / 浏览器壳 not-hosted）⇒ 按钮照旧 enabled（防误伤）；
 * ③ 置灰的按钮以 `aria-describedby` 指向常驻错误条，那条错误条上就挂着「重新选择这个文件夹」
 *   ——焦点/出路的交接是可达的（不强行 focus()，切标签抢编辑器焦点比按不动更打扰作者）；
 * ④ 判定只覆盖**被拒项目目录之下**的路径：作者工作区、常驻可写根、别的项目一概不受影响；
 * ⑤ 写域没放宽：内核 `kernel.io.isWritable` 与 Rust 准入门一字未动，这里只加"读同一份事实"的闸。
 *
 * 挂载设施：`SaveButton` / `ProjectErrorNotice` 都是纯展示组件（零 Monaco、零 kernel）⇒ 真 DOM 断言；
 * `EditorPane` 那三处接线沿用源码切片取证（同 `editor-pane-write-veto.test.ts` 的手法与理由）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SaveButton } from '../src/ui/save-button';
import { ProjectErrorNotice, projectErrorNoticeId, type ProjectErrorBar } from '../src/ui/project-error-notice';
import {
  getSessionWriteDomainFact,
  initialWriteDomainFact,
  saveBlockedByHostWriteDomain,
  setSessionWriteDomainFact,
  writeDomainFixAction,
  writeDomainRedeliverLabel,
  writeDomainRefusedMessage,
  writeDomainSaveBlockedMessage,
} from '../src/ui/write-domain';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REFUSED: typeof initialWriteDomainFact = {
  dir: 'C:\\game\\eratw-未交付',
  grant: 'refused',
  reason: '该目录未经系统对话框交付',
};

beforeEach(() => {
  setSessionWriteDomainFact(initialWriteDomainFact);
});

describe('1 · 判定本体：同一份宿主事实，只挡被拒目录之下', () => {
  it('未登记 / 交付成功 / 浏览器壳 ⇒ 一律放行（判据不许在没有拒绝事实时扩大）', () => {
    expect(saveBlockedByHostWriteDomain('C:\\game\\eratw-未交付\\a.ERB')).toBe(false);
    setSessionWriteDomainFact({ dir: 'C:\\game\\eratw-未交付', grant: 'granted', reason: null });
    expect(saveBlockedByHostWriteDomain('C:\\game\\eratw-未交付\\a.ERB')).toBe(false);
    setSessionWriteDomainFact({ dir: 'C:\\game\\eratw-未交付', grant: 'not-hosted', reason: null });
    expect(saveBlockedByHostWriteDomain('C:\\game\\eratw-未交付\\a.ERB')).toBe(false);
  });

  it('拒绝态只挡被拒项目目录**之下**的路径（工作区 / 常驻可写根 / 别的项目零影响）', () => {
    setSessionWriteDomainFact(REFUSED);
    expect(saveBlockedByHostWriteDomain('C:\\game\\eratw-未交付\\dir\\a.ERB')).toBe(true);
    // Windows 大小写与分隔符折叠同一把尺子（plugin-api pathKey/isPathUnder 口径）
    expect(saveBlockedByHostWriteDomain('c:/game/ERATW-未交付/a.ERB')).toBe(true);
    // 作者工作区（AppData）、常驻可写根、同名前缀但并非子目录的路径、别的项目——全都不挡
    expect(saveBlockedByHostWriteDomain('C:\\Users\\me\\AppData\\Roaming\\dev.kojo.editor\\workspace\\a.ERB')).toBe(false);
    expect(saveBlockedByHostWriteDomain('C:\\game\\eratw-未交付备份\\a.ERB')).toBe(false);
    expect(saveBlockedByHostWriteDomain('C:\\game\\eraAkumaMaid\\a.ERB')).toBe(false);
  });

  it('拒绝态读的是会话单里同一份事实（getSessionWriteDomainFact = 出路① 的那一份，无第二真源）', () => {
    setSessionWriteDomainFact(REFUSED);
    expect(getSessionWriteDomainFact()).toBe(REFUSED);
    expect(saveBlockedByHostWriteDomain('C:\\game\\eratw-未交付\\a.ERB')).toBe(true);
  });
});

describe('2 · DOM：宿主拒绝态 ⇒ 保存按钮 disabled（判据①②）', () => {
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

  function renderSaveButton(dirty: boolean, hostBlocked: boolean, onSave = () => undefined): void {
    void act(() => {
      root.render(h(SaveButton, { dirty, hostBlocked, onSave }));
    });
  }

  it('脏 + 宿主拒绝 ⇒ 渲染但 disabled，title 说清原因与出路', () => {
    renderSaveButton(true, true);
    const button = container.querySelector('button') as HTMLButtonElement | null;
    expect(button, '拒绝态按钮必须还在屏上（不是整颗消失）').toBeTruthy();
    expect(button!.disabled, '宿主拒绝态 ⇒ 保存按钮必须按不动').toBe(true);
    expect(button!.textContent).toBe('保存 (Ctrl+S)');
    expect(button!.title).toBe(writeDomainSaveBlockedMessage);
  });

  it('脏 + 已在册可写（宿主交付成功）⇒ 照旧 enabled，点击照常进保存链（防误伤）', async () => {
    setSessionWriteDomainFact({ dir: 'C:\\game\\eraAkumaMaid', grant: 'granted', reason: null });
    const onSave = vi.fn();
    const blocked = saveBlockedByHostWriteDomain('C:\\game\\eraAkumaMaid\\a.ERB');
    renderSaveButton(true, blocked, onSave);
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled, '交付成功的目录里按钮绝不允许被置灰').toBe(false);
    await act(async () => {
      button.click();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('无改动仍是 .idle 弱化档（P3-4 三段式口径零改动）；拒绝态叠加 idle 类不变', () => {
    renderSaveButton(false, false);
    expect((container.querySelector('button') as HTMLButtonElement).className).toBe('primary small idle');
    renderSaveButton(false, true);
    expect((container.querySelector('button') as HTMLButtonElement).className).toBe('primary small idle');
    renderSaveButton(true, false);
    expect((container.querySelector('button') as HTMLButtonElement).className).toBe('primary small');
  });
});

describe('3 · 可达性：置灰按钮指回常驻错误条，出路就在指间（判据③）', () => {
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

  it('aria-describedby 指向错误条；错误条上挂着「重新选择这个文件夹」那颗出路按钮', () => {
    setSessionWriteDomainFact(REFUSED);
    const bar: ProjectErrorBar = {
      message: writeDomainRefusedMessage(REFUSED),
      action: writeDomainFixAction(() => undefined),
    };
    const filePath = 'C:\\game\\eratw-未交付\\a.ERB';
    void act(() => {
      root.render(
        h(
          'div',
          null,
          h(ProjectErrorNotice, { message: bar.message, action: bar.action, onDismiss: () => undefined }),
          h(SaveButton, {
            dirty: true,
            hostBlocked: saveBlockedByHostWriteDomain(filePath),
            onSave: () => undefined,
          }),
        ),
      );
    });
    const button = container.querySelector('button.primary') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy, '置灰的按钮必须把作者指到那条常驻错误条上').toBe(projectErrorNoticeId);
    const barEl = container.querySelector(`#${projectErrorNoticeId}`);
    expect(barEl, 'aria-describedby 指向的 id 必须真实在屏上').toBeTruthy();
    const fix = [...barEl!.querySelectorAll('button')].find((b) => b.textContent === writeDomainRedeliverLabel);
    expect(fix, '错误条上的出路按钮必须可达').toBeTruthy();
    expect(writeDomainSaveBlockedMessage).toContain(writeDomainRedeliverLabel);
  });

  it('非拒绝态按钮不带 aria-describedby（关联不许变成常驻 chrome）', () => {
    void act(() => {
      root.render(h(SaveButton, { dirty: true, hostBlocked: false, onSave: () => undefined }));
    });
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(button.title).toBe('');
  });
});

describe('4 · EditorPane 接线（源码切片取证，手法同 editor-pane-write-veto）', () => {
  const SOURCE = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'),
    'utf8',
  );

  it('工具条那颗保存换挂在 SaveButton 上，hostBlocked 现读同一判定', () => {
    expect(SOURCE).toContain("import { SaveButton } from './save-button';");
    expect(SOURCE).toContain('hostBlocked={saveBlockedByHostWriteDomain(filePath)}');
    // 整颗不渲染的 P3-4 前置条件留在调用方（kernel.io.isWritable 为假 ⇒ 照旧不画）
    expect(SOURCE).toMatch(/kernel\.io\.isWritable\(filePath\) \? \(\s*<SaveButton/);
    // 本文件不再另存一份裸的保存按钮 JSX
    expect(SOURCE).not.toContain('保存 (Ctrl+S)');
  });

  it('savePathDetailed 的前置拦截排在既有 isWritable 拦截之前，quiet（全保存）不轰炸', () => {
    const guard = SOURCE.slice(
      SOURCE.indexOf('if (saveBlockedByHostWriteDomain(path)) {'),
      SOURCE.indexOf('if (!kernel.io.isWritable(path)) {'),
    );
    expect(guard.length, '找不到保存前置拦截').toBeGreaterThan(0);
    expect(guard).toContain("if (!quiet) notify({ kind: 'error', message: writeDomainSaveBlockedMessage })");
    expect(guard).toContain("return { path, status: 'failed', message: writeDomainSaveBlockedMessage }");
  });

  it('自动保存读同一个判定（必然被拒的路径不再白敲 IPC），且没动内核写域判定本身', () => {
    expect(SOURCE).toContain('writable: kernel.io.isWritable(path) && !saveBlockedByHostWriteDomain(path)');
    // 既有的六处 `kernel.io.isWritable` 判定一字未放宽（直连 / EOL 门 / 保存闸 / 自动保存 /
    // 状态上报 / 直连提示都还在；本批只在其上**追加**读宿主事实的闸，不替换、不删）
    expect(SOURCE.split('kernel.io.isWritable(').length - 1).toBe(6);
  });
});
