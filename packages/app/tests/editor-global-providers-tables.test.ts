/**
 * 宿主接线层（`ui/editor-global-providers.ts`）的三处缺陷回归（1017 补全体感批）。
 *
 * ① **没开项目也要有静态表**：`editorTables` 此前一遇无项目就整体返回 `{}`，
 *    于是连 adapter **构造时**就给出的静态零 IO 表（时机分野模板 / 基础库函数名 / 计数器）也没了，
 *    带 `requires` 的候选源被 `missingRequirement` 逐个跳过 ⇒ `.kojo` / `.erb` 的静态那几路静默。
 *    现在：静态面照旧给出，但**依赖 `loadProject` 的三张表**（`variableSchema` /
 *    `instructionTable` / `callProtocol`）一张都不给——给了就是"假装可用"。
 * ② **注册半途抛错 = 全有或全无**：旧写法把 flag 前置、disposable 留到收尾一次性并入，
 *    某枚注册抛错 ⇒ 补全 / 悬停 / 改名整批 provider 永不注册，且后续每次挂载都被 flag 挡住
 *    不再重试（永久静默）。
 * ③ **拆毁逐枚 try/catch**：一枚 `dispose()` 抛错不许带走其余，清空登记表与复位 flag 必须
 *    无条件执行（否则表里留着半套旧注册、flag 还置着，下次挂载直接 return）。
 *
 * monaco 运行时不进 node（本池 environment = node），故 `../src/monaco/entry` 用 `vi.mock`
 * 桩掉：桩把每一次 `monaco.<ns>.<method>(...)` 记成一枚可拆的假 disposable，并允许按**调用点
 * 路径**注入「这次注册抛错」/ 按记录注入「这枚 dispose 抛错」两种故障。形状照仓内既有做法
 * （`search-replace-exec.test.ts` 的 `vi.hoisted` + 动态 import 保证桩先就位）。
 * 故障点一律选**接线层自己按下**的那几枚（`registerCommand` / `registerCodeActionProvider` /
 * `registerDocumentSymbolProvider`）：叶子 `monaco/*.ts` 的 install 内部还可能各建中间注册，
 * 那一层的账不归本接线层，也不在本批文件权限内。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type { ErbFile, ErbIndex, GameAdapter, GameProject } from '@kojo/plugin-api';

const stub = vi.hoisted(() => {
  /** 一次注册建立的记录：`disposed` = dispose 被叫过且没抛错 */
  interface Rec {
    readonly path: string;
    disposed: boolean;
    failOnDispose: boolean;
  }
  const state = {
    /** 录制窗口：只有 `recording` 为真时的调用才计入（挡掉 import 期与其它用例的意外调用） */
    recording: false,
    created: [] as Rec[],
    /** 命中该路径的注册调用抛错（null = 不注入故障） */
    failRegisterOn: null as string | null,
    /** 让第 N 枚（0 基，按建立顺序）disposable 在 dispose 时抛错；故障钉在记录上，不受数组重置影响 */
    failDispose(index: number): void {
      const rec = state.created[index];
      if (rec) rec.failOnDispose = true;
    },
    reset(): void {
      state.recording = true;
      state.created.length = 0;
      state.failRegisterOn = null;
    },
    paths(): string[] {
      return state.created.map((r) => r.path);
    },
  };

  /**
   * 查询型调用表（`path → 该方法的真返回值形状`）。
   *
   * 真 monaco 的这几个方法只读当前实例集合、不返回 disposable；桩必须照形状回值且**不记账**，
   * 否则「回滚必须全拆」「dispose 后一物不剩」这类断会假红（多出一枚没人拆的账）。
   */
  const QUERY_RESULTS = new Map<string, () => unknown>([
    ['monaco.editor.getEditors', () => []],
    ['monaco.editor.getModels', () => []],
    // B4：组合根现在会问"哪些语言已认领"（`applyAllMonacoLanguageSurfaces` 只给认领过的
    // 语言落语言面）。空表 = 这台替身上下还没注册过任何语言，与"没有 model"同一档冷启动读数。
    ['monaco.languages.getLanguages', () => []],
  ]);
  const invoke = (path: string): unknown => {
    // **查询不算注册**：`monaco.editor.getEditors()` / `getModels()` 只读现有实例，建出来的
    // 东西没人有义务拆（叶子 provider 是 `for…of` 遍历它，不是收下当 disposable）。记账会让
    // 「回滚必须全拆」那条断言假红——A5 的 `erb-preproc-dim` 是第一个在 install 期查
    // `getEditors` 的 provider，2.0 语言面"无条件装配"则在 install 期查 `getModels` 补色。
    // 返回空数组即"当前没有已存在的编辑器 / 模型"，与真机冷启动一致。
    // 新的查询型调用（命名 `get*` / `is*` / `has*`）请加进这张表，别让它进账本。
    const queried = QUERY_RESULTS.get(path);
    if (queried !== undefined) return queried();
    if (!state.recording) {
      // 录制窗口之外：给一枚拆不动任何账的假 disposable
      return { dispose: () => undefined };
    }
    // 只记**注册**调用：读面调用（`editor.getModels()` 这类装机时顺手取一次状态的）返回的
    // 不是注册，接线层也不该把它塞进 `globalDisposers`——记进来会让"每枚都被拆"的断言
    // 把一次读取当成漏拆（2026-10-26 语言面批：2.0 安装器搬出开关块后，装配段会在装机时
    // 读一次 `getModels()`）。
    const method = path.slice(path.lastIndexOf('.') + 1);
    if (!method.startsWith('register')) return { dispose: () => undefined };
    if (path === state.failRegisterOn) throw new Error(`桩：注册 '${path}' 抛错`);
    const rec: Rec = { path, disposed: false, failOnDispose: false };
    state.created.push(rec);
    return {
      dispose: () => {
        if (rec.failOnDispose) throw new Error(`桩：dispose '${path}' 抛错`);
        rec.disposed = true;
      },
    };
  };
  /** 万能桩：任意属性链都是「可调用 / 可 new」的代理，调用即记账（取枚举值之类同样不炸） */
  const universal = (path: string): unknown =>
    new Proxy(function kojoMonacoStub() {}, {
      get: (_target, key) =>
        typeof key === 'symbol' || key === 'then' ? undefined : universal(`${path}.${String(key)}`),
      apply: (_target, _thisArg, _args) => invoke(path),
      construct: () => ({ stubConstructed: path }),
    });
  return { state, universal };
});

