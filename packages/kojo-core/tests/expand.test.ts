/**
 * 展开器单测（`lower/expand/**`）：表依赖/求值一次/值引用、模板两位面替换、
 * 池结构校验、SIF 收紧、未引用声明的静态校验、source map 行数不变量。
 *
 * 全部走真实前端（`compileKojoSource`），只把适配层换成 fixture，避免"直接构造 AST
 * 绕过 parser"式的假通过。
 */
import { describe, expect, it } from 'vitest';
import type { EmitResult, KojoEmitBackend, KojoHiddenSlot } from '../src/lower/backend.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';

const BACKEND: KojoEmitBackend = {
  ...FIXTURE_BACKEND,
  wrapMachine: (request): EmitResult => [`@EVENT_${request.machine.event}`, ...request.body, '@EVENT_END'],
};

function compile(sourceLines: readonly string[]) {
  return compileKojoSource({ source: sourceLines.join('\n'), adapter: FIXTURE_ADAPTER, backend: BACKEND });
}

const bodyLines = (erb: string): string[] => (erb.length === 0 ? [] : erb.slice(0, -1).split('\n'));
const codes = (result: ReturnType<typeof compile>): string[] => result.diagnostics.map((d) => d.code);

const HEAD = ['# 机 开场', '# 视 灵梦'];

