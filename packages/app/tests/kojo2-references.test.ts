/**
 * K2-LSP-REFS · `kojo2` 查找全部引用（Shift+F12）的闸。
 *
 * 覆盖面（纯逻辑 + Monaco 翻译层两层一起钉）：
 * 1. **符号面**：七类声明（`# 幕 / 变量 / 常量 / 表 / 池 / 模`、`@函`）+ 事件名
 *    （`# 机` 声明 / `@织` 监听）；声明位 → 同一符号 + 精确 `declSpan`；
 * 2. **可证引用位**：`{…}` 插值（台词 / 旁白 / 模体）、`! 名` / `! 名(实参)` 调用、
 *    `@巡` 集合、`# 表 由 <表达式>`、`? 条件`、`@算` 赋值两侧 / 裸调用、`@返` 返回值、
 *    `@着色` 颜色表达式、`# 变量` 类型里的 `[<数组长度>]`；
 * 3. **不误报**：正文纯文本、注释行、`@原生` 体、双引号字符串、`对象.成员` 的成员名、
 *    表体字面量、`# 视` 名字、`? 否`、空白位 → 一律 `null` 或不进 `refs`；
 * 4. **结果形状**：源码序、去重、`decl` / `ref` / `call` 三档角色、`declSpan` 覆盖整段
 *    `# 幕` 标题（标题里可以有空格）；
 * 5. **上限**：`KOJO2_REFERENCE_LIMIT` 截断 + `truncated` 显式标记；恰好到上限不标截断；
 * 6. **边界**：CRLF 与 LF 同结果、`getIndex` 注入（正常 / 抛错 / 回 null）、确定性、
 *    空源 / 非法位 / 越界位 → `null`；
 * 7. **provider**：只挂 `kojo2`、flag 关零注册、dispose 幂等且不抛、注册失败外抛、
 *    取文失败 / 无 uri 回 `[]`、`includeDeclaration === false` 去掉声明位。
 *
 * 期望值全部从同一份声明索引（`kojo2DocumentOf`）与夹具原文位置算，不在测试里复写行号。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  kojo2DocumentOf,
  type Kojo2Declaration,
} from '@kojo/kojo-lang';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import {
  KOJO2_REFERENCE_LIMIT,
  installKojo2ReferenceProvider,
  kojo2ReferencesAt,
  type Kojo2ReferencePosition,
  type Kojo2ReferenceSpan,
  type Kojo2ReferenceSymbolKind,
} from '../src/monaco/kojo2-references';

const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 引用查找夹具。刻意把"同一个名字的可证位 / 不可证位"写在相邻行：
 * - `心情` 在表声明、插值、条件里各命中一次，在台词正文与注释里不命中；
 * - `指令` 在 `# 机` / `@织` 各命中一次，在台词正文与注释里不命中；
 * - `今天已触发` 在插值、赋值两侧、成员名（`我.今天已触发`）上区分 `ref` 与不命中；
 * - `亲近线` 在 `# 表 由` 与 `@返` 里各命中一次。
 */
const SOURCE = [
  '// 引用查找夹具：声明位 / 引用位 / 不误报位',
  '# 幕 神社 清晨',
  '# 视 旅人',
  '# 机 指令 310',
  '',
  '# 常量 亲近线 整数 = 500',
  '# 变量 今天已触发 整数 = 0 存档',
  '# 变量 队伍 整数[4]',
  '',
  '# 表 心情 由 亲近线',
  '    0..99 疏远',
  '    100..499 平常',
  '    否 未知',
  '',
  '# 池 早安问候',
  '    ? 好感 < 100',
  '        「……早。」',
  '    ? 否',
  '        「早上好。」',
  '',
  '# 模 娇羞退场(原因)',
  '    > （她红着脸，因为{原因}而不知所措）',
  '    [插槽]',
  '    > （随后匆匆跑开了）',
  '',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 目标 + 亲近线',
  '',
  '@织 指令 之后',
  '    > （事件之后的旁白）',
  '',
  '> 晨光透过鸟居，{今天已触发} 次。',
  '旅人：「{心情}今天来得挺早嘛。」',
  '旅人：「心情不错，指令也清楚。」',
  '@算',
  '    今天已触发 = 1',
  '    ? 心情 == "今天已触发"',
  '        > 她看了你一眼。',
  '    ! 早安问候',
  '    @巡 队伍',
  '        > 一个接一个。',
  '    ! 增加羁绊(目标, 12)',
  '    增加羁绊(目标, 1)',
  '    今天已触发 = 我.今天已触发',
  '',
  '! 早安问候',
  '! 娇羞退场("心情")',
  '',
  '@原生',
  '    CALL 心情',
  '// 注释里提到 心情 / 今天已触发 / 指令',
].join('\n');

