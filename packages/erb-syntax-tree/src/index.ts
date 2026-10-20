import { Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';

/**
 * ERB 结构语法的**装载面**（不是语义层）。
 *
 * 本包只回答"哪一行是什么结构、哪些行能折起来"：不做符号表、不做索引、不做 semantic tokens。
 * 宿主经语言描述符的 `structure.load()` 取运行时；折叠走的正是这里的 `createParser()` /
 * `compileQuery()` / `foldRanges()` 同一条面（浏览器侧由 `erb-ts.worker.ts` 注入 wasm 与查询），
 * Node 读数工具也走同一面，避免工具与宿主各写一份坐标口径。
 */

let languagePromise: Promise<Language> | null = null;

/** 载入语言（wasm 路径由调用方注入：测试传绝对路径、宿主传 `?url` 解析结果）。 */
export function loadLanguage(wasmPath: string): Promise<Language> {
  if (!languagePromise) {
    languagePromise = (async () => {
      await Parser.init();
      return Language.load(wasmPath);
    })();
  }
  return languagePromise;
}

/** 新建绑定 erb 语言的 parser（每线程独立实例）。 */
export async function createParser(wasmPath: string): Promise<Parser> {
  await Parser.init();
  const language = await loadLanguage(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** 编译查询（折叠 / 高亮都走这里；查询文本由调用方给，本包不内嵌第二份）。 */
export function compileQuery(language: Language, source: string): Query {
  return new Query(language, source);
}

/**
 * 解析整篇文本。控制行 token 以行尾换行为终点（短词不吃长词前缀），因此末尾无换行的
 * 文本补一个虚拟换行再喂解析器；已有换行一字不动（节点坐标不受影响）。
 */
export function parseStructureText(parser: Parser, text: string): Tree {
  return parser.parse(text.endsWith('\n') ? text : `${text}\n`);
}

/** 折叠区间（0 基行；`endRow` 为可隐藏区间的最后一行）。 */
export interface FoldRange {
  readonly startRow: number;
  readonly endRow: number;
}

/**
 * 从 `@fold` 捕获取折叠区间。
 *
 * 止行口径：块节点常常把**收尾换行**吃进 span（函数体 / 分支段的 `repeat(_body_item)` 以换行收尾），
 * 此时 `endPosition` 停在下一行行首（column 0）⇒ 回退一行，否则折叠会把下一条 `@` 行也藏进去。
 * 零跨度区间（空函数 / 空块）不返回：没有可隐藏的行。
 */
export function foldRanges(query: Query, tree: Tree): FoldRange[] {
  const out: FoldRange[] = [];
  for (const match of query.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      if (capture.name !== 'fold') continue;
      const node: Node = capture.node;
      let endRow = node.endPosition.row;
      if (endRow > node.startPosition.row && node.endPosition.column === 0) endRow -= 1;
      const startRow = node.startPosition.row;
      if (endRow > startRow) out.push({ startRow, endRow });
    }
  }
  out.sort((a, b) => a.startRow - b.startRow || a.endRow - b.endRow);
  return out;
}
