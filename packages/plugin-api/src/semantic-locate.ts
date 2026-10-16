/**
 * 结构化着色的**落点三件套**（B6，2026-10-16；跨插件共享的极小纯函数）。
 *
 * 为什么住契约层（与 `symbol-token.ts` 同一条理由）：ERB 线与语法糖线都要回答
 * "这个名字确实出现在那一行那一列吗"，两处各写一份 ⇒ 边界规则分叉 ⇒ 同一条名字
 * 一边有色一边没色，而这种漂移**只能靠肉眼发现**。插件之间不许交叉 import
 * （解耦审计 C 项），共享极小件的唯一合法落点就是契约层。
 *
 * 与 `symbolTokenAt` 的**有意分歧**（不是疏漏）：那张表服务"光标命中"，字符集刻意收窄
 * 到 `[A-Za-z0-9_]`（宁可漏也不跳错行）；这里服务"着色落点校验"，字符集取 Unicode 字母
 * 数字下划线，因为 `.kojo` 与 eraTW 的名字大量是中文（`函数 次数` / `M_KOJO_無個性`），
 * ASCII 集会把它判成"边界合法"而错画半根。两个字符集对应两个错误代价，所以是两张表。
 *
 * Unicode 这一张**只在本文件写字面量**：`erb-parser/references.ts` 的反向索引记号集
 * 直接由 `MODEL_TOKEN_CLASS` 组装（"什么字符算一个记号"是一个事实，两处各写一遍
 * 就是第二判据；表现是索引认的名字着色不认，反之亦然）。
 */

/** 记号字符集（Unicode 字母 / 数字 / 下划线）的**字面源**：单字符判定与整体分词都从它组装 */
export const MODEL_TOKEN_CLASS = String.raw`[\p{L}\p{N}_]`;

/** 标识符字符谓词（由 `MODEL_TOKEN_CLASS` 组装，别在本文件另写字符集） */
const IDENT_CHAR = new RegExp(MODEL_TOKEN_CLASS, 'u');

/**
 * 在 `text` 里从 `fromIndex`（0 基）起找 `needle`，**且要求它是一次独立的记号**
 * （左右不是标识符字符）。命中返回 1 基列；找不到返回 `-1` = 调用方**不画**。
 *
 * 为什么要独立记号校验：在 `@F(ARG, ARGS)` 里找 `ARG` 会命中 `ARGS` 的前缀，
 * 那根下划线就画在错的位置上——宁可少一条颜色，不许画错一个字符。
 */
export function locateIdentifier(text: string, needle: string, fromIndex: number): number {
  if (needle.length === 0) return -1;
  let at = text.indexOf(needle, Math.max(0, fromIndex));
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1]!;
    const after = text[at + needle.length];
    if (!IDENT_CHAR.test(before) && (after === undefined || !IDENT_CHAR.test(after))) return at + 1;
    at = text.indexOf(needle, at + 1);
  }
  return -1;
}

/** 换行归一并切成行数组（与 `parseErbText` / `scanFileRefs` 逐字同一条规则：`\r\n` 与裸 `\r` 都算一行） */
export function splitModelLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** 取 1 基行号的原文（`modelLineAt`：与 `structure-fix.ts` 那个会夹取的 `lineAt` 区分——这里越界**必须**给 undefined）；越界 → `undefined`（调用方据此**不画**，不夹取——夹取会把颜色画到别的行上） */
export function modelLineAt(lines: readonly string[], line: number): string | undefined {
  return line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
}
