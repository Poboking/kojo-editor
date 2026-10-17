/**
 * W6 PARITY-EXT 对拍单测（2026-10-17）——`.kojo` 的三员语言服务（`workspaceSymbol` /
 * `codeLens` / `inlayHint`）与 ERB 那条线**同一份判据、同一份结果形状**。
 *
 * ## 为什么必须"两枚真贡献放同一间屋子里对拍"
 *
 * 本批的验收口径不是"糖线也返回了点东西"，而是**判据同源**：
 * 「被谁调用」的口径（无引用不说 / 重名不计数 / 大数报 `1000+`）、实参落槽的口径、
 * 工作区符号的匹配与排序预算，全部只有 `erb-parser` 那一份实现。所以这里
 * **同时装配真 `erb-parser` 插件与真 `kojo-sugar` 插件**（假 io / 假计算池 / 假槽位注册表），
 * 让糖线经 `ui.editor.languageService` 槽去问解析线，再逐条比对两侧的产出：
 * - 形状：`Object.keys()` 逐键相等（不新造第四种结果形状）；
 * - 内容：标签逐字相同、目标位置相同，**只有坐标**从产物折回源（折回口径由
 *   `foldGeneratedLine` 与转译源映射当场复核）。
 * 拿"自己写的假索引 + 假应答"对拍是钉不住这件事的——那两份口径可以各自漂移还全绿。
 *
 * ## 语料（全假表，不碰真盘）
 *
 * 一份 `.kojo`（`A.kojo`）+ 它的编译产物（`A.ERB`，内容由**同一个转译器当场算出**，
 * 杜绝"假产物与真转译不一致"这种自证空洞）+ 一份调用它的方言文件（`CALLER.ERB`）。
 */

import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  DirEntry,
  EditorCodeLens,
  EditorCodeLensResult,
  EditorInlayHint,
  EditorInlayHintResult,
  EditorLanguageServiceContribution,
  EditorWorkspaceSymbol,
  EditorWorkspaceSymbolRequest,
  EditorWorkspaceSymbolResult,
  ErbParserService,
  FileIO,
  GameProject,
  PluginContext,
  SugarTranspileResult,
  Unsubscribe,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createSugarTranspileService } from '../src/service';
import { createKojoSugarPlugin } from '../src/index';
import { foldGeneratedLine } from '../src/langsvc';
import { stubDict } from './support';

/* ============================ 假盘（内容全部当场算出） ============================ */

/** `.kojo` 源：一个用户函数（定义）+ 一个时机块里的**原生直通** CALL（列级映射可得 ⇒ 提示钉得住） */
const KOJO_SOURCE =
  '角色: 12\n' +
  '函数 问候(次数)：\n    「你好。」\n    返回\n' +
  '时机 初见：\n    CALL M_KOJO_K12_问候(3)\n';

const SOURCE_PATH = '/t/KOJO/A.kojo';
/** 产物路径由 `resolveSugarTarget` 的口径写死（同目录换扩展名） */
const PRODUCT_PATH = '/t/KOJO/A.ERB';
const CALLER_PATH = '/t/CALLER.ERB';

/** 与插件装配**同一张**分野表（真 eraTW 表）当场转译，产物逐字进假盘 */
const standalone = createSugarTranspileService({ dictionary: stubDict, faceTable: createEratwFaceTable() });
const PRODUCT: SugarTranspileResult = standalone.transpile(KOJO_SOURCE, { filePath: SOURCE_PATH });
const CALLER = '@CALLER\n\tCALL M_KOJO_K12_问候(1)\n';

const FILES: Record<string, string> = {
  [SOURCE_PATH]: KOJO_SOURCE,
  [PRODUCT_PATH]: PRODUCT.erb,
  [CALLER_PATH]: CALLER,
};

