/**
 * `#DIM` 声明名悬停（2026-10-20 悬停信息批）：声明处 + 值/类型（可判时）+ **最近声明**，
 * 以及派生预览面（`.kojo` 糖面）上的**坐标不跨面换算**。
 *
 * 三条判据各自钉死：
 * ① **有可用信息**：`#DIM 好感度 = 100` 的悬停给「声明于 文件:行」+ 声明原文 + 初值；
 *    读不到原文（索引是陈旧快照 / 派生面拿不到原文 model）⇒ 只给落点，不编值。
 * ② **最近声明**：同文件多处同名声明 ⇒ 取**包围当前函数**里最近的那条（源面）；
 *    函数形参遮蔽同名变量 ⇒ 报形参，不报远处的 `#DIM`。派生面的行号不是源行号 ⇒
 *    不参与「最近」判定（退回索引首条 + 明写还有几处，**不假装知道哪条最近**）。
 * ③ **坐标不跨面**：hover 的 range 永远用**显示面**（预览行/列），声明落点永远用
 *    **源坐标**（索引里的文件 + 行）；声明原文从**原文 model**那一行读，绝不在预览 model
 *    的同一行号上读（那会读到另一个名字）。
 *
 * 数据源与现有悬停测试同形：纯表驱动 + 假 Monaco（`import type`，无运行时依赖）。
 * 预览面的归属（这份内存 model 背后是哪个文件）走与产品同一条登记簿反查——测试里直接把
 * 一条档案放进 `livePanes`，不 mock 宿主内部实现。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbDim, ErbFile, ErbFunction, ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';
import { type HoverSurface, type HoverTables, installHover, resolveHoverName } from '../src/monaco/kojo-hover';

const PATH = String.raw`c:\proj\erb\dim.erb`;

function fn(name: string, startLine: number, endLine: number, params: string[] = []): ErbFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    params: params.map((p) => ({ name: p, hasDefault: false })),
    startLine,
    endLine,
    filePath: PATH,
  };
}

function ref(f: ErbFunction): ErbFunctionRef {
  return { name: f.name, normalizedName: f.normalizedName, filePath: f.filePath, startLine: f.startLine, endLine: f.endLine };
}

/** 索引桩：`dims` 是声明事实（行号只有行，没有原文），`functions` 是作用域边界 */
function indexOf(
  dims: ErbDim[],
  functions: ErbFunction[] = [],
  moreFiles: [string, { path: string; dims: ErbDim[]; functions: ErbFunction[] }][] = [],
): ErbIndex {
  const main = { path: PATH, functions, dims, lineCount: 99, hasFunctionDirective: false } as ErbFile;
  const files = new Map<string, ErbFile>([[PATH, main]]);
  for (const [p, f] of moreFiles) {
    files.set(p, { ...f, lineCount: 99, hasFunctionDirective: false } as ErbFile);
  }
  const byName = new Map<string, ErbFunctionRef[]>(functions.map((f) => [f.normalizedName, [ref(f)]]));
  return { files, byName } as unknown as ErbIndex;
}

/** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1），返回解析结果 */
function at(marked: string, tables: HoverTables, surface?: HoverSurface) {
  return resolveHoverName(
    marked.replace('|', ''),
    marked.indexOf('|') + 1,
    tables,
    {},
    PATH,
    surface,
  );
}

/* ============================== ① 声明处 + 值/类型 ============================== */

