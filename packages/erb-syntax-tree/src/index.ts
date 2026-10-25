import { Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';
import structure from './structure.json' with { type: 'json' };

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
 * ## 预处理条件块（2026-10-25 ERB 语法缺口批 P0-3 · 分支段 K3）
 * `[IF XXX]` / `[IF_DEBUG]` / `[IF_NDEBUG]` … `[ENDIF]` 的折叠**不走查询**，由
 * `collectPreprocFolds()` 在 CST 上配对补出。原因写在 grammar 头注：这批块在引擎里是
 * "按条件裁剪后才编译"的，块内可以有**不配平**的 `IF…ENDIF`；若在文法里建块，
 * 每份这类文件都会落 MISSING（整篇红），而真语料 3,980 份的 `0 ERROR / 0 MISSING`
 * 是硬门槛。配对只认契约真源那三枚"严格等值"整行正则（判据见下方 `PREPROC_*`），
 * 残形一律不配对。
 *
 * 区间形状与 ERB 控制流块**同款**（对齐 `erb-parser/src/folding.ts` 的
 * `controlFlowFoldingRanges`）：整块区间（开块行 → `[ENDIF]` 行）照旧给；分支行
 * （`[ELSE]` / `[ELSEIF …]`）另给"上一段起点 → 分支前一行"的段区间，`[ENDIF]` 再补末段
 * （末段只在真出现过分支时给，无分支块的段区间与整块只差收束行，重复给没有意义）。
 * 未配对一律**不产**（栈空遇到分支/收束 = 不动栈、不发区间；走到文件尾仍开着的块不产）。
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
 * 三枚判据**不在本文件手写**（此前这里是那份语言事实的第二处落地）：pattern 源与标志取自
 * `src/structure.json` 的 `preproc` 段，而该段由 `tools/gen-erb-structure.mjs` 从契约真源
 * `packages/plugin-api/src/erb.ts` 的 `ERB_PREPROC_PATTERNS` **构建期投影**而来。
 *
 * 为什么绕一道投影而不是直接 import 契约层：语言包不许依赖插件（本包既有纪律），也不该在
 * 动态装载面上 import 契约 barrel——那会把整张契约面拖进"只在开 ERB 时才走"的那条路径。
 * 通道与文法侧同形（grammar.js 同样只吃 structure.json）：投影与真源漂移由
 * `tests/projection-single-source.test.ts` 判红，两侧判据对拍由插件侧
 * `erb-parser/tests/preproc-block.test.ts` 钉住。
 *
 * 语言事实本身（严格等值、大小写不敏感、三个开块形共用一枚收束）的理由写在契约层注释里，
 * 这里不复述第二遍。正则**无 `g`/`y` 标志**（投影带这两枚会直接抛），`test()` 无状态，
 * 模块级共享实例安全。
 */
if (!structure.preproc) {
  // 缺段 = 生成脚本没跑 / 产物被手改（与 grammar.js 的 `need` 同一条 fail-closed 纪律）
  throw new Error('structure.json 缺 preproc 段——重跑 node packages/erb-syntax-tree/tools/gen-erb-structure.mjs');
}
const PREPROC_FLAGS = structure.preproc.flags;
const PREPROC_OPEN = new RegExp(structure.preproc.open, PREPROC_FLAGS);
const PREPROC_BRANCH = new RegExp(structure.preproc.branch, PREPROC_FLAGS);
const PREPROC_CLOSE = new RegExp(structure.preproc.close, PREPROC_FLAGS);

/** `[` 行的三种预处理器角色；不是预处理器标记 ⇒ null */
export function preprocRoleOf(lineText: string): 'open' | 'branch' | 'close' | null {
  const text = lineText.trim();
  if (PREPROC_CLOSE.test(text)) return 'close';
  if (PREPROC_BRANCH.test(text)) return 'branch';
  if (PREPROC_OPEN.test(text)) return 'open';
  return null;
}

/** 一个还开着的预处理块：开块行（整块折叠起点）+ 当前分支段起点 + 是否出现过分支 */
interface PreprocFrame {
  readonly openRow: number;
  segmentRow: number;
  sawBranch: boolean;
}

/**
 * 文档序遍历 `bracket_line`，把 `[IF*]`…`[ENDIF]` 配成折叠区间（整块 + 分支段，形状见
 * `foldRanges` 头注）。栈只在开块时压、收束时弹；分支行只移动栈顶帧的段起点、**不改栈深**。
 *
 * 容错口径与 `erb-parser/src/folding.ts` 逐字一致：孤儿 `[ELSE]` / `[ENDIF]`（栈空）不动栈、
 * 不发区间；走到文件尾仍开着的块不产区间（不许折到文末把整篇吞掉）；零跨度段不产。
 */
function collectPreprocFolds(root: Node, out: FoldRange[]): void {
  const stack: PreprocFrame[] = [];
  const top = (): PreprocFrame | undefined => stack[stack.length - 1];
  const walk = (n: Node): void => {
    if (n.type === 'bracket_line') {
      const role = preprocRoleOf(n.text);
      const row = n.startPosition.row;
      if (role === 'open') {
        stack.push({ openRow: row, segmentRow: row, sawBranch: false });
      } else if (role === 'branch') {
        const frame = top();
        if (frame !== undefined) {
          // 上一段起点 → 分支前一行（首个分支到来时这一段就是"块头段"，即 `[IF …]` 的体）
          if (row - 1 > frame.segmentRow) out.push({ startRow: frame.segmentRow, endRow: row - 1 });
          frame.segmentRow = row;
          frame.sawBranch = true;
        }
      } else if (role === 'close') {
        const frame = stack.pop();
        if (frame !== undefined) {
          // 末段只在真出现过分支时补（无分支块的段区间与整块只差收束行，重复给没有意义）
          if (frame.sawBranch && row - 1 > frame.segmentRow) {
            out.push({ startRow: frame.segmentRow, endRow: row - 1 });
          }
          if (row > frame.openRow) out.push({ startRow: frame.openRow, endRow: row });
        }
      }
      return;
    }
    for (const child of n.namedChildren) walk(child);
  };
  walk(root);
}