const DOCUMENT = kojo2DocumentOf(SOURCE);
const ROWS = SOURCE.split('\n');

/* ============================== 位置小工具 ============================== */

/** 0 基源偏移 → 1 基行列（夹具只含 LF，切行即物理行）。 */
function positionAtOffset(source: string, offset: number): Kojo2ReferencePosition {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}

/** `needle` 第 `from` 位之后的首个出现 → 1 基行列；`offsetInNeedle` 指定词内第几位。 */
function positionAt(needle: string, from = 0, offsetInNeedle = 0): Kojo2ReferencePosition {
  return positionIn(SOURCE, needle, from, offsetInNeedle);
}

function positionIn(
  source: string,
  needle: string,
  from = 0,
  offsetInNeedle = 0,
): Kojo2ReferencePosition {
  const at = source.indexOf(needle, from);
  if (at < 0) throw new Error(`夹具里找不到 ${needle}`);
  return positionAtOffset(source, at + offsetInNeedle);
}

/** 夹具里某条声明（同名只有一条；缺了当场红）。 */
function declarationOf(name: string): Kojo2Declaration {
  const found = DOCUMENT.declarations.find((declaration) => declaration.name === name);
  if (found === undefined) throw new Error(`夹具缺少声明 ${name}`);
  return found;
}

/** 声明名字段首列 → 查询位。 */
function atDeclaration(name: string): Kojo2ReferencePosition {
  const declaration = declarationOf(name);
  return { line: declaration.line, column: declaration.nameStart };
}

/** 一次查询；`null` 由调用方断言。 */
function refsAt(position: Kojo2ReferencePosition) {
  return kojo2ReferencesAt(SOURCE, position);
}

/** 一定有结果的查询（失败即测试失败）。 */
function found(position: Kojo2ReferencePosition) {
  const result = refsAt(position);
  if (result === null) throw new Error(`位置 ${position.line}:${position.column} 没有符号`);
  return result;
}

/** span 覆盖的原文（用于断言"落点是哪个词"）。 */
function textOf(span: Kojo2ReferenceSpan): string {
  const line = ROWS[span.startLine - 1] ?? '';
  return line.slice(span.startColumn - 1, span.endColumn - 1);
}

/** 结果里的出现点角色序列。 */
function rolesOf(position: Kojo2ReferencePosition): string[] {
  return found(position).refs.map((site) => site.kind);
}

/** 结果里的出现点行号序列。 */
function linesOf(position: Kojo2ReferencePosition): number[] {
  return found(position).refs.map((site) => site.span.startLine);
}

/* ============================== 假 Monaco / 假 model ============================== */

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

interface Registration {
  readonly selector: unknown;
  readonly provider: unknown;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  /** 注册句柄被撤的次数（幂等 / 零注册判据） */
  readonly disposeCount: () => number;
}

interface FakeMonacoOptions {
  /** 让注册抛错（验错误外抛） */
  readonly failRegister?: boolean;
  /** 让注册句柄的 dispose 抛错（验卸载不抛） */
  readonly failDispose?: boolean;
}

function fakeMonaco(options: FakeMonacoOptions = {}): FakeMonaco {
  const registrations: Registration[] = [];
  let disposeCount = 0;
  const monaco = {
    languages: {
      registerReferenceProvider: (selector: unknown, provider: unknown) => {
        if (options.failRegister === true) throw new Error('桩：注册引用 provider 抛错');
        registrations.push({ selector, provider });
        return {
          dispose: () => {
            if (options.failDispose === true) throw new Error('桩：撤引用 provider 抛错');
            disposeCount++;
          },
        };
      },
    },
  };
  return {
    monaco: monaco as unknown as typeof Monaco,
    registrations,
    disposeCount: () => disposeCount,
  };
}

interface FakeModelOptions {
  /** 不给 uri（模拟没有文件身份的桩 model） */
  readonly withoutUri?: boolean;
}

function fakeModel(text: string, options: FakeModelOptions = {}) {
  let broken = false;
  const uri = {
    scheme: 'file',
    path: 'D:/proj/kojo2-reference.kojo2',
    fsPath: 'D:/proj/kojo2-reference.kojo2',
    toString: () => 'file:///D:/proj/kojo2-reference.kojo2',
  };
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    isDisposed: () => broken,
    ...(options.withoutUri === true ? {} : { uri }),
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    breakModel: () => {
      broken = true;
    },
  };
}

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

