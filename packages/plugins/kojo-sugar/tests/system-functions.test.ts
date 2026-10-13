/**
 * HK-11① · 系统函数名中文化单测。
 *
 * 覆盖三件事：
 * 1. 别名表（中文名 → ERB 函数名）与调用形态替换；
 * 2. 边界：裸词 / 台词 / 长中文串 / 字符串字面量一律不误伤；未知名原样保留；
 * 3. 与既有单点机制（`心形` → `HPH_PRINT`）及双角色词（`随机` 块关键字）不冲突，
 *    且降糖链里系统函数名**先于**代词/属性（`lowerExpression` 端到端）。
 */

import { describe, expect, it } from 'vitest';
import { lowerExpression, type ExprContext } from '../src/expression';
import { SYSTEM_FUNCTION_ALIASES, lowerSystemFunctions } from '../src/system-functions';
import { stubDict } from './support';
import type { AliasEntry } from '../src/types';

/** 最小降糖上下文（别名可选；字典用 support 的桩） */
function ctx(aliases: ReadonlyMap<string, AliasEntry> = new Map()): ExprContext {
  return { aliases, dictionary: stubDict, report: () => {}, loc: null };
}

/* ============================ A. 别名表 ============================ */

describe('SYSTEM_FUNCTION_ALIASES · 中文名 → ERB 函数名', () => {
  it('表非空且覆盖 HANDOFF §13.4 点名的系统函数', () => {
    expect(SYSTEM_FUNCTION_ALIASES.size).toBeGreaterThan(0);
    expect(SYSTEM_FUNCTION_ALIASES.get('获取标记')).toBe('GETBIT');
    expect(SYSTEM_FUNCTION_ALIASES.get('首次')).toBe('FIRSTTIME');
    expect(SYSTEM_FUNCTION_ALIASES.get('随机')).toBe('RAND');
    expect(SYSTEM_FUNCTION_ALIASES.get('分组匹配')).toBe('GROUPMATCH');
  });

  it('只映射到全大写 ERB 名（不含用户自定义小写名）', () => {
    for (const [, erb] of SYSTEM_FUNCTION_ALIASES) {
      expect(erb).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('扩容覆盖 CHK_* 家族全集（语料实证 9 个）', () => {
    expect(SYSTEM_FUNCTION_ALIASES.get('检查约会中')).toBe('CHK_DATENOW');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查焦点')).toBe('CHK_FOCUS');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查入口')).toBe('CHK_ENTRANCE');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查有孩子')).toBe('CHK_HAVE_CHILD');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查子名重复')).toBe('CHK_CHILDNAME_DUPLICATION');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查避妊恋爱')).toBe('CHK_HININ_LOVE');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查避妊恋爱二')).toBe('CHK_HININ_LOVE_2');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查避妊理由')).toBe('CHK_HININ_REASON');
    expect(SYSTEM_FUNCTION_ALIASES.get('检查避妊理由二')).toBe('CHK_HININ_REASON_2');
  });

  it('扩容覆盖常见引擎内建（字符串 / 数组 / CSV / 时间）', () => {
    expect(SYSTEM_FUNCTION_ALIASES.get('字符串长度')).toBe('STRLENS');
    expect(SYSTEM_FUNCTION_ALIASES.get('出现次数')).toBe('STRCOUNT');
    expect(SYSTEM_FUNCTION_ALIASES.get('查找位置')).toBe('STRFIND');
    expect(SYSTEM_FUNCTION_ALIASES.get('取子串')).toBe('SUBSTRING');
    expect(SYSTEM_FUNCTION_ALIASES.get('取码点')).toBe('UNICODE');
    expect(SYSTEM_FUNCTION_ALIASES.get('编码取字')).toBe('ENCODETOUNI');
    expect(SYSTEM_FUNCTION_ALIASES.get('转字符串')).toBe('TOSTR');
    expect(SYSTEM_FUNCTION_ALIASES.get('转数值')).toBe('TOINT');
    expect(SYSTEM_FUNCTION_ALIASES.get('取常量')).toBe('GETNUM');
    expect(SYSTEM_FUNCTION_ALIASES.get('数组求和')).toBe('SUMARRAY');
    expect(SYSTEM_FUNCTION_ALIASES.get('数组计数')).toBe('MATCH');
    expect(SYSTEM_FUNCTION_ALIASES.get('数组查找')).toBe('FINDELEMENT');
    expect(SYSTEM_FUNCTION_ALIASES.get('区间判定')).toBe('INRANGE');
    expect(SYSTEM_FUNCTION_ALIASES.get('区间计数')).toBe('INRANGEARRAY');
    expect(SYSTEM_FUNCTION_ALIASES.get('平方根')).toBe('SQRT');
    expect(SYSTEM_FUNCTION_ALIASES.get('当前时间')).toBe('GETTIME');
    expect(SYSTEM_FUNCTION_ALIASES.get('毫秒')).toBe('GETMILLISECOND');
  });

  it('中文名键唯一（值可复用于别名同源）', () => {
    const names = [...SYSTEM_FUNCTION_ALIASES.keys()];
    expect(new Set(names).size).toBe(names.length);
  });

  it('前缀关系由最长优先消解：`检查避妊恋爱二` 先于 `检查避妊恋爱` 匹配', () => {
    // `检查避妊恋爱` 是 `检查避妊恋爱二` 的前缀（表内确有此关系，靠长度降序消解）
    expect(lowerSystemFunctions('检查避妊恋爱二(1)')).toBe('CHK_HININ_LOVE_2(1)');
    expect(lowerSystemFunctions('检查避妊恋爱(1)')).toBe('CHK_HININ_LOVE(1)');
  });
});

