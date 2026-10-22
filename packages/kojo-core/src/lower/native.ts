/**
 * `@原生` 缩进围栏：**逐行透传**（§8.5 / §16.2 C2.10）。
 *
 * 块体由 parser 按"最小前导空白"去缩进并原样保留（空行、`;` 注释、Tab、行尾 `\` 不动），
 * 并把每行被剥掉的码元数记进 `lineColumns`；本模块只做三件事：合法性守门、逐行写出、
 * 把每一行折回**物理源行/物理列**（source map 逐行保留）。
 *
 * 坐标：块头 `@原生` 在第 L 行 ⇒ 块体第 i 行（0 基）在物理第 `L + 1 + i` 行；
 * 块体保留空行 ⇒ 行序与物理行 1:1，折回不靠猜。列一律走 `column-fold.ts` 的
 * `foldDedentedPosition`（与 v1 折行面同一份折回实现）：去缩进视图里第 1 列 ⇒ 该行物理起点列，
 * 去缩进视图末列之后 ⇒ 物理行尾之后。**行尾 `\` 在这里是 ERB 文本，不是 2.0 折行**——
 * 2.0 没有源折行，`@原生` 逐行透传，`\` 原样进产物（§C2.10）。
 */
import type { KojoNativeBlock, KojoSpan } from '../ast.js';
import { foldDedentedPosition, nativeLineView } from './column-fold.js';
import type { LowerState } from './state.js';
import { report } from './state.js';

/**
 * `@原生` 块体的**物理列**附加面（additive 契约；形状与 `ast.ts::KojoNativeBlock.lineColumns`
 * 逐字相同，保留此别名是为了既有 consumer 的 import 路径不破）。
 *
 * `lineColumns[i]` = `node.lines[i]` 第一个码元在该物理源行里的 **1 基列**（UTF-16 码元口径）。
 * parser 现在恒提供它；手工构造的节点（微基准 / 旧消费方）可以缺省，缺省时退化为
 * **去缩进视图坐标**（与原实现逐字相等），不伪造物理列——宁缺勿编。
 */
export type NativeLineColumns = Pick<KojoNativeBlock, 'lineColumns'>;

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
  const lineColumns = lineColumnsOf(node);
  const firstBodyLine = node.span.start.line + 1;
  for (let i = 0; i < node.lines.length; i++) {
    const text = node.lines[i]!;
    const line = firstBodyLine + i;
    // 有 `lineColumns` 时是**物理列**；缺省列 1 = 去缩进视图坐标（手工节点 / 旧口径）。
    const startColumn = lineColumns?.[i] ?? 1;
    const view = nativeLineView(line, startColumn, text);
    // 半开区间 `[行首, 行尾之后)`：空行的 start === end（零宽，不给假列）。
    const source: KojoSpan = {
      start: foldDedentedPosition(view, { line, column: 1 }),
      end: foldDedentedPosition(view, { line, column: text.length + 1 }),
    };
    state.buffer.push(text, { kind: 'native', source });
  }
}

/** 取附加面 `lineColumns`：长度必须与 `lines` 逐行对齐，否则整块按缺省口径（不半信半疑） */
function lineColumnsOf(node: KojoNativeBlock): readonly number[] | undefined {
  const columns = node.lineColumns;
  if (columns === undefined || columns.length !== node.lines.length) return undefined;
  return columns;
}

/**
 * 坐标折回的**唯一实现**（`column-fold.ts`）经本模块进入 core 公共面：core 内不再另开一个
 * 导出文件，v1（kojo-sugar）从 `@kojo/kojo-core` 复用同一份（只搬一份，禁止第二实现）。
 * 依赖方向单向：core 不认识插件包。
 */
export * from './column-fold.js';