function providerOf(fake: FakeMonaco): Monaco.languages.ReferenceProvider {
  const registration = fake.registrations[0];
  if (registration === undefined) throw new Error('没有注册 ReferenceProvider');
  return registration.provider as Monaco.languages.ReferenceProvider;
}

function provideReferences(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  position: Kojo2ReferencePosition,
  includeDeclaration = true,
): Monaco.languages.Location[] {
  return providerOf(fake).provideReferences(
    model,
    { lineNumber: position.line, column: position.column } as Monaco.Position,
    { includeDeclaration } as Monaco.languages.ReferenceContext,
    TOKEN,
  ) as Monaco.languages.Location[];
}

/** flag 开 + 安装一枚 provider（返回假 monaco 与 disposable）。 */
function installForTest(options: Parameters<typeof installKojo2ReferenceProvider>[1] = {}) {
  stubFlag(true);
  const fake = fakeMonaco();
  const disposable = installKojo2ReferenceProvider(fake.monaco, options);
  return { fake, disposable };
}

/* ============================== ① 符号面：七类声明 + 事件 + 幕 ============================== */

const DECLARATION_CASES: readonly { readonly name: string; readonly kind: Kojo2ReferenceSymbolKind }[] = [
  { name: '神社 清晨', kind: 'scene' },
  { name: '亲近线', kind: 'constant' },
  { name: '今天已触发', kind: 'variable' },
  { name: '队伍', kind: 'variable' },
  { name: '心情', kind: 'table' },
  { name: '早安问候', kind: 'pool' },
  { name: '娇羞退场', kind: 'template' },
  { name: '增加羁绊', kind: 'function' },
];

describe('符号面：声明位 → 同一符号 + 精确名字段', () => {
  it.each(DECLARATION_CASES)(
    '$name（$kind）声明处查得到自己，declSpan = 名字段',
    ({ name, kind }) => {
      const declaration = declarationOf(name);
      const result = found(atDeclaration(name));
      expect(result.symbol.name).toBe(name);
      expect(result.symbol.kind).toBe(kind);
      expect(result.symbol.declSpan).toEqual({
        startLine: declaration.line,
        startColumn: declaration.nameStart,
        endLine: declaration.line,
        endColumn: declaration.nameEnd,
      });
      expect(result.refs[0]?.kind).toBe('decl');
    },
  );

  it('`# 幕` 标题含空格时，光标落在标题第二个词上也认得（区间覆盖整段标题）', () => {
    const result = found(positionAt('清晨'));
    expect(result.symbol.name).toBe('神社 清晨');
    expect(result.symbol.kind).toBe('scene');
    expect(textOf(result.symbol.declSpan)).toBe('神社 清晨');
  });

  it('`# 机` 事件名 → 事件符号，`@织` 是它的 ref', () => {
    // `# 机` 不在声明索引里：事件符号由事件挂点单独成组。
    const atMachine = positionAt('# 机 指令 310', 0, 4);
    const result = found(atMachine);
    expect(result.symbol.name).toBe('指令');
    expect(result.symbol.kind).toBe('event');
    expect(result.symbol.declSpan.startLine).toBe(4);
    expect(textOf(result.symbol.declSpan)).toBe('指令');
    expect(rolesOf(atMachine)).toEqual(['decl', 'ref']);
    expect(linesOf(atMachine)).toEqual([4, 29]);
  });

  it('`@织` 事件名与 `# 机` 解析到同一条事件符号（declSpan 仍指 `# 机`）', () => {
    const atWeave = positionAt('@织 指令', 0, 3);
    const atMachine = positionAt('# 机 指令 310', 0, 4);
    const result = found(atWeave);
    expect(result.symbol).toEqual(found(atMachine).symbol);
    expect(textOf(result.symbol.declSpan)).toBe('指令');
  });

  it('没有 `# 机` 时以最早一条 `@织` 作锚点，两条监听都进 refs', () => {
    const source = [
      '# 幕 某个清晨',
      '@织 指令 之后',
      '    > 一。',
      '@织 指令 之前',
      '    > 二。',
    ].join('\n');
    const position = positionIn(source, '@织 指令', 0, 3);
    const result = kojo2ReferencesAt(source, position);
    expect(result).not.toBeNull();
    expect(result?.symbol.kind).toBe('event');
    expect(result?.symbol.declSpan.startLine).toBe(2);
    expect(result?.refs).toHaveLength(2);
    expect(result?.refs.map((site) => site.kind)).toEqual(['ref', 'ref']);
  });

  it('同名事件与变量是两枚符号（`# 机 指令` 与 `# 变量 指令` 不互相串）', () => {
    const source = [
      '# 机 指令 310',
      '# 变量 指令 整数 = 0',
      '@算',
      '    指令 = 1',
    ].join('\n');
    const atEvent = positionIn(source, '# 机 指令', 0, 4);
    const atVariable = positionIn(source, '指令', source.indexOf('# 变量'));
    const event = kojo2ReferencesAt(source, atEvent);
    const variable = kojo2ReferencesAt(source, atVariable);
    expect(event?.symbol.kind).toBe('event');
    expect(event?.refs.map((site) => site.span.startLine)).toEqual([1]);
    expect(variable?.symbol.kind).toBe('variable');
    expect(variable?.refs.map((site) => site.span.startLine)).toEqual([2, 4]);
    expect(kojo2ReferencesAt(source, positionIn(source, '指令 = 1'))).toEqual(variable);
  });

  it('幕标题与变量同名是合法文件：幕与变量不互相串（幕标题不进表达式名单）', () => {
    const source = [
      '# 幕 日常',
      '# 变量 日常 整数 = 0',
      '@算',
      '    日常 = 1',
    ].join('\n');
    const scene = kojo2ReferencesAt(source, positionIn(source, '# 幕 日常', 0, 4));
    const variable = kojo2ReferencesAt(source, positionIn(source, '日常', source.indexOf('# 变量')));
    expect(scene?.symbol.kind).toBe('scene');
    expect(scene?.refs).toHaveLength(1);
    expect(variable?.symbol.kind).toBe('variable');
    expect(variable?.refs.map((site) => site.span.startLine)).toEqual([2, 4]);
  });

  it('两幕同标题：各自只查到自己那一条（幕按具体符号归属）', () => {
    const source = ['# 幕 日常', '> 一。', '# 幕 日常', '> 二。'].join('\n');
    const first = kojo2ReferencesAt(source, positionIn(source, '# 幕 日常', 0, 4));
    const secondAt = source.lastIndexOf('# 幕 日常') + 4;
    const second = kojo2ReferencesAt(source, positionAtOffset(source, secondAt));
    expect(first?.refs.map((site) => site.span.startLine)).toEqual([1]);
    expect(second?.refs.map((site) => site.span.startLine)).toEqual([3]);
  });
});

