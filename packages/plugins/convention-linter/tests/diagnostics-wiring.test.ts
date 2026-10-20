/**
 * 诊断面**接线**的钉桩测试（DIAG-LINK）：插件激活后，两个槽真的注册了吗？
 * 报告一变，波浪线真的跟着变吗（**只走引擎既有订阅广播**，不新建第二套事件）？
 *
 * 用一枚最小假 `PluginContext`（零 kernel、零盘），把 `ConventionLinterService` 真跑一遍：
 * 装饰器与 💡 供方读的就是装配点里那份 `view`，所以这里钉的是"广播 → 视图 → 槽"这条链，
 * 折叠层的算法另在 `diagnostics.test.ts` 钉。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConventionReport,
  EditorCodeAction,
  EditorDecoratorContribution,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  FileIO,
  GameProject,
  LineDecoration,
  Logger,
  PluginContext,
  SlotRegistry,
  SugarDiagnostic,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createUiSugarEditorPlugin } from '@kojo/plugin-ui-sugar-editor';
import { createConventionLinterPlugin } from '../src/index';
import { conventionIssueKey, conventionSurfaceDecoration } from '../src/diagnostics';
import {
  SUGAR_LINT_DIAGNOSTIC_CODES,
  SUGAR_RULE_ID_PREFIX,
  setSugarTranspileProvider,
} from '../src/rules/sugar-conventions';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const DUP_ERB = 'C:/game/data/erbkoujo/a.erb';
const SUGAR_KOJO = 'C:/game/data/kojo/a.kojo';
const DUP_TEXT = '@AAA\nPRINTDATA\nEND\n@AAA\nPRINTDATA\nEND\n';
const KOJO_TEXT = '时机 对话：\n  「你好 续」\n';

function indexWith(files: Record<string, string>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [path, text] of Object.entries(files)) {
    const f = parseErbText(text, path);
    map.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: map, byName };
}

/** 两槽贡献在测试里的最小形状（真类型由 `src/index.ts` 那边把关，这里只取读得动的两刀） */
interface Registered {
  readonly slot: string;
  readonly item: {
    id?: string;
    title?: string;
    order?: number;
    decorate?: (file: { path: string; text: string; project: GameProject | null }) => LineDecoration[];
    provideActions?: (file: {
      path: string;
      text: string;
      project: GameProject | null;
      line?: number;
    }) => EditorCodeAction[];
  };
}

/** 最小假上下文：只装配本插件用得上的四路服务 + 内存存储 + 槽位表 */
function harness(opts: { writable?: (path: string) => boolean } = {}) {
  const registrations: Registered[] = [];
  const provided = new Map<string, unknown>();
  const disposers: Array<() => void> = [];
  const store = new Map<string, unknown>();
  let index: ErbIndex | null = null;
  const writable = opts.writable ?? (() => true);

  const slots = {
    register: (slot: string, item: Registered['item']) => {
      registrations.push({ slot, item });
      return () => {
        const at = registrations.findIndex((r) => r.item === item);
        if (at >= 0) registrations.splice(at, 1);
      };
    },
    query: () => [],
  } as unknown as SlotRegistry;

  const io = {
    readText: async (path: string) => ({ text: path === SUGAR_KOJO ? KOJO_TEXT : DUP_TEXT, encoding: 'utf-8', eol: '\n', bom: false }),
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => ({ text: p === SUGAR_KOJO ? KOJO_TEXT : DUP_TEXT, encoding: 'utf-8', eol: '\n', bom: false })),
    isWritable: (path: string) => writable(path),
  } as unknown as FileIO;

  const project: GameProject = {
    rootDir: 'C:/game',
    adapterId: 'test',
    kojoPaths: [SUGAR_KOJO],
    writablePaths: [],
    charaIndex: new Map(),
  };

  const ctx: PluginContext = {
    pluginId: 'convention-linter',
    log: silentLog,
    bus: { on: () => () => {}, once: () => () => {}, emit: () => {} },
    storage: {
      get: async <T,>(k: string) => store.get(k) as T | undefined,
      set: async <T,>(k: string, v: T) => {
        store.set(k, v);
      },
      delete: async (k: string) => {
        store.delete(k);
      },
      keys: async () => [...store.keys()],
    },
    slots,
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    inject: <T = unknown,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.slots') return slots as unknown as T;
      if (key === 'kernel.project') return { current: () => project } as unknown as T;
      if (key === WellKnownServices.ErbParser)
        return { currentIndex: () => index, ensureIndex: async () => index } as unknown as T;
      throw new Error(`假上下文未装配服务：${key}`);
    },
    tryInject: <T = unknown,>(key: string): T | undefined => provided.get(key) as T | undefined,
    onDispose: (fn: () => void) => {
      disposers.push(fn);
    },
  };

  const plugin = createConventionLinterPlugin();
  plugin.activate(ctx);
  const linter = provided.get(WellKnownServices.ConventionLinter) as {
    run(): Promise<unknown>;
    report(): ConventionReport;
  };

  const decoratorOf = (id: string) =>
    registrations.find((r) => r.slot === 'ui.editor.decorator' && r.item.id === id)?.item.decorate;
  const actionOf = (id: string) =>
    registrations.find((r) => r.slot === 'ui.editor.codeAction' && r.item.id === id)?.item.provideActions;

  return {
    registrations,
    linter,
    setIndex: (next: ErbIndex | null) => {
      index = next;
    },
    decorate: (path: string, text: string) => decoratorOf('convention-issues')?.({ path, text, project }),
    actions: (path: string, text: string, line?: number) =>
      actionOf('convention-quickfix')?.({ path, text, project, ...(line === undefined ? {} : { line }) }),
    dispose: () => disposers.forEach((fn) => fn()),
  };
}

