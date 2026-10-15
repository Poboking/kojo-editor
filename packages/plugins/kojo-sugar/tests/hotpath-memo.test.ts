/**
 * PERF-5 验收（装配层）：适配器视图 **memo** + 共享缓存在真实插件路径上的接线。
 *
 * 钉死三组读数（全部为确定性计数，不依赖墙钟）：
 *
 * 1. **转译器按代际 memo**：N 次 `sugar.transpile` 只做 N 次槽位扫（改前 = 4N 次，
 *    四个 `*Of` 各查一遍）+ 不再每调重建服务/字典（schema getter 每次调用至多 1 读）；
 *    实例复用由"跨调缓存命中"直接证明（若每调重建，第二次调用必 miss）。
 * 2. **三消费者共享：3→1**——波浪线（decorator 的 `sugar.transpile`）、糖判定面板
 *    （同服务再调一次）、糖预览（`sugar.preview` 内部转译）在同一 (文本, filePath)
 *    上只发生 **1 次真实转译**（`transpileCacheStats().misses === 1`）。
 * 3. **失效正确性**：文本变 ⇒ miss；切项目 / 变量字典换代（新 schema 对象）⇒
 *    新一代际（新实例、空缓存）⇒ 同文本也重算。
 *
 * 上下文用本文件自带的极小插件上下文（与 `language-service.test.ts` 同款骨架），
 * 只有 Project / Slots / IO 三枚硬依赖 + 软取异常路径。
 */

import { describe, expect, it } from 'vitest';
import type {
  FileIO,
  GameProject,
  KojoFaceTable,
  PluginContext,
  SugarPreviewService,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '../src/index';
import type { SugarTranspileServiceWithCache } from '../src/service';
import { stubFaceTable } from './support';

/* ============================== 极小上下文 + 可控适配器 ============================== */

interface AdapterContribution {
  adapter: {
    gameId: string;
    readonly variableSchema: VariableSchema | undefined;
    readonly kojoFaceTemplates: KojoFaceTable | undefined;
  };
}

interface Harness {
  readonly sugar: SugarTranspileServiceWithCache;
  readonly preview: SugarPreviewService;
  readonly counts: { slotQueries: number; schemaGets: number };
  setProject(project: GameProject | null): void;
  setSchema(schema: VariableSchema | undefined): void;
}

function fakeSchema(tag: string): VariableSchema {
  return {
    version: `fake-${tag}`,
    lookup: (family: string, index?: number | string) =>
      index === undefined ? { name: family.toUpperCase(), description: `${tag} 标签` } : undefined,
    names: () => [],
  };
}

function project(rootDir: string, digest: string): GameProject {
  return {
    rootDir,
    adapterId: 'fake-game',
    kojoPaths: [],
    writablePaths: [],
    charaIndex: new Map(),
    inputDigest: digest,
  };
}

function activate(): Harness {
  const counts = { slotQueries: 0, schemaGets: 0 };
  let project_: GameProject | null = project('C:/p1', 'd1');
  let schema: VariableSchema | undefined = fakeSchema('g1');
  const faceTable = stubFaceTable();

  const contribution: AdapterContribution = {
    adapter: {
      gameId: 'fake-game',
      get variableSchema() {
        counts.schemaGets++;
        return schema;
      },
      get kojoFaceTemplates() {
        return faceTable;
      },
    },
  };

  const provided = new Map<string, unknown>();
  const noop = (): void => undefined;
  const slotApi = {
    query: (kind: string) => {
      if (kind === 'game.adapter') {
        counts.slotQueries++;
        return [contribution];
      }
      return [];
    },
    register: () => noop,
  };
  const ctx = {
    pluginId: 'kojo-sugar',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: { on: () => noop, once: () => noop, emit: noop },
    inject: <T,>(key: string): T => {
      if (key === KernelServices.Project) {
        return { current: () => project_ } as unknown as T;
      }
      if (key === KernelServices.Slots) return slotApi as unknown as T;
      if (key === KernelServices.IO) return {} as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    slots: slotApi,
    onDispose: noop,
  } as unknown as PluginContext;

  createKojoSugarPlugin().activate(ctx);

  const sugar = provided.get(WellKnownServices.SugarTranspile) as SugarTranspileServiceWithCache;
  const preview = provided.get(WellKnownServices.SugarPreview) as SugarPreviewService;
  if (!sugar || !preview) throw new Error('插件未提供 sugar.transpile / sugar.preview');

  return {
    sugar,
    preview,
    counts,
    setProject: (p) => {
      project_ = p;
    },
    setSchema: (s) => {
      schema = s;
    },
  };
}

const PATH = 'C:/p1/M_KOJO_K49_指令.kojo';
const DOC = '角色: 12\n时机 指令 310：\n    「呀。」\n';

/* ============================== 1. 转译器按代际 memo ============================== */

describe('makeTranspiler · 按代际 memo（不再每调重建）', () => {
  it('N 次 transpile = N 次槽位扫（改前 4N）+ 跨调缓存命中证明实例复用', () => {
    const h = activate();
    const before = { ...h.counts };
    for (let i = 0; i < 3; i++) h.sugar.transpile(DOC, { filePath: PATH });
    expect(h.counts.slotQueries - before.slotQueries).toBe(3); // 每调一次视图探测（改前 = 4/调）
    expect(h.counts.schemaGets - before.schemaGets).toBe(3);
    // 实例复用：第二次起命中缓存（每调重建的话必 miss）
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 2 });
  });
});

