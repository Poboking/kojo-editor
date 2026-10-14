/**
 * E16 批 · 拆掉条件/块头的两处标识符解析墙（方案 §3.0 R4 / R5–R7，缺口 G2 / G3）。
 *
 * **装配不依赖游戏盘**：字典用 `support.ts` 的桩（`stubDict`）。裸引擎全局的判定
 * 本来就不走字典（判据见 `engine-globals.ts` 头注），故"无字典"也是本批的一条正路径
 * ——另有一组用例故意**不注入字典**，钉住"没打开项目时 `SELECTCOM` 照样可写"。
 *
 * 每条正向断言都配**负自证**（改一个字符 / 换成全角标点必须被抓出），防止断言空转。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { ENGINE_GLOBAL_IDENTIFIERS, resolveEngineGlobal } from '../src/engine-globals';
import { lowerSystemFunctions } from '../src/system-functions';
import { stubDict, stubFaceTable, stubInstructionTable } from './support';

/* ================================ 装配夹具 ================================ */

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
/** 无字典装配（= 未打开项目 / adapter 缺席时的转译路径） */
const svcNoDict = () => createSugarTranspileService({ faceTable: stubFaceTable() });

/** 文档骨架：条件落在 `时机 指令 310：` 的信封体内 */
const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;
/** 一条条件糖（`如果 X：` + 一行台词） */
const cond = (expr: string): string => doc(`    如果 ${expr}：\n        「涩涩的话」\n`);

const errorsOf = (src: string): SugarDiagnostic[] =>
  svc().transpile(src).diagnostics.filter((d) => d.severity === 'error');
const messagesOf = (src: string): string[] => errorsOf(src).map((d) => d.message);
const productOf = (src: string): string => svc().transpile(src).erb;
/** 产物里第一条以 `prefix` 开头的行（已剥缩进；无该行 → 空串） */
const erbLine = (erb: string, prefix: string): string =>
  erb
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(prefix)) ?? '';
/**
 * 条件所在行：信封骨架自己就有一行 `IF LOCAL`（糖的段壳），故取**第一条不是它的
 * `IF` 行**——否则断言会盯在骨架上、条件写错也照样绿（空转）。
 */
const condLine = (erb: string): string =>
  erb
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('IF ') && l !== 'IF LOCAL') ?? '';

/* ============================================================================ */
/* A. 全角拉丁字母进标识符字符集（G3 / R4）                                       */
/* ============================================================================ */

