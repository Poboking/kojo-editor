/**
 * `分支：` 规则池（条件即注解）端到端转译断言 —— 规范 §3.11。
 *
 * 判据：
 * - 产物**就是**一条 `IF / ELSEIF / ELSE / ENDIF` 链（复用「如果」链的 codegen 路径）；
 * - 每个 `[条件]` 走与「如果」**完全相同**的条件降糖管线；
 * - 默认保持书写顺序；只有「同一主语 + 同一数值比较运算符」才按阈值从窄到宽排序；
 * - error 级池诊断 ⇒ 该块**一条字节都不产**（宁缺勿编）。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { canSortRulePool, parseNumericComparison, sortRulePoolBranches } from '../src/rule-pool';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);
// 新增码尚未进契约闭集（本批只改 kojo-sugar）⇒ 断言侧按 string 读，避免 TS2367
const codes = (src: string): string[] => t(src).diagnostics.map((d) => d.code as string);
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
const findCode = (src: string, code: string) =>
  t(src).diagnostics.find((d) => (d.code as string) === code);

const wrap = (body: string): string => `角色: 12\n时机 指令 311：\n${body}`;

/**
 * 截取规则池产物链（从时机体内的 `IF …` 起、到配平的 `ENDIF` 止），并去掉一层缩进，
 * 便于逐字节对照。用「IF 深度」配对，故分支体内的嵌套 `如果` 不会提前截断。
 */
const chain = (src: string): string[] => {
  const lines = t(src).erb.split('\n');
  const start = lines.findIndex((l) => /^\tIF /.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    out.push(line.replace(/^\t/, ''));
    if (/^IF\b/.test(trimmed)) depth++;
    if (trimmed === 'ENDIF') {
      depth--;
      if (depth === 0) break;
    }
  }
  return out;
};

/* ============================================================================ */
/* A. 基础产物                                                                  */
/* ============================================================================ */

describe('§3.11 规则池 · 基础产物', () => {
  const src = wrap(
    [
      '\t分支：',
      '\t\t[她的恋慕 且 她的思慕]',
      '\t\t\t「……那、那里……！」',
      '\t\t\t她红着脸缩了一下身子。',
      '\t\t[她的好感度 >= 500]',
      '\t\t\t「……嗯。」',
      '\t\t[其他]',
      '\t\t\t「……请不要乱摸。」',
      '',
    ].join('\n'),
  );

  it('① 三分支 → IF / ELSEIF / ELSE / ENDIF 逐字节', () => {
    expect(errs(src)).toEqual([]);
    expect(chain(src)).toEqual([
      'IF TALENT:TARGET:恋慕 && TALENT:TARGET:思慕',
      '\tPRINTFORMW 「……那、那里……！」',
      '\tPRINTFORMDW 她红着脸缩了一下身子。',
      'ELSEIF CFLAG:TARGET:好感度 >= 500',
      '\tPRINTFORMW 「……嗯。」',
      'ELSE',
      '\tPRINTFORMW 「……请不要乱摸。」',
      'ENDIF',
    ]);
  });

  it('② `[否则]` 与 `[其他]` 等价（产物逐字节相同）', () => {
    const other = src;
    const otherwise = src.replace('[其他]', '[否则]');
    expect(errs(otherwise)).toEqual([]);
    expect(t(otherwise).erb).toEqual(t(other).erb);
  });

  it('英文块头 `branch：` 与中文 `分支：` 等价', () => {
    const en = src.replace('分支：', 'branch：');
    expect(errs(en)).toEqual([]);
    expect(t(en).erb).toEqual(t(src).erb);
  });

  it('标签行之间 / 分支体里的注释原样保留（注释不能丢）', () => {
    const withComment = wrap(
      [
        '\t分支：',
        '\t\t; 分支说明',
        '\t\t[她的恋慕]',
        '\t\t\t; 体内注释',
        '\t\t\t「嗯。」',
        '\t\t[其他]',
        '\t\t\t「……」',
        '',
      ].join('\n'),
    );
    const erb = t(withComment).erb;
    expect(errs(withComment)).toEqual([]);
    expect(erb).toContain('; 分支说明');
    expect(erb).toContain('; 体内注释');
  });
});

/* ============================================================================ */
/* B. 诊断（error 一律不产字节）                                                 */
/* ============================================================================ */