describe('诊断面接线的两槽', () => {
  it('激活即注册 `ui.editor.decorator` 与 `ui.editor.codeAction`（不靠面板、不靠新事件）', () => {
    setSugarTranspileProvider(null);
    const h = harness();
    expect(h.registrations.map((r) => `${r.slot}#${r.item.id}`).sort()).toEqual([
      'ui.editor.codeAction#convention-quickfix',
      'ui.editor.decorator#convention-issues',
    ]);
    h.dispose();
  });

  it('跑完一次校验（引擎订阅广播）→ 波浪线自己到位；info 一档也在面上', async () => {
    setSugarTranspileProvider(null);
    const h = harness();
    h.setIndex(indexWith({ [DUP_ERB]: DUP_TEXT }));
    await h.linter.run();
    const decorations = h.decorate(DUP_ERB, DUP_TEXT) ?? [];
    expect(decorations.length).toBeGreaterThan(0);
    expect(decorations.every((d) => d.severity === 'info' && d.code === 'erb.duplicate-function')).toBe(true);
    // 没有可证明改法的规则 ⇒ 面上有波浪线，但 💡 一条不给（不猜）
    expect(h.actions(DUP_ERB, DUP_TEXT, decorations[0]!.line)).toEqual([]);
    h.dispose();
  });

  it('`.kojo` 的引号内「续」：线归发布方（本层不再发第二条），💡 仍给整行改法并认领面上那一条', async () => {
    const stub: SugarTranspileService = {
      transpile: () => ({
        diagnostics: [
          {
            code: 'cont-inside-quotes',
            severity: 'error',
            message: '「续」写在了引号内。',
            loc: { line: 2, column: 3 },
          } satisfies SugarDiagnostic,
        ],
      }),
    } as unknown as SugarTranspileService;
    setSugarTranspileProvider(() => stub);
    const h = harness();
    h.setIndex(indexWith({ [SUGAR_KOJO]: KOJO_TEXT }));
    await h.linter.run();
    // 归属（2026-10-19 清账批）：`.kojo` 上的糖族行装饰归 `sugar-diagnostics`，本层零条
    const decorations = h.decorate(SUGAR_KOJO, KOJO_TEXT) ?? [];
    expect(decorations).toEqual([]);
    const actions = h.actions(SUGAR_KOJO, KOJO_TEXT, 2) ?? [];
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('quickfix');
    expect(action.edits).toEqual([{ fromLine: 2, toLine: 2, newText: '  「你好」 续' }]);
    // 身份一致：动作带出的诊断就是**发布方画的那一条**的身份（码无面板前缀 ⇒ 宿主键认得出）
    expect(action.diagnostics).toEqual([
      { line: 2, severity: 'error', message: '「续」写在了引号内。', source: '续行标记写在引号内', code: 'cont-inside-quotes' },
    ]);
    // 宿主反翻译回来的面上 marker（列是正向翻译补的默认值、`source` 不回传）与本层身份同键
    const onScreen: LineDecoration[] = [
      { line: 2, severity: 'error', message: '「续」写在了引号内。', startColumn: 4, endColumn: 9, code: 'cont-inside-quotes' },
    ];
    expect(conventionIssueKey(onScreen[0]!)).toBe(conventionIssueKey(action.diagnostics![0]!));
    h.dispose();
    setSugarTranspileProvider(null);
  });

  it('只读路径不供修法（与 erb-structure-fix 同一道门槛）', async () => {
    const stub = {
      transpile: () => ({
        diagnostics: [
          { code: 'cont-inside-quotes', severity: 'error', message: 'm', loc: { line: 2, column: 3 } },
        ],
      }),
    } as unknown as SugarTranspileService;
    setSugarTranspileProvider(() => stub);
    const h = harness({ writable: () => false });
    h.setIndex(indexWith({ [SUGAR_KOJO]: KOJO_TEXT }));
    await h.linter.run();
    // 线仍由发布方画（本层这条不发），但只读闸照旧挡住修法
    expect(h.decorate(SUGAR_KOJO, KOJO_TEXT) ?? []).toEqual([]);
    expect(h.linter.report()!.issues.length).toBeGreaterThan(0);
    expect(h.actions(SUGAR_KOJO, KOJO_TEXT, 2)).toEqual([]);
    h.dispose();
    setSugarTranspileProvider(null);
  });

  it('退订即停：deactivate 后广播不再改动视图（不留悬空订阅）', async () => {
    setSugarTranspileProvider(null);
    const h = harness();
    h.setIndex(indexWith({ [DUP_ERB]: DUP_TEXT }));
    await h.linter.run();
    expect((h.decorate(DUP_ERB, DUP_TEXT) ?? []).length).toBeGreaterThan(0);
    h.dispose();
    expect(h.registrations).toEqual([]);
    // 订阅本身也退了：退订之后再跑一轮不报错、也不再改动任何已注销的槽
    await expect(h.linter.run()).resolves.toBeDefined();
    expect(h.registrations).toEqual([]);
  });
});

