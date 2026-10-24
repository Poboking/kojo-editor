/**
 * `@kojo/kojo-lang` 的**展开视图编译成品登记表**（B3a）。
 *
 * 这张表原本住在宿主 `ui/kojo2-expand-compile.ts`，B3a 整张搬进包——理由写在
 * `src/expand-compile.ts` 头注里（登记方是宿主、查询方多了插件，两端不在同一侧了）。
 * 搬运是**零语义变化**，所以这里钉的口径与宿主当年那套逐字相同：
 *
 * 1. **零登记零行为**：没人登记 ⇒ `null` ⇒ 悬停 / 转定义不追加展开段（与今天逐字一致）；
 * 2. **后登记的优先**：面板可重挂，同路径下新实例的成品更新；
 * 3. **注销只撤自己**：一枚面板卸载不许把后来者的登记一并带走；重复注销幂等；
 * 4. **读取器抛错 = 这一份取不到**：不把异常带进 provider，问下一枚；
 * 5. **形状守卫**（本文件独有）：`compiled.erb` 不是字符串 / `sourceMapModel` 缺席 ⇒
 *    跳过。这条不是洁癖：下游 `expandViewAt` 拿它做逐行映射，喂进去一个半截对象
 *    会在**每次悬停**时抛错，而宿主那边会把它吞成"展开段突然没了"。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Kojo2ExpandCompilation } from '../src/expand-view';
import {
  kojo2ExpandCompilationFor,
  kojo2ExpandCompileSourceCount,
  registerKojo2ExpandCompileSource,
} from '../src/expand-compile';

/** 一份形状合法的成品（`sourceMapModel` 的内容这条腿不读，用 cast 保夹具短） */
function compilationOf(erb: string): Kojo2ExpandCompilation {
  return { compiled: { erb }, sourceMapModel: {} } as unknown as Kojo2ExpandCompilation;
}

const cleanups: (() => void)[] = [];
function register(source: (filePath: string) => Kojo2ExpandCompilation | null): void {
  cleanups.push(registerKojo2ExpandCompileSource(source));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('kojo2ExpandCompilationFor · 登记表口径', () => {
  it('零登记 ⇒ null（不是抛错、不是空对象）', () => {
    expect(kojo2ExpandCompileSourceCount()).toBe(0);
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')).toBeNull();
  });

  it('空路径 ⇒ null（不拿空串去问全部登记方）', () => {
    let asked = 0;
    register(() => {
      asked++;
      return compilationOf('X');
    });
    expect(kojo2ExpandCompilationFor('')).toBeNull();
    expect(asked).toBe(0);
  });

  it('按路径命中：给了别人的路径 ⇒ 登记方自己回 null ⇒ 总结果 null', () => {
    register((path) => (path === 'D:/p/a.kojo2' ? compilationOf('A') : null));
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('A');
    expect(kojo2ExpandCompilationFor('D:/p/b.kojo2')).toBeNull();
  });

  it('后登记的优先（面板重挂 ⇒ 新实例的成品说了算）', () => {
    register(() => compilationOf('旧'));
    register(() => compilationOf('新'));
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('新');
  });

  it('注销只撤自己：撤掉后者，前者照常可用', () => {
    const first = registerKojo2ExpandCompileSource(() => compilationOf('一'));
    const second = registerKojo2ExpandCompileSource(() => compilationOf('二'));
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('二');
    second();
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('一');
    first();
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')).toBeNull();
  });

  it('重复注销幂等（卸载链重入不报错、不误撤别人）', () => {
    const un = registerKojo2ExpandCompileSource(() => compilationOf('a'));
    register(() => compilationOf('b'));
    un();
    un();
    un();
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('b');
  });

  it('读取器抛错 = 这一份取不到（问下一枚，不把异常带出去）', () => {
    register(() => {
      throw new Error('面板正在重建');
    });
    register(() => compilationOf('ok'));
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('ok');
  });

  it('返回 null / undefined ⇒ 跳过它（不是"当前没有"的终点）', () => {
    register(() => null);
    register(() => undefined as unknown as Kojo2ExpandCompilation | null);
    register(() => compilationOf('last'));
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('last');
  });

  it('形状守卫：`compiled.erb` 不是字符串 ⇒ 跳过（半截对象喂下去会让每次悬停都抛）', () => {
    register(() => ({ compiled: {}, sourceMapModel: {} }) as unknown as Kojo2ExpandCompilation);
    register(() => compilationOf('ok'));
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')?.compiled.erb).toBe('ok');
  });

  it('形状守卫：`sourceMapModel` 缺席 ⇒ 跳过（没有映射就拼不出展开段）', () => {
    register(() => ({ compiled: { erb: 'X' } }) as unknown as Kojo2ExpandCompilation);
    expect(kojo2ExpandCompilationFor('D:/p/a.kojo2')).toBeNull();
  });
});
