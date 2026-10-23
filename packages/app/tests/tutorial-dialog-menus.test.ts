// @vitest-environment happy-dom
/**
 * 教程面 + 输入框/模态/确认框的右键判据（1023 覆盖面批 · WP4.8 / WP4.10）。
 *
 * 两段判据各钉一件事：
 *
 * **A. 教程面**（`tutorial`）——插件与宿主的**标记契约**是这一面的全部约定：
 * 教程浮层由内置教程插件渲染，宿主只按 DOM 标记认"这是代码块 / 目录条目 / 链接"。
 * 所以这里铺一份**按契约结构生成的教程 DOM**（节数 / 样例数取自教程正文的真实数据，
 * 不是随手编的样例），再从它上面跑 `readTutorialTarget` / 菜单构建 / 三级路由；
 * 插件那一侧"真的把这些标记写在元素上"另用**源码断言**钉住（见 A1 末尾的说明：
 * 渲染器模块 import 'react'，而本仓根 `node_modules` 只在 `packages/app` 下装了一份，
 * 从这里直渲染会先倒在模块解析上——那不是契约问题，是工作树安装形态）。
 *
 * **B. 对话框**——确认框这类"是/否"界面不给业务项（右键就是兜底菜单），本批要防的是
 * 两件事：① 某个对话框自己 `onContextMenu` 把右键吞掉却不给菜单（静态扫源码钉住）；
 * ② 遮罩的 mousedown 不认键位，右键落在遮罩上会先关掉对话框再弹菜单（同款静态钉住）。
 *
 * 文案判据一律 `isChineseMenuLabel`（宿主渲染前的最后一道闸就是它）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUGAR_TUTORIAL } from '../../plugins/eratw-adapter/src/tutorial-content';
import { isChineseMenuLabel } from '../src/ui/context-menu-model';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import {
  TUTORIAL_MENU_IDS,
  buildTutorialMenu,
  buildTutorialMenuItems,
  readTutorialTarget,
  runTutorialMenuAction,
  type TutorialMenuTarget,
} from '../src/ui/tutorial-context-menu';

/* ------------------------------- 夹具 ------------------------------- */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const contextMenuEvent = (): MouseEvent =>
  new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 48 });

/**
 * 按**插件标记契约**铺一份教程 DOM（语法糖那本：节多、样例多，三类目标都齐）。
 *
 * 结构逐条对齐 `tutorial-overlay.ts` 的产出：根带 `data-context-surface="tutorial"`；
 * 左栏目录每条 `data-tutorial-section="<序号>"`；正文每个样例一块
 * `<pre class="tutorial-code" data-tutorial-code><code>…</code></pre>`；散文是普通 `<p>`。
 * 节数、样例、代码正文全部取自真实教程数据（写坏一个标记就会被下面的用例抓到）。
 */
function mountTutorial(): HTMLElement {
  const toc = SUGAR_TUTORIAL.sections
    .map(
      (section, i) =>
        `<button type="button" class="tutorial-toc-item" data-tutorial-section="${i}">${section.heading}</button>`,
    )
    .join('');
  const body = SUGAR_TUTORIAL.sections
    .map((section, i) => {
      const samples = (section.samples ?? [])
        .map(
          (sample) =>
            `<pre class="tutorial-code" data-tutorial-code><code>${sample.kojo}</code></pre>` +
            (sample.erb ? `<pre class="tutorial-code" data-tutorial-code><code>${sample.erb}</code></pre>` : ''),
        )
        .join('');
      return (
        `<div class="tutorial-section" id="tu-sugar-s${i}">` +
        `<h4>${section.heading}</h4>` +
        section.paragraphs.map((p) => `<p>${p}</p>`).join('') +
        samples +
        '</div>'
      );
    })
    .join('');
  document.body.innerHTML =
    `<div class="wizard tutorial" data-context-surface="tutorial">` +
    '<div class="tutorial-head"><h3>title</h3><p class="tutorial-lead">lead</p></div>' +
    `<div class="tutorial-main"><nav class="tutorial-toc">${toc}</nav>` +
    `<div class="tutorial-body"><div class="tutorial-doc">${body}</div></div></div>` +
    '</div>';
  const root = document.body.querySelector<HTMLElement>('[data-context-surface="tutorial"]');
  if (root === null) throw new Error('教程根缺 data-context-surface="tutorial"');
  return root;
}

