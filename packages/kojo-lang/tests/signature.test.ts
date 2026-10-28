/**
 * K2-LSP-SIGNATURE · `kojo2` 签名帮助的**纯函数**行为闸。
 *
 * B3d（2026-10-28）：本闸从 `packages/app/tests/kojo2-signature.test.ts` **整枚搬进包**——判据
 * 住在 `src/signature.ts`，供方是插件，宿主只剩翻译与注册。文件名按搬入的那枚叶子叫
 * `signature.test.ts`；**断言一条未减**（原文件 57 条纯函数用例逐条搬来，provider 那 13 条留在
 * app 侧改测"宿主翻译 + 共享收口"）。搬进来只换了两件东西：import 出处，以及把"回看窗口有界"
 * 从注释变成两条真断言（64 行上限内认、上限外 `null`）。
 *
 * 覆盖面（每条都钉一个**事实口径**，不复写语法实现）：
 * - 调用位：`! 函名(` / `! 模名(` / 表达式位裸调用；嵌套调用取最内层；
 * - `activeParameter`：按顶层逗号数，字符串 / 括号 / 嵌套调用里的逗号不计；越界夹到最后一格；
 * - 声明头：`# 模 名(…)` / `@函 名(…)` 的形参与默认值（默认值来自声明索引的同一份事实）；
 * - `@巡` 集合名：集合声明的绑定名 + 来源槽；未声明 / adapter 缺席 / 能力关闭 ⇒ `null`；
 * - 位置门：字符串 / `@原生` / 注释 / 台词正文 ⇒ `null`，`{…}` 插值内照常；
 * - CRLF / 中文：同一份夹具换 EOL 后读数不变；
 * - 参数标签必须逐字出现在签名串里（编辑器靠它在整串上定位高亮）。
 *
 * 夹具里每类声明只留一条；期望值以**声明索引 + core 的 `@巡` 计划语义**为准，测试不另写
 * 一套形参解析（两套判据比没测更坏）。
 */

import { describe, expect, it } from 'vitest';
import type {
  ForeachArrayRule,
  ForeachCollectionDecl,
  ForeachDeclarations,
  GameAdapter,
} from '@kojo/kojo-core';
import {
  clampActiveParameter,
  kojo2SignatureAt,
  type Kojo2SignatureOptions,
} from '../src/signature';

/* ============================== 夹具 ============================== */

/**
 * 一份**语法可解析**的 2.0 文件：函数（带默认值）/ 模板 / 池 / 变量数组（长度用常量）/
 * 台词插值 / `@巡` 三种集合形态 / `@原生`。末尾留一个换行，测试在它后面追加行。
 */
const BASE = [
  '// K2-LSP-SIGNATURE 夹具',
  '# 幕 神社清晨',
  '# 常量 容量 整数 = 5',
  '# 变量 队伍 整数[3]',
  '# 变量 记录 整数[容量]',
  '# 变量 已收 整数 = 0',
  '',
  '# 模 娇羞退场(原因)',
  '    > （她红着脸，因为{原因}而不知所措）',
  '    [插槽]',
  '    > （随后匆匆跑开了）',
  '',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 数值',
  '',
  '@函 取整(值, 基数=1)',
  '    @返 值',
  '',
  '@函 无参()',
  '    @返 0',
  '',
  '# 池 早安问候',
  '    ? 恋慕 < 100',
  '        「……早。」',
  '    ? 否',
  '        「早上好。」',
  '',
  '> 晨光透过鸟居。',
  '灵梦：「{增加羁绊(目标, 1)}今天来得挺早嘛。」',
  '@算',
  '    已收 = 增加羁绊(目标, 12)',
  '! 娇羞退场("被夸奖")',
  '! 增加羁绊(目标, 12)',
  '',
  '@巡 队伍',
  '    > {角} / {名}',
  '',
  '@巡 记录',
  '    > {值} / {下标}',
  '',
  '@巡 状态',
  '    > {项} / {键}',
  '',
  '@巡 不存在',
  '    > x',
  '',
  '@原生',
  '    CALL 增加羁绊(1, 2)',
  '',
].join('\n');

const BASE_TEXT = BASE.endsWith('\n') ? BASE : `${BASE}\n`;

const MARKER = '|';

