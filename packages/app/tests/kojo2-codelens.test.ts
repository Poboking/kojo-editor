/**
 * K2-LSP-CODELENS · Kojo 2.0 行上注解（`# 机` 事件 / `@织` 监听层 / `@函` 同文件引用计数）的闸。
 *
 * 覆盖八件事：
 * 1. **三类注解**：`# 机` 的「事件 + 参数 N」、`@织` 的「事件 + 层」、`@函` 的「本文件 N 处用到」；
 * 2. **计数口径**：只数可证明的调用点（`! 名字` / `名字(`），台词 / 旁白 / 注释 / `@原生`
 *    一律不算，声明头自己不算，递归照数；与 `kojo2-declarations` 的名字区间逐字对拍；
 * 3. **命令口径**：命令 id 复用 v1 已注册的 `kojo.codeLens.execute`；参数是
 *    `EditorSymbolLocation + mode`（`reveal` / `references`）；无文件身份 ⇒ 空参数（不给假按钮）；
 * 4. **行尾区间**：零宽钉在 `contentEnd`（行长 + 1）；
 * 5. **大文件闸**：> `LARGE_FILE_LINES` 只产前 `KOJO2_CODE_LENS_LARGE_FILE_LIMIT` 条；
 * 6. **不产**：`@原生` 体 / 注释 / 块内错写的声明 / 缺名字的声明；
 * 7. **provider**：只挂 `kojo2`、flag 关零注册、异常回空、dispose 幂等、refresh 触发 onDidChange；
 * 8. **失败面**：坏输入 / 空输入回 `[]`、不抛；同一输入两次调用逐字相等。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { kojo2DocumentOf } from '@kojo/kojo-lang';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import {
  KOJO2_CODE_LENS_COMMAND,
  KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER,
  KOJO2_CODE_LENS_LARGE_FILE_LIMIT,
  installKojo2CodeLensProvider,
  kojo2CodeLenses,
  kojo2ReferenceCounts,
  toMonacoCodeLenses,
  type Kojo2CodeLens,
  type Kojo2CodeLensCountQuery,
  type Kojo2CodeLensKind,
  type Kojo2CodeLensTarget,
} from '../src/monaco/kojo2-codelens';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';

const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';
const PATH = 'C:/p/口上.kojo2';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SYMBOLS_FIXTURE = readFileSync(join(HERE, 'fixtures', 'kojo2', 'symbols.kojo2'), 'utf8');

/** 带文件身份的注解（多数用例都要落点） */
function lenses(source: string, filePath: string | undefined = PATH): readonly Kojo2CodeLens[] {
  return kojo2CodeLenses(source, filePath === undefined ? {} : { filePath });
}

/** 某一类的全部注解（源码序） */
function lensesOfKind(source: string, kind: Kojo2CodeLensKind): readonly Kojo2CodeLens[] {
  return lenses(source).filter((lens) => lens.kind === kind);
}

/** 命令参数（只在这条注解确实带落点时可用） */
function targetOf(lens: Kojo2CodeLens): Kojo2CodeLensTarget {
  expect(lens.command.arguments).toHaveLength(1);
  return lens.command.arguments[0] as Kojo2CodeLensTarget;
}

/* ============================== 夹具 ============================== */

/** `# 机`：事件 `指令` + 一个参数 `310`（规范 §3.7 的示例形状） */
const MACHINE = '# 机 指令 310\n# 幕 神社清晨\n    > 她推开了门。\n';

/** `@织`：事件 `回合末` + 修饰词 `之后` */
const WEAVE = '@织 回合末 之后\n    > 雨声盖住了她的脚步。\n';

/** `@函`：声明 + 一处 `!` 调用 + 一处表达式调用 */
const FUNCTION = '@函 增加羁绊(目标, 数值=10)\n    ! 增加羁绊(1)\n    结果 = 增加羁绊(2)\n    @返 结果\n';

/** 三类都有的文件（`# 机` 在最前，`@织` / `@函` 在后） */
const MIXED = `${MACHINE}\n${WEAVE}\n${FUNCTION}`;

/* ============================== ① `# 机` ============================== */

