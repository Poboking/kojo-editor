/**
 * K2-LSP-SIGNATURE · `kojo2` 签名帮助的行为闸。
 *
 * 覆盖面（每条都钉一个**事实口径**，不复写语法实现）：
 * - 调用位：`! 函名(` / `! 模名(` / 表达式位裸调用；嵌套调用取最内层；
 * - `activeParameter`：按顶层逗号数，字符串 / 括号 / 嵌套调用里的逗号不计；越界夹到最后一格；
 * - 声明头：`# 模 名(…)` / `@函 名(…)` 的形参与默认值（默认值来自声明索引的同一份事实）；
 * - `@巡` 集合名：集合声明的绑定名 + 来源槽；未声明 / adapter 缺席 / 能力关闭 ⇒ `null`；
 * - 位置门：字符串 / `@原生` / 注释 / 台词正文 ⇒ `null`，`{…}` 插值内照常；
 * - provider 形状：只挂 `kojo2`、触发字符 `['(', ',']`（合并去重）、dispose 幂等、flag 关零注册；
 * - CRLF / 中文：同一份夹具换 EOL 后读数不变。
 *
 * 夹具里每类声明只留一条；期望值以**声明索引 + core 的 `@巡` 计划语义**为准，测试不另写
 * 一套形参解析（两套判据比没测更坏）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ForeachArrayRule,
  ForeachCollectionDecl,
  ForeachDeclarations,
  GameAdapter,
} from '@kojo/kojo-core';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import {
  KOJO2_SIGNATURE_TRIGGER_CHARS,
  installKojo2SignatureHelpProvider,
  kojo2SignatureAt,
  kojo2SignatureHelpOf,
  mergeTriggerCharacters,
  type Kojo2SignatureOptions,
} from '../src/monaco/kojo2-signature';

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

/** 在夹具末尾追加一行（括号未闭合 / 未声明调用这类"半成品"不会污染前面已解析的声明）。 */
function appended(line: string): string {
  return `${BASE_TEXT}${line}\n`;
}

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

/* ============================== 假 Monaco / 假 model ============================== */

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const CONTEXT = {
  triggerKind: 1,
  triggerCharacter: '(',
  isRetrigger: false,
} as unknown as Monaco.languages.SignatureHelpContext;

interface Registration {
  readonly selector: unknown;
  readonly provider: Monaco.languages.SignatureHelpProvider;
}

function fakeMonaco(failDispose = false): {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: number;
} {
  const registrations: Registration[] = [];
  const counter = { calls: 0 };
  const fake = {
    languages: {
      registerSignatureHelpProvider: (selector: unknown, provider: Monaco.languages.SignatureHelpProvider) => {
        registrations.push({ selector, provider });
        return {
          dispose: () => {
            if (failDispose) throw new Error('桩：撤 provider 抛错');
            counter.calls++;
          },
        };
      },
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    registrations,
    get disposeCalls() {
      return counter.calls;
    },
  };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakGetValue: () => void;
}

function fakeModel(text: string): FakeModel {
  let broken = false;
  const rows = text.split(/\r\n|\r|\n/);
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineContent: (line: number) => rows[line - 1] ?? '',
    getLineCount: () => rows.length,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    uri: { scheme: 'file', path: '/proj/chara.kojo2', fsPath: '/proj/chara.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    breakGetValue: () => {
      broken = true;
    },
  };
}

/** 1 基行列 → model + position。 */
function atPoint(source: string, line: number, column: number): {
  readonly model: Monaco.editor.ITextModel;
  readonly position: Monaco.Position;
} {
  return { model: fakeModel(source).model, position: { lineNumber: line, column } as Monaco.Position };
}

/** provider 的“取一次帮助”捷径（4 参协议只用前两个）。 */
function helpOf(
  provider: Monaco.languages.SignatureHelpProvider,
  source: string,
  line: number,
  column: number,
): Monaco.languages.SignatureHelp | undefined {
  const at = atPoint(source, line, column);
  return helpAtModel(provider, at.model, line, column);
}

/** 同上，但 model 由调用方给（取文抛错 / 已释放模型用这一条）。 */
function helpAtModel(
  provider: Monaco.languages.SignatureHelpProvider,
  model: Monaco.editor.ITextModel,
  line: number,
  column: number,
): Monaco.languages.SignatureHelp | undefined {
  const result = provider.provideSignatureHelp(
    model,
    { lineNumber: line, column } as Monaco.Position,
    TOKEN,
    CONTEXT,
  ) as Monaco.languages.SignatureHelpResult | undefined;
  return result?.value;
}

/* ============================== flag 桩 ============================== */

const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('参数标签必须逐字出现在签名串里（Monaco 靠它在整串上定位高亮）', () => {
    const at = atMarker(BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)'));
    const signature = at.help!.signatures[0]!;
    for (const param of signature.params) expect(signature.label).toContain(param.label);
  });
});