describe('表展开：隐藏槽 + 一次求值 + 依赖顺序', () => {
  it('源表达式只求值一次；值槽由分支链赋值；引用处只读值槽', () => {
    const result = compile([
      ...HEAD,
      '# 表 心情 由 恋慕',
      '    0..99 疏远',
      '    否 未知',
      '> 她看着{心情}。',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    expect(out).toEqual([
      '@EVENT_开场',
      'SET __kojo_table_心情 = {恋慕}',
      'IF {__kojo_table_心情 >= 0 && __kojo_table_心情 <= 99}',
      'SET __kojo_table_心情__value = {"疏远"}',
      'ELSE',
      'SET __kojo_table_心情__value = {"未知"}',
      'ENDIF',
      'TELL: 她看着{__kojo_table_心情__value}。 /WAIT',
      '@EVENT_END',
    ]);
  });

  it('表依赖表：先算被依赖的表，再把它的值槽当自己的判别式', () => {
    const result = compile([
      ...HEAD,
      '# 表 B 由 恋慕',
      '    0..9 b',
      '    否 z',
      '# 表 A 由 B',
      '    0..9 a',
      '    否 z2',
      '> {A}',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    const indexB = out.findIndex((line) => line.includes('SET __kojo_table_B = '));
    const indexA = out.findIndex((line) => line.includes('SET __kojo_table_A = '));
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeGreaterThan(indexB);
    expect(out[indexA]).toBe('SET __kojo_table_A = {__kojo_table_B__value}');
  });

  it('只有 `否` 的表：不产空 IF，只赋值一次', () => {
    const result = compile([...HEAD, '# 表 常数 由 恋慕', '    否 甲乙', '> {常数}']);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    expect(out).toContain('SET __kojo_table_常数 = {恋慕}');
    expect(out).toContain('SET __kojo_table_常数__value = {"甲乙"}');
    expect(out.some((line) => line.startsWith('IF '))).toBe(false);
  });

  it('字符串值按 Kojo 双引号规则再转义（含引号/反斜杠/花括号）', () => {
    const result = compile([...HEAD, '# 表 心情 由 恋慕', '    0..9 "他说\\"好\\" {笑}"', '    否 未知', '> {心情}']);
    expect(result.ok).toBe(true);
    expect(bodyLines(result.erb)).toContain('SET __kojo_table_心情__value = {"他说\\"好\\" \\{笑\\}"}');
  });

  it('槽的值类型随表值列类型：整数表 int / 字符串表 string（adapter 据此选 #DIM/#DIMS）', () => {
    const intTable = compile([...HEAD, '# 表 档位 由 恋慕', '    0..9 1', '    否 0', '> {档位}']);
    expect(intTable.ok).toBe(true);
    expect(intTable.slots).toEqual([
      { name: '__kojo_table_档位', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_档位__value', kind: 'table', valueType: 'int', role: 'table-value' },
    ]);

    const stringTable = compile([...HEAD, '# 表 档位 由 恋慕', '    0..9 甲', '    否 乙', '> {档位}']);
    expect(stringTable.ok).toBe(true);
    expect(stringTable.slots).toEqual([
      { name: '__kojo_table_档位', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_档位__value', kind: 'table', valueType: 'string', role: 'table-value' },
    ]);
  });

  it('未引用的表也做静态校验（prepass）：重叠直接 error', () => {
    const result = compile([...HEAD, '# 表 心情 由 恋慕', '    0..100 甲', '    50..150 乙', '    否 丙', '> 正文。']);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('core/table/overlap');
    expect(result.erb).toBe('');
  });

  it('条件里的表引用同样换成值槽（展开发生在节点之前）', () => {
    const result = compile([
      ...HEAD,
      '# 表 心情 由 恋慕',
      '    0..9 疏远',
      '    否 亲近',
      '? 心情 == "亲近"',
      '    > 近。',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    // 判别式在链头之前算进隐藏槽；链本身仍可 SIF（单行纯文本体不阻断 SIF）
    expect(out.some((line) => line.includes('__kojo_table_心情__value == "亲近"'))).toBe(true);
    expect(out.some((line) => line.startsWith('SIF ') || line.startsWith('IF '))).toBe(true);
  });
});

describe('模板展开：文本位/表达式位两位面替换', () => {
  it('文本位整段参数：字符串字面量落纯文本（打印值）；表达式位落源文本', () => {
    const result = compile([
      ...HEAD,
      '# 模 甲(值)',
      '    > 前{值}后',
      '    > {值 + "!"}',
      '! 甲("被夸奖")',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    expect(out).toContain('TELL: 前被夸奖后 /WAIT');
    // 表达式位：字符串实参按源文本替换，交给 adapter 表达式管线
    expect(out).toContain('TELL: {"被夸奖" + "!"} /WAIT');
  });

  it('插槽：内容来自调用处，模板前后行照常展开', () => {
    const result = compile([...HEAD, '# 模 乙()', '    > 前', '    [插槽]', '    > 后', '! 乙()', '    > 插槽行']);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    const idx = out.findIndex((line) => line.includes('插槽行'));
    expect(out[idx - 1]).toBe('TELL: 前 /WAIT');
    expect(out[idx + 1]).toBe('TELL: 后 /WAIT');
  });

  it('实参个数不符 → core/template/arg-count，0 字节', () => {
    const result = compile([...HEAD, '# 模 甲(原因)', '    > {原因}', '! 甲()']);
    expect(codes(result)).toContain('core/template/arg-count');
    expect(result.erb).toBe('');
  });
});

describe('池展开：结构 / 环 / 双向映射', () => {
  it('`? 否` 不在最后 → core/pool/default-not-last（未引用也报）', () => {
    const result = compile([...HEAD, '# 池 甲', '    ? 真', '        > 甲', '    ? 否', '        > 乙', '    ? 真', '        > 丙', '> 正文。']);
    expect(codes(result)).toContain('core/pool/default-not-last');
    expect(result.erb).toBe('');
  });

  it('池展开体逐行双向 origins；IF 头/体/尾都在', () => {
    const result = compile([...HEAD, '# 池 甲', '    ? 恋慕 < 10', '        > 甲', '    ? 否', '        > 乙', '! 甲']);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    const start = out.indexOf('IF {恋慕 < 10}');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(out.slice(start)).toEqual(['IF {恋慕 < 10}', 'TELL: 甲 /WAIT', 'ELSE', 'TELL: 乙 /WAIT', 'ENDIF', '@EVENT_END']);
    const hit = result.sourceMap.lineAt(start + 1)!;
    expect(hit.kind).toBe('pool');
    expect(hit.origins.map((o) => o.kind)).toEqual(['call-site', 'pool-definition']);
  });

  it('池自调用 → core/pool/cycle，0 字节', () => {
    const result = compile([...HEAD, '# 池 甲', '    ? 真', '        ! 甲', '        > 甲', '    ? 否', '        > 乙', '! 甲']);
    expect(codes(result)).toContain('core/pool/cycle');
    expect(result.erb).toBe('');
  });
});

describe('SIF 收紧：展开会插多行时回落完整 IF', () => {
  it('单分支 + 单行体，但体里有表引用 → 不发 SIF', () => {
    const result = compile([
      ...HEAD,
      '# 表 心情 由 恋慕',
      '    0..9 疏远',
      '    否 亲近',
      '? 恋慕 >= 1',
      '    > {心情}',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    expect(out.some((line) => line.startsWith('SIF '))).toBe(false);
    expect(out).toContain('IF {恋慕 >= 1}');
    expect(out).toContain('ENDIF');
  });

  it('单分支 + 单行纯文本：仍可降 SIF（不误伤）', () => {
    const result = compile([...HEAD, '? 恋慕 >= 1', '    > 甲']);
    expect(result.ok).toBe(true);
    expect(bodyLines(result.erb)).toContain('SIF {恋慕 >= 1}');
  });
});

describe('展开与其它体的组合（不崩、顺序可证）', () => {
  it('`@算` 里的表引用：表在语句前求值，赋值读值槽', () => {
    // 赋值目标必须已声明（spec §3.4.6 / §8.1：`@算` 不偷偷造变量；K2-SEMA-WIRING 起语义层按此拒收）
    const result = compile([
      ...HEAD,
      '# 表 心情 由 恋慕',
      '    0..9 疏远',
      '    否 亲近',
      '# 变量 临时 字符串',
      '@算',
      '    临时 = 心情',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    const tableStart = out.findIndex((line) => line.includes('SET __kojo_table_心情 = '));
    const assign = out.findIndex((line) => line.includes('SET 临时 = '));
    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(assign).toBeGreaterThan(tableStart);
    expect(out[assign]).toBe('SET 临时 = {__kojo_table_心情__value}');
  });

  it('`@随机` 候选里的表引用：落 control-or-side-effect，候选行在随机块内', () => {
    const result = compile([
      ...HEAD,
      '# 表 心情 由 恋慕',
      '    0..9 疏远',
      '    否 亲近',
      '@随机',
      '    灵梦：「{心情}」',
      '    > 乙',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    const head = out.findIndex((line) => line.startsWith('RANDOM '));
    expect(out[head]).toBe('RANDOM control-or-side-effect 2');
    expect(out.indexOf('RANDOM.END')).toBeGreaterThan(head);
    expect(out.some((line) => line.includes('__kojo_table_心情__value'))).toBe(true);
  });

  it('模板实参是表引用：先在调用点求值，模板体拿到值槽', () => {
    const result = compile([
      ...HEAD,
      '# 表 心情 由 恋慕',
      '    0..9 疏远',
      '    否 亲近',
      '# 模 甲(值)',
      '    > 结果{值}',
      '! 甲(心情)',
    ]);
    expect(result.ok).toBe(true);
    const out = bodyLines(result.erb);
    expect(out.some((line) => line.includes('SET __kojo_table_心情 = '))).toBe(true);
    expect(out.some((line) => line === 'TELL: 结果{__kojo_table_心情__value} /WAIT')).toBe(true);
  });
});

describe('随机隐藏槽 valueType = 实际落点（randStyle + 候选纯度，§8.4）', () => {
  const SINGLE_LINE = [...HEAD, '@随机', '    > 甲', '    > 乙'];
  const GROUP_TEXT = [...HEAD, '@随机', '    @组', '        > 甲', '        > 乙', '    @组', '        > 丙', '        > 丁'];

  function backendWithRandStyle(randStyle: 'printdata' | 'printdatal' | 'rand-selectcase'): KojoEmitBackend {
    return { ...FIXTURE_BACKEND, profile: { ...FIXTURE_BACKEND.profile, randStyle } };
  }

  function slotType(randStyle: 'printdata' | 'printdatal' | 'rand-selectcase', lines: readonly string[]): string | undefined {
    const result = compileKojoSource({
      source: lines.join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: backendWithRandStyle(randStyle),
    });
    expect(result.ok).toBe(true);
    expect(result.slots).toHaveLength(1);
    return result.slots[0]?.valueType;
  }

  it('printdata：单行纯文本 → string（PRINTDATA）；@组 不支持 → 回落 RAND → int', () => {
    expect(slotType('printdata', SINGLE_LINE)).toBe('string');
    expect(slotType('printdata', GROUP_TEXT)).toBe('int');
  });

  it('printdatal：@组 纯文本 → string（DATALIST）；单行 → RAND → int', () => {
    expect(slotType('printdatal', GROUP_TEXT)).toBe('string');
    expect(slotType('printdatal', SINGLE_LINE)).toBe('int');
  });

  it('rand-selectcase（fixture 默认）：一律候选下标 int', () => {
    expect(slotType('rand-selectcase', SINGLE_LINE)).toBe('int');
    expect(slotType('rand-selectcase', GROUP_TEXT)).toBe('int');
  });
});

describe('隐藏槽作用域：主场景 vs `@织` 监听（ERB 局部槽跨函数不可见）', () => {
  it('两份清单各含自己的槽；fixture 产物里两处 `;SLOT` 声明位置不同', () => {
    let mainSlots: readonly KojoHiddenSlot[] = [];
    let listenerSlots: readonly KojoHiddenSlot[] = [];
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      wrapMachine: (request) => {
        mainSlots = request.slots;
        // 主事件体包装用 fixture 真实现（会为 mainSlots 发 `;SLOT`）
        return FIXTURE_BACKEND.wrapMachine!(request);
      },
      weave: {
        ...FIXTURE_BACKEND.weave,
        weaveHeader: (request) => {
          listenerSlots = request.slots;
          return [
            ...request.slots.map((slot) => `;SLOT ${slot.name} ${slot.kind} ${slot.valueType}`),
            `WEAVE ${request.event}`,
          ];
        },
      },
    };
    const source = [
      '# 机 开场',
      '# 表 甲 由 恋慕',
      '    0..9 a',
      '    否 z',
      '# 表 乙 由 恋慕',
      '    0..9 b',
      '    否 z',
      '> {甲}',
      '@随机',
      '    > 主甲',
      '    > 主乙',
      '@织 开场',
      '    > {乙}',
      '    @随机',
      '        > 听甲',
      '        > 听乙',
      '',
    ].join('\n');
    const result = compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend });
    expect(result.ok).toBe(true);

    // 主场景只含自己的槽（甲 + 第 9 行的随机块）
    expect(mainSlots).toEqual([
      { name: '__kojo_table_甲', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_甲__value', kind: 'table', valueType: 'string', role: 'table-value' },
      { name: '__kojo_rand_9', kind: 'random', valueType: 'int', role: 'random-slot' },
    ]);
    // 监听函数只含监听体的槽（乙 + 第 14 行的随机块），不串主场景
    expect(listenerSlots).toEqual([
      { name: '__kojo_table_乙', kind: 'table', valueType: 'int', role: 'table-subject' },
      { name: '__kojo_table_乙__value', kind: 'table', valueType: 'string', role: 'table-value' },
      { name: '__kojo_rand_14', kind: 'random', valueType: 'int', role: 'random-slot' },
    ]);
    expect(result.slots).toEqual(mainSlots); // 编译结果的 slots 只统计主场景体

    // fixture 产物：主 wrapper 的 ;SLOT 在正文前，监听 header 的 ;SLOT 在其事件头前
    const rows = bodyLines(result.erb);
    const mainSlotAt = rows.findIndex((line) => line === ';SLOT __kojo_table_甲 table int');
    const listenerSlotAt = rows.findIndex((line) => line === ';SLOT __kojo_table_乙 table int');
    expect(mainSlotAt).toBeGreaterThanOrEqual(0);
    expect(listenerSlotAt).toBeGreaterThan(mainSlotAt);
    const weaveAt = rows.findIndex((line) => line === 'WEAVE 开场');
    expect(weaveAt).toBeGreaterThan(listenerSlotAt);
    expect(rows.slice(listenerSlotAt, weaveAt)).toEqual([
      ';SLOT __kojo_table_乙 table int',
      ';SLOT __kojo_table_乙__value table string',
      ';SLOT __kojo_rand_14 random int',
    ]);
  });
});

describe('不变量', () => {
  it('成功：sourceMap.lineCount === 产物行数；每行都有登记', () => {
    const result = compile([...HEAD, '# 表 心情 由 恋慕', '    0..9 疏远', '    否 未知', '> {心情}']);
    expect(result.ok).toBe(true);
    const rows = bodyLines(result.erb);
    expect(result.sourceMap.lineCount).toBe(rows.length);
    for (let line = 1; line <= rows.length; line++) {
      const hit = result.sourceMap.lookup({ line, column: 1 });
      expect(hit.line).not.toBeNull();
    }
  });
});