describe('E16-A 全角拉丁字母 · NOWEX:Ｃ絶頂 不再被切断', () => {
  it('正向：`如果 NOWEX:Ｃ絶頂 == 3：` 零 error，且产物逐字正确（R4 的"只报不纠"消失）', () => {
    const src = cond('NOWEX:Ｃ絶頂 == 3');
    expect(errorsOf(src)).toEqual([]);
    expect(erbLine(productOf(src), 'IF NOWEX')).toBe('IF NOWEX:Ｃ絶頂 == 3');
  });

  it('正向：全角小写 `ｃ` 同样连通（Ｕ+ＦＦ４１–ＦＦ５Ａ 一支）', () => {
    const src = cond('NOWEX:ｃ絶頂 == 3');
    expect(errorsOf(src)).toEqual([]);
    expect(erbLine(productOf(src), 'IF NOWEX')).toBe('IF NOWEX:ｃ絶頂 == 3');
  });

  it('负自证①：`如果 Ｃ絶頂 == 3：`（无族头）仍必须报错，且报的是**整个** `Ｃ絶頂` 而非被切断的后半截', () => {
    const msgs = messagesOf(cond('Ｃ絶頂 == 3'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('Ｃ絶頂');
    // 分词已连通的反证：错误里不许只出现后半截「絶頂」
    expect(msgs[0]).not.toMatch(/「絶頂」/);
  });

  it('负自证②：全角标点**不是**标识符字符——`如果 Ｃ，絶頂：` 仍被切成两个词各自报错（规范 §8 的判据不被吞）', () => {
    const msgs = messagesOf(cond('Ｃ，絶頂'));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('「Ｃ」');
    expect(msgs[1]).toContain('「絶頂」');
  });

  it('负自证③：块头终止符 `：` 仍是标点不是标识符字符——产物行里不得出现全角冒号', () => {
    const line = erbLine(productOf(cond('NOWEX:Ｃ絶頂 == 3')), 'IF NOWEX');
    expect(line).toBe('IF NOWEX:Ｃ絶頂 == 3');
    expect(line).not.toContain('：');
    expect(line).not.toContain('，');
  });

  it('负自证④：`isIdentStart` 也收全角字母——`:Ｃ…` 具名索引整条直通（不收则 `NOWEX` 落回裸标识符、`Ｃ絶頂` 另起一词，两条 error）', () => {
    // `NOWEX:Ｃ絶頂` 的索引段以全角字母开头；若 `isIdentStart` 不收全角字母，
    // `:` 索引链在第一字符就断 ⇒ `NOWEX` 落回裸标识符解析、`絶頂` 另起一词（实测 2 条 error）。
    expect(errorsOf(cond('NOWEX:Ｃ絶頂'))).toEqual([]);
    expect(condLine(productOf(cond('NOWEX:Ｃ絶頂')))).toBe('IF NOWEX:Ｃ絶頂');
  });

  it('副本一致性：`system-functions.ts` 的词边界与表达式扫描同口径（全角字母黏着的别名不误替换）', () => {
    expect(lowerSystemFunctions('首次(SELECTCOM)')).toBe('FIRSTTIME(SELECTCOM)');
    // `Ｃ首次` 是一个标识符（全角字母算标识符字符），不得从中间截出别名
    expect(lowerSystemFunctions('Ｃ首次(SELECTCOM)')).toBe('Ｃ首次(SELECTCOM)');
    // 全角标点不算标识符字符 ⇒ `，` 后面的 `首次(` 仍是独立词，照常替换
    expect(lowerSystemFunctions('，首次(SELECTCOM)')).toBe('，FIRSTTIME(SELECTCOM)');
  });
});

/* ============================================================================ */
/* B. 裸引擎全局白名单（G2 / R5–R7）                                             */
/* ============================================================================ */

describe('E16-B 裸引擎全局 · 三条目标写法', () => {
  it('`如果 首次(SELECTCOM)：` 零 error 且产物 `IF FIRSTTIME(SELECTCOM)`（R5）', () => {
    const src = cond('首次(SELECTCOM)');
    expect(errorsOf(src)).toEqual([]);
    expect(erbLine(productOf(src), 'IF FIRSTTIME')).toBe('IF FIRSTTIME(SELECTCOM)');
  });

  it('`如果 SELECTCOM == 20：` 零 error 且产物逐字 `IF SELECTCOM == 20`（R7 前半）', () => {
    const src = cond('SELECTCOM == 20');
    expect(errorsOf(src)).toEqual([]);
    expect(erbLine(productOf(src), 'IF SELECTCOM')).toBe('IF SELECTCOM == 20');
  });

  it('`当 SELECTCOM： 是 20：` 零 error，产物 `SELECTCASE SELECTCOM` + `CASE 20`', () => {
    const { erb, diagnostics } = svc().transpile(
      doc('    当 SELECTCOM：\n        是 20：\n            「涩涩的话」\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(erbLine(erb, 'SELECTCASE')).toBe('SELECTCASE SELECTCOM');
    expect(erbLine(erb, 'CASE')).toBe('CASE 20');
  });

  it('退路 `别名 当前指令 = SELECTCOM` 也通了（R6：别名声明的目标自己能解析）', () => {
    const src = `角色: 12\n别名 当前指令 = SELECTCOM\n时机 指令 310：\n    如果 当前指令 == 20：\n        「涩涩的话」\n`;
    expect(errorsOf(src)).toEqual([]);
    expect(condLine(productOf(src))).toBe('IF SELECTCOM == 20');
  });

  it('真实语料形态的组合：`首次(SELECTCOM) && PREVCOM == SELECTCOM`（ADD_ACTIVE_TOUCH.ERB:681 同形）', () => {
    const src = cond('首次(SELECTCOM) && PREVCOM == SELECTCOM');
    expect(errorsOf(src)).toEqual([]);
    expect(condLine(productOf(src))).toBe('IF FIRSTTIME(SELECTCOM) && PREVCOM == SELECTCOM');
  });

  it('白名单成员**逐个**可解析并原样输出（新增成员即被本条覆盖）', () => {
    expect(ENGINE_GLOBAL_IDENTIFIERS.length).toBeGreaterThan(0);
    for (const name of ENGINE_GLOBAL_IDENTIFIERS) {
      const src = cond(`${name} == 1`);
      expect(errorsOf(src), `${name} 应零 error，实际 ${messagesOf(src).join(' / ')}`).toEqual([]);
      expect(condLine(productOf(src))).toBe(`IF ${name} == 1`);
    }
  });

  it('无字典装配（未打开项目）同样可写——白名单不寄生在 adapter 字典里', () => {
    const { erb, diagnostics } = svcNoDict().transpile(cond('SELECTCOM == 20'));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(erbLine(erb, 'IF SELECTCOM')).toBe('IF SELECTCOM == 20');
  });

  it('同一条条件里属性/代词路径未受影响：`她的恋慕 >= 1 && PLAYER == 0 && TARGET == 3`', () => {
    const src = cond('她的恋慕 >= 1 && PLAYER == 0 && TARGET == 3');
    expect(errorsOf(src)).toEqual([]);
    expect(condLine(productOf(src))).toBe('IF TALENT:TARGET:恋慕 >= 1 && PLAYER == 0 && TARGET == 3');
  });
});

describe('E16-B 负自证 · 白名单没有把别的墙一起抹平', () => {
  it('改一个字符必须被抓出：`SELECTCOMX` / 小写 `selectcom` 一律 error（精确大写匹配）', () => {
    for (const bad of ['SELECTCOMX', 'selectcom', 'SELECT_COm', 'PREVCOM2']) {
      const msgs = messagesOf(cond(`${bad} == 3`));
      expect(msgs, `${bad} 不该被放行`).toHaveLength(1);
      expect(msgs[0]).toContain(bad);
      expect(resolveEngineGlobal(bad)).toBeUndefined();
    }
  });

  it('`LOCAL` / `LOCALS` / `LOCALSS` **不收**（段块糖 P-1 的信封槽），今天的报错保持原样', () => {
    for (const name of ['LOCAL', 'LOCALS', 'LOCALSS']) {
      expect(resolveEngineGlobal(name)).toBeUndefined();
      const msgs = messagesOf(cond(`${name} == 3`));
      expect(msgs, `${name} 必须仍然报错`).toHaveLength(1);
      expect(msgs[0]).toContain(`「${name}」`);
    }
    // 产物侧同样不静默：报错的那条条件保留原文（不加工）
    expect(condLine(productOf(cond('LOCAL == 3')))).toBe('IF LOCAL == 3');
  });

  it('单字母草稿数组 `A`/`Z` 与项目级全局（`#DIM`/`GLOBAL` 侧）一律不放行', () => {
    for (const name of ['A', 'Z', 'S', 'SCENE', 'ROLE', 'MAIN_MAP', 'CUSTOM_COM', 'O_DATA']) {
      expect(resolveEngineGlobal(name), `${name} 不属引擎全局`).toBeUndefined();
      expect(messagesOf(cond(`${name} == 1`)), `${name} 必须报错`).toHaveLength(1);
    }
  });

  it('P-5 正断言：`当 SELECTCOM： 是 接吻：` 查指令名表 → `SELECTCASE SELECTCOM` + `CASE 20`，零 error', () => {
    const TABLE = stubInstructionTable();
    const svcP5 = createSugarTranspileService({
      dictionary: stubDict,
      faceTable: stubFaceTable(),
      instructionTable: TABLE,
    });
    // 断言的编号来自**真 CSV 快照经真解析器**建的表，不是硬编码 20 蒙过去
    expect(TABLE.lookupByName('接吻')).toBe(20);
    const { erb, diagnostics } = svcP5.transpile(
      doc('    当 SELECTCOM：\n        是 接吻：\n            「涩涩的话」\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(erbLine(erb, 'SELECTCASE')).toBe('SELECTCASE SELECTCOM');
    expect(erbLine(erb, 'CASE')).toBe(`CASE ${TABLE.lookupByName('接吻')}`);
    expect(erbLine(erb, 'CASE')).toBe('CASE 20');
  });

  it('P-5 正断言（第二组目标写法）：`当 TCVAR:20： 是 给对方口交：` → `SELECTCASE TCVAR:20` + `CASE 2`，零 error', () => {
    const TABLE = stubInstructionTable();
    const svcP5 = createSugarTranspileService({
      dictionary: stubDict,
      faceTable: stubFaceTable(),
      instructionTable: TABLE,
    });
    expect(TABLE.lookupByName('给对方口交')).toBe(2);
    const { erb, diagnostics } = svcP5.transpile(
      doc('    当 TCVAR:20：\n        是 给对方口交：\n            「涩涩的话」\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(erbLine(erb, 'SELECTCASE')).toBe('SELECTCASE TCVAR:20');
    expect(erbLine(erb, 'CASE')).toBe('CASE 2');
  });

  it('P-5 负自证：表外名 `是 接吻不存在：` 必须报错，产物**不被**换成编号（复用 timing-instruction-unknown，不新增码）', () => {
    const TABLE = stubInstructionTable();
    expect(TABLE.lookupByName('接吻不存在')).toBeUndefined();
    const svcP5 = createSugarTranspileService({
      dictionary: stubDict,
      faceTable: stubFaceTable(),
      instructionTable: TABLE,
    });
    const { erb, diagnostics } = svcP5.transpile(
      doc('    当 SELECTCOM：\n        是 接吻不存在：\n            「涩涩的话」\n'),
    );
    const errs = diagnostics.filter((d) => d.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe('timing-instruction-unknown');
    expect(errs[0]!.message).toContain('接吻不存在');
    expect(erbLine(erb, 'SELECTCASE')).toBe('SELECTCASE SELECTCOM');
    expect(erbLine(erb, 'CASE')).toBe('CASE 接吻不存在'); // 原文保留，绝不猜编号
  });

  it('P-5 无表装配（未打开项目）：`是 接吻：` 仍必须报错、产物原样——fail-closed 不依赖有没有表', () => {
    const { erb, diagnostics } = svc().transpile(
      doc('    当 SELECTCOM：\n        是 接吻：\n            「涩涩的话」\n'),
    );
    const errs = diagnostics.filter((d) => d.severity === 'error');
    expect(errs).toHaveLength(1); // 主语 SELECTCOM 已通，只报值侧一条
    expect(errs.map((d) => d.code)).toContain('timing-instruction-unknown');
    expect(erbLine(erb, 'SELECTCASE')).toBe('SELECTCASE SELECTCOM');
    expect(erbLine(erb, 'CASE')).toBe('CASE 接吻'); // 未被换成编号（无表 = 查不到）
  });

  it('无字典装配下属性路径照旧报错——白名单没把字典缺口一起放行', () => {
    const { diagnostics } = svcNoDict().transpile(cond('她的恋慕 >= 1'));
    expect(diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join(' ')).toContain('恋慕');
  });

  it('白名单自身守口径：全大写引擎词、唯一、不含单字母 / 不含 LOCAL 族 / 不含变量族头', () => {
    expect(new Set(ENGINE_GLOBAL_IDENTIFIERS).size).toBe(ENGINE_GLOBAL_IDENTIFIERS.length);
    for (const name of ENGINE_GLOBAL_IDENTIFIERS) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]{2,}$/); // ≥3 字符 ⇒ 单字母草稿数组进不来
      expect(name).not.toMatch(/^LOCAL/);
    }
    // 族头走字典（`resolve`），不在本表——否则两处口径会抢
    for (const family of ['CFLAG', 'TALENT', 'NOWEX', 'TCVAR', 'FLAG', 'TFLAG']) {
      expect(resolveEngineGlobal(family), `${family} 是变量族头，不该进白名单`).toBeUndefined();
    }
  });
});
