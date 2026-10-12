/**
 * S5 批验收：糖提升建议器（原生 ERB → 糖候选）。
 *
 * 硬性覆盖（用户验收项）：**每一类糖都走三路**
 * 1. **正例命中** —— 形态清晰的原生 ERB 区间产出候选，且候选自带
 *    `roundTrip.verified === true`（自证证据，而不是"看起来像"）；
 * 2. **干扰反例跳过** —— 注释 / 宏 / 标签 / 糖未覆盖的控制流 / W: 文本域与
 *    L: 逻辑域混行 / 行内条件 → 落在 `skipped` 里，**不产出候选**；
 * 3. **round-trip 降级** —— 形态像但转不回去（典型：`PRINTFORMDW 「台词」`
 *    有引号却强制 `D`）→ 降级为 `skipped`，`reason === 'roundtrip-mismatch'`。
 *
 * 另加：四类糖的 kind 覆盖、`degraded` 分支（缺 `parseCondition` 替身）、
 * 旁白口径（`旁白色:` 头部开关）的命中记录、集成断言（`fixtures/mini-game`
 * 的真实 ERB + `fixtures/sugar` 的糖源码 **回降再升**闭环）。
 *
 * 说明：本文件是**测试**，按解耦审计规则 C 的豁免（测试属宿主层面集成）
 * 可直接 import 其它插件包；非测试源码一律不得交叉 import。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, ControlFlowStatement, SugarLiftResult } from '@kojo/plugin-api';
import {
  hasCandidates,
  isVerifiedCandidate,
  WellKnownServices,
} from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createSugarTranspileService } from '../src/service';
import { createSugarLiftService, liftSuggest } from '../src/lift';
import type { LiftDeps } from '../src/lift';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

/* ============================== 装配 ============================== */

const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '胆怯' || name === '恋慕' || name === '思慕') return 'TALENT';
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '名字') return 'CALLNAME';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (
      ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR', 'FLAG', 'TFLAG'].includes(head)
    ) {
      return ident;
    }
    return undefined;
  },
};

/** 生产口径的依赖（与 index.ts 装配一致：真实转译器 + 真实扫描 + 真实表达式解析） */
const prodDeps = (): LiftDeps => ({
  transpile: (source, options) =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(source, options),
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
  parseCondition: (text: string): ConditionExpr => parseExpression(text),
});

/** 只缺 `parseCondition` 的降级口径 */
const degradedDeps = (): LiftDeps => {
  const { transpile, scanControlFlow: scan } = prodDeps();
  return { transpile, scanControlFlow: scan };
};

const lift = (source: string, deps: LiftDeps = prodDeps(), extra?: { characterNo?: number }) =>
  liftSuggest(deps, { source, ...(extra ?? {}) });

/** 便捷断言：结果里存在某 kind 的候选 */
const kindsOf = (r: SugarLiftResult) => r.candidates.map((c) => c.kind);
/** 便捷断言：结果里存在某 reason 的跳过项 */
const reasonsOf = (r: SugarLiftResult) => r.skipped.map((s) => s.reason);

/* ============================== 一、PRINT 家族 ============================== */

