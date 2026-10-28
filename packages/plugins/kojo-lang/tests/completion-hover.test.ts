/**
 * B3c 补全 / 悬停两条腿的判据（`src/completion.ts` + `src/hover.ts` + `plugin.ts` 接线）。
 *
 * 六组断言，各自防一种真实退化：
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——混成空结果会把下一家顶掉；
 * 2. **kind 十二档映射逐格对表（简报§四）**：图标错了就是行为变了——作者对候选集的
 *    视觉记忆断了，这一组逐格钉，一格都不许降级；
 * 3. **逐格翻译**：`filterText` = `label`、`insertText`/`detail`/`sortText` 透传、
 *    `range` = 整枚名字段（零宽兜底）、行首追加 snippet 档；
 * 4. **documentation 两格**：命中声明 ⇒ Markdown + `documentationFormat: 'markdown'`；
 *    **索引只在真有声明类候选的这一轮建**（事件轮里同名也不给——与今天宿主逐字一致）；
 * 5. **adapter 纪律**：请求时现取 + `adapter.id === project.adapterId` 才对得上；
 *    对不上 ⇒ **少给那一部分**（adapter 事实四路零候选，源文能证明的路照给）；
 * 6. **悬停两段合成一条 `contents`**（本批唯一被允许的呈现差量）：声明段在前、展开段在后、
 *    `'\n\n'` 相连；**仅 `via === 'call-site'` 追加展开段**；取不到编译成品 ⇒ 只有声明段；
 *    两段都没有 ⇒ `undefined`（不是 `{contents:''}`——空串＝作答会顶掉下一家）。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution, PluginContext } from '@kojo/plugin-api';
import type { GameAdapter } from '@kojo/kojo-core';
import type { Kojo2CompletionCandidate } from '@kojo/kojo-lang/completion';
import type { Kojo2ExpandCompilation } from '@kojo/kojo-lang/expand-view';
import { registerKojo2AdapterSource } from '@kojo/kojo-lang/adapter-source';
import { registerKojo2ExpandCompileSource } from '@kojo/kojo-lang/expand-compile';
import { createKojoLangPlugin, provideCompletion, provideHover } from '../src/index';
import { completionItemKindOf } from '../src/completion';

const PATH = 'D:/proj/口上/1_测试.kojo2';

/** 补全夹具：覆盖锚点 / 声明名 / 事件名 / 插值 / 行首空行五个出货位 */
const SOURCE = [
  '# 幕 序幕', // 1
  '# 变量 今日计数 整数 = 0 存档', // 2
  '# 常量 上限 整数 = 99', // 3
  '# 表 心情 由 好感', // 4
  '    0..99 疏远', // 5
  '    否 未知', // 6
  '# 池 招呼', // 7
  '    ? 今日计数 > 3', // 8
  '        > 你好', // 9
  '    ? 否', // 10
  '        > 再见', // 11
  '# 模 问候(原因)', // 12
  '    [插槽]', // 13
  '@函 加一(数值=1)', // 14
  '> 台词{心情}正文', // 15
  '', // 16
  '# 机 开', // 17
  '! 招', // 18
].join('\n');

