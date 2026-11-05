/**
 * 状态回放契约（v0.2 第五批：state-replay 先行）——架构文档 §5.3 的编辑器内**近似回放**。
 *
 * 定位：不做完整 EraBasic 解释器——把口上函数中的条件谓词（`condition.extractor`
 * 的明细产物）在**快照状态视图**（`snapshot.source` 的档案归约）上求值，输出
 * "该状态下每条谓词是否成立"。这是近似：函数调用 / rename 词 / 伪变量 / 动态索引
 * 等超出求值器能力的部分降级为 `unknown` 并**显式标注原因**（绝不猜测），
 * 函数级置信度三档（架构 §5.3：确定 / 部分未知 / 无法判定）。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：状态视图、求值结果、回放服务接口；
 * - **引擎**（`state-replay` 插件）：Emuera 变量寻址语义（TARGET 补位 / 稀疏数组
 *   取值 / 三值求值）——引擎级语言知识，跨游戏一致；
 * - **输入**：谓词明细来自 `condition.extractor`，存档模型来自 `snapshot.source`，
 *   具名索引字典来自 game adapter 的 `variableSchema`——本服务只做编排与求值。
 *
 * v0.2 第六批扩展：本地量数据流（`FunctionPredicates.assignments` 驱动）、
 * 引擎内置纯函数子集求值、`ReplayCallContext` 调用上下文注入（ARG/ARGS）。
 *
 * 术语：`unknown` 是**能力边界的诚实呈现**，不是错误；`read` / 求值绝不抛错。
 */

import type {
  FunctionReplay,
  ReplayDeterminabilityReading,
  ReplayUnknown,
  ReplayUnknownReducibility,
} from './replay-types';

/** 类型面已拆到 ./replay-types（图外文件）：这里 re-export 只为保持旧的 ./replay 导入路径可用。
 *  xport type * 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './replay-types';

/**
 * 真随机伪变量名匹配：`RAND` 作为独立词出现在 message 中（形如
 * `伪变量（运行期计算值）：RAND`）。词界护栏避免误伤 `RANDDATA` 等复合名。
 */
const IRREDUCIBLE_PSEUDO = /(^|[^0-9A-Za-z_])RAND([^0-9A-Za-z_]|$)/;

/**
 * 单条未知 → 可约性（纯函数）。仅 `pseudo` 码且 message 指向 `RAND` 伪变量者
 * 判为不可约真随机；其余（含 `pseudo` 中的语言局部量 / 其它计算值）一律能力缺口。
 */
export function replayUnknownReducibility(unknown: ReplayUnknown): ReplayUnknownReducibility {
  if (unknown.code === 'pseudo' && IRREDUCIBLE_PSEUDO.test(unknown.message)) return 'irreducible';
  return 'gap';
}

/**
 * 聚合一组函数回放 → 两读汇总（纯函数）。`null` 条目跳过（与回放契约同形）。
 * `unknown` / `irreducible` 逐谓词现算（不依赖 `stats` 自洽性，分母取 `stats.total`）。
 */
export function readReplayDeterminability(
  replays: readonly (FunctionReplay | null)[],
): ReplayDeterminabilityReading {
  let predicates = 0;
  let unknown = 0;
  let irreducible = 0;
  for (const r of replays) {
    if (!r) continue;
    predicates += r.stats.total;
    for (const p of r.predicates) {
      if (p.outcome.kind !== 'unknown') continue;
      unknown++;
      if (replayUnknownReducibility(p.outcome.unknown) === 'irreducible') irreducible++;
    }
  }
  const gap = unknown - irreducible;
  return {
    predicates,
    unknown,
    irreducible,
    gap,
    determinableRate: predicates > 0 ? 1 - gap / predicates : 1,
    capabilityCoverage:
      predicates - irreducible > 0 ? (predicates - unknown) / (predicates - irreducible) : 1,
  };
}

