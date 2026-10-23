/**
 * K2-EDITOR-SYMBOLS · Kojo 2.0 文档符号（大纲 / Ctrl+Shift+O）与面包屑路径的闸。
 *
 * 覆盖八件事：
 * 1. **声明面**：十类声明（幕 / 视 / 机 / 变量 / 常量 / 表 / 池 / 模 / 函 / 织）各出一枚符号，
 *    `?` 链 / 叙事 / 注释 / `@原生` 体一票不产；
 * 2. **detail**：声明词（core 单源）与类型 / 初值 / 存储期 / 行数 / 分支数 / 参数 / 修饰词；
 * 3. **真 span**：块区间取 core AST（表到末行表体、池到末条分支正文、模 / 函 / 织到块体、
 *    幕到本幕末个叙事节点），名字段与 `kojo2-declarations.ts` 的声明索引**逐字对拍**；
 * 4. **层级**：`container` = 真 span 包含的最内层符号（多幕各收自己那一段）；
 * 5. **确定性**：源码序、两次调用逐字相等、LF / CRLF 同结果；
 * 6. **空 / 坏输入**：`[]`、不抛；
 * 7. **面包屑路径**：`kojo2SymbolPathAt` 的"光标 → 根"、深层块 / 声明区 / 正文 / 越界；
 * 8. **Monaco 面**：`SymbolKind` 映射、`DocumentSymbol` 树形状、开关关也注册（只读呈现面，
 *    K2-STRUCTURE-GATE）、dispose 幂等、provider 失败回 `[]`，外加源码断言（Monaco 类型
 *    只 type-only、不碰插件包、不由 cutover 开关门控）。
 *
 * 夹具 `fixtures/kojo2/symbols.kojo2` 刻意把 `# 幕` 写在最前：这样它后面的声明都落在该幕的
 * 真 span 里，层级与块区间都能在同一份输入上验；另有用例用声明区在幕前的写法验"顶层符号"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { kojo2DocumentOf } from '../src/monaco/kojo2-declarations';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-constants';
import {
  KOJO2_SYMBOL_WORD_BY_KIND,
  installKojo2DocumentSymbolProvider,
  kojo2DocumentSymbolTree,
  kojo2DocumentSymbols,
  kojo2SymbolKindToMonaco,
  kojo2SymbolPathAt,
  type Kojo2SymbolFact,
  type Kojo2SymbolKind,
  type Kojo2SymbolPosition,
} from '../src/monaco/kojo2-symbols';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

const FIXTURE = readFileSync(join(HERE, 'fixtures', 'kojo2', 'symbols.kojo2'), 'utf8');
const FACTS = kojo2DocumentSymbols(FIXTURE);

/* ============================== 假 Monaco / 假 model ============================== */

/**
 * Monaco `SymbolKind` 的真实数值（0.57 枚举顺序；node 池里 Monaco 运行时不进模块图，
 * 所以按同一张表桩出来比，与 `kojo2-providers.test.ts` 的 `KINDS` 同手法）。
 */
const SYMBOL_KINDS = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

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
  /** 每一次 `registration.dispose()` 记一次（幂等判据） */
  readonly disposeCalls: number[];
}

interface FakeMonacoOptions {
  /** 让注册抛错（验错误外抛；只有一枚注册，没有半成品） */
  readonly failRegister?: boolean;
  /** 让注册的 dispose 抛错（验卸载不抛） */
  readonly failDispose?: boolean;
}