/** 把 `|` 当光标：摘掉标记，算出 1 基行列，直接问纯模型。 */
function atMarker(
  textWithMarker: string,
  options: Kojo2SignatureOptions = {},
): { readonly source: string; readonly line: number; readonly column: number; readonly help: ReturnType<typeof kojo2SignatureAt> } {
  const at = textWithMarker.indexOf(MARKER);
  if (at < 0) throw new Error(`夹具里没有光标标记 ${MARKER}`);
  const source = textWithMarker.slice(0, at) + textWithMarker.slice(at + MARKER.length);
  return { source, ...pointOf(source, at), help: kojo2SignatureAt(source, pointOf(source, at), options) };
}

/** 0 基源偏移 → 1 基行列（换行只认 `\n`，CRLF 的 `\r` 留在行尾不影响列）。 */
function pointOf(source: string, offset: number): { readonly line: number; readonly column: number } {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}

/* ============================== `@巡` 的假 adapter ============================== */

const TEAM: ForeachCollectionDecl = {
  name: '队伍',
  kind: 'characters',
  elementType: 'character',
  base: 1,
  keyType: null,
  length: { kind: 'engine', counter: 'CHARANUM', minus: 1 },
  bindings: ['角', '名'],
  nameAccessor: 'CALLNAME',
};

const STATUS: ForeachCollectionDecl = {
  name: '状态',
  kind: 'records',
  elementType: 'int',
  base: 0,
  keyType: 'string',
  length: { kind: 'declared', size: 3 },
  bindings: ['项', '键'],
  nameAccessor: null,
};

const ARRAY_RULE: ForeachArrayRule = { base: 0, bindings: ['值', '下标'] };

const DECLARATIONS: ForeachDeclarations = { collections: [TEAM, STATUS], arrayRule: ARRAY_RULE };

interface AdapterOverrides {
  readonly foreach?: boolean;
  readonly declarations?: ForeachDeclarations | null;
}

/** 只填本模块真正读的两格（`programFeatures.foreach` / `foreachCollections`）；其余由类型断言兜。 */
function adapterOf(overrides: AdapterOverrides = {}): GameAdapter {
  return {
    programFeatures: { foreach: overrides.foreach ?? true },
    foreachCollections:
      overrides.declarations === undefined ? DECLARATIONS : overrides.declarations,
  } as unknown as GameAdapter;
}

const ADAPTER = adapterOf();

/* ============================== ① 调用位 ============================== */

