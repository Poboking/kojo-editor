/**
 * 1026 kit-converge C2 判据：删掉遮蔽基座的本地同名件（VIS-41）· 原生 select 换 `KitSelect`
 * （VIS-26）· `KitField` 落地设置页（VIS-40 的常规行那一段）· 设置模态纵向留白（VIS-73）。
 *
 * 四条腿（口径照 C1 的 `kit-panel-converge.test.ts`：单源闸 + 退场闸 + 件契约闸 + 接线闸）：
 * ① **单源闸**：`KitCheck` / `KitSelect` / `KitField` 每族全仓只许有一枚实现，且住在
 *    `ui-kit/kit-<name>.tsx` 叶子里；桶棒只 re-export（导出面不变），且桶棒 re-export 的
 *    与叶子直引的是**同一个函数引用**——"已收编"必须能被机器认出来，不能靠人读注释。
 *    同名局部声明（VIS-41 的根因：局部 `function KitCheck` 遮掉 import 绑定）一律红。
 * ② **退场闸**：宿主侧（`packages/app/src`，`ui-kit/` 自身除外）不再手写 `<select>`；
 *    `type="checkbox"` 只剩记名名单里那四枚（`Switch` 拨动档与启动器三面，都在本批射程外）。
 *    插件包里那一枚原生 select **留在原地**（迁它就要跨包 import，直接撞解耦审计 B/C）。
 * ③ **件契约闸**：SSR 钉 `KitSelect` 的 `option[title]`（本轮唯一 additive 的腿）、
 *    `KitField` 的 clickable / nested / inactive 三档、`KitCheck` 的语义腿。
 * ④ **页面接线闸**：设置页常规行走 `KitField`，`[data-settings-key]` 锚逐行写死在外壳上
 *    （`settings-search.test.ts` 只认 JSX 字面量）；字体两行的 `stacked` 单列形态没被拉回
 *    两列栅格；模态的纵向留白与分组标题两条判据在册；退场动画 `ov-exiting` 的挂载点没丢。
 *
 * 本文件待在默认 node 环境（读源码 + SSR 字符串），不在注释里写任何 vitest 环境指令字面量。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import * as barrel from '../src/ui-kit';
import { KitCheck } from '../src/ui-kit/kit-check';
import { KitField } from '../src/ui-kit/kit-field';
import { KitSelect } from '../src/ui-kit/kit-select';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const appSrcRoot = fileURLToPath(new URL('../src', import.meta.url));

/** 剥注释：判据只认**代码**里的声明与属性（口径同 `problem-panel-ux.test.ts`） */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 递归收 `packages/app/src` 下的 ts/tsx，一次性把注释剥好（判据全部走代码面） */
function sources(dir: string): Array<{ rel: string; src: string; code: string }> {
  const out: Array<{ rel: string; src: string; code: string }> = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (/\.tsx?$/.test(name)) {
      const src = readFileSync(abs, 'utf8');
      out.push({ rel: path.relative(appSrcRoot, abs).split(path.sep).join('/'), src, code: codeOnly(src) });
    }
  }
  return out;
}

const allSources = sources(appSrcRoot);
const outsideKit = allSources.filter((f) => !f.rel.startsWith('ui-kit/'));
const insideKit = allSources.filter((f) => f.rel.startsWith('ui-kit/'));

const problemSrc = read('../src/ui/ProblemPanel.tsx');
const searchSrc = read('../src/ui/SearchPanel.tsx');
const settingsSrc = read('../src/ui/SettingsPanel.tsx');
const kitCss = read('../src/ui-kit/ui-kit.css');
const settingsCss = read('../src/ui/settings-appearance.css');

/** `type="checkbox"` 的记名名单（本批射程外：拨动档是 `Switch` 那一族，启动器归另一条线） */
const CHECKBOX_ROSTER = [
  'launcher/LauncherView.tsx',
  'launcher/plugins-panel.tsx',
  'launcher/saves-panel.tsx',
  'ui/Switch.tsx',
].sort();