describe('#DIM 悬停 · 声明处与值/类型（源面）', () => {
  const SOURCE = [
    '#DIM 好感度 = 100',
    '  好感度 = 好感度 + 1',
    '#DIMS 名前 = "小明"',
    '  名前 = "小红"',
    '#DIM 配列[10]',
    '  配列[0] = 1',
  ];
  const tables: HoverTables = {
    erbIndex: () =>
      indexOf([
        { name: '好感度', directive: 'DIM', line: 1 },
        { name: '名前', directive: 'DIMS', line: 3 },
        // scanner 原样存数组后缀（`#DIM 配列[10]` → `配列[10]`）：悬停必须按裸名匹配
        { name: '配列[10]', directive: 'DIM', line: 5 },
      ]),
  };
  const readLine = (n: number) => SOURCE[n - 1];

  it('整数声明：声明行 + 原文 + 初值，落点是源坐标', () => {
    const hit = at('好感|度 = 好感度 + 1', tables, { line: 2, readSourceLine: readLine });
    expect(hit?.name).toBe('好感度');
    expect(hit?.kind).toBe('#DIM 声明');
    expect(hit?.lines).toContain('声明于 `' + PATH + ':1`');
    expect(hit?.lines).toContain('声明：`#DIM 好感度 = 100`');
    expect(hit?.lines).toContain('初值：`100`');
    expect(hit?.source).toEqual({ filePath: PATH, line: 1 });
  });

  it('字符串声明：指令决定类型，初值连引号原样带出', () => {
    const hit = at('|名前 = "小红"', tables, { line: 4, readSourceLine: readLine });
    expect(hit?.kind).toBe('#DIMS 声明');
    expect(hit?.lines).toContain('声明：`#DIMS 名前 = "小明"`');
    expect(hit?.lines).toContain('初值：`"小明"`');
  });

  it('数组声明：索引名带后缀也按裸名命中；原文带规模，没有 `=` 就不编初值', () => {
    const hit = at('配|列[0] = 1', tables, { line: 6, readSourceLine: readLine });
    expect(hit?.name).toBe('配列');
    expect(hit?.lines).toContain('声明：`#DIM 配列[10]`');
    expect(hit?.lines?.some((l) => l.includes('初值'))).toBe(false);
  });

  it('读不到原文（旧调用 / 索引是陈旧快照）⇒ 只给落点，不编值', () => {
    const noReader = at('好感|度 = 1', tables, { line: 2 });
    expect(noReader?.lines).toEqual(['声明于 `' + PATH + ':1`']);

    const wrong = at('好感|度 = 1', tables, { line: 2, readSourceLine: () => '#DIM 别人 = 2' });
    expect(wrong?.lines).toEqual(['声明于 `' + PATH + ':1`']);
  });

  it('声明行上的名字同样命中（声明 / 使用一个入口）', () => {
    const hit = at('#DIM 好感|度 = 100', tables, { line: 1, readSourceLine: readLine });
    expect(hit?.name).toBe('好感度');
    expect(hit?.lines).toContain('声明：`#DIM 好感度 = 100`');
  });

  it('修饰形与行尾注释：初值取到引号外的 `;` 为止', () => {
    const src = ['#DIM CONST 好感度 = 100 ; 初始好感', '好感度 = 1'];
    const t: HoverTables = {
      erbIndex: () => indexOf([{ name: '好感度', directive: 'DIM', line: 1 }]),
    };
    const hit = at('好感|度 = 1', t, { line: 2, readSourceLine: (n) => src[n - 1] });
    expect(hit?.lines).toContain('声明：`#DIM CONST 好感度 = 100 ; 初始好感`');
    expect(hit?.lines).toContain('初值：`100`');
  });

  it('字符串初值里的分号不算注释（引号内原样保留）', () => {
    const src = ['#DIMS 名 = "a;b" ; 注释', '名 = "c"'];
    const t: HoverTables = {
      erbIndex: () => indexOf([{ name: '名', directive: 'DIMS', line: 1 }]),
    };
    const hit = at('|名 = "c"', t, { line: 2, readSourceLine: (n) => src[n - 1] });
    expect(hit?.lines).toContain('初值：`"a;b"`');
  });

  it('名字大小写不敏感：索引写大写、源行写小写，初值照读', () => {
    const src = ['#DIM HP = 3', 'hp = hp + 1'];
    const t: HoverTables = {
      erbIndex: () => indexOf([{ name: 'HP', directive: 'DIM', line: 1 }]),
    };
    const hit = at('h|p = hp + 1', t, { line: 2, readSourceLine: (n) => src[n - 1] });
    expect(hit?.name).toBe('HP');
    expect(hit?.lines).toContain('初值：`3`');
  });
});