describe('调用位：`! 函名(` / `! 模名(` / 表达式裸调用', () => {
  it('`! 增加羁绊(|目标, 12)`：签名 = 声明形参原文，首参高亮', () => {
    const at = atMarker(BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(|目标, 12)'));
    expect(at.help).not.toBeNull();
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.params.map((param) => param.label)).toEqual(['目标', '数值 = 10']);
    expect(signature.activeParameter).toBe(0);
    expect(at.help!.activeSignature).toBe(0);
  });

  it('逗号后 ⇒ 第 2 个形参（activeParameter = 1）', () => {
    const at = atMarker(BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)'));
    expect(at.help!.signatures[0]!.activeParameter).toBe(1);
  });

  it('实参多于形参 ⇒ 夹到最后一格（不假造第 3 槽）', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊(目标, 12, |3)\n`);
    const signature = at.help!.signatures[0]!;
    expect(signature.params).toHaveLength(2);
    expect(signature.activeParameter).toBe(1);
  });

  it('零形参函数：签名 = `无参()`，activeParameter 恒 0', () => {
    const at = atMarker(`${BASE_TEXT}! 无参(|)\n`);
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('无参()');
    expect(signature.params).toEqual([]);
    expect(signature.activeParameter).toBe(0);
  });

  it('模板调用：`! 娇羞退场(|"被夸奖")` ⇒ 形参 `原因`，说明写 `{原因}`', () => {
    const at = atMarker(BASE_TEXT.replace('! 娇羞退场("被夸奖")', '! 娇羞退场(|"被夸奖")'));
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('娇羞退场(原因)');
    expect(signature.params.map((param) => param.label)).toEqual(['原因']);
    expect(signature.params[0]!.documentation).toContain('{原因}');
  });

  it('函数默认值进标签与说明（`数值 = 10` / 默认值：10）', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊(|目标, 12)\n`);
    const second = at.help!.signatures[0]!.params[1]!;
    expect(second.label).toBe('数值 = 10');
    expect(second.documentation).toBe('默认值：10');
    expect(at.help!.signatures[0]!.params[0]!.documentation).toBe('必填');
  });

  it('表达式位置的裸调用同样给签名（`@算` 里的赋值右侧）', () => {
    const at = atMarker(
      BASE_TEXT.replace('已收 = 增加羁绊(目标, 12)', '已收 = 增加羁绊(目标, |12)'),
    );
    expect(at.help!.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(at.help!.signatures[0]!.activeParameter).toBe(1);
  });

  it('嵌套调用取**最内层**：`增加羁绊(取整(1, |2), 3)` ⇒ 取整', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊(取整(1, |2), 3)\n`);
    expect(at.help!.signatures[0]!.label).toBe('取整(值, 基数 = 1)');
    expect(at.help!.signatures[0]!.activeParameter).toBe(1);
  });

  it('内层已闭合后光标回外层：`增加羁绊(取整(1, 2), |3)` ⇒ 增加羁绊', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊(取整(1, 2), |3)\n`);
    expect(at.help!.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(at.help!.signatures[0]!.activeParameter).toBe(1);
  });

  it('字符串里的逗号不计：`("a,b", |2)` 仍是第 2 个形参', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊("a,b", |2)\n`);
    expect(at.help!.signatures[0]!.activeParameter).toBe(1);
  });

  it('字符串里的左括号不计：`("(", |2)` 仍是第 2 个形参', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊("(", |2)\n`);
    expect(at.help!.signatures[0]!.activeParameter).toBe(1);
  });

  it('光标落在字符串字面量里 ⇒ `null`（不猜）', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊("a,b|", 2)\n`);
    expect(at.help).toBeNull();
  });

  it('右括号之后（调用已写完）⇒ `null`', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊(目标, 12)|\n`);
    expect(at.help).toBeNull();
  });

  it('没有左括号（只写了被调名）⇒ `null`', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊|\n`);
    expect(at.help).toBeNull();
  });

  it('未声明的被调名 ⇒ `null`（不造假签名）', () => {
    const at = atMarker(`${BASE_TEXT}! 未声明函数(1, |2)\n`);
    expect(at.help).toBeNull();
  });

  it('池调用（声明存在但没有形参）⇒ `null`', () => {
    const at = atMarker(`${BASE_TEXT}! 早安问候(|)\n`);
    expect(at.help).toBeNull();
  });

  it('跨行调用：左括号开在上一行、光标在后面的实参行也认（回看窗口有界）', () => {
    const at = atMarker(`${BASE_TEXT}! 增加羁绊(\n    目标,\n    |12\n)\n`);
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.activeParameter).toBe(1);
  });

  it('越界行号 ⇒ `null`（不崩）', () => {
    expect(kojo2SignatureAt(BASE_TEXT, { line: 9_999, column: 1 })).toBeNull();
  });
});

/* ============================== ② 声明头 ============================== */

describe('声明头：`# 模` / `@函` 的形参与默认值', () => {
  it('`# 模 娇羞退场(|原因)` ⇒ 模板声明自己的形参', () => {
    const at = atMarker(BASE_TEXT.replace('# 模 娇羞退场(原因)', '# 模 娇羞退场(|原因)'));
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('娇羞退场(原因)');
    expect(signature.activeParameter).toBe(0);
    expect(signature.params[0]!.documentation).toContain('{原因}');
  });

  it('`@函 增加羁绊(目标, |数值=10)` ⇒ 第 2 个形参 + 默认值说明', () => {
    const at = atMarker(
      BASE_TEXT.replace('@函 增加羁绊(目标, 数值=10)', '@函 增加羁绊(目标, |数值=10)'),
    );
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.activeParameter).toBe(1);
    expect(signature.params[1]!.documentation).toBe('默认值：10');
  });

  it('`@函 增加羁绊(|目标, 数值=10)` ⇒ 第 1 个形参', () => {
    const at = atMarker(
      BASE_TEXT.replace('@函 增加羁绊(目标, 数值=10)', '@函 增加羁绊(|目标, 数值=10)'),
    );
    expect(at.help!.signatures[0]!.activeParameter).toBe(0);
  });

  it('声明头括号未闭合 ⇒ `null`（parser 还没有形参，不假造零形参签名）', () => {
    const at = atMarker(`${BASE_TEXT}# 模 待写(|\n`);
    expect(at.help).toBeNull();
  });

  it('`@函` 声明头括号未闭合 ⇒ `null`', () => {
    const at = atMarker(`${BASE_TEXT}@函 未完成(参数|\n`);
    expect(at.help).toBeNull();
  });

  it('零形参声明头也照常给签名（闭合括号是事实）', () => {
    const at = atMarker(BASE_TEXT.replace('@函 无参()', '@函 无参(|)'));
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('无参()');
    expect(signature.params).toEqual([]);
  });

  it('模板形参不编造默认值（core 明确拒绝 `# 模` 参数默认值，只取名字）', () => {
    const at = atMarker(`${BASE_TEXT}# 模 带默认(原因=1|\n`);
    // 括号未闭合 ⇒ 连形参都还不知道：不提示，更不把 `原因=1` 拆成默认值。
    expect(at.help).toBeNull();
    const closed = atMarker(`${BASE_TEXT}# 模 带默认(原|因=1)\n`);
    expect(closed.help!.signatures[0]!.label).toBe('带默认(原因)');
  });
});

