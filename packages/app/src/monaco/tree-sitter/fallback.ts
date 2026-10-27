import type { CoreDiagnosticCode } from '@kojo/kojo-core';
import type { KojoStructureCapability, KojoStructureErrorStage } from './types';
/**
 * 结构层的**回落台账**（铁律 4 在这一批的具体形状：回落必须看得见，但一次就够）。
 *
 * ## 为什么要单独成文件
 *
 * "失败就悄悄回词法层"与"失败就每次编辑刷一条 toast"是同一个缺陷的两面，两头都得有人管：
 * 前者归 `providers.ts`（它负责真的把 provider 拆掉），后者归这里（去重 + 说出去）。
 * 判据抽出来才能被单测钉住——`tests/tree-sitter-protocol.test.ts` 直接打这里的纯函数。
 *
 * ## 两条口径
 *
 * - **一次性**：去重键 = `capability|stage|消息前缀`，且**数字先归一成 `#`**。同一句话在同一次
 *   会话里只走一次，所以每敲一次键不会重复报；换一种错（不同 stage / 不同消息）还是会说。
 *   数字归一这一步不是洁癖：回落文案几乎都带报数（丢了几段、第几版），按原文去重等于
 *   "每换一份文档就再说一次"——那正是本台账要治的刷屏（2026-10-25 实测：ERB 每开一个文件
 *   多一条，因为空区间条数各不相同）。
 *   台账有界（超过 100 条整表换新），不让长跑的会话把内存喂给一张只增的表。
 * - **不静默**：每条都同时做两件事——`console.warn`（开发者面，带机器可对齐的前缀）与
 *   递给订阅者（作者面：`ui/App.tsx` 把它翻成一条通知）。订阅者缺席也不许抛回来，
 *   回落本身是只读呈现面的事，绝不该打断输入或保存。
 */

/** 一次回落的说明（`capability` = 哪一面回落，`stage` = 在哪一步失败） */
export interface StructureDegradation {
  readonly capability: KojoStructureCapability;
  readonly stage: KojoStructureErrorStage;
  /** worker / 宿主给出的原始原因（上屏时按阶段配一句人话，原始原因跟在后面） */
  readonly message: string;
  /**
   * 只是**丢了几段**，这一面其余照常上屏（例：编码器丢掉了越界行 / 超宽跨度的少数区间）。
   *
   * 缺省 = 整面失效（provider 拆掉、回词法层）。两件事的文案必须分开：把"少涂了几段"
   * 说成"这一面退回了原来的做法"，作者会以为整层着色没了，然后去查一个不存在的故障。
   */
  readonly partial?: boolean;
  /**
   * 这条回落对应的 **core 诊断码**（LAU-6 起 additive；缺省 = 没有码，只有人话）。
   *
   * 为什么两种说法并存：作者面通知只说人话（`degradationNoticeText`），机器对账要稳定码
   * （`core/injection/child-failed` 这种闭集成员）。两处同时出现不是两套口径——
   * 码只进 `console.warn` 的括号与订阅方手上的字段，**不进**作者面正文。
   */
  readonly code?: CoreDiagnosticCode;
}

/** 整档回落（回词法层）与单面回落的人话说法；作者面不出现任何机器词 */
const CAPABILITY_LABEL: Record<KojoStructureCapability, string> = {
  semantic: '结构着色',
  folds: '结构折叠',
  indent: '结构缩进',
  syntax: '结构诊断',
  all: '结构解析',
};

/** 上屏文案：说清"哪一面退回原样"与"原样是什么"，并带上原因（裸英文不进正文，只在括号里） */
export function degradationNoticeText(degradation: StructureDegradation): string {
  const label = CAPABILITY_LABEL[degradation.capability] ?? '结构解析';
  // 只丢了几段（其余照常上屏）≠ 整面退回：两种说法不许混用（见 `StructureDegradation.partial`）
  if (degradation.partial === true) {
    return `${label}有几段没涂上（其余照常着色）：${degradation.message}`;
  }
  const back = degradation.capability === 'all' ? '已退回原来的配色与折叠' : '这一面已退回原来的做法';
  return `${label}这次没顶上（${back}）：${degradation.message}`;
}

let reported = new Set<string>();
const listeners = new Set<(degradation: StructureDegradation) => void>();

function keyOf(degradation: StructureDegradation): string {
  const prefix = degradation.message.slice(0, 200).replace(/\d+/g, '#');
  return `${degradation.capability}\u0000${degradation.stage}\u0000${prefix}`;
}

/**
 * 记一次回落。返回 `true` = 这条是**新**的（已 console.warn 并通知订阅者）；
 * `false` = 见过同样的话，什么都不做（这就是"一次就够"的落点）。
 */
export function reportStructureDegradation(degradation: StructureDegradation): boolean {
  const key = keyOf(degradation);
  if (reported.has(key)) return false;
  if (reported.size > 100) reported = new Set();
  reported.add(key);
  console.warn(
    `[kojo-structure] ${degradation.capability}/${degradation.stage} 回落${
      degradation.code === undefined ? '' : `（${degradation.code}）`
    }：${degradation.message}`,
  );
  for (const listener of [...listeners]) {
    try {
      listener(degradation);
    } catch {
      /* 通知链路抛错不许把回落本身打断（更不许打断输入或保存） */
    }
  }
  return true;
}

/** 订阅回落（`ui/App.tsx` 用它把作者面通知发出去）；返回退订函数 */
export function onStructureDegradation(
  listener: (degradation: StructureDegradation) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 清台账与订阅（重新翻开开关时调用；测试也用这一条把状态复位） */
export function resetStructureDegradationLedger(): void {
  reported = new Set();
}