/** 取第一个代码块里的 `<code>`（右键真正落在这上面，不是 `<pre>` 上） */
function firstCodeChild(root: HTMLElement): HTMLElement {
  const node = root.querySelector<HTMLElement>('[data-tutorial-code] code');
  if (node === null) throw new Error('教程里没有代码块');
  return node;
}

const codeTarget: TutorialMenuTarget = {
  kind: 'code',
  element: document.createElement('pre'),
  text: '角色: 12\n时机 初见：',
};
const sectionTarget: TutorialMenuTarget = {
  kind: 'section',
  element: document.createElement('button'),
  index: 2,
};
const linkTarget = (href: string): TutorialMenuTarget => ({
  kind: 'link',
  element: document.createElement('a'),
  href,
});

beforeEach(() => {
  document.body.innerHTML = '';
});

/* ----------------------- A1. 插件侧的标记契约 ----------------------- */

describe('教程浮层的右键标记（插件侧契约）', () => {
  it('根元素带 data-context-surface="tutorial"（宿主按它认面）', () => {
    const root = mountTutorial();
    expect(root.classList.contains('tutorial')).toBe(true);
  });

  it('每个代码块都带 data-tutorial-code（左右对照的两半都算）', () => {
    const root = mountTutorial();
    const pres = [...root.querySelectorAll('pre')];
    const codes = [...root.querySelectorAll<HTMLElement>('[data-tutorial-code]')];
    expect(pres.length).toBeGreaterThan(0);
    // 教程里的 <pre> 全部是代码块：标记漏一个就等于那个块右键没菜单
    expect(codes.length).toBe(pres.length);
    for (const code of codes) expect(code.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('目录条目的 data-tutorial-section 是 0..n-1 连续序号（跳转靠它定位）', () => {
    const root = mountTutorial();
    const items = [...root.querySelectorAll<HTMLElement>('.tutorial-toc-item')];
    expect(items.length).toBe(SUGAR_TUTORIAL.sections.length);
    items.forEach((item, i) => {
      expect(item.getAttribute('data-tutorial-section'), item.textContent ?? '').toBe(String(i));
    });
  });

  it('标记不抢读屏与焦点（无 role / 无 tabindex 改动，代码块仍是纯文本块）', () => {
    const root = mountTutorial();
    for (const code of root.querySelectorAll('[data-tutorial-code]')) {
      expect(code.hasAttribute('role')).toBe(false);
      expect(code.hasAttribute('tabindex')).toBe(false);
    }
  });

  /**
   * 契约在**插件那一侧**真的落地了（源码断言）。
   *
   * 为什么是源码断言而不是再渲染一遍：渲染器 `tutorial-overlay.ts` import 'react'，
   * 而本仓的 react 只装在 `packages/app/node_modules` 下（根 `node_modules` 没有），
   * 从这里直渲染会先倒在模块解析上——那是工作树的安装形态，不是契约问题。
   * 三个标记各钉一处，插件侧漏写哪个都会在这里红。
   */
  it('插件渲染器里写着三处标记（少了任何一个，这一面就哑了）', () => {
    const src = read('../../plugins/eratw-adapter/src/tutorial-overlay.ts');
    expect(src).toContain("'data-context-surface': 'tutorial'");
    expect(src).toContain("'data-tutorial-code': ''");
    expect(src).toContain("'data-tutorial-section': String(index)");
  });
});

/* --------------------- A2. 目标识别（宿主侧读 DOM） --------------------- */

describe('readTutorialTarget · 认目标', () => {
  it('代码块内部的 <code> 上右键 ⇒ 代码目标，正文逐字取自 DOM', () => {
    const root = mountTutorial();
    const child = firstCodeChild(root);
    const target = readTutorialTarget(child);
    expect(target?.kind).toBe('code');
    if (target?.kind !== 'code') throw new Error('应识别为代码块');
    const pre = child.closest('[data-tutorial-code]');
    expect(target.text).toBe(pre?.textContent);
  });

  it('目录条目上右键 ⇒ 章节目标，带序号', () => {
    const root = mountTutorial();
    const item = root.querySelectorAll<HTMLElement>('.tutorial-toc-item')[3];
    if (item === undefined) throw new Error('目录条目不足');
    const target = readTutorialTarget(item.querySelector('span') ?? item);
    expect(target).toEqual({ kind: 'section', element: item, index: 3 });
  });

  it('链接上右键 ⇒ 链接目标（拿 href，不拿显示文字）', () => {
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/doc';
    anchor.textContent = '看这里';
    document.body.appendChild(anchor);
    const target = readTutorialTarget(anchor);
    expect(target?.kind).toBe('link');
    if (target?.kind !== 'link') throw new Error('应识别为链接');
    expect(target.href).toBe('https://example.com/doc');
  });

  it('没有 href 的 <a> 与正文散文都不认（返回 null ⇒ 走兜底）', () => {
    const bare = document.createElement('a');
    bare.textContent = '不是链接';
    document.body.appendChild(bare);
    expect(readTutorialTarget(bare)).toBeNull();

    const root = mountTutorial();
    const prose = root.querySelector('.tutorial-lead');
    if (prose === null) throw new Error('教程缺导语');
    expect(readTutorialTarget(prose as HTMLElement)).toBeNull();
  });
});

/* ------------------------- A3. 菜单项集合与文案 ------------------------- */

describe('buildTutorialMenuItems · 每个作用域给什么', () => {
  it('代码块：复制代码 / 全选代码', () => {
    const items = buildTutorialMenuItems(codeTarget, { canCopy: true });
    expect(items.map((i) => i.label)).toEqual(['复制代码', '全选代码']);
    expect(items.map((i) => i.id)).toEqual([TUTORIAL_MENU_IDS.copyCode, TUTORIAL_MENU_IDS.selectCode]);
  });

  it('代码块 · 没有剪贴板：复制代码禁用并说明为什么，全选代码仍可用', () => {
    const items = buildTutorialMenuItems(codeTarget, { canCopy: false });
    const copy = items.find((i) => i.id === TUTORIAL_MENU_IDS.copyCode);
    expect(copy?.disabled).toBe(true);
    expect(copy?.disabledReason).toContain('剪贴板');
    expect(items.find((i) => i.id === TUTORIAL_MENU_IDS.selectCode)?.disabled).toBeUndefined();
  });

  it('章节导航项：跳到这一节', () => {
    expect(buildTutorialMenuItems(sectionTarget, { canCopy: true }).map((i) => i.label)).toEqual([
      '跳到这一节',
    ]);
  });

  it('https 链接：复制链接 + 在浏览器打开', () => {
    const labels = buildTutorialMenuItems(linkTarget('https://example.com/a'), { canCopy: true }).map(
      (i) => i.label,
    );
    expect(labels).toEqual(['复制链接', '在浏览器打开']);
  });

  it('非 https 链接：只给复制链接（外链闸只放 https，不给点了必被拒的按钮）', () => {
    for (const href of ['mailto:a@b.c', 'http://example.com', 'file:///tmp/x', '#anchor']) {
      expect(
        buildTutorialMenuItems(linkTarget(href), { canCopy: true }).map((i) => i.label),
        href,
      ).toEqual(['复制链接']);
    }
  });

  it('四类目标的文案全中文，且不编快捷键（本面无命令，键位只能来自命令表）', () => {
    const all = [
      ...buildTutorialMenuItems(codeTarget, { canCopy: true }),
      ...buildTutorialMenuItems(sectionTarget, { canCopy: true }),
      ...buildTutorialMenuItems(linkTarget('https://example.com'), { canCopy: true }),
      ...buildTutorialMenuItems(codeTarget, { canCopy: false }),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const item of all) {
      expect(isChineseMenuLabel(item.label), item.id).toBe(true);
      expect(item.shortcut, item.id).toBeUndefined();
    }
  });

  it('面菜单是 { items, onSelect } 对象形态（数组形态点了不做事）', () => {
    const menu = buildTutorialMenu(codeTarget, { canCopy: true });
    expect(Array.isArray(menu)).toBe(false);
    expect(typeof menu?.onSelect).toBe('function');
  });
});

/* ---------------------------- A4. 动作 ---------------------------- */

describe('runTutorialMenuAction · 只借现成能力', () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    });
  });

  it('复制代码：整块文本进剪贴板', () => {
    expect(runTutorialMenuAction(codeTarget, TUTORIAL_MENU_IDS.copyCode)).toBe(true);
    expect(written).toEqual([codeTarget.kind === 'code' ? codeTarget.text : '']);
  });

  it('复制链接：写的是 href', () => {
    const target = linkTarget('https://example.com/doc');
    expect(runTutorialMenuAction(target, TUTORIAL_MENU_IDS.copyLink)).toBe(true);
    expect(written).toEqual(['https://example.com/doc']);
  });

  it('全选代码：选区只圈住这一块，不漏到整页', () => {
    const pre = document.createElement('pre');
    pre.setAttribute('data-tutorial-code', '');
    pre.textContent = '角色: 12';
    document.body.appendChild(pre);
    const outside = document.createElement('p');
    outside.textContent = '正文不该被选中';
    document.body.appendChild(outside);

    expect(runTutorialMenuAction({ kind: 'code', element: pre, text: '角色: 12' }, TUTORIAL_MENU_IDS.selectCode)).toBe(
      true,
    );
    const selected = window.getSelection()?.toString() ?? '';
    expect(selected).toContain('角色: 12');
    expect(selected).not.toContain('正文不该被选中');
  });

  it('跳到这一节：点一下那条目录项（跳转仍是插件那一条实现）', () => {
    const button = document.createElement('button');
    let clicks = 0;
    button.addEventListener('click', () => {
      clicks += 1;
    });
    document.body.appendChild(button);
    expect(runTutorialMenuAction({ kind: 'section', element: button, index: 0 }, TUTORIAL_MENU_IDS.jumpSection)).toBe(
      true,
    );
    expect(clicks).toBe(1);
  });

  it('在浏览器打开：只对 https 发起；别的协议直接 false（不发注定被拒的请求）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const https = linkTarget('https://example.com/doc');
    expect(runTutorialMenuAction(https, TUTORIAL_MENU_IDS.openLink)).toBe(true);
    // 测试环境没有 Tauri IPC ⇒ 平台原语必然拒绝：把拒绝那拍吃掉，别让日志漏到用例外面
    await Promise.resolve();
    await Promise.resolve();
    expect(runTutorialMenuAction(linkTarget('mailto:a@b.c'), TUTORIAL_MENU_IDS.openLink)).toBe(false);
    warn.mockRestore();
  });

  it('目标与动作不匹配、或 id 不认识 ⇒ false，不抛', () => {
    expect(runTutorialMenuAction(sectionTarget, TUTORIAL_MENU_IDS.copyCode)).toBe(false);
    expect(runTutorialMenuAction(codeTarget, 'tutorial.不存在的动作')).toBe(false);
  });
});

