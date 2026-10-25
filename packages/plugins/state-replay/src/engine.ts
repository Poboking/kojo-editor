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
 */

import type {
  FunctionPredicate,
  FunctionPredicates,
  FunctionReplay,
  Logger,
  PredicateReplay,
  ReplayCallContext,
  ReplayCallContextResolver,
  ReplayFunctionOptions,
  ReplayStateView,
  SnapshotArchive,
  StateReplayService,
} from '@kojo/plugin-api';
import { judgeCondition, type CallResolver, type EvalContext, type ValueReader } from './evaluate';
import { buildBranchOutcomes } from './branches';
import { InlineManager } from './inline';
import { createFunctionOverlay, type OverlayPosition, type OverlayReader } from './locals';
import { createStateView, type SchemaLookup } from './state-view';

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

/** 视图记忆条目：archive 身份就是失效判据 */
interface ViewEntry {
  readonly archive: SnapshotArchive;
  readonly view: ReplayStateView;
}

export interface StateReplayEngineDeps {
  log: Logger;
  /** 解析档案（`snapshot.source.parse`） */
  parseArchive(path: string): Promise<SnapshotArchive>;
  /** 谓词明细（`condition.extractor.functionPredicates`） */
  functionPredicates(normalizedName: string): Promise<FunctionPredicates | null>;
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
 *  `resolveCall`：用户函数内联通道（v0.2 第七批；缺省 = 调用一律 unknown('call')）。 */
export function replayPredicates(
  detail: FunctionPredicates,
  read: ValueReader,
  overlay?: OverlayReader,
  resolveCall?: CallResolver,
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
      const outcome = judgeCondition(p.expr, ctx);
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

  constructor(private readonly deps: StateReplayEngineDeps) {
    this.lineCacheMaxFiles = deps.lineCacheCaps?.maxFiles ?? LINE_CACHE_MAX_FILES;
    this.lineCacheMaxChars = deps.lineCacheCaps?.maxChars ?? LINE_CACHE_MAX_CHARS;
    this.viewCacheMax = deps.viewCacheMax ?? VIEW_CACHE_MAX;
    this.inline = new InlineManager({
      functionPredicates: (name) => deps.functionPredicates(name),
      readFileLines: async (path) => {
        const hit = this.lineCache.get(path);
        if (hit) {
          this.lineCache.delete(path); // 重读=重新入队尾
          this.lineCache.set(path, hit);
          return hit;
        }
        const text = await deps.readFileText(path);
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
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


  async replayFunction(
    view: ReplayStateView,
    functionName: string,
    options?: ReplayFunctionOptions,
  ): Promise<FunctionReplay | null> {
    const detail = await this.deps.functionPredicates(functionName);
    if (!detail) return null;
    const read: ValueReader = (ref) => view.read(ref);
    // 调用上下文：显式注入优先；否则经推导器补「确定事实」（HK-20）——
    // 场景输入仍 unknown，只有引擎转发链未设置槽 / 发言者槽等确定值才被填。
    let callContext: ReplayCallContext | undefined = options?.callContext;
    if (!callContext) {
      const resolver = options?.callContextResolver ?? this.deps.getCallContextResolver?.();
      callContext = resolver?.(functionName, view.characterNo);
    }
    const overlay = createFunctionOverlay({ detail, callContext, baseRead: read });
    // 内联预热（异步阶段结束 → 执行期同步缓存命中）
    await this.inline.preanalyze(detail);
    const resolveCall: CallResolver = (name, args, callerCtx) =>
      this.inline.resolveCall(name, args, callerCtx, 0);
    return replayPredicates(detail, read, overlay ?? undefined, resolveCall);
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
}
