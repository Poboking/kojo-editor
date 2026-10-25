/**
 * K2-LSP-INLAY · Kojo 2.0 行内提示（`kojo2-inlay.ts`）的闸。
 *
 * 覆盖七件事：
 * 1. **类型提示**：`# 变量 / # 常量` 的显式类型、数组长度、未写类型时按初值推断，
 *    以及"推断不出不产"的四种反例（缺初值 / 初值表达式 / 坏尾巴 / 第二个记号不是类型）；
 * 2. **`@巡` 绑定**：本文件作者数组（无需 adapter）、adapter 命名集合（角色 / 键值）、
 *    adapter 重复声明 / 不支持 `@巡` / 集合未知时**都不猜**；
 * 3. **`# 表` 档数**：有兜底 / 缺兜底 / 只有兜底，且只在声明行尾产一枚（表体逐行不刷）；
 * 4. **范围**：只算 `range` 内的行、越界端点夹取、非法区间回空；
 * 5. **位置门**：`@原生` 体 / 注释 / 台词 / 旁白 / 转义字面文本不产；
 * 6. **上限与确定性**：200 条截断、源码序、两次调用逐字相等、CRLF 与 LF 同结果；
 * 7. **provider 面**：只挂 `kojo2`、flag 关零注册、dispose 幂等、异常回空、Monaco 种类映射、
 *    体量档让路、adapter getter 抛错退到"本文件数组"这一层，外加源码卫生断言。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { GameAdapter } from '@kojo/kojo-core';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import {
  KOJO2_INLAY_HINT_LIMIT,
  installKojo2InlayHintsProvider,
  kojo2InlayHints,
  toMonacoInlayHints,
  type Kojo2InlayHint,
} from '../src/monaco/kojo2-inlay';

const HERE = dirname(fileURLToPath(import.meta.url));
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

/* ============================== 假 Monaco / 假 model / 假 adapter ============================== */

interface Registration {
  readonly selector: string;
  readonly provider: Monaco.languages.InlayHintsProvider;
}

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: number[];
}