function fakeMonaco(options: FakeMonacoOptions = {}): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: number[] = [];
  const fake = {
    languages: {
      SymbolKind: SYMBOL_KINDS,
      registerDocumentSymbolProvider: (selector: unknown, provider: unknown) => {
        if (options.failRegister === true) throw new Error('桩：注册符号 provider 抛错');
        const record: Registration = { selector, provider };
        registrations.push(record);
        return {
          dispose: () => {
            if (options.failDispose === true) throw new Error('桩：撤符号 provider 抛错');
            disposeCalls.push(registrations.length);
          },
        };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, disposeCalls };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  /** 让 `getValue()` 抛（模拟已释放 / 取文失败） */
  readonly breakModel: () => void;
}

function fakeModel(text: string): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    isDisposed: () => broken,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
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

/* ============================== 小工具 ============================== */

function factOf(kind: Kojo2SymbolKind, name?: string): Kojo2SymbolFact {
  const found = FACTS.find(
    (fact) => fact.kind === kind && (name === undefined || fact.name === name),
  );
  if (found === undefined) throw new Error(`夹具缺少符号 ${kind}${name === undefined ? '' : `:${name}`}`);
  return found;
}

function indexOfFact(fact: Kojo2SymbolFact): number {
  return FACTS.indexOf(fact);
}

function providerOf(fake: FakeMonaco): Monaco.languages.DocumentSymbolProvider {
  const registration = fake.registrations[0];
  if (registration === undefined) throw new Error('没有注册 DocumentSymbolProvider');
  return registration.provider as Monaco.languages.DocumentSymbolProvider;
}

function symbolsOf(fake: FakeMonaco, model: Monaco.editor.ITextModel): Monaco.languages.DocumentSymbol[] {
  return providerOf(fake).provideDocumentSymbols(model, TOKEN) as Monaco.languages.DocumentSymbol[];
}

function at(line: number, column: number): Kojo2SymbolPosition {
  return { line, column };
}

/** 手工造一枚事实（只为覆盖翻译层的坏 `container` 输入，与语法无关） */
function fact(overrides: Partial<Kojo2SymbolFact> & { readonly name: string }): Kojo2SymbolFact {
  return {
    detail: '示例',
    kind: 'variable',
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    selectionRange: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    ...overrides,
  };
}

/* ============================== ① 声明面：十类与"不产符号" ============================== */

describe('声明面：十类声明各出一枚，源码序、无重复', () => {
  it('十类声明全部覆盖（含声明索引不识的视 / 机 / 织）', () => {
    expect(new Set(FACTS.map((f) => f.kind))).toEqual(
      new Set<Kojo2SymbolKind>([
        'scene',
        'view',
        'machine',
        'variable',
        'constant',
        'table',
        'pool',
        'template',
        'function',
        'weave',
      ]),
    );
  });

  it('符号名与声明名逐字一致（幕取标题、机 / 织取事件名）', () => {
    expect(FACTS.map((f) => f.name)).toEqual([
      '神社清晨', // 幕
      '灵梦', // 视
      '指令', // 机（事件名；310 是参数，进 detail）
      '亲近线', // 常量
      '今天已触发', // 变量
      '心情快照', // 变量
      '心情', // 表
      '早安问候', // 池
      '娇羞退场', // 模
      '增加羁绊', // 函
      '指令', // 织（同样取事件名）
      '神社黄昏', // 第二幕
      '天气', // 第二幕里的表
    ]);
  });

  it('事实按源码序排列（行号单调不减）', () => {
    const lines = FACTS.map((f) => f.selectionRange.startLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('`?` 条件链 / 表体 / 池体 / 模体 / 函体 / 织体 / 叙事 / 注释 / @原生 都不产符号', () => {
    const startLines = FACTS.map((f) => f.selectionRange.startLine);
    // 条件行（15 / 17）、表体（10-12）、池分支正文（16 / 18）、模体（21-23）、函体（26）、
    // 织体（29）、叙事（31-32）、注释（1）都不在符号起点里。
    for (const line of [1, 10, 11, 12, 15, 16, 17, 18, 21, 22, 23, 26, 29, 31, 32, 36, 37, 38]) {
      expect(startLines, `第 ${line} 行不该产符号`).not.toContain(line);
    }
    // 池的两条分支只体现在 detail 的分支数上，没有分支符号。
    expect(factOf('pool').detail).toContain('2 分支');
  });

  it('`@原生` 围栏里的 `# 变量` 是原文，不产符号', () => {
    const source = '# 幕 测试\n@原生\n    # 变量 原生里的 整数\n';
    const facts = kojo2DocumentSymbols(source);
    expect(facts.map((f) => f.name)).toEqual(['测试']);
  });

  it('没有可导航结构的文件（纯叙事 / 纯注释）⇒ []', () => {
    expect(kojo2DocumentSymbols('> 只有旁白\n灵梦：「只有台词。」\n')).toEqual([]);
    expect(kojo2DocumentSymbols('// 只有注释\n// 第二行\n')).toEqual([]);
  });
});

/* ============================== ② detail ============================== */

describe('detail：声明词（core 单源）+ 一句话事实', () => {
  it('幕 / 视 / 机 / 织的 detail 只写种类词与参数 / 修饰词', () => {
    expect(factOf('scene', '神社清晨').detail).toBe(KOJO2_SYMBOL_WORD_BY_KIND.scene);
    expect(factOf('view').detail).toBe(KOJO2_SYMBOL_WORD_BY_KIND.view);
    expect(factOf('machine').detail).toBe(`${KOJO2_SYMBOL_WORD_BY_KIND.machine} 310`);
    expect(factOf('weave').detail).toBe(`${KOJO2_SYMBOL_WORD_BY_KIND.weave} 之前`);
  });

  it('变量 / 常量写类型、初值与存储期', () => {
    expect(factOf('variable', '今天已触发').detail).toBe(
      `${KOJO2_SYMBOL_WORD_BY_KIND.variable} 整数 = 0 存档`,
    );
    expect(factOf('variable', '心情快照').detail).toBe(
      `${KOJO2_SYMBOL_WORD_BY_KIND.variable} 字符串 场景`,
    );
    expect(factOf('constant').detail).toBe(
      `${KOJO2_SYMBOL_WORD_BY_KIND.constant} 整数 = 500`,
    );
  });

  it('表写由谁驱动与行数，池写分支数', () => {
    expect(factOf('table', '心情').detail).toBe(
      `${KOJO2_SYMBOL_WORD_BY_KIND.table} 由 恋慕 · 3 行`,
    );
    expect(factOf('table', '天气').detail).toContain('2 行');
    expect(factOf('pool').detail).toBe(`${KOJO2_SYMBOL_WORD_BY_KIND.pool} · 2 分支`);
  });

  it('模 / 函写参数表（有默认值的写 `名 = 值`），模另外标出插槽', () => {
    expect(factOf('template').detail).toBe(
      `${KOJO2_SYMBOL_WORD_BY_KIND.template} (原因) · [插槽]`,
    );
    expect(factOf('function').detail).toBe(
      `${KOJO2_SYMBOL_WORD_BY_KIND.function} (目标, 数值 = 10)`,
    );
  });

  it('detail 恒以该种类的 core 词开头（宿主不另写一套措辞）', () => {
    for (const fact of FACTS) {
      expect(fact.detail, fact.name).toContain(KOJO2_SYMBOL_WORD_BY_KIND[fact.kind]);
    }
  });

  it('数组长度 / 无参模 / 织的实参与修饰词都按源码序进 detail', () => {
    const source = [
      '# 变量 队列 整数[10] 存档',
      '# 模 无参()',
      '@织 指令 参数 之后',
      '# 幕 测试',
      '> 正文',
    ].join('\n');
    const facts = kojo2DocumentSymbols(source);
    const variable = facts.find((fact) => fact.kind === 'variable');
    const template = facts.find((fact) => fact.kind === 'template');
    const weave = facts.find((fact) => fact.kind === 'weave');
    expect(variable?.detail).toBe(`${KOJO2_SYMBOL_WORD_BY_KIND.variable} 整数[10] 存档`);
    expect(template?.detail).toBe(`${KOJO2_SYMBOL_WORD_BY_KIND.template} ()`);
    expect(weave?.name).toBe('指令');
    expect(weave?.detail).toBe(`${KOJO2_SYMBOL_WORD_BY_KIND.weave} 参数 之后`);
  });
});

/* ============================== ③ 真 span ============================== */

describe('真 span：块区间取 core AST，名字区间取词法偏移', () => {
  it('表块到末行表体（不是整行猜测）', () => {
    expect(factOf('table', '心情').range).toEqual({
      startLine: 9,
      startColumn: 1,
      endLine: 12,
      endColumn: 9,
    });
    expect(factOf('table', '天气').range).toEqual({
      startLine: 35,
      startColumn: 1,
      endLine: 37,
      endColumn: 8,
    });
  });

  it('池块到最后一条分支正文，模 / 函 / 织块到块体末行', () => {
    expect(factOf('pool').range).toEqual({ startLine: 14, startColumn: 1, endLine: 18, endColumn: 15 });
    expect(factOf('template').range).toEqual({ startLine: 20, startColumn: 1, endLine: 23, endColumn: 16 });
    expect(factOf('function').range).toEqual({ startLine: 25, startColumn: 1, endLine: 26, endColumn: 10 });
    expect(factOf('weave').range).toEqual({ startLine: 28, startColumn: 1, endLine: 29, endColumn: 16 });
  });

  it('幕的区间到本幕最后一个叙事节点（第二幕不会并进第一幕）', () => {
    expect(factOf('scene', '神社清晨').range).toEqual({
      startLine: 2,
      startColumn: 1,
      endLine: 32,
      endColumn: 18,
    });
    expect(factOf('scene', '神社黄昏').range).toEqual({
      startLine: 34,
      startColumn: 1,
      endLine: 38,
      endColumn: 8,
    });
  });

  it('单行声明的 range 就是该行内容；selectionRange 只盖名字段', () => {
    const variable = factOf('variable', '今天已触发');
    expect(variable.range).toEqual({ startLine: 6, startColumn: 1, endLine: 6, endColumn: 21 });
    expect(variable.selectionRange).toEqual({ startLine: 6, startColumn: 6, endLine: 6, endColumn: 11 });
    const weave = factOf('weave');
    expect(weave.selectionRange).toEqual({ startLine: 28, startColumn: 4, endLine: 28, endColumn: 6 });
  });

  it('每枚符号的 range 都完整包住 selectionRange', () => {
    for (const fact of FACTS) {
      const startsBefore =
        fact.range.startLine < fact.selectionRange.startLine ||
        (fact.range.startLine === fact.selectionRange.startLine &&
          fact.range.startColumn <= fact.selectionRange.startColumn);
      const endsAfter =
        fact.range.endLine > fact.selectionRange.endLine ||
        (fact.range.endLine === fact.selectionRange.endLine &&
          fact.range.endColumn >= fact.selectionRange.endColumn);
      expect(startsBefore, `${fact.name} 的 range 起点在名字之前`).toBe(true);
      expect(endsAfter, `${fact.name} 的 range 终点在名字之后`).toBe(true);
    }
  });

  it('七类声明的名字区间与 `kojo2DocumentOf` 的声明索引逐字一致（不养第二份尺子）', () => {
    const declarations = kojo2DocumentOf(FIXTURE).declarations;
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      const symbol = FACTS.find(
        (fact) => fact.kind === declaration.kind && fact.name === declaration.name,
      );
      expect(symbol, `${declaration.kind}:${declaration.name}`).toBeDefined();
      expect(symbol!.selectionRange).toEqual({
        startLine: declaration.line,
        startColumn: declaration.nameStart,
        endLine: declaration.line,
        endColumn: declaration.nameEnd,
      });
    }
  });
});

/* ============================== ④ 层级 ============================== */

describe('层级：container = 真 span 包含的最内层符号', () => {
  it('幕包住写在它后面的声明（视 / 机 / 表 / 池 / 模 / 函 / 织都是子项）', () => {
    const scene = factOf('scene', '神社清晨');
    const sceneIndex = indexOfFact(scene);
    for (const kind of [
      'view',
      'machine',
      'variable',
      'constant',
      'table',
      'pool',
      'template',
      'function',
      'weave',
    ] as const) {
      for (const child of FACTS.filter((fact) => fact.kind === kind)) {
        if (child === factOf('table', '天气')) continue; // 第二幕的表不属于第一幕
        expect(child.container, `${kind}:${child.name}`).toBe(sceneIndex);
      }
    }
  });

  it('多幕文件各收自己那一段（第二幕的表挂在第二幕下）', () => {
    const scene2 = factOf('scene', '神社黄昏');
    const scene2Index = indexOfFact(scene2);
    expect(scene2.container).toBeUndefined();
    expect(factOf('table', '天气').container).toBe(scene2Index);
  });

  it('声明区写在首个幕之前 ⇒ 顶层符号（没有容器）', () => {
    const source = '# 变量 甲 整数\n# 常量 乙 整数 = 1\n# 幕 开场\n> 正文\n';
    const facts = kojo2DocumentSymbols(source);
    const variable = facts.find((fact) => fact.kind === 'variable');
    const constant = facts.find((fact) => fact.kind === 'constant');
    expect(variable?.container).toBeUndefined();
    expect(constant?.container).toBeUndefined();
    const scene = facts.find((fact) => fact.kind === 'scene');
    expect(scene?.container).toBeUndefined();
  });

  it('container 恒指向更早的符号，且父区间完整包住子区间（无环、无向后引用）', () => {
    for (let i = 0; i < FACTS.length; i++) {
      const parent = FACTS[i]!.container;
      if (parent === undefined) continue;
      expect(parent, FACTS[i]!.name).toBeGreaterThanOrEqual(0);
      expect(parent, FACTS[i]!.name).toBeLessThan(i);
      const outer = FACTS[parent]!.range;
      const inner = FACTS[i]!.range;
      const startsBefore =
        outer.startLine < inner.startLine ||
        (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn);
      const endsAfter =
        outer.endLine > inner.endLine ||
        (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn);
      expect(startsBefore && endsAfter, FACTS[i]!.name).toBe(true);
    }
  });

  it('`@函` / `@织` 是可被幕包住的块（自身没有可嵌套的声明符号）', () => {
    expect(factOf('function').container).toBe(indexOfFact(factOf('scene', '神社清晨')));
    expect(factOf('weave').container).toBe(indexOfFact(factOf('scene', '神社清晨')));
    // 当前语法里声明不可能写进块体 ⇒ 它们不会成为任何符号的容器。
    const asParent = FACTS.filter((fact) => fact.container === indexOfFact(factOf('function')));
    expect(asParent).toEqual([]);
  });
});

/* ============================== ⑤ 确定性 ============================== */

describe('确定性：同输入必同输出，源码序', () => {
  it('两次调用逐字相等', () => {
    expect(kojo2DocumentSymbols(FIXTURE)).toEqual(FACTS);
  });

  it('CRLF 与 LF 同结果（换行不是符号语义）', () => {
    expect(kojo2DocumentSymbols(FIXTURE.replace(/\n/g, '\r\n'))).toEqual(FACTS);
  });

  it('排序键是 (起点行, 起点列, 名字码元序)，不是 locale', () => {
    const sorted = [...FACTS].sort(
      (a, b) =>
        a.selectionRange.startLine - b.selectionRange.startLine ||
        a.selectionRange.startColumn - b.selectionRange.startColumn ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    expect(FACTS).toEqual(sorted);
  });
});

/* ============================== ⑥ 空 / 坏输入 ============================== */

describe('空 / 坏输入：[] 且不抛', () => {
  it('空串 / 纯空白 ⇒ []', () => {
    expect(kojo2DocumentSymbols('')).toEqual([]);
    expect(kojo2DocumentSymbols('   \n\t\n\n')).toEqual([]);
  });

  it('非字符串 ⇒ []（运行时兜底，不抛）', () => {
    expect(kojo2DocumentSymbols(null as unknown as string)).toEqual([]);
    expect(kojo2DocumentSymbols(undefined as unknown as string)).toEqual([]);
  });

  it('识别不出的坏文件 ⇒ []', () => {
    expect(kojo2DocumentSymbols('这不是 Kojo 2.0\n???\n###\n')).toEqual([]);
  });

  it('声明缺名字 / 幕缺标题 ⇒ 那一条不产符号', () => {
    expect(kojo2DocumentSymbols('# 变量\n')).toEqual([]);
    expect(kojo2DocumentSymbols('# 幕\n> 正文\n')).toEqual([]);
  });

  it('局部坏行不带走其余合法声明（错误恢复：能给多少给多少）', () => {
    const source = '# 变量 甲 整数\n  这一行缩进错了\n# 表 乙 由 甲\n    否 零\n';
    const facts = kojo2DocumentSymbols(source);
    expect(facts.map((fact) => fact.name)).toContain('甲');
    expect(facts.map((fact) => fact.name)).toContain('乙');
  });

  it('坏输入永不抛（随机字符 / 未闭合围栏 / 混合换行）', () => {
    const sources = [
      '@原生\n    CALL X\n',
      '# 幕 甲\r\n# 变量 乙 整数\r\n',
      '[[[###@@@\n\n\t\t',
      `# 表 超长 由 ${'甲'.repeat(500)}\n    否 零\n`,
    ];
    for (const source of sources) {
      expect(() => kojo2DocumentSymbols(source)).not.toThrow();
      expect(Array.isArray(kojo2DocumentSymbols(source))).toBe(true);
    }
  });

  it('超长 detail 截断到一行（不折行、不丢代理对）', () => {
    const longSubject = '恋'.repeat(200);
    const facts = kojo2DocumentSymbols(`# 表 长 由 ${longSubject}\n    否 零\n`);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.detail.endsWith('…')).toBe(true);
    expect([...facts[0]!.detail].length).toBeLessThanOrEqual(60);
  });
});

/* ============================== ⑦ 面包屑路径 ============================== */

describe('面包屑路径：光标 → 根（最内层在前）', () => {
  it('表体里：表 → 幕', () => {
    expect(kojo2SymbolPathAt(FIXTURE, at(10, 5))).toEqual(['心情', '神社清晨']);
  });

  it('池分支正文里：池 → 幕', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 16, column: 9 })).toEqual(['早安问候', '神社清晨']);
  });

  it('模体 / 函体 / 织体里：所在块 → 幕', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 21, column: 5 })).toEqual(['娇羞退场', '神社清晨']);
    expect(kojo2SymbolPathAt(FIXTURE, { line: 26, column: 5 })).toEqual(['增加羁绊', '神社清晨']);
    expect(kojo2SymbolPathAt(FIXTURE, { line: 29, column: 5 })).toEqual(['指令', '神社清晨']);
  });

  it('声明行上（含行首 `#`）：该声明 → 幕', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 3, column: 1 })).toEqual(['灵梦', '神社清晨']);
    expect(kojo2SymbolPathAt(FIXTURE, { line: 9, column: 1 })).toEqual(['心情', '神社清晨']);
  });

  it('第二幕正文只给第二幕（不串到第一幕）', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 38, column: 1 })).toEqual(['神社黄昏']);
  });

  it('声明区（首个幕之前）只给那一条声明', () => {
    const source = '# 变量 独立 整数\n> 正文\n';
    expect(kojo2SymbolPathAt(source, { line: 1, column: 1 })).toEqual(['独立']);
  });

  it('不在任何符号区间（两幕之间 / 注释行）⇒ []', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 33, column: 1 })).toEqual([]);
    expect(kojo2SymbolPathAt(FIXTURE, { line: 1, column: 1 })).toEqual([]);
  });

  it('尾列可停靠（Monaco 行末列恰好等于 endColumn）', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 12, column: 9 })).toEqual(['心情', '神社清晨']);
  });

  it('越界 / 非法位点 / 空文件 ⇒ []（不猜）', () => {
    expect(kojo2SymbolPathAt(FIXTURE, { line: 9_999, column: 1 })).toEqual([]);
    expect(kojo2SymbolPathAt(FIXTURE, { line: 0, column: 1 })).toEqual([]);
    expect(kojo2SymbolPathAt(FIXTURE, { line: 1, column: 0 })).toEqual([]);
    expect(kojo2SymbolPathAt(FIXTURE, { line: Number.NaN, column: 1 })).toEqual([]);
    expect(kojo2SymbolPathAt('', { line: 1, column: 1 })).toEqual([]);
  });
});