vi.mock('../src/monaco/entry', () => ({
  editor: stub.universal('monaco.editor'),
  languages: stub.universal('monaco.languages'),
  Uri: stub.universal('monaco.Uri'),
  Range: stub.universal('monaco.Range'),
  // 真实 monaco 的枚举面（宿主只用这几个桶）：给实值，免得桩对象参与数值比较时变成 NaN
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
}));

// 动态 import：保证上面的桩先就位（本模块 import 期就会碰 monaco 运行时）
const { editorTables, ensureGlobalProviders, disposeGlobalProviders } = await import(
  '../src/ui/editor-global-providers'
);

/** 一张表的桩：宿主只搬引用、不解释内容，带个身份标记的空对象就够 */
const table = (name: string): { __table: string } => ({ __table: name });

const identity = (value: object): string => (value as { __table?: string }).__table ?? '';

function fakeKernel(
  contributions: readonly { id: string; adapter: GameAdapter }[],
  project: GameProject | null,
  parser?: { currentIndex(): ErbIndex | null },
) {
  return {
    project: { current: () => project },
    slots: { query: () => contributions },
    services: { tryGet: (key: string) => (key === 'erb.parser' ? parser : undefined) },
  } as unknown as Kernel;
}

/** 一枚「静态面 + loadProject 面」都填齐的 adapter：用来证明无项目时只漏出静态面那三张 */
function fullAdapter(gameId: string): GameAdapter {
  return {
    gameId,
    displayName: gameId,
    variableSchema: table(`${gameId}-variableSchema`),
    kojoFaceTemplates: table(`${gameId}-face`),
    kojoLibraryTable: table(`${gameId}-library`),
    kojoCounterTable: table(`${gameId}-counter`),
    kojoInstructionTable: table(`${gameId}-instruction`),
    kojoCallProtocol: table(`${gameId}-protocol`),
  } as unknown as GameAdapter;
}