function completionRequest(line: number, column: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'completion' as const,
    path: PATH,
    text: SOURCE,
    line,
    column,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

function hoverRequest(line: number, column: number, text: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'hover' as const,
    path: PATH,
    text,
    line,
    column,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

/** 只造补全/悬停要读的两格（`eventCatalog` / `presentation`）；其余字段与这两条腿无关（cast 保测试短） */
function stubAdapter(
  id: string,
  events: readonly string[],
  presentation: { faceTemplates?: unknown; hintNames?: readonly string[] } = {},
): GameAdapter {
  return {
    id,
    eventCatalog: { events: events.map((event) => ({ event, args: [] })), defaultEvent: null },
    presentation,
  } as unknown as GameAdapter;
}

/* ============================== 补全腿 ============================== */

describe('completion 供方：语言过滤与三态', () => {
  it('不是 completion / 不是 kojo2 ⇒ undefined（弃权，不是空结果）', () => {
    expect(provideCompletion({ kind: 'hover', path: 'a.kojo2', text: '', line: 1, column: 1, project: null } as never)).toBeUndefined();
    expect(provideCompletion(completionRequest(16, 1, { languageId: 'erb' }))).toBeUndefined();
  });

  it('认这个位置但一个候选都没有 ⇒ items: []（不猜）', () => {
    // 台词正文：位置门退让——是"作答"，不是弃权
    expect(provideCompletion(completionRequest(15, 3))).toEqual({ kind: 'completion', items: [] });
    // `# 机` 事件位没有 adapter 事实：零候选（不猜任何内置事件）
    expect(provideCompletion(completionRequest(17, 6))).toEqual({ kind: 'completion', items: [] });
  });

  it('行首空轮 ⇒ 五锚点 + 五条块级 snippet（`kind: \'snippet\'`，追加在纯函数候选之后）', () => {
    const items = provideCompletion(completionRequest(16, 1))!.items;
    expect(items.map((item) => item.label)).toEqual([
      '#', '@', '>', '?', '!',
      '? 链（条件 + 否）',
      expect.any(String), expect.any(String), expect.any(String), expect.any(String),
    ]);
    expect(items.slice(0, 5).every((item) => item.kind === 'operator')).toBe(true);
    expect(items.slice(5).every((item) => item.kind === 'snippet')).toBe(true);
    expect(items[5]!.sortText).toMatch(/^9_snippet/);
    expect(items[5]!.insertText).toContain('${1:');
    // 图标与插入语义是两件事（契约 insertTextFormat）：块级骨架才声明 snippet 插入
    expect(items.slice(5).every((item) => item.insertTextFormat === 'snippet')).toBe(true);
    expect(items.slice(0, 5).every((item) => item.insertTextFormat === undefined)).toBe(true);
  });
});

describe('completion 供方：逐格翻译（与今天宿主对齐）', () => {
  it('锚点条目：filterText = label、sortText 透传、零宽 range、无 documentation 两格', () => {
    const anchor = provideCompletion(completionRequest(16, 1))!.items[0]!;
    expect(anchor).toEqual({
      label: '#',
      kind: 'operator',
      insertText: '#',
      detail: '锚点',
      sortText: '0_#',
      filterText: '#',
      range: { line: 16, startColumn: 1, endColumn: 1 },
    });
  });

  it('`! 招`：声明候选 enum 档 + range 吞**整枚名字段** + documentation Markdown', () => {
    const items = provideCompletion(completionRequest(18, 4))!.items;
    const call = items.find((item) => item.label === '招呼')!;
    expect(call.kind).toBe('enum');
    expect(call.detail).toContain('本文件第 7 行');
    expect(call.sortText).toBe('4_pool_招呼');
    expect(call.filterText).toBe('招呼');
    // `! 招`：名字段 `招` 占第 3 列（半开到 4），替换整段而不是"到光标为止"
    expect(call.range).toEqual({ line: 18, startColumn: 3, endColumn: 4 });
    expect(call.documentation).toContain('**招呼**（池声明）');
    expect(call.documentationFormat).toBe('markdown');
  });

  it('插值表达式位（空前缀整表）：声明类给 Markdown 两格、非声明类不写这两格（缺省 = 旧形态）', () => {
    // 第 15 行 `{心情}` 内是表达式位 ⇒ 域符号 + 表 / 池 / 模 / 函（文档索引这一轮**要建**：有声明类候选）
    const declared = provideCompletion(completionRequest(15, 6))!.items;
    expect(declared.map((item) => item.label)).toEqual(['我', '你', '她', '心情', '招呼', '问候', '加一']);
    const byLabel = new Map(declared.map((item) => [item.label, item]));
    // 域符号：variable 档、**不写** documentation 两格（`filterText` 仍是 label）
    expect(byLabel.get('我')!.kind).toBe('variable');
    expect('documentation' in byLabel.get('我')!).toBe(false);
    expect('documentationFormat' in byLabel.get('我')!).toBe(false);
    // 声明类逐档：表→struct、池→enum、模→snippet、函→function，各带 Markdown documentation
    expect(byLabel.get('心情')!.kind).toBe('struct');
    expect(byLabel.get('心情')!.documentation).toContain('**心情**（表声明）');
    expect(byLabel.get('心情')!.documentationFormat).toBe('markdown');
    expect(byLabel.get('招呼')!.kind).toBe('enum');
    expect(byLabel.get('招呼')!.documentation).toContain('**招呼**（池声明）');
    expect(byLabel.get('问候')!.kind).toBe('snippet');
    // `# 模` 的声明名只借 snippet 的**图标**，不声明 snippet 插入（宿主今天也只给块级骨架开
    // `InsertAsSnippet`）——这一格写成 snippet 就会把名字里的 `$` / `}` 当槽位解释。
    expect('insertTextFormat' in byLabel.get('问候')!).toBe(false);
    expect(byLabel.get('问候')!.documentation).toContain('**问候**（模声明）');
    expect(byLabel.get('加一')!.kind).toBe('function');
    expect(byLabel.get('加一')!.documentation).toContain('**加一**（函声明）');
    // 锚点轮（无声明类候选）⇒ 所有条目都不带 documentation / documentationFormat
    for (const item of provideCompletion(completionRequest(16, 1))!.items) {
      expect('documentation' in item).toBe(false);
      expect('documentationFormat' in item).toBe(false);
    }
  });

  it('声明索引**只在声明轮建**：事件候选与声明同名也不给 documentation（与今天逐字一致）', () => {
    const adapter = stubAdapter('proj-a', ['心情']);
    const items = provideCompletion(
      completionRequest(4, 6, { text: '# 表 心情 由 好感\n    0..99 疏远\n    否 未知\n# 机 心情' }),
      { adapter },
    )!.items;
    const event = items.find((item) => item.label === '心情')!;
    expect(event.kind).toBe('event');
    expect('documentation' in event).toBe(false);
    // 对偶面：同一名字走**声明轮**（`{心` 插值位、前缀 `心` 只剩 心情）⇒ 索引建了、documentation 有
    const inExpression = provideCompletion(completionRequest(15, 7), { adapter })!.items;
    expect(inExpression.map((item) => item.label)).toEqual(['心情']);
    const table = inExpression[0]!;
    expect(table.documentation).toContain('**心情**（表声明）');
  });
});

describe('kind 十二档映射逐格对表（简报§四——图标错了就是行为变了）', () => {
  const candidate = (kind: string, declarationKind?: string): Kojo2CompletionCandidate =>
    ({
      label: '示例',
      insertText: '示例',
      kind,
      detail: 'd',
      sortText: '0',
      ...(declarationKind === undefined ? {} : { declarationKind }),
    }) as unknown as Kojo2CompletionCandidate;

  const TABLE: readonly [Kojo2CompletionCandidate, string][] = [
    [candidate('anchor'), 'operator'],
    [candidate('declarationWord'), 'keyword'],
    [candidate('event'), 'event'],
    [candidate('domainSymbol'), 'variable'],
    [candidate('declaration', 'variable'), 'variable'],
    [candidate('declaration', 'constant'), 'constant'],
    [candidate('declaration', 'table'), 'struct'],
    [candidate('declaration', 'pool'), 'enum'],
    [candidate('declaration', 'template'), 'snippet'],
    [candidate('declaration', 'function'), 'function'],
    [candidate('declaration', 'scene'), 'module'],
    [candidate('declaration'), 'text'],
    [candidate('declaration', '未来新增的种类'), 'text'],
    [candidate('eventArgument'), 'value'],
    [candidate('valueType'), 'keyword'],
    [candidate('storagePeriod'), 'keyword'],
    [candidate('templateParam'), 'variable'],
    [candidate('faceObject'), 'variable'],
    [candidate('faceArgument'), 'value'],
    [candidate('templateSlot'), 'text'],
    [candidate('hintName'), 'text'],
    [candidate('未知类别'), 'text'],
  ];

  for (const [input, expected] of TABLE) {
    it(`${input.kind}${input.declarationKind === undefined ? '' : ` + ${input.declarationKind}`} ⇒ ${expected}`, () => {
      expect(completionItemKindOf(input)).toBe(expected);
    });
  }
});

describe('completion 供方：adapter 纪律（经 plugin.ts 接线，请求时现取 + 只认 id）', () => {
  /** 起插件、抓两条语言服务贡献（真实接线形状，不手搓注入） */
  function activate(): Map<string, EditorLanguageServiceContribution> {
    const contributions = new Map<string, EditorLanguageServiceContribution>();
    const ctx = {
      pluginId: 'kojo-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, item: EditorLanguageServiceContribution) => {
          if (slot === 'ui.editor.languageService') contributions.set(item.id, item);
          return () => undefined;
        },
      },
    } as unknown as PluginContext;
    createKojoLangPlugin().activate(ctx);
    return contributions;
  }

  /** 槽 `provide` 的联合结果窄到 items（前面已断言 `kind === 'completion'`；窄形只为准测短） */
  const itemsOf = (result: unknown): readonly { label: string; kind?: string }[] =>
    ((result as { items?: readonly { label: string; kind?: string }[] } | null | undefined)?.items ?? []);

  it('id 对得上 ⇒ 事件候选；对不上 / 没有 project ⇒ 少给那一部分（其余路照给）', () => {
    const adapter = stubAdapter('proj-a', ['开场白']);
    const unregister = registerKojo2AdapterSource(() => adapter);
    try {
      const completion = activate().get('kojo2-completion')!;
      // 对得上：`# 机 开` 出货
      const matched = completion.provide(completionRequest(17, 6, { project: { adapterId: 'proj-a' } as never }));
      expect(matched!.kind).toBe('completion');
      expect(itemsOf(matched).map((item) => item.label)).toEqual(['开场白']);
      // 对不上：同位零候选（不拿 A 游戏的目录解释 B 游戏的 `# 机`）
      const mismatched = completion.provide(completionRequest(17, 6, { project: { adapterId: 'proj-b' } as never }));
      expect(itemsOf(mismatched)).toEqual([]);
      // 没有 project：同样少给 adapter 事实；但源文能证明的路**不受牵连**
      const noProject = completion.provide(completionRequest(18, 4));
      expect(itemsOf(noProject).map((item) => item.label)).toEqual(['招呼']);
      const anchors = completion.provide(completionRequest(16, 1));
      expect(itemsOf(anchors)).toHaveLength(10);
    } finally {
      unregister();
    }
  });

  it('行尾提示名走同一条 adapter 投影（presentation 字段有则给、无则零候选——不猜）', () => {
    const adapter = stubAdapter('proj-a', [], { hintNames: ['心形'] });
    const hintRequest = completionRequest(1, 13, { text: '> 台词{心情}正文(心' });
    const items = provideCompletion(hintRequest, { adapter })!.items;
    expect(items.map((item) => item.label)).toEqual(['心形']);
    expect(items[0]!.kind).toBe('text');
    expect(items[0]!.documentationFormat).toBeUndefined();
    // 没有 adapter ⇒ 同一位置零候选（少给那一部分：不弃权、不猜）
    expect(provideCompletion(hintRequest)).toEqual({ kind: 'completion', items: [] });
  });
});

