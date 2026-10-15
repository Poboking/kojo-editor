/**
 * 4 号 · 自建函数命名前缀（`函数前缀: <模板>`）转译单测（B4-fp）。
 *
 * 表层（additive 到 B4 用户函数最小面）：
 * ```
 * 角色: 11
 * 函数前缀: K{n}_
 * 函数 问候()：
 *     （函数体…）
 *     返回
 * ```
 * - `{n}` = 角色号（`角色:`）；`{name}` = 作者写的函数名原文；
 * - 未含 `{name}` 的模板按**前缀**处理 → 渲染后末尾补函数名（真语料 `@K11_ZE` /
 *   `@Music_INSTRUMENT` / `@CHECK_COLLECTION_MARISA` 皆此形态）；
 * - **未声明** `函数前缀:` → 逐字节走 adapter 的 `userFunction.template`（不退化）；
 * - 非法模板（未知占位符 / 空模板）→ 既有码 `face-table-missing`（error）+ fail-closed。
 *
 * 组织：A 前缀语义 ／ B 与 adapter 模板的关系 ／ C 非法模板 fail-closed
 *      ／ D B4 六组在新前缀下复测 ／ E 真语料命名 & 冲突检测 ／ F 零假告警。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = (faceTable: KojoFaceTable = stubFaceTable()) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable });
const t = (src: string) => svc().transpile(src);
const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');
const warns = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'warning');

/* ============================================================================ */
/* A 前缀语义（`函数前缀:` 覆盖命名）                                              */
/* ============================================================================ */

