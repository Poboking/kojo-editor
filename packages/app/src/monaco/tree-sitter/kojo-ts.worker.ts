/**
 * 结构解析 worker（**主线程永不解析**：CST 与查询只活在这一条线程里）。
 *
 * 装配点把它当独立线程用（`client.ts` 里 `new TsWorker()`），它自己只做四件事：
 * 载入两枚 wasm → 持有一枚 `Parser` 与一棵 `Tree` → 按消息增量重解并跑查询 →
 * 把结果压成**普通数据**发回去（Node 对象绝不跨线程，故每条回复都是新建的 plain array）。
 *
 * 三条纪律：
 * 1. **不 import Monaco、不 import 宿主 UI**：worker 的依赖面只有 web-tree-sitter +
 *    `./types` + `./assets`，主线程那套模块图（词表 / 主题 / 内核）一概不进这条线程；
 * 2. **增量优先**：`change` 走 `tree.edit()` + `parser.parse(text, oldTree)`，
 *    整篇重解只发生在 `parse`（首份 / 切文档 / 上一次增量失败后的重新对齐）；
 * 3. **出错就报出去，不硬撑**：任何一步抛错都回一条 `error`（带 `stage` 与 `capability`），
 *    由宿主决定是"整档回落"还是"这一面回落"。worker 自己绝不回落到半吊子状态继续答。
 */