describe('S5 / print-message —— 文本消息行升糖', () => {
  it('正例：PRINTFORMDW 旁白 → 无引号糖文本行（自证通过）', () => {
    const r = lift('PRINTFORMDW 她看起来很高兴。');
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('print-message');
    expect(c.fromLine).toBe(1);
    expect(c.toLine).toBe(1);
    expect(c.sugarSource).toBe('她看起来很高兴。');
    expect(c.confidence).toBe('verified');
    expect(c.narrationColor).toBe('默认');
    expect(c.roundTrip.verified).toBe(true);
    expect(isVerifiedCandidate(c)).toBe(true);
    expect(hasCandidates(r)).toBe(true);
  });

  it('正例：PRINTFORMW 台词（「」起）→ 糖文本行（自证通过）', () => {
    const r = lift('PRINTFORMW 「你好，%CALLNAME:MASTER%。」');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.kind).toBe('print-message');
    expect(r.candidates[0]!.sugarSource).toBe('「你好，%CALLNAME:MASTER%。」');
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('正例：PRINTFORML 「台词」 续 → 糖文本行 + 「 续」（台词不等待）', () => {
    const r = lift('PRINTFORML 「她红着脸，小声嘟囔着。」');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.sugarSource).toBe('「她红着脸，小声嘟囔着。」 续');
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('正例：PRINTFORML 无引号旁白 → 糖文本行（靠 `旁白色: 作者色` 口径自证通过）', () => {
    const r = lift('PRINTFORML 她红着脸，小声嘟囔着。');
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('print-message');
    expect(c.sugarSource).toBe('她红着脸，小声嘟囔着。 续');
    // 无引号文本要产出非 D 系，只能靠头部 `旁白色: 作者色`——候选必须带出该口径
    expect(c.narrationColor).toBe('作者色');
    expect(c.roundTrip.verified).toBe(true);
  });

  it('正例：PRINTFORMDL → 糖文本行 + 「 续」（默认口径，无引号走 D 系）', () => {
    const r = lift('PRINTFORMDL 她什么也没说。');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.sugarSource).toBe('她什么也没说。 续');
    // 两种口径都试，默认口径优先命中
    expect(r.candidates[0]!.narrationColor).toBe('默认');
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('正例：PRINTFORMW 旁白 → 糖文本行（`旁白色: 作者色` 口径自证通过）', () => {
    const r = lift('PRINTFORMW 她看起来很高兴。');
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.sugarSource).toBe('她看起来很高兴。');
    expect(c.narrationColor).toBe('作者色');
    expect(c.roundTrip.verified).toBe(true);
  });

  it('降级：PRINTFORMDW 「台词」（有引号却强制 D）→ round-trip 仍拦下', () => {
    // 引号性决定台词色（非 D），而 `旁白色` 只作用于旁白；
    // 故"有引号 + D"在糖表层**没有落点**（语料占比 0.35%，见设计稿 §2.3）
    const r = lift('PRINTFORMDW 「你好。」');
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toContain('roundtrip-mismatch');
  });

  it('跳过：PRINTFORM / PRINTFORMD（无 L/W 后缀）没有糖形态', () => {
    for (const src of ['PRINTFORM 不换行', 'PRINTFORMD 不换行旁白']) {
      const r = lift(src);
      expect(r.candidates).toHaveLength(0);
      expect(r.skipped[0]!.reason).toBe('unsupported-print-variant');
    }
  });

  it('跳过：PRINTL / PRINT / PRINTBUTTON 等非 FORM 系', () => {
    const r = lift('PRINTL 普通打印');
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped[0]!.reason).toBe('unsupported-print-variant');
  });

  it('跳过：含行内条件 \\@…\\@ 的行（本版不逆向行内条件）', () => {
    const r = lift('PRINTFORMW 她\\@ CFLAG:2 >= 50 ? "很高兴" # "很平静" \\@地看着你。');
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toContain('not-covered');
  });

  it('跳过：注释行与空行不产出任何东西（也不记跳过）', () => {
    const r = lift('; 这是注释\n\nPRINTFORMDW 正文。');
    expect(r.candidates.map((c) => c.fromLine)).toEqual([3]);
    expect(r.skipped).toHaveLength(0);
  });
});

/* ========================= 一之二、旁白口径（`旁白色:`）========================= */

/**
 * 糖层对"无引号旁白"的 `D` 归属由**文件头 `旁白色:` 开关**决定（spec §3.1 / §5.1）：
 * - `默认`（缺省）→ 旁白走 `D` 系（`PRINTFORMDW/DL`）；
 * - `作者色` → 旁白也用角色色（`PRINTFORMW/L`）。
 *
 * 因此自证必须**两种口径都试**——否则 `PRINTFORMW/L <无引号>`（语料 12.8 万行）会
 * 被误判为不一致。命中口径回写进 `SugarLiftCandidate.narrationColor`，消费方应用
 * `作者色` 候选时需同步写文件头。这组用例锁死该机制（改动即红）。
 */
describe('S5 / 旁白口径 —— `旁白色:` 头部开关决定无引号文本的 D 归属', () => {
  it('无引号 + 非 D（PRINTFORMW）→ 作者色口径自证通过', () => {
    const r = lift('PRINTFORMW 她看起来很高兴。');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.narrationColor).toBe('作者色');
    expect(r.candidates[0]!.sugarSource).toBe('她看起来很高兴。');
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('无引号 + D（PRINTFORMDW）→ 默认口径自证通过（口径不写进候选的语义依赖）', () => {
    const r = lift('PRINTFORMDW 她看起来很高兴。');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.narrationColor).toBe('默认');
    expect(r.candidates[0]!.sugarSource).toBe('她看起来很高兴。');
  });

  it('两种口径都能命中时，**默认优先**（社区缺省口径，无谓引入头部声明）', () => {
    // `PRINTFORMW 「台词」`：旁白色 不影响台词 —— 两种口径产物相同 → 取默认
    const r = lift('PRINTFORMW 「你好。」');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.narrationColor).toBe('默认');
  });

  it('块级候选同样带径（IF 块内的无引号非 D 文本）', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMW 她看起来很高兴。', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.kind).toBe('if-block');
    expect(r.candidates[0]!.narrationColor).toBe('作者色');
    expect(r.candidates[0]!.sugarSource).toBe('如果 CFLAG:2 >= 50：\n\t她看起来很高兴。');
  });

  it('分派块候选同样带径（SELECTCASE / 随机块）', () => {
    const src = [
      'LOCAL = RAND:2',
      'SELECTCASE LOCAL',
      '\tCASE 0',
      '\t\tPRINTFORMW 甲。',
      '\tCASE 1',
      '\t\tPRINTFORMW 乙。',
      'ENDSELECT',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.kind).toBe('selectcase');
    expect(r.candidates[0]!.narrationColor).toBe('作者色');
    expect(r.candidates[0]!.sugarSource).toBe('随机：\n\t甲。\n\t乙。');
  });

  it('同一段文本在默认口径下仍成立时不误报作者色（口径最小化）', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMDW 她看起来很高兴。', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates[0]!.narrationColor).toBe('默认');
  });
});

