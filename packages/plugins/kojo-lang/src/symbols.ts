/**
 * `documentSymbol` 供方：包里的平铺符号事实 → 契约的**嵌套**大纲项。
 *
 * ## 组树为什么在这里做，不在包里
 *
 * 包里给的是**平铺事实** + `container`（父符号在数组里的下标）。那是语言事实的
 * 最小完备形式：谁想怎么摆是消费方的选择（大纲要嵌套树、面包屑只要一条路径、
 * 粘性滚动只关心"当前在第几个块里"）。组树写进包，等于让三种消费方共用一种摆法。
 *
 * 平铺 + 下标还有一个硬理由：**父恒在子之前**（一遍扫描即可组树），而用名字做父引用
 * 在"同名声明"（core 会报错，但错误态下编辑器照样得能画出大纲）时没有确定答案。
 *
 * ## 类别映射（契约只认四个中性类别）
 *
 * 契约的 `EditorDocumentSymbolKind` 是 `function / section / block / declaration`——
 * 它说的是"这是哪种**层次**的东西"，不是"这是哪个语法结构"。2.0 的九种符号压到这四个：
 * - `# 幕` / `# 机` → `section`：都是"一大段"（幕是整篇的段落，机是钩子段）；
 * - `@织`（`weave`）与 `# 模`（`template`）→ `block`：都是挂在别的结构里的块
 *   （监听块、编译期展开的模板块）；
 * - `@函`（`function`）→ `function`：能带参调用；
 * - `# 变量` / `# 常量` / `# 表` / `# 池` / `# 视` → `declaration`：声明就是声明，
 *   具体是哪种由 `detail` 里的声明词说清楚（那是语言自己的词，不是编辑器的分类）。
 *
 * 具体是哪种**没有丢**：`detail` 原样带着包给的副标题（声明词 + 一句话事实），
 * 作者在大纲里看到的仍是"`# 表 心情`"，不是"declaration 心情"。
 */
import type {
  EditorDocumentSymbol,
  EditorDocumentSymbolKind,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { kojo2DocumentSymbols, type Kojo2SymbolFact, type Kojo2SymbolKind } from '@kojo/kojo-lang/symbols';
import { isKojo2Request } from './request';

/** 2.0 符号种类 → 契约的中性类别（**唯一映射表**，理由见本文件头注） */
const SYMBOL_KIND: Readonly<Record<Kojo2SymbolKind, EditorDocumentSymbolKind>> = {
  scene: 'section',
  machine: 'section',
  weave: 'block',
  template: 'block',
  function: 'function',
  view: 'declaration',
  variable: 'declaration',
  constant: 'declaration',
  table: 'declaration',
  pool: 'declaration',
};

/**
 * 平铺事实 → 大纲树。
 *
 * `container` 的三种坏值（`undefined` / 负数 / 不在 `[0, i)` 内）一律当**顶层**：
 * 它们只可能来自损坏的输入，而大纲是只读呈现面——把一项挂到不存在的父上等于整棵树
 * 少一段，静默丢结构比多一个顶层项糟得多。
 */
export function symbolFactsToTree(facts: readonly Kojo2SymbolFact[]): EditorDocumentSymbol[] {
  const nodes: EditorDocumentSymbol[] = facts.map((fact) => ({
    name: fact.name,
    kind: SYMBOL_KIND[fact.kind] ?? 'declaration',
    startLine: fact.range.startLine,
    endLine: fact.range.endLine,
    ...(fact.detail.length > 0 ? { detail: fact.detail } : {}),
  }));
  const roots: EditorDocumentSymbol[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const parent = facts[i]?.container;
    if (parent === undefined || parent < 0 || parent >= i) {
      roots.push(node);
      continue;
    }
    const parentNode = nodes[parent];
    if (parentNode === undefined) {
      roots.push(node);
      continue;
    }
    // 契约里 `children` 是 readonly 数组 —— 组树时用可变副本，最后交回只读形状。
    const children = (parentNode.children ?? []) as EditorDocumentSymbol[];
    children.push(node);
    (parentNode as { children?: readonly EditorDocumentSymbol[] }).children = children;
  }
  return roots;
}

/**
 * 交回 `{ kind: 'documentSymbol', symbols }`，或 `undefined`（弃权）。
 *
 * 抛错面同 `provideDefinition`：归成空数组（"这篇没有结构"），不让 throw 冒到宿主——
 * 宿主会把 throw 吞成"大纲突然空了"，而空数组至少是一个**有语义**的答案。
 */
export function provideDocumentSymbols(
  request: EditorLanguageServiceRequest,
): { kind: 'documentSymbol'; symbols: EditorDocumentSymbol[] } | undefined {
  if (request.kind !== 'documentSymbol') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    return { kind: 'documentSymbol', symbols: symbolFactsToTree(kojo2DocumentSymbols(request.text)) };
  } catch {
    return { kind: 'documentSymbol', symbols: [] };
  }
}
