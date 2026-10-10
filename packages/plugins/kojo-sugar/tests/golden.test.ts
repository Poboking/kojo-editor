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
import { stubDict, stubFaceTable } from './support';

// 兼容旧引用点（其它测试文件从本文件 import `stubDict`）
export { stubDict } from './support';

const dir = new URL('./goldens/', import.meta.url);
const readRaw = (name: string) => readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');

/** 读 fixture 并剥掉首部 `//` 注释横幅（fixture 约定，不进转译输入） */
export const readKojo = (name: string) =>
  readRaw(name)
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n');

const service = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

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

describe('golden §3.3 · 旁白口径（`旁白色:`）对 D 归属的作用（逐字节成对）', () => {
  /**
   * 同一份无引号文本，唯一变量是文件头是否声明 `旁白色: 作者色`：
   * - 缺省（`默认`）→ 旁白走 `D` 系（`PRINTFORMD*`）；
   * - `作者色` → 旁白也用角色色（`PRINTFORM*`）。
   *
   * 这两张 golden 成对存在，锁定 spec §5.1 的 `d = (旁白色 == 默认) 且 not speech`。
   */
  it('缺省口径 → 无引号文本产 D 系（PRINTFORMDW / PRINTFORMDL）', () => {
    const { erb, diagnostics } = service().transpile(readKojo('spec-3.3-narration-default.kojo'));
    expect(diagnostics).toEqual([]);
    expect(erb).toBe(readRaw('spec-3.3-narration-default.expected.erb.todo'));
    expect(erb).toContain('\tPRINTFORMDW 她点了点头。');
    expect(erb).toContain('\tPRINTFORMDL 她叹了口气。');
    // 台词不受旁白口径影响，恒为非 D
    expect(erb).toContain('\tPRINTFORMW 「今天也来训练了？」');
  });

  it('`旁白色: 作者色` → 同一份无引号文本改产非 D 系（PRINTFORMW / PRINTFORML）', () => {
    const { erb, diagnostics } = service().transpile(
      readKojo('spec-3.3-narration-author-color.kojo'),
    );
    expect(diagnostics).toEqual([]);
    expect(erb).toBe(readRaw('spec-3.3-narration-author-color.expected.erb.todo'));
    expect(erb).toContain('\tPRINTFORMW 她点了点头。');
    expect(erb).toContain('\tPRINTFORML 她叹了口气。');
    expect(erb).toContain('\tPRINTFORMW 「今天也来训练了？」');
  });

  it('两张 golden 的差异**仅在** D 后缀（锁定口径是唯一变量）', () => {
    const a = readRaw('spec-3.3-narration-default.expected.erb.todo');
    const b = readRaw('spec-3.3-narration-author-color.expected.erb.todo');
    expect(a).not.toBe(b);
    // 把 D 系归一为非 D 系后应当完全一致
    const unD = (s: string) => s.replace(/PRINTFORMD([WL])/g, 'PRINTFORM$1');
    expect(unD(a)).toBe(unD(b));
  });
});
