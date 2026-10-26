/**
 * 启动器模态版式（VIS-16 · D-3）与搜索井度量对齐（VIS-42 · D-10）的静态判据。
 *
 * 口径：这里钉的是"遮罩挂没挂上、面板还撑不撑满、左栏重复空态删没删、错误卡降没降档"
 * 四件版式事实。那条错误卡的**内容**（Web 调试宿没有 launcher 命令）是环境限制不是缺陷，
 * 本文件一条判据都不碰它的文案。真壳里"模态居中在 x=?"要人眼复核（见批次回执）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const view = read('launcher/LauncherView.tsx');
const css = read('launcher/launcher.css');

/** 取一条规则的声明体（选择器按行首精确匹配） */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`);
  expect(at, `找不到规则 ${selector}`).toBeGreaterThan(-1);
  const open = source.indexOf('{', at);
  const close = source.indexOf('\n}', open);
  expect(close, `规则 ${selector} 没有闭合`).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

describe('D-3 · 启动器模态居中与按内容长', () => {
  it('遮罩真挂上 .overlay-backdrop（改前只有 .launcher-mask ⇒ 静态块，实测落在 x=8..1113 没居中）', () => {
    expect(view).toContain('className="launcher-mask overlay-backdrop"');
  });

  it('面板从写死 height 改成 max-height（空库不再撑满 720 高留一片灰 void）', () => {
    const panel = ruleBody(css, '.launcher-panel');
    expect(panel).toContain('max-height: min(720px, 88vh)');
    expect(panel).not.toMatch(/(^|\n)\s*height:/);
  });
});

describe('D-3 · 空态收成一张三步引导卡', () => {
  it('空库不画左栏（296px 近空栏 + 重复的那句"还没有实例。"一起摘掉）', () => {
    expect(view).toContain("{instances.length === 0 ? null : (");
    expect(view).toContain("className={`launcher-body${instances.length === 0 ? ' is-empty' : ''}`}");
    // 左栏那句重复空态只剩"筛不出"一种口径
    expect(view).toContain('<p className="launcher-note">没有匹配的实例。</p>');
    expect(view).not.toContain("{instances.length === 0 ? '还没有实例。' : '没有匹配的实例。'}");
  });

  it('三步取向导真源的三个名字，不另抄口径', () => {
    expect(view).toContain('{WIZARD_STEPS.map((step, index) => (');
    expect(view).toContain('WIZARD_STEP_TITLES[step]');
    expect(css).toMatch(/\.launcher-body\.is-empty\s*\{[\s\S]*?grid-template-columns: 1fr;/);
    expect(css).toContain('.launcher-empty-card');
    expect(css).toMatch(/\.launcher-empty-card\s*\{[\s\S]*?text-align: center;/);
    expect(css).toContain('.launcher-empty-step + .launcher-empty-step::before');
  });

  it('空态文案一条没丢：主句 + 定义 + 无启动面提示', () => {
    expect(view).toContain('>还没有实例<');
    expect(view).toContain('实例 = 一个游戏目录 + 一份隔离配置');
    expect(view).toContain('NO_LAUNCH_SURFACE_TEXT');
  });
});

describe('D-3 · 错误卡降成通栏 inline notice', () => {
  it('列表失败从"叠在左栏里的一张卡"搬成顶栏之下的通栏 dense 档', () => {
    expect(view).toContain('<FailureNotice failure={listFailure} dense />');
    expect(css).toContain('.launcher-failure--dense');
    expect(ruleBody(css, '.launcher-failure--dense')).toContain('border-left: 2px solid var(--red)');
    // 错误必须可见（铁律 4）：dense 档保留红轨，只撤掉占三行的卡片外壳
    expect(ruleBody(css, '.launcher-failure--dense')).toContain('background: transparent');
  });

  it('dense 只改版式：FailureNotice 的文字节点一条没减', () => {
    const notice = view.slice(view.indexOf('function FailureNotice'), view.indexOf('/** 空状态') > 0 ? view.indexOf('/** 空状态') : view.length);
    for (const cls of [
      'launcher-failure-head',
      'launcher-failure-code',
      'launcher-failure-heading',
      'launcher-failure-message',
      'launcher-failure-detail',
      'launcher-failure-why',
      'launcher-failure-hint',
    ]) {
      expect(notice, `dense 化时丢了 \`${cls}\``).toContain(cls);
    }
  });
});

describe('D-10 · 搜索井对齐 ksp-* 度量基线（等 Lane C 的 KitSearchField）', () => {
  const kit = read('search-panel.css');
  const kitField = ruleBody(kit, '.panel-search.ksp .ksp-field');
  const kitInput = ruleBody(kit, '.panel-search.ksp .ksp-input');
  const field = ruleBody(css, '.launcher-search');
  const input = ruleBody(css, '.launcher-search-input');

  it('井：26 高 / radius-md / sunken 底 / hover 抬描边，逐条与 ksp-field 同值', () => {
    expect(field).toContain('min-height: 26px');
    expect(field).toContain('border-radius: var(--radius-md)');
    expect(field).toContain('background: var(--surface-sunken)');
    expect(kitField).toContain('min-height: 26px');
    expect(css).toContain('.launcher-search:hover:not(:focus-within)');
    expect(css).toContain('border-color: var(--border-strong)');
  });

  it('框内输入：24px 命中 + --fs-2 + placeholder 走 --fg-dim，与 ksp-input 同值', () => {
    expect(input).toContain('min-height: 24px');
    expect(input).toContain('font-size: var(--fs-2)');
    expect(kitInput).toContain('min-height: 24px');
    expect(css).toMatch(/\.launcher-search-input::placeholder\s*\{[\s\S]*?color: var\(--fg-dim\);/);
  });

  it('没有在本车道偷抽公共件：井只有一份定义，视图仍用自己的类名（等 Lane C 的 KitSearchField）', () => {
    expect(css.match(/^\.launcher-search \{$/gm)?.length).toBe(1);
    expect(css.match(/^\.launcher-search-input \{$/gm)?.length).toBe(1);
    expect(view).toContain('className="launcher-search-input"');
    expect(view).not.toContain('ui-kit');
  });
});