function fakeMonaco(options: { readonly failRegister?: boolean; readonly failDispose?: boolean } = {}): FakeMonaco {
  const registrations: Registration[] = [];
  const disposeCalls: number[] = [];
  const fake = {
    languages: {
      InlayHintKind: { Type: 1, Parameter: 2 },
      registerInlayHintsProvider: (selector: string, provider: Monaco.languages.InlayHintsProvider) => {
        if (options.failRegister === true) throw new Error('桩：注册 inlay provider 抛错');
        registrations.push({ selector, provider });
        return {
          dispose: () => {
            if (options.failDispose === true) throw new Error('桩：撤 inlay provider 抛错');
            disposeCalls.push(registrations.length);
          },
        };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations, disposeCalls };
}

interface FakeModelOptions {
  readonly lineCount?: number;
  readonly broken?: boolean;
  readonly disposed?: boolean;
  /** 桩 model 缺 `getLineCount`（验体量档判据缺失时不让路） */
  readonly noLineCount?: boolean;
}

function fakeModel(text: string, options: FakeModelOptions = {}): Monaco.editor.ITextModel {
  const model: Record<string, unknown> = {
    getValue: () => {
      if (options.broken === true) throw new Error('桩：模型已释放');
      return text;
    },
    isDisposed: () => options.disposed === true,
  };
  if (options.noLineCount !== true) {
    model.getLineCount = () => options.lineCount ?? text.split(/\r\n|\r|\n/).length;
  }
  return model as unknown as Monaco.editor.ITextModel;
}

interface FakeCollection {
  readonly name: string;
  readonly bindings: readonly string[];
}

/** 只造 `@巡` 提示要读的两格；其余 adapter 字段与提示无关（cast 保测试短） */
function fakeAdapter(
  collections: readonly FakeCollection[],
  arrayRule: { readonly bindings: readonly string[] } | null = { bindings: ['值', '下标'] },
): GameAdapter {
  return { foreachCollections: { collections, arrayRule } } as unknown as GameAdapter;
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

function labelsOf(source: string, adapter?: GameAdapter): string[] {
  return kojo2InlayHints(source, undefined, adapter === undefined ? {} : { adapter }).map((hint) => hint.label);
}

function hintOnLine(source: string, line: number): Kojo2InlayHint | undefined {
  return kojo2InlayHints(source).find((hint) => hint.position.lineNumber === line);
}

function providerOf(fake: FakeMonaco): Monaco.languages.InlayHintsProvider {
  const registration = fake.registrations[0];
  if (registration === undefined) throw new Error('没有注册 InlayHintsProvider');
  return registration.provider;
}

interface InlayResult {
  readonly hints: Monaco.languages.InlayHint[];
  readonly dispose?: () => void;
}

function provide(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  range: Monaco.IRange = { startLineNumber: 1, endLineNumber: 100_000, startColumn: 1, endColumn: 1 },
): InlayResult {
  return providerOf(fake).provideInlayHints(model, range as Monaco.Range, TOKEN) as InlayResult;
}

/* ============================== ① 类型提示 ============================== */

describe('类型提示：显式类型 / 数组长度 / 未写类型按初值推断', () => {
  it('`# 变量` 显式整数类型：行尾一枚 `整数`，paddingLeft 隔开原文', () => {
    const source = '# 变量 计数 整数 = 3';
    expect(kojo2InlayHints(source)).toEqual([
      {
        position: { lineNumber: 1, column: source.length + 1 },
        label: '整数',
        kind: 'type',
        paddingLeft: true,
      },
    ]);
  });

  it('`# 变量` 显式字符串类型', () => {
    expect(labelsOf('# 变量 名字 字符串 = "灵梦"')).toEqual(['字符串']);
  });

  it('`# 常量` 显式类型（core 词表转发）', () => {
    expect(labelsOf('# 常量 上限 整数 = 10')).toEqual(['整数']);
  });

  it('数组声明的类型带长度原文（`整数[3]`）', () => {
    expect(labelsOf('# 变量 队列 整数[3]')).toEqual(['整数[3]']);
  });

  it('未写类型：整数字面量初值 ⇒ `整数`', () => {
    expect(labelsOf('# 变量 甲 = 1')).toEqual(['整数']);
  });

  it('未写类型：双引号初值 ⇒ `字符串`', () => {
    expect(labelsOf('# 变量 乙 = "早"')).toEqual(['字符串']);
  });

  it('未写类型：十六进制颜色按整数字面量 ⇒ `整数`', () => {
    expect(labelsOf('# 变量 戊 = 0xFF8080')).toEqual(['整数']);
  });

  it('未写类型：`# 常量` 同样按初值推断（整数 / 字符串两例）', () => {
    expect(labelsOf('# 常量 己 = 2')).toEqual(['整数']);
    expect(labelsOf('# 常量 庚 = "x"')).toEqual(['字符串']);
  });

  it('存储期词跟在初值后不打断推断（`= "x" 存档`）', () => {
    expect(labelsOf('# 变量 壬 = "x" 存档')).toEqual(['字符串']);
  });

  it('显式类型 + 存储期：类型照给', () => {
    expect(labelsOf('# 变量 辛 整数 存档')).toEqual(['整数']);
  });

  it('推断不出：缺初值 / 只有名字 / 初值是表达式 / 尾巴不是存储期 ⇒ 一枚都不产', () => {
    expect(kojo2InlayHints('# 变量 丙 =')).toEqual([]);
    expect(kojo2InlayHints('# 变量 丙')).toEqual([]);
    expect(kojo2InlayHints('# 变量 丁 = 1 + 1')).toEqual([]);
    expect(kojo2InlayHints('# 变量 癸 = "x" 坏词')).toEqual([]);
  });

  it('第二个记号既不是类型也不是 `=` ⇒ 不猜（不当成类型别名）', () => {
    expect(kojo2InlayHints('# 变量 甲 数组 = 1')).toEqual([]);
  });

  it('显式类型但初值类型不符：类型事实仍来自 AST（只报类型，不做纠正）', () => {
    expect(labelsOf('# 变量 甲 整数 = "x"')).toEqual(['整数']);
  });

  it('`# 常量` 写了类型却没有初值（AST 不建节点）⇒ 用行内显式类型兜底', () => {
    expect(labelsOf('# 常量 无值 整数')).toEqual(['整数']);
  });

  it('只对 `# 变量 / # 常量` 产类型提示：表 / 池 / 模 / 函 / 机 行不产 type', () => {
    const source = [
      '# 表 心情 由 恋慕',
      '    否 未知',
      '# 池 问候',
      '    早安',
      '        > 早。',
      '# 模 退场(原因)',
      '    > 走。',
      '@函 增加(数值)',
      '    返 数值',
      '# 机 开场',
      '# 幕 测试',
    ].join('\n');
    expect(kojo2InlayHints(source).filter((hint) => hint.kind === 'type')).toEqual([]);
  });
});

/* ============================== ② `@巡` 绑定提示 ============================== */

describe('`@巡 <集合>` 绑定名：数组 / 角色集合 / 键值集合，解析不出不猜', () => {
  it('本文件声明的数组 + 没有 adapter ⇒ core 数组绑定表 `{值} {下标}`', () => {
    const source = ['# 变量 状态 整数[3]', '@巡 状态'].join('\n');
    expect(labelsOf(source)).toEqual(['整数[3]', '{值} {下标}']);
  });

  it('adapter 命名角色集合 ⇒ `{角} {名}`', () => {
    const adapter = fakeAdapter([{ name: '队伍', bindings: ['角', '名'] }]);
    expect(labelsOf('@巡 队伍', adapter)).toEqual(['{角} {名}']);
  });

  it('adapter 命名键值集合 ⇒ `{项} {键}`', () => {
    const adapter = fakeAdapter([{ name: '记录', bindings: ['项', '键'] }]);
    expect(labelsOf('@巡 记录', adapter)).toEqual(['{项} {键}']);
  });

  it('adapter 在场但集合未知 ⇒ 不猜（哪怕本文件有同名数组也会先按命名集合解析）', () => {
    const adapter = fakeAdapter([{ name: '队伍', bindings: ['角', '名'] }]);
    expect(kojo2InlayHints('@巡 未知', undefined, { adapter })).toEqual([]);
  });

  it('没有 adapter 时的命名集合（无本文件数组声明）⇒ 不猜', () => {
    expect(kojo2InlayHints('@巡 队伍')).toEqual([]);
  });

  it('adapter 同名集合重复声明 ⇒ 不猜（core 同判：解析不了该用哪一条）', () => {
    const adapter = fakeAdapter([
      { name: '队伍', bindings: ['角', '名'] },
      { name: '队伍', bindings: ['角', '名'] },
    ]);
    expect(kojo2InlayHints('@巡 队伍', undefined, { adapter })).toEqual([]);
  });

  it('adapter 明确不支持 `@巡`（foreachCollections = null）⇒ 本文件数组也不给', () => {
    const adapter = { foreachCollections: null } as unknown as GameAdapter;
    expect(kojo2InlayHints('@巡 状态', undefined, { adapter })).toEqual([]);
  });

  it('`@巡` 缺集合 ⇒ 不产（缺集合是诊断的事，不是提示）', () => {
    expect(kojo2InlayHints('@巡')).toEqual([]);
  });

  it('缩进的 `@巡`：提示压在块头行尾（列按含缩进的原文算）', () => {
    const line = '    @巡 状态';
    const source = ['# 变量 状态 整数[3]', line].join('\n');
    const hint = hintOnLine(source, 2);
    expect(hint).toEqual({
      position: { lineNumber: 2, column: line.length + 1 },
      label: '{值} {下标}',
      kind: 'binding',
      paddingLeft: true,
    });
  });

  it('`@巡` 在 `@原生` 围栏里是原文 ⇒ 不产', () => {
    const source = ['# 变量 状态 整数[3]', '@原生', '    @巡 状态'].join('\n');
    expect(kojo2InlayHints(source)).toEqual([
      {
        position: { lineNumber: 1, column: '# 变量 状态 整数[3]'.length + 1 },
        label: '整数[3]',
        kind: 'type',
        paddingLeft: true,
      },
    ]);
  });

  it('注释 / 台词 / 旁白里的 `@巡` 不产（位置门与悬停同一把尺子）', () => {
    expect(kojo2InlayHints('// @巡 状态')).toEqual([]);
    expect(kojo2InlayHints('> @巡 状态')).toEqual([]);
    expect(kojo2InlayHints('灵梦：「@巡 状态」')).toEqual([]);
  });
});

/* ============================== ③ `# 表` 档数提示 ============================== */

describe('`# 表` 档数 / 兜底：只做声明行尾一枚，不逐行刷', () => {
  const TABLE = [
    '# 表 心情 由 恋慕',
    '    0..99 疏远',
    '    100..499 平常',
    '    500.. 亲近',
    '    否 未知',
  ].join('\n');

  it('三档 + 否 ⇒ `3 档 · 有否`', () => {
    expect(kojo2InlayHints(TABLE)).toEqual([
      {
        position: { lineNumber: 1, column: '# 表 心情 由 恋慕'.length + 1 },
        label: '3 档 · 有否',
        kind: 'value',
        paddingLeft: true,
      },
    ]);
  });

  it('缺兜底 ⇒ `2 档 · 缺否`', () => {
    const source = ['# 表 心情 由 恋慕', '    0..99 疏远', '    100.. 平常'].join('\n');
    expect(labelsOf(source)).toEqual(['2 档 · 缺否']);
  });

  it('只有兜底 ⇒ `0 档 · 有否`', () => {
    expect(labelsOf(['# 表 心情 由 恋慕', '    否 未知'].join('\n'))).toEqual(['0 档 · 有否']);
  });

  it('表体里的 `//` 注释不进档数', () => {
    const source = ['# 表 心情 由 恋慕', '    // 说明', '    0..99 疏远', '    否 未知'].join('\n');
    expect(labelsOf(source)).toEqual(['1 档 · 有否']);
  });

  it('只有声明行尾一枚：表体每一行都不产提示', () => {
    const hints = kojo2InlayHints(TABLE);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.position.lineNumber).toBe(1);
  });

  it('表头残缺到 parser 建不出节点（`# 表` 没名字）⇒ 不产', () => {
    expect(kojo2InlayHints('# 表')).toEqual([]);
  });

  it('块体 / 表体里缩进的 `# 变量` 是原文，不是声明 ⇒ 不产类型提示', () => {
    const source = ['# 表 心情 由 恋慕', '    # 变量 甲 整数', '    否 未知'].join('\n');
    expect(labelsOf(source)).toEqual(['1 档 · 有否']);
  });
});

/* ============================== ④ 范围 ============================== */

describe('范围限定：只算传入 range 内的行', () => {
  const THREE = [
    '# 变量 甲 整数',
    '# 变量 乙 字符串',
    '# 常量 丙 整数 = 1',
  ].join('\n');

  it('只给第 2 行 ⇒ 只有第 2 行的提示', () => {
    const hints = kojo2InlayHints(THREE, { startLineNumber: 2, endLineNumber: 2 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ position: { lineNumber: 2 }, label: '字符串', kind: 'type' });
  });

  it('range 尾越界 ⇒ 夹到文件末行（不是回空）', () => {
    const hints = kojo2InlayHints(THREE, { startLineNumber: 2, endLineNumber: 99_999 });
    expect(hints.map((hint) => hint.position.lineNumber)).toEqual([2, 3]);
  });

  it('range 起点 0 ⇒ 夹到第 1 行', () => {
    const hints = kojo2InlayHints(THREE, { startLineNumber: 0, endLineNumber: 1 });
    expect(hints.map((hint) => hint.position.lineNumber)).toEqual([1]);
  });

  it('range 完全在文件外 ⇒ []', () => {
    expect(kojo2InlayHints(THREE, { startLineNumber: 99, endLineNumber: 120 })).toEqual([]);
  });

  it('非法 range（NaN）⇒ []（不悄悄退回整篇）', () => {
    expect(kojo2InlayHints(THREE, { startLineNumber: Number.NaN, endLineNumber: 2 })).toEqual([]);
    expect(kojo2InlayHints(THREE, { startLineNumber: 2, endLineNumber: Number.NaN })).toEqual([]);
  });

  it('不给 range ⇒ 整篇', () => {
    expect(kojo2InlayHints(THREE).map((hint) => hint.position.lineNumber)).toEqual([1, 2, 3]);
  });
});

/* ============================== ⑤ 位置门 / 编码 ============================== */

describe('位置门与编码：注释 / 台词 / 旁白不产，CRLF 与中文不漂', () => {
  it('整行注释里的 `# 变量` 是注释文本 ⇒ 不产', () => {
    expect(kojo2InlayHints('// # 变量 甲 整数')).toEqual([]);
  });

  it('旁白 / 台词正文里的 `# 变量` 不是声明 ⇒ 不产', () => {
    expect(kojo2InlayHints('> # 变量 甲 整数')).toEqual([]);
    expect(kojo2InlayHints('灵梦：「# 变量 甲 整数」')).toEqual([]);
  });

  it('CRLF 与 LF 的提示逐字相等（行号 / 列 / 标签都不漂）', () => {
    const lf = ['# 变量 甲 整数 = 1', '# 常量 乙 字符串 = "x"'].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(kojo2InlayHints(crlf)).toEqual(kojo2InlayHints(lf));
  });

  it('中文名 / 中文初值：列是 UTF-16 码元，行尾列 = 原文长度 + 1', () => {
    const line = '# 变量 心情 字符串 = "很好"';
    const hint = hintOnLine(line, 1);
    expect(hint?.position).toEqual({ lineNumber: 1, column: line.length + 1 });
    expect(hint?.label).toBe('字符串');
  });

  it('空串 / 纯空白 / 非字符串 ⇒ []（运行时兜底不抛）', () => {
    expect(kojo2InlayHints('')).toEqual([]);
    expect(kojo2InlayHints('   \n\t\n')).toEqual([]);
    expect(kojo2InlayHints(null as unknown as string)).toEqual([]);
    expect(kojo2InlayHints(undefined as unknown as string)).toEqual([]);
  });

  it('坏行不带走其余合法声明（错误恢复：能给多少给多少）', () => {
    const source = ['# 变量 甲 整数', '??? 坏行', '# 常量 乙 整数 = 2'].join('\n');
    expect(labelsOf(source)).toEqual(['整数', '整数']);
  });

  it('未闭合的 `@原生` 围栏 / 随机字符不抛', () => {
    const sources = ['@原生\n    CALL X\n', '[[[###@@@\n\n\t\t', '# 表 超长 由 甲\n    否 零\n'];
    for (const source of sources) {
      expect(() => kojo2InlayHints(source)).not.toThrow();
    }
  });
});

/* ============================== ⑥ 上限 / 确定性 ============================== */

describe('上限与确定性', () => {
  it('超过 200 条按源码序截断，最后一条停在第 200 行', () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(`# 变量 甲${i} 整数`);
    const hints = kojo2InlayHints(lines.join('\n'));
    expect(hints).toHaveLength(KOJO2_INLAY_HINT_LIMIT);
    expect(KOJO2_INLAY_HINT_LIMIT).toBe(200);
    expect(hints[0]!.position.lineNumber).toBe(1);
    expect(hints[199]!.position.lineNumber).toBe(200);
  });

  it('两次调用逐字相等（纯函数）', () => {
    const source = ['# 变量 甲 整数', '# 表 心情 由 恋慕', '    否 未知', '@巡 甲'].join('\n');
    expect(kojo2InlayHints(source)).toEqual(kojo2InlayHints(source));
  });

  it('输出按（行，列）升序', () => {
    const source = ['# 常量 丙 整数 = 1', '# 变量 甲 整数', '# 表 心情 由 恋慕', '    否 未知'].join('\n');
    const lines = kojo2InlayHints(source).map((hint) => hint.position.lineNumber);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

/* ============================== ⑦ Monaco 翻译 / provider ============================== */

describe('Monaco 翻译：种类映射与 padding 透传', () => {
  it('type → Type(1)、binding → Parameter(2)、value 不借邻居颜色（kind 留空）', () => {
    const { monaco } = fakeMonaco();
    const out = toMonacoInlayHints(monaco, [
      { position: { lineNumber: 1, column: 2 }, label: '整数', kind: 'type', paddingLeft: true },
      { position: { lineNumber: 2, column: 2 }, label: '{值} {下标}', kind: 'binding', paddingLeft: true },
      { position: { lineNumber: 3, column: 2 }, label: '3 档 · 有否', kind: 'value', paddingLeft: true },
    ]);
    expect(out[0]).toMatchObject({ kind: 1, paddingLeft: true, label: '整数' });
    expect(out[1]).toMatchObject({ kind: 2, paddingLeft: true, label: '{值} {下标}' });
    expect(out[2]!.kind).toBeUndefined();
    expect(out[2]!.paddingLeft).toBe(true);
  });

  it('paddingRight 缺省不出现；给了原样透传', () => {
    const { monaco } = fakeMonaco();
    const out = toMonacoInlayHints(monaco, [
      { position: { lineNumber: 1, column: 1 }, label: '甲', kind: 'type' },
      { position: { lineNumber: 1, column: 1 }, label: '乙', kind: 'type', paddingRight: true },
    ]);
    expect(out[0]!.paddingRight).toBeUndefined();
    expect(out[1]!.paddingRight).toBe(true);
  });
});

describe('安装：只挂 kojo2、不读开关、dispose 幂等、异常回空', () => {
  it('缺省档（v1-only）⇒ 照样注册一枚，句柄可重复 dispose', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2InlayHintsProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(fake.disposeCalls).toHaveLength(1);
  });

  it('flag 开 ⇒ 恰好一枚注册，selector 只有 kojo2', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(typeof providerOf(fake).provideInlayHints).toBe('function');
    expect(providerOf(fake).provideInlayHints).toBeTypeOf('function');
  });

  it('provider 对 `# 变量` 交回 Monaco 形状的提示（position / label / kind / padding）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    const source = '# 变量 甲 整数';
    const result = provide(fake, fakeModel(source));
    expect(result.hints).toEqual([
      {
        position: { lineNumber: 1, column: source.length + 1 },
        label: '整数',
        kind: 1,
        paddingLeft: true,
      },
    ]);
    expect(typeof result.dispose).toBe('function');
  });

  it('三类提示的种类映射：type=1 / binding=2 / value 缺省', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    const source = [
      '# 变量 状态 整数[3]',
      '@巡 状态',
      '# 表 心情 由 恋慕',
      '    否 未知',
    ].join('\n');
    const result = provide(fake, fakeModel(source));
    expect(result.hints.map((hint) => hint.kind)).toEqual([1, 2, undefined]);
  });

  it('provider 把 range 透传给纯函数：只交回这一段的提示', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    const source = ['# 变量 甲 整数', '# 变量 乙 字符串', '# 常量 丙 整数 = 1'].join('\n');
    const result = provide(fake, fakeModel(source), {
      startLineNumber: 2,
      endLineNumber: 2,
      startColumn: 1,
      endColumn: 1,
    });
    expect(result.hints.map((hint) => hint.position.lineNumber)).toEqual([2]);
  });

  it('取文抛错 / 模型已释放 ⇒ `{ hints: [] }`（不抛进 Monaco）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    expect(provide(fake, fakeModel('# 变量 甲 整数', { broken: true })).hints).toEqual([]);
    expect(provide(fake, fakeModel('# 变量 甲 整数', { disposed: true })).hints).toEqual([]);
  });

  it('超出体量档（≥ LARGE_FILE_LINES）⇒ 整体让路（与 stickyScroll / 面包屑同一条线）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    const model = fakeModel('# 变量 甲 整数', { lineCount: LARGE_FILE_LINES });
    expect(provide(fake, model).hints).toEqual([]);
  });

  it('桩 model 缺 `getLineCount` ⇒ 不因体量判据缺席而回空', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco);
    const model = fakeModel('# 变量 甲 整数', { noLineCount: true });
    expect(provide(fake, model).hints.map((hint) => hint.label)).toEqual(['整数']);
  });

  it('adapter getter 抛错 ⇒ 退到"本文件数组"这一层，不把 provider 带崩', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco, {
      adapter: () => {
        throw new Error('boom');
      },
    });
    const source = ['# 变量 状态 整数[3]', '@巡 状态'].join('\n');
    expect(provide(fake, fakeModel(source)).hints.map((hint) => hint.label)).toEqual([
      '整数[3]',
      '{值} {下标}',
    ]);
  });

  it('adapter 注入：命名集合的绑定名进 provider', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2InlayHintsProvider(fake.monaco, {
      adapter: fakeAdapter([{ name: '队伍', bindings: ['角', '名'] }]),
    });
    expect(provide(fake, fakeModel('@巡 队伍')).hints.map((hint) => hint.label)).toEqual(['{角} {名}']);
  });

  it('dispose 幂等：两次只撤一轮；注册的 dispose 抛错不带走卸载链', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2InlayHintsProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls).toHaveLength(1);

    const failing = fakeMonaco({ failDispose: true });
    const failingHandle = installKojo2InlayHintsProvider(failing.monaco);
    expect(() => failingHandle.dispose()).not.toThrow();
  });

  it('注册失败 ⇒ 错误外抛（只有一枚注册，没有半成品要回滚）', () => {
    stubFlag(true);
    const fake = fakeMonaco({ failRegister: true });
    expect(() => installKojo2InlayHintsProvider(fake.monaco)).toThrow(/注册 inlay provider/);
    expect(fake.disposeCalls).toEqual([]);
  });
});

/* ============================== ⑧ 源码卫生 ============================== */

describe('源码卫生：Monaco 只 type-only、不碰插件包、安装器自带 flag 闸', () => {
  const source = readFileSync(resolve(HERE, '..', 'src', 'monaco', 'kojo2-inlay.ts'), 'utf8');

  it('Monaco 运行时只许 type-only 引入（node 池不把 monaco 拉进模块图）', () => {
    expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
    expect(source).not.toMatch(/import \* as Monaco from/);
    expect(source).not.toMatch(/from 'monaco-editor'/);
  });

  it('不 import 任何插件包、不出现游戏名词', () => {
    expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-/);
    expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
  });

  it('安装器自带 flag 闸，且注册 selector 只有 KOJO2_LANGUAGE_ID', () => {
    expect(source).not.toMatch(/isKojo2CutoverEnabled/);
    expect(source).toMatch(/registerInlayHintsProvider\(\s*KOJO2_LANGUAGE_ID/);
  });
});
