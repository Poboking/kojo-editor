/**
 * ZH-F1 · 基础库 / 常用函数名中文化（adapter 表消费）单测。
 *
 * 覆盖四件事：
 * 1. 中文函数名调用形态 → 原生 ERB 函数名（走 adapter 的 `KojoLibraryTable`）；
 * 2. **系统函数表优先**于 adapter 表（同名时系统名胜出）；
 * 3. 两表皆不认的**中文函数名调用形态** → 报 `function-name-unknown`（warning，
 *    产物逐字节原样；fail-visible）；
 * 4. 负测：裸词 / 别名 / 变量引用 / 字符串字面量 / 前导标识符**一律不误伤**。
 *
 * 测试用的函数名表由真 adapter builder（`createEratwLibraryTable`）构造——与生产装配
 * 同构，杜绝"替身与实现形状不同构 ⇒ 空断言"。
 */

import { describe, expect, it } from 'vitest';
import type { KojoLibraryTable, SugarDiagnostic } from '@kojo/plugin-api';
import { createEratwLibraryTable } from '@kojo/plugin-eratw-adapter';
import { lowerExpression, type ExprContext } from '../src/expression';
import {
  isKnownFunctionName,
  lookupFunctionName,
  lowerSystemFunctions,
} from '../src/system-functions';
import { stubDict } from './support';
import type { AliasEntry } from '../src/types';

/** 最小函数名表（测试桩；生产表由 eratw-adapter 直接提供） */
function stubLibraryTable(): KojoLibraryTable {
  return createEratwLibraryTable(
    new Map([
      ['角色文本', 'CHARA_TEXT'],
      ['随机文本', 'TEXTR'],
      ['心形', 'HPH_PRINT'],
    ]),
  );
}

/** 降糖上下文（函数名表可选；字典用 support 桩；诊断写进 sink） */
function ctx(opts: {
  libraryTable?: KojoLibraryTable;
  aliases?: Map<string, AliasEntry>;
  sink?: SugarDiagnostic[];
}): ExprContext {
  return {
    aliases: opts.aliases ?? new Map(),
    dictionary: stubDict,
    ...(opts.libraryTable ? { libraryTable: opts.libraryTable } : {}),
    report: (d) => opts.sink?.push(d),
    loc: null,
  };
}

/* ============================ A. 中文名 → 原生 ERB ============================ */

describe('lowerExpression · adapter 函数名表消费（ZH-F1）', () => {
  it('中文函数名调用形态降为原生 ERB 名', () => {
    expect(lowerExpression('角色文本(她的名字)', ctx({ libraryTable: stubLibraryTable() }))).toBe(
      'CHARA_TEXT(CALLNAME:TARGET)',
    );
    expect(lowerExpression('随机文本("甲", "乙")', ctx({ libraryTable: stubLibraryTable() }))).toBe(
      'TEXTR("甲", "乙")',
    );
    expect(lowerExpression('心形(1)', ctx({ libraryTable: stubLibraryTable() }))).toBe('HPH_PRINT(1)');
  });

  it('`lowerSystemFunctions` 亦认 adapter 表（直观形态）', () => {
    expect(lowerSystemFunctions('角色文本(她的名字)', stubLibraryTable())).toBe(
      'CHARA_TEXT(她的名字)',
    );
  });

  it('名字与 `(` 之间的空白保留（系统表与 adapter 表同口径）', () => {
    expect(lowerSystemFunctions('角色文本 ( x )', stubLibraryTable())).toBe('CHARA_TEXT ( x )');
  });
});

/* ============================ B. 系统函数表优先 ============================ */

describe('系统函数表优先于 adapter 表', () => {
  it('同名时系统名胜出（adapter 表不覆盖语言层）', () => {
    const table = createEratwLibraryTable(new Map([['获取标记', 'NOT_THIS']]));
    expect(lookupFunctionName('获取标记', table)).toBe('GETBIT');
    expect(lowerExpression('获取标记(1)', ctx({ libraryTable: table }))).toBe('GETBIT(1)');
  });

  it('adapter 表独有名字照常命中；两表皆无返回 undefined', () => {
    const table = stubLibraryTable();
    expect(lookupFunctionName('角色文本', table)).toBe('CHARA_TEXT');
    expect(lookupFunctionName('未知函数', table)).toBeUndefined();
    expect(isKnownFunctionName('角色文本', table)).toBe(true);
    expect(isKnownFunctionName('未知函数', table)).toBe(false);
  });
});

