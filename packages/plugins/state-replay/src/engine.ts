/**
 * 状态回放引擎（游戏无关）。
 *
 * 职责：编排 `snapshot.source`（档案解析）与 `condition.extractor`（谓词明细），
 * 在状态视图上逐条求值 → `FunctionReplay`（置信度三档）。
 * 具名索引字典经 `getSchemaLookup` 注入（来自当前 game.adapter 的 `variableSchema`）。
 *
 * v0.2 第七批：内联求值通道——`InlineManager` 对口上域 `#FUNCTION` 纯助手做
 * 有界内联解释（先 `preanalyze` 异步预热 → 同步 `resolveCall` 注入求值上下文）。
 * 文本缓存与内联缓存随项目生命周期（`resetCaches`，装配层在 project.closed 调用）。
 *
 * KW-15C 1103：谓词判定改走 `judgePredicateWithLoops`——计数循环的循环量在使用点是
 * 体内第一条真代码行时，按抽取侧发布的闭区间逐值试算，**值域内全体一致才收**，
 * 不一致就换 `local-range` 继续报未知（其余点位逐字走改动前的 `judgeCondition`）。
 * KW-15D 1103：放宽到体内任意行——窗口（循环头→使用点）每行都被证明写不到循环量
 * 槽位才试算（白名单与三条判性见 `loop-range.ts` 文件头）；行文本经 `getLines`
 * 同一份缓存供给，读不到 = 回落第一条行档。
 *
 * 2026-11-05 本批（两条伤信任的边界）：
 * - **未建模写事实**（`writes.ts`）：函数体内对游戏状态的写（`CFLAG:2 += 10` /
 *   `SETBIT` / `INPUT`）回放不执行，结论可能和真实运行不同形。`replayFunction`
 *   **总是**尽可能给出写点行（`FunctionReplay.unmodeledWrites`），面板据此给结论打
 *   「近似」标记。字段口径（本引擎写死，消费方照此呈现，详见 `replayFunction`）：
 *   **`[]` = 算过、未检出已知写点（白名单内零命中，不等于"真没写"）；缺省 = 不知道**（行文本不可得 ⇒ 本批不做"猜无写"）。
 * - **缓冲区文本回放**（`ReplayFunctionOptions.textOverride`）：未保存的编辑也照回放——
 *   明细分派给抽取器时透传（抽取器在**缓冲区自己的行号空间**里按 `@NAME` 重定位函数，
 *   不读盘；评审 P0），台词推演与循环窗口取行也优先用 override 切行。override
 *   **不进 lineCache**（那份缓存描述磁盘正文，混入缓冲区会让下一次无 override 的回放
 *   读到旧编辑）；内联求值按**来源分桶**吃同一份缓冲区（见下条）。
 * - **内联解释器吃缓冲区文本**（`inline.ts` 的 `InlineScope`）：每次 `replayFunction` 先
 *   `beginReplay({ filePath, text })` 领一个本次回放独占的句柄，`preanalyze` 与
 *   `resolveCall`（含递归内联）全链路只传这个句柄。同文件被调函数按**缓冲坐标**明细
 *   与缓冲区正文 analyze；跨文件仍读盘。磁盘命名空间（`InlineManager` 的 `cache`）与
 *   override 命名空间互不写入：两个并发回放各持各的桶，谁也不会读到对方的正文。
 *   文本身份比较每个回放至多两次（复用/清空判据 + 切行记忆各一次），**不是每次函数
 *   查找都比 150 KB**；同一份缓冲正文只 `splitEolLines` 一次（`overrideLinesMemo`）。
 *   **口径**：override 只作用于"本函数所在文件"这一个函数窗口，面板文案不许把它说成
 *   "整份缓冲区都能回放"。
 */

import { splitEolLines } from '@kojo/plugin-api/eol';
import { applyArchiveOverrides, pathKey } from '@kojo/plugin-api';
import type {
  ArchiveOverrides,
  FunctionPredicate,
  FunctionPredicates,
  FunctionReplay,
  Logger,
  PredicateReplay,
  ReplayCallContextResolver,
  ReplayFunctionOptions,
  ReplayStateView,
  SnapshotArchive,
  StateReplayService,
} from '@kojo/plugin-api';
import { type CallResolver, type EvalContext, type ValueReader } from './evaluate';
import { buildBranchOutcomes } from './branches';
import { InlineManager, type InlineCacheStats, type InlineScope } from './inline';
import { createFunctionOverlay, mergeCallContext, type OverlayPosition, type OverlayReader } from './locals';
import { judgePredicateWithLoops } from './loop-range';
import { createStateView, type SchemaLookup } from './state-view';
import { buildTranscript } from './transcript';
import { detectUnmodeledWrites, type ReplayWrite } from './writes';