/* ============================ ① 单源：基座只有一枚 ============================ */

describe('KitCheck / KitSelect / KitField 全仓各只有一枚实现（VIS-41）', () => {
  for (const name of ['KitCheck', 'KitSelect', 'KitField'] as const) {
    it(`${name}：实现只在 ui-kit 的叶子里，别处（含桶棒）不许再写第二枚`, () => {
      const decl = new RegExp(`(?:function|const)\\s+${name}\\s*[=(:]`);
      const owners = insideKit.filter((f) => decl.test(f.code)).map((f) => f.rel);
      expect(owners, `${name} 的实现不止一枚：${owners.join(', ')}`).toEqual([
        `ui-kit/kit-${name.slice(3).toLowerCase()}.tsx`,
      ]);
      // 遮蔽基座的那条路（局部同名声明）在 ui-kit 之外的任何角落都不许出现
      const shadowers = outsideKit.filter((f) => decl.test(f.code)).map((f) => f.rel);
      expect(shadowers, `${name} 被局部同名件遮蔽：${shadowers.join(', ')}`).toEqual([]);
    });
  }

  it('桶棒 re-export 与叶子直引是同一个引用（导出面不变，旧消费方零改动）', () => {
    const b = barrel as unknown as Record<string, unknown>;
    expect(b.KitCheck).toBe(KitCheck);
    expect(b.KitSelect).toBe(KitSelect);
    expect(b.KitField).toBe(KitField);
  });

  it('消费方直引叶子、不经桶棒（开机图纪律：叶子按件付费）', () => {
    expect(problemSrc).toContain("from '../ui-kit/kit-check'");
    expect(problemSrc).toContain("from '../ui-kit/kit-select'");
    expect(searchSrc).toContain("from '../ui-kit/kit-check'");
    expect(searchSrc).toContain("from '../ui-kit/kit-select'");
    expect(settingsSrc).toContain("from '../ui-kit/kit-field'");
    expect(problemSrc).toMatch(/<KitCheck\b/);
    expect(problemSrc).toMatch(/<KitSelect\b/);
    expect(searchSrc).toMatch(/<KitCheck\b/);
    expect((searchSrc.match(/<KitSelect\b/g) ?? []).length).toBe(2);
    expect((settingsSrc.match(/<KitField\b/g) ?? []).length).toBeGreaterThanOrEqual(22);
  });
});

/* ============================ ② 退场：原生件清零 ============================ */