/* ============================== ② 最近声明 / 形参遮蔽 ============================== */

describe('#DIM 悬停 · 重名取最近声明（源面）', () => {
  const SOURCE = [
    '@FIRST',
    '  #DIM 好感度 = 1',
    '  好感度 = 1',
    '  好感度 = 1',
    '  好感度 = 1',
    '@SECOND',
    '  #DIM 好感度 = 2',
    '  好感度 = 2',
  ];
  const functions = [fn('FIRST', 1, 5), fn('SECOND', 6, 8)];
  const tables: HoverTables = {
    erbIndex: () =>
      indexOf(
        [
          { name: '好感度', directive: 'DIM', line: 2 },
          { name: '好感度', directive: 'DIM', line: 7 },
        ],
        functions,
      ),
  };
  const readLine = (n: number) => SOURCE[n - 1];

  it('同名两处：当前函数里的那条胜出（不是全文件第一条）', () => {
    const hit = at('好感|度 = 2', tables, { line: 8, readSourceLine: readLine });
    expect(hit?.lines).toContain('声明于 `' + PATH + ':7`');
    expect(hit?.lines).toContain('初值：`2`');
    expect(hit?.lines).toContain('另有 1 处同名声明（第 2 行）');
    expect(hit?.source).toEqual({ filePath: PATH, line: 7 });
  });

  it('后一个函数的名字不会被拉过来「凑最近」：作用域内优先于绝对行距', () => {
    // 用点在第 5 行（FIRST 的最后一行）：第 2 行在 FIRST 内、第 7 行在 SECOND 内；
    // 绝对行距 2 更近的是第 7 行（行 5 → 7），但它在别的函数里，看不见
    const hit = at('好感|度 = 1', tables, { line: 5, readSourceLine: readLine });
    expect(hit?.lines).toContain('声明于 `' + PATH + ':2`');
    expect(hit?.lines).not.toContain('声明于 `' + PATH + ':7`');
  });

  it('没有函数边界（索引桩只给 dims）⇒ 退到行距最近，并明写另一处', () => {
    const noFn: HoverTables = {
      erbIndex: () =>
        indexOf([
          { name: '好感度', directive: 'DIM', line: 2 },
          { name: '好感度', directive: 'DIM', line: 5 },
        ]),
    };
    const hit = at('好感|度 = 2', noFn, { line: 6, readSourceLine: readLine });
    expect(hit?.lines).toContain('声明于 `' + PATH + ':5`');
  });

  it('函数形参遮蔽同名变量：报形参，不报远处的 #DIM', () => {
    const shadow = ['@SHOW(好感度 = 1)', '  好感度 = 好感度 + 1', '', '@OTHER', '  #DIM 好感度 = 9', '  好感度 = 9'];
    const t: HoverTables = {
      erbIndex: () =>
        indexOf(
          [{ name: '好感度', directive: 'DIM', line: 5 }],
          [fn('SHOW', 1, 2, ['好感度']), fn('OTHER', 4, 6)],
        ),
    };
    const hit = at('  好感|度 = 好感度 + 1', t, {
      line: 2,
      readSourceLine: (n) => shadow[n - 1],
    });
    expect(hit?.name).toBe('好感度');
    expect(hit?.kind).toBe('函数形参');
    expect(hit?.lines?.some((l) => l.includes('@SHOW'))).toBe(true);
    expect(hit?.lines?.some((l) => l.includes(`${PATH}:1`))).toBe(true);
    expect(hit?.kind).not.toContain('#DIM');
    expect(hit?.source).toEqual({ filePath: PATH, line: 1 });
  });

  it('形参只在它自己的函数里遮蔽：函数外仍报 #DIM 声明', () => {
    const t: HoverTables = {
      erbIndex: () =>
        indexOf(
          [{ name: '好感度', directive: 'DIM', line: 5 }],
          [fn('SHOW', 1, 2, ['好感度']), fn('OTHER', 4, 6)],
        ),
    };
    // 第 6 行在 OTHER 里（SHOW 的形参不越界）
    const hit = at('好感|度 = 9', t, { line: 6, readSourceLine: () => '' });
    expect(hit?.kind).toBe('#DIM 声明');
    expect(hit?.lines).toContain('声明于 `' + PATH + ':5`');
  });
});