/**
 * 函数体行文本缓存上限（2026-10-18 性能批）。
 *
 * 这是**第四份**正文常驻（内核 io 的会话文本缓存里已经有一份，`kernel/src/io.ts` 上限
 * 4,096 文件 / 128M 字符），所以这里只该留"当前正在回放的少数几棵"，不该留全树：
 * 判定面板/回放面一旦走完 99,228 个函数，无上限的旧形态会把 ~144 MB 正文再抄一份常驻。
 * 逐出不是错误——下次问到该文件会重新经 `readFileText` 取（内核那层通常仍命中，零 IPC）。
 * 形状照 `io.ts:313-317`：重读=重新入队尾，超尺从队首削，尺子＝条数 + 字符数。
 */
const LINE_CACHE_MAX_FILES = 64;
const LINE_CACHE_MAX_CHARS = 4 * 1024 * 1024;

/**
 * 回放视图上限（`createView` 的记忆）。
 *
 * 视图 = 168 个角色块的变量索引（一次性全建），击键重算纯属浪费：解析产物被 sav-parser
 * 那侧的记忆钉成**同一个对象**后，只要身份没变，同一个 (档, 角色) 的视图必然逐字同。
 * 判据因此就是"archive 对象身份相等"——重解析（mtime/size 变了）即作废，不需要第二把尺。
 */
const VIEW_CACHE_MAX = 4;
/** override 切行记忆最多留几份（面板同时开着的缓冲文件上限 4） */
const OVERRIDE_LINES_MEMO_MAX = 4;
/** 跨函数写传播每次回放最多查几个被调函数（防巨型函数体拖住面板） */
const CALL_PROPAGATION_BUDGET = 30;

/**
 * 多文件缓冲文本（**本地声明，不进 plugin-api 契约**：开机图字节闸只剩 22 B；
 * 引擎与面板各自声明结构相同的本地类型，靠结构化类型对上，`as` 透传不产生契约面）。
 */
export interface ReplayTextOverrideSource {
  readonly filePath: string;
  readonly text: string;
}

/** `replayFunction` 的**本地**扩展选项（`textOverrides` 不进契约，见上） */
type ReplayOptionsWithOverrides = ReplayFunctionOptions & {
  readonly textOverrides?: readonly ReplayTextOverrideSource[];
};

/**
 * 有效 override 文本：先按**文件身份**查多文件表（`pathKey` 判等），再退回"被判函数那一份"
 * 的单文件旧口径。没列出、也不是被判函数的文件 → `undefined` = 读盘。
 */
function effectiveOverrideText(
  filePath: string,
  options?: ReplayOptionsWithOverrides,
  judgedPath?: string,
): string | undefined {
  const list = options?.textOverrides;
  if (list !== undefined && list.length > 0) {
    const key = pathKey(filePath);
    for (const o of list) if (pathKey(o.filePath) === key) return o.text;
  }
  if (options?.textOverride !== undefined) {
    if (judgedPath === undefined || pathKey(judgedPath) === pathKey(filePath)) return options.textOverride;
  }
  return undefined;
}

/**
 * 本次回放的 override 集合（含被判函数那一份）。只存**引用**（`text` 不复制），
 * 身份比较因此是 O(1)/项（同字符串对象）；这也是"传播缓存何时清空"的判据。
 */
function overridesOf(
  options?: ReplayOptionsWithOverrides,
  judgedPath?: string,
): readonly { readonly filePath: string; readonly text: string }[] {
  const out: { filePath: string; text: string }[] = [];
  const list = options?.textOverrides;
  if (list !== undefined) for (const o of list) out.push({ filePath: o.filePath, text: o.text });
  if (options?.textOverride !== undefined && judgedPath !== undefined) {
    const key = pathKey(judgedPath);
    if (!out.some((o) => pathKey(o.filePath) === key)) out.push({ filePath: judgedPath, text: options.textOverride });
  }
  return out;
}

/** 视图记忆条目：archive 身份就是失效判据 */
interface ViewEntry {
  readonly archive: SnapshotArchive;
  readonly view: ReplayStateView;
}

