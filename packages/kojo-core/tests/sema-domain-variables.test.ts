/**
 * K2-SEMA-DOMAIN-VARIABLES 验收：`domainSymbols.variables`（adapter 外部变量面）。
 *
 * 两条线各一组：
 * 1. **sema**：名字解析链的第三档（参数/绑定 → 文件声明 → 外部变量 → 未声明）；
 *    只读 → 既有 `core/expr/readonly-target`；`valueKind` 进类型格 ⇒ 既有 `type-mismatch`；
 *    **旧 adapter 省略该面 ⇒ 行为与今天逐字节一致**（同一源码仍报 `unknown-symbol`）。
 * 2. **adapter 自检**：形状坏 → 既有 `unit/adapter-incomplete`；重名 / 与代词·属性·名字函数
 *    撞名 → 既有 `unit/adapter-inconsistent`（不新造码）。
 *
 * 口径：输入一律真 2.0 源码（`parseSource`）+ `FIXTURE_ADAPTER`（或其派生变体）；
 * 只断言既有码，不钉文案全文（文案可读性改动不该红）。
 */
import { describe, expect, it } from 'vitest';

import type { DomainVariableSymbol, GameAdapter } from '../src/adapter.js';
import {
  ADAPTER_VALIDATION_CODES,
  checkSymbol,
  findDomainVariable,
  validateGameAdapter,
} from '../src/adapter.js';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter.js';
import { parseSource } from '../src/parser.js';
import { checkKojoFile } from '../src/sema/index.js';

/* ============================== 夹具 ============================== */

/** 去掉模板字面量开头的换行，保持作者书写的缩进（parser 按缩进判块） */
const source = (text: string): string => (text.startsWith('\n') ? text.slice(1) : text);

const check = (text: string, adapter: GameAdapter = FIXTURE_ADAPTER) =>
  checkKojoFile(parseSource(source(text)), { adapter, filePath: 'sema.domain.kojo2' });

const codes = (text: string, adapter: GameAdapter = FIXTURE_ADAPTER): string[] =>
  check(text, adapter).diagnostics.map((diagnostic) => String(diagnostic.code));

const expectCode = (text: string, code: string, adapter: GameAdapter = FIXTURE_ADAPTER): void => {
  expect(codes(text, adapter)).toContain(code);
};

const expectNoCode = (text: string, code: string, adapter: GameAdapter = FIXTURE_ADAPTER): void => {
  expect(codes(text, adapter)).not.toContain(code);
};

/**
 * 旧 adapter 的形态：`domainSymbols` **没有** `variables` 键（不是空数组）。
 * 契约把该字段标成可缺省，正是为了让这种 adapter 零改动继续跑。
 */
const LEGACY_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  domainSymbols: {
    pronouns: FIXTURE_ADAPTER.domainSymbols.pronouns,
    attributes: FIXTURE_ADAPTER.domainSymbols.attributes,
    nameFunctions: FIXTURE_ADAPTER.domainSymbols.nameFunctions,
    speakers: FIXTURE_ADAPTER.domainSymbols.speakers,
    unknown: FIXTURE_ADAPTER.domainSymbols.unknown,
  },
};

const withVariables = (variables: readonly DomainVariableSymbol[]): GameAdapter => ({
  ...FIXTURE_ADAPTER,
  domainSymbols: { ...FIXTURE_ADAPTER.domainSymbols, variables },
});

/* ============================== 1. sema：名字解析链 ============================== */