describe('§3.11 规则池 · 诊断', () => {
  it('③ 缺兜底 → rule-pool-no-fallback（error），整块不产字节', () => {
    const src = wrap(
      ['\t分支：', '\t\t[她的恋慕]', '\t\t\t「只有你。」', '\t\t[她的好感度 >= 500]', '\t\t\t「……嗯。」', ''].join('\n'),
    );
    expect(codes(src)).toContain('rule-pool-no-fallback');
    expect(findCode(src, 'rule-pool-no-fallback')!.message).toContain('[其他]');
    expect(chain(src)).toEqual([]);
    expect(t(src).erb).not.toContain('只有你');
  });

  it('④ 兜底不在最后 → rule-pool-fallback-not-last（error），整块不产字节', () => {
    const src = wrap(
      ['\t分支：', '\t\t[其他]', '\t\t\t「兜底。」', '\t\t[她的恋慕]', '\t\t\t「恋慕。」', ''].join('\n'),
    );
    expect(codes(src)).toContain('rule-pool-fallback-not-last');
    expect(chain(src)).toEqual([]);
  });

  it('⑤ 重复条件（去多余空白后逐字相同）→ rule-pool-duplicate（error）', () => {
    const src = wrap(
      [
        '\t分支：',
        '\t\t[她的好感度 >= 500]',
        '\t\t\t「A」',
        '\t\t[她的好感度   >=   500]',
        '\t\t\t「B」',
        '\t\t[其他]',
        '\t\t\t「C」',
        '',
      ].join('\n'),
    );
    expect(codes(src)).toContain('rule-pool-duplicate');
    expect(chain(src)).toEqual([]);
  });

  it('⑧ 空分支 → rule-pool-empty-branch（error），消息指明是哪个标签', () => {
    const src = wrap(['\t分支：', '\t\t[她的恋慕]', '\t\t[其他]', '\t\t\t「C」', ''].join('\n'));
    const diag = findCode(src, 'rule-pool-empty-branch');
    expect(diag).toBeDefined();
    expect(diag!.message).toContain('[她的恋慕]');
    expect(chain(src)).toEqual([]);
  });

  it('⑨ 块外 `[条件]` → rule-pool-branch-outside-pool（error），不当台词打印', () => {
    const src = wrap(['\t[她的恋慕]', '\t「正文」', ''].join('\n'));
    expect(codes(src)).toContain('rule-pool-branch-outside-pool');
    expect(t(src).erb).not.toContain('她的恋慕');
  });

  it('`[真]` 之后的后续分支 → rule-pool-unreachable（warning，不阻断产出）', () => {
    const src = wrap(
      ['\t分支：', '\t\t[真]', '\t\t\t「恒真。」', '\t\t[她的恋慕]', '\t\t\t「永远到不了。」', '\t\t[其他]', '\t\t\t「兜底。」', ''].join(
        '\n',
      ),
    );
    const unreachable = t(src).diagnostics.filter((d) => (d.code as string) === 'rule-pool-unreachable');
    expect(unreachable).toHaveLength(2);
    expect(unreachable.every((d) => d.severity === 'warning')).toBe(true);
    // warning 不阻断：IF 链照常产出
    expect(chain(src)[0]).toBe('IF true');
  });

  it('规则池内嵌规则池 → error（本批不做），不产半成品', () => {
    const src = wrap(
      ['\t分支：', '\t\t[她的恋慕]', '\t\t\t分支：', '\t\t\t\t[她的思慕]', '\t\t\t\t\t「嵌套」', '\t\t[其他]', '\t\t\t「兜底」', ''].join(
        '\n',
      ),
    );
    expect(errs(src).length).toBeGreaterThan(0);
    expect(t(src).erb).not.toContain('嵌套');
  });
});

/* ============================================================================ */
/* C. 排序：同主语数值条件 → 阈值从窄到宽                                        */
/* ============================================================================ */

