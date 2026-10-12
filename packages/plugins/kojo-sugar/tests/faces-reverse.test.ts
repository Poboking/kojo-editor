/**
 * 批 I：时机函数名**反向匹配**的单测。
 *
 * 这个模块的产物会直接决定读者眼里的"这是哪一段口上"，所以**错标的代价 >> 漏标**：
 * 本文件一半的断言在钉"不该标的时候必须返回 undefined"。
 */
import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { buildFaceNameIndex, stripParams } from '../src/faces-reverse';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const idx = buildFaceNameIndex(stubFaceTable());

describe('函数头反解 · 该标的必须标对', () => {
  it('标准版指令（无家族段）→ 规范 §3.2 原文 `时机 指令 310：`（默认类型段整个省略）', () => {
    expect(idx.label('M_KOJO_MESSAGE_COM_K12_310')).toBe('时机 指令 310：');
  });

  it('别人版（家族段 `_名字`）→ 收成 `（名字版）`，不混进编号', () => {
    expect(idx.label('M_KOJO_少女之梦_EVENT_K1_2')).toBe('时机 事件 2（少女之梦版）：');
    expect(idx.label('M_KOJO_少女之梦_ENCOUNTER_K1')).toBe('时机 初见（少女之梦版）：');
  });

  it('括号版家族名（`口上名（改）`）也能整段吃掉', () => {
    expect(idx.label('M_KOJO_破空自制（改）_MESSAGE_COM_K14_100')).toBe(
      '时机 指令 100（破空自制（改）版）：',
    );
  });

  it('非默认段取值按 §3.2 写成**命名参数**，并换回声明键（`CUSTOM_COM` → `自定指令`）', () => {
    expect(idx.label('M_KOJO_MESSAGE_CUSTOM_COM_K1_310')).toBe('时机 指令 310 类型: 自定指令：');
    expect(idx.label('M_KOJO_MESSAGE_SCOM_K1_60')).toBe('时机 指令 60 类型: SCOM：');
  });

  it('主模板优先于"另一分野的成否子模板"（规范 §3.2 `时机 成功：`）', () => {
    // `M_KOJO{t}_SUCCESS_${com}_K{n}_{i}` 同时是「成功」的主模板与「指令」的成否子模板
    expect(idx.label('M_KOJO_SUCCESS_COM_K1_310')).toBe('时机 成功 310：');
  });

  it('无编号的分野只给分野名', () => {
    expect(idx.label('M_KOJO_MESSAGE_PALAMCNG_B_K1')).toBe('时机 绝顶：');
    expect(idx.label('M_KOJO_MESSAGE_MARKCNG_K1')).toBe('时机 标记：');
  });
});

describe('函数头反解 · 不该标的必须放弃（错标比不标危险）', () => {
  it('段取值只认 adapter 声明过的候选：MESSAGECHECK 四件套不是"指令的类型段"', () => {
    expect(idx.label('M_KOJO_MESSAGE_MESSAGECHECK_COM_K1_310')).toBeUndefined();
    expect(idx.label('M_KOJO_MESSAGE_PALAMCNG_MESSAGECHECK_A_K1_3')).toBeUndefined();
  });

  it('表里没有的调用面不猜（`PALAMCNG_A` ≠ 表里的 `PALAMCNG_A2`）', () => {
    expect(idx.label('M_KOJO_MESSAGE_PALAMCNG_A_K1_3')).toBeUndefined();
  });

  it('不锚定整串就不匹配；但 `{i}` 允许带后缀的真实编号', () => {
    // 编号段 `{i}` 会吃掉 `_310_EXTRA_SUFFIX`——语料里 `…_K28_600_1` 这类"带后缀编号"是真的
    // （包装三联的 `_1` 那一个），所以它算命中；但**前缀**多出来的一律不匹配。
    expect(idx.label('M_KOJO_MESSAGE_COM_K12_310_EXTRA_SUFFIX')).toBe('时机 指令 310_EXTRA_SUFFIX：');
    expect(idx.label('PREFIX_M_KOJO_MESSAGE_COM_K12_310')).toBeUndefined();
    expect(idx.label('M_KOJO_MESSAGE_COM_K12')).toBeUndefined(); // 缺编号段 → 不猜
  });

  it('辅助函数 / 工具函数 / 空名不标', () => {
    for (const name of ['AUTO_AEGI', 'KOJO_ACTIVE_INFO', 'OPPAI_DESCRIPTION', '', 'M_KOJO_K1']) {
      expect(idx.label(name)).toBeUndefined();
    }
  });

  it('分野表缺席 → 一个头都不标（fail-closed，与 `timing-face-unknown` 同纪律）', () => {
    const empty = buildFaceNameIndex(undefined);
    expect(empty.size).toBe(0);
    expect(empty.label('M_KOJO_MESSAGE_COM_K12_310')).toBeUndefined();
  });

  it('最具体者优先：特化模板赢过前缀超集的通用模板', () => {
    // 「事件」模板 `…_EVENT_K{n}_{i}` 会吞掉「撞见」`…_EVENT_K{n}_ONABARE_{i}`；
    // 固定字面量更长者胜出，否则读者会把"撞见"读成编号 ONABARE 的普通事件。
    expect(idx.label('M_KOJO_EVENT_K1_ONABARE_3')).toBe('时机 撞见 3：');
    expect(idx.label('M_KOJO_DAILY_EVENT_K1_100')).toBe('时机 日常 100：');
    expect(idx.label('M_KOJO_EVENT_K1_LOST_VIRGIN_STOP')).toBe('时机 破瓜中止：');
  });

  it('三件套（登记 / 配色 / 开关初始化）不参与——`registration` 不是时机入口', () => {
    expect(idx.label('M_KOJO_K1')).toBeUndefined(); // 登记函数
    expect(idx.label('M_KOJO_COLOR_K1')).toBeUndefined(); // 配色函数
    // 「开关初始化」在 faces 表里是真实调用面（`时机 开关初始化`），与 registration 是两回事
    expect(idx.label('M_KOJO_FLAGSETTING_K1')).toBe('时机 开关初始化：');
  });
});

