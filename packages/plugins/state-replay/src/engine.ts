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
 *   读到旧编辑）；内联求值要读的正文仍走磁盘（见 `replayFunction` 内的边界注释）。
 *   **口径**：override 只作用于"本函数所在文件"这一个函数窗口，面板文案不许把它说成
 *   "整份缓冲区都能回放"。
 */

import { splitEolLines } from '@kojo/plugin-api/eol';
import { applyArchiveOverrides } from '@kojo/plugin-api';
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
import { InlineManager } from './inline';
import { createFunctionOverlay, mergeCallContext, type OverlayPosition, type OverlayReader } from './locals';
import { judgePredicateWithLoops } from './loop-range';
import { createStateView, type SchemaLookup } from './state-view';
import { buildTranscript } from './transcript';
import { detectUnmodeledWrites } from './writes';

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
   * 函数体行文本：**缓冲区文本优先**（按 EOL 切行，返回临时数组、绝不入缓存），
   * 没有 override 才走 `getLines`（同一份 lineCache / 读盘）。
   *
   * 为什么不把 override 塞进 lineCache：那份缓存按**文件路径**记账、描述磁盘正文。
   * 把缓冲区塞进去，下一次不带 override 的回放（同一路径）就会读到旧编辑——
   * 这正是本批要消灭的"看不出来的不一致"，不能在新通道里再造一份。
   */
  private async linesOf(filePath: string, textOverride?: string): Promise<string[]> {
    if (textOverride !== undefined) return splitEolLines(textOverride);
    return this.getLines(filePath);
  }

  async replayFunction(
    view: ReplayStateView,
    functionName: string,
    options?: ReplayFunctionOptions,
  ): Promise<FunctionReplay | null> {
    // 缓冲区文本透传给抽取器（additive）：给了就按这一份解析（不读盘），
    // 明细里的行号 / 区间仍按索引（行号按 override 文本）。
    const detail = await this.deps.functionPredicates(functionName, options?.textOverride);
    if (!detail) return null;
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
    // 内联预热（异步阶段结束 → 执行期同步缓存命中）
    await this.inline.preanalyze(detail);
    const resolveCall: CallResolver = (name, args, callerCtx) =>
      this.inline.resolveCall(name, args, callerCtx, 0);
    /**
     * 函数体行文本（**取一次，三种用途共用**）：①未建模写检测（面板要的近似标记，
     * 总是尽可能提供）；②循环量窗口档（仅已发布循环）；③台词推演（仅有显示行）。
     * 取行优先用缓冲区文本（`options.textOverride`：未保存的编辑也照回放），否则走
     * lineCache / 读盘。读盘失败照旧 `log.warn` 降级（三种用途各自隐藏），绝不抛错。
     *
     * **行号空间**：`detail` 的行号 / 区间与 `lines` 必须来自**同一份正文**（评审 P0）——
     * 抽取器物化 override 时会在缓冲区里按 `@NAME` 重定位函数，`detail.startLine` 就是
     * 缓冲区坐标；本层三种用途一律按 `detail.startLine/endLine` 切 `lines`，不再碰
     * 磁盘索引区间。
     *
     * **边界**：override 只作用于**本函数所在文件**的明细与取行；内联解释器（
     * `InlineManager`）要读的正文仍走磁盘——它的分析缓存按函数名定格、正文通道按
     * 文件路径记账，把缓冲区混进去会让同一次回放里两个来源拼在一起（也污染下一次
     * 无 override 的回放）。这是本批刻意不做的部分，如实记在文件头与本注释；
     * 面板文案不该承诺"缓冲区里内联被调体也按缓冲区算"。
     */
    let lines: readonly string[] | undefined;
    try {
      lines = await this.linesOf(detail.filePath, options?.textOverride);
    } catch (err) {
      this.deps.log.warn(`function body lines unavailable for ${detail.filePath}: ${String(err)}`);
    }
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
      ? { ...evaluated, unmodeledWrites: detectUnmodeledWrites(lines, detail.startLine, detail.endLine) }
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
