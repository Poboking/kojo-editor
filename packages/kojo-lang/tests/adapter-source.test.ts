/**
 * `@kojo/kojo-lang` 的 **2.0 adapter 来源登记表**（B2c）。
 *
 * 这一层存在的理由写在 `src/adapter-source.ts` 头注里；本文件钉的是它的**五条口径**——
 * 每一条都对应一种"看起来能用、实际会静默出错"的写法：
 *
 * 1. **零登记零行为**：没人登记 ⇒ `null`（语言面退化成"只用本文件能证明的事实"）；
 * 2. **后登记的优先**：最新装配的那一份才是当前的（项目开闭会重新装配）；
 * 3. **注销只撤自己**：一枚卸载不许把后来者的登记一并带走；
 * 4. **getter 抛错 = 这一轮没有**：不能因为组合根那一刻状态不对就整片哑掉；
 * 5. **重复注销幂等**：卸载链可能重入。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameAdapter } from '@kojo/kojo-core';
import {
  kojo2AdapterNow,
  kojo2AdapterSourceCount,
  registerKojo2AdapterSource,
} from '../src/adapter-source';

/** 只填这条腿真正会读的字段（其余字段这里用不到，硬造一份完整的会掩盖"其实没读"） */
function adapterOf(id: string): GameAdapter {
  return { id } as unknown as GameAdapter;
}

const cleanups: (() => void)[] = [];
function register(source: () => GameAdapter | null | undefined): void {
  cleanups.push(registerKojo2AdapterSource(source));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('kojo2AdapterNow · 登记表口径', () => {
  it('零登记 ⇒ null（不是抛错、不是空对象）', () => {
    expect(kojo2AdapterSourceCount()).toBe(0);
    expect(kojo2AdapterNow()).toBeNull();
  });

  it('登记后立刻能读到（同一张表、同一份实例）', () => {
    const adapter = adapterOf('eratw');
    register(() => adapter);
    expect(kojo2AdapterNow()).toBe(adapter);
  });

  it('后登记的优先（项目开闭重新装配 ⇒ 新的那份说了算）', () => {
    register(() => adapterOf('old'));
    register(() => adapterOf('new'));
    expect(kojo2AdapterNow()?.id).toBe('new');
  });

  it('注销只撤自己：撤掉后者，前者照常可用', () => {
    const first = registerKojo2AdapterSource(() => adapterOf('first'));
    const second = registerKojo2AdapterSource(() => adapterOf('second'));
    expect(kojo2AdapterNow()?.id).toBe('second');
    second();
    expect(kojo2AdapterNow()?.id).toBe('first');
    first();
    expect(kojo2AdapterNow()).toBeNull();
  });

  it('重复注销幂等（卸载链重入不报错、不误撤别人）', () => {
    const un = registerKojo2AdapterSource(() => adapterOf('a'));
    register(() => adapterOf('b'));
    un();
    un();
    un();
    expect(kojo2AdapterNow()?.id).toBe('b');
  });

  it('getter 抛错 = 这一轮没有（问下一枚，不把异常带出去）', () => {
    register(() => {
      throw new Error('组合根正在重建');
    });
    register(() => adapterOf('ok'));
    expect(kojo2AdapterNow()?.id).toBe('ok');
  });

  it('getter 返回 null / undefined ⇒ 跳过它（不是"当前没有"的终点）', () => {
    register(() => null);
    register(() => undefined);
    register(() => adapterOf('last'));
    expect(kojo2AdapterNow()?.id).toBe('last');
  });
});