/* ==================== 波浪线**归属**（2026-10-19 自造重叠清账批） ====================
 *
 * W1b 把本插件接上 `ui.editor.decorator`，W2 又把四条糖规则改成转译器的投影 ⇒ 同一棵
 * `.kojo` 同一行的**同一件事**被发成两条 marker：`ui-sugar-editor#sugar-diagnostics` 发一条
 * 裸码（转译器码本名）、这里发一条 `sugar.` 前缀 ⇒ 问题面板每条显示两行、计数翻倍。
 * 裁决落在**归属**这一层：`.kojo` 上的糖族行装饰归发布方（它对着**实时转译产物**画，是那份
 * 真相的最近邻），本层只进整项目报告与面板分组。
 *
 * 合并口径逐字照宿主（`marker-pool` / `kojo-fix-all.documentDiagnostics`）：按贡献顺序 push、
 * **宿主不做按行去重**（那是第三把尺子）⇒ "不翻倍"只能是贡献方自己的归属裁决，这条测试
 * 因此必须拿**两家真的都起来**的合并面来钉，而不是只数本层那一份。
 * 两家喂**同一枚真转译服务**（判据单源 ⇒ 行 / 消息 / 严重级天然逐字相等，比对才不是自证）。
 */
describe('波浪线归属：同一行两贡献方合并不翻倍', () => {
  /** 真转译服务（同一枚实例喂两家；`.kojo` 无角色头也会报别的码，本组只按码子集筛） */
  const sugarService = createSugarTranspileService({ faceTable: createEratwFaceTable() });

  /** 起**真** `ui-sugar-editor`，取它那枚 `sugar-diagnostics`（面上那条线的发布方） */
  function publishSugarSquiggles(): (path: string, text: string) => LineDecoration[] {
    const contributions: EditorDecoratorContribution[] = [];
    const ctx: PluginContext = {
      pluginId: 'ui-sugar-editor',
      log: silentLog,
      bus: { on: () => () => {}, once: () => () => {}, emit: () => {} },
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        keys: async () => [],
      },
      slots: {
        register: (slot: string, item: unknown) => {
          if (slot === 'ui.editor.decorator') contributions.push(item as EditorDecoratorContribution);
          return () => {};
        },
        query: () => [],
      } as unknown as SlotRegistry,
      provide: () => {},
      inject: <T = unknown,>(key: string): T => {
        if (key === WellKnownServices.SugarTranspile) return sugarService as unknown as T;
        if (key === KernelServices.IO)
          return { isWritable: () => true, readText: async () => ({ text: '' }) } as unknown as T;
        if (key === KernelServices.Project) return { current: () => null } as unknown as T;
        if (key === KernelServices.Slots) return { register: () => () => {}, query: () => [] } as unknown as T;
        if (key === KernelServices.Workspaces) return {} as unknown as T;
        throw new Error(`假上下文未装配服务：${key}`);
      },
      tryInject: <T = unknown,>(): T | undefined => undefined,
      onDispose: () => {},
    };
    createUiSugarEditorPlugin().activate(ctx);
    const found = contributions.find((c) => c.id === 'sugar-diagnostics');
    if (!found) throw new Error('ui-sugar-editor 未注册 `sugar-diagnostics`（装配面变了，本组判据作废）');
    return (path, text) => found.decorate({ path, text, project: null });
  }

  /** 糖族判据子集（`rules/sugar-conventions.ts` 那份唯一清单）在本组夹具里确实有上线的 */
  const inLintSubset = (d: LineDecoration): boolean =>
    (SUGAR_LINT_DIAGNOSTIC_CODES as readonly string[]).includes(d.code ?? '');

  it('①同一 `.kojo` 同一行：两家合并后的条数 === 发布方那一份（本层一条糖族线都不发）', async () => {
    setSugarTranspileProvider(() => sugarService);
    const sugarDecorate = publishSugarSquiggles();
    const h = harness();
    h.setIndex(indexWith({ [SUGAR_KOJO]: KOJO_TEXT, [DUP_ERB]: DUP_TEXT }));
    await h.linter.run();

    const published = sugarDecorate(SUGAR_KOJO, KOJO_TEXT);
    const mine = h.decorate(SUGAR_KOJO, KOJO_TEXT) ?? [];
    const subset = published.filter(inLintSubset);
    // 夹具要让发布方**确有**糖族子集那几条线（否则"不翻倍"是两边都没报的空转）
    expect(subset.length, JSON.stringify(published)).toBeGreaterThan(0);
    // 归属闸：这一族在 `.kojo` 上不由本层画第二条
    expect(mine).toEqual([]);
    const merged = [...published, ...mine]; // 宿主就这么合并：按贡献顺序 push，不去重
    expect(merged).toHaveLength(published.length);
    for (const d of subset) {
      // 同一行同一件事在面上只有一条，且码是发布方那份本名（无面板前缀）
      expect(merged.filter((m) => m.line === d.line && m.message === d.message)).toHaveLength(1);
    }
    expect(merged.some((m) => (m.code ?? '').startsWith(SUGAR_RULE_ID_PREFIX))).toBe(false);
    h.dispose();
    setSugarTranspileProvider(null);
  });

  it('②整项目结论一条不少：那条 `sugar.*` issue 仍在 report 与面板分组里', async () => {
    setSugarTranspileProvider(() => sugarService);
    const sugarDecorate = publishSugarSquiggles();
    const h = harness();
    h.setIndex(indexWith({ [SUGAR_KOJO]: KOJO_TEXT }));
    await h.linter.run();
    const report = h.linter.report() as ConventionReport;
    const sugarIssues = report.issues.filter((i) => i.ruleId.startsWith(SUGAR_RULE_ID_PREFIX));
    expect(sugarIssues.length, JSON.stringify(report.issues)).toBeGreaterThan(0);
    // 报告口径与 issue 表逐字对得上（归属只动装饰面，没动项目级账）
    expect(report.counts.error + report.counts.warning + report.counts.info).toBe(report.issues.length);
    // 报告里那几条与面上那几条说的是同一件事（同一枚转译服务 ⇒ 行 + 消息逐字相等）
    const published = sugarDecorate(SUGAR_KOJO, KOJO_TEXT);
    for (const i of sugarIssues) {
      if (typeof i.line !== 'number') continue;
      expect(published.some((d) => d.line === i.line && d.message === i.message), i.ruleId).toBe(true);
    }
    // 反向也钉住：本层为那条 issue 算出的**认领身份**就是面上那一条（前缀已剥）
    for (const i of sugarIssues) {
      const surface = conventionSurfaceDecoration(i);
      if (!surface) continue;
      expect(published.some((d) => conventionIssueKey(d) === conventionIssueKey(surface)), i.ruleId).toBe(true);
    }
    h.dispose();
    setSugarTranspileProvider(null);
  });

  it('③非糖规则波浪线照旧（`erb.duplicate-function` 没有别家发，删了就是漏报）', async () => {
    setSugarTranspileProvider(() => sugarService);
    const h = harness();
    h.setIndex(indexWith({ [SUGAR_KOJO]: KOJO_TEXT, [DUP_ERB]: DUP_TEXT }));
    await h.linter.run();
    const mine = h.decorate(DUP_ERB, DUP_TEXT) ?? [];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((d) => d.code === 'erb.duplicate-function')).toBe(true);
    // 同一轮里 `.kojo` 的糖族那条**不**在面上（归属在别家）——两件事各自成立，不是整条链路哑了
    expect(h.decorate(SUGAR_KOJO, KOJO_TEXT) ?? []).toEqual([]);
    h.dispose();
    setSugarTranspileProvider(null);
  });
});
