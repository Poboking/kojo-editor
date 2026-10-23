/**
 * 未定义名的「你是不是想写…」候选（did-you-mean，纯函数）。
 *
 * 本模块只做两件事：码点级 Levenshtein 距离、以及从一份候选名里挑出距离 ≤ 阈值的近名。
 * **不读盘、不读索引、不认任何语言/游戏知识**——候选池由调用方（`undefined-name.ts`）给，
 * 因此可独立单测，也可在任何运行时复用。
 *
 * 排序是**确定性**的：距离升序 → 名字码元序（UTF-16）升序。不使用 `localeCompare`
 * （它随运行环境语言设置变化，同一份输入会排出不同候选）。
 */

/** 默认只收编辑距离 ≤ 2 的候选（与 S8 的诊断口径一致） */
export const DEFAULT_MAX_EDIT_DISTANCE = 2;

/** 默认最多给 3 个候选（消息里塞太多反而干扰判断） */
export const DEFAULT_MAX_SUGGESTIONS = 3;

/** `suggestNames` 的可选参数 */
export interface SuggestNamesOptions {
  /** 允许的最大编辑距离（缺省 {@link DEFAULT_MAX_EDIT_DISTANCE}） */
  readonly maxDistance?: number;
  /** 最多返回几个候选（缺省 {@link DEFAULT_MAX_SUGGESTIONS}；0 = 不返回） */
  readonly limit?: number;
}

/**
 * 码点级编辑距离（Levenshtein），超过 `limit` 时提前返回 `limit + 1`。
 *
 * 用**码点**而不是 UTF-16 码元切分：CJK / 增平面字符按一个字算，
 * 否则一个汉字在代理对下会被当成两个字符，距离虚高。
 */
export function editDistance(a: string, b: string, limit = DEFAULT_MAX_EDIT_DISTANCE): number {
  const A = [...a];
  const B = [...b];
  const max = Math.max(0, Math.trunc(limit));
  if (Math.abs(A.length - B.length) > max) return max + 1;
  if (A.length === 0) return B.length;
  if (B.length === 0) return A.length;

  let prev: number[] = Array.from({ length: A.length + 1 }, (_, i) => i);
  for (let j = 1; j <= B.length; j++) {
    const cur: number[] = [j];
    let rowMin = j;
    for (let i = 1; i <= A.length; i++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      const v = Math.min(prev[i]! + 1, cur[i - 1]! + 1, prev[i - 1]! + cost);
      cur[i] = v;
      if (v < rowMin) rowMin = v;
    }
    // 整行都超过阈值 ⇒ 最终距离只可能更大，提前收工（返回值只需保证 > limit）
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[A.length]!;
}

/**
 * 从候选名里挑出与 `name` 编辑距离 ≤ `maxDistance` 的近名（**纯函数、确定性排序**）。
 *
 * 判据与边界：
 * - 大小写不敏感（ERB 名字吃大小写差异）；返回的是候选池里的**原形**，不擅自改写；
 * - 与 `name` 本身相等的候选剔除（那不是"建议"，是同名）；
 * - 大小写不同的重复候选只留**首个原形**（候选池顺序确定 ⇒ 结果确定）；
 * - 排序 = 距离升序 → 原形码元序升序；同距离同名的重复已被剔除，排序因此是良序；
 * - 空名 / 空池 / `limit <= 0` ⇒ 空数组。
 */
export function suggestNames(
  name: string,
  candidates: readonly string[],
  options: SuggestNamesOptions = {},
): string[] {
  const maxDistance = Math.max(0, Math.trunc(options.maxDistance ?? DEFAULT_MAX_EDIT_DISTANCE));
  const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_MAX_SUGGESTIONS));
  if (name.length === 0 || limit === 0) return [];

  const upper = name.toUpperCase();
  const upperLength = [...upper].length;
  const pool = new Map<string, string>();
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const key = raw.toUpperCase();
    if (!pool.has(key)) pool.set(key, raw);
  }

  const hits: Array<{ readonly display: string; readonly distance: number }> = [];
  for (const [key, display] of pool) {
    if (key === upper) continue;
    const keyLength = [...key].length;
    // 长度差已经超阈值的候选，距离不可能落进阈值内（码点级长度）
    if (Math.abs(keyLength - upperLength) > maxDistance) continue;
    // 两字以内的短名里"距离 2"等于面目全非（`P1` vs `OR`）——短名只认单字之差
    const effectiveMax = Math.min(upperLength, keyLength) < 3 ? Math.min(maxDistance, 1) : maxDistance;
    const distance = editDistance(upper, key, effectiveMax);
    if (distance <= effectiveMax) hits.push({ display, distance });
  }

  hits.sort((x, y) => {
    if (x.distance !== y.distance) return x.distance - y.distance;
    return x.display < y.display ? -1 : x.display > y.display ? 1 : 0;
  });
  return hits.slice(0, limit).map((hit) => hit.display);
}