describe('`# 机` 事件注解', () => {
  it('事件名 + 参数个数：`参数 N` 数的是事件名之后的词', () => {
    const [lens] = lensesOfKind(MACHINE, 'events');
    expect(lens).toBeDefined();
    expect(lens!.command.title).toBe('事件 指令 · 参数 1');
    expect(lens!.kind).toBe('events');
  });

  it('没有参数 ⇒ `参数 0`；多个参数按个数数', () => {
    expect(lensesOfKind('# 机 指令\n', 'events')[0]!.command.title).toBe('事件 指令 · 参数 0');
    expect(lensesOfKind('# 机 指令 310 80\n', 'events')[0]!.command.title).toBe(
      '事件 指令 · 参数 2',
    );
  });

  it('缺事件名的 `# 机` 不产注解（错误行不产注解）', () => {
    expect(lensesOfKind('# 机\n', 'events')).toEqual([]);
  });
});

/* ============================== ② `@织` ============================== */

describe('`@织` 监听注解', () => {
  it('带修饰词 ⇒ 层就是那个修饰词', () => {
    const [lens] = lensesOfKind(WEAVE, 'weave');
    expect(lens!.command.title).toBe('监听 回合末 · 之后');
    expect(lens!.kind).toBe('weave');
  });

  it('不带修饰词 ⇒ 普通层（`KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER`）', () => {
    expect(lensesOfKind('@织 回合末\n    > 旁白\n', 'weave')[0]!.command.title).toBe(
      `监听 回合末 · ${KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER}`,
    );
  });

  it('多个修饰词按源码原样列出（错误态也如实照抄，不替作者挑一个）', () => {
    expect(lensesOfKind('@织 回合末 之前 之后\n    > 旁白\n', 'weave')[0]!.command.title).toBe(
      '监听 回合末 · 之前 之后',
    );
  });

  it('缺事件名（首词就是修饰词）不产注解', () => {
    expect(lensesOfKind('@织 之前\n    > 旁白\n', 'weave')).toEqual([]);
    expect(lensesOfKind('@织\n', 'weave')).toEqual([]);
  });
});

/* ============================== ③ `@函` 引用计数 ============================== */

