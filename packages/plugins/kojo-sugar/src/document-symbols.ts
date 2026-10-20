import type {
  EditorDocumentSymbol,
  IfBranch,
  SugarDoc,
  SugarNode,
  SugarSourceSpan,
  SugarTopLevelNode,
  TimingBlock,
  WhenBranch,
} from '@kojo/plugin-api';
import type { CatchBlock, DataBlock, LoopBlock, RulePoolBlock, RulePoolBranch } from './parser';
import type { HeartBlock } from './types';

/**
 * `.kojo` 文档 → 大纲（B3）。
 *
 * 数据源刻意是 `sugar.transpile` 的 `parse` 结果（**纯函数、无 IO**），而且用的是宿主给的
 * **缓冲区文本**——糖 AST 每个节点自带 `loc`（源映射地基），大纲因此天然与作者正在编辑的
 * 那份内容逐行对齐，不存在"索引过期"这回事，也不需要第二份表。
 *
 * 只收**结构节点**（时机 / 若 / 分支 / 选项 / 循环 / 出错处理…），台词行与注释不进大纲：
 * 大纲是"现在在哪一层"的导航，把每句台词列出来只会得到第二份正文。
 */

/** 名称 / 副标题上限（大纲一行一项；长条件截断而不是折行） */
const NAME_MAX = 70;
const DETAIL_MAX = 60;

/**
 * 截断到 `max` 码元（含尾省略号）。
 *
 * 截断点若正落在代理对中间（高位留下、低位被切走），再退一码元——孤立代理在
 * Monaco 里显示成 `�`，等于静默丢字（星外汉字 / 表情名都会踩到）。
 */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let cut = max - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
};

/**
 * 转译器**内部** AST 块（循环 / 出错处理 / 数据表 / 规则池 / 心形连续块）。
 *
 * 这些形状沿用 `HeartBlock` 的既有先例：不出转译器、不进契约闭集（见 `parser.ts` 头注）。
 * 大纲必须看见它们——否则块里的 `如果` / `选项` 会整段失踪，结构感在这里断档；
 * 类型按同包 parser / types 的导出入账，不另抄一份形状、更不扫第二遍源文本。
 */
type InternalBlock = LoopBlock | CatchBlock | DataBlock | RulePoolBlock | HeartBlock;

/** 大纲遍历的节点面：契约节点 + 转译器内部块 */
type SymbolNode = SugarNode | SugarTopLevelNode | InternalBlock;

/** 块头行的区间（1 基、闭区间）；`cover` 里的子节点要算进来（分支头只覆盖自己那一行） */
function rangeOf(
  loc: SugarSourceSpan,
  cover?: readonly { readonly loc: SugarSourceSpan }[],
): { startLine: number; endLine: number } {
  const startLine = loc.start.line;
  let endLine = loc.end.line >= startLine ? loc.end.line : startLine;
  for (const child of cover ?? []) endLine = Math.max(endLine, child.loc.end.line);
  return { startLine, endLine };
}

const joinParts = (parts: readonly (string | undefined | '')[]): string =>
  clip(
    parts
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' '),
    NAME_MAX,
  );

/** 时机块标题（`时机 指令 310` / `时机 事件 摸屁股`） */
function timingName(node: TimingBlock): string {
  return joinParts(['时机', node.face, node.indexName ?? node.index]);
}

function timingDetail(node: TimingBlock): string {
  return clip(
    node.namedParams.map((p) => `${p.name}: ${p.value}`).join(' · '),
    DETAIL_MAX,
  );
}

function ifBranchName(branch: Pick<IfBranch, 'kind' | 'condition'>): string {
  if (branch.kind === 'else') return '否则';
  return joinParts([branch.kind === 'if' ? '如果' : '否则如果', branch.condition]);
}