/* ============================== ③ 位置门 ============================== */

describe('位置门：字符串 / `@原生` / 注释 / 台词正文 / 插值', () => {
  it('台词正文里的“调用”不提示', () => {
    const at = atMarker(BASE_TEXT.replace('今天来得', '增加羁绊(目标, |1)今天来得'));
    expect(at.help).toBeNull();
  });

  it('台词 `{…}` 插值内照常提示（插值是表达式位）', () => {
    const at = atMarker(BASE_TEXT.replace('{增加羁绊(目标, 1)}', '{增加羁绊(目标, |1)}'));
    expect(at.help!.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
  });

  it('`@原生` 体内不提示（原文不解释）', () => {
    const at = atMarker(BASE_TEXT.replace('CALL 增加羁绊(1, 2)', 'CALL 增加羁绊(1, |2)'));
    expect(at.help).toBeNull();
  });

  it('注释行不提示', () => {
    const at = atMarker(`${BASE_TEXT}// ! 增加羁绊(1, |2)\n`);
    expect(at.help).toBeNull();
  });

  it('空行不提示', () => {
    const at = atMarker(`${BASE_TEXT}|\n`);
    expect(at.help).toBeNull();
  });

  it('列号非法 / 非数字 ⇒ `null`', () => {
    expect(kojo2SignatureAt(BASE_TEXT, { line: 1, column: 0 })).toBeNull();
    expect(kojo2SignatureAt(BASE_TEXT, { line: 1, column: Number.NaN })).toBeNull();
    expect(kojo2SignatureAt('', { line: 1, column: 1 })).toBeNull();
  });
});

/* ============================== ④ `@巡` ============================== */

describe('`@巡` 集合名：绑定名与来源槽（集合声明全部经 core 计划）', () => {
  it('角色集合 `队伍` ⇒ `{角}` / `{名}`（说明写角色号 / 名字）', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'), { adapter: ADAPTER });
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('@巡 队伍(角, 名)');
    expect(signature.params.map((param) => param.label)).toEqual(['角', '名']);
    expect(signature.params[0]!.documentation).toContain('{角}');
    expect(signature.params[0]!.documentation).toContain('角色号');
    expect(signature.params[1]!.documentation).toContain('{名}');
    expect(signature.activeParameter).toBe(0);
  });

  it('作者数组 `记录`（长度经 `# 常量 容量`）⇒ `{值}` / `{下标}`', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 记录', '@巡 记|录'), { adapter: ADAPTER });
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('@巡 记录(值, 下标)');
    expect(signature.params[0]!.documentation).toContain('{值}');
    expect(signature.params[0]!.documentation).toContain('整数');
  });

  it('键值集合 `状态` ⇒ `{项}` / `{键}`', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 状态', '@巡 状|态'), { adapter: ADAPTER });
    expect(at.help!.signatures[0]!.label).toBe('@巡 状态(项, 键)');
  });

  it('未声明的集合 ⇒ `null`（不猜绑定名）', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 不存在', '@巡 不|存在'), { adapter: ADAPTER });
    expect(at.help).toBeNull();
  });

  it('没有 adapter ⇒ `null`（集合名不可解析）', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'));
    expect(at.help).toBeNull();
  });

  it('adapter 明确关闭 `programFeatures.foreach` ⇒ `null`', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'), {
      adapter: adapterOf({ foreach: false }),
    });
    expect(at.help).toBeNull();
  });

  it('集合重复声明（core 判不出来该用哪条）⇒ `null`', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'), {
      adapter: adapterOf({ declarations: { collections: [TEAM, TEAM], arrayRule: ARRAY_RULE } }),
    });
    expect(at.help).toBeNull();
  });

  it('绑定自相矛盾（只声明 `{名}` 没有 `{角}`）⇒ `null`', () => {
    const broken: ForeachCollectionDecl = { ...TEAM, bindings: ['名'] };
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'), {
      adapter: adapterOf({ declarations: { collections: [broken], arrayRule: null } }),
    });
    expect(at.help).toBeNull();
  });

  it('光标停在 `@巡` 词上（还没到集合名）⇒ `null`', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@|巡 队伍'), { adapter: ADAPTER });
    expect(at.help).toBeNull();
  });

  it('光标在集合名之后的同行余量里也认（边界）', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队伍|'), { adapter: ADAPTER });
    expect(at.help!.signatures[0]!.label).toBe('@巡 队伍(角, 名)');
  });

  it('数组规则缺席时作者数组不可遍历 ⇒ `null`', () => {
    const at = atMarker(BASE_TEXT.replace('@巡 记录', '@巡 记|录'), {
      adapter: adapterOf({ declarations: { collections: [TEAM], arrayRule: null } }),
    });
    expect(at.help).toBeNull();
  });
});