export interface StateReplayEngineDeps {
  log: Logger;
  /** 解析档案（`snapshot.source.parse`） */
  parseArchive(path: string): Promise<SnapshotArchive>;
  /** 谓词明细（`condition.extractor.functionPredicates`）；第二个形参 additive：
   *  该文件**缓冲区文本**（未保存编辑），给了解析不读盘。 */
  functionPredicates(normalizedName: string, textOverride?: string): Promise<FunctionPredicates | null>;
  /** 具名索引字典（当前适配器的 `variableSchema`） */
  getSchemaLookup(): SchemaLookup | undefined;
  /** 读文件原文（v0.2 第七批：内联求值需要函数体行文本；走 kernel.io） */
  readFileText(path: string): Promise<string>;
  /**
   * 调用上下文推导器（HK-20；可选）——显式注入缺省时补「确定槽值」（游戏知识
   * 经适配器协议注入）。缺省 / 返回 undefined → 保持 unknown('call-context')。
   */
  getCallContextResolver?(): ReplayCallContextResolver | undefined;
  /**
   * 文本缓存上限（2026-10-18 性能批；可选，缺省＝上面两个常数）。
   * `maxFiles` / `maxChars` 给 `Infinity` = 不设限（A/B 对照用：改前形态就是无上限）。
   */
  lineCacheCaps?: { maxFiles?: number; maxChars?: number };
  /** 回放视图上限（可选；0 = 关闭视图记忆，每次 `createView` 重建索引） */
  viewCacheMax?: number;
}

/** 控制流语句谓词（回放口径的四类；`INLINE` 不在其中） */
type ControlPredicate = FunctionPredicate & { kind: 'IF' | 'ELSEIF' | 'SIF' | 'CASE' };

/** 谓词明细 → 回放结果（纯函数；测试可直用）。
 *  `overlay`：本地量数据流 + 调用上下文叠加（v0.2 第六批；可省略 = 纯视图求值）。
 *  `resolveCall`：用户函数内联通道（v0.2 第七批；缺省 = 调用一律 unknown('call')）。
 *  `loopBodyLines`（KW-15D 1103；additive）：函数体行文本——循环量窗口档
 *  （使用点在体内更深行、且循环头到使用点每行都被证明写不到循环量）需要它；
 *  缺省 = 只走 KW-15C 的第一条行档，旧行为逐字保留。 */
export function replayPredicates(
  detail: FunctionPredicates,
  read: ValueReader,
  overlay?: OverlayReader,
  resolveCall?: CallResolver,
  loopBodyLines?: readonly string[],
): FunctionReplay {
  // 只回放**控制流语句**的谓词（IF / ELSEIF / SIF / CASE）：本服务的产物是"分支链走向"，
  // 分支链由 `detail.statements` 建、谓词按行匹配成员。文本内联三元（`INLINE`，P0-1）
  // 没有开/闭配对、不构成链，它属于条件矩阵的视野；混进这里只会把命中率的分母算歪。
  const predicates: PredicateReplay[] = detail.predicates
    .filter((p): p is ControlPredicate => p.kind !== 'INLINE')
    .map((p) => {
      const at: OverlayPosition = { line: p.line, context: p.context ?? [] };
      const base: ValueReader = (ref) => (overlay ? (overlay(ref, at) ?? read(ref)) : read(ref));
      const ctx: EvalContext = {
        // 谓词来源上下文伪变量：__LINE__ = 1 基来源行（引擎 Debug__LINE__Token 语义）。
        // 已知近似：内联函数体内的 __LINE__ 取调用点行（本解释器不逐帧建模来源行）。
        read: (ref) =>
          ref.name === '__LINE__'
            ? ref.indices.length > 0
              ? { kind: 'unknown', unknown: { code: 'too-many-args', message: '__LINE__ 为标量，不接受索引' } }
              : { kind: 'value', value: p.line }
            : base(ref),
        ...(resolveCall ? { resolveCall } : {}),
      };
      const outcome = judgePredicateWithLoops(p.expr, ctx, detail, at, loopBodyLines);
      return {
        kind: p.kind,
        text: p.text,
        line: p.line,
        expr: p.expr,
        ...(p.conjunction ? { conjunction: p.conjunction } : {}),
        outcome,
      };
    });

  let hit = 0;
  let miss = 0;
  let unknown = 0;
  for (const p of predicates) {
    if (p.outcome.kind === 'true') hit++;
    else if (p.outcome.kind === 'false') miss++;
    else unknown++;
  }
  const total = predicates.length;
  const confidence: FunctionReplay['confidence'] =
    unknown === 0 ? 'exact' : unknown === total ? 'unknown' : 'partial';

  return {
    normalizedName: detail.normalizedName,
    filePath: detail.filePath,
    startLine: detail.startLine,
    predicates,
    branches: buildBranchOutcomes(detail.statements, predicates),
    stats: { total, hit, miss, unknown },
    confidence,
  };
}

