/**
 * S2 批 · golden 转译逐字节验收（规范 §6.1 / §6.2）。
 *
 * 硬性契约（规范 §6 末）：§6.1 / §6.2 的产物必须**逐字节**等于规范原文
 * （含 TAB 缩进、全角空格与 `;記入チェック` 注释行）。本文件把 S1 批的
 * `expected.erb.todo` 转正式断言。
 *
 * 测试字典是**测试专用最小桩**：游戏知识只允许出现在测试里（本批边界）；
 * 生产路径由 adapter 经槽位查询注入。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import type { DictionaryLookup } from '../src/types';

/** 测试用最小字典（覆盖 golden 用到的 胆怯 / 恋慕 / 思慕 / 好感度 / 心情 + 原生族名） */
export const stubDict: DictionaryLookup = {
  resolveFamily(name: string) {
    if (name === '胆怯' || name === '恋慕' || name === '思慕') return 'TALENT';
    if (name === '好感度' || name === '心情') return 'CFLAG';
    return undefined;
  },
  resolve(ident: string) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (
      ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR', 'FLAG', 'TFLAG'].includes(head)
    ) {
      return ident;
    }
    return undefined;
  },
};

const dir = new URL('./goldens/', import.meta.url);
const readRaw = (name: string) => readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');

/** 读 fixture 并剥掉首部 `//` 注释横幅（fixture 约定，不进转译输入） */
export const readKojo = (name: string) =>
  readRaw(name)
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n');

const service = () => createSugarTranspileService({ dictionary: stubDict });

describe('golden §6.1 · 露米娅 · 摸屁股 310（逐字节）', () => {
  const expected = readRaw('spec-6.1-lumia-310.expected.erb.todo');

  it('产物逐字节一致，且诊断为空', () => {
    const res = service().transpile(readKojo('spec-6.1-lumia-310.kojo'));
    expect(res.diagnostics).toEqual([]);
    expect(res.erb).toBe(expected);
  });

  it('关键锚点存在（TAB 缩进 / `記入チェック` 注释行 / 函数骨架）', () => {
    const { erb } = service().transpile(readKojo('spec-6.1-lumia-310.kojo'));
    expect(erb).toContain('@M_KOJO_MESSAGE_COM_K12_310_1');
    expect(erb).toContain(';記入チェック（=0, 非表示、1, 表示）');
    expect(erb).toContain('\tPRINTFORMW 「呀……！」');
    // §6.1 产物**不含**登记函数（RESULTS 为空 → 无内容可写 → 省略）
    expect(erb).not.toContain('@M_KOJO_K12');
    // 配色函数排在全部时机之后
    expect(erb.indexOf('@M_KOJO_COLOR_K12')).toBeGreaterThan(erb.indexOf('@M_KOJO_MESSAGE_COM_K12_310_1'));
  });
});

describe('golden §6.2 · 选项 + 心形 + 随机（摘录逐字节）', () => {
  it('从 `IF LOCAL` 到 `ENDIF` 的摘录逐字节一致', () => {
    const { erb, diagnostics } = service().transpile(readKojo('spec-6.2-choice-heart-random.kojo'));
    expect(diagnostics).toEqual([]);

    // 规范 §6.2 的期望产物是**摘录**：从 `IF LOCAL` 起、到 `ENDIF` 止
    // （不含其后的 `RETURN 1`），且以 +1 TAB 的呈现缩进排版 —— 去一级后对照。
    const expected = readRaw('spec-6.2-choice-heart-random.expected.erb.todo')
      .split('\n')
      .map((l) => (l.startsWith('\t') ? l.slice(1) : l))
      .join('\n');

    const lines = erb.split('\n');
    const start = lines.indexOf('IF LOCAL');
    const end = lines.indexOf('ENDIF');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const excerpt = lines.slice(start, end + 1).join('\n') + '\n';
    expect(excerpt).toBe(expected);
  });

  it('锚点：心形 HPH_PRINT / 选项 INPUTS+SELECTCASE RESULTS / 随机 bare LOCAL', () => {
    const { erb } = service().transpile(readKojo('spec-6.2-choice-heart-random.kojo'));
    expect(erb).toContain('CALL HPH_PRINT(@"……嗯。","w")');
    expect(erb).toContain('CALL HPH_PRINT(@"虽然，还不太明白……但是、不讨厌。","w")');
    expect(erb).toContain('PRINTBUTTON "用亲吻代替回答", "1"');
    expect(erb).toContain('INPUTS');
    expect(erb).toContain('SELECTCASE RESULTS');
    expect(erb).toContain('\t\tCASE "1"');
    // 随机块第 0 块写 bare `LOCAL`（= `LOCAL:0` 省略写法）——golden 冻结口径
    expect(erb).toContain('\t\t\tLOCAL = RAND:2');
    expect(erb).toContain('\t\t\tSELECTCASE LOCAL');
  });
});