/* ------------------------- A5. 三级路由里的位置 ------------------------- */

describe('三级路由 · 教程面', () => {
  it('代码块右键命中教程面，用面自己的无障碍名，菜单全中文', () => {
    const root = mountTutorial();
    const route = buildContextMenuRoute(firstCodeChild(root), contextMenuEvent());
    expect(route?.source).toBe('tutorial');
    expect(route?.ariaLabel).toBe('教程菜单');
    expect(route?.items.length).toBeGreaterThan(0);
    for (const item of route?.items ?? []) expect(isChineseMenuLabel(item.label), item.id).toBe(true);
  });

  it('目录条目右键也命中教程面', () => {
    const root = mountTutorial();
    const item = root.querySelector<HTMLElement>('.tutorial-toc-item');
    if (item === null) throw new Error('教程缺目录条目');
    expect(buildContextMenuRoute(item, contextMenuEvent())?.source).toBe('tutorial');
  });

  it('抬头 / 导语这些没标记的地方不表态 ⇒ 落到兜底菜单（复制 / 全选仍是通用的）', () => {
    const root = mountTutorial();
    const lead = root.querySelector<HTMLElement>('.tutorial-lead');
    if (lead === null) throw new Error('教程缺导语');
    const route = buildContextMenuRoute(lead, contextMenuEvent());
    expect(route?.source).toBe('app-fallback');
    expect(route?.items.length).toBeGreaterThan(0);
  });

  it('面分发接到动作上（选中即执行，不是只展示）', () => {
    const root = mountTutorial();
    const item = root.querySelectorAll<HTMLElement>('.tutorial-toc-item')[1];
    if (item === undefined) throw new Error('目录条目不足');
    let clicks = 0;
    item.addEventListener('click', () => {
      clicks += 1;
    });
    const route = buildContextMenuRoute(item, contextMenuEvent());
    route?.onSelect(TUTORIAL_MENU_IDS.jumpSection);
    expect(clicks).toBe(1);
  });
});

