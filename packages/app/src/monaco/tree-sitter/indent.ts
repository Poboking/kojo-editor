import type { KojoStructureIndentRules } from './types';
/**
 * 缩进规则的**合并层**（纯逻辑，零 Monaco——所以能在 node 里钉死）。
 *
 * ## 为什么"合并"而不是"替换"
 *
 * `.kojo` 的回车层级与缩进判定**今天已经有一套**：`kojo-language.ts` 用
 * `sugarEnterRulePatterns()`（词表派生）注册进 Monaco 的 `onEnterRules` /
 * `indentationRules`。结构层这批只该做**加法**：把 CST 认出来的额外行匹配并到既有规则后面，
 * 一条都不撤——撤了就是在实验开关里顺手改掉了已经交付的行为。
 *
 * Monaco 的 `setLanguageConfiguration` 是**按属性组合**的（同语言多份注册，
 * 属性级"后注册的赢"，没写的属性回落到前一份），所以这里只交 `onEnterRules` +
 * `indentationRules` 两个属性，注释 / 括号 / `wordPattern` 一概不写 ⇒ 继续走基底那份。
 *
 * ## 空规则 = 一个字都不发
 *
 * `rules` 为 null（worker 没回过 indent）或三条腿全空 ⇒ {@link mergeIndentConfig} 返回
 * `null`，装配层因此**不调** `setLanguageConfiguration`。"结构层没话说"与"这条线没接"
 * 必须是同一份行为，否则开关一开就多了一次语言配置重写。
 */

/** 基底（词表派生）那三份规则的投影——`sugarEnterRulePatterns()` 的形状，抽出来好注入假值 */
export interface BaseIndentPatterns {
  readonly indentOnEnter: readonly RegExp[];
  readonly increaseIndentPattern: RegExp;
  readonly decreaseIndentPattern: RegExp;
}

/** 合并结果（`action` 用字面量而不是 Monaco 枚举：本文件不碰 Monaco，枚举在装配层映射） */
export interface MergedIndentConfig {
  readonly onEnterRules: readonly { readonly beforeText: RegExp; readonly action: 'indent' }[];
  readonly increaseIndentPattern: RegExp;
  readonly decreaseIndentPattern: RegExp;
  /** 这次由结构层补进来的条数（写进"生效读数"，也用于装配层的去重键） */
  readonly added: number;
  /** 正则源码非法而被丢掉的条数（丢掉必须能被看见，装配层据此说一次） */
  readonly rejected: number;
  /** 去重键：同样的规则不重复注册配置（每次回复都重注册会让 Monaco 整批编辑器重算缩进） */
  readonly key: string;
}

/** 正则源码 → RegExp；非法（手改过的 worker / 语法层给错）⇒ null，交回 `rejected` 计数 */
export function compilePattern(source: string): RegExp | null {
  if (typeof source !== 'string' || source === '') return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * 合并基底与结构层规则。
 *
 * 去重按**正则源码字符串**：结构层给出的行匹配若与基底某条逐字相同就不再添一遍
 * （`onEnterRules` 里重复条目会让同一次回车匹配两条规则，行为虽仍一致但白算）。
 * `increase` / `decrease` 各自与基底那份用 `|` 并联（Monaco 这两个属性只能各给一条正则，
 * 并联是唯一"两条都要"的写法）。
 */
export function mergeIndentConfig(
  base: BaseIndentPatterns,
  rules: KojoStructureIndentRules | null | undefined,
): MergedIndentConfig | null {
  if (!rules) return null;
  const baseSources = new Set(base.indentOnEnter.map((r) => r.source));
  let rejected = 0;
  const enter: RegExp[] = [];
  for (const source of rules.enterPatterns) {
    if (baseSources.has(source)) continue;
    const compiled = compilePattern(source);
    if (compiled === null) {
      rejected++;
      continue;
    }
    baseSources.add(source);
    enter.push(compiled);
  }
  const increaseSources = rules.increasePatterns.filter((s) => !base.increaseIndentPattern.source.includes(s));
  const decreaseSources = rules.decreasePatterns.filter((s) => !base.decreaseIndentPattern.source.includes(s));
  const badIncrease = increaseSources.filter((s) => compilePattern(s) === null).length;
  const badDecrease = decreaseSources.filter((s) => compilePattern(s) === null).length;
  rejected += badIncrease + badDecrease;
  const goodIncrease = increaseSources.filter((s) => compilePattern(s) !== null);
  const goodDecrease = decreaseSources.filter((s) => compilePattern(s) !== null);
  if (enter.length === 0 && goodIncrease.length === 0 && goodDecrease.length === 0) return null;

  const increase =
    goodIncrease.length === 0
      ? base.increaseIndentPattern
      : new RegExp(`(?:${base.increaseIndentPattern.source})|(?:${goodIncrease.join('|')})`);
  const decrease =
    goodDecrease.length === 0
      ? base.decreaseIndentPattern
      : new RegExp(`(?:${base.decreaseIndentPattern.source})|(?:${goodDecrease.join('|')})`);
  return {
    onEnterRules: [
      ...base.indentOnEnter.map((beforeText) => ({ beforeText, action: 'indent' as const })),
      ...enter.map((beforeText) => ({ beforeText, action: 'indent' as const })),
    ],
    increaseIndentPattern: increase,
    decreaseIndentPattern: decrease,
    added: enter.length + goodIncrease.length + goodDecrease.length,
    rejected,
    key: [...enter.map((r) => r.source), ...goodIncrease, ...goodDecrease].join('\u0000'),
  };
}
