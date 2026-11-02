/**
 * 未知码人话文案的**穷尽闸**（KW-28 1103）。
 *
 * 为什么要有这一枚：`UNKNOWN_HINT` 早先是 `Record<string, string>`——契约里新增一枚机器码、
 * 忘了在这里配文案，编译期一声不响，屏上直接把 `local-range` 这种工程词甩给作者。
 * 现在类型已经是 `Record<ReplayUnknownCode, string>`（少一格 typecheck 就红），这一枚补的是
 * **运行期那半边**：文案表与契约联合**逐枚对齐**，多一格少一格都红。
 *
 * 码表只有一个来源（`plugin-api/src/replay.ts` 的联合声明，现读现算），这里**不抄第二份名单**
 * ——抄了就是双真源，正是本仓头号罪。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_HINT } from '../src/preview';

const repoRoot = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../../../..');

/** 从契约源码里现算机器码联合（`export type ReplayUnknownCode = | 'a' // … | 'b';`） */
function contractUnknownCodes(): string[] {
  const src = readFileSync(
    path.join(repoRoot, 'packages/plugin-api/src/replay.ts'),
    'utf8',
  );
  // 声明以分号收尾（`| 'other';`）；注释里没有分号，非贪婪切到第一枚即整段
  const block = /export type ReplayUnknownCode =([\s\S]*?);/.exec(src)?.[1] ?? '';
  expect(block.length > 0).toBe(true);
  return [...block.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]!);
}

describe('UNKNOWN_HINT —— 与契约机器码联合逐枚对齐（KW-28 穷尽闸）', () => {
  const codes = contractUnknownCodes();

  it('契约联合非空（读不到就是判据自己瞎了，不许空过）', () => {
    expect(codes.length >= 15).toBe(true);
  });

  it('每一枚机器码都有人话文案，且不是把机器码原样当文案', () => {
    for (const code of codes) {
      const hint = (UNKNOWN_HINT as Record<string, string | undefined>)[code];
      expect(typeof hint).toBe('string');
      expect((hint ?? '').length > 0).toBe(true);
      expect(hint).not.toBe(code);
    }
  });

  it('文案表不藏旧码（键集 ⊆ 契约联合；漂出去的一枚也算红）', () => {
    for (const key of Object.keys(UNKNOWN_HINT)) expect(codes.includes(key)).toBe(true);
  });

  it('call-context 的文案带上「该怎么办」（858 枚那族的作者面出口，KW-28 判性）', () => {
    // 判性读数：这一族的值取决于本次调用的实参，存档里没有 ⇒ 静态收不掉；
    // 作者唯一的出路是手填场景参数。文案只说"没告诉它"会把作者推向一个并不存在的入口。
    expect(UNKNOWN_HINT['call-context'].includes('场景参数')).toBe(true);
  });
});