/* ============================== ② 可证引用位 ============================== */

describe('可证引用位：插值 / 调用 / 表达式', () => {
  it('台词插值 `{心情}` → 表声明（区间是插值里的名字，不是花括号）', () => {
    const result = found(positionAt('{心情}', 0, 1));
    expect(result.symbol.name).toBe('心情');
    expect(result.refs.map((site) => site.kind)).toEqual(['decl', 'ref', 'ref']);
    expect(textOf(result.refs[1]!.span)).toBe('心情');
    expect(linesOf(positionAt('心情'))).toEqual([10, 33, 37]);
  });

  it('旁白插值 `{今天已触发}` → 变量声明', () => {
    const result = found(positionAt('{今天已触发}', 0, 1));
    expect(result.symbol.name).toBe('今天已触发');
    expect(result.symbol.kind).toBe('variable');
    expect(result.refs.some((site) => site.span.startLine === 32)).toBe(true);
  });

  it('`! 名` 调用 → `call` 角色', () => {
    const result = found(positionAt('! 早安问候', 0, 2));
    expect(rolesOf(positionAt('! 早安问候', 0, 2))).toEqual(['decl', 'call', 'call']);
    expect(result.refs.map((site) => site.span.startLine)).toEqual([15, 39, 46]);
  });

  it('`! 名(实参)` 调用 → `call` 角色（实参里的字符串不进 refs）', () => {
    const result = found(positionAt('! 娇羞退场', 0, 2));
    expect(result.symbol.name).toBe('娇羞退场');
    expect(rolesOf(positionAt('! 娇羞退场', 0, 2))).toEqual(['decl', 'call']);
    expect(result.refs.some((site) => site.span.startLine === 47)).toBe(true);
  });

  it('`@巡 名` 的集合表达式 → `ref`', () => {
    const result = found(positionAt('@巡 队伍', 0, 3));
    expect(result.symbol.name).toBe('队伍');
    expect(rolesOf(positionAt('@巡 队伍', 0, 3))).toEqual(['decl', 'ref']);
    expect(result.refs[1]?.span.startLine).toBe(40);
  });

  it('`# 表 由 <表达式>` 的由后表达式 → `ref`', () => {
    const result = found(positionAt('# 表 心情 由 亲近线', 0, 10));
    expect(result.symbol.name).toBe('亲近线');
    expect(result.symbol.kind).toBe('constant');
    expect(rolesOf(positionAt('# 表 心情 由 亲近线', 0, 10))).toEqual(['decl', 'ref', 'ref']);
    expect(result.refs.map((site) => site.span.startLine)).toEqual([6, 10, 27]);
  });

  it('`? <条件>` 的条件表达式 → `ref`', () => {
    const result = found(positionAt('? 心情 ==', 0, 2));
    expect(result.symbol.name).toBe('心情');
    expect(result.refs.some((site) => site.span.startLine === 37)).toBe(true);
  });

  it('`@算` 体里的赋值左侧 → `ref`', () => {
    const result = found(positionAt('今天已触发 = 1'));
    expect(result.symbol.name).toBe('今天已触发');
    expect(result.refs.some((site) => site.span.startLine === 36)).toBe(true);
  });

  it('`@算` 体里的裸调用 → `call` 角色', () => {
    const result = found(positionAt('增加羁绊(目标, 1)', 0, 0));
    expect(result.symbol.name).toBe('增加羁绊');
    expect(rolesOf(positionAt('增加羁绊(目标, 1)', 0, 0))).toEqual(['decl', 'call', 'call']);
    expect(result.refs.map((site) => site.span.startLine)).toEqual([26, 42, 43]);
  });

  it('`@返 <表达式>` 的返回值表达式 → `ref`', () => {
    const result = found(positionAt('@返 目标 + 亲近线', 0, 8));
    expect(result.symbol.name).toBe('亲近线');
    expect(result.refs.some((site) => site.span.startLine === 27)).toBe(true);
  });

  it('`@着色 <颜色表达式>` → `ref`（颜色不是字面量时也认）', () => {
    const source = [
      '# 变量 主色 整数 = 0',
      '@着色 主色',
      '    > （红光照在脸上）',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '主色'));
    expect(result?.symbol.name).toBe('主色');
    expect(result?.refs.map((site) => site.kind)).toEqual(['decl', 'ref']);
    expect(result?.refs[1]?.span.startLine).toBe(2);
  });

  it('`# 变量` 类型里的 `[<数组长度>]` 可引用整数常量', () => {
    const source = [
      '# 常量 上限 整数 = 4',
      '# 变量 队伍 整数[上限]',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '上限'));
    expect(result?.symbol.name).toBe('上限');
    expect(result?.symbol.kind).toBe('constant');
    expect(result?.refs.map((site) => site.kind)).toEqual(['decl', 'ref']);
    expect(result?.refs[1]?.span.startLine).toBe(2);
  });

  it('`@函` 体内嵌套 `@算`：语句仍按表达式位收集（缩进栈逐层归位）', () => {
    const source = [
      '# 变量 计数 整数 = 0',
      '@函 加一()',
      '    @算',
      '        计数 = 计数 + 1',
      '    @返 计数',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '计数'));
    expect(result?.symbol.name).toBe('计数');
    expect(result?.refs.map((site) => site.span.startLine)).toEqual([1, 4, 4, 5]);
  });

  it('`# 模` 体插值里的参数名不是文件符号（不归给任何声明）', () => {
    // `{原因}` 是模的参数，不是文件级符号：没有可归属的声明 ⇒ null。
    expect(refsAt(positionAt('{原因}', 0, 1))).toBeNull();
  });

  it('`@织` 修饰词 / `# 机` 事件参数不是引用位', () => {
    // `之后`（修饰词）与 `310`（事件参数）都没有对应符号。
    expect(refsAt(positionAt('@织 指令 之后', 0, 7))).toBeNull();
    expect(refsAt(positionAt('# 机 指令 310', 0, 7))).toBeNull();
  });
});