const PROJECT = {
  rootDir: '/t',
  adapterId: 'eratw',
  // 索引根与名录根**同一份**（装配层就是照 `project.kojoPaths` 取的）：`A.kojo` 不是方言文件，
  // 解析线按守门跳过它，只收产物 `A.ERB` 与调用方 `CALLER.ERB`。
  kojoPaths: ['/t'],
  writablePaths: ['/t/KOJO'],
} as unknown as GameProject;

/** 假 io：列目录（带 size/mtime，供名录的复用判据）+ 批量读 */
function fakeIO(): FileIO {
  const entries = (root: string): DirEntry[] =>
    Object.entries(FILES)
      .filter(([path]) => path.startsWith(root))
      .map(([path, text]) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        isDirectory: false,
        size: text.length,
        mtimeMs: 1_000,
      }));
  const read = (path: string) => {
    const text = FILES[path];
    return text === undefined ? null : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1_000 };
  };
  return {
    async walkDir(root: string) {
      return entries(root);
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((p) => read(p));
    },
    async readText(path: string) {
      const file = read(path);
      if (!file) throw new Error(`not found: ${path}`);
      return file;
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: 1_000, isDirectory: false };
    },
  } as unknown as FileIO;
}

/** 假计算池：与 erb-parser 测试替身同语义（保序、串行即可；offload 走本地实现） */
function fakeCompute(): ComputePool {
  const tasks = new Map<string, (payload: never) => unknown>();
  const offload = async (kind: string, payload: unknown): Promise<unknown> => {
    const impl = tasks.get(kind);
    if (!impl) throw new Error(`no local impl: ${kind}`);
    return await impl(payload as never);
  };
  return {
    async yieldToMain(): Promise<void> {},
    async runSliced<T, R>(
      items: readonly T[],
      _opts: unknown,
      fn: (item: T, index: number) => R | Promise<R>,
    ): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
    runLatest: (_key: string, _opts: unknown, fn: () => unknown) => Promise.resolve(fn()),
    busyInteractive: () => false,
    registerTask: (kind: string, impl: (payload: never) => unknown) => {
      tasks.set(kind, impl);
    },
    parallel: () => false,
    attachTransport: () => undefined,
    offload: offload as ComputePool['offload'],
    stats: () => ({ tasks: [], yields: 0, interactiveActive: false, offload: { parallel: false, dispatched: 0, fellBack: 0, inline: 0 } }),
    resetStats: () => undefined,
  } as unknown as ComputePool;
}

/* ============================ 装配两枚真插件 ============================ */

/**
 * `game.adapter` 的最小 eraTW 贡献（本文件专用，不进 `support.ts`——那是别人也在改的共享夹具）。
 *
 * 为什么必须有它：`kojo-sugar` 的转译代际判据要 `game.adapter` 槽里真有一枚
 * `adapterId` 对得上的贡献才拿得到分野表；分野表缺席 ⇒ 用户函数的产物名"无法生成"
 * ⇒ 名录一条不产，本批要钉的东西就根本没在跑。只给必填四项 + 分野表，其余留空。
 */
function stubEratwAdapterContribution(): { id: string; adapter: unknown } {
  return {
    id: 'eratw',
    adapter: {
      gameId: 'eratw',
      displayName: 'eraTW（测试替身）',
      detect: async () => true,
      loadProject: async () => {
        throw new Error('测试替身不加载项目');
      },
      kojoFaceTemplates: createEratwFaceTable(),
    },
  };
}

interface Harness {
  /** 按 id 取槽上的语言服务应答（跨两个插件，注册序即槽序） */
  contribution(id: string): EditorLanguageServiceContribution;
  ids(): string[];
  erbService: ErbParserService;
  emit(topic: string, payload: unknown): Promise<void>;
  /** 装配层与名录的 warn 全文（失败必须可见 ⇒ 断言用得上） */
  warnings: string[];
}