describe('`@函` 同文件引用计数', () => {
  it('`! 名字` 与 `名字(` 都算一处：两处调用 ⇒ `本文件 2 处用到`', () => {
    const [lens] = lensesOfKind(FUNCTION, 'refs');
    expect(lens!.command.title).toBe('本文件 2 处用到');
    expect(lens!.kind).toBe('refs');
  });

  it('只有声明没有调用 ⇒ `本文件 0 处用到`（0 是事实，不退化成不出）', () => {
    expect(lensesOfKind('@函 孤独()\n    @返 1\n', 'refs')[0]!.command.title).toBe(
      '本文件 0 处用到',
    );
  });

  it('`! 名字` 不带括号也算一处调用', () => {
    expect(
      lensesOfKind('@函 打招呼()\n    ! 打招呼\n', 'refs')[0]!.command.title,
    ).toBe('本文件 1 处用到');
  });

  it('台词 / 旁白 / 注释 / `@原生` 体里的同名文字不算引用', () => {
    const source = [
      '@函 笑(目标)',
      '    > 笑(目标) 只是旁白里的字',
      '    灵梦：「笑(目标) 是台词。」',
      '    // 笑(目标) 是注释',
      '    @原生',
      '        笑(目标)',
      '    @返 0',
      '',
    ].join('\n');
    expect(lensesOfKind(source, 'refs')[0]!.command.title).toBe('本文件 0 处用到');
  });

  it('递归调用照数（函数体里两处自调用 ⇒ 2）', () => {
    const source = [
      '@函 斐波那契(n)',
      '    ? n <= 1',
      '        @返 n',
      '    @返 斐波那契(n - 1) + 斐波那契(n - 2)',
      '',
    ].join('\n');
    expect(lensesOfKind(source, 'refs')[0]!.command.title).toBe('本文件 2 处用到');
  });

  it('声明头自己不算一处调用（哪怕名字后面紧跟 `(`）', () => {
    expect(lensesOfKind('@函 单独(目标)\n    @返 目标\n', 'refs')[0]!.command.title).toBe(
      '本文件 0 处用到',
    );
  });

  it('名字按整词匹配：`增加羁绊` 不把 `增加羁绊值` 算到自己头上', () => {
    const source = [
      '@函 增加羁绊(目标)',
      '    ! 增加羁绊值(1)',
      '    ! 增加羁绊(2)',
      '',
    ].join('\n');
    expect(lensesOfKind(source, 'refs')[0]!.command.title).toBe('本文件 1 处用到');
  });

  it('`kojo2ReferenceCounts` 与注解同源（名字 → 调用点）', () => {
    const counts = kojo2ReferenceCounts(FUNCTION);
    expect(counts.get('增加羁绊')).toBe(2);
    expect(counts.get('结果')).toBeUndefined();
    expect(kojo2ReferenceCounts('')).toEqual(new Map());
  });

  it('名字区间与 `kojo2-declarations` 的声明索引逐字对拍（不写第二把尺子）', () => {
    const declaration = kojo2DocumentOf(FUNCTION).declarations.find(
      (item) => item.kind === 'function',
    );
    expect(declaration).toBeDefined();
    const target = targetOf(lensesOfKind(FUNCTION, 'refs')[0]!);
    expect(target.column).toBe(declaration!.nameStart);
    expect(target.span).toEqual({
      columnStart: declaration!.nameStart,
      columnEnd: declaration!.nameEnd,
    });
  });

  it('注入的引用面读数覆盖自扫（K2-REFS 同源的那一档）', () => {
    const [lens] = kojo2CodeLenses(FUNCTION, {
      filePath: PATH,
      countReferences: () => 0,
    }).filter((item) => item.kind === 'refs');
    expect(lens!.command.title).toBe('本文件 0 处用到');
  });

  it('注入位收到「名字 + 声明位 + 源文」——宿主一行就能问引用面', () => {
    const queries: Kojo2CodeLensCountQuery[] = [];
    kojo2CodeLenses(FUNCTION, {
      filePath: PATH,
      countReferences: (query) => {
        queries.push(query);
        return 4;
      },
    });
    expect(queries).toEqual([
      { name: '增加羁绊', line: 1, column: 4, source: FUNCTION },
    ]);
  });

  it('注入读到非有限值 / 负数 ⇒ 退回自扫（不让一条腿把读数写成假数）', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const [lens] = kojo2CodeLenses(FUNCTION, {
        filePath: PATH,
        countReferences: () => bad,
      }).filter((item) => item.kind === 'refs');
      expect(lens!.command.title, String(bad)).toBe('本文件 2 处用到');
    }
  });
});

/* ============================== ④ 命令口径 ============================== */