describe('sema · 域符号变量：假阳转绿', () => {
  it('外部变量赋值：fixture（声明了变量）零 unknown-symbol，旧 adapter 仍报（行为未翻转）', () => {
    const text = `
@算
    外部计数 = 3
`;
    expectNoCode(text, 'core/expr/unknown-symbol');
    expectCode(text, 'core/expr/unknown-symbol', LEGACY_ADAPTER);
  });

  it('外部变量做右值：同类型槽无诊断，异类型槽走既有 type-mismatch', () => {
    const sameKind = `
# 变量 人数 整数
@算
    人数 = 外部计数
`;
    expectNoCode(sameKind, 'core/expr/type-mismatch');
    const crossKind = `
# 变量 称呼 字符串
@算
    称呼 = 外部计数
`;
    expectCode(crossKind, 'core/expr/type-mismatch');
  });

  it('花括号读取（`{名}`）走同一名字链（`resolveName` 第三档）', () => {
    const text = `
# 变量 人数 整数
@算
    人数 = {外部计数}
`;
    expectNoCode(text, 'core/expr/unknown-symbol');
    expectNoCode(text, 'core/expr/type-mismatch');
  });

  it('字符串外部变量赋整数 → core/expr/type-mismatch（valueKind 参与兼容）', () => {
    const text = `
@算
    外部文本 = 1
`;
    expectCode(text, 'core/expr/type-mismatch');
  });

  it('角色号外部变量 ← 整数 → type-mismatch（int → character 不做隐式提升）', () => {
    expectCode(
      `
@算
    外部角色 = 1
`,
      'core/expr/type-mismatch',
    );
  });
});

describe('sema · 域符号变量：只读', () => {
  it('只读变量整体赋值 → core/expr/readonly-target', () => {
    expectCode(
      `
@算
    外部上限 = 5
`,
      'core/expr/readonly-target',
    );
  });

  it('只读变量增量赋值 → 同样是 core/expr/readonly-target（不落到 type-mismatch）', () => {
    const text = `
@算
    外部上限 += 1
`;
    expectCode(text, 'core/expr/readonly-target');
    expectNoCode(text, 'core/expr/type-mismatch');
  });

  it('可写整数变量 += → 无诊断', () => {
    const text = `
@算
    外部计数 += 1
`;
    expectNoCode(text, 'core/expr/type-mismatch');
    expectNoCode(text, 'core/expr/readonly-target');
    expectNoCode(text, 'core/expr/unknown-symbol');
  });

  it('字符串外部变量 += → core/expr/type-mismatch（增量只用于整数）', () => {
    expectCode(
      `
@算
    外部文本 += "先生"
`,
      'core/expr/type-mismatch',
    );
  });
});

describe('sema · 域符号变量：未声明与优先级', () => {
  it('未声明名字仍报 core/expr/unknown-symbol（变量面不放大放行范围）', () => {
    expectCode(
      `
@算
    路人甲 = 1
`,
      'core/expr/unknown-symbol',
    );
  });

  it('作者文件声明优先于外部变量（同名以文件声明为准）', () => {
    const text = `
# 变量 外部计数 字符串
@算
    外部计数 = 1
`;
    // 文件声明是字符串 ⇒ 整数右值类型不符；若外部变量（整数）抢先，这里就不会报
    expectCode(text, 'core/expr/type-mismatch');
  });

  it("unknown = 'raw' 时外部变量面不改变放行口径（未声明也放行）", () => {
    const rawAdapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      domainSymbols: { ...FIXTURE_ADAPTER.domainSymbols, unknown: 'raw' },
    };
    expectNoCode(
      `
@算
    路人甲 = 1
`,
      'core/expr/unknown-symbol',
      rawAdapter,
    );
  });

  it('外部变量是标量（省略 arraySize）：`名[下标]` 报 bad-index（名字已声明、但不是数组）', () => {
    /*
     * K2-SEMA-WIRING 起外部变量有数组面：adapter 省略 `arraySize` ⇒ 该名字**已声明为标量**，
     * 下标语法属于"形状不对"（`core/expr/bad-index`），不再冒充"未声明的数组"
     * （`core/expr/unknown-symbol` 会让作者去声明一个已经存在的名字）。长度/元素类型仍一概不猜。
     */
    expectCode(
      `
@算
    外部计数[0] = 1
`,
      'core/expr/bad-index',
    );
  });

  it('确定性：同一输入两次检查诊断逐字节相同', () => {
    const text = `
# 变量 称呼 字符串
@算
    称呼 = 外部计数
    外部上限 = 1
`;
    expect(JSON.stringify(check(text))).toBe(JSON.stringify(check(text)));
  });
});

