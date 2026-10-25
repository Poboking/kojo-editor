import { Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';

/**
 * ERB 结构语法的**装载面**（不是语义层）。
 *
 * 本包只回答"哪一行是什么结构、哪些行能折起来、哪些行是块的开/分支/收束"：不做符号表、
 * 不做索引。宿主经语言描述符的 `structure.load()` 取运行时；折叠走的正是这里的
 * `createParser()` / `compileQuery()` / `foldRanges()` 同一条面（浏览器侧由
 * `erb-ts.worker.ts` 注入 wasm 与查询），Node 读数工具也走同一面，避免工具与宿主各写一份
 * 坐标口径。语义着色 / 缩进 / 结构诊断的查询在同目录 `queries/`（判据在查询里，配色与
 * 上屏在宿主）。
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
  const tree = parser.parse(text.endsWith('\n') ? text : `${text}\n`);
  /**
   * `web-tree-sitter` 的类型把 `parse()` 写成 `Tree | null`（解析器还没 `setLanguage`
   * 时会返回 null）。本仓所有调用点都排在 `setLanguage` 之后，所以 null 只可能是
   * "wasm / parser 装配坏了"——**抛出去**比让半个树流到下游更容易定位（下游拿到 null
   * 会以 TypeError 的形式炸在无关的地方）。这是纯类型对齐，不改变任何正常路径行为。
   */
  if (tree === null) throw new Error('tree-sitter 解析返回 null：parser 尚未 setLanguage？');
  return tree;
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
 *
 * ## 预处理条件块（2026-10-25 ERB 语法缺口批 P0-3）
 * `[IF XXX]` / `[IF_DEBUG]` / `[IF_NDEBUG]` … `[ENDIF]` 的折叠**不走查询**，由
 * `collectPreprocFolds()` 在 CST 上配对补出。原因写在 grammar 头注：这批块在引擎里是
 * "按条件裁剪后才编译"的，块内可以有**不配平**的 `IF…ENDIF`；若在文法里建块，
 * 每份这类文件都会落 MISSING（整篇红），而真语料 3,980 份的 `0 ERROR / 0 MISSING`
 * 是硬门槛。配对只认"严格等值"的整行标记（见 `PREPROC_*`），残形一律不配对。
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
  collectPreprocFolds(tree.rootNode, out);
  out.sort((a, b) => a.startRow - b.startRow || a.endRow - b.endRow);
  return out;
}

// ---------------------------------------------------------------------------
// 预处理条件块（Emuera 预处理器）
// ---------------------------------------------------------------------------

/**
 * 三个开块形共用一枚 `[ENDIF]`（引擎事实：`[IF xxx]` / `[IF_DEBUG]` / `[IF_NDEBUG]`
 * 都靠 `[ENDIF]` 收尾）⇒ 配对表按"开块族"认，不做词一一映射。
 *
 * 匹配**严格等值**（整行只有标记，允许尾随空白）：与 `[SKIPSTART]` 的判据同一条纪律——
 * 宁可漏认一行，也不要把 ASCII 画里的 `[IF …]` 当成块边界。大小写不敏感：预处理器命令
 * 在语料里三种大小写都出现过（`[IF_DEBUG]` 41 / `[IF DEBUG]` 40 同盘并存）。
 */
const PREPROC_OPEN = /^\[(?:IF\s+[^\]]*\S|IF_DEBUG|IF_NDEBUG)\]\s*$/i;
const PREPROC_BRANCH = /^\[(?:ELSEIF\s+[^\]]*\S|ELSE)\]\s*$/i;
const PREPROC_CLOSE = /^\[ENDIF\]\s*$/i;

/** `[` 行的三种预处理器角色；不是预处理器标记 ⇒ null */
export function preprocRoleOf(lineText: string): 'open' | 'branch' | 'close' | null {
  const text = lineText.trim();
  if (PREPROC_CLOSE.test(text)) return 'close';
  if (PREPROC_BRANCH.test(text)) return 'branch';
  if (PREPROC_OPEN.test(text)) return 'open';
  return null;
}

/** 文档序遍历 `bracket_line`，把 `[IF*]`…`[ENDIF]` 配成折叠区间（未配对的开块不产区间） */
function collectPreprocFolds(root: Node, out: FoldRange[]): void {
  const openRows: number[] = [];
  const walk = (n: Node): void => {
    if (n.type === 'bracket_line') {
      const role = preprocRoleOf(n.text);
      if (role === 'open') {
        openRows.push(n.startPosition.row);
      } else if (role === 'close') {
        const startRow = openRows.pop();
        if (startRow !== undefined) {
          const endRow = n.startPosition.row;
          if (endRow > startRow) out.push({ startRow, endRow });
        }
      }
      // 分支行不改栈深（`[ELSEIF]` / `[ELSE]` 不另立折叠区间；分支级折叠后置）
      return;
    }
    for (const child of n.namedChildren) walk(child);
  };
  walk(root);
}