/* ============================== ⑥ provider ============================== */

describe('provider：只挂 kojo2、触发字符、dispose、不读开关', () => {
  it('缺省档（v1-only）⇒ 照样注册一枚；句柄可重复 dispose（只撤一次）', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    expect(fake.registrations).toHaveLength(1);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(fake.disposeCalls).toBe(1);
  });

  it('flag 开 ⇒ 恰好一枚注册，selector = kojo2', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(KOJO2_LANGUAGE_ID).toBe('kojo2');
  });

  it('触发字符 = `(` / `,`（与任务书一致）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    expect(fake.registrations[0]!.provider.signatureHelpTriggerCharacters).toEqual([
      ...KOJO2_SIGNATURE_TRIGGER_CHARS,
    ]);
    expect([...KOJO2_SIGNATURE_TRIGGER_CHARS]).toEqual(['(', ',']);
  });

  it('既有清单与基础清单**合并去重**（追加 `)` 与重复的 `,`）', () => {
    expect(mergeTriggerCharacters(KOJO2_SIGNATURE_TRIGGER_CHARS, [',', ')'])).toEqual([
      '(',
      ',',
      ')',
    ]);
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, {
      adapter: ADAPTER,
      extraTriggerCharacters: [')', ','],
    });
    expect(fake.registrations[0]!.provider.signatureHelpTriggerCharacters).toEqual([
      '(',
      ',',
      ')',
    ]);
  });

  it('provider 返回 Monaco 形状：parameters + documentation + 顶层 activeParameter', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    const source = BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)');
    const at = atMarker(source);
    const help = helpOf(fake.registrations[0]!.provider, at.source, at.line, at.column);
    expect(help).toBeDefined();
    expect(help!.activeSignature).toBe(0);
    expect(help!.activeParameter).toBe(1);
    const signature = help!.signatures[0]!;
    expect(signature.label).toBe('增加羁绊(目标, 数值 = 10)');
    expect(signature.parameters.map((param) => param.label)).toEqual(['目标', '数值 = 10']);
    expect(signature.parameters[1]!.documentation).toBe('默认值：10');
    expect(signature.activeParameter).toBe(1);
  });

  it('provider 对“无签名位”回 `undefined`（不返回空 signatures 占住提示）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    const at = atMarker(`${BASE_TEXT}! 未声明函数(1, |2)\n`);
    expect(helpOf(fake.registrations[0]!.provider, at.source, at.line, at.column)).toBeUndefined();
  });

  it('取文抛错 ⇒ `undefined`（不抛进击键路径）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    const broken = fakeModel(BASE_TEXT);
    broken.breakGetValue();
    expect(helpAtModel(fake.registrations[0]!.provider, broken.model, 1, 1)).toBeUndefined();
  });

  it('dispose 幂等：两次只撤一次；撤不掉也不外抛', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2SignatureHelpProvider(fake.monaco, { adapter: ADAPTER });
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toBe(1);

    stubFlag(true);
    const throwing = fakeMonaco(true);
    const second = installKojo2SignatureHelpProvider(throwing.monaco, { adapter: ADAPTER });
    expect(() => second.dispose()).not.toThrow();
  });

  it('adapter getter 形态在请求时现取（`@巡` 走 getter）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const getter = vi.fn(() => ADAPTER);
    installKojo2SignatureHelpProvider(fake.monaco, { adapter: getter });
    const at = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'));
    const help = helpOf(fake.registrations[0]!.provider, at.source, at.line, at.column);
    expect(help!.signatures[0]!.label).toBe('@巡 队伍(角, 名)');
    expect(getter).toHaveBeenCalled();
  });

  it('adapter getter 抛错 ⇒ 只是 `@巡` 那一路不应答，同文件签名照常', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2SignatureHelpProvider(fake.monaco, {
      adapter: () => {
        throw new Error('桩：adapter 取失败');
      },
    });
    const foreach = atMarker(BASE_TEXT.replace('@巡 队伍', '@巡 队|伍'));
    expect(helpOf(fake.registrations[0]!.provider, foreach.source, foreach.line, foreach.column)).toBeUndefined();
    const call = atMarker(BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)'));
    expect(helpOf(fake.registrations[0]!.provider, call.source, call.line, call.column)!.signatures[0]!.label).toBe(
      '增加羁绊(目标, 数值 = 10)',
    );
  });

  it('`kojo2SignatureHelpOf` 可单独调用（不注册也能算）', () => {
    const at = atMarker(BASE_TEXT.replace('! 增加羁绊(目标, 12)', '! 增加羁绊(目标, |12)'));
    const help = kojo2SignatureHelpOf(atPoint(at.source, at.line, at.column).model, {
      lineNumber: at.line,
      column: at.column,
    } as Monaco.Position);
    expect(help!.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
  });
});