/* ==================== B. 调用形态替换 / 边界 ==================== */

describe('lowerSystemFunctions · 只对 `名字(` 调用生效', () => {
  it('调用形态替换为 ERB 函数名', () => {
    expect(lowerSystemFunctions('获取标记(CFLAG:TARGET:1088, 1)')).toBe('GETBIT(CFLAG:TARGET:1088, 1)');
    expect(lowerSystemFunctions('分组匹配(SELECTCOM, 310, 311)')).toBe('GROUPMATCH(SELECTCOM, 310, 311)');
    expect(lowerSystemFunctions('首次("SPEV2", 1)')).toBe('FIRSTTIME("SPEV2", 1)');
  });

  it('名字与 `(` 之间的空白保留（只换名字本身）', () => {
    expect(lowerSystemFunctions('获取标记 ( x )')).toBe('GETBIT ( x )');
  });

  it('裸词（无 `(`）原样保留——不误伤台词 / 属性词 / 别名', () => {
    expect(lowerSystemFunctions('获取标记')).toBe('获取标记');
    expect(lowerSystemFunctions('今天已获取标记值')).toBe('今天已获取标记值');
    // 前导为中文字符（词边界内）→ 不视为调用
    expect(lowerSystemFunctions('她的获取标记(1)')).toBe('她的获取标记(1)');
  });

  it('长中文串（别名只是前缀）不误伤', () => {
    expect(lowerSystemFunctions('获取标记列表(1)')).toBe('获取标记列表(1)');
  });

  it('最长优先：`随机化` 不被 `随机` 前缀吞并', () => {
    expect(lowerSystemFunctions('随机化()')).toBe('RANDOMIZE()');
    expect(lowerSystemFunctions('随机(3)')).toBe('RAND(3)');
  });

  it('CHK_* 扩容：调用形态降糖，长中文串 / 前导中文不乱截取', () => {
    expect(lowerSystemFunctions('检查入口(MAPID)')).toBe('CHK_ENTRANCE(MAPID)');
    expect(lowerSystemFunctions('检查避妊恋爱(她)')).toBe('CHK_HININ_LOVE(她)');
    // 长中文串（别名只是前缀）→ 原样保留
    expect(lowerSystemFunctions('检查入口处(1)')).toBe('检查入口处(1)');
    // 前缀命中但不能接 `(`（末尾多一个字）→ 不误伤
    expect(lowerSystemFunctions('检查避妊恋爱三(1)')).toBe('检查避妊恋爱三(1)');
    // 前导为中文字符（词边界内）→ 不视为调用
    expect(lowerSystemFunctions('她的检查入口(1)')).toBe('她的检查入口(1)');
  });

  it('引擎内建扩容：字符串 / 数组 / 常量族调用降糖', () => {
    expect(lowerSystemFunctions('取常量("某常量", 5)')).toBe('GETNUM("某常量", 5)');
    expect(lowerSystemFunctions('字符串长度(她的名字)')).toBe('STRLENS(她的名字)');
    expect(lowerSystemFunctions('区间判定(结果, 0, 99)')).toBe('INRANGE(结果, 0, 99)');
  });

  it('字符串字面量内部不改写', () => {
    expect(lowerSystemFunctions('"获取标记(1)"')).toBe('"获取标记(1)"');
    expect(lowerSystemFunctions('获取标记("她获取标记(2)", 1)')).toBe('GETBIT("她获取标记(2)", 1)');
  });

  it('未收录的中文名原样保留（fail-visible，不静默改写）', () => {
    expect(lowerSystemFunctions('未知函数(1)')).toBe('未知函数(1)');
    expect(lowerSystemFunctions('心形(「嗯。」)')).toBe('心形(「嗯。」)');
  });

  it('纯函数、无副作用：同输入同输出', () => {
    const src = '获取标记(她, 1)';
    expect(lowerSystemFunctions(src)).toBe(lowerSystemFunctions(src));
  });
});

/* ============ C. 与既有机制不冲突 + 降糖链顺序（端到端） ============ */

describe('降糖链接线 · 系统函数名先于代词/属性', () => {
  it('裸词不是调用 → 仍走别名展开（系统函数名不抢普通同名标识符）', () => {
    const aliases = new Map<string, AliasEntry>([
      ['获取标记', { value: { kind: 'variable', text: 'CFLAG:TARGET:1088' }, readonly: false, line: 1 }],
    ]);
    // 无 `(` → 按别名展开
    expect(lowerExpression('获取标记', ctx(aliases))).toBe('CFLAG:TARGET:1088');
    // 有 `(` → 系统函数名优先（别名不参与）
    expect(lowerExpression('获取标记(1)', ctx(aliases))).toBe('GETBIT(1)');
  });

  it('end-to-end：中文函数名 + 她的X 属性 → 原生 ERB 调用', () => {
    expect(lowerExpression('获取标记(她的好感度, 1)', ctx())).toBe('GETBIT(CFLAG:TARGET:好感度, 1)');
  });

  it('`随机` 块关键字形态（无 `(`）不被改写——双角色词不冲突', () => {
    // 块关键字写法是 `随机：` / `随机 甲, 乙`（不带调用括号）——原样保留
    expect(lowerSystemFunctions('随机 甲, 乙')).toBe('随机 甲, 乙');
    // 调用形态才降糖
    expect(lowerSystemFunctions('随机(3)')).toBe('RAND(3)');
  });

  it('`心形`（`kHPH_PRINT` 单点机制）不在本表内 → 本步零改动', () => {
    expect(SYSTEM_FUNCTION_ALIASES.has('心形')).toBe(false);
  });
});
