/**
 * 缩进导轨合一闸（视觉批十一 · 收尾路 R1 活三）。
 *
 * L16 给文件树、L19 给大纲各写了一份「1px + `var(--border)`，悬停/当前行提
 * `var(--border-strong)`」的导轨，两份实现开始漂（大纲那份额外挂了 `--outline-guide`
 * 别名层）。本批收成**一条规则驱动两处**：
 *  - 定义点全仓唯一：`file-tree.css` 里 `.file-tree, .outline-panel` 同一条规则挂
 *    `--tree-guide` / `--tree-guide-strong` 两档（颜色真源仍是主题 `--border` 族）；
 *  - 两处各自消费同一对 token——DOM 形态不互抄（树在 ul 上挂 ::before 竖线，
 *    大纲把 repeating 渐变铺在行的缩进带上），只共"缩进带导轨"这一条口径；
 *  - 别名层 `--outline-guide` 必须删净（代码腿零出现，注释里作为历史说明允许）。
 *
 * 两屏各自仍成立的运行腿不在这里重复：文件树导轨的类与几何由
 * `file-tree.css` 既有规则钉住（本闸查 token 腿），大纲行形状/箭头由
 * `outline-panel-fold.test.ts`、`l11-inline-to-class.test.ts` 既有闸守着。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const treeCss = (): string => stripComments(read('../src/file-tree.css'));
const outlineCss = (): string => stripComments(read('../src/outline-panel.css'));
const heavyCss = (): string => read('../src/styles-project.css');
const lightCss = (): string => read('../src/styles.css');

describe('导轨两档 · 定义点全仓唯一，一处规则驱动两处', () => {
  it('file-tree.css：`.file-tree, .outline-panel` 同一条规则定义 --tree-guide 两档', () => {
    const css = treeCss();
    expect(css).toMatch(/\.file-tree\s*,\s*\n\.outline-panel\s*\{/);
    expect(css).toContain('--tree-guide: var(--border);');
    expect(css).toContain('--tree-guide-strong: var(--border-strong);');
  });

  it('定义点只此一处：其余切片不映射 --tree-guide 到颜色 token（大纲的 hover 覆写是档位切换、不是第二定义点）', () => {
    for (const [name, css] of [
      ['outline-panel.css', outlineCss()],
      ['styles.css', stripComments(lightCss())],
      ['styles-project.css', stripComments(heavyCss())],
    ] as const) {
      // 「定义点」的判据 = 有没有第二处把 --tree-guide 映射到 --border 族；
      // 悬停/当前行的 `--tree-guide: var(--tree-guide-strong)` 是同一档位的状态切换，允许。
      expect(css, `${name} 不该冒出第二个颜色映射定义点`).not.toMatch(
        /--tree-guide(-strong)?:\s*var\(--border/,
      );
    }
  });
});

describe('两处消费同一对 token · 别名层删净', () => {
  it('文件树 ::before 导轨吃 --tree-guide / --tree-guide-strong，不再直写 --border 对', () => {
    const css = treeCss();
    expect(css).toContain('background: var(--tree-guide);');
    expect(css.match(/background:\s*var\(--tree-guide-strong\);/g)?.length).toBe(2);
    expect(css).not.toMatch(/background:\s*var\(--border(-strong)?\);/);
  });

  it('大纲静息档渐变吃 --tree-guide；悬停/当前行把同一枚 token 提到强档（别名 --outline-guide 绝迹）', () => {
    const css = outlineCss();
    expect(css).toContain('var(--tree-guide) 0 1px');
    expect(css.match(/--tree-guide:\s*var\(--tree-guide-strong\);/g)?.length).toBe(2);
    expect(css).not.toMatch(/--outline-guide(-strong)?\s*[:=]/);
    // 步进/深度口径没被动过（只合颜色，不改设计）
    expect(css).toContain('--outline-indent: calc(var(--space-3) + var(--space-0));');
    expect(css).toContain('calc(var(--outline-indent) * var(--outline-depth, 0))');
  });

  it('等值口径：合流前后颜色对逐字不变（--border 静息 / --border-strong 悬停与当前）', () => {
    // 定义腿只允许这一对映射——别名删掉后两处仍落回同一双 token
    const defs = `${treeCss()}`.match(/--tree-guide(-strong)?:\s*var\(--(border(-strong)?)\);/g) ?? [];
    expect(defs.sort()).toEqual([
      '--tree-guide-strong: var(--border-strong);',
      '--tree-guide: var(--border);',
    ]);
  });
});