import { Edit, Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';
import { KOJO_STRUCTURE_ASSETS } from './assets';
import {
  KOJO_STRUCTURE_MAX_TOKENS,
  KOJO_STRUCTURE_PROTOCOL,
  tierForCapture,
  type KojoStructureCapability,
  type KojoStructureErrorStage,
  type KojoStructureFold,
  type KojoStructureIndentRules,
  type KojoStructureReply,
  type KojoStructureRequest,
  type KojoStructureToken,
} from './types';

/** worker 全局的窄投影（app 的 tsconfig 只挂 DOM lib，不挂 WebWorker lib，故在此声明用到的三件） */
interface WorkerScope {
  postMessage(message: KojoStructureReply): void;
  onmessage: ((event: MessageEvent<KojoStructureRequest>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;

/** 抛错原因（本地一份，不为一条日志把 `@kojo/plugin-api` 拖进 worker 依赖图） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function post(message: KojoStructureReply): void {
  scope.postMessage(message);
}

function fail(
  version: number,
  stage: KojoStructureErrorStage,
  capability: KojoStructureCapability,
  message: string,
): void {
  post({ type: 'error', version, stage, capability, message });
}

/* ------------------------------- 线程内状态 ------------------------------- */

let parser: Parser | null = null;
let tree: Tree | null = null;
/** worker 自己那一版文本（与主线程的缝合口径逐字相同 ⇒ 两侧永远对齐，无需回传全文） */
let documentText = '';
let initialized = false;
let highlightsQuery: Query | null = null;
let foldsQuery: Query | null = null;
let indentsQuery: Query | null = null;
/** 已经报过的捕获名（同一名字只说一次，别每解一次刷屏） */
const reportedCaptures = new Set<string>();

/* -------------------------------- 查询执行 -------------------------------- */

/** `@name` 之类捕获 → 档位；表里没有就**说一次**并且不着色（绝不挑个"最像的"凑数） */
function tokensFrom(query: Query, root: Node): { tokens: KojoStructureToken[]; truncated: boolean } {
  const tokens: KojoStructureToken[] = [];
  for (const capture of query.captures(root)) {
    const tier = tierForCapture(capture.name);
    if (tier === null) {
      if (!reportedCaptures.has(capture.name)) {
        reportedCaptures.add(capture.name);
        fail(
          0,
          'query',
          'semantic',
          `highlights 查询里的捕获 @${capture.name} 没有档位映射 ⇒ 该类节点不着色（宿主侧在 types.ts 的 KOJO_STRUCTURE_CAPTURE_TIERS 里登记，或从查询里删掉）`,
        );
      }
      continue;
    }
    const node = capture.node;
    tokens.push({
      startRow: node.startPosition.row,
      startCol: node.startPosition.column,
      endRow: node.endPosition.row,
      endCol: node.endPosition.column,
      tier,
    });
    if (tokens.length > KOJO_STRUCTURE_MAX_TOKENS) {
      return { tokens, truncated: true };
    }
  }
  return { tokens, truncated: false };
}

/**
 * 折叠区间：约定用 `@fold` 捕获，没有 `@fold` 时退化为"该模式的第一个捕获"。
 * 查询**一个捕获都没有**（例如只有 `(block)` 这种无捕获模式）⇒ tree-sitter 的
 * `captures()` 无从回传节点，这一面就没法由结构层供：回一条 query 阶段的回落，
 * 折叠继续由既有供给器负责（`ui/editor-global-providers.ts`），不是"折叠消失了"。
 */
function foldsFrom(query: Query, root: Node): KojoStructureFold[] {
  const folds: KojoStructureFold[] = [];
  const preferred = query.captureNames.includes('fold') ? 'fold' : null;
  for (const capture of query.captures(root)) {
    if (preferred !== null && capture.name !== preferred) continue;
    const startRow = capture.node.startPosition.row;
    const endRow = capture.node.endPosition.row;
    if (endRow <= startRow) continue;
    folds.push({ startRow, endRow });
    if (folds.length > KOJO_STRUCTURE_MAX_TOKENS) break;
  }
  return folds;
}

/**
 * 缩进规则：约定捕获名 `@indent.increase` / `@indent.decrease` / `@indent.enter`，
 * 每条取其节点**首行文本**并转成"整行精确匹配"的锚定正则源码交给宿主。
 *
 * 为什么由宿主做正则、而不是语法包直接给正则：结构层只知道"哪一段是块头"，
 * 而 Monaco 的缩进配置只认正则；把"节点 → 行匹配"这一步的口径留在宿主，语法包
 * 就不必为表现层负责（档位表同理，见 `types.ts`）。查询里没有任何 `@indent.*` 捕获 ⇒
 * 三条腿都为空，宿主连配置都不重发（= 与没接这条线时逐字一致）。
 */
function indentRulesFrom(query: Query, root: Node): KojoStructureIndentRules {
  const increase = new Set<string>();
  const decrease = new Set<string>();
  const enter = new Set<string>();
  for (const capture of query.captures(root)) {
    const line = firstLineText(capture.node);
    if (line === null) continue;
    const pattern = anchoredPattern(line);
    if (capture.name === 'indent.increase') increase.add(pattern);
    else if (capture.name === 'indent.decrease') decrease.add(pattern);
    else if (capture.name === 'indent.enter') enter.add(pattern);
  }
  return {
    increasePatterns: [...increase].sort(),
    decreasePatterns: [...decrease].sort(),
    enterPatterns: [...enter].sort(),
  };
}

/** 节点覆盖范围里的首行文本（多行节点只取第一行——缩进判据本来就按行给） */
function firstLineText(node: Node): string | null {
  const start = node.startIndex;
  const end = node.endIndex;
  if (end <= start || start < 0 || end > documentText.length) return null;
  const slice = documentText.slice(start, end);
  const newline = slice.indexOf('\n');
  const line = (newline >= 0 ? slice.slice(0, newline) : slice).trim();
  return line === '' ? null : line;
}

/** 行文本 → 锚定正则源码（正则元字符逐个转义，不假定节点文本只用 `\w`） */
function anchoredPattern(line: string): string {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^\\s*${escaped}$`;
}

/** 解完后把三面都发一遍（三面各自独立可用/可回落，见 `compiled` 的三枚判据） */
function emit(version: number): void {
  if (tree === null) return;
  const root = tree.rootNode;
  if (highlightsQuery) {
    const { tokens, truncated } = tokensFrom(highlightsQuery, root);
    if (truncated) {
      fail(version, 'parse', 'all', `单文档结构段数超过 ${KOJO_STRUCTURE_MAX_TOKENS} ⇒ 结构解析整档停用（这通常意味着语法层的错误恢复在长文件上跑飞了）`);
      return;
    }
    post({ type: 'semantic', version, tokens });
  }
  if (foldsQuery) post({ type: 'folds', version, folds: foldsFrom(foldsQuery, root) });
  if (indentsQuery) post({ type: 'indent', version, rules: indentRulesFrom(indentsQuery, root) });
}

/* --------------------------------- 装配 --------------------------------- */

/** 三份查询各编各的：一份编译失败只让那一面回落，不许连累另外两面 */
function compileQueries(language: Language): void {
  const attempts: Array<{ source: string; name: 'highlights' | 'folds' | 'indents'; set: (q: Query) => void }> = [
    { source: KOJO_STRUCTURE_ASSETS.highlightsQuery, name: 'highlights', set: (q) => (highlightsQuery = q) },
    { source: KOJO_STRUCTURE_ASSETS.foldsQuery, name: 'folds', set: (q) => (foldsQuery = q) },
    { source: KOJO_STRUCTURE_ASSETS.indentsQuery, name: 'indents', set: (q) => (indentsQuery = q) },
  ];
  for (const attempt of attempts) {
    try {
      attempt.set(new Query(language, attempt.source));
    } catch (error: unknown) {
      fail(
        0,
        'query',
        attempt.name === 'highlights' ? 'semantic' : attempt.name === 'folds' ? 'folds' : 'indent',
        `${attempt.name} 查询编译失败：${reason(error)}（这一面由原有供给器继续负责）`,
      );
    }
  }
  if (foldsQuery && foldsQuery.captureNames.length === 0) {
    foldsQuery.delete();
    foldsQuery = null;
    fail(0, 'query', 'folds', 'folds 查询里没有带捕获的模式（约定用 @fold）⇒ 折叠这一面不由结构层供，继续走原有折叠');
  }
  if (indentsQuery && !indentsQuery.captureNames.some((n) => n.startsWith('indent.'))) {
    indentsQuery.delete();
    indentsQuery = null;
    fail(0, 'query', 'indent', 'indents 查询里没有 @indent.increase / @indent.decrease / @indent.enter 捕获 ⇒ 缩进这一面不由结构层供，继续走原有回车规则');
  }
}

async function handleInit(request: Extract<KojoStructureRequest, { type: 'init' }>): Promise<void> {
  if (request.protocol !== KOJO_STRUCTURE_PROTOCOL) {
    fail(0, 'worker', 'all', `协议版本不符（worker 认 ${KOJO_STRUCTURE_PROTOCOL}，宿主发 ${request.protocol}）⇒ 结构解析整档停用`);
    return;
  }
  try {
    await Parser.init({ locateFile: () => request.runtimeWasmUrl });
  } catch (error: unknown) {
    fail(0, 'wasm', 'all', `结构解析运行时载入失败：${reason(error)}`);
    return;
  }
  let language: Language;
  try {
    language = await Language.load(request.wasmUrl);
  } catch (error: unknown) {
    fail(0, 'wasm', 'all', `.kojo 语法载入失败：${reason(error)}`);
    return;
  }
  try {
    parser = new Parser();
    parser.setLanguage(language);
    compileQueries(language);
  } catch (error: unknown) {
    fail(0, 'wasm', 'all', `语法装配失败：${reason(error)}`);
    return;
  }
  initialized = true;
  post({ type: 'ready', version: 0 });
}

/** 整篇重解（首份文档 / 切文档 / 增量失败后的重新对齐） */
function handleParse(version: number, text: string): void {
  if (parser === null) return;
  tree?.delete();
  tree = null;
  documentText = text;
  try {
    const next = parser.parse(text, null);
    if (next === null) {
      fail(version, 'parse', 'all', '解析器没有产出语法树（多半是语言未装配成功）⇒ 结构解析整档停用');
      return;
    }
    tree = next;
  } catch (error: unknown) {
    fail(version, 'parse', 'all', `整篇解析抛错：${reason(error)}`);
    return;
  }
  emit(version);
}

/**
 * 增量重解：先按编辑把旧树推到位（`tree.edit`），再拿旧树解新文本。
 * 任何一步不对（无旧树 / 无新树 / 抛错）就**退化成整篇重解**——同一份文本、同一个
 * 版本号，主线程拿到的结果形状不变，只是这次贵一点；连续退化由宿主的超时判据管。
 */
function handleChange(request: Extract<KojoStructureRequest, { type: 'change' }>): void {
  if (parser === null) return;
  const nextText = documentText.slice(0, request.start.offset) + request.newText + documentText.slice(request.oldEnd.offset);
  if (tree === null) {
    handleParse(request.version, nextText);
    return;
  }
  try {
    tree.edit(
      new Edit({
        startIndex: request.start.offset,
        oldEndIndex: request.oldEnd.offset,
        newEndIndex: request.newEnd.offset,
        startPosition: { row: request.start.row, column: request.start.column },
        oldEndPosition: { row: request.oldEnd.row, column: request.oldEnd.column },
        newEndPosition: { row: request.newEnd.row, column: request.newEnd.column },
      }),
    );
    const old = tree;
    const next = parser.parse(nextText, old);
    old.delete();
    if (next === null) {
      tree = null;
      handleParse(request.version, nextText);
      return;
    }
    tree = next;
    documentText = nextText;
  } catch (error: unknown) {
    tree = null;
    fail(request.version, 'parse', 'all', `增量解析抛错，已退回整篇重解：${reason(error)}`);
    handleParse(request.version, nextText);
    return;
  }
  emit(request.version);
}

scope.onmessage = (event: MessageEvent<KojoStructureRequest>) => {
  const request = event.data;
  if (!request || typeof request.type !== 'string') return;
  if (request.type === 'init') {
    if (initialized) return;
    void handleInit(request);
    return;
  }
  if (!initialized) {
    // 没装配成功就来活：说一次，别让主线程把"没有任何回复"当成"worker 还在忙"
    fail(request.version, 'worker', 'all', 'worker 尚未完成装配就收到解析请求 ⇒ 结构解析整档停用');
    return;
  }
  if (request.type === 'parse') handleParse(request.version, request.text);
  else if (request.type === 'change') handleChange(request);
};

scope.onerror = (event: ErrorEvent) => {
  // 线程级未捕获异常：能说话就说，说不出去由宿主的超时/崩溃判据兜住
  fail(0, 'worker', 'all', `worker 线程异常：${event.message}`);
};