afterEach(() => {
  // 模块级 flag 与登记表是跨用例的真状态：关掉录制后拆干净再进下一个用例（幂等）
  stub.state.recording = false;
  disposeGlobalProviders();
  vi.restoreAllMocks();
});

describe('editorTables · 无项目时的静态面（缺陷 1）', () => {
  it('项目未打开：静态三张表照旧给出，依赖 loadProject 的键一个都不给', () => {
    const kernel = fakeKernel([{ id: 'adapter-a', adapter: fullAdapter('game-a') }], null);
    const tables = editorTables(kernel);
    // 静态、零 IO：与项目开闭无关 ⇒ 必须照旧可用（否则静态那几路候选源静默）
    expect(tables.faceTable).toBeDefined();
    expect(tables.libraryTable).toBeDefined();
    expect(tables.counterTable).toBeDefined();
    // loadProject 才填得上的三张：此刻确实不存在 ⇒ 不给（不给"假装可用"）
    expect(tables).not.toHaveProperty('variableSchema');
    expect(tables).not.toHaveProperty('instructionTable');
    expect(tables).not.toHaveProperty('callProtocol');
    expect(tables).not.toHaveProperty('dictionary');
  });

  it('槽位里没有任何 adapter 贡献：三张 loadProject 表同样缺席，也不抛', () => {
    const tables = editorTables(fakeKernel([], null));
    expect(tables).not.toHaveProperty('variableSchema');
    expect(tables).not.toHaveProperty('instructionTable');
    expect(tables).not.toHaveProperty('callProtocol');
    expect(tables.faceTable).toBeUndefined();
  });

  it('多枚 adapter：无项目时按注册序取第一枚带静态表的贡献，不做跨 adapter 合并', () => {
    const emptyFirst = { gameId: 'game-empty', displayName: '空' } as unknown as GameAdapter;
    const kernel = fakeKernel(
      [
        { id: 'a0', adapter: emptyFirst },
        { id: 'a1', adapter: fullAdapter('game-b') },
        { id: 'a2', adapter: fullAdapter('game-c') },
      ],
      null,
    );
    const tables = editorTables(kernel);
    expect(identity(tables.faceTable as object)).toBe('game-b-face');
    expect(identity(tables.libraryTable as object)).toBe('game-b-library');
    expect(identity(tables.counterTable as object)).toBe('game-b-counter');
  });

  it('有项目但 adapterId 在槽位里找不到贡献：与无项目同口径（只给静态面）', () => {
    const kernel = fakeKernel(
      [{ id: 'a1', adapter: fullAdapter('game-b') }],
      { adapterId: 'game-not-registered' } as unknown as GameProject,
    );
    const tables = editorTables(kernel);
    expect(tables.faceTable).toBeDefined();
    expect(tables).not.toHaveProperty('variableSchema');
    expect(tables).not.toHaveProperty('callProtocol');
  });

  it('有项目且 adapterId 命中：loadProject 面照常给出（这次改动没削掉既有能力）', () => {
    const kernel = fakeKernel(
      [{ id: 'a1', adapter: fullAdapter('game-b') }],
      { adapterId: 'game-b' } as unknown as GameProject,
    );
    const tables = editorTables(kernel);
    expect(tables.variableSchema).toBeDefined();
    expect(tables.instructionTable).toBeDefined();
    expect(tables.callProtocol).toBeDefined();
    expect(tables.faceTable).toBeDefined();
    // `variableSchema` 在场 ⇒ 字典腿同批给出（与转译器同一个 makeLookup 构造器）
    expect(tables.dictionary).toBeDefined();
  });
});