/* ============================== 悬停腿 ============================== */

const HOVER_SOURCE = [
  '! 心情', // 1（引用处：表 心情 在第 3 行声明）
  '', // 2
  '# 表 心情 由 好感', // 3（声明处）
  '    0..99 疏远', // 4
  '    否 未知', // 5
  '# 机 开场白', // 6（事件挂点）
].join('\n');

/** 展开视图的桩编译成品：产物第 2 行 ← 调用行 1 / 定义段 3..5 / 展开体源行 3 */
function fakeCompilation(): Kojo2ExpandCompilation {
  const call = { start: { line: 1, column: 3 }, end: { line: 1, column: 5 } };
  const definition = { start: { line: 3, column: 1 }, end: { line: 5, column: 5 } };
  const body = { start: { line: 3, column: 5 }, end: { line: 3, column: 7 } };
  const mapping = {
    source: body,
    origins: [
      { kind: 'call-site', span: call },
      { kind: 'template-definition', span: definition },
    ],
  };
  const model = {
    generatedInRange: () => [{ generatedLine: 2, via: 'origin' }],
    lineAt: (n: number) => (n === 2 ? mapping : null),
  };
  return { compiled: { erb: 'PRE\nBODY' }, sourceMapModel: model } as unknown as Kojo2ExpandCompilation;
}