/* ============================== ③ 不误报 ============================== */

describe('不误报：正文 / 字符串 / 成员 / 字面量 / 非本批符号', () => {
  it('台词正文里的名字（与声明同名）不产生引用', () => {
    expect(refsAt(positionAt('心情不错'))).toBeNull();
    expect(refsAt(positionAt('指令也清楚', 0, 0))).toBeNull();
  });

  it('注释里的名字不产生引用', () => {
    const from = SOURCE.indexOf('// 注释里提到');
    const position = positionAtOffset(SOURCE, SOURCE.indexOf('心情', from));
    expect(refsAt(position)).toBeNull();
  });

  it('`@原生` 体里的名字不产生引用', () => {
    const from = SOURCE.indexOf('@原生');
    const position = positionAtOffset(SOURCE, SOURCE.indexOf('心情', from));
    expect(refsAt(position)).toBeNull();
  });

  it('双引号字符串里的名字不计数（条件行只认字符串外的 `心情`）', () => {
    const result = found(positionAt('? 心情 ==', 0, 2));
    expect(result.refs).toHaveLength(3); // decl10 + interp33 + 条件37
    const quoted = SOURCE.indexOf('"今天已触发"');
    const position = positionAtOffset(SOURCE, quoted + 1);
    expect(refsAt(position)).toBeNull();
  });

  it('调用实参里的双引号字符串不计数', () => {
    const result = found(positionAt('! 娇羞退场', 0, 2));
    expect(result.refs).toHaveLength(2); // 声明 + 调用，没有实参里的 `心情`
    expect(result.refs.every((site) => textOf(site.span) !== '心情')).toBe(true);
  });

  it('`对象.成员` 的成员名不是文件内符号', () => {
    const result = found(positionAt('今天已触发 = 我.今天已触发'));
    // 该行只有左侧一枚 ref；右侧成员名被跳过。
    expect(result.refs.filter((site) => site.span.startLine === 44)).toHaveLength(1);
    const member = SOURCE.indexOf('我.今天已触发') + '我.'.length;
    expect(refsAt(positionAtOffset(SOURCE, member))).toBeNull();
  });

  it('表体行：值列不是引用位；范围端点里的常量是（与 rename 的改写集合一致）', () => {
    // 改前读数：端点也不收集（`refsAt('100..499')` / 端点常量 → null），
    // 而 `kojo2-rename.ts` 按 core AST 会改写 `from` / `to` 里的常量 ⇒ 两把尺子不一致。
    expect(refsAt(positionAt('疏远'))).toBeNull();
    expect(refsAt(positionAt('100..499'))).toBeNull();
    const source = [
      '# 常量 上限 整数 = 499',
      '# 表 心情 由 上限',
      '    0..上限 疏远',
      '    否 未知',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '上限'));
    expect(result?.symbol.name).toBe('上限');
    expect(result?.symbol.kind).toBe('constant');
    // 声明位 + `由` 表达式 + 表体端点
    expect(result?.refs.map((site) => site.span.startLine)).toEqual([1, 2, 3]);
    expect(result?.refs.map((site) => site.kind)).toEqual(['decl', 'ref', 'ref']);
  });

  it('`# 视` 的名字不属本批符号面', () => {
    expect(refsAt(positionAt('旅人'))).toBeNull();
  });

  it('`? 否` 默认分支不是引用位', () => {
    expect(refsAt(positionAt('? 否', 0, 2))).toBeNull();
  });

  it('空白 / 声明名之后的空格 / 越界行 → null', () => {
    expect(refsAt(positionAt('今天已触发', 0, 0))).not.toBeNull();
    // 名字段之后（`整数` 开头）不再是这个名字位。
    const afterName = SOURCE.indexOf('整数', SOURCE.indexOf('# 变量 今天已触发'));
    expect(refsAt(positionAtOffset(SOURCE, afterName))).toBeNull();
    expect(refsAt({ line: 999, column: 1 })).toBeNull();
  });
});

