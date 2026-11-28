/**
 * 行首 ERB 语句悬停展示引擎 ISA 原话（4.981/1.824 有锚的规约）。
 *
 * 钉两件事：命中 ISA 的语句把 argForm / semantics / errors / 源码锚**追加**在分类之后；
 * 查不到的语句只答分类，不自行推断、不把 prose 当判据。
 */
import { describe, expect, it } from 'vitest';
import { resolveErbMarkHover } from '../src/completion';

describe('ERB 语句悬停 ↔ ISA 原话', () => {
  it('SETBIT 带出位实参形态与 0-63 位域报错', () => {
    const hit = resolveErbMarkHover('SETBIT FLAG:0, 1', 3);
    expect(hit?.kind).toBe('ERB 语句');
    const text = (hit?.lines ?? []).join('\n');
    expect(text).toContain('原生 ERB 语句');
    expect(text).toContain('BitArgument (BIT_ARG)');
    expect(text).toContain('0-63');
    expect(text).toContain('FunctionIdentifier.cs:731-760');
  });

  it('别名 CLEARBIT 同指一条 ISA 条目', () => {
    const text = (resolveErbMarkHover('CLEARBIT FLAG:0, 1', 3)?.lines ?? []).join('\n');
    expect(text).toContain('BitArgument (BIT_ARG)');
  });

  it('ISA 未收录的语句仍只给分类，不追加臆测', () => {
    const text = (resolveErbMarkHover('PRINTFORMW x', 3)?.lines ?? []).join('\n');
    expect(text).toContain('原生 ERB 语句');
  });
});
