/**
 * 结构解析的**引擎本体**（CST 与三份查询只在这里活；`kojo-ts.worker.ts` 只是它外面的消息环）。
 *
 * ## 为什么把引擎从 worker 里拆出来
 *
 * 增量解对不对、贵不贵，只有拿**真语法 + 真 wasm**量了才算数；而 worker 文件本身在
 * Node 测试池里起不来（`?worker` 是 Vite 后缀，vitest 的 node 环境没有 Worker 构造）。
 * 拆开后两侧打的是同一份代码：worker 只做"收消息 → 调引擎 → 把回话 postMessage 出去"，
 * 测试直接 `new StructureEngine({ assets, emit })` 驱动同一条 `tree.edit()` +
 * `parse(stringer, oldTree)` 路——**不许**在测试里另抄一份"看起来一样的"调用形状。
 *
 * 资源（两枚 wasm 与三份查询）由构造参数注入而不是 import `./assets`：`assets.ts` 走
 * Vite 的 `?url` / `?raw`，node 池解析不了；注入也顺带把"worker 不许硬编码路径"这条
 * 纪律写成了类型（引擎根本拿不到 URL 之外的资源）。
 *
 * ## 增量口径（实测，非推测；读数见 `tests/tree-sitter-parse.perf.test.ts`）
 *
 * `change` 只做两件事：① 用宿主算好的那一条保守编辑把旧树推到位（`tree.edit`）；
 * ② 拿**有界取字符回调**（stringer）在新文本上重解。web-tree-sitter 0.27 的
 * `Parser.parse(input, oldTree)` 两种输入都支持，但传整串时内部是
 * `(index) => text.slice(index)` —— **每次取字都复制一遍文档尾巴**（源码见
 * `web-tree-sitter.js` 的 `parse()`：`C.currentParseCallback = (index) => callback.slice(index)`），
 * 5,000 行档实测整篇解的 p95 因此被抬到 30ms 级（GC 抖动），而 stringer 是 12ms 级；
 * 增量路径每击键只取 1 段（改动行附近），取字量与文档规模解耦。
 * 段长上限 4,096 码元是照 wasm 侧的输入缓冲定的（`_tree_sitter_parse_callback` 只把
 * `10 * 1024` 字节 = 5,120 码元写进缓冲），超过会白取。
 *
 * ## 三条纪律（与拆分之前的 worker 一致）
 *
 * 1. 依赖面只有 `web-tree-sitter` + `./types`（不 import Monaco、不 import 宿主 UI、不 import `./assets`）；
 * 2. 增量失败分两种：**没有旧树**（首次 / 上次已停用）⇒ 整篇重解对齐；**解本身抛错** ⇒
 *    回一条 `all` 级错误并且**不再继续答**（wasm 抛过之后树与解析器都可疑，硬撑着继续解就是
 *    拿可疑的树着色；`client.ts` 收到 `all` 会拆掉全部 provider，作者回到只有词法层）。
 * 3. 任何一条回话都是新建的 plain array —— Node 对象绝不跨线程。
 */
