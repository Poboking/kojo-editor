import type { ReferenceTally } from './reference-utils';

/**
 * 「一次查找引用的台账读数」的宿主单源（W8 XLANG-RENAME 接线批，2026-10-18）。
 *
 * 为什么单独成文件：`installReferenceProvider` 的 `onTally` 是 W8 交付好的**读数出口**
 * （F12 的"N 处"与「被调用」面板的入边读数出自**同一次计算**的两个投影），而全局
 * provider 只注册一份、React 侧需要一个可订阅的落点——照 `call-hierarchy.ts` /
 * `problem-store.ts` 的既有形态：模块级单源 + 订阅，零 React、零 Monaco，node 可单测。
 *
 * 一条纪律：**这里不数第二次**。本模块只存 `find-references` 交来的那份 `tally`
 * 与它的一句话解释；面板要读数就取 `tally.nonDefinitionCount`（非定义位全集）、
 * 直系族子集取 `tally.callSiteCount`——再 `reduce` 一遍 `incomingCalls` 就是 W8
 * 要收口的第二判据（对拍见 `tests/find-references.test.ts`）。
 */

/** 最近一次查找引用的读数（null = 本会话还没查过；面板据此出空态，不编数字） */
export interface ReferenceTallyEntry {
  readonly tally: ReferenceTally;
  /** `explainReferenceCounts` 的原文（差值解释的唯一文案真源，面板不许另写一份） */
  readonly explanation: string;
  /** 读数对应的那份文件（换文件即视为陈旧） */
  readonly path: string;
  /**
   * 读数属于**哪个名字**（归一化大写；additive，可选）。
   * 面板靠它把读数钉在符号上而不是"这个文件里最近查过的某个东西"上：
   * `path` 只保证同文件，同文件里换个名字按 F12 会让上一份读数变成谎话。
   * 供方没填（老接线）⇒ 消费方退到 `path` 判据；供方填了 ⇒ 必须逐字相等才认。
   */
  readonly normalizedName?: string;
}

let current: ReferenceTallyEntry | null = null;
const listeners = new Set<() => void>();

export function getReferenceTally(): ReferenceTallyEntry | null {
  return current;
}

/** 写入读数（同值不惊动订阅者，与 `pushSelStatus` 的"文案未变不上抛"同一口径） */
export function setReferenceTally(entry: ReferenceTallyEntry | null): void {
  const same =
    (entry === null && current === null) ||
    (entry !== null &&
      current !== null &&
      entry.path === current.path &&
      entry.normalizedName === current.normalizedName &&
      entry.explanation === current.explanation &&
      entry.tally === current.tally);
  if (same) return;
  current = entry;
  for (const cb of [...listeners]) cb();
}

/**
 * 「这份读数是不是这个符号的」——唯一判据（面板不许另立一份匹配规则）。
 * 同文件是下限；供方登记了名字就按名字裁决，没登记就退回文件判据并交出 `normalizedName`
 * 缺席这一事实，由消费方自己决定要不要把它说出来（宁缺毋错，绝不猜）。
 */
export function referenceTallyFor(
  path: string,
  normalizedName: string,
): ReferenceTallyEntry | null {
  if (current === null || current.path !== path) return null;
  if (current.normalizedName !== undefined && current.normalizedName !== normalizedName) return null;
  return current;
}

export function subscribeReferenceTally(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
