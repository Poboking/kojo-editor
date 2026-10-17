/**
 * **红线尺子（ZH-M，kojo 全中文化系列）** —— `.kojo 预览` 屏上「一整行原样 ERB」的行数。
 *
 * 系列目标（用户 2026-10-17 令）：预览**不许出现一整行源文件抄来的 ERB**。行内残留英文记号
 * （引擎函数名、槽位原名 `噴乳`）允许——那是数据不是语言；「这一行逐字等于 `.ERB` 那一行」=
 * 作者仍在读 ERB = 不允许。预览是**只读理解面**（糖 model `readOnly`、磁盘零改动），本文件
 * 一切判据只看「作者读到什么」，**不涉及**产物可逆性（不存在「原文转糖再编译」这条链路）。
 *
 * 判据实现**只有一份**：`../src/native-display/types.ts` 的 `measureVerbatimNativeLines`；
 * 这里只做装配、分账与棘轮。六条并行线各自要交「改前 → 改后」，没有共用的尺子必然各造六套口径。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import {
  isCountableErBLine,
  isVerbatimNativeLine,
  measureVerbatimNativeLines,
} from '../src/native-display/types';

const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影是只读显示面，不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
});

const split = (source: string): string[] => source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

/** 源文本 → 红线读数（走契约尺子，本文件不自己数） */
function measure(source: string) {
  const r = liftProject(deps(), { source });
  const m = measureVerbatimNativeLines(split(source), r.segments);
  return { ...m, hitTexts: m.hits.map((h) => h.text), stats: r.stats };
}

/* ==================== 判据本体 ==================== */

describe('红线尺子 · 判据本身', () => {
  it('逐字相同才算红线；糖行 / 注释 / 空行 / SKIP 标记都不算', () => {
    expect(isVerbatimNativeLine('PRINTFORMW 「嗯」', 'PRINTFORMW 「嗯」')).toBe(true);
    expect(isVerbatimNativeLine('「嗯」', 'PRINTFORMW 「嗯」')).toBe(false);
    expect(isVerbatimNativeLine('如果 LOCAL：', 'IF LOCAL')).toBe(false);
    expect(isVerbatimNativeLine(';注释本来就是中文', ';注释本来就是中文')).toBe(false);
    expect(isVerbatimNativeLine('', '')).toBe(false);
    expect(isCountableErBLine('   ')).toBe(false);
    expect(isCountableErBLine('; 说明')).toBe(false);
    expect(isCountableErBLine('[SKIPSTART]')).toBe(false);
    expect(isCountableErBLine('CALL X')).toBe(true);
  });

  it('分母只算作者真得读的行；未接管的行逐条可追（报红要能给「屏上原样文案」）', () => {
    const src = ['', ';说明', 'CALL X', '', 'TFLAG:193 = 1'];
    // 空段 = 什么都不接管 ⇒ 分母金额与报红明细直接钉尺子口径（不借投影的世界育人）
    const m = measureVerbatimNativeLines(src, []);
    expect(m.total).toBe(2);
    expect(m.count).toBe(2);
    expect(m.uncovered).toBe(2);
    expect(m.hits.map((h) => h.text)).toEqual(['CALL X', 'TFLAG:193 = 1']);
    expect(m.hits.map((h) => h.line)).toEqual([3, 5]);
    // 合流后同一份源在投影下归零（`CALL` → `调用 …`、赋值行走 ZH-S pass）——分母照常计数、命中消失
    expect(measure('\n;说明\nCALL X\n\nTFLAG:193 = 1')).toMatchObject({ total: 2, count: 0 });
  });

  it('台词段整段被糖替换 ⇒ 0 行原样 ERB（尺子不误报已被接管的行）', () => {
    const m = measure('PRINTFORMW 「今天也来训练了？」\nPRINTFORML 「……」');
    expect(m.total).toBe(2);
    expect(m.count).toBe(0);
  });
});

/* ==================== 真实语料形态：本系列的改前基线 ==================== */

/**
 * 一份典型「指令口上」函数，覆盖语料里所有高频形态（骨架信封 / 台词 / 控制流 /
 * 数据表 / 循环 / 预处理 / 标签 / 早退返回）。缩进用 TAB，与真实语料一致。
 */
const REALISTIC_ERB = [
  '@M_KOJO_MESSAGE_COM_K101_303',
  ';-------------------------------------------------',
  ';記入チェック（=0, 非表示、1, 表示）',
  'LOCAL = 1',
  ';-------------------------------------------------',
  'IF LOCAL',
  '\tPRINTFORMW 「今天也来训练了？」',
  '\tTFLAG:193 = 1',
  '\tCONF:12 += 3',
  '\tCALL M_KOJO_K101_HELPER',
  '\tSELECTCASE SELECTCOM',
  '\t\tCASE 311',
  '\t\t\tPRINTFORMW 「嗯……」',
  '\t\tCASEELSE',
  '\t\t\tPRINTFORMW "……"',
  '\tENDSELECT',
  '\tSETBIT RESULT, 0',
  '\tPRINTDATA 3',
  '\t\tPRINTFORMW 「一」',
  '\tENDDATA',
  '\tSETCOLOR 0xFF8800',
  '\tRESETCOLOR',
  '\tWAIT',
  '\tFOR i = 0 TO 9',
  '\t\tPRINTFORMW 第%i%回',
  '\tNEXT',
  '\tWHILE FLAG:70 < 3',
  '\t\tFLAG:70 += 1',
  '\tWEND',
  '#DIM 计数 3',
  '$loopstart',
  '\tJUMP loopstart',
  '\tSIF !CFLAG:101:2',
  '\t\tRETURN 2',
  'ENDIF',
  'RETURN 1',
].join('\n');

