import { Parser, Language, type Node } from 'web-tree-sitter';
import { NODE_TO_KIND, NON_LINE_NODES, type KojoKind, type KojoNode } from './node-types';

/**
 * kojo 语法层入口：在 Node（测试）与 Worker（宿主）里加载同一枚生成的 WASM，
 * 解析 `.kojo` 文本，产出**逐行 CST 分类**。宿主侧只经 worker 收发 ranges/tokens，
 * 主线程不直接调用本模块的解析（本模块可跑在 worker 线程内）。
 */

export interface KojoLine {
  /** 该行在文档中的 0 基行号（= 行节点**末字符**所在行：见 `rowOfLastChar` 的口径说明） */
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

/**
 * 行锚点 = 节点**最后一个字符**所在的行（需要全文的行表，见 `buildRowTable`）。
 *
 * 为什么不用 `startPosition.row`：本语法每行是一条原子记号，记号前面的 extras（换行 / 缩进）
 * 会被吞进该记号的 span ⇒ `startPosition.row` 常指到上一行。第二波把换行从 extras 里拿出来
 * 交给 `blank_line` 认领之后，行记号的起始行已经正确；但**块内首行**前面仍可能留着缩进 extras，
 * 且 `choice_item` 这类形本身跨到行尾——末字符锚点对所有形都成立，故一律取它。
 */
export function buildRowTable(text: string): number[] {
  const rows: number[] = [];
  let row = 0;
  for (let i = 0; i < text.length; i++) {
    rows.push(row);
    if (text[i] === '\n') row++;
  }
  return rows;
}

/** 节点末字符所在行（零宽节点回落到 `endPosition.row`）。 */
export function rowOfLastChar(node: Node, rows: number[]): number {
  const lastChar = node.endIndex - 1;
  if (lastChar < node.startIndex) return node.endPosition.row;
  return rows[Math.min(lastChar, rows.length - 1)] ?? node.endPosition.row;
}

/** 顶层行节点：块容器取其块头子节点，其余取自身。 */
function lineNodeOf(node: Node): Node {
  const head = node.childForFieldName('open');
  if (head) return head;
  return node;
}

/**
 * 容器节点：只穿过去、不当中行走（行节点 = 容器之外的一切具名子节点）。
 * `NON_LINE_NODES` 还包含 `string` / `native_string` 这类"行内词法形"——其中 `string`
 * 是整行的分型（对照闸要吃它），故这里另立一份**纯容器**表，不复用 `NON_LINE_NODES`。
 */
const CONTAINER_NODES: ReadonlySet<string> = new Set([
  'source_file',
  'block',
  'item_block',
  'block_body',
  'switch_body',
  'choice_body',
  'when_body',
]);

/**
 * 走完整棵树取**逐行**节点（块嵌套后行节点不再是 `source_file` 的直接子节点）。
 * 容器逐层下钻；行节点内部（原生串 / 行内注释尾巴）不再下钻 ⇒ 一行一枚。
 * 返回顺序 = 文档顺序（同一物理行争抢时留最先出现的那枚，与对照闸同一口径）。
 */
export function lineNodes(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (node: Node): void => {
    if (CONTAINER_NODES.has(node.type)) {
      for (const child of node.namedChildren) walk(child);
      return;
    }
    out.push(lineNodeOf(node));
  };
  walk(root);
  return out;
}

/** 解析文本，返回逐行分类（用于与 classifyLine 对照）。 */
export async function classifyLines(parser: Parser, text: string): Promise<KojoLine[]> {
  const tree = parser.parse(text);
  const rows = buildRowTable(text);
  const out: KojoLine[] = [];
  for (const child of lineNodes(tree.rootNode)) {
    const kind = (NODE_TO_KIND as Record<string, KojoKind | undefined>)[child.type] ?? null;
    out.push({
      row: rowOfLastChar(child, rows),
      nodeType: child.type,
      kind,
      range: [child.startPosition.row, child.startPosition.column, child.endPosition.row, child.endPosition.column],
    });
  }
  tree.delete();
  return out;
}

/** 节点名 → classifyLine kind（宿主按行反查用；非行节点回 null）。 */
export function kindOfNodeName(nodeType: string): KojoKind | null {
  return (NODE_TO_KIND as Partial<Record<KojoNode, KojoKind>>)[nodeType as KojoNode] ?? null;
}

export * from './node-types';