export class StateReplayEngine implements StateReplayService {
  /** 内联管理器（analyze 缓存；resetCaches 时清空） */
  private readonly inline: InlineManager;
  /**
   * 函数体行文本缓存（path → lines；插入序＝FIFO 序；`resetCaches` 与超尺逐出都会清）。
   * 记账尺子＝**行字符总数**（与内核 io 的 `textCacheChars` 同量纲，只是这里存的是行数组）。
   */
  private readonly lineCache = new Map<string, string[]>();
  private readonly lineCacheMaxFiles: number;
  private readonly lineCacheMaxChars: number;
  private lineCacheChars = 0;
  /** 回放视图记忆（key = 档路径 + 角色号；失效判据＝archive 对象身份） */
  private readonly viewCache = new Map<string, ViewEntry>();
  private readonly viewCacheMax: number;
  /**
   * 缓冲区切行记忆（**按文件路径分桶，最多 4 份**；`linesOf` 的 override 分支用）。
   * 不按"磁盘正文"记账、也绝不被无 override 的回放读到 ⇒ 缓冲区正文不会污染磁盘语义。
   * 判据是**文本身份比较**（同字符串对象 O(1)；内容相同的另一份 = 一次逐字比较）。
   */
  private readonly overrideLinesMemo = new Map<string, { readonly text: string; readonly lines: string[] }>();
  /** 上一批 override 集合的文本身份（用于判定"要不要清调用传播缓存"；只存引用，不复制正文） */
  private overrideIdentity: readonly { readonly filePath: string; readonly text: string }[] = [];
  /**
   * 跨函数写传播缓存：`target\u0000disk|buf` → 被调段可证明写点数（`null` = 查不到）。
   * 只在 override 集合身份不变期间有效（集合一变就整表清空，宁重算不误用旧正文）。
   */
  private readonly callWriteCache = new Map<string, number | null>();

  constructor(private readonly deps: StateReplayEngineDeps) {
    this.lineCacheMaxFiles = deps.lineCacheCaps?.maxFiles ?? LINE_CACHE_MAX_FILES;
    this.lineCacheMaxChars = deps.lineCacheCaps?.maxChars ?? LINE_CACHE_MAX_CHARS;
    this.viewCacheMax = deps.viewCacheMax ?? VIEW_CACHE_MAX;
    this.inline = new InlineManager({
      functionPredicates: (name, text) => deps.functionPredicates(name, text),
      readFileLines: async (path) => {
        const hit = this.lineCache.get(path);
        if (hit) {
          this.lineCache.delete(path); // 重读=重新入队尾
          this.lineCache.set(path, hit);
          return hit;
        }
        const text = await deps.readFileText(path);
        const lines = splitEolLines(text);
        this.putLines(path, lines);
        return lines;
      },
      log: deps.log,
    });
  }

  /** 文本缓存读数（面板与测试用来自证上限真的在收口，不是挂着好看） */
  cacheStats(): {
    readonly files: number;
    readonly chars: number;
    readonly maxFiles: number;
    readonly maxChars: number;
    readonly views: number;
  } {
    return {
      files: this.lineCache.size,
      chars: this.lineCacheChars,
      maxFiles: this.lineCacheMaxFiles,
      maxChars: this.lineCacheMaxChars,
      views: this.viewCache.size,
    };
  }

  /**
   * 内联缓存读数（诊断用，不是回放语义）：磁盘桶 / override 桶分开报，外加 override
   * 作用域代数——测试据此证明"文本变化 = 新桶（代数 +1）+ 旧桶丢弃，条目数不随代数涨"，
   * 也就是"磁盘缓存零污染"与"override 常驻有界"两条各有一把尺。
   */
  inlineCacheStats(): InlineCacheStats {
    return this.inline.cacheStats();
  }

