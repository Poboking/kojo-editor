/**
 * 1016 批 · 数值增减行 `增减 <族>:<对象>:<槽> <op> <增量>` → 一行 `CALL <族目标函数>(…)`。
 *
 * 判据（本批）：
 * - **泛化动词**：只有一个动词糖位（`增减` / 英文别名 `adjust`），把"改某族某槽"收成一行；
 *   表层与 `结算` 同款"词 + 空白 + 余下正文"，不做每个 CFLAG/BASE 名字各造关键字；
 * - **降级必走 `CALL`**：族头查 adapter 增减族表得**目标函数 + 参数序 + 变量槽形态**，
 *   按 `argOrder` 排实参（CFLAG 槽在前、BASE 对象在前 ⇒ 两族产物形态不同）；
 *   **绝不降成裸算术赋值**（`CHANGE_CFLAG` / `BUFF_BASE` 内含钳制 / 记账 / 消息副作用）；
 * - 变量槽 / 对象**原样透传**（写 `lowerExpression` 会误报 `unknown-identifier`），
 *   只有增量交表达式降糖；`-=` 增量取负（单原子前置 `-`、含顶层运算符加括号 `-(…)`）；
 * - **fail-closed（零新诊断码，复用闭集码 `unknown-identifier` error）**：
 *   ①族头未登记（含缺表 / 拼错）②变量槽形态不符（引用非三段 / 对象或槽为空 /
 *   该族要求数字下标却写了名字）——两成因**文案互斥**可区分；
 * - 结构残缺（无 ref / 无运算符 / 空增量）→ 退化为普通文本行（同 `结算` 退化口径）。
 *
 * 游戏知识只住 adapter：本测试用 `@kojo/plugin-eratw-adapter` 的**真实**族表
 * （`stubMutatorTable()`），断言贴近生产（审计 C 项对 `tests/` 豁免）。
 */

import { describe, expect, it } from 'vitest';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '../src/service';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { stubDict, stubFaceTable, stubMutatorTable } from './support';

const svc = () =>
  createSugarTranspileService({
    dictionary: stubDict,
    faceTable: stubFaceTable(),
    mutatorTable: stubMutatorTable(),
  });
const t = (src: string) => svc().transpile(src);

/** 正文落在 `时机 绝顶：` 体内（stub 表 = eraTW 真实模板） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/** 产物按行展开、去缩进 */
const outLines = (src: string): string[] => t(src).erb.split('\n').map((l) => l.trim());
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
const hasCall = (src: string, prefix: string): boolean => outLines(src).some((l) => l.startsWith(prefix));
/**
 * 本糖**产出的**目标函数行（`CALL <族目标函数>(…)`）。
 * 刻意排除每个产物都有的外层包装行 `CALL M_KOJO_…_1`——否则"没有降糖"的负断言恒假。
 */
const mutatorCalls = (src: string): string[] =>
  outLines(src).filter((l) => /^CALL (CHANGE_CFLAG|BUFF_BASE)\(/.test(l));

/** 投影只依赖结构扫描（transpile 用抛错替身证明不被调用） */
const projDeps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (text: string) => scanControlFlow(text),
});

/* ================================ 正向 ================================ */