/* ============================== ⑤ CRLF / 中文 ============================== */

describe('CRLF / 中文：同一份源码换 EOL 后读数不变', () => {
  it('CRLF 下的调用位与 activeParameter 与 LF 一致', () => {
    const crlf = BASE_TEXT.replace(/\n/g, '\r\n');
    const at = atMarker(crlf.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)'));
    const signature = at.help!.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.activeParameter).toBe(1);
  });

  it('CRLF 下的模板调用（中文名）与 LF 一致', () => {
    const crlf = BASE_TEXT.replace(/\n/g, '\r\n');
    const at = atMarker(crlf.replace('! 娇羞退场("被夸奖")', '! 娇羞退场(|"被夸奖")'));
    expect(at.help!.signatures[0]!.label).toBe('娇羞退场(原因)');
  });

  it('CRLF 下的 `@巡` 集合名与 LF 一致', () => {
    const crlf = BASE_TEXT.replace(/\n/g, '\r\n');
    const at = atMarker(crlf.replace('@巡 队伍', '@巡 队|伍'), { adapter: ADAPTER });
    expect(at.help!.signatures[0]!.label).toBe('@巡 队伍(角, 名)');
  });

  it('参数标签必须逐字出现在签名串里（编辑器靠它在整串上定位高亮）', () => {
    const at = atMarker(BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)'));
    const signature = at.help!.signatures[0]!;
    for (const param of signature.params) expect(signature.label).toContain(param.label);
  });
});

/* ============================== ⑥ 回看窗口 + 夹取（B3d 新钉的两条口径） ============================== */

describe('跨行回看上限与 `activeParameter` 夹取（搬进包时补的两条真断言）', () => {
  /** 64 行回看窗口：`! 增加羁绊(` 之后垫 N 行实参，再看光标。 */
  function callWithFill(fill: number): string {
    const rows = Array.from({ length: fill }, (_, i) => `    > 填充 ${i + 1}`);
    return `${BASE_TEXT}! 增加羁绊(\n${rows.join('\n')}\n    |12\n)\n`;
  }

  it('左括号在 64 行窗口内 ⇒ 仍认这次调用', () => {
    const at = atMarker(callWithFill(60));
    expect(at.help!.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
  });

  it('左括号超出 64 行窗口 ⇒ `null`（回看必须封顶，否则每次击键都可能是整篇扫描）', () => {
    const at = atMarker(callWithFill(80));
    expect(at.help).toBeNull();
  });

  it('`clampActiveParameter`：零形参恒 0、负数归 0、越界夹到最后一格', () => {
    expect(clampActiveParameter(5, 0)).toBe(0);
    expect(clampActiveParameter(-3, 4)).toBe(0);
    expect(clampActiveParameter(0, 4)).toBe(0);
    expect(clampActiveParameter(3, 4)).toBe(3);
    expect(clampActiveParameter(99, 4)).toBe(3);
  });
});