/* ============================== ③ 派生预览面：坐标不跨面 ============================== */

interface FakeUri {
  scheme?: string;
  authority?: string;
  path?: string;
  fsPath?: string;
}

function fakeModel(lines: readonly string[], uri?: FakeUri): Monaco.editor.ITextModel {
  return {
    ...(uri !== undefined ? { uri } : {}),
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getLineCount: () => lines.length,
    getValue: () => lines.join('\n'),
  } as unknown as Monaco.editor.ITextModel;
}

/** 把一个「糖预览 model + 原文 model」的实例档案放进登记簿（与产品同一条反查） */
function registerSugarPane(sourcePath: string, source: Monaco.editor.ITextModel, sugar: Monaco.editor.ITextModel): void {
  livePanes.set('pane-hover-test', {
    paneId: 'pane-hover-test',
    editorRef: { current: null },
    entriesRef: {
      current: new Map([
        [sourcePath, { model: source, listener: { dispose: () => undefined }, encoding: 'utf8', eol: '\n' }],
      ]),
    },
    filePathRef: { current: sourcePath },
    sugarModelRef: { current: sugar },
    pendingActionsRef: { current: new Map() },
    actionSeqRef: { current: 0 },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx);
}

afterEach(() => {
  livePanes.clear();
});

const noopToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function providerOf(tables: HoverTables): Monaco.languages.HoverProvider {
  const regs: Monaco.languages.HoverProvider[] = [];
  const monaco = {
    languages: {
      registerHoverProvider: (_id: string, provider: Monaco.languages.HoverProvider) => {
        regs.push(provider);
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  installHover(monaco, () => tables);
  return regs[0]!;
}

describe('#DIM 悬停 · 派生预览面坐标不跨面', () => {
  /** 原文 10 行；预览 5 行——两者的行号没有任何一一对应关系 */
  const SOURCE = [
    '@MAIN',
    '  #DIM 好感度 = 100',
    '  #DIM 运气 = 7',
    '',
    '  好感度 = 好感度 + 1',
    '',
    '',
    '',
    '  IF 运气 >= 50',
    '  ENDIF',
  ];
  const PREVIEW = ['; .kojo 预览', '角色: 12', '#DIM 运气 = 7', '', 'IF 好感度 >= 50'];
  const tables: HoverTables = {
    erbIndex: () =>
      indexOf(
        [
          { name: '好感度', directive: 'DIM', line: 2 },
          { name: '运气', directive: 'DIM', line: 3 },
        ],
        [fn('MAIN', 1, 10)],
      ),
  };

  it('名字取自预览行、声明落点用源坐标：初值读原文那一行，不读预览同号行', () => {
    const source = fakeModel(SOURCE, { scheme: 'file', fsPath: 'C:/proj/erb/dim.erb', path: '/C:/proj/erb/dim.erb' });
    const sugar = fakeModel(PREVIEW, {
      scheme: 'inmemory',
      authority: 'sugar',
      path: '/pane-hover-test/' + encodeURIComponent(String.raw`c:\proj\erb\dim.erb`),
    });
    registerSugarPane(String.raw`c:\proj\erb\dim.erb`, source, sugar);
    const hover = providerOf(tables).provideHover(
      sugar,
      { lineNumber: 5, column: PREVIEW[4]!.indexOf('好感度') + 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    expect(text).toContain('好感度');
    expect(text).toContain('#DIM 声明');
    expect(text).toContain('dim.erb:2');
    expect(text).toContain('初值：`100`');
    // 预览第 3 行也有一句 `#DIM 运气 = 7`：若在预览 model 上按源行号读原文，就会读到这一句
    expect(text).not.toContain('初值：`7`');
    // range 用**预览坐标**（第 5 行、预览列），不是源行 2
    expect(hover?.range?.startLineNumber).toBe(5);
    expect(hover?.range?.endLineNumber).toBe(5);
    expect(hover?.range?.startColumn).toBe(PREVIEW[4]!.indexOf('好感度') + 1);
    expect(hover?.range?.endColumn).toBe(PREVIEW[4]!.indexOf('好感度') + 4);
  });

  it('行映射错位也不指到别的名字：取词只看屏幕上那一行', () => {
    // 故意摆一张会让「按源行重取词」读错的映射：预览 5 → 源 9，源 9 上写的是「运气」
    const lineMap = new Map([[5, 9]]);
    const source = fakeModel(SOURCE, { scheme: 'file', fsPath: String.raw`c:\proj\erb\dim.erb` });
    const sugar = fakeModel(PREVIEW, {
      scheme: 'inmemory',
      authority: 'sugar',
      path: '/pane-hover-test/' + encodeURIComponent(String.raw`c:\proj\erb\dim.erb`),
    });
    registerSugarPane(String.raw`c:\proj\erb\dim.erb`, source, sugar);
    expect(lineMap.get(5)).toBe(9);
    const hover = providerOf(tables).provideHover(
      sugar,
      { lineNumber: 5, column: PREVIEW[4]!.indexOf('好感度') + 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    expect(text).toContain('**好感度**');
    expect(text).not.toContain('**运气**');
  });

  it('重名时预览行号不参与「最近」判定：退回索引首条并明写其余，不假装知道最近', () => {
    const source = fakeModel(
      ['@MAIN', '  #DIM 好感度 = 1', '  好感度 = 1', '@SECOND', '  #DIM 好感度 = 2', '  好感度 = 2'],
      { scheme: 'file', fsPath: String.raw`c:\proj\erb\dim.erb` },
    );
    const sugar = fakeModel(['; 预览', '', '', '', '', 'IF 好感度 >= 50'], {
      scheme: 'inmemory',
      authority: 'sugar',
      path: '/pane-hover-test/' + encodeURIComponent(String.raw`c:\proj\erb\dim.erb`),
    });
    registerSugarPane(String.raw`c:\proj\erb\dim.erb`, source, sugar);
    const t: HoverTables = {
      erbIndex: () =>
        indexOf(
          [
            { name: '好感度', directive: 'DIM', line: 2 },
            { name: '好感度', directive: 'DIM', line: 5 },
          ],
          [fn('MAIN', 1, 3), fn('SECOND', 4, 6)],
        ),
    };
    const hover = providerOf(t).provideHover(
      sugar,
      { lineNumber: 6, column: 5 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    // 预览第 6 行恰等于源第 5 行；若拿它当源行号，就会选中第二次声明并自称「最近」
    expect(text).toContain('dim.erb:2');
    expect(text).not.toContain('dim.erb:5');
    expect(text).toContain('另有 1 处同名声明');
  });

  it('源面（`file:` model）：读行腿就是当前 model，range 与声明行各归各面', () => {
    const lines = ['@MAIN', '  #DIM 好感度 = 100', '  好感度 = 1'];
    const model = fakeModel(lines, { scheme: 'file', fsPath: PATH, path: '/C:/proj/erb/dim.erb' });
    const t: HoverTables = {
      erbIndex: () => indexOf([{ name: '好感度', directive: 'DIM', line: 2 }], [fn('MAIN', 1, 3)]),
    };
    const hover = providerOf(t).provideHover(
      model,
      { lineNumber: 3, column: lines[2]!.indexOf('好感度') + 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    expect(text).toContain('初值：`100`');
    expect(text).toContain('dim.erb:2');
    expect(hover?.range?.startLineNumber).toBe(3);
  });

  it('归属认不出（无登记簿、URI 也解不出）⇒ 声明路闭嘴，别的路照常', () => {
    const bare = fakeModel(['SIF GETBIT(A,0)'], { scheme: 'inmemory', path: '/model/1' });
    const hover = providerOf(tables).provideHover(
      bare,
      { lineNumber: 1, column: 5 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    // 系统函数表那条（与文件身份无关）照常出货
    expect(JSON.stringify(hover?.contents ?? [])).toContain('获取标记');
  });

  it('登记簿缺席但 URI 是糖预览形态：仍按源路径找声明（只是没有原文可读值）', () => {
    const sugar = fakeModel(PREVIEW, {
      scheme: 'inmemory',
      authority: 'sugar',
      path: '/pane-1/' + encodeURIComponent(String.raw`c:\proj\erb\dim.erb`),
    });
    const hover = providerOf(tables).provideHover(
      sugar,
      { lineNumber: 5, column: PREVIEW[4]!.indexOf('好感度') + 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    expect(text).toContain('dim.erb:2');
    expect(text).not.toContain('初值');
  });

  it('`.kojo` 糖面的函数名：预览面 range + 源文件定义行（两面各用各的坐标）', () => {
    const fnPath = 'C:/proj/erb/func.erb';
    const def: ErbFunction = {
      name: '好感度检查',
      normalizedName: '好感度检查',
      params: [],
      startLine: 7,
      endLine: 9,
      filePath: fnPath,
    };
    const t: HoverTables = {
      erbIndex: () =>
        ({
          files: new Map([[fnPath, { path: fnPath, functions: [def], dims: [], lineCount: 9, hasFunctionDirective: false }]]),
          byName: new Map([
            [
              '好感度检查',
              [{ name: def.name, normalizedName: def.normalizedName, filePath: fnPath, startLine: 7, endLine: 9 }],
            ],
          ]),
        }) as unknown as ErbIndex,
    };
    const sugar = fakeModel(['; 预览', '好感度检查(1)'], {
      scheme: 'inmemory',
      authority: 'sugar',
      path: '/pane-1/' + encodeURIComponent(fnPath),
    });
    const hover = providerOf(t).provideHover(
      sugar,
      { lineNumber: 2, column: 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    expect(text).toContain('ERB 函数');
    expect(text).toContain('func.erb:7');
    expect(hover?.range?.startLineNumber).toBe(2);
    expect(hover?.range?.startColumn).toBe(1);
    expect(hover?.range?.endColumn).toBe('好感度检查'.length + 1);
  });

  it('同名文件不同目录不串：按完整源路径认家，不按文件名猜', () => {
    const other = String.raw`c:\other\dim.erb`;
    const t: HoverTables = {
      erbIndex: () =>
        indexOf(
          [{ name: '好感度', directive: 'DIM', line: 2 }],
          [fn('MAIN', 1, 10)],
          [[other, { path: other, dims: [{ name: '好感度', directive: 'DIM', line: 99 }], functions: [] }]],
        ),
    };
    const sugar = fakeModel(PREVIEW, {
      scheme: 'inmemory',
      authority: 'sugar',
      path: '/pane-1/' + encodeURIComponent(String.raw`c:\proj\erb\dim.erb`),
    });
    const hover = providerOf(t).provideHover(
      sugar,
      { lineNumber: 5, column: PREVIEW[4]!.indexOf('好感度') + 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const text = JSON.stringify(hover?.contents ?? []);
    expect(text).toContain('dim.erb:2');
    expect(text).not.toContain(':99');
    expect(text).not.toContain('other');
  });
});