/* ------------------------- B. 对话框的右键行为 ------------------------- */

/** 本批核查的对话框（含两个浮层宿主：教程浮层的关闭也走遮罩 mousedown） */
const DIALOG_FILES = [
  'DevNoteDialog.tsx',
  'UpdateDialog.tsx',
  'SaveWarningDialog.tsx',
  'UnsavedConfirmDialog.tsx',
  'UnsavedFilesConfirmDialog.tsx',
  'WritableApprovalDialog.tsx',
  'QuickFixPreviewOverlay.tsx',
  'WelcomeOverlayHost.tsx',
];

const readUi = (file: string): string => read(`../src/ui/${file}`);

describe('对话框 · 右键不被吞（静态钉住）', () => {
  it('没有任何对话框「只 preventDefault、不给菜单」', () => {
    for (const file of DIALOG_FILES) {
      const src = readUi(file);
      if (!src.includes('onContextMenu')) continue;
      // 自己接管右键就必须把菜单交回去（openContextMenu / buildFallbackMenu），否则点了什么都不出
      expect(
        src.includes('openContextMenu') || src.includes('buildFallbackMenu'),
        `${file} 拦了右键却没给菜单`,
      ).toBe(true);
    }
  });

  it('遮罩上的按下只认左键（右键是开菜单，不是关浮层）', () => {
    for (const file of DIALOG_FILES) {
      const src = readUi(file);
      if (!src.includes('onMouseDown')) continue;
      expect(src.includes('button !== 0'), `${file} 的 mousedown 没认键位`).toBe(true);
    }
  });

  it('对话框仍走宿主模态栈的 Esc（焦点锁与键盘语义本批一字未动）', () => {
    for (const file of DIALOG_FILES) {
      // QuickFixPreviewOverlay 的 Esc 由壳层全局键盘承接（它自己不用 useModalEscape）；
      // WelcomeOverlayHost 自备同语义的 Esc（无项目态没有壳层键盘层）——两者都在文件头注里写明。
      if (file === 'QuickFixPreviewOverlay.tsx' || file === 'WelcomeOverlayHost.tsx') continue;
      expect(readUi(file).includes('useModalEscape'), file).toBe(true);
    }
  });
});

