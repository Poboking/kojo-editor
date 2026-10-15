/**
 * B4 · 用户函数最小面转译单测。
 *
 * 表层（规范 §7.2 重开的最小形）：
 * ```
 * 函数 问候(次数)：
 *     （函数体，用既有糖语句）
 *     返回 次数
 * ```
 * - `调用 名(实参…)` —— 语句位置调用（产物 `CALL <产物名>(实参…)`）；
 * - 表达式位置调用 = 直接在条件 / 插值里写 `名字(实参)`（经每文件合成表降为产物名）；
 * - `返回 <值>` —— 值函数（产物挂 `#FUNCTION`（数值）/`#FUNCTIONS`（字符串）+ `RETURNF`）；
 * - 裸 `返回` / 无 `返回` —— 过程（产物落 `RETURN`，**不挂** `#FUNCTION`）。
 *
 * 产物函数名走 adapter 的 `userFunction.template`（游戏知识不进转译器）：
 * 本测试用**真 eraTW 表**，断言命名模板确实来自 adapter（换模板 → 产物名随之改变）。
 *
 * 组织：① 定义 + 语句位置调用 → ② 表达式位置调用与返回二态 → ③ 参数传递（ARG）
 *      → ④ 块引用（调用已声明函数块）→ ⑤ 与原生 `@` 块 / 自定指令共存 → ⑥ 命名模板来自 adapter。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

/** 转译服务（注入分野表；目录足量即可） */
const svc = (faceTable: KojoFaceTable = stubFaceTable()) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable });
const t = (src: string) => svc().transpile(src);
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
const warns = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'warning');

/* ============================================================================ */
/* ① 定义 + 语句位置调用                                                          */
/* ============================================================================ */

