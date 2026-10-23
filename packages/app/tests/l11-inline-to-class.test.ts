import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * L11-inline-to-class 立论闸（视觉批十一 · 2026-10-24）。
 *
 * 本路的立论：`OutlinePanel.tsx` / `kojo2-preview-panel.tsx` / `kojo2-migrate.tsx` /
 * `kojo2-cutover-settings.tsx` 四件的**观感**全部搬进类系统（`outline-panel.css` /
 * `kojo2.css`），TSX 里只准留**数据驱动的量**（虚拟化行高、进度百分比、
 * `--outline-depth` 这一枚无单位数字）。此前该成果零测试——任何人往这四件里
 * 塞回一枚 `fontSize: 12` 都不会被拦。本闸把它钉成可回归。
 *
 * 口径照 `boot-sweep-single-source.test.ts` 先例：`readFileSync` 读源码，
 * node 环境、不起壳、不依赖 DOM。扫描前先剥注释——文件头都有一段"此前如何如何"
 * 的历史说明，那是散文不是声明。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 剥掉 `/* … *\/` 块注释与 `//` 行注释（本批只用这两种注释形态） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const TSX_FILES = [
  '../src/ui/OutlinePanel.tsx',
  '../src/ui/kojo2-preview-panel.tsx',
  '../src/ui/kojo2-migrate.tsx',
  '../src/ui/kojo2-cutover-settings.tsx',
] as const;

/** 内联外观属性名：出现在这四个 TSX（剥注释后）即违例——像素/颜色/观感一律归 CSS */
const BANNED_INLINE_PROPS = [
  'fontSize',
  'fontFamily',
  'font',
  'padding',
  'paddingLeft',
  'margin',
  'borderRadius',
  'border',
  'borderTop',
  'borderBottom',
  'borderLeft',
  'borderRight',
  'background',
  'color',
  'boxShadow',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'cursor',
  'position',
  'inset',
  'zIndex',
  'backdropFilter',
  'accentColor',
] as const;

describe('L11 · 内联声明归零（立论闸）', () => {
  for (const rel of TSX_FILES) {
    describe(rel, () => {
      const code = stripComments(read(rel));

      it('不再出现内联外观属性字面量（fontSize/padding/color/… 全归类系统）', () => {
        for (const prop of BANNED_INLINE_PROPS) {
          // `prop:` 形式（对象字面量键）与 `prop='` 形式都拦
          const re = new RegExp(`\\b${prop}\\s*:`, 'g');
          const hits = code.match(re);
          expect(hits, `内联属性 ${prop}: 又回到了 ${rel}`).toBeNull();
        }
      });

      it('不再出现颜色字面量（rgba / hex）', () => {
        expect(code).not.toMatch(/rgba?\(/);
        expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      });

      it('旧的整表样式常量（const styles = {…}）不许复活', () => {
        expect(code).not.toMatch(/const\s+styles\s*=\s*\{/);
      });
    });
  }

  it('留在 TSX 的内联只剩数据驱动的量（行高 / 进度宽 / --outline-depth）', () => {
    // OutlinePanel：唯一一处内联是"第几级"这一个无单位数字
    const outline = stripComments(read('../src/ui/OutlinePanel.tsx'));
    expect(outline.match(/style=\{\{/g) ?? []).toHaveLength(1);
    expect(outline).toContain("'--outline-depth'");
    // 预览面板：只剩虚拟化的 height 系（rowStyle + 上下衬垫），不许出现别的 style 形态
    const preview = stripComments(read('../src/ui/kojo2-preview-panel.tsx'));
    for (const m of preview.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      expect(m[1]!.trim()).toMatch(/^(height|width)(:|,)/);
    }
    // 向导：唯一一处内联是进度条宽度（百分比是算出来的，不是设计常量）
    const wizard = stripComments(read('../src/ui/kojo2-migrate.tsx'));
    for (const m of wizard.matchAll(/style=\{\{(.*?)\}\}/gs)) {
      expect(m[1]!.trim()).toMatch(/^width:/);
    }
    // 切换设置：一行内联都不许有
    const cutover = read('../src/ui/kojo2-cutover-settings.tsx');
    expect(stripComments(cutover)).not.toContain('style=');
  });
});

describe('L11 · CSS 侧纪律（token 消费方）', () => {
  for (const rel of ['../src/outline-panel.css', '../src/kojo2.css']) {
    describe(rel, () => {
      const css = stripComments(read(rel));

      it('颜色不许写字面量（hex / rgba 一律走 token 或 color-mix）', () => {
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        // `rgb(var(--accent-rgb)…)` 是 token 派生，合法；带数字参的字面量才算违例
        expect(css).not.toMatch(/rgba?\(\s*[\d.#]/);
      });

      it('圆角只吃 --radius-*（豁免尺度外的几何语义值 0 与 50%，tokens.css §圆角明文）', () => {
        for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
          const value = m[1]!.trim();
          expect(
            value === '0' || value === '50%' || value.startsWith('var(') || value === 'inherit',
            `${rel} 出现裸圆角：border-radius: ${value}`,
          ).toBe(true);
        }
      });

      it('不定义 :root（token 单源归 tokens.css）', () => {
        expect(css).not.toMatch(/:root\s*\{/);
      });
    });
  }
});

describe('L11 · 迁移向导与切换设置的形状', () => {
  const wizard = read('../src/ui/kojo2-migrate.tsx');
  const cutover = read('../src/ui/kojo2-cutover-settings.tsx');
  const css = read('../src/kojo2.css');

  it('向导浮层说 .overlay-host 的语言：遮罩 .overlay-backdrop、本体 .overlay-host.kojo2-wizard', () => {
    expect(wizard).toContain('className="overlay-backdrop"');
    expect(wizard).toContain('className="overlay-host kojo2-wizard"');
    expect(wizard).not.toMatch(/position:\s*'fixed'/);
  });

  it('步骤条与进度轨存在且成功/失败走「形状+图标+色」三重区分', () => {
    expect(wizard).toContain('kojo2-wizard__steps');
    expect(wizard).toContain('kojo2-wizard-step');
    expect(wizard).toContain('data-state={step.state}');
    expect(wizard).toContain('kojo2-wizard__progress');
    // 记号用真图标，不是只换个色
    expect(wizard).toContain('<Icon name="check"');
    expect(wizard).toContain('<Icon name="close"');
    expect(wizard).toContain('<Icon name="warning"');
    // CSS 侧三档各有形状差（结果盒：左轨 vs 整周描边 vs 菱形叉）
    expect(css).toContain(".kojo2-wizard__result[data-state='ok']");
    expect(css).toContain(".kojo2-wizard__result[data-state='error']");
  });

  it('切换设置用 ui-kit 真件 KitRadio，原生 radio 已退役', () => {
    const cutoverCode = stripComments(cutover);
    expect(cutoverCode).toContain("import { KitRadio } from '../ui-kit'");
    expect(cutoverCode).toContain('<KitRadio');
    expect(cutoverCode).not.toContain('<input');
    // 既有测试钉住的行锚点属性还在
    expect(cutover).toContain('data-kojo2-stage={stage}');
    expect(cutover).toContain("data-kojo2-selected={selected ? '1' : '0'}");
  });

  it('ui-kit.css 按 L14 加载契约进 main.tsx 静态链（否则 KitRadio 裸奔）', () => {
    const main = read('../src/main.tsx');
    expect(main).toContain("import './ui-kit/ui-kit.css';");
  });
});
