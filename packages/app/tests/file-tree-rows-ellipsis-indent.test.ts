/**
 * 文件树行级两处越界的收编闸（视觉批十一 · 收尾路 R1 活二）。
 *
 * 钉两件事（都是 L16 交付时点名转派的残留）：
 *  ① **中段省略接上单源函数**：`FileRow`（单条平铺文件行）的文件名渲染必须过
 *     `middleEllipsis`——`.ERH` / `.kojo` 这类后缀就是信息，长名不许被尾部 ellipsis 吃掉；
 *     上限与包/根两层同一把尺（`TREE_LABEL_MAX` 单源，不另造数字）。
 *  ② **缩进像素值不住 TS**：`DirRows` 的行内 padding 只许递"第几级"这一个无单位数字进
 *     `calc(… * var(--tree-indent))`，像素真源在 `.file-tree` 的 `--tree-indent`。
 *     改前 `depth * 14px` ≡ 改后 `calc(depth * var(--tree-indent))` 的**终值等式**在这里钉死：
 *     两侧同深同值（逐层对拍），且 token 现值仍为 14px——这是重排不是改设计。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileRow } from '../src/ui/file-tree-row';
import { TREE_LABEL_MAX, middleEllipsis } from '../src/ui/FileTree';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('FileRow · 文件名吃中段省略单源函数', () => {
  it('渲染腿点名 `middleEllipsis(baseName(f), TREE_LABEL_MAX)`（上限也单源，不另造数字）', () => {
    const code = stripComments(read('../src/ui/file-tree-row.tsx'));
    expect(code).toContain('middleEllipsis(baseName(f), TREE_LABEL_MAX)');
  });

  it('长名上屏：中段省略、扩展名留在屏上；title 仍是完整路径（裁的只是显示）', () => {
    const long = 'C:/game/kojo/001/M_KOJO_RM_01_少女夢中長期イベントテスト用.ERB';
    const html = renderToStaticMarkup(
      h(FileRow, { f: long, active: false, onOpenFile: () => {} }),
    );
    const shown = middleEllipsis(
      long.slice(long.lastIndexOf('/') + 1),
      TREE_LABEL_MAX,
    );
    expect(shown).toContain('…');
    expect(shown.length).toBeLessThanOrEqual(TREE_LABEL_MAX);
    expect(shown.endsWith('.ERB')).toBe(true);
    expect(html).toContain('…');
    expect(html).toContain('.ERB');
    expect(html).toContain(`title="${long}"`);
  });

  it('短名零扰动：不超上限时逐字原样（省略闸不许自己变成新的信息损失）', () => {
    const html = renderToStaticMarkup(
      h(FileRow, { f: 'C:/koa/q.ERH', active: false, onOpenFile: () => {} }),
    );
    expect(html).toContain('>q.ERH<');
    expect(html).not.toContain('…');
  });
});

describe('DirRows · 递归缩进的像素值不住 TS', () => {
  const code = stripComments(read('../src/ui/file-tree-dir-rows.tsx'));

  it('行内 padding 只递无单位深度进 calc()，吃 --tree-indent；`14` 这个数字绝迹', () => {
    // 算式操作数序与 `file-tree.test.ts` 的宿主侧同一形（`var(--tree-indent) * depth`）：
    // 两批各自把裸 px 收进 token 时选了同一条式的两个写法，合树统一到对面那一形（CSS 终值相同）
    expect(code).toContain('calc(var(--tree-indent) * ${depth})');
    expect(code).not.toMatch(/paddingLeft:\s*`\$\{depth\s*\*\s*14\}px`/);
    expect(code).not.toContain('14px');
  });

  it('终值等式（重排不改设计的证据）：逐层 depth×14px === calc(depth × var(--tree-indent))', () => {
    // 左侧 = 改前 TS 字面量口径；右侧的 token 现值在 styles-project.css 钉着（.file-tree）
    const heavy = read('../src/styles-project.css');
    expect(heavy).toContain('--tree-indent: 14px;');
    const indentPx = Number(/--tree-indent:\s*(\d+(?:\.\d+)?)px/.exec(heavy)?.[1]);
    expect(indentPx).toBe(14);
    for (let depth = 0; depth <= 8; depth += 1) {
      // calc(depth * 14px) 的解析终值就是 depth×14px——两侧同尺同值，逐层对拍
      expect(`${depth * indentPx}px`).toBe(`${depth * 14}px`);
    }
  });
});