/* ============================== 2. adapter：查询面 ============================== */

describe('adapter · 域符号变量：查询面', () => {
  it('checkSymbol 认外部变量；不认识的名字仍报 unknown-symbol', () => {
    expect(checkSymbol(FIXTURE_ADAPTER, '外部计数')).toBeNull();
    expect(checkSymbol(FIXTURE_ADAPTER, '路人甲')?.code).toBe('core/expr/unknown-symbol');
  });

  it('findDomainVariable：声明了就返回该条，旧 adapter 返回 undefined（不造空表）', () => {
    expect(findDomainVariable(FIXTURE_ADAPTER, '外部上限')).toMatchObject({
      name: '外部上限',
      valueKind: 'int',
      readonly: true,
    });
    expect(findDomainVariable(FIXTURE_ADAPTER, '路人甲')).toBeUndefined();
    expect(findDomainVariable(LEGACY_ADAPTER, '外部计数')).toBeUndefined();
  });
});

/* ============================== 3. adapter：装载期自检 ============================== */

describe('adapter · 域符号变量：装载期自检', () => {
  const diagnosticCodes = (adapter: GameAdapter): string[] =>
    validateGameAdapter(adapter).map((diagnostic) => String(diagnostic.code));

  it('fixture（四条变量）与旧 adapter（省略字段）都零诊断', () => {
    expect(validateGameAdapter(FIXTURE_ADAPTER)).toEqual([]);
    expect(validateGameAdapter(LEGACY_ADAPTER)).toEqual([]);
  });

  it('字段可以显式声明空数组（= 没有外部变量面）', () => {
    expect(validateGameAdapter(withVariables([]))).toEqual([]);
  });

  it('变量重名 → unit/adapter-inconsistent', () => {
    const adapter = withVariables([
      { name: '外部计数', valueKind: 'int' },
      { name: '外部计数', valueKind: 'string' },
    ]);
    expect(diagnosticCodes(adapter)).toContain(ADAPTER_VALIDATION_CODES.inconsistent);
  });

  it('与代词撞名 → unit/adapter-inconsistent', () => {
    expect(diagnosticCodes(withVariables([{ name: '我', valueKind: 'int' }]))).toContain(
      ADAPTER_VALIDATION_CODES.inconsistent,
    );
  });

  it('与角色属性撞名 → unit/adapter-inconsistent', () => {
    expect(diagnosticCodes(withVariables([{ name: '数值', valueKind: 'int' }]))).toContain(
      ADAPTER_VALIDATION_CODES.inconsistent,
    );
  });

  it('与名字函数撞名 → unit/adapter-inconsistent', () => {
    expect(diagnosticCodes(withVariables([{ name: '名字', valueKind: 'int' }]))).toContain(
      ADAPTER_VALIDATION_CODES.inconsistent,
    );
  });

  it('valueKind 非法 → unit/adapter-incomplete', () => {
    const adapter = withVariables([{ name: '外部计数', valueKind: 'unknown' as never }]);
    expect(diagnosticCodes(adapter)).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });

  it('variables 不是数组 → unit/adapter-incomplete', () => {
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      domainSymbols: { ...FIXTURE_ADAPTER.domainSymbols, variables: 'nope' as never },
    };
    expect(diagnosticCodes(adapter)).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });

  it('空名 / 非对象条目 → unit/adapter-incomplete（坏形状不抛）', () => {
    expect(diagnosticCodes(withVariables([{ name: '  ', valueKind: 'int' }]))).toContain(
      ADAPTER_VALIDATION_CODES.incomplete,
    );
    const broken = withVariables([null as never]);
    expect(diagnosticCodes(broken)).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });

  it('readonly 不是布尔 → unit/adapter-incomplete', () => {
    const adapter = withVariables([{ name: '外部计数', valueKind: 'int', readonly: 'yes' as never }]);
    expect(diagnosticCodes(adapter)).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });
});