  /** 入缓存（FIFO：超尺从队首削；与 `kernel/src/io.ts` 的文本缓存同形状；尺子＝行字符总数） */
  private putLines(path: string, lines: string[]): void {
    const sum = (ls: string[]): number => ls.reduce((n, s) => n + s.length, 0);
    const prev = this.lineCache.get(path);
    if (prev) {
      this.lineCache.delete(path);
      this.lineCacheChars -= sum(prev);
    }
    this.lineCache.set(path, lines);
    this.lineCacheChars += sum(lines);
    while (
      this.lineCache.size > this.lineCacheMaxFiles ||
      this.lineCacheChars > this.lineCacheMaxChars
    ) {
      const oldest = this.lineCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.lineCache.get(oldest);
      this.lineCache.delete(oldest);
      if (evicted) this.lineCacheChars -= evicted.reduce((n, s) => n + s.length, 0);
    }
  }

  /** 项目切换 / 索引重建时清空缓存（函数体可能已变） */
  resetCaches(): void {
    this.inline.reset();
    this.lineCache.clear();
    this.lineCacheChars = 0;
    this.viewCache.clear();
    this.overrideLinesMemo.clear();
    this.overrideIdentity = [];
    this.callWriteCache.clear();
  }

  /**
   * 建状态视图（带记忆）。
   *
   * 失效判据＝**解析产物对象身份**：sav-parser 的深解析记忆把同一 (路径, mtime, size) 的
   * 档案钉成同一个对象，身份一变（档被改过 / 记忆逐出后重解析）视图即重建。
   * 抛错口径一字未动：解析失败照旧 warn + 上抛（不静默伪造空视图），角色不在档里由
   * `createStateView` 抛 `ReplayViewError`，同样每次现抛。
   */
  async createView(archivePath: string, characterNo: number): Promise<ReplayStateView> {
    const key = `${archivePath}\u0000${characterNo}`;
    let archive: SnapshotArchive;
    try {
      archive = await this.deps.parseArchive(archivePath);
    } catch (err) {
      this.deps.log.warn(`Replay view parse failed: ${archivePath} — ${String(err)}`);
      throw err; // 显式上抛（不静默伪造空视图）
    }
    if (this.viewCacheMax <= 0) {
      return createStateView({ archive, characterNo, lookup: this.deps.getSchemaLookup() });
    }
    const hit = this.viewCache.get(key);
    if (hit && hit.archive === archive) {
      this.viewCache.delete(key);
      this.viewCache.set(key, hit);
      return hit.view;
    }
    const view = createStateView({ archive, characterNo, lookup: this.deps.getSchemaLookup() });
    this.viewCache.delete(key);
    this.viewCache.set(key, { archive, view });
    while (this.viewCache.size > this.viewCacheMax) {
      const oldest = this.viewCache.keys().next().value;
      if (oldest === undefined) break;
      this.viewCache.delete(oldest);
    }
    return view;
  }


  /** 函数体行文本（缓存；内联解释器与台词推演共用同一份） */
  private async getLines(path: string): Promise<string[]> {
    const hit = this.lineCache.get(path);
    if (hit) {
      this.lineCache.delete(path); // 重读=重新入队尾
      this.lineCache.set(path, hit);
      return hit;
    }
    const text = await this.deps.readFileText(path);
    const lines = splitEolLines(text);
    this.putLines(path, lines);
    return lines;
  }