describe('ensureGlobalProviders · 全有或全无（缺陷 2）', () => {
  it('靠前的注册抛错：错误外抛、已建立的那枚也被拆掉、flag 复位让下次挂载重试', () => {
    stub.state.reset();
    stub.state.failRegisterOn = 'monaco.languages.registerCodeActionProvider';
    expect(() => ensureGlobalProviders()).toThrow(/桩：注册/);
    // 抛错之前只建成了命令那一枚 ⇒ 回滚必须把它拆掉（不留未登记的注册）
    expect(stub.state.paths()).toEqual(['monaco.editor.registerCommand']);
    expect(stub.state.created.every((r) => r.disposed)).toBe(true);

    // flag 已复位 ⇒ 再挂一次会重走整条注册序列（旧写法在这里永久沉默，补全从此不再回来）
    stub.state.reset();
    expect(() => ensureGlobalProviders()).not.toThrow();
    expect(stub.state.created.length).toBeGreaterThan(1);
    // 成功路径一枚都不许拆
    expect(stub.state.created.every((r) => !r.disposed)).toBe(true);
  });

  it('较深处的注册抛错：此前每一枚（含叶子 install 返回的组合 disposable）都被拆过', () => {
    stub.state.reset();
    stub.state.failRegisterOn = 'monaco.languages.registerDocumentSymbolProvider';
    expect(() => ensureGlobalProviders()).toThrow(/桩：注册/);
    expect(stub.state.created.length).toBeGreaterThanOrEqual(4);
    expect(stub.state.created.filter((r) => r.disposed)).toHaveLength(stub.state.created.length);
  });

  it('注册成功后重复调用不再注册第二次（单次注册那道门仍在）', () => {
    stub.state.reset();
    ensureGlobalProviders();
    const total = stub.state.created.length;
    expect(total).toBeGreaterThan(5);
    stub.state.reset();
    ensureGlobalProviders();
    expect(stub.state.created).toHaveLength(0);
  });
});

describe('disposeGlobalProviders · 逐枚 try/catch（缺陷 3）', () => {
  it('一枚 dispose 抛错：其余照旧拆完、登记表清空、flag 复位（下次挂载重新注册）', () => {
    stub.state.reset();
    ensureGlobalProviders();
    const total = stub.state.created.length;
    expect(total).toBeGreaterThan(5);

    stub.state.failDispose(0); // 第一枚抛错
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => disposeGlobalProviders()).not.toThrow();
    expect(stub.state.created.filter((r) => r.disposed)).toHaveLength(total - 1);
    // 抛错那一枚进日志（不静默），且带宿主既有的日志 tag 风格
    expect(
      warn.mock.calls.some((args) => String(args[0]).startsWith('[editor-providers]')),
    ).toBe(true);

    // flag 复位 ⇒ 下一次挂载重建整套注册（旧写法会留下"半套注册 + flag 已置"）
    stub.state.reset();
    ensureGlobalProviders();
    expect(stub.state.created).toHaveLength(total);
  });
});

/* ------------------------------ erbFileFacts（解析事实通道的宿主注入侧） ------------------------------ */

/**
 * 一枚桩 ERB 索引：单个文件，两个函数各挂各的标签；dims 含一条**重名不同指令**的声明
 * （钉去重）。文件的键形态（`C:\Game\SKILL.ERB`）与查询路径故意不同大小写 / 分隔符——
 * 归一责任在宿主（`pathKey`），装配核零路径知识。
 */