import { Edit, Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';
import {
  KOJO_STRUCTURE_MAX_SYNTAX_FAULTS,
  KOJO_STRUCTURE_MAX_TOKENS,
  tierForCapture,
  type KojoStructureCapability,
  type KojoStructureDocSeq,
  type KojoStructureErrorStage,
  type KojoStructureFold,
  type KojoStructureIndentRules,
  type KojoStructureReply,
  type KojoStructureRequest,
  type KojoStructureSyntaxFault,
  type KojoStructureSyntaxKind,
  type KojoStructureToken,
} from './types';

/** 引擎要的资源：两枚 wasm（浏览器给 URL、node 测试给字节）+ 三份查询源码 */
export interface StructureEngineAssets {
  readonly runtimeWasm: string;
  readonly kojoWasm: string | Uint8Array;
  readonly highlightsQuery: string;
  readonly foldsQuery: string;
  readonly indentsQuery: string;
}

/**
 * 一次解（整篇或增量）的**局部性读数**——增量大小的唯一可证伪证据。
 *
 * `reads` = 这一趟向文本取了几段；`readStart/readEnd` = 取到的窗口（新文本的 UTF-16 码元偏移）；
 * `incremental` = 这一次有没有用上旧树。真增量应当是"窗口贴着编辑点、段数与文档规模无关"。
 */
export interface StructureParseStat {
  readonly incremental: boolean;
  readonly reads: number;
  readonly readStart: number;
  readonly readEnd: number;
  readonly editStart: number;
  readonly editEnd: number;
  readonly documentLength: number;
}

export interface StructureEngineOptions {
  readonly assets: StructureEngineAssets;
  /** 唯一的输出通道（worker 里就是 `postMessage`；测试里就是收消息的数组） */
  readonly emit: (reply: KojoStructureReply) => void;
}

/** stringer 每次交给 wasm 输入缓冲的最大码元数（见文件头：wasm 侧缓冲 10 KiB = 5,120 码元） */
export const STRUCTURE_READ_CHUNK = 4096;

/** 抛错原因（本地一份，不为一条日志把 `@kojo/plugin-api` 拖进 worker 依赖图） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StructureEngine {
  private readonly assets: StructureEngineAssets;
  private readonly emit: (reply: KojoStructureReply) => void;
  private parser: Parser | null = null;
  private tree: Tree | null = null;
  /** 引擎自己那一版文本（与主线程的缝合口径逐字相同 ⇒ 两侧永远对齐，无需每击键回传全文） */
  private documentText = '';
  private ready = false;
  private highlightsQuery: Query | null = null;
  private foldsQuery: Query | null = null;
  private indentsQuery: Query | null = null;
  /** 已经报过的捕获名（同一名字只说一次，别每解一次刷屏） */
  private readonly reportedCaptures = new Set<string>();
  private stat: StructureParseStat | null = null;

  constructor(options: StructureEngineOptions) {
    this.assets = options.assets;
    this.emit = options.emit;
  }

  get initialized(): boolean {
    return this.ready;
  }

  /** 当前文本快照（只给诊断/测试用；provider 一侧不许拿它当数据源） */
  get text(): string {
    return this.documentText;
  }

  /** 最近一次解的局部性读数；还没解过 = null */
  get lastStat(): StructureParseStat | null {
    return this.stat;
  }

  /* -------------------------------- 查询执行 -------------------------------- */

  private fail(
    version: number,
    stage: KojoStructureErrorStage,
    capability: KojoStructureCapability,
    message: string,
  ): void {
    this.emit({ type: 'error', version, stage, capability, message });
  }

  /** `@name` 之类捕获 → 档位；表里没有就**说一次**并且不着色（绝不挑个"最像的"凑数） */
  private tokensFrom(query: Query, root: Node): { tokens: KojoStructureToken[]; truncated: boolean } {
    const tokens: KojoStructureToken[] = [];
    for (const capture of query.captures(root)) {
      const tier = tierForCapture(capture.name, capture.node.type);
      if (tier === null) {
        if (!this.reportedCaptures.has(capture.name)) {
          this.reportedCaptures.add(capture.name);
          this.fail(
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
   * 查询**一个捕获都没有** ⇒ 这一面没法由结构层供：回一条 query 阶段的回落，
   * 折叠继续由既有供给器负责（`ui/editor-global-providers.ts`），不是"折叠消失了"。
   */
  private foldsFrom(query: Query, root: Node): KojoStructureFold[] {
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
   * 查询里没有任何 `@indent.*` 捕获 ⇒ 三条腿都为空，宿主连配置都不重发。
   */
  private indentRulesFrom(query: Query, root: Node): KojoStructureIndentRules {
    const increase = new Set<string>();
    const decrease = new Set<string>();
    const enter = new Set<string>();
    for (const capture of query.captures(root)) {
      const line = this.firstLineText(capture.node);
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
  private firstLineText(node: Node): string | null {
    const start = node.startIndex;
    const end = node.endIndex;
    if (end <= start || start < 0 || end > this.documentText.length) return null;
    const slice = this.documentText.slice(start, end);
    const newline = slice.indexOf('\n');
    const line = (newline >= 0 ? slice.slice(0, newline) : slice).trim();
    return line === '' ? null : line;
  }

  /** 解完后把四面都发一遍（着色 / 折叠 / 缩进 / 结构残缺，四面各自独立可用、独立可回落）
   *
   * `doc` 是**原样回显**：引擎不判断它、不复用它，只是把请求里那枚跨文档隔离号带回回复
   * （对不上号是主线程 `client.ts` 的丢弃口径）——引擎里没有"当前文档"这个概念。 */
  private emitAll(doc: KojoStructureDocSeq, version: number): void {
    if (this.tree === null) return;
    const root = this.tree.rootNode;
    if (this.highlightsQuery) {
      const { tokens, truncated } = this.tokensFrom(this.highlightsQuery, root);
      if (truncated) {
        this.fail(version, 'parse', 'all', `单文档结构段数超过 ${KOJO_STRUCTURE_MAX_TOKENS} ⇒ 结构解析整档停用（这通常意味着语法层的错误恢复在长文件上跑飞了）`);
        return;
      }
      this.emit({ type: 'semantic', doc, version, tokens });
    }
    if (this.foldsQuery) this.emit({ type: 'folds', doc, version, folds: this.foldsFrom(this.foldsQuery, root) });
    if (this.indentsQuery) this.emit({ type: 'indent', doc, version, rules: this.indentRulesFrom(this.indentsQuery, root) });
    // 结构残缺（TSIT2-D）：这一面**自己包 try/catch**，且放在最后——遍历树是纯读，
    // 但它一旦抛错只该让"这一面没波浪线"，不该把已经发出去的三面一起带走（也不该抛进编辑器）。
    this.emitSyntax(doc, version, root);
  }

  /**
   * 把 CST 的 ERROR / MISSING 折成**行级残缺事实**发出去（只发事实，文案在宿主）。
   *
   * 三条口径（都关系到"作者看到的是不是一处错"）：
   * 1. **不深入 ERROR 子树**：错误恢复把一整段读不通的内容挂成一枚 ERROR，里面可能还套着
   *    别的节点——那都是同一个错，逐个子节点再报就是给一个错画三条波浪线；
   * 2. **MISSING 认领到块头**：没收束词的块在回缩点 / 文末插一枚 MISSING 收束记号，
   *    那一点作者看不见（零宽），看得懂的是"哪一行开的那个块还开着" ⇒ 落点给块头行，
   *    残缺点另带给文案（"开到第几行"）；嵌套时各自父块就是最内层那一枚，天然报最里侧；
   * 3. **有界**：超过 {@link KOJO_STRUCTURE_MAX_SYNTAX_FAULTS} 处就截断并如实带上 `truncated`
   *    （宿主据此说一次），绝不把编辑器变成装饰刷。
   */
  private emitSyntax(doc: KojoStructureDocSeq, version: number, root: Node): void {
    try {
      const faults: KojoStructureSyntaxFault[] = [];
      const walk = (node: Node): void => {
        if (faults.length >= KOJO_STRUCTURE_MAX_SYNTAX_FAULTS) return;
        if (node.isMissing) {
          const fault = this.missingFault(node);
          if (fault) faults.push(fault);
          return;
        }
        if (node.isError) {
          faults.push(this.errorFault(node));
          return;
        }
        for (const child of node.children) walk(child);
      };
      walk(root);
      this.emit({ type: 'syntax', doc, version, faults, truncated: faults.length >= KOJO_STRUCTURE_MAX_SYNTAX_FAULTS });
    } catch (error: unknown) {
      this.fail(
        version,
        'parse',
        'syntax',
        `结构残缺扫描失败 ⇒ 这一面这次不画波浪线（着色与折叠不受影响）：${reason(error)}`,
      );
    }
  }

  /** MISSING 记号 ⇒ 一枚"块没有收盘"事实：落点 = 所在块的块头行 */
  private missingFault(node: Node): KojoStructureSyntaxFault | null {
    const parent = node.parent;
    const head = parent ? parent.childForFieldName('open') : null;
    const faultRow = node.startPosition.row;
    if (!head) {
      // 认不出块头（语法换了形状）：仍然报"这里有东西没等到"，但不编块头文案
      return {
        row: faultRow,
        endRow: faultRow,
        column: node.startPosition.column,
        endColumn: node.startPosition.column + 1,
        kind: 'unexpected-token',
        faultRow,
        expectedToken: node.type,
      };
    }
    const headRow = head.startPosition.row;
    const headText = firstLine(head.text).trim();
    return {
      row: headRow,
      endRow: headRow,
      column: head.startPosition.column + leadingSpaces(head.text),
      endColumn: head.endPosition.column,
      kind: 'unclosed-block',
      faultRow,
      blockHeadText: headText,
      blockHeadRow: headRow,
      expectedToken: node.type,
    };
  }

  /** ERROR 节点 ⇒ 一枚按行文本分类的残缺事实 */
  private errorFault(node: Node): KojoStructureSyntaxFault {
    const text = node.text;
    const line = firstLine(text);
    const row = node.startPosition.row;
    return {
      row,
      endRow: node.endPosition.row,
      column: node.startPosition.column + leadingSpaces(text),
      endColumn: node.endPosition.column,
      kind: kindOfErrorLine(line),
      faultRow: node.endPosition.row,
    };
  }

  /* --------------------------------- 装配 --------------------------------- */

  /** 三份查询各编各的：一份编译失败只让那一面回落，不许连累另外两面 */
  private compileQueries(language: Language): void {
    const attempts: Array<{ source: string; name: 'highlights' | 'folds' | 'indents'; set: (q: Query) => void }> = [
      { source: this.assets.highlightsQuery, name: 'highlights', set: (q) => (this.highlightsQuery = q) },
      { source: this.assets.foldsQuery, name: 'folds', set: (q) => (this.foldsQuery = q) },
      { source: this.assets.indentsQuery, name: 'indents', set: (q) => (this.indentsQuery = q) },
    ];
    for (const attempt of attempts) {
      try {
        attempt.set(new Query(language, attempt.source));
      } catch (error: unknown) {
        this.fail(
          0,
          'query',
          attempt.name === 'highlights' ? 'semantic' : attempt.name === 'folds' ? 'folds' : 'indent',
          `${attempt.name} 查询编译失败：${reason(error)}（这一面由原有供给器继续负责）`,
        );
      }
    }
    if (this.foldsQuery && this.foldsQuery.captureNames.length === 0) {
      this.foldsQuery.delete();
      this.foldsQuery = null;
      this.fail(0, 'query', 'folds', 'folds 查询里没有带捕获的模式（约定用 @fold）⇒ 折叠这一面不由结构层供，继续走原有折叠');
    }
    if (this.indentsQuery && !this.indentsQuery.captureNames.some((n) => n.startsWith('indent.'))) {
      this.indentsQuery.delete();
      this.indentsQuery = null;
      this.fail(0, 'query', 'indent', 'indents 查询里没有 @indent.increase / @indent.decrease / @indent.enter 捕获 ⇒ 缩进这一面不由结构层供，继续走原有回车规则');
    }
  }

  /** 装载两枚 wasm 并编好三份查询；任何一步不成都回一条 `all`，返回 false（调用方不再投递解析） */
  async init(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await Parser.init({ locateFile: () => this.assets.runtimeWasm });
    } catch (error: unknown) {
      this.fail(0, 'wasm', 'all', `结构解析运行时载入失败：${reason(error)}`);
      return false;
    }
    let language: Language;
    try {
      language = await Language.load(this.assets.kojoWasm);
    } catch (error: unknown) {
      this.fail(0, 'wasm', 'all', `.kojo 语法载入失败：${reason(error)}`);
      return false;
    }
    try {
      this.parser = new Parser();
      this.parser.setLanguage(language);
      this.compileQueries(language);
    } catch (error: unknown) {
      this.fail(0, 'wasm', 'all', `语法装配失败：${reason(error)}`);
      return false;
    }
    this.ready = true;
    this.emit({ type: 'ready', version: 0 });
    return true;
  }

  /* --------------------------------- 解析 --------------------------------- */

  /**
   * 有界取字符回调：只给 `STRUCTURE_READ_CHUNK` 码元，**不**把文档尾巴整段复制给 wasm。
   * 顺带记下取字窗口（`reads` / `readStart` / `readEnd`），这是"增量到底局部不局部"的唯一现场证据。
   */
  private reader(text: string, stat: { reads: number; readStart: number; readEnd: number }) {
    return (index: number): string => {
      const chunk = text.slice(index, index + STRUCTURE_READ_CHUNK);
      stat.reads += 1;
      stat.readStart = Math.min(stat.readStart, index);
      stat.readEnd = Math.max(stat.readEnd, index + chunk.length);
      return chunk;
    };
  }

  /** 整篇重解（首份文档 / 切文档 / 上一次没有可用旧树时的重新对齐）；`doc` = 跨文档隔离号，原样回显 */
  parse(doc: KojoStructureDocSeq, version: number, text: string): void {
    if (this.parser === null) return;
    this.tree?.delete();
    this.tree = null;
    this.documentText = text;
    const counters = { reads: 0, readStart: Number.POSITIVE_INFINITY, readEnd: 0 };
    try {
      const next = this.parser.parse(this.reader(text, counters), null);
      if (next === null) {
        this.fail(version, 'parse', 'all', '解析器没有产出语法树（多半是语言未装配成功）⇒ 结构解析整档停用');
        return;
      }
      this.tree = next;
    } catch (error: unknown) {
      this.stat = {
        incremental: false, reads: counters.reads, readStart: 0, readEnd: 0,
        editStart: 0, editEnd: text.length, documentLength: text.length,
      };
      this.fail(version, 'parse', 'all', `整篇解析抛错：${reason(error)}`);
      return;
    }
    this.stat = {
      incremental: false,
      reads: counters.reads,
      readStart: Number.isFinite(counters.readStart) ? counters.readStart : 0,
      readEnd: counters.readEnd,
      editStart: 0,
      editEnd: text.length,
      documentLength: text.length,
    };
    this.emitAll(doc, version);
  }

  /**
   * 增量重解：先按编辑把旧树推到位（`tree.edit`），再拿旧树解新文本。
   *
   * 两种退化要分开看：**没有旧树**（首份 / 刚换文档）⇒ 整篇重解对齐一次，这不算失败；
   * **edit 或 parse 抛错** ⇒ 回一条 `all` 并且就此住口（见文件头纪律 2）。
   */
  change(request: Extract<KojoStructureRequest, { type: 'change' }>): void {
    if (this.parser === null) return;
    const nextText =
      this.documentText.slice(0, request.start.offset) + request.newText + this.documentText.slice(request.oldEnd.offset);
    if (this.tree === null) {
      this.parse(request.doc, request.version, nextText);
      return;
    }
    const counters = { reads: 0, readStart: Number.POSITIVE_INFINITY, readEnd: 0 };
    let next: Tree | null = null;
    try {
      this.tree.edit(
        new Edit({
          startIndex: request.start.offset,
          oldEndIndex: request.oldEnd.offset,
          newEndIndex: request.newEnd.offset,
          startPosition: { row: request.start.row, column: request.start.column },
          oldEndPosition: { row: request.oldEnd.row, column: request.oldEnd.column },
          newEndPosition: { row: request.newEnd.row, column: request.newEnd.column },
        }),
      );
      next = this.parser.parse(this.reader(nextText, counters), this.tree);
    } catch (error: unknown) {
      this.stat = {
        incremental: true, reads: counters.reads, readStart: 0, readEnd: 0,
        editStart: request.start.offset, editEnd: request.newEnd.offset, documentLength: nextText.length,
      };
      this.tree.delete();
      this.tree = null;
      this.documentText = nextText;
      this.fail(request.version, 'parse', 'all', `增量解析抛错 ⇒ 结构解析整档停用（不拿可疑的树继续着色）：${reason(error)}`);
      return;
    }
    this.tree.delete();
    if (next === null) {
      this.tree = null;
      this.documentText = nextText;
      this.parse(request.doc, request.version, nextText);
      return;
    }
    this.tree = next;
    this.documentText = nextText;
    this.stat = {
      incremental: true,
      reads: counters.reads,
      readStart: Number.isFinite(counters.readStart) ? counters.readStart : request.start.offset,
      readEnd: counters.readEnd,
      editStart: request.start.offset,
      editEnd: request.newEnd.offset,
      documentLength: nextText.length,
    };
    this.emitAll(request.doc, request.version);
  }

  dispose(): void {
    this.tree?.delete();
    this.tree = null;
    this.highlightsQuery?.delete();
    this.foldsQuery?.delete();
    this.indentsQuery?.delete();
    this.highlightsQuery = null;
    this.foldsQuery = null;
    this.indentsQuery = null;
    this.parser?.delete();
    this.parser = null;
    this.documentText = '';
    this.ready = false;
    this.stat = null;
    this.reportedCaptures.clear();
  }
}

/** 行文本 → 锚定正则源码（正则元字符逐个转义，不假定节点文本只用 `\w`） */
function anchoredPattern(line: string): string {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^\\s*${escaped}$`;
}

/** 节点文本的首行（多行节点只看第一行——残缺落点本来就按行给） */
function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline >= 0 ? text.slice(0, newline) : text;
}

/** 行首空白宽度（波浪线从第一个非空白字符起画，不把缩进也算进"错的那一段"） */
function leadingSpaces(text: string): number {
  const matched = /^[ \t]*/.exec(text);
  return matched ? matched[0].length : 0;
}

/**
 * ERROR 节点首行文本 → 残缺类别（**只按行面文本判，不猜语法内部**）。
 *
 * 判据就是作者自己看得见的那两个记号：`「` 在 `{` 之前出现（或只有 `「`）⇒ 台词引号没合上；
 * 只有 `{` ⇒ 插值没闭合；两者都没有 ⇒ 说不清，老实报"这一行读不通"。
 * 为什么不在这里读子节点类型：语法包正在被另一条线改（子节点形状会变），
 * 而行面记号判据与 `.kojo` 的写形同寿——它漂了也只是归类变保守，不会报错到别的行上。
 */
function kindOfErrorLine(line: string): KojoStructureSyntaxKind {
  const quote = line.indexOf('「');
  const brace = line.indexOf('{');
  if (quote >= 0 && (brace < 0 || quote < brace)) return 'unterminated-string';
  if (brace >= 0) return 'unterminated-interp';
  return 'unexpected-token';
}
