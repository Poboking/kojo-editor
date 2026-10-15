import type {
  ChoiceItem,
  EditorDocumentSymbol,
  IfBranch,
  SugarDoc,
  SugarNode,
  SugarSourceSpan,
  SugarTopLevelNode,
  TimingBlock,
  WhenBranch,
} from '@kojo/plugin-api';

/**
 * `.kojo` 文档 → 大纲（B3）。
 *
 * 数据源刻意是 `sugar.transpile` 的 `parse` 结果（**纯函数、无 IO**），而且用的是宿主给的
 * **缓冲区文本**——糖 AST 每个节点自带 `loc`（源映射地基），大纲因此天然与作者正在编辑的
 * 那份内容逐行对齐，不存在"索引过期"这回事，也不需要第二份表。
 *
 * 只收**结构节点**（时机 / 段 / 分支 / 选项…），台词行与注释不进大纲：大纲是"现在在哪一层"
 * 的导航，把每句台词列出来只会得到第二份正文。
 */

/** 名称 / 副标题上限（大纲一行一项；长条件截断而不是折行） */
const NAME_MAX = 70;
const DETAIL_MAX = 60;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** 块头行的区间（1 基、闭区间）；`cover` 里的子节点要算进来（分支头只覆盖自己那一行） */
function rangeOf(loc: SugarSourceSpan, cover?: readonly SugarNode[]): { startLine: number; endLine: number } {
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

function ifBranchName(branch: IfBranch): string {
  if (branch.kind === 'else') return '否则';
  return joinParts([branch.kind === 'if' ? '如果' : '否则如果', branch.condition]);
}

function caseBranchName(branch: WhenBranch): string {
  if (branch.kind === 'else') return '否则';
  return joinParts([
    '是',
    branch.values.map((value) => (value.to === null || value.to === '' ? value.from : `${value.from} 到 ${value.to}`)).join(', '),
  ]);
}

const itemSymbols = (items: readonly ChoiceItem[]): EditorDocumentSymbol[] =>
  items.map((item) =>
    finish({
      name: clip(`「${item.label}」`, NAME_MAX),
      kind: 'block' as const,
      ...rangeOf(item.loc, item.body),
      children: symbolsOfNodes(item.body),
    }),
  );

/** 一条子项（分支 / 候选 / 条目都由块头行 + 自身体决定区间）；与顶层项走同一收尾（含摘空箭头） */
function childSymbol(name: string, loc: SugarSourceSpan, body: readonly SugarNode[]): EditorDocumentSymbol {
  return finish({ name, kind: 'block', ...rangeOf(loc, body), children: symbolsOfNodes(body) });
}

/** 节点 → 大纲项（非结构节点返回 null） */
function rawSymbol(node: SugarNode | SugarTopLevelNode): EditorDocumentSymbol | null {
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
        ...(node.params.length > 0 ? { detail: clip(`(${node.params.join(', ')})`, DETAIL_MAX) } : {}),
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
        name: joinParts(['段', node.condition]),
        kind: 'section',
        ...rangeOf(node.loc, node.body),
        ...(node.disabled ? { detail: '停用' } : {}),
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
      return { name: '选项', kind: 'block', ...rangeOf(node.loc), children: itemSymbols(node.items) };
    case 'menuBlock':
      return { name: '菜单', kind: 'block', ...rangeOf(node.loc), children: itemSymbols(node.items) };
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
    case 'aliasDecl':
      return { name: joinParts(['别名', node.name]), kind: 'declaration', ...rangeOf(node.loc) };
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

function symbolOf(node: SugarNode | SugarTopLevelNode): EditorDocumentSymbol | null {
  const symbol = rawSymbol(node);
  return symbol === null ? null : finish(symbol);
}

function symbolsOfNodes(nodes: readonly (SugarNode | SugarTopLevelNode)[]): EditorDocumentSymbol[] {
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
