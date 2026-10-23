/**
 * 口上预览的组合入口。
 *
 * 一条 `<command>` 在编辑器里要同时回答三个问题：**它什么时候命中**（条件）、
 * **它的台词长什么样**（替换后的分行文本）、**哪些记号我没看懂**（未解析清单）。
 * 三者来自同一次调用，避免面板各调各的、把同一份文本解释出三种结果。
 *
 * 纯函数：不读盘、不发事件、不抛异常（畸形 `cmd` 按空条目处理）。
 */

import type { KojoXmlCondition } from './conditions';
import { extractKojoXmlConditions } from './conditions';
import type { KojoInterpolateContext } from './interpolate';
import { interpolateKojoText } from './interpolate';

export type { KojoXmlCondition } from './conditions';
export { extractKojoXmlConditions } from './conditions';
export type { KojoInterpolateContext, KojoInterpolateResult } from './interpolate';
export { interpolateKojoText } from './interpolate';

/**
 * 预览入参：只要求 `attrs` 与 `text`，故 `KojoXmlCommand` 可直接传入
 * （结构兼容），测试里也能用最小对象驱动。
 */
export interface KojoPreviewCommandLike {
  readonly attrs?: Readonly<Record<string, string>> | null;
  readonly text?: string;
}

/** 预览结果（`lines` 已按原文换行拆开，保留空行） */
export interface KojoPreviewResult {
  readonly lines: string[];
  readonly conditions: KojoXmlCondition[];
  readonly unresolved: string[];
}

/** 换行判据与解析器一致：`\r\n` / `\r` / `\n` 各算一次，不把 CRLF 拆出多余空行 */
const LINE_BREAK_RE = /\r\n|\r|\n/;

/**
 * 预览一条口上。
 *
 * `lines` 用**替换后的文本**拆行（替换不会改变换行结构）；空文本返回空数组，
 * 而不是 `['']`——面板据此显示"这条没有台词"，不会画出一行空白。
 */
export function previewKojoCommand(
  cmd: KojoPreviewCommandLike | null | undefined,
  ctx: KojoInterpolateContext = {},
): KojoPreviewResult {
  const text = typeof cmd?.text === 'string' ? cmd.text : '';
  const { text: rendered, unresolved } = interpolateKojoText(text, ctx);
  return {
    lines: text.length === 0 ? [] : rendered.split(LINE_BREAK_RE),
    conditions: extractKojoXmlConditions(cmd),
    unresolved: [...unresolved],
  };
}
