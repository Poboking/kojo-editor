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
  FunctionPredicates,
  FunctionReplay,
  Logger,
  PredicateReplay,
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
}

/** 谓词明细 → 回放结果（纯函数；测试可直用）。
 *  `overlay`：本地量数据流 + 调用上下文叠加（v0.2 第六批；可省略 = 纯视图求值）。
 *  `resolveCall`：用户函数内联通道（v0.2 第七批；缺省 = 调用一律 unknown('call')）。 */
export function replayPredicates(
  detail: FunctionPredicates,
  read: ValueReader,
  overlay?: OverlayReader,
  resolveCall?: CallResolver,
): FunctionReplay {
  const predicates: PredicateReplay[] = detail.predicates.map((p) => {
    const at: OverlayPosition = { line: p.line, context: p.context ?? [] };
    const ctx: EvalContext = {
      read: (ref) => (overlay ? (overlay(ref, at) ?? read(ref)) : read(ref)),
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
  /** 函数体行文本缓存（path → lines；resetCaches 时清空） */
  private readonly lineCache = new Map<string, string[]>();

  constructor(private readonly deps: StateReplayEngineDeps) {
    this.inline = new InlineManager({
      functionPredicates: (name) => deps.functionPredicates(name),
      readFileLines: async (path) => {
        let lines = this.lineCache.get(path);
        if (!lines) {
          const text = await deps.readFileText(path);
          lines = text.replace(/\r\n?/g, '\n').split('\n');
          this.lineCache.set(path, lines);
        }
        return lines;
      },
      log: deps.log,
    });
  }

  /** 项目切换 / 索引重建时清空缓存（函数体可能已变） */
  resetCaches(): void {
    this.inline.reset();
    this.lineCache.clear();
  }

  async createView(archivePath: string, characterNo: number): Promise<ReplayStateView> {
    let archive: SnapshotArchive;
    try {
      archive = await this.deps.parseArchive(archivePath);
    } catch (err) {
      this.deps.log.warn(`Replay view parse failed: ${archivePath} — ${String(err)}`);
      throw err; // 显式上抛（不静默伪造空视图）
    }
    return createStateView({ archive, characterNo, lookup: this.deps.getSchemaLookup() });
  }

  async replayFunction(
    view: ReplayStateView,
    functionName: string,
    options?: ReplayFunctionOptions,
  ): Promise<FunctionReplay | null> {
    const detail = await this.deps.functionPredicates(functionName);
    if (!detail) return null;
    const read: ValueReader = (ref) => view.read(ref);
    const overlay = createFunctionOverlay({ detail, callContext: options?.callContext, baseRead: read });
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