  /**
   * 函数体行文本：**缓冲区文本优先**（按 EOL 切行，返回临时数组、绝不入 `lineCache`），
   * 没有 override 才走 `getLines`（同一份 lineCache / 读盘）。
   *
   * 为什么不把 override 塞进 lineCache：那份缓存按**文件路径**记账、描述磁盘正文。
   * 把缓冲区塞进去，下一次不带 override 的回放（同一路径）就会读到旧编辑——
   * 这正是本批要消灭的"看不出来的不一致"，不能在新通道里再造一份。
   *
   * **缓冲区切行记忆**（`overrideLinesMemo`，按文件分桶、最多 4 份）：同一份缓冲区连续
   * 回放 N 个函数时，166 KB 正文不必被 `splitEolLines` 切 N 遍（实测 20 个真实函数：
   * 带 override 每轮 13.9 ms → 3.7 ms，与磁盘回放 3.5 ms 同量级）。多文件批起按
   * `pathKey` 分桶：两个文件的缓冲正文各切一次，互不挤占。
   *
   * **多文件 override**（`textOverrides`，不进 plugin-api 契约——开机图字节闸只剩 22 B）：
   * 形如 `readonly { filePath; text }[]`。命中判据只认**文件身份**（`pathKey` 判等），
   * 不猜"这份文本是哪个文件"；没列出的文件一律读盘，读盘结果也不受污染。
   */
  private async linesOf(
    filePath: string,
    options?: ReplayFunctionOptions & { readonly textOverrides?: readonly ReplayTextOverrideSource[] },
    judgedPath?: string,
  ): Promise<string[]> {
    const text = effectiveOverrideText(filePath, options, judgedPath);
    if (text !== undefined) {
      const key = pathKey(filePath);
      const memo = this.overrideLinesMemo.get(key);
      if (memo !== undefined && memo.text === text) {
        this.overrideLinesMemo.delete(key);
        this.overrideLinesMemo.set(key, memo);
        return memo.lines;
      }
      const lines = splitEolLines(text);
      this.overrideLinesMemo.delete(key);
      this.overrideLinesMemo.set(key, { text, lines });
      while (this.overrideLinesMemo.size > OVERRIDE_LINES_MEMO_MAX) {
        const oldest = this.overrideLinesMemo.keys().next().value;
        if (oldest === undefined) break;
        this.overrideLinesMemo.delete(oldest);
      }
      return lines;
    }
    return this.getLines(filePath);
  }

  /**
   * 跨函数写传播（**只做一层**，2026-11-05 边界批）：
   * 静态可解析的 `CALL TARGET(...)` 行 → 查 TARGET 的明细与行文本（override 优先），
   * 用同一套写判据数出被调段里**可证明的写点**（assign / instruction；不再往下递归），
   * 填进 `calleeWrites`。动态目标 / 查不到 / 超预算 → 不填（= 不可知，不是 0）。
   *
   * 为什么只做一层：跨函数传播每深一层，误报面与耗时都翻倍，而"这一行调用会不会写"
   * 对作者的价值在**第一层**就已经兑现（看到"被调段有 3 处写"就够了）。预算 30 个
   * 被调函数/次，防一个巨型函数体把面板拖住。
   */
  private async propagateCallWrites(
    writes: readonly ReplayWrite[],
    options?: ReplayFunctionOptions & { readonly textOverrides?: readonly ReplayTextOverrideSource[] },
    judgedPath?: string,
  ): Promise<readonly ReplayWrite[]> {
    const targets = writes.filter((w) => w.kind === 'call' && typeof w.target === 'string' && w.target !== '');
    if (targets.length === 0) return writes;
    const overrides = overridesOf(options, judgedPath);
    this.syncOverrideIdentity(overrides);
    const overrideMap = new Map(overrides.map((o) => [pathKey(o.filePath), o.text] as const));
    const out: ReplayWrite[] = [];
    let budget = CALL_PROPAGATION_BUDGET;
    for (const w of writes) {
      if (w.kind !== 'call' || typeof w.target !== 'string' || w.target === '') {
        out.push(w);
        continue;
      }
      const target = w.target;
      const diskDetail = await this.deps.functionPredicates(target);
      if (diskDetail === null || budget <= 0) {
        out.push(w);
        continue;
      }
      budget -= 1;
      const bufText = overrideMap.get(pathKey(diskDetail.filePath));
      const cacheKey = `${target.toUpperCase()}\u0000${bufText === undefined ? 'disk' : 'buf'}`;
      const cached = this.callWriteCache.get(cacheKey);
      if (cached !== undefined) {
        out.push(cached === null ? w : { ...w, calleeWrites: cached });
        continue;
      }
      let count: number | null = null;
      try {
        const detail = bufText === undefined ? diskDetail : await this.deps.functionPredicates(target, bufText);
        if (detail !== null) {
          const calleeLines = await this.linesOf(detail.filePath, options, judgedPath);
          count = detectUnmodeledWrites(calleeLines, detail.startLine, detail.endLine).filter(
            (x) => x.kind !== 'call' && x.kind !== 'jump',
          ).length;
        }
      } catch {
        count = null; // 查不到 = 不可知（不填字段），绝不猜 0
      }
      this.callWriteCache.set(cacheKey, count);
      out.push(count === null ? w : { ...w, calleeWrites: count });
    }
    return out;
  }