describe('stripParams · 函数头参数段剥离', () => {
  it('糖表层不手写函数参数，`(ARG,ARG:1)` 一类先剥掉再匹配', () => {
    expect(stripParams('M_KOJO_SPEVENT_K1_1 (ARG,ARG:1)')).toBe('M_KOJO_SPEVENT_K1_1');
    expect(stripParams('M_KOJO_MESSAGE_COM_K12_310')).toBe('M_KOJO_MESSAGE_COM_K12_310');
    expect(stripParams('  M_KOJO_K1_2 (ARG)  ')).toBe('M_KOJO_K1_2');
    expect(idx.label(stripParams('M_KOJO_SPEVENT_K1_1 (ARG,ARG:1)'))).toBe('时机 特殊事件 1：');
  });
});

describe('模板算术 · 自定义表也成立（不依赖 eraTW 字面量）', () => {
  const custom: KojoFaceTable = {
    faces: {
      测试面: { template: 'X_{t}_HELLO_${com}_K{n}_{i}', segments: { com: { 甲: 'A', 乙: 'B' } } },
    },
  };
  const ci = buildFaceNameIndex(custom);

  it('自定义表：默认段省略、非默认段进命名参数、家族段与编号各归其位', () => {
    expect(ci.label('X__fork_HELLO_B_K9_3')).toBe('时机 测试面 3 类型: 乙（fork版）：');
    expect(ci.label('X__HELLO_A_K9_3')).toBe('时机 测试面 3：');
  });

  it('未声明的段取值不猜', () => {
    expect(ci.label('X__HELLO_C_K9_3')).toBeUndefined();
  });

  it('段名没在语法层登记命名参数 → 整头不标（静默丢分支事实 = 错标）', () => {
    const orphan: KojoFaceTable = {
      faces: { 测试面: { template: 'X_{t}_HELLO_${zz}_K{n}_{i}', segments: { zz: { 甲: 'A', 乙: 'B' } } } },
    };
    expect(buildFaceNameIndex(orphan).label('X__HELLO_A_K9_3')).toBeUndefined();
  });
});

/**
 * 糖视图的第一原则：**看见的即写得出的**。
 * 投影标签不是"注释"，是同一套 §3.2 语法——所以每条标签都必须能被转译器吃回去、
 * 产出与来源同一个函数名。这条测试是标签口径的**闭合证明**：
 * 标签写成 `时机 指令 COM 310：` 这种"读得懂但写不出"的形态，这里就会红。
 */
describe('标签可写回 · 反糖标签喂回转译器得到同一个函数名', () => {
  const t = (src: string) =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['M_KOJO_MESSAGE_COM_K12_310', '时机 指令 310：'],
    ['M_KOJO_MESSAGE_SCOM_K12_60', '时机 指令 60 类型: SCOM：'],
    ['M_KOJO_MESSAGE_CUSTOM_COM_K12_310', '时机 指令 310 类型: 自定指令：'],
    ['M_KOJO_SUCCESS_COM_K12_310', '时机 成功 310：'],
    ['M_KOJO_EVENT_K12_100', '时机 事件 100：'],
    ['M_KOJO_DAILY_EVENT_K12_100', '时机 日常 100：'],
    ['M_KOJO_MESSAGE_COUNTER_K12_20', '时机 计数器 20：'],
    ['M_KOJO_ENCOUNTER_K12', '时机 初见：'],
  ];

  for (const [name, label] of cases) {
    it(`${label} → @${name}`, () => {
      expect(idx.label(name)).toBe(label);
      const { erb } = t(`角色: 12\n${label}\n    「甲。」\n`);
      expect(erb).toContain(`@${name}`);
    });
  }
});