/** 让事件循环走一跳（假 io 与名录都是 promise 链，真计时器兜住宏任务那一档） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 装两枚真插件（解析线 + 糖线）到同一间假盘屋子里。
 *
 * `openProject: false` ⇒ 只激活、不发 `project.opened`：名录一条不建、
 * 用来钉"名录未就绪 ⇒ 本包不答（不谎称没有）"那条三态纪律。
 */
async function boot(opts: { openProject?: boolean } = {}): Promise<Harness> {
  const registry: Array<{ kind: string; contribution: EditorLanguageServiceContribution }> = [];
  const services = new Map<string, unknown>();
  const handlers = new Map<string, Array<(payload: never) => void>>();
  const warnings: string[] = [];
  const noop = (): void => undefined;
  const io = fakeIO();

  const slotApi = {
    register: (kind: string, contribution: EditorLanguageServiceContribution) => {
      registry.push({ kind, contribution });
      return noop;
    },
    query: (kind: string) => registry.filter((entry) => entry.kind === kind).map((entry) => entry.contribution),
  };
  const bus = {
    on: (topic: string, handler: (payload: never) => void): Unsubscribe => {
      const list = handlers.get(topic) ?? [];
      list.push(handler);
      handlers.set(topic, list);
      return noop;
    },
    once: (topic: string, handler: (payload: never) => void): Unsubscribe => bus.on(topic, handler),
    emit: noop,
  };
  const projectService = { current: () => PROJECT };

  const makeContext = (pluginId: string, extraInject: (key: string) => unknown | undefined): PluginContext =>
    ({
      pluginId,
      log: {
        debug: noop,
        info: noop,
        warn: (message: string) => {
          warnings.push(message);
        },
        error: (message: string) => {
          warnings.push(message);
        },
      },
      bus,
      inject: <T,>(key: string): T => {
        const hit = extraInject(key);
        if (hit !== undefined) return hit as T;
        throw new Error(`unexpected inject: ${key}`);
      },
      provide: (key: string, value: unknown) => {
        services.set(key, value);
      },
      storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
      slots: slotApi,
      onDispose: noop,
    }) as unknown as PluginContext;

  const harness: Harness = {
    contribution: (id) => {
      const hit = registry.find((entry) => entry.contribution.id === id);
      if (!hit) throw new Error(`${id} 未注册`);
      return hit.contribution;
    },
    ids: () => registry.filter((entry) => entry.kind === 'ui.editor.languageService').map((entry) => entry.contribution.id),
    erbService: undefined as unknown as ErbParserService,
    emit: async (topic, payload) => {
      for (const handler of handlers.get(topic) ?? []) await handler(payload as never);
      await tick();
      await tick();
    },
    warnings,
  };

  // ① 解析器先激活（它提供 `erb.parser` 服务与八类应答）
  createErbParserPlugin().activate(
    makeContext('erb-parser', (key) => (key === KernelServices.IO ? io : key === KernelServices.Compute ? fakeCompute() : undefined)),
  );
  const erbService = services.get(WellKnownServices.ErbParser) as ErbParserService;
  harness.erbService = erbService;

  // ② 糖插件后激活：软取 `erb.parser`；`game.adapter` 只给一枚最小 eraTW 贡献（分野表）
  createKojoSugarPlugin().activate(
    makeContext('kojo-sugar', (key) => {
      if (key === KernelServices.Project) return projectService;
      if (key === KernelServices.Slots) return slotApi;
      if (key === KernelServices.IO) return io;
      if (key === WellKnownServices.ErbParser) return erbService;
      return undefined; // 其余（replay / 条件抽取）走软取：抛错由装配层吞掉
    }),
  );
  // 分野表经 `game.adapter` 槽注入（装配层每次转译现查，注册晚于激活照样生效）
  slotApi.register('game.adapter', stubEratwAdapterContribution() as unknown as EditorLanguageServiceContribution);

  // ③ 项目打开 ⇒ 解析线建索引、糖线建 `.kojo` 名录（两边都只在事件里读盘）
  if (opts.openProject !== false) {
    await harness.emit('project.opened', { project: PROJECT });
    await settle(harness);
  }
  return harness;
}

