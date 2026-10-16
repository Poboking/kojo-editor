/**
 * 1016 批 · 计数器面登记：`时机 计数器 <中文名>：` 的名经 adapter 计数器值域表
 * 换算成编号，拼进既有 `_MESSAGE_COUNTER_K{n}_{i}` 形态（`{i}` = 编号）。
 *
 * 判据（本批）：
 * - **纯数字令牌直通**：`时机 计数器 20：` 不查表、逐字节保持旧产物（与无表实例
 *   转译结果全等——本文件用逐字节对比钉住）；
 * - **中文名走表**：命中 → 编号拼进函数名；MESSAGECHECK 与本体**共用同一份已解析编号**；
 * - **fail-closed（新码 `timing-counter-unknown`）**：未登记名 / 缺表（`hasTable=false`）
 *   两种成因**文案互斥**可区分；报错后该时机**一个字都不产**（不猜编号、不产半成品）。
 *
 * 游戏知识只住 adapter：本测试用 `@kojo/plugin-eratw-adapter` 的**真实**计数器表
 * （`stubCounterTable()`），断言贴近生产（审计 C 项对 `tests/` 豁免）。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService, type CreateSugarServiceOptions } from '../src/service';
import { EMPTY_COUNTER_TABLE } from '@kojo/plugin-eratw-adapter';
import { stubCounterTable, stubDict, stubFaceTable } from './support';

const svc = (extra: Partial<CreateSugarServiceOptions> = {}) =>
  createSugarTranspileService({
    dictionary: stubDict,
    faceTable: stubFaceTable(),
    ...extra,
  });
const withTable = () => svc({ counterTable: stubCounterTable() });
const noTable = () => svc();

const doc = (timing: string): string => `角色: 12\n${timing}`;

const outLines = (src: string, s = withTable()): string[] =>
  s.transpile(src).erb.split('\n').map((l) => l.trim());
const errs = (src: string, s = withTable()) =>
  s.transpile(src).diagnostics.filter((d) => d.severity === 'error');

/* ================================ 正向 ================================ */

describe('1016 计数器面 · 中文名直通（名 → 编号，函数名逐字对引擎调用形）', () => {
  it('`时机 计数器 偷看：` → `@M_KOJO_MESSAGE_COUNTER_K12_2`（偷看 = 编号 2）', () => {
    const src = doc('时机 计数器 偷看：\n    「偷看。」\n');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('@M_KOJO_MESSAGE_COUNTER_K12_2');
  });

  it('名字取**编号小者**：`搭话`（3/128 同名）→ 编号 3', () => {
    const src = doc('时机 计数器 搭话：\n    「搭话。」\n');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('@M_KOJO_MESSAGE_COUNTER_K12_3');
  });

  it('反应表编号同样可查：`膣性交` → 500（REACTION 族经 TCVAR:20 到口上）', () => {
    const src = doc('时机 计数器 膣性交：\n    「性交。」\n');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('@M_KOJO_MESSAGE_COUNTER_K12_500');
  });

  it('MESSAGECHECK 与本体**共用同一份已解析编号**（中缀插在 `_K{n}` 前，引擎 :1153）', () => {
    const src = doc('时机 计数器 偷看：\n    隐藏情景: 如果 TFLAG:193\n    「偷看。」\n');
    expect(errs(src)).toEqual([]);
    expect(outLines(src)).toContain('@M_KOJO_MESSAGE_COUNTER_K12_2');
    expect(outLines(src)).toContain('@M_KOJO_MESSAGE_COUNTER_MESSAGECHECK_K12_2');
  });
});

/* =========================== 数字路径逐字节直通 =========================== */

describe('1016 计数器面 · 纯数字令牌不查表、逐字节保持旧产物', () => {
  it('有表 / 无表两个实例，`时机 计数器 20：` 产物逐字节全等（旧文档零变化）', () => {
    const src = doc('时机 计数器 20：\n    隐藏情景: 如果 TFLAG:193\n    「计数。」\n');
    expect(withTable().transpile(src).erb).toBe(noTable().transpile(src).erb);
  });

  it('无表实例上数字路径零诊断，函数名照旧', () => {
    const src = doc('时机 计数器 20：\n    「计数。」\n');
    const r = noTable().transpile(src);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.erb.split('\n').map((l) => l.trim())).toContain('@M_KOJO_MESSAGE_COUNTER_K12_20');
  });
});

/* ============================== fail-closed ============================== */

describe('1016 计数器面 · 名查不到一律 fail-closed（绝不猜编号、不产半成品）', () => {
  it('未登记名：报 `timing-counter-unknown`，措辞含「未登记的计数器」', () => {
    const src = doc('时机 计数器 查无此计数器：\n    「呀。」\n');
    const diags = errs(src);
    expect(diags.length).toBe(1);
    expect(diags[0]!.code).toBe('timing-counter-unknown');
    expect(diags[0]!.message).toContain('未登记的计数器');
    expect(diags[0]!.message).not.toContain('未提供计数器表');
  });

  it('未登记名：该时机**一个字都不产**（没有函数头、没有正文、没有 MESSAGECHECK）', () => {
    const src = doc('时机 计数器 查无此计数器：\n    隐藏情景: 如果 TFLAG:193\n    「呀。」\n');
    const erb = withTable().transpile(src).erb;
    expect(erb).not.toContain('M_KOJO_MESSAGE_COUNTER');
    expect(erb).not.toContain('呀');
  });

  it('缺表（未注入 `counterTable`）：报同一码、措辞含「未提供计数器表」', () => {
    const src = doc('时机 计数器 偷看：\n    「呀。」\n');
    const diags = errs(src, noTable());
    expect(diags.length).toBe(1);
    expect(diags[0]!.code).toBe('timing-counter-unknown');
    expect(diags[0]!.message).toContain('未提供计数器表');
    expect(diags[0]!.message).not.toContain('未登记的计数器');
  });

  it('空表实例（`hasTable=false`）与缺表同判：不静默放行', () => {
    const src = doc('时机 计数器 偷看：\n    「呀。」\n');
    const diags = errs(src, svc({ counterTable: EMPTY_COUNTER_TABLE }));
    expect(diags.length).toBe(1);
    expect(diags[0]!.code).toBe('timing-counter-unknown');
    expect(diags[0]!.message).toContain('未提供计数器表');
  });

  it('报错时机不影响同文档其它时机（错误隔离以**时机**为界）', () => {
    const src = doc(
      '时机 计数器 查无此计数器：\n    「呀。」\n\n时机 计数器 偷看：\n    「偷看。」\n',
    );
    const r = withTable().transpile(src);
    expect(r.erb).toContain('@M_KOJO_MESSAGE_COUNTER_K12_2');
    expect(r.erb).not.toContain('呀');
  });
});