/* ============================== 2. 三消费者共享：3→1 ============================== */

describe('三消费者同一版本共享：真实转译 3→1', () => {
  it('波浪线 + 糖判定 + 糖预览：三次消费，misses = 1', async () => {
    const h = activate();
    // ① 波浪线（decorator 槽的调用形态）
    h.sugar.transpile(DOC, { filePath: PATH });
    // ② 糖判定面板（同服务、读盘后同文本同路径）
    h.sugar.transpile(DOC, { filePath: PATH });
    // ③ 糖预览面板（sugar.preview 内部复用同一转译器）
    const r = await h.preview.preview({ source: DOC, filePath: PATH });
    expect(r.transpile.erb).toContain('@');
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 2 });
  });
});

/* ============================== 3. 失效正确性 ============================== */

describe('失效正确性：文本变 / 切项目 / 字典换代', () => {
  it('文本变 ⇒ 重算；切项目（新 rootDir + 新 schema）⇒ 新代际、同文本也重算', () => {
    const h = activate();
    h.sugar.transpile(DOC, { filePath: PATH });
    h.sugar.transpile(`${DOC}; 改了一行\n`, { filePath: PATH });
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 2, hits: 0 });

    // 切项目：rootDir / inputDigest / schema 全换代
    h.setProject(project('C:/p2', 'd2'));
    h.setSchema(fakeSchema('g2'));
    h.sugar.transpile(DOC, { filePath: PATH });
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 0 }); // 新实例：空缓存
  });

  it('项目关闭（current === null）⇒ 又一代际；重开原项目 ⇒ 再换新实例（旧缓存不复活脏数据）', () => {
    const h = activate();
    h.sugar.transpile(DOC, { filePath: PATH });
    h.setProject(null);
    h.sugar.transpile(DOC, { filePath: PATH });
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 0 });
    h.setProject(project('C:/p1', 'd1'));
    h.sugar.transpile(DOC, { filePath: PATH });
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 0 });
  });

  it('变量字典换代（同项目、同 rootDir，仅 schema 对象换新）⇒ 必重算（代际判据含表引用）', () => {
    const h = activate();
    h.sugar.transpile(DOC, { filePath: PATH });
    h.sugar.transpile(DOC, { filePath: PATH });
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 1 });

    h.setSchema(fakeSchema('g1-重生')); // 内容同形状，对象身份已换
    h.sugar.transpile(DOC, { filePath: PATH });
    expect(h.sugar.transpileCacheStats()).toMatchObject({ misses: 1, hits: 0 });
  });
});

/* ============================== 4. 日志水位不静默 ============================== */

describe('缓存读数进日志（debug 水位行）', () => {
  it('每 64 次调用输出一行命中/未命中/淘汰（不静默、不刷屏）', () => {
    const lines: string[] = [];
    const provided = new Map<string, unknown>();
    const noop = (): void => undefined;
    const slotApi = { query: () => [], register: () => noop };
    const ctx = {
      pluginId: 'kojo-sugar',
      log: {
        debug: (m: string) => lines.push(m),
        info: noop,
        warn: noop,
        error: noop,
      },
      bus: { on: () => noop, once: () => noop, emit: noop },
      inject: <T,>(key: string): T => {
        if (key === KernelServices.Project) return { current: () => null } as unknown as T;
        if (key === KernelServices.Slots) return slotApi as unknown as T;
        if (key === KernelServices.IO) return {} as unknown as T;
        throw new Error(`unexpected inject: ${key}`);
      },
      provide: (key: string, value: unknown) => provided.set(key, value),
      slots: slotApi,
      onDispose: noop,
    } as unknown as PluginContext;
    createKojoSugarPlugin().activate(ctx);
    const sugar = provided.get(WellKnownServices.SugarTranspile) as SugarTranspileServiceWithCache;
    for (let i = 0; i < 64; i++) sugar.transpile(`; 注释 ${i}\n`, { filePath: 'C:/x.kojo' });
    expect(lines.some((l) => l.includes('缓存') && l.includes('命中'))).toBe(true);
  });
});