describe('1016 增减行 · 正向（→ 一行 CALL <目标函数>）', () => {
  it('CFLAG 族：`增减 CFLAG:TARGET:2 += 100` → `CALL CHANGE_CFLAG(2, TARGET, 100)`（槽在前）', () => {
    const src = doc('\t增减 CFLAG:TARGET:2 += 100');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CALL CHANGE_CFLAG(2, TARGET, 100)');
  });

  it('BASE 族：`增减 BASE:MASTER:BASE_体力 += 300` → `CALL BUFF_BASE(MASTER, BASE_体力, 300)`（对象在前）', () => {
    const src = doc('\t增减 BASE:MASTER:BASE_体力 += 300');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CALL BUFF_BASE(MASTER, BASE_体力, 300)');
  });

  it('`-=` 单原子取负：`增减 CFLAG:TARGET:2 -= 100` → `CALL CHANGE_CFLAG(2, TARGET, -100)`', () => {
    const src = doc('\t增减 CFLAG:TARGET:2 -= 100');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CALL CHANGE_CFLAG(2, TARGET, -100)');
  });

  it('`-=` 含顶层运算符加括号防优先级错：`-= 非 0` → `-(! 0)`', () => {
    const src = doc('\t增减 BASE:MASTER:BASE_体力 -= 非 0');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CALL BUFF_BASE(MASTER, BASE_体力, -(! 0))');
  });

  it('裸 `=` 形与 `+=` 同产（`=` 视为原始变动值）：`增减 CFLAG:TARGET:2 = 100`', () => {
    const src = doc('\t增减 CFLAG:TARGET:2 = 100');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CALL CHANGE_CFLAG(2, TARGET, 100)');
  });

  it('增量交表达式降糖（属性展开）：`+= 她的好感度` → 实参为 `CFLAG:TARGET:好感度`', () => {
    const src = doc('\t增减 CFLAG:TARGET:2 += 她的好感度');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('CALL CHANGE_CFLAG(2, TARGET, CFLAG:TARGET:好感度)');
  });

  it('对象与变量槽**原样透传**，不被 `lowerExpression` 误报', () => {
    // `BASE_体力` 走 lowerExpression 会被判 `unknown-identifier`；这里必须零 error
    expect(errs(doc('\t增减 BASE:MASTER:BASE_体力 += 1'))).toEqual([]);
    expect(errs(doc('\t增减 CFLAG:MASTER:2 += 1'))).toEqual([]);
  });

  it('逐字节：运算符两侧无空白也同产（`CFLAG:TARGET:2+=100`）', () => {
    const src = doc('\t增减 CFLAG:TARGET:2+=100');
    expect(outLines(src)).toContain('CALL CHANGE_CFLAG(2, TARGET, 100)');
  });

  it('英文别名 `adjust` 与中文 `增减` 等价（产物逐字节相同）', () => {
    expect(t(doc('\tadjust CFLAG:TARGET:2 += 100')).erb).toEqual(t(doc('\t增减 CFLAG:TARGET:2 += 100')).erb);
    expect(t(doc('\tadjust BASE:MASTER:BASE_体力 -= 5')).erb).toEqual(
      t(doc('\t增减 BASE:MASTER:BASE_体力 -= 5')).erb,
    );
  });

  it('行内体（`如果 …：增减 …`）同样产 CALL 直通行', () => {
    const src = doc('\t如果 1 == 1： 增减 CFLAG:TARGET:2 += 100');
    expect(errs(src)).toEqual([]);
    expect(hasCall(src, 'CALL CHANGE_CFLAG(2, TARGET, 100)')).toBe(true);
  });
});

/* ==================== fail-closed：两成因互斥可区分 ==================== */

describe('1016 增减行 · 未登记族 / 变量槽形态不符（复用闭集码 unknown-identifier，两成因互斥）', () => {
  const msgs = (src: string): string[] => errs(src).map((d) => d.message);

  it('成因 A · 族头未登记：文案含「增减族表」「适配器」，不含「变量槽」', () => {
    const src = doc('\t增减 FOOBAR:TARGET:2 += 1');
    const e = errs(src);
    expect(e).toHaveLength(1);
    expect(e[0]!.code).toBe('unknown-identifier');
    expect(e[0]!.severity).toBe('error');
    expect(msgs(src)[0]).toContain('增减族表');
    expect(msgs(src)[0]).toContain('适配器');
    expect(msgs(src)[0]).not.toContain('变量槽');
  });

  it('成因 A · 适配器未提供增减族表（缺表）：同样判「族头查不到」，不产 CALL', () => {
    const bare = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
    const r = bare.transpile(doc('\t增减 CFLAG:TARGET:2 += 1'));
    const e = r.diagnostics.filter((d) => d.severity === 'error');
    expect(e).toHaveLength(1);
    expect(e[0]!.code).toBe('unknown-identifier');
    expect(e[0]!.message).toContain('增减族表');
    expect(r.erb.split('\n').map((l) => l.trim())).not.toContain('CALL CHANGE_CFLAG(2, TARGET, 1)');
  });

  it('成因 B · 引用非三段（`增减 TARGET:2 += 1`）：文案含「变量槽」，不含「增减族表」', () => {
    const src = doc('\t增减 TARGET:2 += 1');
    const e = errs(src);
    expect(e).toHaveLength(1);
    expect(e[0]!.code).toBe('unknown-identifier');
    expect(msgs(src)[0]).toContain('变量槽');
    expect(msgs(src)[0]).not.toContain('增减族表');
  });

  it('成因 B · 对象 / 槽为空（`增减 CFLAG::2 += 1`）：文案含「变量槽」', () => {
    const src = doc('\t增减 CFLAG::2 += 1');
    const e = errs(src);
    expect(e).toHaveLength(1);
    expect(msgs(src)[0]).toContain('变量槽');
    expect(msgs(src)[0]).not.toContain('增减族表');
  });

  it('成因 B · CFLAG 要求数字下标却写名（`增减 CFLAG:TARGET:好感度 += 1`）：文案含「变量槽」，绝不猜编号', () => {
    const src = doc('\t增减 CFLAG:TARGET:好感度 += 1');
    const e = errs(src);
    expect(e).toHaveLength(1);
    expect(msgs(src)[0]).toContain('变量槽');
    expect(msgs(src)[0]).not.toContain('增减族表');
    expect(mutatorCalls(src)).toEqual([]);
  });

  it('fail-closed 不产半成品：报错行不往产物落任何 CALL', () => {
    expect(mutatorCalls(doc('\t增减 FOOBAR:TARGET:2 += 1'))).toEqual([]);
    expect(mutatorCalls(doc('\t增减 CFLAG:TARGET:好感度 += 1'))).toEqual([]);
  });
});