describe('§3.11 规则池 · 自动排序', () => {
  const pool = (order: readonly string[]): string =>
    wrap(['\t分支：', ...order.flatMap((n) => [`\t\t[她的好感度 >= ${n}]`, `\t\t\t「${n}」`]), '\t\t[其他]', '\t\t\t「其他」', ''].join('\n'));

  it('⑥ 同主语 `>=` → 阈值从大到小（窄在前），且与书写顺序无关', () => {
    const shuffled = pool(['100', '500', '0']);
    const narrowFirst = pool(['500', '100', '0']);
    expect(errs(shuffled)).toEqual([]);
    expect(chain(shuffled)).toEqual([
      'IF CFLAG:TARGET:好感度 >= 500',
      '\tPRINTFORMW 「500」',
      'ELSEIF CFLAG:TARGET:好感度 >= 100',
      '\tPRINTFORMW 「100」',
      'ELSEIF CFLAG:TARGET:好感度 >= 0',
      '\tPRINTFORMW 「0」',
      'ELSE',
      '\tPRINTFORMW 「其他」',
      'ENDIF',
    ]);
    // 两种书写顺序产出**逐字节相同**的 ERB（顺序无关的产物级证明）
    expect(t(shuffled).erb).toEqual(t(narrowFirst).erb);
  });

  it('⑥b 顺序无关的等价性：任意书写顺序 → 同一分支选择', () => {
    // 三个作者顺序不同的池（同一组条件），排序后必须落到同一条链 ⇒ 任意输入值选中同一条分支。
    const orders = [
      ['100', '500', '0'],
      ['500', '0', '100'],
      ['0', '100', '500'],
    ].map((order) =>
      order.map((n) => ({ kind: 'rule' as const, condition: `她的好感度 >= ${n}`, label: n })),
    );
    const pick = (
      list: readonly { kind: 'rule' | 'else'; condition: string; label?: string }[],
      value: number,
    ): string => {
      for (const b of list) {
        if (b.kind === 'else') return '其他';
        const cmp = parseNumericComparison(b.condition)!;
        if (value >= cmp.value) return b.label ?? '';
      }
      return '';
    };
    for (const value of [-10, 0, 1, 99, 100, 101, 499, 500, 999]) {
      const picks = orders.map((o) => pick(sortRulePoolBranches([...o, { kind: 'else' as const, condition: '', label: '其他' }]), value));
      expect(new Set(picks).size).toBe(1);
      expect(picks[0]).toBe(value >= 500 ? '500' : value >= 100 ? '100' : value >= 0 ? '0' : '其他');
    }
  });

  it('`<` 条件 → 阈值从小到大（窄在前）', () => {
    const src = wrap(
      ['\t分支：', '\t\t[她的好感度 < 500]', '\t\t\t「宽」', '\t\t[她的好感度 < 100]', '\t\t\t「窄」', '\t\t[其他]', '\t\t\t「其他」', ''].join(
        '\n',
      ),
    );
    expect(chain(src).slice(0, 4)).toEqual([
      'IF CFLAG:TARGET:好感度 < 100',
      '\tPRINTFORMW 「窄」',
      'ELSEIF CFLAG:TARGET:好感度 < 500',
      '\tPRINTFORMW 「宽」',
    ]);
  });

  it('⑦ 混合形态（含 `且` / 不同主语）→ 整池保持书写顺序', () => {
    const src = wrap(
      [
        '\t分支：',
        '\t\t[她的恋慕 且 她的思慕]',
        '\t\t\t「A」',
        '\t\t[她的好感度 >= 500]',
        '\t\t\t「B」',
        '\t\t[其他]',
        '\t\t\t「C」',
        '',
      ].join('\n'),
    );
    expect(chain(src).slice(0, 5)).toEqual([
      'IF TALENT:TARGET:恋慕 && TALENT:TARGET:思慕',
      '\tPRINTFORMW 「A」',
      'ELSEIF CFLAG:TARGET:好感度 >= 500',
      '\tPRINTFORMW 「B」',
      'ELSE',
    ]);
    expect(canSortRulePool(['她的恋慕 且 她的思慕', '她的好感度 >= 500'])).toBe(false);
  });

  it('运算符混用（`>=` 与 `>`）→ 不可排序（顺序敏感）', () => {
    expect(canSortRulePool(['她的好感度 >= 500', '她的好感度 > 100'])).toBe(false);
  });
});

/* ============================================================================ */
/* D. 与逃生舱 / 嵌套块共存                                                      */
/* ============================================================================ */

describe('§3.11 规则池 · 嵌套与直通', () => {
  it('⑩ 分支体内可写嵌套 `如果` / `随机` / 原生行', () => {
    const src = wrap(
      [
        '\t分支：',
        '\t\t[她的恋慕]',
        '\t\t\t如果 她的思慕：',
        '\t\t\t\t「深。」',
        '\t\t\t否则：',
        '\t\t\t\t「浅。」',
        '\t\t\t随机：',
        '\t\t\t\t「甲」',
        '\t\t\t\t「乙」',
        '\t\t[其他]',
        '\t\t\tSETCOLOR 0xFF0000',
        '',
      ].join('\n'),
    );
    expect(errs(src)).toEqual([]);
    const erb = t(src).erb;
    expect(erb).toContain('IF TALENT:TARGET:恋慕');
    expect(erb).toContain('IF TALENT:TARGET:思慕');
    expect(erb).toContain('LOCAL = RAND:2');
    expect(erb).toContain('SELECTCASE LOCAL');
    expect(erb).toContain('SETCOLOR 0xFF0000');
    // 链仍正确收口：池的 ELSE 在最后
    expect(chain(src).filter((l) => l === 'ELSE')).toHaveLength(1);
  });

  it('排序是纯函数：不改入参，返回新数组', () => {
    const input = [
      { kind: 'rule' as const, condition: '她的好感度 >= 100' },
      { kind: 'rule' as const, condition: '她的好感度 >= 500' },
      { kind: 'else' as const, condition: '' },
    ];
    const out = sortRulePoolBranches(input);
    expect(input.map((b) => b.condition)).toEqual(['她的好感度 >= 100', '她的好感度 >= 500', '']);
    expect(out.map((b) => b.condition)).toEqual(['她的好感度 >= 500', '她的好感度 >= 100', '']);
    expect(out).not.toBe(input);
  });
});
