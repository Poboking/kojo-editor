/**
 * 浮层里的编辑器外观并入主编辑器口径（批次十一 L12-overlays）。
 *
 * 比对窗与快速修复预览窗原先只铺 `CODE_FONT_BASELINE`（字面那张），于是并排看时
 * 留白、导航面与主编辑器是两套：主编辑器有上下 padding、粘性滚动、当前行高亮，
 * 浮层里一概没有——读起来像"另一款更简陋的编辑器"。
 *
 * 这一档只做**外观同源**，不做选项同源：
 * - 值从主编辑器那张档位表读（`editorOptionsForLineCount`），本模块**不抄第二份数字**；
 * - 只挑外观那几把尺子（留白 / 缩略图 / 粘性滚动 / 当前行高亮），不把打字规范化、
 *   suggest、find 那一族偏好搬进只读的对拍面（那些是"写"的装备，这里没有写）；
 * - `wordWrap` 刻意不并：Monaco 的并排 diff 与折行互相将了一军（折行会把两栏压成一栏），
 *   比对面要保持左右可对照，这条不许跟。
 *
 * **装载走动态 import**：两个来源模块都只在浏览器 effect 里取，一次都不进开机静态图
 * （`tests/ps10-eager-graph.test.ts` 的口径——只跟静态的"有值"依赖）。类型那一头用
 * `import type`，同样被擦除，不构成边。
 */

import type { EditorOptionPatch } from './editor-options';

/**
 * 浮层编辑器外观档：直接从主编辑器那张表的类型上**摘**出这几把尺子（`import type` 会被擦除，
 * 因此不产生开机静态图依赖）。不另写一份形状——自己抄一遍 `IEditorMinimapOptions` 的字段，
 * 就是下一批"两处口径漂移"的开始。
 */
export type OverlayEditorAppearance = Pick<
  EditorOptionPatch,
  'padding' | 'minimap' | 'stickyScroll' | 'renderLineHighlight' | 'renderLineHighlightOnlyWhenFocus'
>;

/**
 * 换行符计数（1 基行数；零中间分配）。
 *
 * 与 `DiffViewOverlay.countLines` 同算法而**不从它 import**：那个模块是刻意动态装载的
 * （P2-14 / PS-10 断链），快速修复预览窗静态挂在开机图里，静态 import 它会把整块
 * 比对 chunk 拽回首屏。两处各一份五行纯函数，比一根错链便宜。
 */
export function overlayLineCount(text: string): number {
  if (text.length === 0) return 1;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * 按**这一侧正文的行数**取主编辑器的外观档（纯异步，装载失败即返回空补丁 ⇒ 浮层照旧
 * 只有字面基线，绝不因为取外观把编辑器开没了）。
 *
 * 行数取两侧较大那一本：档位表关的是"全文级"开销，比对时两栏同时在场，
 * 按大的那本降级才与主编辑器"打开这个文件时"的样子一致。
 */
export async function overlayEditorAppearance(lineCount: number): Promise<OverlayEditorAppearance> {
  try {
    const [options, sugarView] = await Promise.all([import('./editor-options'), import('./sugar-view')]);
    const tier = options.editorOptionsForLineCount(lineCount);
    return {
      padding: { ...sugarView.EDITOR_PADDING_DEFAULT },
      ...(tier.minimap !== undefined ? { minimap: tier.minimap } : {}),
      ...(tier.stickyScroll !== undefined ? { stickyScroll: tier.stickyScroll } : {}),
      ...(tier.renderLineHighlight !== undefined
        ? { renderLineHighlight: tier.renderLineHighlight }
        : {}),
      ...(tier.renderLineHighlightOnlyWhenFocus !== undefined
        ? { renderLineHighlightOnlyWhenFocus: tier.renderLineHighlightOnlyWhenFocus }
        : {}),
    };
  } catch {
    // 外观是加分项，不是前提：取不到就维持改前的样子（不留"取外观失败所以开不了"的坑）
    return {};
  }
}
