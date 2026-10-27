/**
 * LAU-D3 · ERB 注册壳的悬停提示（`carrierShells` 通道）。
 *
 * DoD 第 4 条：**ERB 壳函数不再被当成"没实现的口上"**。判据钉四件事：
 * 1. 方言在 `carriers[].shells` 声明的**前缀 + 紧跟数字**命中 ⇒ 追加一句「这条事件在 xml」；
 * 2. 提示只**追加**，不抢已有悬停事实（库表/函数索引给的名字与正文照旧）；
 * 3. 没声明 / 前缀后不是数字 / 不是壳函数 ⇒ 一条都不添（不猜）；
 * 4. 数据来自 eraFL 自己的 `carriers` 声明（宿主不认识任何一族名字）。
 */
import { describe, expect, it } from 'vitest';
import { ERAFL_CARRIERS, ERAFL_ERB_SHELL_PREFIXES } from '../../plugins/erafl-adapter/src/kojo2/carriers';
import {
  carrierShellHintOf,
  resolveHoverName,
  type CarrierShellHint,
  type HoverTables,
} from '../src/monaco/kojo-hover';

/** eraFL 的真实载体声明 → 宿主投影（与 `editorTables()` 的投影同形） */
const ERAFL_HINTS: CarrierShellHint[] = ERAFL_CARRIERS.filter(
  (binding) => Array.isArray(binding.shells) && binding.shells.length > 0,
).map((binding) => ({
  carrier: binding.carrier,
  glob: binding.glob,
  prefixes: binding.shells!,
}));

const tablesWith = (shells?: readonly CarrierShellHint[]): HoverTables => ({
  ...(shells === undefined ? {} : { carrierShells: shells }),
  libraryTable: {
    hasTable: true,
    lookupByName: () => undefined,
    lookupByFunction: (name: string) =>
      name.toUpperCase().startsWith('KOJO_DEFINE_K') ? '口上注册' : undefined,
  },
});

describe('carrierShellHintOf（纯函数）', () => {
  it('命中 `KOJO_DEFINE_K1099` ⇒ 「这条事件在 xml」+ 载体 glob', () => {
    const line = 'CALL KOJO_DEFINE_K1099';
    const hint = carrierShellHintOf(line, 10, ERAFL_HINTS);
    expect(hint).toBeDefined();
    expect(hint!.lines[0]).toContain('这条事件在 xml');
    expect(hint!.lines[0]).toContain('ERB/口上/**/*.xml');
    // 区间 = 整个函数名（1 基、半开）
    expect(hint!.startColumn).toBe(6);
    expect(hint!.endColumn).toBe(line.length + 1);
  });

  it('大小写不敏感；长前缀不误吃短名（`KOJO_DEFINE_KOJO_INFO_K` 之后是 `O` 不是数字）', () => {
    expect(carrierShellHintOf('kojo_define_k1099', 3, ERAFL_HINTS)).toBeDefined();
    const shortOnly: CarrierShellHint[] = [
      { carrier: 'xml', glob: '口上/**/*.xml', prefixes: ['KOJO_DEFINE_K'] },
    ];
    expect(carrierShellHintOf('KOJO_DEFINE_KOJO_INFO_K1099', 5, shortOnly)).toBeUndefined();
    expect(carrierShellHintOf('KOJO_DEFINE_K1099', 5, shortOnly)).toBeDefined();
  });

  it('前缀后不是数字 / 没声明 shells / 光标不在记号上 ⇒ undefined（不猜）', () => {
    expect(carrierShellHintOf('KOJO_DEFINE_KX', 5, ERAFL_HINTS)).toBeUndefined();
    expect(carrierShellHintOf('KOJO_DEFINE_K1099', 5, undefined)).toBeUndefined();
    expect(carrierShellHintOf('KOJO_DEFINE_K1099', 5, [])).toBeUndefined();
    expect(carrierShellHintOf('CALL GETBIT', 6, ERAFL_HINTS)).toBeUndefined();
  });
});

describe('resolveHoverName · 壳提示挂在既有悬停通路上', () => {
  it('库表已答出名字 ⇒ 提示**追加**在其后（原有事实一个字不丢）', () => {
    const hit = resolveHoverName('CALL KOJO_DEFINE_K1099', 12, tablesWith(ERAFL_HINTS));
    expect(hit).toBeDefined();
    expect(hit!.name).toBe('口上注册');
    expect(hit!.kind).toContain('KOJO_DEFINE_K1099');
    expect(hit!.lines?.[0]).toContain('这条事件在 xml');
  });

  it('其它路都没答案 ⇒ 壳提示自己成一条悬停（不再静默）', () => {
    const hit = resolveHoverName('CALL KOJO_XML_INIT_K1099', 12, tablesWith(ERAFL_HINTS));
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('口上注册壳');
    expect(hit!.name).toBe('KOJO_XML_INIT_K1099');
    expect(hit!.lines?.join('\n')).toContain('这条事件在 xml');
  });

  it('没注入 carrierShells ⇒ 逐字回到改前（壳函数只有库表那一跳）', () => {
    const hit = resolveHoverName('CALL KOJO_DEFINE_K1099', 12, tablesWith());
    expect(hit?.name).toBe('口上注册');
    expect(hit?.lines).toBeUndefined();
  });

  it('eraFL 声明了 7 族壳前缀（含两个 XML 注册族），提示对每一族都成立', () => {
    expect(ERAFL_ERB_SHELL_PREFIXES.length).toBe(7);
    for (const prefix of ERAFL_ERB_SHELL_PREFIXES) {
      const hint = carrierShellHintOf(`${prefix}1099`, 3, ERAFL_HINTS);
      expect(hint, `${prefix}1099 应当命中`).toBeDefined();
    }
  });
});