/* ==================== C. 两表皆不认 → function-name-unknown ==================== */

describe('中文函数名调用形态两表皆无 → warning，产物原样（fail-visible）', () => {
  it('有 adapter 表时未收录中文调用名报 warning 且产物逐字节原样', () => {
    const sink: SugarDiagnostic[] = [];
    const out = lowerExpression('未知函数(1)', ctx({ libraryTable: stubLibraryTable(), sink }));
    expect(out).toBe('未知函数(1)');
    expect(sink.filter((d) => d.code === 'function-name-unknown')).toHaveLength(1);
    expect(sink.find((d) => d.code === 'function-name-unknown')!.severity).toBe('warning');
  });

  it('无 adapter 表（适配器未声明）时同样报 warning，产物原样', () => {
    const sink: SugarDiagnostic[] = [];
    const out = lowerExpression('角色文本(1)', ctx({ sink }));
    expect(out).toBe('角色文本(1)');
    expect(sink.filter((d) => d.code === 'function-name-unknown')).toHaveLength(1);
  });

  it('收录的名字不报本码（系统表或 adapter 表任一命中即放行）', () => {
    const sink: SugarDiagnostic[] = [];
    lowerExpression('获取标记(1)', ctx({ libraryTable: stubLibraryTable(), sink }));
    lowerExpression('角色文本(1)', ctx({ libraryTable: stubLibraryTable(), sink }));
    expect(sink.filter((d) => d.code === 'function-name-unknown')).toHaveLength(0);
  });
});

/* ============================ D. 负测：不误伤 ============================ */

describe('负测 · 非调用形态与受保护段落一律不误伤', () => {
  it('裸中文词（无 `(`）不降糖、不报本码', () => {
    const sink: SugarDiagnostic[] = [];
    // 既非别名、也非字典命中 → 仍是 unknown-identifier（error），但**不**是 function-name-unknown
    expect(lowerExpression('角色文本', ctx({ libraryTable: stubLibraryTable(), sink }))).toBe('角色文本');
    expect(sink.some((d) => d.code === 'function-name-unknown')).toBe(false);
  });

  it('别名（无 `(`）照旧按别名展开；别名与函数名同字时调用形态走函数名', () => {
    const aliases = new Map<string, AliasEntry>([
      ['角色文本', { value: { kind: 'variable', text: 'CFLAG:TARGET:1088' }, readonly: false, line: 1 }],
    ]);
    // 裸词 → 别名展开
    expect(lowerExpression('角色文本', ctx({ aliases }))).toBe('CFLAG:TARGET:1088');
    // 调用形态 → adapter 函数名优先（别名不参与）
    expect(lowerExpression('角色文本(1)', ctx({ aliases, libraryTable: stubLibraryTable() }))).toBe(
      'CHARA_TEXT(1)',
    );
  });

  it('字符串字面量内部不改写、不报本码', () => {
    const sink: SugarDiagnostic[] = [];
    expect(lowerExpression('"角色文本(1)"', ctx({ libraryTable: stubLibraryTable(), sink }))).toBe(
      '"角色文本(1)"',
    );
    expect(sink).toHaveLength(0);
    expect(lowerSystemFunctions('获取标记 ("未知函数(2)")', stubLibraryTable())).toBe(
      'GETBIT ("未知函数(2)")',
    );
  });

  it('前导标识符字符（长中文串）不从中间截取：`她的角色文本(1)` 不报本码', () => {
    const sink: SugarDiagnostic[] = [];
    // `角色文本(` 被前导中文黏住 → 不降糖；本码只看"独立中文函数名调用形态"，故不出
    lowerSystemFunctions('她的角色文本(1)', stubLibraryTable());
    lowerExpression('她的角色文本(1)', ctx({ libraryTable: stubLibraryTable(), sink }));
    expect(sink.some((d) => d.code === 'function-name-unknown')).toBe(false);
  });
});