describe('hover 供方：语言过滤与三态分家', () => {
  it('不是 hover / 不是 kojo2 ⇒ undefined（弃权）', () => {
    expect(provideHover({ kind: 'definition', path: 'a.kojo2', text: '', line: 1, column: 1, project: null } as never)).toBeUndefined();
    expect(provideHover(hoverRequest(3, 5, HOVER_SOURCE, { languageId: 'erb' }))).toBeUndefined();
  });

  it('声明处 / 引用处 ⇒ Markdown 正文 + format + 名字段 range', () => {
    const result = provideHover(hoverRequest(3, 5, HOVER_SOURCE))!;
    expect(result.kind).toBe('hover');
    expect(result.format).toBe('markdown');
    expect(result.contents.startsWith('**心情**（表声明）')).toBe(true);
    expect(result.contents).toContain('来源行：第 3 行');
    expect(result.range).toEqual({ line: 3, startColumn: 5, endColumn: 7 });

    const reference = provideHover(hoverRequest(1, 3, HOVER_SOURCE))!;
    expect(reference.contents).toContain('**心情**（表声明）');
    expect(reference.range).toEqual({ line: 1, startColumn: 3, endColumn: 5 });
  });

  it('此处没有事实 ⇒ undefined（**不是** {contents:\'\'}——空串＝作答会顶掉下一家）', () => {
    expect(provideHover(hoverRequest(2, 1, HOVER_SOURCE))).toBeUndefined();
  });

  it('adapter 纪律：id 对得上才有事件悬停；对不上 ⇒ 事件名不给（其余声明事实照旧）', () => {
    const contributions = (() => {
      const map = new Map<string, EditorLanguageServiceContribution>();
      const ctx = {
        pluginId: 'kojo-lang',
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        slots: {
          register: (slot: string, item: EditorLanguageServiceContribution) => {
            if (slot === 'ui.editor.languageService') map.set(item.id, item);
            return () => undefined;
          },
        },
      } as unknown as PluginContext;
      createKojoLangPlugin().activate(ctx);
      return map;
    })();
    const hover = contributions.get('kojo2-hover')!;
    const unregister = registerKojo2AdapterSource(() => stubAdapter('proj-a', []));
    try {
      const matched = hover.provide(hoverRequest(6, 5, HOVER_SOURCE, { project: { adapterId: 'proj-a' } as never }));
      expect(matched).toBeDefined();
      expect((matched as { contents: string }).contents).toContain('“开场白”');
      expect((matched as { contents: string }).contents).toContain('可用事件');
      expect(hover.provide(hoverRequest(6, 5, HOVER_SOURCE, { project: { adapterId: 'proj-b' } as never }))).toBeUndefined();
      // 声明事实不受牵连
      const declaration = hover.provide(hoverRequest(3, 5, HOVER_SOURCE, { project: { adapterId: 'proj-b' } as never }));
      expect((declaration as { contents: string }).contents).toContain('**心情**（表声明）');
    } finally {
      unregister();
    }
  });
});