/**
 * `分支：` 规则池的分支名——**不另起一套命名**：这一族语义就是 `如果 / 否则如果 / 否则`
 * 的写法糖（`codegen.ts::emitRulePoolBlock` 把它映射成 `IfBranch` 后走同一条发射路径），
 * 所以大纲名直接复用 `ifBranchName`，只把 `kind` 由**书写位置**推出（首条 = `如果`、
 * 其后 = `否则如果`、兜底 = `否则`）。产物侧可能按 §3.11 自动重排，大纲跟着源码行走
 * ——大纲是"这一行写了什么"的导航，不是发射顺序。
 */
function rulePoolBranchName(branch: RulePoolBranch, index: number): string {
  return ifBranchName({
    kind: branch.kind === 'else' ? 'else' : index === 0 ? 'if' : 'elseif',
    condition: branch.condition,
  });
}

function caseBranchName(branch: WhenBranch): string {
  if (branch.kind === 'else') return '否则';
  return joinParts([
    '是',
    branch.values.map((value) => (value.to === null || value.to === '' ? value.from : `${value.from} 到 ${value.to}`)).join(', '),
  ]);
}

/** 条目类子项（选项 / 菜单 / 询问 / 确认共用：`「标签」` + 自身体） */
interface LabeledItem {
  readonly label: string;
  readonly body: readonly SugarNode[];
  readonly loc: SugarSourceSpan;
}

const labeledItemSymbols = (items: readonly LabeledItem[]): EditorDocumentSymbol[] =>
  items.map((item) =>
    finish({
      name: clip(`「${item.label}」`, NAME_MAX),
      kind: 'block' as const,
      ...rangeOf(item.loc, item.body),
      children: symbolsOfNodes(item.body),
    }),
  );

/** 一条子项（分支 / 候选 / 条目都由块头行 + 自身体决定区间）；与顶层项走同一收尾（含摘空箭头） */
function childSymbol(name: string, loc: SugarSourceSpan, body: readonly SymbolNode[]): EditorDocumentSymbol {
  return finish({ name, kind: 'block', ...rangeOf(loc, body), children: symbolsOfNodes(body) });
}

