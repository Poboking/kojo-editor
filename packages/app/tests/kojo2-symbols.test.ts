/**
 * K2-EDITOR-SYMBOLS · Kojo 2.0 文档符号（大纲 / Ctrl+Shift+O）与面包屑路径的**判据**闸。
 *
 * B2（2026-10-24）起这条腿改由共享收口挂上（`monaco/kojo-symbols.ts` 的
 * `installDocumentSymbolProvider` 带能力名 `documentSymbol`，kojo2 由 descriptor 的
 * `slotServices` 点名），供方是插件 `@kojo/plugin-kojo-lang`。B5b（2026-10-30）把宿主那枚
 * **零生产调用**的 `monaco/kojo2-symbols.ts`（原生安装器 + 第二份 Monaco 翻译）整块删除
 * ⇒ 事实只剩 `@kojo/kojo-lang` 这一份、Monaco 翻译只剩 `kojo-symbols.ts` 那一份。
 * 本文件因此只管**纯判据**（源码文本 → 符号事实 / 光标 → 根路径），不碰 Monaco 形状。
 *
 * 覆盖七件事：
 * 1. **声明面**：十类声明（幕 / 视 / 机 / 变量 / 常量 / 表 / 池 / 模 / 函 / 织）各出一枚符号，
 *    `?` 链 / 叙事 / 注释 / `@原生` 体一票不产；
 * 2. **detail**：声明词（core 单源）与类型 / 初值 / 存储期 / 行数 / 分支数 / 参数 / 修饰词；
 * 3. **真 span**：块区间取 core AST（表到末行表体、池到末条分支正文、模 / 函 / 织到块体、
 *    幕到本幕末个叙事节点），名字域与 `kojo2-declarations.ts` 的声明索引**逐字对拍**；
 * 4. **层级**：`container` = 真 span 包含的最内层符号（多幕各收自己那一段）；
 * 5. **确定性**：源码序、两次调用逐字相等、LF / CRLF 同结果；
 * 6. **空 / 坏输入**：`[]`、不抛；
 * 7. **面包屑路径**：`kojo2SymbolPathAt` 的"光标 → 根"、深层块 / 声明区 / 正文 / 越界。
 *
 * 夹具 `fixtures/kojo2/symbols.kojo2` 刻意把 `# 幕` 写在最前：这样它后面的声明都落在该幕的
 * 真 span 里，层级与块区间都能在同一份输入上验；另有用例用声明区在幕前的写法验"顶层符号"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KOJO2_SYMBOL_WORD_BY_KIND,
  kojo2DocumentOf,
  kojo2DocumentSymbols,
  kojo2SymbolPathAt,
  type Kojo2SymbolFact,
  type Kojo2SymbolKind,
  type Kojo2SymbolPosition,
} from '@kojo/kojo-lang';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURE = readFileSync(join(HERE, 'fixtures', 'kojo2', 'symbols.kojo2'), 'utf8');
const FACTS = kojo2DocumentSymbols(FIXTURE);

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

function at(line: number, column: number): Kojo2SymbolPosition {
  return { line, column };
}

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

  it('`@原生` 围栏里的 `# 设` 是原文，不产符号', () => {
    const source = '# 幕 测试\n@原生\n    # 设 原生里的 整数\n';
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
      `${KOJO2_SYMBOL_WORD_BY_KIND.table} 依据 恋慕 · 3 行`,
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
      '# 设 队列 整数[10] 存档',
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
      endColumn: 12,
    });
    expect(factOf('table', '天气').range).toEqual({
      startLine: 35,
      startColumn: 1,
      endLine: 37,
      endColumn: 11,
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
    expect(variable.range).toEqual({ startLine: 6, startColumn: 1, endLine: 6, endColumn: 20 });
    expect(variable.selectionRange).toEqual({ startLine: 6, startColumn: 5, endLine: 6, endColumn: 10 });
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
    const source = '# 设 甲 整数\n# 设 乙 整数 = 1\n# 幕 开场\n> 正文\n';
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
    expect(kojo2DocumentSymbols('# 设\n')).toEqual([]);
    expect(kojo2DocumentSymbols('# 幕\n> 正文\n')).toEqual([]);
  });

  it('局部坏行不带走其余合法声明（错误恢复：能给多少给多少）', () => {
    const source = '# 设 甲 整数\n  这一行缩进错了\n# 对照表 乙 依据 甲\n    否 -> 零\n';
    const facts = kojo2DocumentSymbols(source);
    expect(facts.map((fact) => fact.name)).toContain('甲');
    expect(facts.map((fact) => fact.name)).toContain('乙');
  });

  it('坏输入永不抛（随机字符 / 未闭合围栏 / 混合换行）', () => {
    const sources = [
      '@原生\n    CALL X\n',
      '# 幕 甲\r\n# 设 乙 整数\r\n',
      '[[[###@@@\n\n\t\t',
      `# 对照表 超长 依据 ${'甲'.repeat(500)}\n    否 零\n`,
    ];
    for (const source of sources) {
      expect(() => kojo2DocumentSymbols(source)).not.toThrow();
      expect(Array.isArray(kojo2DocumentSymbols(source))).toBe(true);
    }
  });

  it('超长 detail 截断到一行（不折行、不丢代理对）', () => {
    const longSubject = '恋'.repeat(200);
    const facts = kojo2DocumentSymbols(`# 对照表 长 依据 ${longSubject}\n    否 -> 零\n`);
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
    const source = '# 设 独立 整数\n> 正文\n';
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