describe('B4 用户函数 · 定义与语句位置调用', () => {
  it('过程形：`函数 问候(次数)：` → `@M_KOJO_K12_问候(ARG)`；裸 `返回` → `RETURN`，不挂 `#FUNCTION`', () => {
    const { erb, diagnostics } = t('角色: 12\n函数 问候(次数)：\n    「你好。」\n    返回\n');
    expect(erb).toContain('@M_KOJO_K12_问候(ARG)');
    expect(erb).toContain('\tPRINTFORMW 「你好。」');
    expect(erb).toContain('\tRETURN');
    expect(erb).not.toContain('#FUNCTION');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('无 `返回` 也是过程形（不挂 `#FUNCTION`，靠引擎隐式返回）', () => {
    const { erb } = t('角色: 12\n函数 打招呼()：\n    「嗨。」\n');
    expect(erb).toContain('@M_KOJO_K12_打招呼');
    expect(erb).not.toContain('#FUNCTION');
    expect(erb).toContain('\tPRINTFORMW 「嗨。」');
  });

  it('语句位置 `调用 名(实参)` → `CALL <产物名>(实参)`，且**零假告警**（产物名不算"未收录"）', () => {
    const src =
      '角色: 12\n' +
      '函数 问候(次数)：\n    「你好。」\n    返回\n' +
      '时机 初见：\n    调用 问候(3)\n';
    expect(t(src).erb).toContain('CALL M_KOJO_K12_问候(3)');
    expect(warns(src).map((d) => d.code)).toEqual([]);
  });

  it('零实参调用 → `CALL <产物名>()`（与真实语料 `CALL Xxx()` 同形）', () => {
    const src = '角色: 12\n函数 开场()：\n    「开始。」\n    返回\n' + '时机 初见：\n    调用 开场()\n';
    expect(t(src).erb).toContain('CALL M_KOJO_K12_开场()');
  });

  it('非函数体里的 `返回` → `indent-mismatch`（error），不产半成品', () => {
    expect(errs('角色: 12\n时机 初见：\n    返回\n').map((d) => d.code)).toContain('indent-mismatch');
  });
});

/* ============================================================================ */
/* ② 表达式位置调用 + 返回二态                                                    */
/* ============================================================================ */

describe('B4 用户函数 · 表达式位置调用与返回二态', () => {
  it('数值值函数：`返回 <表达式>` → `#FUNCTION` + `RETURNF`；插值 `{名(1)}` → `{…}`', () => {
    const src = '角色: 12\n函数 加倍(份)：\n    返回 份\n' + '时机 初见：\n    「结果是 {加倍(1)}」\n';
    const { erb } = t(src);
    expect(erb).toContain('@M_KOJO_K12_加倍(ARG)');
    expect(erb).toContain('#FUNCTION');
    expect(erb).toContain('\tRETURNF ARG');
    expect(erb).toContain('{M_KOJO_K12_加倍(1)}');
  });

  it('字符串值函数：`返回 "字面量"` → `#FUNCTIONS` + `RETURNF`；插值 `{名()}` → `%…%`', () => {
    const src = '角色: 12\n函数 自称()：\n    返回 "小露"\n' + '时机 初见：\n    「我叫 {自称()}」\n';
    const { erb } = t(src);
    expect(erb).toContain('@M_KOJO_K12_自称');
    expect(erb).toContain('#FUNCTIONS');
    expect(erb).toContain('\tRETURNF "小露"');
    expect(erb).toContain('%M_KOJO_K12_自称()%');
  });

  it('二态不混：同文件里过程函数与值函数共存，各自产物互不串味', () => {
    const src =
      '角色: 12\n' +
      '函数 值函()：\n    返回 1\n' +
      '函数 过程()：\n    「做事。」\n    返回\n';
    const { erb } = t(src);
    // 值函数带 `#FUNCTION`；过程不带（用切片围住各自函数体来判）
    const valueAt = erb.indexOf('@M_KOJO_K12_值函');
    const procAt = erb.indexOf('@M_KOJO_K12_过程');
    expect(erb.slice(valueAt, procAt)).toContain('#FUNCTION');
    expect(erb.slice(procAt)).not.toContain('#FUNCTION');
    expect(erb).toContain('\tRETURNF 1');
  });
});

/* ============================================================================ */
/* ③ 参数传递（ARG 约定）                                                         */
/* ============================================================================ */

describe('B4 用户函数 · 参数传递（ARG 位置约定）', () => {
  it('多形参 → `ARG` / `ARG:1` / `ARG:2`（第 k 个形参 0 基）', () => {
    const { erb } = t('角色: 12\n函数 三参(甲, 乙, 丙)：\n    返回 丙\n');
    expect(erb).toContain('@M_KOJO_K12_三参(ARG,ARG:1,ARG:2)');
    expect(erb).toContain('\tRETURNF ARG:2');
  });

  it('形参名在函数体内按普通变量使用（别名注入：读写皆落 `ARG`）', () => {
    const { erb } = t('角色: 12\n函数 累加(份)：\n    份 = 份 + 1\n    返回 份\n');
    expect(erb).toContain('\tARG = ARG + 1');
    expect(erb).toContain('\tRETURNF ARG');
  });

  it('实参原样透传（含表达式的实参经同一条降糖管线）', () => {
    const src =
      '角色: 12\n' +
      '函数 累加(份)：\n    返回 份\n' +
      '时机 初见：\n    调用 累加(1 + 2)\n';
    expect(t(src).erb).toContain('CALL M_KOJO_K12_累加(1 + 2)');
  });
});

/* ============================================================================ */
/* ③B 形参默认值（`形参 = 整数`）——引擎声明位默认值的可写形                        */
/* ============================================================================ */

describe('B4 用户函数 · 形参默认值', () => {
  it('单个形参带默认值 → `ARG = 1`（等号两侧各一空格，值为原文逐字透传）', () => {
    const { erb, diagnostics } = t('角色: 12\n函数 问候(次数 = 1)：\n    返回 次数\n');
    expect(erb).toContain('@M_KOJO_K12_问候(ARG = 1)');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('混合形：只给前几个形参默认值，后几个照旧裸写（对齐语料 `(ARG = 0, ARG:1, ARG:2)`）', () => {
    const src = '角色: 12\n函数 混合(次数 = 1, 名字)：\n    返回 名字\n';
    expect(t(src).erb).toContain('@M_KOJO_K12_混合(ARG = 1,ARG:1)');
  });

  it('负值默认值原样透传（`ARG = -1`，语料实测 `@CIRNO_FIND_AROUND(ARG = -1)`）', () => {
    const src = '角色: 12\n函数 找周围(范围 = -1)：\n    返回 范围\n';
    expect(t(src).erb).toContain('@M_KOJO_K12_找周围(ARG = -1)');
  });

  it('等号两侧空白自由（`次数=1` / `次数  =  1` 与 `次数 = 1` 等价）', () => {
    expect(t('角色: 12\n函数 甲(次数=1)：\n    返回 次数\n').erb).toContain('@M_KOJO_K12_甲(ARG = 1)');
    expect(t('角色: 12\n函数 乙(次数  =  1)：\n    返回 次数\n').erb).toContain('@M_KOJO_K12_乙(ARG = 1)');
  });

  it('默认值不进别名表：形参名仍映射到 `ARG`（`次数 = 次数 + 1` 落 `ARG = ARG + 1`）', () => {
    const src = '角色: 12\n函数 累加(次数 = 1)：\n    次数 = 次数 + 1\n    返回 次数\n';
    expect(t(src).erb).toContain('\tARG = ARG + 1');
  });

  it('非整数默认值（字符串 / 变量 / 表达式）→ `alias-unknown-target`（error），不产半成品默认值', () => {
    for (const bad of ['"x"', '某变量', '1 + 2']) {
      const res = t(`角色: 12\n函数 坏(次数 = ${bad})：\n    返回 次数\n`);
      expect(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toContain('alias-unknown-target');
      expect(res.erb).not.toContain('= "x"');
      expect(res.erb).not.toContain(`= ${bad}`);
    }
  });

  it('无默认值时产物逐字节不变（`defaults` 缺省，既有形参口径零改动）', () => {
    expect(t('角色: 12\n函数 三参(甲, 乙, 丙)：\n    返回 丙\n').erb).toContain('@M_KOJO_K12_三参(ARG,ARG:1,ARG:2)');
  });
});

/* ============================================================================ */
/* ④ 块引用形态（调用处引用一个已声明的函数块）                                    */
/* ============================================================================ */

describe('B4 用户函数 · 块引用（函数体里调用已声明函数块）', () => {
  it('函数体里 `调用` 另一个已声明函数 → `CALL` 其产物名', () => {
    const src =
      '角色: 12\n' +
      '函数 甲()：\n    「甲」\n    调用 乙()\n    返回\n' +
      '函数 乙()：\n    「乙」\n    返回\n';
    const { erb, diagnostics } = t(src);
    expect(erb).toContain('@M_KOJO_K12_甲');
    expect(erb).toContain('@M_KOJO_K12_乙');
    expect(erb).toContain('CALL M_KOJO_K12_乙()');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('前向引用：调用**后面**才声明（先扫全文件再降糖，声明顺序无关）', () => {
    const src =
      '角色: 12\n' +
      '函数 前()：\n    调用 后()\n    返回\n' +
      '函数 后()：\n    「后面声明的」\n    返回\n';
    expect(t(src).erb).toContain('CALL M_KOJO_K12_后()');
  });

  it('表达式位置也能量引用另一函数块（条件里 `名()` 降为产物名）', () => {
    const src =
      '角色: 12\n' +
      '函数 判定(值)：\n    返回 值\n' +
      '函数 用判定()：\n    如果 判定(1)：\n        「真」\n    返回\n';
    const { erb } = t(src);
    expect(erb).toContain('IF M_KOJO_K12_判定(1)');
  });
});

/* ============================================================================ */
/* ⑤ 与既有面共存（不打架）                                                       */
/* ============================================================================ */

describe('B4 用户函数 · 与原生 `@` 块 / 自定指令共存', () => {
  it('原生 `@` 直通块与用户函数块并存：各走各的，原生块原样透传', () => {
    const src =
      '角色: 12\n' +
      '函数 问候()：\n    「糖」\n    返回\n' +
      '@MY_RAW_TOOL\n' +
      '#FUNCTION\n' +
      '$MY_LABEL\n' +
      'RETURN 1\n' +
      '#FUNCTIONEND\n';
    const { erb, diagnostics } = t(src);
    expect(erb).toContain('@M_KOJO_K12_问候');
    expect(erb).toContain('@MY_RAW_TOOL');
    expect(erb).toContain('$MY_LABEL');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('自定指令块与用户函数块并存：命名空间各归各（COM_ 族 vs 用户模板）', () => {
    const src = '角色: 12\n自定指令 赛钱：\n    「a」\n' + '函数 问候()：\n    「b」\n    返回\n';
    const { erb } = t(src);
    expect(erb).toContain('@KOJO_COM_K12_270');
    expect(erb).toContain('@M_KOJO_K12_问候');
    // 用户函数不占用自定指令的 270 段（片名不同即可证明不冲突）
    expect(erb).toContain('RESULTS = 赛钱');
  });

  it('用户函数与系统函数调用同处一表达式：各按各的表降糖，互不吞并', () => {
    const src =
      '角色: 12\n' +
      '函数 取标记(位)：\n    返回 位\n' +
      '时机 初见：\n    如果 取标记(1) 且 获取标记(0, 3)：\n        「都认」\n';
    const { erb } = t(src);
    expect(erb).toContain('IF M_KOJO_K12_取标记(1) && GETBIT(0, 3)');
  });
});

/* ============================================================================ */
/* ⑥ 命名模板来自 adapter（kojo-sugar 零游戏名词）                                */
/* ============================================================================ */

describe('B4 用户函数 · 命名模板来自 adapter', () => {
  it('换 adapter 模板 → 产物名随之改变（前缀零硬编码在转译器里）', () => {
    const custom: KojoFaceTable = { ...stubFaceTable(), userFunction: { template: 'ZX_{name}_K{n}' } };
    const erb = svc(custom).transpile('角色: 12\n函数 问候()：\n    「x」\n    返回\n').erb;
    expect(erb).toContain('@ZX_问候_K12');
    expect(erb).not.toContain('M_KOJO_K12_问候');
  });

  it('未声明模板 → `face-table-missing`（error）fail-closed，不产半成品', () => {
    const { userFunction: _omit, ...noTpl } = stubFaceTable();
    const res = svc(noTpl).transpile('角色: 12\n函数 问候()：\n    「x」\n    返回\n');
    expect(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toContain('face-table-missing');
    expect(res.erb).not.toContain('@M_KOJO_K12_问候');
  });
});

/* ============================================================================ */
/* ⑦ 自机色（B1）在函数体内同样吃 adapter 兜底                                   */
/* ============================================================================ */

describe('B4 用户函数 · 自机色兜底不漏函数体', () => {
  it('未声明 `自机色:` → 函数体内 `你：` 取 adapter 缺省自机色（零诊断 + 非 D 打印）', () => {
    const res = svc().transpile('角色: 12\n函数 问候()：\n    你：我来了\n    返回\n');
    expect(res.diagnostics).toEqual([]);
    expect(res.erb).toContain('SETCOLOR 0x4682B4');
    expect(res.erb).toContain('PRINTFORMW 我来了');
  });
});
