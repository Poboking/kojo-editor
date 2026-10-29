/**
 * K2-SEMA-TYPES 验收：core 语义检查层（`src/sema/**`）。
 *
 * 口径：
 * - 输入一律是**真 2.0 源码**（`parseSource`）+ `FIXTURE_ADAPTER`（或其能力派生变体），
 *   不手搓 AST 当正常输入；只有 parser 已挡在 AST 之外的不变量（常量非字面量 / 初值类型
 *   不符）用"真源码解析后补一条坏声明"的防御性用例，注明原因；
 * - 每类检查各给正反例；诊断只断言**既有码**（不新造码）；
 * - 确定性：同一输入两次调用 `JSON.stringify` 逐字节相等，诊断按 span 稳定排序。
 */
import { describe, expect, it } from 'vitest';

import type { GameAdapter, ProgramFeatureKey } from '../src/adapter.js';
import type { KojoConstDecl, KojoFile, KojoVarDecl } from '../src/ast.js';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter.js';
import { parseSource } from '../src/parser.js';
import { assignable, checkKojoFile, semaTypeLabel, semaTypeOfLiteral } from '../src/sema/index.js';

/* ============================== 夹具 ============================== */

/** 去掉模板字面量开头的换行，保持作者书写的缩进（parser 按缩进判块） */
const source = (text: string): string => (text.startsWith('\n') ? text.slice(1) : text);

const check = (text: string, adapter: GameAdapter = FIXTURE_ADAPTER) =>
  checkKojoFile(parseSource(source(text)), { adapter, filePath: 'sema.kojo2' });

const codes = (text: string, adapter: GameAdapter = FIXTURE_ADAPTER): string[] =>
  check(text, adapter).diagnostics.map((diagnostic) => String(diagnostic.code));

const expectCode = (text: string, code: string, adapter: GameAdapter = FIXTURE_ADAPTER): void => {
  expect(codes(text, adapter)).toContain(code);
};

const expectNoCode = (text: string, code: string, adapter: GameAdapter = FIXTURE_ADAPTER): void => {
  expect(codes(text, adapter)).not.toContain(code);
};

/** 能力全开的 fixture 派生 adapter：用于隔离"能力闸"与"类型/结构"两类判定 */
const CAPABLE_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  presentation: {
    heart: FIXTURE_ADAPTER.presentation.heart,
    color: { setColor: 'ENTER-COLOR', resetColor: 'EXIT-COLOR', hexPrefix: '0x' },
    face: {
      defaultExpression: '平静',
      calls: [{ object: 'me', call: 'PRINT-FACE', receiverArg: '0' }],
      maxArgs: 4,
      placeholder: '-',
    },
    options: { status: 'pending', button: 'BUTTON', input: 'INPUT', result: 'RESULT', maxPerScene: 1 },
  },
  storageClasses: {
    classes: [
      ...FIXTURE_ADAPTER.storageClasses.classes,
      {
        period: 'save',
        engine: 'SAVE-STORE',
        init: 'on-new-game',
        persisted: true,
        slotPrefix: '__fixture_save_',
        description: 'fixture 存档槽',
      },
      {
        period: 'session',
        engine: 'SESSION-STORE',
        init: 'on-process-start',
        persisted: false,
        slotPrefix: '__fixture_session_',
        description: 'fixture 会话槽',
      },
    ],
    slotStability: 'project-stable',
  },
  programFeatures: { arrays: true, while: true, goto: true, recursion: true, foreach: true, repeat: true },
};

/** 只改 programFeatures 的派生 adapter（数组/循环的"开启"正例） */
const withFeatures = (overrides: Partial<Record<ProgramFeatureKey, boolean>>): GameAdapter => ({
  ...FIXTURE_ADAPTER,
  programFeatures: { ...FIXTURE_ADAPTER.programFeatures, ...overrides },
});

/** 把 fixture 唯一的角色属性改成只读（`core/expr/readonly-target` 正例） */
const READONLY_ATTRIBUTE_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  domainSymbols: {
    ...FIXTURE_ADAPTER.domainSymbols,
    attributes: [{ ...FIXTURE_ADAPTER.domainSymbols.attributes[0]!, readonly: true }],
  },
};

/* ============================== 1. 值类型格 ============================== */