describe('命令 id / 参数形态 / 行尾区间', () => {
  it('命令 id 与 v1 的 `CODE_LENS_COMMAND` 逐字相同（源码断言，不绑定模块求值顺序）', () => {
    const v1Source = readFileSync(
      join(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'kojo-code-lens.ts'),
      'utf8',
    );
    expect(v1Source).toContain(`export const CODE_LENS_COMMAND = '${KOJO2_CODE_LENS_COMMAND}';`);
    expect(KOJO2_CODE_LENS_COMMAND).toBe('kojo.codeLens.execute');
  });

  it('三类注解都挂这枚 id（不新造命令、不给 Monaco 一个没人接的 id）', () => {
    for (const lens of lenses(MIXED)) {
      expect(lens.command.id).toBe(KOJO2_CODE_LENS_COMMAND);
      expect(lens.command.title.length).toBeGreaterThan(0);
    }
  });

  it('`# 机` / `@织` 的落点 mode = reveal，`@函` 的 mode = references（请求引用面）', () => {
    const machine = targetOf(lensesOfKind(MACHINE, 'events')[0]!);
    expect(machine.mode).toBe('reveal');
    expect(machine.line).toBe(1);
    expect(machine.column).toBe(5); // `# 机 指令 310`：`指令` 从第 5 列起
    expect(machine.span).toEqual({ columnStart: 5, columnEnd: 7 });
    expect(targetOf(lensesOfKind(WEAVE, 'weave')[0]!).mode).toBe('reveal');
    expect(targetOf(lensesOfKind(FUNCTION, 'refs')[0]!).mode).toBe('references');
  });

  it('落点带文件身份（宿主不必再猜这份 model 是谁）', () => {
    expect(targetOf(lensesOfKind(MACHINE, 'events')[0]!).filePath).toBe(PATH);
  });

  it('没有文件身份 ⇒ 空参数（点击原地不动，但也不给 Monaco 一个不认识的命令）', () => {
    const [lens] = kojo2CodeLenses(MACHINE).filter((item) => item.kind === 'events');
    expect(lens!.command.arguments).toEqual([]);
    expect(lens!.command.id).toBe(KOJO2_CODE_LENS_COMMAND);
  });

  it('区间零宽钉在行尾：`# 机 指令 310`（10 个码元）⇒ 第 11 列', () => {
    const [lens] = lensesOfKind(MACHINE, 'events');
    expect(lens!.range).toEqual({
      startLine: 1,
      startColumn: 11,
      endLine: 1,
      endColumn: 11,
    });
  });

  it('三类注解按源码行升序（同一篇里不交叉）', () => {
    const lines = lenses(MIXED).map((lens) => lens.range.startLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(new Set(lenses(MIXED).map((lens) => lens.kind))).toEqual(
      new Set<Kojo2CodeLensKind>(['events', 'weave', 'refs']),
    );
  });

  it('同一输入两次调用逐字相等（纯函数、无缓存）', () => {
    expect(lenses(MIXED)).toEqual(lenses(MIXED));
  });

  it('LF / CRLF 同一份源文 ⇒ 同一批注解（行列口径不随换行漂）', () => {
    const crlf = MIXED.replace(/\n/g, '\r\n');
    expect(lenses(crlf)).toEqual(lenses(MIXED));
  });

  it('真实夹具：三类注解各就各位（行号 / 标题逐字）', () => {
    expect(
      lenses(SYMBOLS_FIXTURE).map((lens) => [lens.range.startLine, lens.kind, lens.command.title]),
    ).toEqual([
      [4, 'events', '事件 指令 · 参数 1'],
      [25, 'refs', '本文件 0 处用到'],
      [28, 'weave', '监听 指令 · 之前'],
    ]);
  });
});

/* ============================== ⑤ 不产 / 空输入 ============================== */

describe('不产注解的行与空输入', () => {
  it('`@原生` 围栏里的 `# 机` / `@织` / `@函` 都是原文，不产注解', () => {
    const source = [
      '@原生',
      '    # 机 指令 310',
      '    @织 回合末 之后',
      '    @函 藏起来()',
      '',
    ].join('\n');
    expect(kojo2CodeLenses(source, { filePath: PATH })).toEqual([]);
  });

  it('块内错写的声明（缩进 > 0）不产注解', () => {
    const source = [
      '@函 外层()',
      '    # 机 指令 310',
      '    @织 回合末 之后',
      '    @函 内层()',
      '    @返 0',
      '',
    ].join('\n');
    const kinds = lenses(source).map((lens) => lens.kind);
    expect(kinds).toEqual(['refs']);
    expect(lenses(source)[0]!.command.title).toBe('本文件 0 处用到');
  });

  it('纯注释 / 纯叙事 / 空串 ⇒ []', () => {
    expect(kojo2CodeLenses('', { filePath: PATH })).toEqual([]);
    expect(kojo2CodeLenses('// 注释\n// 又一行\n', { filePath: PATH })).toEqual([]);
    expect(kojo2CodeLenses('> 只有旁白\n灵梦：「只有台词。」\n', { filePath: PATH })).toEqual([]);
  });

  it('坏输入不抛（不把异常送进 Monaco）', () => {
    expect(() => kojo2CodeLenses('# 机\n@织\n@函 \n', { filePath: PATH })).not.toThrow();
  });
});

/* ============================== ⑥ 大文件闸 ============================== */

/** 造一篇「函数声明若干行 + 旁白填充到指定行数」的源文（末尾无多余空行） */
function sourceOfLines(declarations: readonly string[], totalLines: number): string {
  const head = `${declarations.join('\n')}\n`;
  const filler = totalLines - declarations.length;
  return `${head}${'> 旁白\n'.repeat(Math.max(0, filler))}`;
}

const LARGE_DECLARATIONS = Array.from({ length: 12 }, (_, index) => `@函 f${index}()`);

describe('大文件闸：超过 LARGE_FILE_LINES 只产前 N 条', () => {
  it('N 写死为 10（改这条线必须改测试，不许悄悄放宽）', () => {
    expect(KOJO2_CODE_LENS_LARGE_FILE_LIMIT).toBe(10);
  });

  it('恰好 LARGE_FILE_LINES 行 ⇒ 全产（界线是「大于」）', () => {
    const source = sourceOfLines(LARGE_DECLARATIONS, LARGE_FILE_LINES);
    expect(lenses(source)).toHaveLength(12);
  });

  it('LARGE_FILE_LINES + 1 行 ⇒ 只产前 KOJO2_CODE_LENS_LARGE_FILE_LIMIT 条', () => {
    const source = sourceOfLines(LARGE_DECLARATIONS, LARGE_FILE_LINES + 1);
    expect(lenses(source)).toHaveLength(KOJO2_CODE_LENS_LARGE_FILE_LIMIT);
  });

  it('截断保留的是源码序最前的那几条（行号从 1 起连续）', () => {
    const source = sourceOfLines(LARGE_DECLARATIONS, LARGE_FILE_LINES + 1);
    expect(lenses(source).map((lens) => lens.range.startLine)).toEqual(
      Array.from({ length: KOJO2_CODE_LENS_LARGE_FILE_LIMIT }, (_, index) => index + 1),
    );
  });

  it('超档文件的注解内容不因截断而改变（仍是真话）', () => {
    const source = `${'# 机 指令 310\n'}${'> 旁白\n'.repeat(LARGE_FILE_LINES)}`;
    const [lens] = lenses(source);
    expect(lens!.command.title).toBe('事件 指令 · 参数 1');
  });
});

/* ============================== ⑦ Monaco 翻译层 ============================== */

describe('toMonacoCodeLenses · 协议形状', () => {
  it('字段逐条翻译：1 基区间、逐条唯一 id、command 三格原样', () => {
    const got = toMonacoCodeLenses(lenses(MIXED));
    expect(got).toHaveLength(3);
    expect(got[0]!.range).toEqual({
      startLineNumber: 1,
      startColumn: 11,
      endLineNumber: 1,
      endColumn: 11,
    });
    expect(new Set(got.map((lens) => lens.id)).size).toBe(got.length);
    expect(got[0]!.command!.id).toBe(KOJO2_CODE_LENS_COMMAND);
    expect(got[0]!.command!.title).toBe('事件 指令 · 参数 1');
    expect(got[0]!.command!.arguments).toHaveLength(1);
  });

  it('空表 ⇒ 空数组（不造一条假注解）', () => {
    expect(toMonacoCodeLenses([])).toEqual([]);
  });
});

/* ============================== ⑧ provider ============================== */

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

interface Registration {
  readonly languageId: string;
  readonly provider: Monaco.languages.CodeLensProvider;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  /** 每一次 `registration.dispose()` 记一次（幂等判据） */
  readonly disposeCalls: number[];
}

function fakeMonaco(): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: number[] = [];
  const fake = {
    languages: {
      registerCodeLensProvider: (
        languageId: string,
        provider: Monaco.languages.CodeLensProvider,
      ): Monaco.IDisposable => {
        registrations.push({ languageId, provider });
        return {
          dispose: () => {
            disposeCalls.push(registrations.length);
          },
        };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, disposeCalls };
}

interface FakeModelOptions {
  readonly path?: string;
  /** `getValue()` 抛错（模拟已释放 / 取文失败） */
  readonly breakValue?: boolean;
  /** `isDisposed()` 回 true（模拟 model 已释放） */
  readonly disposed?: boolean;
}

function fakeModel(text: string, options: FakeModelOptions = {}): Monaco.editor.ITextModel {
  const model = {
    getValue: () => {
      if (options.breakValue === true) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    isDisposed: () => options.disposed === true,
    ...(options.path === undefined ? {} : { uri: { fsPath: options.path } }),
  };
  return model as unknown as Monaco.editor.ITextModel;
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

function providerOf(fake: FakeMonaco): Monaco.languages.CodeLensProvider {
  const registration = fake.registrations[0];
  if (registration === undefined) throw new Error('没有注册 CodeLensProvider');
  return registration.provider;
}

function providedLenses(
  provider: Monaco.languages.CodeLensProvider,
  model: Monaco.editor.ITextModel,
): readonly Monaco.languages.CodeLens[] {
  const result = provider.provideCodeLenses(model, TOKEN) as Monaco.languages.CodeLensList;
  return result.lenses;
}

describe('installKojo2CodeLensProvider · 注册纪律', () => {
  it('缺省档（v1-only）⇒ 照样注册一枚；句柄 refresh / dispose 幂等不抛', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2CodeLensProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(() => handle.refresh()).not.toThrow();
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });

  it('flag 开 ⇒ 恰好一枚注册，语言 selector 只有 `kojo2`', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.languageId).toBe(KOJO2_LANGUAGE_ID);
  });

  it('dispose 幂等：连撤两次只撤一次注册', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2CodeLensProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });

  it('refresh 触发 onDidChange；dispose 之后 refresh 不再通知', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2CodeLensProvider(fake.monaco);
    const provider = providerOf(fake);
    const seen: unknown[] = [];
    const subscription = provider.onDidChange!((event) => {
      seen.push(event);
    });
    handle.refresh();
    expect(seen).toEqual([provider]);
    subscription.dispose();
    handle.refresh();
    expect(seen).toEqual([provider]);
    handle.dispose();
    expect(() => handle.refresh()).not.toThrow();
    expect(seen).toEqual([provider]);
  });

  it('注册失败原样外抛（只有一枚注册，没有半成品要回滚）', () => {
    stubFlag(true);
    const monaco = {
      languages: {
        registerCodeLensProvider: () => {
          throw new Error('桩：注册抛错');
        },
      },
    } as unknown as typeof Monaco;
    expect(() => installKojo2CodeLensProvider(monaco)).toThrow('桩：注册抛错');
  });
});

