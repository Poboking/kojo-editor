/**
 * VIS-62（1026 编辑器体感 E1）：书签的 glyph margin **槽位**判据。
 *
 * 立论（组长的实测前提，本文件把它钉成读数）：C 批的装饰层只写了
 * `glyphMarginClassName` / `glyphMarginHoverMessage`（`ui/editor-pane/use-bookmarks.ts:46-47`），
 * 而 monaco-editor 这一档的 `glyphMargin` 缺省是 **false**
 * （`monaco.d.ts:3580`「Defaults to true in vscode and to false in monaco-editor」）。
 * 全仓改前 `grep -rn "glyphMargin" packages/app/src` 只有那两行 ⇒ 槽位从未存在过，
 * 角标与那句 hover 文案一枚都没画过，`ui/bookmark-gutter.css` 的 `.kojo-bookmark-glyph`
 * 一支是**死样式**——而"文件在、类名对、测试绿、tsc 绿"四项没有一项会红（与
 * `css-slices-wired.test.ts` 抓到的 L14 同一类事故，只是这次死的是 Monaco 侧的槽位）。
 *
 * 三件判据（链必须闭合：选项开 → 装饰带类 → 样式消费）：
 *  ① 体量三档**逐档同值 = 开**（视口级渲染 + 稀疏装饰，不在"随文件长度增长"那一族里 ⇒
 *     大档没有理由砍它；砍了就是作者亲手钉的书签按文件长度静默消失，铁律 4）；
 *  ② create 那一路对齐（与 `formatOnType: true` 同一格纪律：创建时就对，不等第一次落档补写）；
 *  ③ **开了档 ⇒ 样式表真有对应消费方**，且类名字面量与 `ui/bookmarks.ts` 的单源常量逐字相等
 *     ——改名只改一侧、或往 CSS 里手抄第三个名字，这一条直接红。
 *
 * 静态读源码 + 纯函数（node 环境）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  editorOptionsForLineCount,
  sizeTierKeys,
  sizeTierKeysMissingFromSmall,
} from '../src/ui/editor-options';
import { BOOKMARK_GLYPH_CLASS, BOOKMARK_LINE_CLASS } from '../src/ui/bookmarks';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const gutterCss = readFileSync(path.join(SRC, 'ui/bookmark-gutter.css'), 'utf8');
const gutterBody = gutterCss.replace(/\/\*[\s\S]*?\*\//g, '');
const instanceSource = readFileSync(path.join(SRC, 'ui/editor-pane/use-monaco-instance.ts'), 'utf8');
const decorSource = readFileSync(path.join(SRC, 'ui/editor-pane/use-bookmarks.ts'), 'utf8');

/** 三档各取两个读数：档内样本 + 阈值边界（阈值含等号，"≥ 即降"那条口径不许漂） */
const TIER_SAMPLES = [1, 4_999, LARGE_FILE_LINES, 20_000, HUGE_FILE_LINES, 990_000];

describe('VIS-62 ①：书签槽位在体量三档上都开着', () => {
  it('每一档、每个读数的 glyphMargin 都是 true（缺省 false 一旦回来，装饰就成死样式）', () => {
    for (const lines of TIER_SAMPLES) {
      expect(editorOptionsForLineCount(lines).glyphMargin, `${lines} 行档上槽位没开`).toBe(true);
    }
  });

  it('这一格确实在档位表里（sizeTierKeys 认得它），且"大档写过、小档没写回"仍是空表', () => {
    expect(sizeTierKeys()).toContain('glyphMargin');
    expect(sizeTierKeysMissingFromSmall()).toEqual([]);
  });
});

describe('VIS-62 ②：create 那一路与档位表对齐', () => {
  it('use-monaco-instance.ts 的 create options 里 glyphMargin 就开着（不等第一次落档）', () => {
    expect(instanceSource).toContain('glyphMargin: true,');
  });
});

describe('VIS-62 ③：开档 ⇒ 样式表真有消费方（防死样式回潮）', () => {
  it('装饰层确实把单源常量挂到 glyphMarginClassName 上', () => {
    expect(decorSource).toContain(`glyphMarginClassName: BOOKMARK_GLYPH_CLASS`);
    expect(decorSource).toContain('glyphMarginHoverMessage');
  });

  it('开了档的每一档，bookmark-gutter.css 都消费这两个类（逐字等于常量，改名漏一侧即红）', () => {
    const openTiers = TIER_SAMPLES.filter((lines) => editorOptionsForLineCount(lines).glyphMargin === true);
    expect(openTiers.length, '一档都没开：下面那两条断言会空转').toBe(TIER_SAMPLES.length);
    expect(gutterBody).toContain(`.${BOOKMARK_GLYPH_CLASS}`);
    expect(gutterBody).toContain(`.${BOOKMARK_LINE_CLASS}`);
  });

  it('CSS 里出现的 kojo-bookmark-* 类名集合**恰好**是那两枚（不许手抄第三个名字）', () => {
    const found = [...new Set([...gutterBody.matchAll(/\.kojo-bookmark-[a-z-]+/g)].map((m) => m[0].slice(1)))].sort();
    expect(found).toEqual([BOOKMARK_GLYPH_CLASS, BOOKMARK_LINE_CLASS].sort());
  });

  it('角标确实画在 ::after 上（margin 装饰元素由 monaco 内联定位，样式只在其内部居中）', () => {
    expect(gutterBody).toMatch(new RegExp(`\\.${BOOKMARK_GLYPH_CLASS}::after\\s*\\{`));
  });
});