/* ============ 解析退化：不开新诊断码，与 `结算` 同口径落文本行 ============ */

describe('1016 增减行 · 结构残缺 → 文本行（不静默吞、不产 CALL）', () => {
  it('裸 `增减`（关键字后无空白+内容）不判为增减，按文本行打印', () => {
    const src = doc('\t增减');
    expect(errs(src)).toEqual([]);
    expect(mutatorCalls(src)).toEqual([]);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('增减'))).toBe(true);
  });

  it('`增减済み`（关键字后紧跟内容、无空白）同样不判为增减', () => {
    const src = doc('\t增减済み');
    expect(mutatorCalls(src)).toEqual([]);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('增减済み'))).toBe(true);
  });

  it('无运算符（`增减 CFLAG:TARGET:2 等于 3`，只有比较词没有赋值符）→ 文本行', () => {
    const src = doc('\t增减 CFLAG:TARGET:2 等于 3');
    expect(errs(src)).toEqual([]);
    expect(mutatorCalls(src)).toEqual([]);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('增减'))).toBe(true);
  });

  it('空增量（`增减 CFLAG:TARGET:2 +=`）→ 文本行（不被赋值扫描吞成左值、零 error）', () => {
    const src = doc('\t增减 CFLAG:TARGET:2 +=');
    expect(errs(src)).toEqual([]);
    expect(mutatorCalls(src)).toEqual([]);
    expect(outLines(src).some((l) => /^PRINTFORM/.test(l) && l.includes('增减 CFLAG:TARGET:2 +='))).toBe(true);
  });

  it('比较运算符不被误切：`增减` 行也不吃 `==` / `!=` / `<=` / `>=`', () => {
    for (const op of ['==', '!=', '<=', '>=']) {
      const src = doc(`\t增减 CFLAG:TARGET:2 ${op} 3`);
      expect(errs(src), op).toEqual([]);
      expect(mutatorCalls(src), op).toEqual([]);
    }
  });
});

/* ==================== 回归：手写 CALL 行不受影响 + 投影钉子 ==================== */

describe('1016 增减行 · 手写 `CALL` 行与投影钉子', () => {
  it('转译：手写 `CALL CHANGE_CFLAG(…)` 由原生直通截获、原样透传（不被二次处理）', () => {
    const src = doc('\tCALL CHANGE_CFLAG(2, TARGET, 100)');
    expect(outLines(src)).toContain('CALL CHANGE_CFLAG(2, TARGET, 100)');
    expect(errs(src)).toEqual([]);
  });

  it('投影：手写 `CALL CHANGE_CFLAG(…)` 仍按既有口径原样保留（不改字节、不产生糖段）', () => {
    const r = liftProject(projDeps(), { source: 'CALL CHANGE_CFLAG(2, TARGET, 100)' });
    expect(r.segments).toHaveLength(0);
    expect(r.stats.nativeByReason.find((x) => x.reason === 'other')?.count).toBe(1);
  });
});