/**
 * **本批实测基线（ZH-M 交付的数）**：33 个可读源行里 **18 行整行原样 ERB 上屏**（54.5%）。
 *
 * 已接管、**不算**红线的部分（别再误当靶子）：`LOCAL = 1` + `IF LOCAL` + `ENDIF` + 尾巴
 * `RETURN 1` 的記入チェック信封已吸收；`SELECTCASE / CASE / CASEELSE / ENDSELECT` 折成
 * `当 …：` / `是 …：`；`SETCOLOR` / `RESETCOLOR` 走 `着色` 糖；`SIF` 折成条件；台词行全部上中文。
 */
const BASELINE = {
  total: 33,
  count: 18,
  uncovered: 18,
  echoed: 0,
  /** 逐行钉死（行号 1 基）——哪一行还压在作者眼前 */
  hits: [
    '@M_KOJO_MESSAGE_COM_K101_303', // 函数头：面表未命中 ⇒ 归 ZH-N / 面表面
    'TFLAG:193 = 1', // 赋值（全局族）⇒ ZH-S
    'CONF:12 += 3', // 赋值（未别名族）⇒ ZH-N + ZH-S
    'CALL M_KOJO_K101_HELPER', // 调用 ⇒ ZH-S
    'SETBIT RESULT, 0', // 位原语 ⇒ ZH-S
    'PRINTDATA 3', // 数据表 ⇒ ZH-S
    'PRINTFORMW 「一」', // 数据表体 ⇒ ZH-S
    'ENDDATA', // 数据表收束 ⇒ ZH-C
    'WAIT', // 等待 ⇒ ZH-S
    'FOR i = 0 TO 9', // 循环 ⇒ ZH-C
    'NEXT', // 循环收束 ⇒ ZH-C
    'WHILE FLAG:70 < 3', // 循环 ⇒ ZH-C
    'FLAG:70 += 1', // 赋值 ⇒ ZH-S
    'WEND', // 循环收束 ⇒ ZH-C
    '#DIM 计数 3', // 预处理 ⇒ ZH-C
    '$loopstart', // 标签 ⇒ ZH-C
    'JUMP loopstart', // 跳转 ⇒ ZH-C
    'RETURN 2', // 函数体内早退 ⇒ ZH-P（本系列令 RETURN 永不上屏）
  ],
} as const;

describe('红线尺子 · 真实语料形态分账（六线的共同靶）', () => {
  it('归零验收（全中系列合流后）：同一份语料形态，红线从 18/33 到 0/33', () => {
    const m = measure(REALISTIC_ERB);
    // 分母（真实语料形态的可读行）没变——变的是每一行都被接管且不再是原样 ERB
    expect(m.total).toBe(BASELINE.total);
    expect(m.count).toBe(0);
    expect(m.uncovered).toBe(0);
    expect(m.echoed).toBe(0);
    expect(m.hits).toEqual([]);
  });

  it('成因分账可见（不静默）：other / unsupported-control-flow / data-or-skip 三类都有数', () => {
    const { stats } = measure(REALISTIC_ERB);
    const byReason = new Map(stats.nativeByReason.map((x) => [x.reason, x.count]));
    // 改前 18 行原样上屏；合流后 `RETURN 2`（SIF 早退）被 ZH-P 吸收 ⇒ native 分账 17。
    // 每一类都要有数（任何一类被吞掉都算静默违约）：
    expect(byReason.get('other') ?? 0).toBeGreaterThan(0);
    expect(byReason.get('unsupported-control-flow') ?? 0).toBeGreaterThan(0);
    expect(byReason.get('data-or-skip') ?? 0).toBeGreaterThan(0);
    expect(
      (byReason.get('other') ?? 0) + (byReason.get('unsupported-control-flow') ?? 0) + (byReason.get('data-or-skip') ?? 0),
    ).toBe(17);
  });

  /**
   * **棘轮**：只许降、不许升。合流后 lead 逐档下调 `BASELINE`，归零时把本用例改成
   * `expect(m.count).toBe(0)` —— 那才是系列终点。
   */
  it('棘轮：红线行数只许降、不许升', () => {
    const m = measure(REALISTIC_ERB);
    expect(m.count).toBeLessThanOrEqual(BASELINE.count);
  });
});