describe('值类型格 · assignable', () => {
  it('同类可赋值，理由说明类型一致', () => {
    const result = assignable('int', 'int');
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('一致');
  });

  it('来源 unknown 放行（动态类型不参与静态判定）', () => {
    const result = assignable('unknown', 'int');
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('动态类型');
  });

  it('目标 unknown 放行', () => {
    expect(assignable('string', 'unknown').ok).toBe(true);
  });

  it('character → int 放行（角色号以整数落地）', () => {
    const result = assignable('character', 'int');
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('角色号');
  });

  it('int → character 拒绝（不做隐式提升）', () => {
    const result = assignable('int', 'character');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('隐式');
  });

  it('string → int 拒绝：不做隐式类型转换', () => {
    const result = assignable('string', 'int');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('整数');
  });

  it('字面量 / 标签映射', () => {
    expect(semaTypeOfLiteral(10)).toBe('int');
    expect(semaTypeOfLiteral('十')).toBe('string');
    expect(semaTypeLabel('character')).toBe('角色号');
    expect(semaTypeLabel('unknown')).toBe('未知类型');
  });
});

/* ============================== 2. 声明层 ============================== */

describe('声明层 · 初值 / 常量 / 表值列 / 池分支', () => {
  it('初值类型与声明一致时不报 bad-initializer', () => {
    expectNoCode('# 变量 温度 整数 = 0\n', 'core/decl/bad-initializer');
  });

  it('初值类型与声明不符（防御性复核：parser 已挡在 AST 外，这里补一条坏声明）', () => {
    const base = parseSource('# 变量 温度 整数 = 0\n');
    const span = base.decls[0]!.span;
    const broken: KojoVarDecl = {
      kind: 'var',
      name: '湿度',
      valueType: 'int',
      init: '潮',
      storage: 'scene',
      span,
    };
    const file: KojoFile = { ...base, decls: [...base.decls, broken] };
    const result = checkKojoFile(file, { adapter: FIXTURE_ADAPTER });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/decl/bad-initializer');
  });

  it('常量初值非字面量（防御性复核：parser 已挡在 AST 外）', () => {
    const base = parseSource('# 常量 上限 整数 = 10\n');
    const span = base.decls[0]!.span;
    // 模拟"绕过 parser 的 AST 生产方"把表达式节点塞进字面量槽（正常输入里不可能出现）
    const broken = {
      kind: 'const',
      name: '坏常量',
      valueType: 'int',
      value: { call: '记录("x")' },
      span,
    } as unknown as KojoConstDecl;
    const file: KojoFile = { ...base, decls: [...base.decls, broken] };
    const result = checkKojoFile(file, { adapter: FIXTURE_ADAPTER });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/decl/const-not-constant');
  });

  it('常量字面量合法：无声明层诊断', () => {
    expect(codes('# 常量 上限 整数 = 10\n')).toEqual([]);
  });

  it('表值列混类型 → core/table/type-mismatch（只上浮这一条）', () => {
    const text = `
# 对照表 心情 依据 恋慕
    0..9 -> 疏远
    10..19 -> 5
    否 -> 未知
`;
    const result = check(text);
    const tableCodes = result.diagnostics.map((diagnostic) => String(diagnostic.code));
    expect(tableCodes).toContain('core/table/type-mismatch');
    expect(tableCodes.filter((code) => code === 'core/table/type-mismatch')).toHaveLength(1);
  });

  it('表值列同类型：不报 type-mismatch', () => {
    const text = `
# 对照表 心情 依据 恋慕
    0..9 -> 疏远
    10..19 -> 亲近
    否 -> 未知
`;
    expectNoCode(text, 'core/table/type-mismatch');
  });

  it('池分支归约不出可打印内容 → core/pool/empty-branch', () => {
    const text = `
# 池 问候
    ? 1
        // 只有注释
    ? 否
        > 早上好。
`;
    expectCode(text, 'core/pool/empty-branch');
  });

  it('池每个分支都可归约 → 无 empty-branch', () => {
    const text = `
# 池 问候
    ? 1
        > 早上好。
    ? 否
        > 你好。
`;
    expectNoCode(text, 'core/pool/empty-branch');
  });
});

/* ============================== 3. 赋值 / @算 ============================== */

