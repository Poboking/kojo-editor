/**
 * 状态回放引擎（游戏无关）。
 *
 * 职责：编排 `snapshot.source`（档案解析）与 `condition.extractor`（谓词明细），
 * 在状态视图上逐条求值 → `FunctionReplay`（置信度三档）。
 * 具名索引字典经 `getSchemaLookup` 注入（来自当前 game.adapter 的 `variableSchema`）。
 *
 * 不做缓存：视图生命周期由调用方持有（一次批量回放复用同一视图）；
 * 谓词明细的缓存在 condition-extractor 侧。
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
import { judgeCondition, type ValueReader } from './evaluate';
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
}

/** 谓词明细 → 回放结果（纯函数；测试可直用）。
 *  `overlay`：本地量数据流 + 调用上下文叠加（v0.2 第六批；可省略 = 纯视图求值）。 */
export function replayPredicates(
  detail: FunctionPredicates,
  read: ValueReader,
  overlay?: OverlayReader,
): FunctionReplay {
  const predicates: PredicateReplay[] = detail.predicates.map((p) => {
    let outcome;
    if (overlay) {
      const at: OverlayPosition = { line: p.line, context: p.context ?? [] };
      outcome = judgeCondition(p.expr, (ref) => overlay(ref, at) ?? read(ref));
    } else {
      outcome = judgeCondition(p.expr, read);
    }
    return {
      kind: p.kind,
      text: p.text,
      line: p.line,
      expr: p.expr,
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
    stats: { total, hit, miss, unknown },
    confidence,
  };
}

export class StateReplayEngine implements StateReplayService {
  constructor(private readonly deps: StateReplayEngineDeps) {}

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
    return replayPredicates(detail, read, overlay ?? undefined);
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
