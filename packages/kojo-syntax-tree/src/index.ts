import { Parser, Language } from 'web-tree-sitter';
import { NODE_TO_KIND, type KojoKind, NON_LINE_NODES } from './node-types';

/**
 * kojo 语法层入口：在 Node（测试）与 Worker（宿主）里加载同一枚生成的 WASM，
 * 解析 `.kojo` 文本，产出**逐行 CST 分类**。宿主侧只经 worker 收发 ranges/tokens，
 * 主线程不直接调用本模块的解析（本模块可跑在 worker 线程内）。
 */

export interface KojoLine {
  /** 该行在文档中的 0 基行号 */
  row: number;
  /** 顶层行节点名（KIND_TO_NODE 值）；容器 / 非行节点为 null */
  nodeType: string;
  /** 反查出的 classifyLine kind（非分类节点为 null） */
  kind: KojoKind | null;
  /** 该节点的 [startRow, startColumn, endRow, endColumn] */
  range: [number, number, number, number];
}

let languagePromise: Promise<Language> | null = null;

/** 加载语言（wasm 路径由调用方注入，测试传绝对路径、宿主传 ?url 解析结果）。 */
export function loadLanguage(wasmPath: string): Promise<Language> {
  if (!languagePromise) {
    languagePromise = Language.load(wasmPath);
  }
  return languagePromise;
}

/** 新建一个绑定 kojo 语言的 parser（每线程独立实例）。 */
export async function createParser(wasmPath: string): Promise<Parser> {
  await Parser.init();
  const language = await loadLanguage(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** 顶层行节点：block 容器取其块头子节点，其余取自身。 */
function lineNodeOf(node: { type: string; namedChildren: Array<{ type: string }> }): {
  type: string;
} {
  if (node.type === 'block') {
    const head = node.namedChildren.find((c) => !NON_LINE_NODES.has(c.type));
    if (head) return head;
  }
  return node;
}

/** 解析文本，返回逐行分类（用于与 classifyLine 对照）。 */
export async function classifyLines(parser: Parser, text: string): Promise<KojoLine[]> {
  const tree = parser.parse(text);
  const out: KojoLine[] = [];
  for (const child of tree.rootNode.namedChildren) {
    const line = lineNodeOf(child);
    const kind = (NODE_TO_KIND as Record<string, KojoKind>)[line.type] ?? null;
    out.push({
      row: child.startRow,
      nodeType: line.type,
      kind,
      range: [child.startRow, child.startColumn, child.endRow, child.endColumn],
    });
  }
  return out;
}

export * from './node-types';
