/**
 * 展开层的**唯一名字查找**：`@巡` 绑定槽优先，其次表值槽。
 *
 * 为什么单独一层：`# 表` 展开与 `@巡` 绑定改写都要替换"名字位置"的标识符，两者的
 * 优先级是语言层规则（绑定名遮蔽同名表 = 名字解析优先级），必须只有一份实现——
 * 否则 textLine / 条件 / 模板实参 各写一套判据，迟早漏一条路径（出体后仍改名、
 * 或循环体内改名不生效）。
 *
 * 只做保守的标识符替换（不解析表达式语法）：字符串字面量原样跳过，调用位 `名(` 与
 * 属性位 `名.` 不替换（与 `tables.ts` 同一判据）。
 */
import type { KojoExprText } from '../../ast.js';
import type { ExpandContext } from './context.js';
import { foreachSlotInScope } from './context.js';
import type { NameNeighbors } from './expr.js';
import { isBareIdentifier, rewriteExpr } from './expr.js';
import { isNamePosition, tableLookup } from './tables.js';

export function expandLookup(
  ctx: ExpandContext,
): (name: string, neighbors: NameNeighbors) => string | undefined {
  const table = tableLookup(ctx);
  return (name, neighbors) => {
    if (isNamePosition(neighbors)) {
      const slot = foreachSlotInScope(ctx, name);
      if (slot !== null) return slot;
    }
    return table(name, neighbors);
  };
}

/**
 * 调度区表达式里的**简单名字引用** `{名字}`（§2.5：等价于裸 `名字`）→ 裸槽名。
 *
 * 为什么在展开层做：`{名字}` 只是作者面的"这是名字"标记，隐藏槽名是普通标识符，
 * 产物里必须裸写（引擎表达式不认花括号）。只处理"整段花括号里恰好一个标识符"且
 * 该标识符是当前 `@巡` 绑定名——其它花括号形态（`{条件 ? A : B}`）原样留给表达式管线。
 * 字符串字面量内部不动（那里是作者要打印的文本）。
 */
function unwrapBoundBraces(text: string, ctx: ExpandContext): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        const inner = text[i]!;
        if (inner === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (inner === '"') break;
      }
      out += text.slice(start, i);
      continue;
    }
    if (ch === '{') {
      const close = text.indexOf('}', i + 1);
      if (close > i + 1) {
        const inner = text.slice(i + 1, close).trim();
        if (isBareIdentifier(inner)) {
          const slot = foreachSlotInScope(ctx, inner);
          if (slot !== null) {
            out += slot;
            i = close + 1;
            continue;
          }
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 展开层表达式改写（`{名字}` 解壳 + 名字位置替换）：`walk` / 模板实参 / 集合表达式共用。
 * 未命中时 `rewriteExpr` 原样返回同一对象（零拷贝）。
 */
export function rewriteExpandExpr(expr: KojoExprText, ctx: ExpandContext): KojoExprText {
  const unwrapped = unwrapBoundBraces(expr.text, ctx);
  const base = unwrapped === expr.text ? expr : { text: unwrapped, span: expr.span };
  return rewriteExpr(base, expandLookup(ctx)).expr;
}