/** 等到两枚真插件的后端都就绪（索引 + 名录），最多 100 跳 */
async function settle(h: Harness): Promise<void> {
  const kojo = h.contribution('kojo-workspace-symbols');
  for (let i = 0; i < 100; i++) {
    await tick();
    const indexed = h.erbService.currentIndex() !== null;
    const answered = kojo.provide({ kind: 'workspaceSymbol', query: '问候', project: PROJECT }) !== undefined;
    if (indexed && answered) return;
  }
  throw new Error(`索引或名录未就绪（warn 全文：${h.warnings.join(' | ')}）`);
}

/* ============================ ① workspaceSymbol 形状对拍 ============================ */

describe('W6 · workspaceSymbol：`.kojo` 与 `.erb` 结果形状逐键一致', () => {
  it('同一查询词下：糖线那条候选的键集合与 ERB 那条**完全相同**，且落点是 `.kojo` 源行', async () => {
    const h = await boot();
    const erb = h.contribution('erb-workspace-symbols');
    const kojo = h.contribution('kojo-workspace-symbols');
    const request: EditorWorkspaceSymbolRequest = { kind: 'workspaceSymbol', query: '问候', project: PROJECT, limit: 50 };

    const erbResult = erb.provide(request) as EditorWorkspaceSymbolResult;
    const kojoResult = kojo.provide(request) as EditorWorkspaceSymbolResult;
    expect(erbResult.kind).toBe('workspaceSymbol');
    expect(kojoResult.kind).toBe('workspaceSymbol');

    const erbHit = erbResult.symbols.find((s) => s.filePath === PRODUCT_PATH);
    const kojoHit = kojoResult.symbols.find((s) => s.filePath === SOURCE_PATH);
    expect(erbHit, 'ERB 那条线本该给出产物里的定义').toBeDefined();
    expect(kojoHit, '糖线该把同一条候选重定基到 `.kojo` 源').toBeDefined();

    // 形状：不新造第四种结果形状（键集合逐字相同，值域也只有 kind/name/filePath/line）
    expect(Object.keys(kojoHit!).sort()).toEqual(Object.keys(erbHit!).sort());
    // 内容：同一个函数的同一个名字，只有坐标不同
    expect(kojoHit!.name).toBe(erbHit!.name);
    expect(kojoHit!.kind).toBe(erbHit!.kind);
    // 行号：产物的 `@` 头是**纯生成行**，按与转到定义同一条折回规则落在本函数体的
    // 第一条有源行（这里就是第 3 行 `    「你好。」`）——同一条规则在两条腿上给出同一个
    // 位置，绝不越过下一个 `@`（越过就是别的函数，宁可不给）。
    const folded = foldGeneratedLine(PRODUCT, erbHit!.line);
    expect(folded).toBe(3);
    expect(kojoHit!.line).toBe(folded);
    // 命中总数与给出的条数同口径（糖线不虚报溢出）
    expect(kojoResult.totalMatched).toBe(kojoResult.symbols.length);
  });

  it('名录里证不了源位置的候选**不重定基**（不猜行号；那条仍以产物路径在 ERB 结果里）', async () => {
    const h = await boot();
    await settle(h);
    const kojo = h.contribution('kojo-workspace-symbols');
    // `CALLER` 定义在原生方言文件里（不是任何 `.kojo` 的产物）⇒ 糖线一条都不该编出来
    const result = kojo.provide({ kind: 'workspaceSymbol', query: 'CALLER', project: PROJECT }) as EditorWorkspaceSymbolResult;
    expect(result).toBeDefined();
    expect(result.symbols).toEqual([]);
    expect(result.totalMatched).toBe(0);
  });
});

/* ============================ ② codeLens / inlayHint：判据同源 ============================ */

