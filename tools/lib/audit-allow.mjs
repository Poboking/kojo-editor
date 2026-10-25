/**
 * `// audit-allow: <理由>` 豁免的**唯一判据**（`audit-decoupling` 与 `audit-language` 共用）。
 *
 * 为什么要抽出来：两枚闸各自实现过一份，口径一度分叉——`audit-language` 2026-10-26 收紧到
 * 「注释位 + 非空理由」，`audit-decoupling` 还是「行里出现 audit-allow: 就免责」。后者留的
 * 缝正是前者修掉的那条：字符串字面量或行中随手写一枚标记就能豁免游戏名，而豁免本身
 * 没有任何留痕。判据住一处，两枚闸就不可能再分叉。
 *
 * 规则（两条同时成立才算豁免）：
 *   ① 标记落在**注释位**：整行注释或行尾注释（`//` 行注释，或单行块注释内）。
 *      `'audit-allow: …'` 这类字符串里的同名串不算；
 *   ② `audit-allow:` 后有**非空理由**（块注释收尾记号与尾随空白不计）。
 */

/**
 * 行内**注释起点**的下标（找不到 = -1）：逐字符走，跳过 `'…'` / `"…"` / `` `…` `` 里的
 * 内容，只认真正在代码位上的 `//` / `/*`。
 */
export function commentStartIndex(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) return i;
  }
  return -1;
}

/** `audit-allow:` 后必须跟非空理由；空理由 = 不是豁免（免得写成"占位却生效"）。 */
const ALLOW_RE = /audit-allow:[ \t]*(.*)$/;

/**
 * 这一行是不是一条**合法豁免**：返回理由字符串（null = 不是）。
 *
 * 注释行整体不在此列：调用方本来就先跳过注释行（`isCommentLine`），这里的判据只服务
 * 「代码行上的行尾豁免」与「行内块注释里的豁免」两种形态。
 */
export function licenseOf(line) {
  const commentAt = commentStartIndex(line);
  if (commentAt < 0) return null;
  const m = ALLOW_RE.exec(line.slice(commentAt));
  if (!m) return null;
  const reason = m[1].replace(/\*\/\s*$/, '').trim();
  return reason.length > 0 ? reason : null;
}