describe('hover 供方：展开段（两段合成一条 contents，本批唯一差量）', () => {
  it('调用行命中 ⇒ 声明段在前 + 展开段在后，`\\n\\n` 相连成**一枚字符串**', () => {
    const compilation = fakeCompilation();
    const unregister = registerKojo2ExpandCompileSource((path) => (path === PATH ? compilation : null));
    try {
      const result = provideHover(hoverRequest(1, 3, HOVER_SOURCE))!;
      expect(typeof result.contents).toBe('string');
      expect(result.contents).toContain('**心情**（表声明）');
      expect(result.contents).toContain('展开产物：第 2 行（1 行）');
      expect(result.contents.indexOf('表声明')).toBeLessThan(result.contents.indexOf('展开产物'));
      // 两段之间的接缝恰是 `'\n\n'`（声明段末段与展开段标题之间）
      expect(result.contents).toContain('（表声明）');
      expect(result.contents).toContain('\n\n**模板 心情**');
      // range 归声明段（与今天宿主优先级一致）
      expect(result.range).toEqual({ line: 1, startColumn: 3, endColumn: 5 });
    } finally {
      unregister();
    }
  });

  it('仅 via === call-site 追加：展开体源行（via definition）不贴第二遍', () => {
    const compilation = fakeCompilation();
    const unregister = registerKojo2ExpandCompileSource((path) => (path === PATH ? compilation : null));
    try {
      const result = provideHover(hoverRequest(3, 5, HOVER_SOURCE))!;
      expect(result.contents).toContain('**心情**（表声明）');
      expect(result.contents).not.toContain('展开产物');
    } finally {
      unregister();
    }
  });

  it('只有展开段（随机块头这类无声明事实处）⇒ range 取调用处 span', () => {
    const compilation = fakeCompilation();
    const text = ['! 未在', '', '# 表 心情 由 好感', '    0..99 疏远', '    否 未知'].join('\n');
    const unregister = registerKojo2ExpandCompileSource((path) => (path === PATH ? compilation : null));
    try {
      const result = provideHover(hoverRequest(1, 3, text))!;
      expect(result.contents.startsWith('**模板 未在**')).toBe(true);
      expect(result.contents).not.toContain('（表声明）');
      expect(result.range).toEqual({ line: 1, startColumn: 3, endColumn: 5 });
    } finally {
      unregister();
    }
  });

  it('取不到编译成品 ⇒ 只有声明段（不二次编译、不猜）', () => {
    const result = provideHover(hoverRequest(1, 3, HOVER_SOURCE))!;
    expect(result.contents).toContain('**心情**（表声明）');
    expect(result.contents).not.toContain('展开产物');
    expect(result.format).toBe('markdown');
  });

  it('登记表形状不对 / 与本篇无关的编译成品 ⇒ 展开段缺席、声明段照旧', () => {
    const unregister = registerKojo2ExpandCompileSource(() => ({
      compiled: { erb: 'X' },
      sourceMapModel: {
        generatedInRange: () => {
          throw new Error('桩：读取端抛错');
        },
        lineAt: () => null,
      },
    }) as unknown as Kojo2ExpandCompilation);
    try {
      const result = provideHover(hoverRequest(1, 3, HOVER_SOURCE))!;
      expect(result.contents).toContain('**心情**（表声明）');
      expect(result.contents).not.toContain('展开产物');
    } finally {
      unregister();
    }
  });
});