/* ============================== ⑧ Monaco 翻译 ============================== */

describe('Monaco 翻译：SymbolKind 映射与 DocumentSymbol 树', () => {
  it('十类符号 → SymbolKind（单一映射表）', () => {
    const fake = fakeMonaco();
    const expected: Record<Kojo2SymbolKind, number> = {
      scene: SYMBOL_KINDS.Module,
      view: SYMBOL_KINDS.Variable,
      machine: SYMBOL_KINDS.Event,
      variable: SYMBOL_KINDS.Variable,
      constant: SYMBOL_KINDS.Constant,
      table: SYMBOL_KINDS.Struct,
      pool: SYMBOL_KINDS.Enum,
      template: SYMBOL_KINDS.Method,
      function: SYMBOL_KINDS.Function,
      weave: SYMBOL_KINDS.Event,
    };
    for (const kind of Object.keys(expected) as Kojo2SymbolKind[]) {
      expect(kojo2SymbolKindToMonaco(fake.monaco, kind), kind).toBe(expected[kind]);
    }
  });

  it('树形状：两个幕是根，声明是各自幕的子项（源码序）', () => {
    const fake = fakeMonaco();
    const tree = kojo2DocumentSymbolTree(fake.monaco, FACTS);
    expect(tree.map((node) => node.name)).toEqual(['神社清晨', '神社黄昏']);
    expect(tree[0]!.children?.map((node) => node.name)).toEqual([
      '灵梦',
      '指令',
      '亲近线',
      '今天已触发',
      '心情快照',
      '心情',
      '早安问候',
      '娇羞退场',
      '增加羁绊',
      '指令',
    ]);
    expect(tree[1]!.children?.map((node) => node.name)).toEqual(['天气']);
    // 空 children 不挂（避免点不开的假箭头）
    for (const node of tree) {
      for (const child of node.children ?? []) {
        expect(child.children).toBeUndefined();
      }
    }
  });

  it('name / detail / kind / tags / range / selectionRange 逐项搬运', () => {
    const fake = fakeMonaco();
    const tree = kojo2DocumentSymbolTree(fake.monaco, FACTS);
    const table = tree[0]!.children?.find((node) => node.name === '心情');
    expect(table).toBeDefined();
    expect(table!.detail).toBe(factOf('table', '心情').detail);
    expect(table!.kind).toBe(SYMBOL_KINDS.Struct);
    expect(table!.tags).toEqual([]);
    expect(table!.range).toEqual({
      startLineNumber: 9,
      startColumn: 1,
      endLineNumber: 12,
      endColumn: 9,
    });
    expect(table!.selectionRange).toEqual({
      startLineNumber: 9,
      startColumn: 5,
      endLineNumber: 9,
      endColumn: 7,
    });
  });

  it('坏 container（越界 / 指向自己或后面的兄弟）⇒ 当顶层，不接环', () => {
    const fake = fakeMonaco();
    const dangling = fact({ name: '孤儿', container: 5 });
    const root = fact({ name: '根' });
    const self = fact({ name: '错位', container: 2 });
    const tree = kojo2DocumentSymbolTree(fake.monaco, [dangling, root, self]);
    expect(tree.map((node) => node.name)).toEqual(['孤儿', '根', '错位']);
  });

  it('空事实 ⇒ 空树', () => {
    expect(kojo2DocumentSymbolTree(fakeMonaco().monaco, [])).toEqual([]);
  });
});