/* ============================== 二、IF 家族 ============================== */

describe('S5 / if-block —— IF 块升糖', () => {
  it('正例：单分支 IF → 「如果 …：」+ 缩进体（自证通过）', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMDW 她看起来很高兴。', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('if-block');
    expect(c.fromLine).toBe(1);
    expect(c.toLine).toBe(3);
    expect(c.sugarSource).toBe(['如果 CFLAG:2 >= 50：', '\t她看起来很高兴。'].join('\n'));
    expect(c.roundTrip.verified).toBe(true);
  });

  it('正例：IF / ELSEIF / ELSE 三分支 → 「如果 / 否则如果 / 否则」（自证通过）', () => {
    const src = [
      'IF CFLAG:2 >= 80',
      '\tPRINTFORMDW 她害羞地笑了。',
      'ELSEIF CFLAG:2 >= 30',
      '\tPRINTFORMDW 她微微点头。',
      'ELSE',
      '\tPRINTFORMDW 她没什么反应。',
      'ENDIF',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('if-block');
    expect(c.sugarSource).toBe(
      [
        '如果 CFLAG:2 >= 80：',
        '\t她害羞地笑了。',
        '否则如果 CFLAG:2 >= 30：',
        '\t她微微点头。',
        '否则：',
        '\t她没什么反应。',
      ].join('\n'),
    );
    expect(c.roundTrip.verified).toBe(true);
  });

  it('正例：嵌套 IF 由外层候选携带，不重复产出内层候选', () => {
    const src = [
      'IF CFLAG:2 >= 50',
      '\tIF TALENT:胆怯',
      '\t\tPRINTFORMDW 她缩了缩。',
      '\tENDIF',
      'ENDIF',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.fromLine).toBe(1);
    expect(r.candidates[0]!.toLine).toBe(5);
    expect(r.candidates[0]!.sugarSource).toBe(
      ['如果 CFLAG:2 >= 50：', '\t如果 TALENT:胆怯：', '\t\t她缩了缩。'].join('\n'),
    );
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('跳过：块内混入注释行 → 不产出候选（混行保守）', () => {
    const src = [
      'IF CFLAG:2 >= 50',
      '\t; 这里有个注释',
      '\tPRINTFORMDW 她看起来很高兴。',
      'ENDIF',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('mixed-domain-line');
  });

  it('跳过：块内含糖未覆盖的控制流（FOR 循环）', () => {
    const src = ['IF CFLAG:2 >= 50', '\tFOR I, 0, 3', '\t\tPRINTFORMDW 一次。', '\tNEXT', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('unsupported-control-flow');
  });

  it('跳过：块内含 GOTO / 标签', () => {
    const src = ['IF CFLAG:2 >= 50', '\tGOTO HOGE', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('label-or-goto');
  });

  it('跳过：残缺块（IF 没有配对 ENDIF）不产出块候选', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMDW 她看起来很高兴。'].join('\n');
    const r = lift(src);
    // 块级不成立（残缺不猜）；块内的独立文本行仍可单独升糖——这是**期望**行为
    expect(r.candidates.some((c) => c.kind === 'if-block')).toBe(false);
    expect(reasonsOf(r)).toContain('unsupported-control-flow');
  });

  it('跳过：条件表达式无法解析（opaque）', () => {
    // `?` 单目是不完整表达式 → parseExpression 降级 opaque
    const src = ['IF ?CFLAG:2', '\tPRINTFORMDW 她看起来很高兴。', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('mixed-domain-line');
  });

  it('跳过：空分支体（糖要求块体非空）', () => {
    const src = ['IF CFLAG:2 >= 50', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('mixed-domain-line');
  });
});

/* ============================== 三、SELECTCASE 分派 ============================== */

describe('S5 / selectcase —— SELECTCASE 分派升糖', () => {
  it('正例：SELECTCASE + CASE / CASEELSE → 「当 / 是 / 否则」（自证通过）', () => {
    const src = [
      'SELECTCASE TFLAG:193',
      '\tCASE 1',
      '\t\tPRINTFORMW 「不、不要……！」',
      '\tCASE 2, 3',
      '\t\tPRINTFORMW 「呜……真是的。」',
      '\tCASEELSE',
      '\t\tPRINTFORMDW 她什么也没说。',
      'ENDSELECT',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('selectcase');
    expect(c.sugarSource).toBe(
      [
        '当 TFLAG:193：',
        '\t是 1：',
        '\t\t「不、不要……！」',
        '\t是 2, 3：',
        '\t\t「呜……真是的。」',
        '\t否则：',
        '\t\t她什么也没说。',
      ].join('\n'),
    );
    expect(c.roundTrip.verified).toBe(true);
  });

  it('正例：CASE a TO b → 糖「a 到 b」', () => {
    const src = ['SELECTCASE CFLAG:2', '\tCASE 10 TO 20', '\t\tPRINTFORMDW 中段。', 'ENDSELECT'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.sugarSource).toBe(['当 CFLAG:2：', '\t是 10 到 20：', '\t\t中段。'].join('\n'));
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('正例：等概率随机组 → 「随机：」块（含上一行 LOCAL = RAND:n）', () => {
    const src = [
      'LOCAL = RAND:3',
      'SELECTCASE LOCAL',
      '\tCASE 0',
      '\t\tPRINTFORMW 「呀……！」',
      '\tCASE 1',
      '\t\tPRINTFORMW 「呜……真是的。」',
      '\tCASE 2',
      '\t\tPRINTFORMDW 她什么也没说。',
      'ENDSELECT',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('selectcase');
    // 区间必须**含**上一行 RAND 赋值（替换后不留残行）
    expect(c.fromLine).toBe(1);
    expect(c.toLine).toBe(9);
    expect(c.sugarSource).toBe(
      ['随机：', '\t「呀……！」', '\t「呜……真是的。」', '\t她什么也没说。'].join('\n'),
    );
    expect(c.roundTrip.verified).toBe(true);
  });

  it('跳过：分派表达式无法解析', () => {
    const src = ['SELECTCASE ?X', '\tCASE 1', '\t\tPRINTFORMDW 甲。', 'ENDSELECT'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('unparsable-condition');
  });

  it('跳过：块体混入注释', () => {
    const src = ['SELECTCASE TFLAG:193', '\tCASE 1', '\t\t; 注释', '\t\tPRINTFORMDW 甲。', 'ENDSELECT'].join('\n');
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(reasonsOf(r)).toContain('mixed-domain-line');
  });
});

/* ============================== 四、别名 ============================== */

describe('S5 / alias —— 重复变量引用升糖为别名（本版仅提示，不出候选）', () => {
  it('边界：裸标识符位置重复 ≥3 次 → 报告 not-covered，**不产出候选**（宁可漏报）', () => {
    const src = [
      'IF CFLAG:TARGET:1088',
      '\tPRINTFORMDW 今天已经够了。',
      'ENDIF',
      'CFLAG:TARGET:1088 = 1',
      'IF !CFLAG:TARGET:1088',
      '\tPRINTFORMDW 还没呢。',
      'ENDIF',
    ].join('\n');
    const r = lift(src);
    // 别名不做候选（糖层的别名替换不介入原生 ERB 形态，无法自证）
    expect(r.candidates.filter((c) => c.kind === 'alias')).toHaveLength(0);
    const note = r.skipped.find((s) => s.reason === 'not-covered' && s.message.includes('CFLAG:TARGET:1088'));
    expect(note).toBeDefined();
    expect(note!.message).toContain('3 次');
    // 但块级糖仍然正常产出（别名不影响其它类）
    expect(r.candidates.filter((c) => c.kind === 'if-block').length).toBeGreaterThanOrEqual(1);
  });

  it('边界：`%…%` 插值里的重复引用 → 同样只提示', () => {
    const src = [
      'PRINTFORMDW 好感是 %CFLAG:TARGET:1088%。',
      'PRINTFORMDW 再说一遍，好感是 %CFLAG:TARGET:1088%。',
      'PRINTFORMDW 第三遍了，好感是 %CFLAG:TARGET:1088%。',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates.filter((c) => c.kind === 'alias')).toHaveLength(0);
    expect(r.skipped.some((s) => s.reason === 'not-covered' && s.message.includes('CFLAG:TARGET:1088'))).toBe(true);
  });

  it('跳过：只出现 2 次（收益太低不报）', () => {
    const src = [
      'IF CFLAG:TARGET:1088',
      '\tPRINTFORMDW 甲。',
      'ENDIF',
      'CFLAG:TARGET:1088 = 1',
    ].join('\n');
    const r = lift(src);
    expect(r.candidates.filter((c) => c.kind === 'alias')).toHaveLength(0);
    expect(r.skipped.some((s) => s.message.includes('CFLAG:TARGET:1088'))).toBe(false);
  });
});

/* ============================== 五、降级 / 契约 ============================== */

describe('S5 / 降级与契约', () => {
  it('degraded：缺 parseCondition 时标记 degraded，结构判据不受影响', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMDW 她看起来很高兴。', 'ENDIF'].join('\n');
    const r = lift(src, degradedDeps());
    expect(r.degraded).toBe(true);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.roundTrip.verified).toBe(true);
  });

  it('degraded：缺 scanControlFlow 时用内置最小实现（只认 IF/SELECTCASE）', () => {
    const { transpile } = prodDeps();
    const r = liftSuggest({ transpile }, { source: 'PRINTFORMDW 正文。' });
    expect(r.degraded).toBe(true);
    expect(r.candidates).toHaveLength(1);
  });

  it('非字符串输入抛 TypeError（契约：输入必须是文本）', () => {
    expect(() => liftSuggest(prodDeps(), { source: undefined as unknown as string })).toThrow(TypeError);
  });

  it('候选与跳过项均按行号升序（UI 逐条确认依赖稳定顺序）', () => {
    const src = [
      'PRINTFORMDW 第一行。',
      'IF CFLAG:2 >= 50',
      '\tPRINTFORMDW 块内。',
      'ENDIF',
      'PRINTFORMDW 最后一行。',
    ].join('\n');
    const r = lift(src);
    const starts = r.candidates.map((c) => c.fromLine);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('服务装配：createSugarLiftService 与 liftSuggest 同口径', () => {
    const svc = createSugarLiftService(prodDeps());
    const a = svc.liftSuggest({ source: 'PRINTFORMDW 正文。' });
    const b = lift('PRINTFORMDW 正文。');
    expect(a).toEqual(b);
    expect(WellKnownServices.SugarLift).toBe('sugar.lift');
  });

  it('只读纪律：不改动输入、不产生副作用（幂等）', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMDW 她看起来很高兴。', 'ENDIF'].join('\n');
    const copy = String(src);
    const a = lift(src);
    const b = lift(src);
    expect(src).toBe(copy);
    expect(a).toEqual(b);
  });
});

/* ============================== 六、集成：真实 fixtures ============================== */

describe('S5 / 集成 —— fixtures', () => {
  const miniErb = path.resolve(
    import.meta.dirname,
    '../../../../fixtures/mini-game/ERB/口上・メッセージ関連/個人口上/001 Remu/M_KOJO_K1.ERB',
  );

  it('mini-game 真实 ERB：IF LOCAL 信封块 + 内层 IF 均被识别（自证通过）', () => {
    const source = fs.readFileSync(miniErb, 'utf8');
    const r = lift(source, prodDeps(), { characterNo: 1 });
    // `IF LOCAL` 是**信封层**（转译器骨架守卫，见 S4 `isEnvelopeChain`）——
    // 升糖应透传它、取体内一级块，而不把它本身当候选。
    const blocks = r.candidates.filter((c) => c.kind === 'if-block');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const top = blocks[0]!;
    expect(top.roundTrip.verified).toBe(true);
    // `IF CFLAG:2 >= 50` 块在 `IF LOCAL` 体内（第 13–15 行）→ 应能升糖
    expect(top.sugarSource).toBe(['如果 CFLAG:2 >= 50：', '\t她看起来很高兴。'].join('\n'));
    // 信封本身**不**产出候选（它的谓词 `LOCAL` 字典不可解析）
    expect(r.candidates.some((c) => c.sugarSource.includes('如果 LOCAL：'))).toBe(false);
    // 台词行独立升糖（`PRINTFORMW 「你好，…」` 无 D → 原生自洽）
    const print = r.candidates.find((c) => c.kind === 'print-message');
    expect(print?.sugarSource).toBe('「你好，%CALLNAME:MASTER%。」');
  });

  it('mini-game 真实 ERB：函数声明 / 骨架注释行不产出候选（宏与注释干扰）', () => {
    const source = fs.readFileSync(miniErb, 'utf8');
    const r = lift(source, prodDeps(), { characterNo: 1 });
    for (const c of r.candidates) {
      const seg = source.split('\n').slice(c.fromLine - 1, c.toLine);
      for (const l of seg) {
        expect(l.trimStart().startsWith('@')).toBe(false);
        expect(l.trimStart().startsWith('#')).toBe(false);
      }
    }
  });

  it('fixtures/sugar 样例：糖源码 → 降糖 → 升糖闭环（回降产物能被再识别为候选）', () => {
    const kojoPath = path.resolve(import.meta.dirname, '../../../../fixtures/sugar/sample-310.kojo');
    const kojo = fs.readFileSync(kojoPath, 'utf8');
    const transpiled = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(kojo);
    expect(transpiled.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    const r = lift(transpiled.erb, prodDeps(), { characterNo: 101 });
    // 产物里必然含「当 TFLAG:193：」分派块（§6.1 形态）→ 应被识别为 selectcase 候选
    const sc = r.candidates.filter((c) => c.kind === 'selectcase');
    expect(sc.length).toBeGreaterThanOrEqual(1);
    for (const c of sc) expect(c.roundTrip.verified).toBe(true);
    // 并且候选里的「是 2, 3」形态与样例一致（说明值集合逆向正确）
    expect(sc.some((c) => c.sugarSource.includes('是 2, 3：'))).toBe(true);
  });

  it('集成自洽：产物 → 候选 → 再转译 → 与原产物区间逐字节一致', () => {
    const kojoPath = path.resolve(import.meta.dirname, '../../../../fixtures/sugar/sample-310.kojo');
    const kojo = fs.readFileSync(kojoPath, 'utf8');
    const erb = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(kojo).erb;
    const r = lift(erb, prodDeps(), { characterNo: 101 });

    const lines = erb.replace(/\r\n/g, '\n').split('\n');
    for (const c of r.candidates) {
      const original = lines.slice(c.fromLine - 1, c.toLine).join('\n');
      expect(c.roundTrip.originalText).toBe(original);
      expect(c.roundTrip.generatedText).toBe(original);
    }
  });
});

describe('缩进口径（回归：按层级归一，不按字符）', () => {
  /**
   * 回归自 2026-10-12 语法糖视图批：旧 `normalizeIndent` 用 `indentOf`（数**层级**）
   * 算出 `min`，却在剥离循环里按**字符**扣（空格 1 / 全角 2 / TAB 1）——两把尺子。
   * 后果：空格缩进的源只剥掉 1 个空格，与壳产物（TAB，剥干净）判成不一致 →
   * **所有 4 空格缩进的 `.kojo`（规范示例与新建向导骨架的写法）识别不到任何升糖候选**。
   *
   * 三种缩进风格都必须能识别，且识别出的糖写法是**相对形态**（不带绝对缩进）。
   */
  const variants: Record<string, string[]> = {
    '1 个 TAB': ['角色: 1', '时机 指令 310：', '\tPRINTFORMDW 甲。'],
    '4 空格': ['角色: 1', '时机 指令 310：', '    PRINTFORMDW 甲。'],
    '8 空格（嵌套一层）': ['角色: 1', '时机 指令 310：', '    如果 FLAG:1：', '        PRINTFORMDW 甲。'],
    '2 个 TAB（嵌套一层）': ['角色: 1', '时机 指令 310：', '\t如果 FLAG:1：', '\t\tPRINTFORMDW 甲。'],
  };

  for (const [name, lines] of Object.entries(variants)) {
    it(`${name}：能识别出文本行候选，且糖写法为相对形态`, () => {
      const src = `${lines.join('\n')}\n`;
      const r = lift(src, prodDeps(), { characterNo: 101 });
      const pm = r.candidates.filter((c) => c.kind === 'print-message');
      expect(pm.length).toBe(1);
      expect(pm[0]!.sugarSource).toBe('甲。');
      expect(pm[0]!.roundTrip.verified).toBe(true);
    });
  }
});