  /** override 集合身份变了 ⇒ 清传播缓存（旧正文算出来的写点数不能再用） */
  private syncOverrideIdentity(identity: readonly { readonly filePath: string; readonly text: string }[]): void {
    const prev = this.overrideIdentity;
    let same = prev.length === identity.length;
    if (same) {
      for (let i = 0; i < identity.length; i += 1) {
        const a = prev[i]!;
        const b = identity[i]!;
        if (a.filePath !== b.filePath || a.text !== b.text) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      this.overrideIdentity = identity;
      this.callWriteCache.clear();
    }
  }

  async replayFunction(
    view: ReplayStateView,
    functionName: string,
    options?: ReplayFunctionOptions,
  ): Promise<FunctionReplay | null> {
    // 缓冲区文本透传给抽取器（additive）：给了就按这一份解析（不读盘），
    // 明细里的行号 / 区间仍按索引（行号按 override 文本）。
    //
    // 多文件批：被判函数那份也可能只出现在 `textOverrides` 里（面板对"正开着的文件"统一
    // 走那张表）。先拿磁盘明细只为确认**被判函数属于哪个文件**，再按该文件的有效文本重取，
    // 保证"明细行号空间"与"取行文本"来自同一份正文（评审 P0 的同一判据）。
    const opts = options as ReplayOptionsWithOverrides | undefined;
    let detail = await this.deps.functionPredicates(functionName, options?.textOverride);
    if (!detail) return null;
    const topText = effectiveOverrideText(detail.filePath, opts, detail.filePath);
    if (topText !== undefined && topText !== options?.textOverride) {
      const withBuffer = await this.deps.functionPredicates(functionName, topText);
      if (withBuffer !== null) detail = withBuffer;
    }
    const read: ValueReader = (ref) => view.read(ref);
    // 调用上下文：显式注入与适配器推导的「确定事实」（HK-20）**逐槽合并**（E1 2026-11-05）——
    // 两者描述同一份调用实参的不同槽位：显式非 undefined 胜出（面板手填 + 预填 0 的假设值
    // 都是"这一格的值"），undefined / 缺位由推导器补（如路由确定的「发言者槽 = 回放角色号」）。
    // 此前"显式整体取代推导器"会让面板只注入几格时丢掉全部推导事实（HK-20 缺陷）；
    // 场景输入仍 unknown，只有确定值才被填。推导器口径不变：调用方覆写优先于引擎内置。
    const resolver = options?.callContextResolver ?? this.deps.getCallContextResolver?.();
    const callContext = mergeCallContext(
      options?.callContext,
      resolver?.(functionName, view.characterNo),
    );
    const overlay = createFunctionOverlay({ detail, callContext, baseRead: read });
    /**
     * 函数体行文本（**取一次，四种用途共用**）：①未建模写检测（面板要的近似标记，
     * 总是尽可能提供）；②循环量窗口档（仅已发布循环）；③台词推演（仅有显示行）；
     * ④内联解释器的同文件被调函数（行文本提示，省掉 N 次全文切行）。
     * 取行优先用缓冲区文本（`options.textOverride`：未保存的编辑也照回放），否则走
     * lineCache / 读盘。读盘失败照旧 `log.warn` 降级（四种用途各自隐藏），绝不抛错。
     *
     * **行号空间**：`detail` 的行号 / 区间与 `lines` 必须来自**同一份正文**（评审 P0）——
     * 抽取器物化 override 时会在缓冲区里按 `@NAME` 重定位函数，`detail.startLine` 就是
     * 缓冲区坐标；本层四种用途一律按 `detail.startLine/endLine` 切 `lines`，不再碰
     * 磁盘索引区间。
     *
     * **内联边界（本批已落地）**：override 通过 `InlineScope` 传参，只作用于**本函数
     * 所在文件**的同文件被调函数（跨文件仍读盘）。作用域是**本次调用私有**的：句柄被
     * `resolveCall` 闭包捕获，两个并发回放（不同缓冲区文本）各持各的桶，不会串味；
     * 实例字段只记"上一次来源"用于复用/清空，**不存"当前 override"**。
     */
    let lines: readonly string[] | undefined;
    try {
      lines = await this.linesOf(detail.filePath, opts, detail.filePath);
    } catch (err) {
      this.deps.log.warn(`function body lines unavailable for ${detail.filePath}: ${String(err)}`);
    }
    /**
     * 本次回放的 override 作用域：**每个 replay 只在这里做一次文本身份比较**
     * （`beginReplay` 里逐项 `pathKey + text`；不是每次函数查找都比 150 KB）。
     * 集合内容没变 ⇒ 复用上一次的桶（跨 replay 命中）；某文件文本变了 ⇒ 只重建该文件桶。
     *
     * 多文件批起：作用域吃**整个 override 集合**（被判函数那份 + 其它开着未保存的文件），
     * 这样内联展开到别的文件里的被调函数时也能按编辑器文本算（`ensureAnalyzed` 按文件分桶）。
     */
    const inlineOverrides = overridesOf(opts, detail.filePath);
    const scope: InlineScope | null =
      inlineOverrides.length === 0 ? null : this.inline.beginReplay({ overrides: inlineOverrides });
    // 内联预热（异步阶段结束 → 执行期同步缓存命中）：override 作用域与行文本全链路透传
    await this.inline.preanalyze(
      detail,
      scope,
      lines === undefined ? undefined : { pathKey: pathKey(detail.filePath), lines },
    );
    const resolveCall: CallResolver = (name, args, callerCtx) =>
      this.inline.resolveCall(name, args, callerCtx, 0, scope);
    // 循环量窗口档（KW-15D）：有已发布循环才用行文本；拿不到行 = 只走第一条行档，
    // 绝不猜窗口干净。
    const loopBodyLines = lines && detail.loopCounters && detail.loopCounters.length > 0 ? lines : undefined;
    const evaluated = replayPredicates(detail, read, overlay ?? undefined, resolveCall, loopBodyLines);
    /**
     * `unmodeledWrites` 的口径（本引擎实现选择，契约只给可选字段）：
     * - **`[]`** = 算过、函数体内**未检出已知写点**（`writes.ts` 的白名单判据跑完了；白名单外/间接写仍可能漏 ⇒ 消费方不许把它说成"结论可信"）；
     * - **字段缺省（undefined）= 不知道**：行文本不可得（读盘失败 / 无 override 且读不到），
     *   本批**不做"猜无写"**——消费方必须按"近似未评估"呈现，不许当零写点。
     * 因此这里只有在真的拿到行文本时才挂这个字段（含空数组）。
     */
    const replay: FunctionReplay = lines
      ? {
          ...evaluated,
          // 先跑本段写检测，再做**一层跨函数传播**（静态可解析的 CALL → 被调段可证明写点数）
          unmodeledWrites: await this.propagateCallWrites(
            detectUnmodeledWrites(lines, detail.startLine, detail.endLine),
            opts,
            detail.filePath,
          ),
        }
      : evaluated;
    // 台词推演（v0.3 口上调试统一批；additive）：有显示行资料且行文本可得时才附。
    if (detail.displays && detail.displays.length > 0 && lines) {
      try {
        const transcript = buildTranscript({
          detail,
          lines,
          predicates: replay.predicates,
          branches: replay.branches,
          read,
          ...(overlay ? { overlay } : {}),
          resolveCall,
        });
        if (transcript) return { ...replay, transcript };
      } catch (err) {
        this.deps.log.warn(`transcript build failed for ${functionName}: ${String(err)}`);
      }
    }
    return replay;
  }

  async replayFunctions(
    view: ReplayStateView,
    functionNames: readonly string[],
    options?: ReplayFunctionOptions,
  ): Promise<(FunctionReplay | null)[]> {
    const out: (FunctionReplay | null)[] = [];
    for (const name of functionNames) {
      out.push(await this.replayFunction(view, name, options));
    }
    return out;
  }

  /**
   * 覆盖预演回放（v0.3 口上调试统一批；契约可选方法）——把覆盖集应用到
   * 读模型（`applyArchiveOverrides`，不改入参）后回放。预演视图**不入缓存**
   * （一次性对象；入参 archive 来自解析记忆，覆盖产物即抛）。
   */
  async replayFunctionWithOverrides(
    view: ReplayStateView,
    functionName: string,
    overrides: ArchiveOverrides,
    options?: ReplayFunctionOptions,
  ): Promise<FunctionReplay | null> {
    const archive = await this.deps.parseArchive(view.archivePath);
    const patched = applyArchiveOverrides(archive, overrides);
    const previewView = createStateView({ archive: patched, characterNo: view.characterNo, lookup: this.deps.getSchemaLookup() });
    return this.replayFunction(previewView, functionName, options);
  }
}