describe('installKojo2CodeLensProvider · 取数与失败面', () => {
  it('provider 交回 Monaco 形状的注解（含文件身份与命令）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco);
    const got = providedLenses(providerOf(fake), fakeModel(MIXED, { path: PATH }));
    expect(got).toHaveLength(3);
    expect(got[0]!.command!.title).toBe('事件 指令 · 参数 1');
    expect((got[0]!.command!.arguments as Kojo2CodeLensTarget[])[0]!.filePath).toBe(PATH);
  });

  it('`model.uri.fsPath` 是文件身份的兜底；`getFilePath` 优先且抛错时退回 uri', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco, {
      getFilePath: () => {
        throw new Error('桩：身份取不到');
      },
    });
    const got = providedLenses(providerOf(fake), fakeModel(MACHINE, { path: PATH }));
    expect((got[0]!.command!.arguments as Kojo2CodeLensTarget[])[0]!.filePath).toBe(PATH);
  });

  it('引用计数注入位生效（K2-REFS 落地后同源接上）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco, { countReferences: () => 7 });
    const got = providedLenses(providerOf(fake), fakeModel(FUNCTION, { path: PATH }));
    expect(got[0]!.command!.title).toBe('本文件 7 处用到');
  });

  it('注入位抛错 ⇒ 退回自扫读数（注解照常出，不空白）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco, {
      countReferences: () => {
        throw new Error('桩：引用面炸了');
      },
    });
    const got = providedLenses(providerOf(fake), fakeModel(FUNCTION, { path: PATH }));
    expect(got[0]!.command!.title).toBe('本文件 2 处用到');
  });

  it('取文抛错 ⇒ 空列表、不抛（Monaco 的 throw 会被吞成「注解突然没了」）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco);
    const got = providedLenses(
      providerOf(fake),
      fakeModel(MIXED, { path: PATH, breakValue: true }),
    );
    expect(got).toEqual([]);
  });

  it('模型已释放 ⇒ 空列表', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco);
    const got = providedLenses(
      providerOf(fake),
      fakeModel(MIXED, { path: PATH, disposed: true }),
    );
    expect(got).toEqual([]);
  });
});