/* ============================== ④ 结果形状 ============================== */

describe('结果形状：源码序 / 去重 / 角色', () => {
  it('refs 按源码序（行、列升序）且同一位置只出现一次', () => {
    const result = found(atDeclaration('今天已触发'));
    const keys = result.refs.map((site) => `${site.span.startLine}:${site.span.startColumn}`);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...result.refs].sort(
      (a, b) => a.span.startLine - b.span.startLine || a.span.startColumn - b.span.startColumn,
    );
    expect(keys).toEqual(sorted.map((site) => `${site.span.startLine}:${site.span.startColumn}`));
  });

  it('声明位在第一位且角色是 `decl`（声明通常写在引用之前）', () => {
    for (const { name } of DECLARATION_CASES) {
      const result = found(atDeclaration(name));
      expect(result.refs[0]?.kind).toBe('decl');
      expect(textOf(result.refs[0]!.span)).toBe(declarationOf(name).name);
    }
  });

  it('角色三档：decl（声明）/ ref（普通引用）/ call（`!` 调用与裸调用）', () => {
    expect(rolesOf(atDeclaration('早安问候'))).toEqual(['decl', 'call', 'call']);
    expect(rolesOf(atDeclaration('心情'))).toEqual(['decl', 'ref', 'ref']);
    expect(rolesOf(atDeclaration('增加羁绊'))).toEqual(['decl', 'call', 'call']);
  });

  it('`declSpan` 对 `@函` / `# 模` 取 `(` 之前的名字（不带参数表）', () => {
    const fn = found(atDeclaration('增加羁绊'));
    expect(textOf(fn.symbol.declSpan)).toBe('增加羁绊');
    const template = found(atDeclaration('娇羞退场'));
    expect(textOf(template.symbol.declSpan)).toBe('娇羞退场');
  });
});

