import type {
  EditorSemanticTokenModifier,
  EditorSemanticTokenSpan,
  SugarDoc,
  SugarNode,
  SugarPosition,
  SugarTopLevelNode,
} from '@kojo/plugin-api';

/** 遍历面 = 语句节点 ∪ 顶层节点（顶层的 `函数` / `别名` / `常量` 不在 `SugarNode` 里） */
type AnySugarNode = SugarNode | SugarTopLevelNode;
import { locateIdentifier, modelLineAt, splitModelLines } from '@kojo/plugin-api';

/**
 * `.kojo` 结构化着色（B6，2026-10-16 结构化着色批）。
 *
 * ## 只画"词法判不出来"的三件事
 *
 * 糖的词法面（`kojo-language.ts` 的 Monarch）已经把关键字、代词、台词、插值、运算符
 * 全画完了——那些是**形状**，正则看得见。剩下的三件是**角色**，只有 AST 知道：
 *
 * | 产出 | 类别 | 为什么词法判不出来 |
 * |---|---|---|
 * | `函数 名字(…)` / `自定指令 名字` 的名字 | `function` + `declaration` | 中文串在词法里就是一枚 `identifier`，与正文里的同名散文无异 |
 * | `别名 名字 = …` / `常量 名字 = …` 的名字 | `variable` + `declaration`（+ `readonly`） | 同上；只读性还是**右值形态**决定的（规范 §3.1 表），不在那一行的形状里 |
 * | `函数` 形参表里的名字 | `parameter` | 括号内的中文段词法一律 `identifier` |
 * | `调用 名字(…)` 的名字 | `function` | 与上面那些 `identifier` 长得一模一样 |
 *
 * 刻意**不做**的：别名 / 常量 / 形参在**条件与插值里的使用点**（`如果 次数 > 3：` 里那个
 * `次数`）。糖节点把条件存成**原文字符串**（`IfBranch.condition` / `WhenExpr.subject`…），
 * 段内没有子记号区间 ⇒ 要画就得自己再切一遍表达式 = 长出第二份词法，与转译器的
 * `expression.ts` 迟早对不上。宁可只画声明位。
 *
 * ## 遍历为什么按形状而不列 kind 表
 *
 * `eachNode` 认的是"带 `kind` 与 `loc` 的普通对象"，不枚举容器字段（`body` / `branches` /
 * `items` / `alternatives`…）。列表就要跟 AST 一起改，忘了改的表现是"新写的块里颜色
 * 消失"——没人会当成 bug 报上来。按形状遍历让新增节点类型**自动**被覆盖，
 * 唯一漏的是没有 `loc` 的字段（那不是节点）。
 */

/** 一条声明 / 调用位点；定位不了（越行、折行续段、名字与行文本对不上）就返回空数组 */
function nameSpanAt(
  lines: readonly string[],
  start: SugarPosition,
  name: string,
  tokenType: EditorSemanticTokenSpan['tokenType'],
  modifiers?: EditorSemanticTokenSpan['modifiers'],
): EditorSemanticTokenSpan[] {
  const text = modelLineAt(lines, start.line);
  if (text === undefined) return [];
  const at = locateIdentifier(text, name, start.column - 1);
  if (at < 0) return [];
  return [
    {
      line: start.line,
      startColumn: at,
      endColumn: at + name.length,
      tokenType,
      ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
    },
  ];
}

/** 按声明顺序在块头行里滚动定位形参名（定位不到的一段不画；同 B5 签名帮助的单行口径） */
function paramSpans(
  lines: readonly string[],
  start: SugarPosition,
  params: readonly string[],
): EditorSemanticTokenSpan[] {
  const text = modelLineAt(lines, start.line);
  if (text === undefined) return [];
  const out: EditorSemanticTokenSpan[] = [];
  let cursor = start.column - 1;
  for (const name of params) {
    const at = locateIdentifier(text, name, cursor);
    if (at < 0) continue;
    out.push({ line: start.line, startColumn: at, endColumn: at + name.length, tokenType: 'parameter' });
    cursor = at - 1 + name.length;
  }
  return out;
}

/** 按形状遍历糖 AST：凡带 `kind` 且带 `loc` 的普通对象都算一个节点（见文件头取舍） */
function eachNode(value: unknown, out: AnySugarNode[]): void {
  if (Array.isArray(value)) {
    for (const item of value) eachNode(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as { kind?: unknown; loc?: unknown };
  if (typeof node.kind === 'string' && typeof node.loc === 'object' && node.loc !== null) out.push(value as AnySugarNode);
  for (const child of Object.values(value)) eachNode(child, out);
}

/**
 * 已解析的糖文档 → 着色 span（**纯函数**：文档 + 同一份缓冲区文本进，数据出；不读盘）。
 *
 * `text` 只用来把节点给的**行号**换算成**列**——文档与文本必须是同一份内容，
 * 对不上时逐条定位失败 ⇒ 少画，不会画错（`locateIdentifier` 的独立记号校验兜底）。
 */
export function kojoSemanticTokens(doc: SugarDoc, text: string): EditorSemanticTokenSpan[] {
  if (text.length === 0) return [];
  const lines = splitModelLines(text);
  const nodes: AnySugarNode[] = [];
  eachNode(doc.topLevel, nodes);
  const out: EditorSemanticTokenSpan[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case 'functionBlock':
        out.push(...nameSpanAt(lines, node.loc.start, node.name, 'function', ['declaration']));
        out.push(...paramSpans(lines, node.loc.start, node.params));
        break;
      case 'custom-command':
        out.push(...nameSpanAt(lines, node.loc.start, node.name, 'function', ['declaration']));
        break;
      case 'callStatement':
        out.push(...nameSpanAt(lines, node.loc.start, node.name, 'function'));
        break;
      case 'aliasDecl': {
        // 只读性来自右值形态（规范 §3.1：只有 `variable` 形态可写），不是宿主猜的
        const modifiers: EditorSemanticTokenModifier[] = ['declaration'];
        if (node.value.kind !== 'variable') modifiers.push('readonly');
        out.push(...nameSpanAt(lines, node.loc.start, node.name, 'variable', modifiers));
        break;
      }
      case 'constDecl':
        out.push(...nameSpanAt(lines, node.loc.start, node.name, 'variable', ['declaration', 'readonly']));
        break;
      default:
        break;
    }
  }
  return out;
}