describe('对话框 · 右键给的是兜底菜单', () => {
  it('确认框内部右键 ⇒ 通用兜底菜单，非空、全中文', () => {
    document.body.innerHTML = [
      '<div data-context-surface="app-fallback">',
      '  <div class="modal-mask">',
      '    <div class="modal" role="dialog" aria-modal="true" aria-label="有未保存的修改">',
      '      <p>有未保存的修改。关闭前请选择处理方式：</p>',
      '      <div class="modal-actions"><button>取消</button><button>丢弃修改</button></div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
    const button = document.body.querySelector('button');
    if (button === null) throw new Error('确认框缺按钮');
    const route = buildContextMenuRoute(button, contextMenuEvent());
    expect(route?.source).toBe('app-fallback');
    expect(route?.items.length).toBeGreaterThan(0);
    for (const item of route?.items ?? []) expect(isChineseMenuLabel(item.label), item.id).toBe(true);
  });

  it('确认框里不掺业务项（这批不给是/否界面加专属动作）', () => {
    document.body.innerHTML = '<div data-context-surface="app-fallback"><div class="modal"><p>保存提醒</p></div></div>';
    const modal = document.body.querySelector('.modal');
    if (modal === null) throw new Error('确认框缺面板');
    const route = buildContextMenuRoute(modal as HTMLElement, contextMenuEvent());
    for (const item of route?.items ?? []) {
      expect(item.id.startsWith('tutorial.'), item.id).toBe(false);
    }
  });

  it('对话框里的输入框右键 ⇒ 输入框面（撤销 / 剪切 / 复制那一套，不被遮罩吞掉）', () => {
    document.body.innerHTML = [
      '<div data-context-surface="app-fallback">',
      '  <div class="modal-mask"><div class="modal" role="dialog"><textarea>备注</textarea></div></div>',
      '</div>',
    ].join('');
    const textarea = document.body.querySelector('textarea');
    if (textarea === null) throw new Error('缺输入框');
    const route = buildContextMenuRoute(textarea, contextMenuEvent());
    expect(route?.source).toBe('input');
    expect(route?.ariaLabel).toBe('输入框菜单');
    expect(route?.items.map((i) => i.label)).toContain('粘贴');
  });
});