/* ============================== ⑤ 上限 / 截断 ============================== */

describe('上限：500 条 + truncated 显式标记', () => {
  function poolWithCalls(count: number): string {
    const rows = ['# 池 甲', '    ? 否', '        「好。」'];
    for (let i = 0; i < count; i++) rows.push('! 甲');
    return rows.join('\n');
  }

  it('超过上限 → refs 恰好 500 条且 truncated = true（声明位保留）', () => {
    const source = poolWithCalls(KOJO2_REFERENCE_LIMIT + 5);
    const result = kojo2ReferencesAt(source, positionIn(source, '# 池 甲', 0, 4));
    expect(result).not.toBeNull();
    expect(result?.refs).toHaveLength(KOJO2_REFERENCE_LIMIT);
    expect(result?.truncated).toBe(true);
    expect(result?.refs[0]?.kind).toBe('decl');
  });

  it('恰好到上限 → truncated = false（不静默标截断）', () => {
    const source = poolWithCalls(KOJO2_REFERENCE_LIMIT - 1);
    const result = kojo2ReferencesAt(source, positionIn(source, '# 池 甲', 0, 4));
    expect(result?.refs).toHaveLength(KOJO2_REFERENCE_LIMIT);
    expect(result?.truncated).toBe(false);
  });

  it('未到上限 → truncated = false', () => {
    const result = found(atDeclaration('心情'));
    expect(result.truncated).toBe(false);
  });
});

/* ============================== ⑥ 边界 / 注入 / 确定性 ============================== */

describe('边界：CRLF / getIndex / 确定性 / 坏输入', () => {
  it('CRLF 与 LF 给出逐字相同的结果', () => {
    const crlf = SOURCE.replace(/\n/g, '\r\n');
    const lfResult = found(atDeclaration('今天已触发'));
    const crlfResult = kojo2ReferencesAt(crlf, positionIn(crlf, '今天已触发'));
    expect(crlfResult).toEqual(lfResult);
  });

  it('`getIndex` 注入：用注入的索引且结果与现建一致', () => {
    const injected = kojo2DocumentOf(SOURCE);
    const getIndex = vi.fn(() => injected);
    const position = atDeclaration('心情');
    const result = kojo2ReferencesAt(SOURCE, position, { getIndex });
    expect(getIndex).toHaveBeenCalledTimes(1);
    expect(result).toEqual(found(position));
  });

  it('`getIndex` 抛错 → 退回现建（结果不变，不抛）', () => {
    const position = atDeclaration('心情');
    const getIndex = () => {
      throw new Error('桩：索引端抛错');
    };
    expect(kojo2ReferencesAt(SOURCE, position, { getIndex })).toEqual(found(position));
  });

  it('`getIndex` 回 null / 坏值 → 退回现建', () => {
    const position = atDeclaration('心情');
    expect(kojo2ReferencesAt(SOURCE, position, { getIndex: () => null })).toEqual(found(position));
    const bad = () => ({}) as never;
    expect(kojo2ReferencesAt(SOURCE, position, { getIndex: bad })).toEqual(found(position));
  });

  it('确定性：同一输入两次调用逐字相等', () => {
    const position = atDeclaration('心情');
    expect(kojo2ReferencesAt(SOURCE, position)).toEqual(kojo2ReferencesAt(SOURCE, position));
  });

  it('空源 / 非法位（0 行 / 0 列 / NaN）→ null', () => {
    expect(kojo2ReferencesAt('', { line: 1, column: 1 })).toBeNull();
    expect(kojo2ReferencesAt(SOURCE, { line: 0, column: 1 })).toBeNull();
    expect(kojo2ReferencesAt(SOURCE, { line: 1, column: 0 })).toBeNull();
    expect(kojo2ReferencesAt(SOURCE, { line: Number.NaN, column: 1 })).toBeNull();
  });

  it('没有声明也没有事件的空文件 → null', () => {
    expect(kojo2ReferencesAt('> 只有旁白。', { line: 1, column: 1 })).toBeNull();
  });
});

