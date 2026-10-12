/**
 * 编辑器工具条上的路径呈现（UI P4，2026-10-13）。
 *
 * 实测量出来的问题（1280×841，真实语料里一个游戏目录 ERB）：整条绝对路径 969px、
 * 工具条只给 550px，纯 CSS 的 `text-overflow: ellipsis` 从**末尾**裁——
 * 裁掉的正是文件名。作者盯着编辑器顶部看到的是 `C:\game\eratw-sub-modding…`，
 * 而"我在改哪一个文件"一个字都没显示。
 *
 * 所以这里定的规矩是：**身份不许裁，前缀可以让**。
 * 把路径切成三段，按"作者认得出这是哪份文件"的强弱排：
 * - `base`（文件名）——加粗、永不缩；
 * - `tail`（最深一层目录，通常就是作者自己的包名）——dim、永不缩；
 * - `head`（剩下的长前缀）——dim、可缩，且自己先做一次中段省略。
 * 完整路径恒在 `title` 里（悬停即得，不用为了看路径把窗口拉宽）。
 */

/** 目录与文件名的拆分（两种分隔符都认；平台原样字符串，不做归一化——显示用的） */
export function splitPath(p: string): { dir: string; base: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return { dir: '', base: p };
  return { dir: p.slice(0, i), base: p.slice(i + 1) };
}

/** 工具条三段（`head` 可缩，`tail` / `base` 恒显；无目录段时两者为空串） */
export interface PathLabelParts {
  readonly head: string;
  readonly tail: string;
  readonly base: string;
}

/**
 * 拆成工具条要显示的三段。
 *
 * 默认 26 是量出来的：1280 窗口里 head 实际只分到 ~180px，34 字符的中文前缀仍会被
 * CSS 再裁掉 49px（等于把这里的中段省略又裁成尾部省略）。头一短，CSS 就基本接手不到
 * 活干；而 head 本就是"可以让"的那一段——**窗口再窄也不该轮到包名和文件名让位**。
 * 完整路径恒在 `title`。入参是 BMP 文本（口上路径与中文目录名），不处理代理对拆分。
 */
export function pathLabelParts(p: string, headMaxChars = 26): PathLabelParts {
  const { dir, base } = splitPath(p);
  const { head, tail } = dirLabelParts(dir, headMaxChars);
  return { head, tail, base };
}

/** 目录两段：`head` 可缩的前缀 + `tail` 最深一层目录（恒显） */
export interface DirLabelParts {
  readonly head: string;
  readonly tail: string;
}

/**
 * 一个**目录**字符串拆成"可缩前缀 + 最深一层"。
 *
 * 快速打开（Ctrl+P）的副行就是它：整条目录交给 CSS 尾部省略时，被裁掉的恰好是
 * 包名/角色目录——而那正是"这一堆同名 ERB 里我要哪一个"的唯一区分点。
 * 预算只用于中段省略（按字符数），像素交给 CSS 兜底；**保住尾段靠结构不靠预算**。
 */
export function dirLabelParts(dir: string, headMaxChars = 26): DirLabelParts {
  const { dir: grand, base: tail } = splitPath(dir);
  let head = grand;
  if (headMaxChars > 0 && head.length > headMaxChars) {
    const keep = Math.max(1, headMaxChars - 12 - 1);
    head = `${head.slice(0, keep)}…${head.slice(-12)}`;
  }
  return { head, tail };
}