describe('B4-fp 前缀语义', () => {
  it('`函数前缀: K{n}_` + `函数 问候()` → `@K11_问候`（前缀 + 名）', () => {
    const { erb, diagnostics } = t('角色: 11\n函数前缀: K{n}_\n函数 问候()：\n    「你好。」\n    返回\n');
    expect(erb).toContain('@K11_问候');
    expect(erb).not.toContain('@M_KOJO_K11_问候');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('前缀不含 `{n}`（纯名前缀）：`函数前缀: Music_` + `函数 INSTRUMENT()` → `@Music_INSTRUMENT`', () => {
    const { erb } = t('角色: 11\n函数前缀: Music_\n函数 INSTRUMENT()：\n    「♪」\n    返回\n');
    expect(erb).toContain('@Music_INSTRUMENT');
  });

  it('显式 `{name}` 占位：`函数前缀: {name}@K{n}` → `@问候@K11`（名字放任意处）', () => {
    const { erb } = t('角色: 11\n函数前缀: {name}@K{n}\n函数 问候()：\n    「x」\n    返回\n');
    expect(erb).toContain('@问候@K11');
  });

  it('前缀渲染按**角色号**逐文件求值（换 `角色:` → 产物名随之变）', () => {
    const { erb } = t('角色: 42\n函数前缀: K{n}_\n函数 打招呼()：\n    「x」\n    返回\n');
    expect(erb).toContain('@K42_打招呼');
    expect(erb).not.toContain('K11_打招呼');
  });

  // 文件头选项的英文别名与中文主形**同一产物**（发版样例里只能写一次头部，
  // 故中英等价性在这里钉死；`function-prefix` 与 `char:` / `family:` 同类）。
  it('英文别名 `function-prefix:` 与 `函数前缀:` 同形（产物逐字节相同）', () => {
    const zh = t('角色: 11\n函数前缀: K{n}_\n函数 问候()：\n    「你好。」\n    返回\n');
    const en = t('角色: 11\nfunction-prefix: K{n}_\n函数 问候()：\n    「你好。」\n    返回\n');
    expect(en.erb).toBe(zh.erb);
    expect(zh.diagnostics).toEqual([]);
  });
});

/* ============================================================================ */
/* B 与 adapter 模板的关系（未声明 = 不退化；声明 = 覆盖）                        */
/* ============================================================================ */

describe('B4-fp 与 adapter 命名模板的关系', () => {
  it('未声明 `函数前缀:` → 逐字节走 adapter 模板（`@M_KOJO_K12_问候(ARG)`）', () => {
    const { erb, diagnostics } = t('角色: 12\n函数 问候()：\n    「你好。」\n    返回\n');
    expect(erb).toContain('@M_KOJO_K12_问候');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('声明 `函数前缀:` → **覆盖** adapter 模板（不再出现 `M_KOJO_` 段）', () => {
    const { erb } = t('角色: 12\n函数前缀: K{n}_\n函数 问候()：\n    「你好。」\n    返回\n');
    expect(erb).toContain('@K12_问候');
    expect(erb).not.toContain('M_KOJO_K12_问候');
  });

  it('零游戏名词：换一个**自定义** adapter 模板，未声明前缀时仍跟随它（前缀零硬编码在转译器）', () => {
    const custom: KojoFaceTable = { ...stubFaceTable(), userFunction: { template: 'ZX_{name}_K{n}' } };
    const erb = svc(custom).transpile('角色: 12\n函数 问候()：\n    「x」\n    返回\n').erb;
    expect(erb).toContain('@ZX_问候_K12');
  });
});

/* ============================================================================ */
/* C 非法模板 → fail-closed（复用既有码，不新增）                                  */
/* ============================================================================ */

describe('B4-fp 非法前缀模板 fail-closed', () => {
  it('未知占位符 `{i}` → `face-table-missing`(error)，且**不产**该函数块', () => {
    const res = t('角色: 11\n函数前缀: K{i}_\n函数 问候()：\n    「x」\n    返回\n');
    expect(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toContain(
      'face-table-missing',
    );
    expect(res.erb).not.toContain('@K{i}_问候');
    expect(res.erb).not.toContain('@K11_问候');
  });

  it('空模板 `函数前缀:`（空值）→ `face-table-missing`(error)，不产半成品', () => {
    const res = t('角色: 11\n函数前缀:\n函数 问候()：\n    「x」\n    返回\n');
    expect(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toContain(
      'face-table-missing',
    );
  });

  it('非法前缀时**报的是前缀原因**（消息含 `函数前缀:`），不是含糊的适配器缺表', () => {
    const msgs = errs('角色: 11\n函数前缀: {bad}\n函数 问候()：\n    「x」\n    返回\n').map((d) => d.message);
    expect(msgs.some((m) => m.includes('函数前缀'))).toBe(true);
  });
});

/* ============================================================================ */
/* D B4 六组在新前缀下复测（既有精神不退化）                                       */
/* ============================================================================ */

describe('B4-fp · ①定义 + 语句位置调用（新前缀）', () => {
  it('过程形：`@K11_问候(ARG)` + 裸 `返回` → `RETURN`，不挂 `#FUNCTION`', () => {
    const { erb, diagnostics } = t(
      '角色: 11\n函数前缀: K{n}_\n函数 问候(次数)：\n    「你好。」\n    返回\n',
    );
    expect(erb).toContain('@K11_问候(ARG)');
    expect(erb).toContain('\tPRINTFORMW 「你好。」');
    expect(erb).toContain('\tRETURN');
    expect(erb).not.toContain('#FUNCTION');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('语句位置 `调用 名(实参)` → `CALL K11_问候(3)`，且**零假告警**', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 问候(次数)：\n    「你好。」\n    返回\n' +
      '时机 初见：\n    调用 问候(3)\n';
    expect(t(src).erb).toContain('CALL K11_问候(3)');
    expect(warns(src).map((d) => d.code)).toEqual([]);
  });
});

describe('B4-fp · ②表达式位置调用与返回二态（新前缀）', () => {
  it('数值值函数 → `#FUNCTION` + `RETURNF`；插值 `{名(1)}` → `{K11_加倍(1)}`', () => {
    const src = '角色: 11\n函数前缀: K{n}_\n函数 加倍(份)：\n    返回 份\n' + '时机 初见：\n    「结果是 {加倍(1)}」\n';
    const { erb } = t(src);
    expect(erb).toContain('@K11_加倍(ARG)');
    expect(erb).toContain('#FUNCTION');
    expect(erb).toContain('{K11_加倍(1)}');
  });

  it('字符串值函数 → `#FUNCTIONS`；插值 `{名()}` → `%K11_自称()%`', () => {
    const src = '角色: 11\n函数前缀: K{n}_\n函数 自称()：\n    返回 "小露"\n' + '时机 初见：\n    「我叫 {自称()}」\n';
    const { erb } = t(src);
    expect(erb).toContain('@K11_自称');
    expect(erb).toContain('#FUNCTIONS');
    expect(erb).toContain('%K11_自称()%');
  });
});

describe('B4-fp · ③参数传递（ARG 位置约定，新前缀）', () => {
  it('多形参 → `@K11_三参(ARG,ARG:1,ARG:2)`（第 k 个形参 0 基）', () => {
    const { erb } = t('角色: 11\n函数前缀: K{n}_\n函数 三参(甲, 乙, 丙)：\n    返回 丙\n');
    expect(erb).toContain('@K11_三参(ARG,ARG:1,ARG:2)');
    expect(erb).toContain('\tRETURNF ARG:2');
  });

  it('形参名在函数体内按普通变量使用（别名注入：读写皆落 `ARG`）', () => {
    const { erb } = t('角色: 11\n函数前缀: K{n}_\n函数 累加(份)：\n    份 = 份 + 1\n    返回 份\n');
    expect(erb).toContain('\tARG = ARG + 1');
    expect(erb).toContain('\tRETURNF ARG');
  });
});

describe('B4-fp · ④块引用 / 前向引用 / 条件内调用（新前缀）', () => {
  it('前向引用：调用**后面**才声明（声明顺序无关）', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 前()：\n    调用 后()\n    返回\n' +
      '函数 后()：\n    「后面声明的」\n    返回\n';
    expect(t(src).erb).toContain('CALL K11_后()');
  });

  it('条件里 `名()` 降为产物名：`IF K11_判定(1)`', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 判定(值)：\n    返回 值\n' +
      '函数 用判定()：\n    如果 判定(1)：\n        「真」\n    返回\n';
    expect(t(src).erb).toContain('IF K11_判定(1)');
  });
});

describe('B4-fp · ⑤与原生 `@` 块 / 自定指令共存（新前缀）', () => {
  it('原生 `@` 直通块与用户函数块并存：原生块原样透传', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 问候()：\n    「糖」\n    返回\n' +
      '@MY_RAW_TOOL\n#FUNCTION\nRETURN 1\n#FUNCTIONEND\n';
    const { erb, diagnostics } = t(src);
    expect(erb).toContain('@K11_问候');
    expect(erb).toContain('@MY_RAW_TOOL');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('自定指令块与用户函数块并存：命名空间各归各（COM 族 vs 用户前缀）', () => {
    const src = '角色: 11\n函数前缀: K{n}_\n自定指令 赛钱：\n    「a」\n' + '函数 问候()：\n    「b」\n    返回\n';
    const { erb } = t(src);
    expect(erb).toContain('@KOJO_COM_K11_270');
    expect(erb).toContain('@K11_问候');
  });
});

describe('B4-fp · ⑥自机色（B1）在函数体内不漏（新前缀）', () => {
  it('未声明 `自机色:` → 函数体内 `你：` 取 adapter 缺省自机色（零诊断 + 非 D 打印）', () => {
    const res = t('角色: 11\n函数前缀: K{n}_\n函数 问候()：\n    你：我来了\n    返回\n');
    expect(res.diagnostics).toEqual([]);
    expect(res.erb).toContain('SETCOLOR 0x4682B4');
    expect(res.erb).toContain('PRINTFORMW 我来了');
  });
});

/* ============================================================================ */
/* E 真语料命名 & 冲突检测                                                        */
/* ============================================================================ */

describe('B4-fp 真语料私有命名形态', () => {
  it('混合大小写名（真语料 `@K11_ZE` / `@K11_ISNAKED`）逐字保留', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 ZE()：\n    「x」\n    返回\n' +
      '函数 ISNAKED()：\n    「y」\n    返回\n';
    const { erb } = t(src);
    expect(erb).toContain('@K11_ZE');
    expect(erb).toContain('@K11_ISNAKED');
  });

  it('`@CHECK_COLLECTION_MARISA` 形态：下划线前缀 + 名，逐字复现', () => {
    const { erb } = t('角色: 11\n函数前缀: CHECK_COLLECTION_\n函数 MARISA(位)：\n    返回 位\n');
    expect(erb).toContain('@CHECK_COLLECTION_MARISA(ARG)');
  });

  it('前缀与既有原生 `@K11_ZE` 块**撞车** → `function-name-duplicate`（error），不静默', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 ZE()：\n    「糖」\n    返回\n' +
      '@K11_ZE\nPRINTFORML 原生\nRETURN 1\n';
    expect(errs(src).map((d) => d.code)).toContain('function-name-duplicate');
  });
});

/* ============================================================================ */
/* F 零假告警 / 逐字不退化                                                        */
/* ============================================================================ */

describe('B4-fp 零假告警', () => {
  it('合法前缀文档：无警告（产物名不被当成"未收录的中文函数名"）', () => {
    const src =
      '角色: 11\n函数前缀: K{n}_\n' +
      '函数 问候()：\n    「你好。」\n    返回\n' +
      '时机 初见：\n    调用 问候()\n    如果 问候()：\n        「x」\n';
    expect(warns(src).map((d) => d.code)).toEqual([]);
  });

  it('`函数前缀:` 只影响本文件头声明——非 `函数` 文档（纯时机）不产任何差异', () => {
    const src = '角色: 11\n函数前缀: K{n}_\n时机 初见：\n    「hi」\n';
    const { erb, diagnostics } = t(src);
    expect(erb).toContain('@M_KOJO_ENCOUNTER_K11');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