/* ============================== ⑦ provider ============================== */

describe('provider：只挂 kojo2 / flag / dispose / 失败面', () => {
  it('flag 开 → 恰好一枚注册，selector 是 `kojo2`，provider 是引用查找形状', () => {
    const { fake } = installForTest();
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]?.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(typeof providerOf(fake).provideReferences).toBe('function');
  });

  it('provider 的 Location 与纯逻辑 refs 逐条对应（uri 取 model.uri）', () => {
    const { fake } = installForTest();
    const { model } = fakeModel(SOURCE);
    const position = atDeclaration('心情');
    const locations = provideReferences(fake, model, position);
    const result = found(position);
    expect(locations).toHaveLength(result.refs.length);
    expect(locations[0]?.uri).toBe((model as unknown as { uri: unknown }).uri);
    expect(locations[0]?.range).toEqual({
      startLineNumber: 10,
      startColumn: 5,
      endLineNumber: 10,
      endColumn: 7,
    });
    expect(locations.map((location) => location.range.startLineNumber)).toEqual(
      result.refs.map((site) => site.span.startLine),
    );
  });

  it('`includeDeclaration === false` → 去掉声明位', () => {
    const { fake } = installForTest();
    const { model } = fakeModel(SOURCE);
    const position = atDeclaration('心情');
    const locations = provideReferences(fake, model, position, false);
    expect(locations.map((location) => location.range.startLineNumber)).toEqual([33, 37]);
  });

  it('不可识别位 → `[]`（不是 null / 不是抛）', () => {
    const { fake } = installForTest();
    const { model } = fakeModel(SOURCE);
    expect(provideReferences(fake, model, positionAt('心情不错'))).toEqual([]);
  });

  it('缺省档（v1-only）→ 照样注册一枚；句柄 dispose 幂等', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const disposable = installKojo2ReferenceProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(() => {
      disposable.dispose();
      disposable.dispose();
    }).not.toThrow();
    expect(fake.disposeCount()).toBe(1);
  });

  it('dispose 幂等：重复 dispose 只撤一次', () => {
    const { fake, disposable } = installForTest();
    disposable.dispose();
    disposable.dispose();
    expect(fake.disposeCount()).toBe(1);
  });

  it('注册句柄的 dispose 抛错 → 卸载链不崩（不抛）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failDispose: true });
    const disposable = installKojo2ReferenceProvider(fake.monaco);
    expect(() => disposable.dispose()).not.toThrow();
  });

  it('注册抛错 → 原样外抛（宿主统一回滚）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failRegister: true });
    expect(() => installKojo2ReferenceProvider(fake.monaco)).toThrow();
  });

  it('取文抛错（模型已释放）→ `[]`', () => {
    const { fake } = installForTest();
    const { model, breakModel } = fakeModel(SOURCE);
    breakModel();
    expect(provideReferences(fake, model, atDeclaration('心情'))).toEqual([]);
  });

  it('model 没有 uri → `[]`（Location 缺 uri 无处可落）', () => {
    const { fake } = installForTest();
    const { model } = fakeModel(SOURCE, { withoutUri: true });
    expect(provideReferences(fake, model, atDeclaration('心情'))).toEqual([]);
  });

  it('provider 把 `getIndex` 透传给纯逻辑（注入的索引确实被调用）', () => {
    const getIndex = vi.fn(() => kojo2DocumentOf(SOURCE));
    const { fake } = installForTest({ getIndex });
    const { model } = fakeModel(SOURCE);
    const locations = provideReferences(fake, model, atDeclaration('心情'));
    expect(getIndex).toHaveBeenCalledTimes(1);
    expect(locations).toHaveLength(3);
  });

  it('源码纪律：Monaco 只 type-only 引、不碰插件包 / kernel；只注册一次 ReferenceProvider', () => {
    const source = readFileSync(join(HERE, '..', 'src', 'monaco', 'kojo2-references.ts'), 'utf8');
    expect(source).toContain("import type * as Monaco from './entry'");
    expect(source).not.toMatch(/@kojo\/plugin-/);
    expect(source).not.toMatch(/@kojo\/kernel/);
    expect(source.match(/registerReferenceProvider/g) ?? []).toHaveLength(1);
    expect(source.match(/KOJO2_LANGUAGE_ID/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});
