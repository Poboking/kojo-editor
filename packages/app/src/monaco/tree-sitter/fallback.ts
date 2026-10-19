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
 * - **一次性**：去重键 = `capability|stage|消息前缀`。同一句话在同一次会话里只走一次，
 *   所以每敲一次键不会重复报；换一种错（不同 stage / 不同消息）还是会说。
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
  const back = degradation.capability === 'all' ? '已退回原来的配色与折叠' : '这一面已退回原来的做法';
  return `${label}这次没顶上（${back}）：${degradation.message}`;
}

let reported = new Set<string>();
const listeners = new Set<(degradation: StructureDegradation) => void>();

function keyOf(degradation: StructureDegradation): string {
  return `${degradation.capability}\u0000${degradation.stage}\u0000${degradation.message.slice(0, 200)}`;
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
    `[kojo-structure] ${degradation.capability}/${degradation.stage} 回落：${degradation.message}`,
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