describe('赋值 · 已声明性 / 类型 / 只读目标', () => {
  it('未声明名字赋值 → core/expr/unknown-symbol', () => {
    const text = `
@算
    人数 = 1
`;
    expectCode(text, 'core/expr/unknown-symbol');
  });

  it('@算 嵌在条件分支里也被检查（走法覆盖）', () => {
    const text = `
? 1
    @算
        人数 = 1
`;
    expectCode(text, 'core/expr/unknown-symbol');
  });

  it('给常量赋值 → core/expr/assign-to-constant', () => {
    const text = `
# 常量 上限 整数 = 10
@算
    上限 = 3
`;
    expectCode(text, 'core/expr/assign-to-constant');
  });

  it('给表名赋值 → core/expr/assign-to-constant', () => {
    const text = `
# 对照表 心情 依据 恋慕
    0..9 -> 疏远
    否 -> 未知
@算
    心情 = 1
`;
    expectCode(text, 'core/expr/assign-to-constant');
  });

  it('整数变量赋字符串字面量 → core/expr/type-mismatch', () => {
    const text = `
# 变量 人数 整数
@算
    人数 = "三"
`;
    expectCode(text, 'core/expr/type-mismatch');
  });

  it('整数变量赋整数常量：无类型诊断', () => {
    const text = `
# 变量 人数 整数
# 常量 上限 整数 = 10
@算
    人数 = 上限
`;
    const result = codes(text);
    expect(result).not.toContain('core/expr/type-mismatch');
    expect(result).not.toContain('core/expr/unknown-symbol');
  });

  it('字符串变量用 += → core/expr/type-mismatch（增量只用于整数）', () => {
    const text = `
# 变量 称呼 字符串
@算
    称呼 += "先生"
`;
    expectCode(text, 'core/expr/type-mismatch');
  });

  it("adapter 的 unknown = 'raw' 时未声明目标原样放行（与 checkSymbol 同口径）", () => {
    const rawAdapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      domainSymbols: { ...FIXTURE_ADAPTER.domainSymbols, unknown: 'raw' },
    };
    const text = `
@算
    人数 = 1
    队列[0] = 1
`;
    expectNoCode(text, 'core/expr/unknown-symbol', rawAdapter);
  });

  it('未声明的角色属性赋值 → core/expr/unknown-symbol', () => {
    const text = `
@函 加(目标)
    {目标}的好感度 = 3
`;
    expectCode(text, 'core/expr/unknown-symbol');
  });

  it('只读角色属性赋值 → core/expr/readonly-target', () => {
    const text = `
@函 加(目标)
    {目标}的数值 = 3
`;
    expectCode(text, 'core/expr/readonly-target', READONLY_ATTRIBUTE_ADAPTER);
  });

  it('角色属性类型不符 → core/expr/type-mismatch', () => {
    const text = `
@函 加(目标)
    {目标}的数值 = "高"
`;
    expectCode(text, 'core/expr/type-mismatch');
  });
});

/* ============================== 4. 数组 ============================== */