describe('宿主侧原生 select / checkbox 退场（VIS-26 · VIS-41 顺手项）', () => {
  it('packages/app/src（ui-kit 之外）不再手写 `<select>`', () => {
    const re = /<select[\s>]|createElement\(\s*['"]select['"]/;
    const hits = outsideKit.filter((f) => re.test(f.code)).map((f) => f.rel);
    expect(hits, `还在手写原生 select：${hits.join(', ')}`).toEqual([]);
  });

  it('packages/app/src（ui-kit 之外）的 `type="checkbox"` 只剩记名那四枚', () => {
    const hits = outsideKit.filter((f) => /type=["']checkbox["']/.test(f.code)).map((f) => f.rel).sort();
    expect(hits).toEqual(CHECKBOX_ROSTER);
  });

  it('件本体仍交原生 `<select>` / `<input type=checkbox>`（键盘与读屏语义是刻意取舍，不是漏网）', () => {
    expect(read('../src/ui-kit/kit-select.tsx').includes('<select')).toBe(true);
    expect(read('../src/ui-kit/kit-check.tsx').includes('type="checkbox"')).toBe(true);
    // `-webkit-small-control` 那枚系统字号的根因就是裸生 select：三处换完即消失，
    // `appearance: none` 那两条腿必须在基座里（判据本体在 ui-chrome-polish.test.ts，本批不放宽）。
    expect(kitCss).toMatch(/\.kit-select-input\s*\{[^}]*appearance:\s*none/);
  });

  it('插件包那一枚原生 select 留在原地（迁它 = 跨包 import = 撞解耦审计 B/C）', () => {
    const nav = read('../../../packages/plugins/ui-kojo-navigator/src/navigator-panel.ts');
    // 那一边不用 JSX，原生 select 是 `createElement('select', …)` 造出来的
    expect(nav).toMatch(/createElement\(\s*'select'/);
    expect(nav).not.toContain('KitSelect');
  });

  it('旧抄本整体退场：prob 族的第二份勾盒 / 井与 ksp 族的原生 checkbox 不再被挂上', () => {
    expect(problemSrc).not.toMatch(/prob-(check|select-wrap|select-caret)\b/);
    expect(searchSrc).not.toMatch(/ksp-opt-check\b/);
    // 判据走代码面：两份 CSS 的头注里如实记着"旧的那两段被删了"，那是要给人读的
    const probCss = codeOnly(read('../src/problem-panel.css'));
    const kspCss = codeOnly(read('../src/search-panel.css'));
    expect(probCss).not.toMatch(/\.prob-check/);
    // 只留 `.prob-select-well` 那一格井宽上限；旧的裸 `.prob-select` 井与 SVG 箭头抄本清零
    expect(probCss).not.toMatch(/\.prob-select(?![\w-])/);
    expect(probCss).not.toMatch(/\.prob-select-(wrap|caret)/);
    expect(kspCss).not.toMatch(/\.ksp-opt-check\b/);
  });
});

/* ============================ ③ 件契约 ============================ */

describe('件契约（SSR 字符串）', () => {
  it('KitSelect：井在 wrapper 上、select 穿 kit-select-input、chevron 自绘；option[title] 是 additive 腿', () => {
    const s = renderToStaticMarkup(
      h(KitSelect, {
        value: 'b',
        onChange: () => undefined,
        ariaLabel: '范围',
        title: '整句说明',
        options: [
          { value: 'a', label: '甲' },
          { value: 'b', label: '乙', title: '乙的逐档说明' },
          { value: 'c', label: '丙', disabled: true },
        ],
      }),
    );
    expect(s).toContain('<span class="kit-select">');
    expect(s).toContain('<select class="kit-select-input"');
    expect(s).toContain('class="kit-select-arrow"');
    // 不传 title 的旧形态：属性根本不出现（这就是"旧消费方零改动"的可验形态）
    expect(s).toContain('<option value="a">甲</option>');
    expect(s).toMatch(/<option value="b"[^>]*title="乙的逐档说明"/);
    expect(s).toMatch(/<option value="c"[^>]*disabled/);
  });

  it('KitField：clickable / nested / inactive 三档各落自己的类，文字列在前、控件槽在右', () => {
    const s = renderToStaticMarkup(
      h(KitField, {
        as: 'label',
        nested: true,
        inactive: true,
        title: '编辑器居中限宽',
        description: '需要先开启写作模式',
        control: h('span', { className: 'ctl-mock' }, 'ctl'),
      }),
    );
    expect(s).toContain('<label class="kit-field kit-field-clickable kit-field-nested kit-field-inactive"');
    expect(s.indexOf('kit-field-text')).toBeLessThan(s.indexOf('kit-field-ctl'));
    expect(s).toContain('ctl-mock');
  });

  it('KitCheck：无文字落 aria-label（问题面板档）；有文字走 label 包裹、点文字即切换（检索面板档）', () => {
    const bare = renderToStaticMarkup(h(KitCheck, { checked: true, onChange: () => undefined, label: '错误' }));
    expect(bare).toContain('<span class="kit-check">');
    expect(bare).toContain('aria-label="错误"');
    expect(bare).toContain('<span class="kit-check-box" aria-hidden="true"></span>');
    const withText = renderToStaticMarkup(
      h(KitCheck, { checked: true, onChange: () => undefined, label: '打字即搜', className: 'search-live' }, '打字即搜'),
    );
    expect(withText).toContain('<label class="kit-check search-live">');
    expect(withText).not.toContain('aria-label');
  });
});

/* ============================ ④ 设置页接线 ============================ */

describe('设置页（KitField 落地 + 纵向留白，VIS-40 / VIS-73）', () => {
  it('每枚 KitField 行都自带写死的 data-settings-key 外壳（锚不许塞进件里）', () => {
    // 判据走代码面：文件头那段"怎么写锚"的说明本身不是锚
    const rows = [...codeOnly(settingsSrc).matchAll(/<div\s+className="settings-kit-row"[\s\S]*?>/g)].map(
      (m) => m[0],
    );
    expect(rows.length).toBeGreaterThanOrEqual(22);
    for (const tag of rows) {
      expect(tag, '外壳上少了逐行写死的锚 ⇒ 右键面与搜索落点会指不到这一行').toMatch(
        /data-settings-key="[^"{$]+"/,
      );
    }
  });

  it('带 role=group 的步进器行：组语义与锚同住外壳，没被件吃掉', () => {
    for (const label of ['毛玻璃透明度', '正文字号', '补全弹出延迟']) {
      expect(settingsSrc).toContain(`aria-label="${label}"`);
    }
  });

  it('字体两行仍走 `.settings-row.stacked` 单列 flex（没被拉回两列栅格）', () => {
    for (const key of ['editor.fontFamily', 'appearance.uiFontFamily']) {
      const tag = new RegExp(`<div\\b[^>]*data-settings-key="${key}"[^>]*>`).exec(settingsSrc)?.[0] ?? '';
      expect(tag, `${key} 的行本体不见了`).not.toBe('');
      expect(tag).toContain('settings-row');
      expect(tag).toContain('stacked');
      expect(tag).not.toContain('flexDirection');
    }
    // 单列那条规则本体在 styles-project.css（Lane B 的文件，本批一字不改），这里只验它仍在册
    expect(read('../src/styles-project.css')).toMatch(
      /\.settings-row\.stacked\s*\{[^}]*flex-direction:\s*column/,
    );
  });

  it('右轴：KitField 在设置页吃宿主那枚 `--settings-ctl-axis`（不抄第二份 120px）', () => {
    expect(settingsCss).toMatch(/\.settings-host \.kit-field\s*\{[^}]*--settings-ctl-axis/);
  });

  it('分组标题 12px dim + 8px 间距，尾线删净（VIS-73）', () => {
    const title = /\.settings-host \.settings-group-title\s*\{([^}]*)\}/.exec(settingsCss)?.[1] ?? '';
    expect(title).toMatch(/font-size:\s*var\(--fs-1\)/);
    expect(title).toMatch(/color:\s*var\(--fg-dim\)/);
    expect(title).toMatch(/margin-bottom:\s*var\(--space-2\)/);
    expect(settingsCss).toMatch(/\.settings-host \.settings-group-title::after\s*\{\s*content:\s*none/);
  });

  it('纵向留白：余量上下对分，分栏区不再把宿主的可用高度吃干', () => {
    expect(settingsCss).toMatch(
      /\.settings-host \.settings-nav-panel > \.settings-body\s*\{[^}]*margin-block:\s*auto/,
    );
    expect(settingsCss).toMatch(/\.settings-host \.settings-nav-split\s*\{[^}]*flex:\s*0 1 auto/);
  });

  it('退场动画的挂载点没被结构改造弄丢（`ov-exiting` 两处：正常壳与防御空壳）', () => {
    expect((settingsSrc.match(/ov-exiting/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(settingsSrc).toContain('useOverlayPresence');
  });

  it('件与样式表的分工：kit 度量住 ui-kit.css，页面锚与留白住设置页切片', () => {
    for (const sel of ['.kit-field', '.kit-check-box', '.kit-select-input', '.kit-select-arrow']) {
      expect(kitCss, `${sel} 规则块不见了`).toContain(sel);
    }
  });
});