function stubErbIndex(): ErbIndex {
  const filePath = 'C:\\Game\\SKILL.ERB';
  const file: ErbFile = {
    path: filePath,
    functions: [
      { name: 'M_FUNC_A', normalizedName: 'M_FUNC_A', params: [], startLine: 10, endLine: 30, filePath },
      { name: 'M_FUNC_B', normalizedName: 'M_FUNC_B', params: [], startLine: 40, endLine: 60, filePath },
    ],
    dims: [
      { name: 'FLAG_A', directive: 'DIM', line: 3 },
      { name: 'FLAG_A', directive: 'DIMS', line: 4 },
      { name: 'FLAG_B', directive: 'DIM', line: 5 },
    ],
    labels: [
      { name: 'LABEL_A1', line: 12, functionStartLine: 10 },
      { name: 'LABEL_A2', line: 14, functionStartLine: 10 },
      { name: 'LABEL_B1', line: 42, functionStartLine: 40 },
    ],
    hasFunctionDirective: false,
    lineCount: 100,
  };
  return { files: new Map([[filePath, file]]), byName: new Map() };
}

/** 查询路径：与索引键的大小写 / 分隔符都不同，只有 `pathKey` 归一才能命中 */
const FACTS_PATH = 'c:/game/skill.erb';

/** 经 `editorTables` 取出 `erbFileFacts`（无项目也必须在场：它挂在 projectSoftLegs 上） */
function factsOf(index: ErbIndex | null) {
  const facts = editorTables(fakeKernel([], null, { currentIndex: () => index })).erbFileFacts;
  expect(facts).toBeDefined();
  return facts!;
}

describe('editorTables · erbFileFacts（解析事实通道，宿主注入侧）', () => {
  it('dimsOf：路径经 pathKey 归一命中（大小写 / 分隔符不同），重名声明去重', () => {
    expect(factsOf(stubErbIndex()).dimsOf(FACTS_PATH)).toEqual(['FLAG_A', 'FLAG_B']);
  });

  it('dimsOf：未知路径 ⇒ undefined；无索引 ⇒ undefined；取索引抛错也 undefined（绝不抛进 seam）', () => {
    expect(factsOf(stubErbIndex()).dimsOf('C:\\Game\\OTHER.ERB')).toBeUndefined();
    expect(factsOf(null).dimsOf(FACTS_PATH)).toBeUndefined();
    const throwing = fakeKernel([], null, {
      currentIndex: () => {
        throw new Error('索引在途');
      },
    });
    expect(editorTables(throwing).erbFileFacts?.dimsOf(FACTS_PATH)).toBeUndefined();
    // tryGet 本身抛错（槽位表崩）：同一条兜底
    const throwingGet = {
      project: { current: () => null },
      slots: { query: () => [] },
      services: {
        tryGet: () => {
          throw new Error('槽位表崩');
        },
      },
    } as unknown as Kernel;
    expect(editorTables(throwingGet).erbFileFacts?.dimsOf(FACTS_PATH)).toBeUndefined();
  });

  it('labelsAt：光标行落在函数 A ⇒ 只出 A 的标签（B 的不混）；首末边界含', () => {
    const facts = factsOf(stubErbIndex());
    expect(facts.labelsAt(FACTS_PATH, 10)).toEqual(['LABEL_A1', 'LABEL_A2']); // 函数 A 首行
    expect(facts.labelsAt(FACTS_PATH, 30)).toEqual(['LABEL_A1', 'LABEL_A2']); // 函数 A 末行（含）
    expect(facts.labelsAt(FACTS_PATH, 45)).toEqual(['LABEL_B1']); // 函数 B 体内
  });

  it('labelsAt：行在函数外 ⇒ []（已索引但确无该项，诚实空不回退）', () => {
    const facts = factsOf(stubErbIndex());
    expect(facts.labelsAt(FACTS_PATH, 5)).toEqual([]); // 第一个 @ 之前
    expect(facts.labelsAt(FACTS_PATH, 35)).toEqual([]); // 两函数之间
    expect(facts.labelsAt(FACTS_PATH, 200)).toEqual([]); // 文件尾之外
  });

  it('labelsAt：未知路径 / 无索引 ⇒ undefined（未索引，调用方自行回退）', () => {
    expect(factsOf(stubErbIndex()).labelsAt('C:\\Game\\OTHER.ERB', 12)).toBeUndefined();
    expect(factsOf(null).labelsAt(FACTS_PATH, 12)).toBeUndefined();
  });
});