/* ============================== ⑨ 安装 / flag / 失败面 ============================== */

describe('安装：开关关也注册（只读面）、只挂 kojo2、dispose 幂等、失败回 []', () => {
  it('flag 关 ⇒ 仍恰好一枚注册（K2-STRUCTURE-GATE 改口：旧口径「零注册」作废）', () => {
    // 大纲是只读呈现面：cutover 只管写回 / 迁移 / 切解析器，关着也必须有 Ctrl+Shift+O。
    // 保留 stubFlag(false) 正是为了断言"开关确实关着，注册照样发生"。
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2DocumentSymbolProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(fake.disposeCalls).toHaveLength(1);
  });

  it('flag 开 ⇒ 恰好一枚注册，selector 只有 kojo2', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentSymbolProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(providerOf(fake).displayName).toBe('kojo2');
  });

  it('provider 对夹具返回同一棵树（两幕 + 子项）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentSymbolProvider(fake.monaco);
    const symbols = symbolsOf(fake, fakeModel(FIXTURE).model);
    expect(symbols.map((node) => node.name)).toEqual(['神社清晨', '神社黄昏']);
    expect(symbols[0]!.children).toHaveLength(10);
  });

  it('取文抛错 / 模型已释放 / 坏文件 ⇒ []（不抛进 Monaco）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentSymbolProvider(fake.monaco);
    const broken = fakeModel(FIXTURE);
    broken.breakModel();
    expect(symbolsOf(fake, broken.model)).toEqual([]);
    expect(symbolsOf(fake, fakeModel('').model)).toEqual([]);
    expect(symbolsOf(fake, fakeModel('???\n###\n').model)).toEqual([]);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2DocumentSymbolProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);
  });

  it('注册的 dispose 抛错不带走卸载链', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failDispose: true });
    const handle = installKojo2DocumentSymbolProvider(fake.monaco);
    expect(() => handle.dispose()).not.toThrow();
  });

  it('注册失败 ⇒ 错误外抛（宿主那侧的全有或全无才有东西可回滚）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failRegister: true });
    expect(() => installKojo2DocumentSymbolProvider(fake.monaco)).toThrow(/注册符号 provider/);
    expect(fake.disposeCalls).toEqual([]);
  });
});

/* ============================== ⑩ 源码卫生（读源码断言） ============================== */

describe('源码卫生：Monaco 只 type-only、不碰插件包、flag 自身再挡一次', () => {
  const source = readFileSync(
    resolve(REPO_ROOT, 'packages', 'app', 'src', 'monaco', 'kojo2-symbols.ts'),
    'utf8',
  );

  it('Monaco 运行时只许 type-only 引入（node 池不把 monaco 拉进模块图）', () => {
    expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
    expect(source).not.toMatch(/import \* as Monaco from/);
    expect(source).not.toMatch(/from 'monaco-editor'/);
  });

  it('不 import 任何插件包、不出现游戏名词', () => {
    expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-/);
    expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
  });

  it('安装器**不再**由 cutover 开关门控（K2-STRUCTURE-GATE：只读面）', () => {
    // 旧口径断言的是"安装器自带 flag 闸"，批次十一起折叠 / 大纲移出切流开关：
    // 断言反过来钉住"门控已拆"，注册行照旧只认 `kojo2`。
    expect(source).not.toMatch(/isKojo2CutoverEnabled/);
    expect(source).toMatch(/registerDocumentSymbolProvider\(\s*KOJO2_LANGUAGE_ID/);
  });
});
