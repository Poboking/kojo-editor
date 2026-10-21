/**
 * `@原生` 缩进围栏：**逐行透传**（§8.5 / §16.2 C2.10）。
 *
 * 块体已由 lexer 做过"最小前导空白"去缩进并原样保留（空行、`;` 注释、Tab 不动）；
 * 本模块只做三件事：合法性守门、逐行写出、把每一行折回**物理源行**（source map 逐行保留）。
 *
 * 坐标：块头 `@原生` 在第 L 行 ⇒ 块体第 i 行（0 基）在物理第 `L + 1 + i` 行；
 * 块体保留空行 ⇒ 行序与物理行 1:1，折回不靠猜。
 */
import type { KojoNativeBlock } from '../ast.js';
import type { LowerState } from './state.js';
import { report } from './state.js';

export function lowerNativeBlock(node: KojoNativeBlock, state: LowerState): void {
  // §8.5 允许位置：池/模板/`@着色`/`@随机` 候选内禁止（会破坏纯文本/颜色配对/随机落点）
  if (state.color !== null) {
    report(
      state,
      'core/native/disallowed-location',
      '`@原生` 不能写在 `@着色` 块内：原生行里的颜色/控制转移不受配对规则保护；请移到着色块外。',
      node.span,
    );
    return;
  }
  if (node.lines.length === 0) {
    report(state, 'core/native/empty', '`@原生` 块是空的：逃生舱必须至少有一行 ERB；不生成任何字节。', node.span);
    return;
  }
  const firstBodyLine = node.span.start.line + 1;
  for (let i = 0; i < node.lines.length; i++) {
    const text = node.lines[i]!;
    const line = firstBodyLine + i;
    state.buffer.push(text, {
      kind: 'native',
      source: { start: { line, column: 1 }, end: { line, column: text.length + 1 } },
    });
  }
}