describe('W6 · codeLens：`.kojo` 的行上注解与 ERB 同一份判据', () => {
  it('标签与落点逐字相同，只有行号折回源（`@` 函数头是纯生成行）', async () => {
    const h = await boot();
    await settle(h);
    const erb = h.contribution('erb-usage-lens');
    const kojo = h.contribution('kojo-code-lens');

    const erbResult = erb.provide({ kind: 'codeLens', path: PRODUCT_PATH, text: PRODUCT.erb, project: PROJECT }) as EditorCodeLensResult;
    const kojoResult = kojo.provide({
      kind: 'codeLens',
      path: SOURCE_PATH,
      text: KOJO_SOURCE,
      project: PROJECT,
      lineCount: KOJO_SOURCE.split('\n').length,
    }) as EditorCodeLensResult;

    // 前提自证：ERB 那条线确实对产物说话了（否则"同源"是空断言）
    expect(erbResult.lenses.length).toBeGreaterThan(0);
    expect(kojoResult.lenses.length).toBe(erbResult.lenses.length);

    for (const lens of erbResult.lenses) {
      const folded = foldGeneratedLine(PRODUCT, lens.line);
      expect(folded, `产物第 ${lens.line} 行该能折回源行`).not.toBeNull();
      const match: EditorCodeLens | undefined = kojoResult.lenses.find(
        (k) => k.line === folded && k.label === lens.label,
      );
      expect(match, `注解「${lens.label}」应以同一句话落在源第 ${folded} 行`).toBeDefined();
      // 落点原样保留：它指向真实存在的使用处（方言文件的行），换成源坐标就是编出来的
      expect(match!.target).toEqual(lens.target);
    }
    expect(kojoResult.lenses.map((l) => l.line)).toEqual([...kojoResult.lenses.map((l) => l.line)].sort((a, b) => a - b));
  });

  it('「没人调用就不说」这条口径在 `.kojo` 上同样成立（无引用 ⇒ 空数组，不抛）', async () => {
    const h = await boot();
    await settle(h);
    const kojo = h.contribution('kojo-code-lens');
    // 只有一份 `函数 开场()`，且没有任何调用它的方言文件 ⇒ ERB 判据一条不给 ⇒ 糖线也就无话可说
    const source = '角色: 12\n函数 开场()：\n    「开始。」\n    返回\n';
    const only = createSugarTranspileService({ dictionary: stubDict, faceTable: createEratwFaceTable() }).transpile(source, {
      filePath: '/t/KOJO/B.kojo',
    });
    expect(only.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // 这个函数名根本不在项目索引里（假盘没有它）⇒ "证明不了有人用" ⇒ 空
    const result = kojo.provide({ kind: 'codeLens', path: '/t/KOJO/B.kojo', text: source, project: PROJECT }) as EditorCodeLensResult;
    expect(result.kind).toBe('codeLens');
    expect(result.lenses).toEqual([]);
  });
});

describe('W6 · inlayHint：`.kojo` 的实参位提示与 ERB 同一份判据', () => {
  it('产物 CALL 行的提示折回源行列；列证不了就不给（不猜）', async () => {
    const h = await boot();
    await settle(h);
    const erb = h.contribution('erb-inlay-hints');
    const kojo = h.contribution('kojo-inlay-hints');

    const erbResult = erb.provide({ kind: 'inlayHint', path: PRODUCT_PATH, text: PRODUCT.erb, project: PROJECT }) as EditorInlayHintResult;
    expect(erbResult.hints.length).toBeGreaterThan(0);

    const kojoResult = kojo.provide({
      kind: 'inlayHint',
      path: SOURCE_PATH,
      text: KOJO_SOURCE,
      project: PROJECT,
      lineCount: KOJO_SOURCE.split('\n').length,
    }) as EditorInlayHintResult;
    expect(kojoResult.hints.length).toBeGreaterThan(0);

    // 同源核对：糖线的提示条数 ≤ 产物提示里"行折得回来"的那些（列折不动的那些整条丢弃）
    const foldable = erbResult.hints.filter((hint) => foldGeneratedLine(PRODUCT, hint.line) !== null).length;
    expect(kojoResult.hints.length).toBeLessThanOrEqual(foldable);

    // 逐条钉位置：源第 5 行是 `    CALL M_KOJO_K12_问候(3)`（原生直通，产物逐码元同源），
    // `3` 在第 24 列 ⇒ 提示必须正钉在它前面，标签是形参表第 1 槽的名字（`次数:`）
    const sourceLines = KOJO_SOURCE.split('\n');
    expect(sourceLines[5]).toBe('    CALL M_KOJO_K12_问候(3)');
    // `函数 问候(次数)：` 的产物头是 `@M_KOJO_K12_问候(ARG)`（形参落 ARG 槽），
    // ARG 式槽名的标签就是槽位坐标本身（`inlay-hints.ts` 的 `ARG_STYLE_RE` 口径）
    expect(PRODUCT.erb).toContain('@M_KOJO_K12_问候(ARG)');
    expect(kojoResult.hints).toContainEqual({
      line: 6,
      column: 24,
      label: 'ARG',
      tooltip: '第 1 参：ARG',
    });
    for (const hint of kojoResult.hints) {
      const text = sourceLines[hint.line - 1]!;
      expect(hint.column).toBeGreaterThanOrEqual(1);
      expect(hint.column).toBeLessThanOrEqual(text.length + 1);
      // 提示钉在"某个非空白字符之前"——钉到空白上就是钉错实参
      expect(/\S/.test(text.charAt(hint.column - 1))).toBe(true);
    }
    // ERB 那条线说的同一句话（同一个标签）在糖线上原样出现——判据没被改写过
    for (const hint of erbResult.hints) {
      expect(kojoResult.hints.some((k) => k.label === hint.label)).toBe(true);
    }
  });

  it('转译有 error（半成品不可当产物）⇒ 认这个文件但整篇无话可说：空数组、不抛', async () => {
    const h = await boot();
    await settle(h);
    const kojo = h.contribution('kojo-inlay-hints');
    const broken = '角色: 12\n时机 初见：\n    返回\n'; // 非函数体里的裸 `返回` ⇒ indent-mismatch（error）
    const result = kojo.provide({ kind: 'inlayHint', path: SOURCE_PATH, text: broken, project: PROJECT }) as EditorInlayHintResult;
    expect(result).toEqual({ kind: 'inlayHint', hints: [] });
    expect(() => kojo.provide({ kind: 'inlayHint', path: SOURCE_PATH, text: '', project: PROJECT })).not.toThrow();
  });
});

/* ============================ ③④ 守门与缺席（三态） ============================ */

describe('W6 · 三态纪律与方言守门', () => {
  it('糖线三枚只认 `.kojo`：方言与杂文件一律 undefined（各管各的，不重答）', async () => {
    const h = await boot();
    await settle(h);
    for (const id of ['kojo-code-lens', 'kojo-inlay-hints']) {
      const c = h.contribution(id);
      const kind = id === 'kojo-code-lens' ? 'codeLens' : 'inlayHint';
      expect(c.provide({ kind, path: '/t/CALLER.ERB', text: CALLER, project: PROJECT })).toBeUndefined();
      expect(c.provide({ kind, path: '/t/x.txt', text: CALLER, project: PROJECT })).toBeUndefined();
      expect(c.provide({ kind, path: '/t/ERH/x.erh', text: '#DIM A\n', project: PROJECT })).toBeUndefined();
    }
    // 判别成员不打扰：codeLens 请求不会让 workspaceSymbol 应答开口
    expect(h.contribution('kojo-workspace-symbols').provide({ kind: 'documentSymbol', path: SOURCE_PATH, text: '', project: PROJECT })).toBeUndefined();
  });

  it('解析线认整个方言族（大小写不敏感），只拒方言族之外（`.kojo` / `.txt`）', async () => {
    const h = await boot();
    const lens = h.contribution('erb-usage-lens');
    const hints = h.contribution('erb-inlay-hints');
    for (const path of ['/t/a.ERB', '/t/a.erb', '/t/a.Erm', '/t/a.erh', '/t/目录/名.ERB']) {
      expect(lens.provide({ kind: 'codeLens', path, text: '@A\n', project: PROJECT })).toBeDefined();
      expect(hints.provide({ kind: 'inlayHint', path, text: 'CALL A\n', project: PROJECT })).toBeDefined();
    }
    // `.kojo` 是**糖线的地盘**（行号属派生文本），解析线拒它是对的
    expect(lens.provide({ kind: 'codeLens', path: SOURCE_PATH, text: KOJO_SOURCE, project: PROJECT })).toBeUndefined();
    expect(hints.provide({ kind: 'inlayHint', path: SOURCE_PATH, text: KOJO_SOURCE, project: PROJECT })).toBeUndefined();
  });

  it('糖线注册的三枚 id 稳定（宿主/诊断按 id 指认）', async () => {
    const h = await boot();
    for (const id of ['kojo-workspace-symbols', 'kojo-code-lens', 'kojo-inlay-hints']) {
      expect(h.ids()).toContain(id);
    }
  });

  it('名录未就绪（项目没开 / 关掉了）⇒ 糖线不答，而不是答"没有"', async () => {
    // ① 从未打开过项目：解析线在场，但 `.kojo` 名录一条没建 ⇒ 本包不答
    const cold = await boot({ openProject: false });
    expect(
      cold.contribution('kojo-workspace-symbols').provide({ kind: 'workspaceSymbol', query: '问候', project: PROJECT }),
    ).toBeUndefined();
    // ② 开过又关掉：名录整表清空（旧项目的坐标一条不许留给新项目），同样回到"不答"
    const h = await boot();
    await h.emit('project.closed', { rootDir: '/t' });
    expect(
      h.contribution('kojo-workspace-symbols').provide({ kind: 'workspaceSymbol', query: '问候', project: PROJECT }),
    ).toBeUndefined();
  });

  it('单枚贡献抛错不影响其余（隔离在通道里，与宿主同口径）', async () => {
    const h = await boot();
    await settle(h);
    // 让 ERB 那条线的 codeLens 应答抛：糖线必须如实退化，不把异常带进编辑器的输入链
    const lens = h.contribution('erb-usage-lens');
    const original = lens.provide;
    (lens as { provide: unknown }).provide = (): never => {
      throw new Error('boom');
    };
    try {
      const result = h.contribution('kojo-code-lens').provide({
        kind: 'codeLens',
        path: SOURCE_PATH,
        text: KOJO_SOURCE,
        project: PROJECT,
      });
      expect(result).toBeUndefined(); // 没有名录可言 = 不答（不谎称"这里没有引用"）
    } finally {
      (lens as { provide: unknown }).provide = original;
    }
    const stillWorks = h.contribution('kojo-code-lens').provide({
      kind: 'codeLens',
      path: SOURCE_PATH,
      text: KOJO_SOURCE,
      project: PROJECT,
    }) as EditorCodeLensResult;
    expect(stillWorks.lenses.length).toBeGreaterThan(0);
  });

  it('候选类型形状收口（同一份契约对象，值只多不少）', async () => {
    const h = await boot();
    await settle(h);
    const result = h.contribution('kojo-workspace-symbols').provide({
      kind: 'workspaceSymbol',
      query: 'M_KOJO',
      project: PROJECT,
      limit: 50,
    }) as EditorWorkspaceSymbolResult;
    const symbol: EditorWorkspaceSymbol | undefined = result.symbols.find((s) => s.filePath === SOURCE_PATH);
    expect(symbol).toBeDefined();
    expect(symbol!.kind).toBe('function');
    expect(Number.isInteger(symbol!.line)).toBe(true);
  });
});