/** 节点 → 大纲项（非结构节点返回 null）；`RulePoolBlock` / `HeartBlock` / `LoopBlock` / `CatchBlock` / `DataBlock` 是转译器内部节点，同 `codegen` 的 `emitStatement` 口径并入入参类型 */
function rawSymbol(
  node: SugarNode | SugarTopLevelNode | RulePoolBlock | HeartBlock | LoopBlock | CatchBlock | DataBlock,
): EditorDocumentSymbol | null {
  switch (node.kind) {
    case 'timingBlock': {
      const detail = timingDetail(node);
      return {
        name: timingName(node),
        kind: 'function',
        ...rangeOf(node.loc, node.body),
        ...(detail ? { detail } : {}),
        children: symbolsOfNodes(node.body),
      };
    }
    case 'functionBlock':
      return {
        name: joinParts(['函数', node.name]),
        kind: 'function',
        ...rangeOf(node.loc, node.body),
        ...(node.params.length > 0
          ? {
              detail: clip(
                `(${node.params.map((p, i) => (node.defaults?.[i] === undefined ? p : `${p} = ${node.defaults[i]}`)).join(', ')})`,
                DETAIL_MAX,
              ),
            }
          : {}),
        children: symbolsOfNodes(node.body),
      };
    case 'custom-command':
      return {
        name: joinParts(['自定指令', node.name, node.index === undefined ? undefined : `编号 ${node.index}`]),
        kind: 'function',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'sectionBlock':
      return {
        name: joinParts(['若', node.condition]),
        kind: 'section',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'onceBlock':
      return {
        name: joinParts(['初回', node.key]),
        kind: 'block',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'ifBlock': {
      const first = node.branches[0];
      return {
        name: first ? ifBranchName(first) : '如果',
        kind: 'block',
        ...rangeOf(node.loc),
        children: node.branches.map((branch) => childSymbol(ifBranchName(branch), branch.loc, branch.body)),
      };
    }
    case 'whenBlock':
      return {
        name: joinParts(['当', node.subject]),
        kind: 'block',
        ...rangeOf(node.loc),
        children: node.branches.map((branch) => childSymbol(caseBranchName(branch), branch.loc, branch.body)),
      };
    case 'rulePoolBlock':
      // `分支：` 规则池（转译器内部 AST 节点，不进契约闭集——同 heartBlock / loopBlock）。
      // 形状照 `randomBlock`：池本身一枚 + 每条分支一个子项，折叠与大纲同源于这棵树。
      return {
        name: '分支',
        kind: 'block',
        ...rangeOf(node.loc),
        children: node.branches.map((branch, i) =>
          childSymbol(rulePoolBranchName(branch, i), branch.loc, branch.body),
        ),
      };
    case 'heartBlock':
      // `心形：` 连续块（转译器内部 AST 节点，不进契约闭集——同 `rulePoolBlock`）。块体只许文本行
      // 与注释，两者按顶层同一判据都不进大纲 ⇒ 本族**只有一枚叶子**。块体混进语句时 parser 已报
      // error 进 `diagnostics`（codegen 据此一条字节都不产），大纲不重复判也不跟着静默：
      // 源码确实写了这一行块头，导航就该指得到它。
      return { name: '心形', kind: 'block', ...rangeOf(node.loc, node.body) };
    case 'loopBlock':
      // `循环 …：`（转译器内部 AST 节点，不进契约闭集——同 `rulePoolBlock`）。形状照 `groupBlock`：
      // 块本身一枚 + 块体里每族各成子项——循环体内的 `如果` / `分支：` 此前整族不可见。
      // 区间含**收束行**（`parser.ts::parseLoopBlock` 把消费掉的 `循环结束` 记进 `loc`）：这一族
      // 写了收束词就要连它一起折，不许把尾巴留在折叠外（`出错处理` / `数据表` 登记时照此办理）。
      // 模态（`FOR` / `WHILE` / `REPEAT` / `DO`）不进名称：大纲按族给名，与 `随机` / `组` 同一口径。
      return {
        name: '循环',
        kind: 'block',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'catchBlock':
      // `出错处理：`（转译器内部 AST 节点，不进契约闭集——同 `loopBlock`）。形状照 `groupBlock`：
      // 块本身一枚 + 块体里每族各成子项。区间含**收束行**（`parser.ts::parseCatchBlock` 把消费掉的
      // `出错处理结束` 记进 `loc`）——与 `循环` 同一条区间口径，折起来把收束词一起藏掉。
      return {
        name: '出错处理',
        kind: 'block',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'dataBlock':
      // `数据表：`（转译器内部 AST 节点，不进契约闭集——同 `loopBlock`）。块体只许条目行与注释
      // （两者按顶层同一判据都不进大纲）⇒ 本族**只有一枚叶子**，形状照 `heartBlock`。
      // 区间含**收束行**（`parser.ts::parseDataBlock` 把消费掉的 `数据表结束` 记进 `loc`）。
      // 条目行混进语句时 parser 已报 error 进 `diagnostics`（codegen 据此一条字节都不产），
      // 大纲不重复判——源码写了这一块，导航就该指得到它（与 `心形` 的同一口径）。
      return { name: '数据表', kind: 'block', ...rangeOf(node.loc, node.body) };
    case 'ifExpr':
    case 'whenExpr': {
      // 表达式位置的 `如果` / `当`：结构同块，但要说清"赋给谁"——大纲里看不出左值就是误导
      const inner = rawSymbol(node.block);
      if (!inner) return null;
      return { ...inner, ...rangeOf(node.loc), detail: clip(`→ ${node.target}`, DETAIL_MAX) };
    }
    case 'randomBlock':
      return {
        name: '随机',
        kind: 'block',
        ...rangeOf(node.loc),
        children: node.alternatives.map((alt, i) => childSymbol(`候选 ${i + 1}`, alt.loc, alt.body)),
      };
    case 'groupBlock':
      return {
        name: '组',
        kind: 'block',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'choiceBlock':
      return { name: '选项', kind: 'block', ...rangeOf(node.loc), children: labeledItemSymbols(node.items) };
    case 'menuBlock':
      return { name: '菜单', kind: 'block', ...rangeOf(node.loc), children: labeledItemSymbols(node.items) };
    case 'askMBlock':
    case 'askYNBlock':
      // `询问：` / `确认：`（契约节点）与 `选项` / `菜单` **同构**：块一枚 + 每条 `「标签」：` 一个子项
      // ——条目的 `label` / `loc` / `body` 与 `ChoiceItem` 同形，故直接复用 `labeledItemSymbols`，不另造命名。
      // 族名按**族**给（`询问` / `确认`），模态与提示文案不进名称（同 `随机` / `组` 的口径）。
      return {
        name: node.kind === 'askMBlock' ? '询问' : '确认',
        kind: 'block',
        ...rangeOf(node.loc),
        children: labeledItemSymbols(node.items),
      };
    case 'colorBlock':
      return {
        name: joinParts(['着色', node.color]),
        kind: 'block',
        ...rangeOf(node.loc, node.body),
        children: symbolsOfNodes(node.body),
      };
    case 'rawFunctionBlock': {
      const head = (node.lines[0] ?? '').trim();
      return head.length === 0 ? null : { name: clip(head, NAME_MAX), kind: 'function', ...rangeOf(node.loc) };
    }
    // `开关:` 是唯一的「带头声明的块」：大纲一枚叶子（条目不进大纲，同 `别名` 右值口径），
    // 折叠真源 `kojoFoldingRanges` 摊平本树 ⇒ 登记一次，大纲/吸顶/面包屑/折叠同值。
    // `loc` 已含体后尾随空行，与 CST 折叠的伸行口径逐行对齐（A/B 闸的「仅 CST」两条）。
    case 'switchBlock':
      return { name: '开关', kind: 'block', ...rangeOf(node.loc) };
    case 'aliasDecl':
      return { name: joinParts(['别名', node.name]), kind: 'declaration', ...rangeOf(node.loc) };
    case 'constDecl':
      return { name: joinParts(['常量', node.name]), kind: 'declaration', ...rangeOf(node.loc) };
    default:
      return null;
  }
}

/**
 * 收尾两件事（每条项都要过）：
 * - **区间含子项**：`如果` / `选项` 这类块头的 `loc.end` 只到最后一行的块骨架，
 *   父项区间可能短于子项——大纲树要求父含子，否则展开箭头指向的内容在区间外；
 * - **摘掉空 `children`**：空数组会渲染成"点不开的假箭头"。
 */
function finish(symbol: EditorDocumentSymbol): EditorDocumentSymbol {
  const children = symbol.children;
  if (children === undefined || children.length === 0) {
    const { children: dropped, ...rest } = symbol;
    void dropped;
    return rest;
  }
  const endLine = children.reduce((max, child) => Math.max(max, child.endLine), symbol.endLine);
  return { ...symbol, endLine, children };
}

function symbolOf(node: SymbolNode): EditorDocumentSymbol | null {
  const symbol = rawSymbol(node);
  return symbol === null ? null : finish(symbol);
}

function symbolsOfNodes(nodes: readonly SymbolNode[]): EditorDocumentSymbol[] {
  const out: EditorDocumentSymbol[] = [];
  for (const node of nodes) {
    const symbol = symbolOf(node);
    if (symbol) out.push(symbol);
  }
  return out;
}

/** 顶层大纲（`别名` 声明 + 时机块 + 用户函数 + 顶层原生块） */
export function kojoDocumentSymbols(doc: SugarDoc): EditorDocumentSymbol[] {
  return symbolsOfNodes(doc.topLevel);
}