describe('数组 · 下标与能力', () => {
  const ARRAYS = withFeatures({ arrays: true });

  it('字面量下标在范围内：不报越界', () => {
    const text = `
# 变量 队列 整数[3]
@算
    队列[2] = 7
`;
    expectNoCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('字面量下标越界 → core/expr/index-out-of-range', () => {
    const text = `
# 变量 队列 整数[3]
@算
    队列[3] = 7
`;
    expectCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('负下标 → core/expr/index-out-of-range（0 基）', () => {
    const text = `
# 变量 队列 整数[3]
@算
    队列[-1] = 7
`;
    expectCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('整数常量下标越界 → core/expr/index-out-of-range', () => {
    const text = `
# 常量 末位 整数 = 3
# 变量 队列 整数[3]
@算
    队列[末位] = 1
`;
    expectCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('字符串下标 → core/expr/bad-index', () => {
    const text = `
# 变量 队列 整数[3]
@算
    队列["首"] = 1
`;
    expectCode(text, 'core/expr/bad-index', ARRAYS);
  });

  it('给标量加下标 → core/expr/bad-index', () => {
    const text = `
# 变量 人数 整数
@算
    人数[0] = 1
`;
    expectCode(text, 'core/expr/bad-index', ARRAYS);
  });

  it('给 .长度 赋值 → core/expr/readonly-target', () => {
    const text = `
# 变量 队列 整数[3]
@算
    队列.长度 = 9
`;
    expectCode(text, 'core/expr/readonly-target', ARRAYS);
  });

  it('读取位置的字面量下标越界同样报（表达式扫描）', () => {
    const text = `
# 变量 队列 整数[3]
# 变量 人数 整数
@算
    人数 = 队列[5]
`;
    expectCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('插值里的字面量下标越界同样报', () => {
    const text = `
# 变量 队列 整数[3]
> 第{队列[9]}位
`;
    expectCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('字符串字面量里的“队列[5]”不当下标（扫描跳过引号内部）', () => {
    const text = `
# 变量 队列 整数[3]
# 变量 文本 字符串
@算
    文本 = "队列[5]"
`;
    expectNoCode(text, 'core/expr/index-out-of-range', ARRAYS);
  });

  it('数组声明在 adapter 未开启 arrays 时 → core/array/unsupported', () => {
    const text = '# 变量 队列 整数[3]\n';
    expectCode(text, 'core/array/unsupported');
  });

  it('@巡 绑定名进入作用域（{下标} / {值} 可赋值且类型已知）', () => {
    const text = `
# 变量 队伍 整数[3]
# 变量 人数 整数
@巡 队伍
    @算
        下标 = 0
        人数 = {值}
`;
    const result = codes(text, CAPABLE_ADAPTER);
    expect(result).not.toContain('core/expr/unknown-symbol');
    expect(result).not.toContain('core/expr/type-mismatch');
  });

  it('整数常量长度为 0 → core/decl/bad-array-size', () => {
    const text = `
# 常量 零 整数 = 0
# 变量 队列 整数[零]
`;
    expectCode(text, 'core/decl/bad-array-size', CAPABLE_ADAPTER);
  });
});

/* ============================== 5. 函数 ============================== */

describe('@函 · 返回种类 / 保守路径 / 参数默认值', () => {
  it('@返 混用（有值 + 无值）→ core/func/return-mixed', () => {
    const text = `
@函 算(数值)
    ? 数值 > 0
        @返 数值
    ? 否
        @返
`;
    expectCode(text, 'core/func/return-mixed', CAPABLE_ADAPTER);
  });

  it('有值返回且 ? 否 两分支都返回：无 missing-return', () => {
    const text = `
@函 算(数值)
    ? 数值 > 0
        @返 1
    ? 否
        @返 0
`;
    expectNoCode(text, 'core/func/missing-return', CAPABLE_ADAPTER);
  });

  it('有值返回但无 ? 否：可证落空 → core/func/missing-return', () => {
    const text = `
@函 算(数值)
    ? 数值 > 0
        @返 1
`;
    expectCode(text, 'core/func/missing-return', CAPABLE_ADAPTER);
  });

  it('末尾显式 @返：无 missing-return', () => {
    const text = `
@函 算(数值)
    @返 1
`;
    expectNoCode(text, 'core/func/missing-return', CAPABLE_ADAPTER);
  });

  it('循环让路径证不出：只保留 unproven，不误报 missing-return', () => {
    const text = `
@函 算(数值)
    @循 1
        @返 1
`;
    const result = check(text, CAPABLE_ADAPTER);
    expect(result.diagnostics.map((diagnostic) => String(diagnostic.code))).not.toContain(
      'core/func/missing-return',
    );
    expect(result.symbols.functions[0]!.returnFlow).toBe('unproven');
  });

  it('实参 vs 形参默认值类型不符 → core/expr/type-mismatch', () => {
    const text = `
@函 加(数值=10)
    @返 数值
! 加("十")
`;
    expectCode(text, 'core/expr/type-mismatch', CAPABLE_ADAPTER);
  });

  it('实参与形参默认值同类型：无类型诊断', () => {
    const text = `
@函 加(数值=10)
    @返 数值
! 加(20)
`;
    expectNoCode(text, 'core/expr/type-mismatch', CAPABLE_ADAPTER);
  });

  it('形参无默认值 = 动态类型：传什么参数都不判', () => {
    const text = `
@函 加(数值)
    @返 数值
! 加("十")
`;
    expectNoCode(text, 'core/expr/type-mismatch', CAPABLE_ADAPTER);
  });

  it('void 函数（只有无值 @返）：无返回诊断', () => {
    const text = `
@函 记录()
    @返
`;
    const result = codes(text, CAPABLE_ADAPTER);
    expect(result).not.toContain('core/func/return-mixed');
    expect(result).not.toContain('core/func/missing-return');
  });
});

/* ============================== 6. adapter 能力 ============================== */

describe('能力闸 · presentation / programFeatures / storageClasses（只读）', () => {
  it('@循 在 while 未开启时 → core/control/unsupported', () => {
    const text = `
@循 1
    > 等
`;
    expectCode(text, 'core/control/unsupported');
  });

  it('@复 在 repeat 未开启时 → core/control/unsupported', () => {
    const text = `
@复 2
    > 等
`;
    expectCode(text, 'core/control/unsupported');
  });

  it('@巡 在 foreach 未开启时 → core/control/unsupported', () => {
    const text = `
@巡 队伍
    > 等
`;
    expectCode(text, 'core/control/unsupported');
  });

  it('@标 / @跳 在 goto 未开启时 → core/goto/unsupported', () => {
    const text = `
@标 起点
@跳 起点
`;
    expectCode(text, 'core/goto/unsupported');
  });

  it('存档变量在 storageClasses 未声明时 → core/decl/unknown-storage', () => {
    expectCode('# 变量 标记 整数 存档\n', 'core/decl/unknown-storage');
  });

  it('会话变量在 storageClasses 未声明时 → core/decl/unknown-storage', () => {
    expectCode('# 变量 标记 整数 会话\n', 'core/decl/unknown-storage');
  });

  it('@着色 在 presentation.color 为 null 时 → core/color/unsupported', () => {
    const text = `
@着色 0xFF8080
    > 红
`;
    expectCode(text, 'core/color/unsupported');
  });

  it('@颜绘 在 presentation.face 为 null 时 → core/face/unsupported', () => {
    expectCode('@颜绘 笑顔\n', 'core/face/unsupported');
  });

  it('选项 在 presentation.options 为 null 时 → core/feature/unsupported', () => {
    const text = `
选项：
    「甲」：
        > 甲
`;
    expectCode(text, 'core/feature/unsupported');
  });

  it('能力全开的 adapter：同一批构造不再报能力码', () => {
    const text = `
# 变量 队列 整数[2] 存档
@算
    队列[0] = 1
@循 队列[0] < 2
    > 等
@复 2
    > 好
@标 起点
@跳 起点
@着色 0xFF0000
    > 红
@颜绘 笑顔
选项：
    「甲」：
        > 甲
`;
    const result = codes(text, CAPABLE_ADAPTER);
    for (const capabilityCode of [
      'core/array/unsupported',
      'core/control/unsupported',
      'core/goto/unsupported',
      'core/decl/unknown-storage',
      'core/color/unsupported',
      'core/face/unsupported',
      'core/feature/unsupported',
    ]) {
      expect(result).not.toContain(capabilityCode);
    }
  });
});

/* ============================== 7. 确定性 / 符号事实 ============================== */

describe('确定性 · 诊断排序 · 符号事实', () => {
  const MESSY = `
# 变量 人数 整数 存档
# 变量 队列 整数[2]
@算
    人数 = "三"
    队列[5] = 1
    未声明 = 1
`;

  it('同一输入两次调用逐字节相等', () => {
    const first = check(MESSY);
    const second = check(MESSY);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('诊断按 span 稳定排序（行/列不倒退）', () => {
    const diagnostics = check(MESSY).diagnostics;
    expect(diagnostics.length).toBeGreaterThan(1);
    for (let index = 1; index < diagnostics.length; index++) {
      const previous = diagnostics[index - 1]!.span;
      const current = diagnostics[index]!.span;
      if (previous === null || current === null) continue;
      const previousKey = previous.start.line * 100000 + previous.start.column;
      const currentKey = current.start.line * 100000 + current.start.column;
      expect(currentKey).toBeGreaterThanOrEqual(previousKey);
    }
  });

  it('符号事实：声明类型 / 数组长度 / 表值类型', () => {
    const text = `
# 变量 队列 整数[3]
# 常量 上限 整数 = 10
# 对照表 心情 依据 恋慕
    0..9 -> 疏远
    否 -> 未知
`;
    const symbols = check(text).symbols;
    const byName = new Map(symbols.declarations.map((entry) => [entry.name, entry]));
    expect(byName.get('队列')).toMatchObject({ kind: 'var', type: 'int', isArray: true, arraySize: 3 });
    expect(byName.get('上限')).toMatchObject({ kind: 'const', type: 'int', isArray: false });
    expect(byName.get('心情')).toMatchObject({ kind: 'table', type: 'string' });
  });

  it('符号事实：函数形参类型 / 返回三态可喂项目层', () => {
    const text = `
@函 计算(数值=10)
    ? 数值 > 0
        @返 数值
    ? 否
        @返 0
`;
    const fn = check(text, CAPABLE_ADAPTER).symbols.functions[0]!;
    expect(fn.name).toBe('计算');
    expect(fn.filePath).toBe('sema.kojo2');
    expect(fn.params).toHaveLength(1);
    expect(fn.params[0]).toMatchObject({ name: '数值', type: 'int', hasDefault: true });
    expect(fn.returnsValue).toBe(true);
    expect(fn.returnFlow).toBe('returns');
    expect(fn.allPathsReturn).toBe(true);
  });

  it('本层不并表 parser 诊断（初值类型错由 parser 报，不双报）', () => {
    const text = '# 变量 温度 整数 = "热"\n';
    // parser 已报 bad-initializer 且不把坏初值放进 AST；本层不应再报一条
    expectNoCode(text, 'core/decl/bad-initializer');
  });
});
