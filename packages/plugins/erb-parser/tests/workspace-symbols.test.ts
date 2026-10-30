/**
 * D2 · 工作区符号查询（`workspaceSymbolsInIndex`）单测 + 十万条规模的实测。
 *
 * 夹具口径与 `symbols.test.ts` 一致：**走生产路径建索引**（`parseErbText` →
 * `aggregateIndex`），不手搓 `ErbIndex` 字面量——手搓夹具会把"索引长什么样"钉死在
 * 测试里，真实解析一变测试仍绿，那就白测了（性能那一档例外：只为造体量，见其注）。
 *
 * 覆盖任务书点名的判据：大小写不敏感 / 中文名与原生大写名都查得到 /
 * 名字命中优先于路径命中 / 上限 + 溢出计数 / 同名多定义并列 / 空查询不给全表。
 */

import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type {
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbParserService,
  FileIO,
  PluginContext,
  Unsubscribe,
} from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { aggregateIndex } from '../src/snapshot';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';
import {
  DEFAULT_WORKSPACE_SYMBOL_LIMIT,
  workspaceSymbolsInIndex,
} from '../src/symbols';

/** 由多份文本建索引（生产路径：解析 → 聚合） */
function indexOf(files: { path: string; text: string }[]): ErbIndex {
  const parsed: ErbFile[] = files.map((f) => parseErbText(f.text, f.path));
  const agg = aggregateIndex(parsed);
  return { files: agg.files, byName: agg.byName };
}

const F1 = 'C:\\proj\\chara10\\Message.ERB';
const F2 = 'C:\\proj\\chara20\\Message.ERB';

const idx = indexOf([
  {
    path: F1,
    // 原生大写名 + 中文函数名（真实语料 21% 的名字含 CJK）+ 同名多定义
    text: [
      '@ALPHA(ARG)',
      '\tRETURN 1',
      '@训练度检查',
      '\tRETURN 1',
      '@CHARA_TEXT_MESSAGE',
      '\tRETURN 1',
      '@ALPHA',
      '\tRETURN 2',
      '@UNRELATED',
      '\tPRINTFORMW "alpha 只在路径里，名字里没有"',
    ].join('\n'),
  },
  { path: F2, text: ['@BETA', '\tRETURN 1'].join('\n') },
]);

describe('workspaceSymbolsInIndex · 查询口径', () => {
  it('空 / 全空白查询不给全表（十万条不许整份递回去）', () => {
    expect(workspaceSymbolsInIndex(idx, '')).toEqual({ symbols: [], totalMatched: 0, scope: null });
    expect(workspaceSymbolsInIndex(idx, '   ')).toEqual({ symbols: [], totalMatched: 0, scope: null });
  });

  it('范围戳（W7 NAV-SCOPE）：范围外的定义不进产出、**也不进命中总数**（挡掉的不许报成溢出）', () => {
    const all = workspaceSymbolsInIndex(idx, 'alpha');
    expect(all.totalMatched).toBe(2);
    expect(all.scope).toBeNull();
    const scopedOut = workspaceSymbolsInIndex(idx, 'alpha', undefined, { key: 'k20', roots: ['C:\\proj\\chara20'] });
    expect(scopedOut.symbols).toEqual([]);
    expect(scopedOut.totalMatched).toBe(0);
    expect(scopedOut.scope?.key).toBe('k20'); // 实际生效的戳原样回显给宿主
    const scopedIn = workspaceSymbolsInIndex(idx, 'alpha', undefined, { key: 'k10', roots: ['C:\\proj\\chara10'] });
    expect(scopedIn.totalMatched).toBe(2);
    // 盖在索引上的派生视图戳与显式参数走同一条 `pathInScope`
    const stamped: ErbIndex = { ...idx, scope: { key: 'k20', roots: ['C:\\proj\\chara20'] } };
    expect(workspaceSymbolsInIndex(stamped, 'alpha').totalMatched).toBe(0);
  });

  it('大小写不敏感：小写查询命中原生大写名（Emuera 名字口径）', () => {
    const hit = workspaceSymbolsInIndex(idx, 'alpha');
    expect(hit.symbols.map((s) => s.name).sort()).toEqual(['ALPHA', 'ALPHA']);
    expect(hit.totalMatched).toBe(2);
    expect(hit.symbols.every((s) => s.line === 1 || s.line === 7)).toBe(true);
  });

  it('精确名 > 前缀 > 含子串（同一条查询里三档同时命中时的顺序）', () => {
    const hit = workspaceSymbolsInIndex(idx, 'chara_text');
    expect(hit.symbols.map((s) => s.name)).toEqual(['CHARA_TEXT_MESSAGE']);
    // 精确名排最前：单独查 `CHARA_TEXT_MESSAGE` 的精确档
    const exact = workspaceSymbolsInIndex(idx, 'CHARA_TEXT_MESSAGE');
    expect(exact.symbols[0]?.name).toBe('CHARA_TEXT_MESSAGE');
    expect(exact.symbols[0]?.line).toBe(5);
  });

  it('中文函数名查得到（本域最高频的检索入口）', () => {
    const hit = workspaceSymbolsInIndex(idx, '训练');
    expect(hit.symbols.map((s) => s.name)).toEqual(['训练度检查']);
    expect(hit.symbols[0]?.filePath).toBe(F1);
    expect(hit.symbols[0]?.kind).toBe('function');
  });

  it('同名多定义并列给出，靠 filePath / line 区分', () => {
    const hit = workspaceSymbolsInIndex(idx, 'ALPHA');
    expect(hit.symbols).toHaveLength(2);
    expect(new Set(hit.symbols.map((s) => `${s.filePath}:${s.line}`)).size).toBe(2);
  });

  it('路径命中排在名字命中之后（两份文件的目录段都含 `chara`，故名字没命中的那些也列出来，但一律排在后面）', () => {
    // 目录名命中：`chara20` 在路径里、不在任何名字里
    const pathOnly = workspaceSymbolsInIndex(idx, 'chara20');
    expect(pathOnly.symbols.map((s) => s.name)).toEqual(['BETA']);
    expect(pathOnly.totalMatched).toBe(1);

    // 名字命中 + 路径命中同时存在时，名字档恒在前
    const both = workspaceSymbolsInIndex(idx, 'chara');
    expect(both.symbols[0]?.name).toBe('CHARA_TEXT_MESSAGE');
    expect(both.symbols.map((s) => s.name)).toEqual([
      'CHARA_TEXT_MESSAGE',
      'ALPHA',
      '训练度检查',
      'ALPHA',
      'UNRELATED',
      'BETA',
    ]);
    expect(both.totalMatched).toBe(6);
  });

  it('产出预算：满桶后只计数不再造对象，总数照常报（溢出不是丢弃）', () => {
    const hit = workspaceSymbolsInIndex(idx, 'A', 1);
    expect(hit.symbols).toHaveLength(1);
    expect(hit.totalMatched).toBeGreaterThan(1);
  });

  it(`缺省预算 = ${DEFAULT_WORKSPACE_SYMBOL_LIMIT}`, () => {
    const hit = workspaceSymbolsInIndex(idx, 'A');
    expect(hit.symbols.length).toBeLessThanOrEqual(DEFAULT_WORKSPACE_SYMBOL_LIMIT);
  });

  it('非法预算（0 / 负 / NaN）退回缺省，不是"一条都不给"', () => {
    for (const bad of [0, -5, Number.NaN]) {
      const hit = workspaceSymbolsInIndex(idx, 'ALPHA', bad);
      expect(hit.symbols).toHaveLength(2);
    }
  });
});

describe('workspaceSymbolsInIndex · 十万条规模实测（语料口径 99,104 函数 / 2,316 文件）', () => {
  /**
   * 体量夹具**刻意不**走解析器：100k 行 × 解析（含每行正则）要 100ms+，那是测解析器
   * 不是测查询。这里直接搭 `ErbIndex` 的两张表（键/值形状与 `aggregateIndex` 产出一致），
   * 上面那组用例已经用生产路径钉住了"形状对不对"。
   */
  function bigIndex(fnCount: number, fileCount: number): ErbIndex {
    const files = new Map<string, ErbFile>();
    const byName = new Map<string, ErbFunctionRef[]>();
    let made = 0;
    for (let f = 0; f < fileCount && made < fnCount; f++) {
      const path = `C:\\proj\\包${f}\\M_KOJO_K${f}_${f % 97}.ERB`;
      const perFile = Math.min(Math.ceil((fnCount - made) / (fileCount - f)), 60);
      const functions: ErbFunction[] = [];
      for (let k = 0; k < perFile && made < fnCount; k++, made++) {
        // 名字形态照真实语料：长前缀大写名 + 约两成中文名
        const name = k % 5 === 0 ? `训练度${made}` : `M_KOJO_MESSAGE_COM_K${f}_${made}`;
        functions.push({
          name,
          normalizedName: name.toUpperCase(),
          params: [],
          startLine: k * 3 + 1,
          endLine: k * 3 + 2,
          filePath: path,
        });
      }
      files.set(path, {
        path,
        functions,
        dims: [],
        hasFunctionDirective: false,
        lineCount: functions.length * 3 + 1,
      });
      for (const fn of functions) {
        const list = byName.get(fn.normalizedName);
        if (list) list.push(fn);
        else byName.set(fn.normalizedName, [fn]);
      }
    }
    return { files, byName: functionLookupOf(byName) };
  }

  const BIG = bigIndex(99_104, 2_316);
  const nameCount = [...BIG.byName.values()].reduce((n, refs) => n + refs.length, 0);

  it('夹具规模 = 99,104 个函数 / 2,316 个文件（低于此规模则"实测"无意义）', () => {
    expect(nameCount).toBe(99_104);
    expect(BIG.files.size).toBe(2_316);
  });

  it('单次查询耗时可忽略（阈值放宽到慢机上也过得去，真实读数打日志）', () => {
    const cases: { query: string; note: string }[] = [
      { query: 'M_KOJO_MESSAGE_COM_K100_', note: '长前缀（一个包的档案）' },
      { query: '训练度', note: '中文档高频（约两成名字）' },
      { query: 'K4', note: '极短且命中面最大（子串满射）' },
    ];
    const measured: string[] = [];
    for (const c of cases) {
      // 预热一次（首跑含 JIT 与 Map 迭代器构造），随后 **3 次取中位**——单次读数不当数。
      // 跑数刻意只到 3：这些全量扫是 CPU 密集档，跑多了会把同批并行的
      // `completion-perf.test.ts` 那条 15ms 护栏挤到超时（同一台机器上实测过）。
      workspaceSymbolsInIndex(BIG, c.query);
      const total = workspaceSymbolsInIndex(BIG, c.query).totalMatched;
      const collected: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const hit = workspaceSymbolsInIndex(BIG, c.query);
        collected.push(performance.now() - t0);
        expect(hit.symbols.length).toBeLessThanOrEqual(DEFAULT_WORKSPACE_SYMBOL_LIMIT);
      }
      const median = collected.sort((a, b) => a - b)[1]!;
      measured.push(`${c.note}：中位 ${median.toFixed(2)}ms（命中总数 ${total}）`);
      expect(median).toBeLessThan(200);
    }
    // 读数进测试输出（验收要求"实测毫秒数"，不是形容词）
    console.info(`[D2 工作区符号实测] 规模 ${nameCount} 函数 / ${BIG.files.size} 文件 — ${measured.join(' | ')}`);
  });
});

/* ========================= 装配（槽注册 + 三态） ========================= */

const T = '/t';
const T1 = `${T}/Alpha.ERB`;
const T2 = `${T}/训练.ERB`;
const TEXTS: Record<string, string> = {
  [T1]: '@ALPHA(ARG)\n\tRETURN 1\n',
  [T2]: '@训练度检查\n\tRETURN 1\n',
};

function fakeIO(): FileIO {
  return {
    async readText(path: string) {
      const text = TEXTS[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    // 批量语义镜像内核 `FileIOService.readTexts`（读不到 = `null`，不抛）：
    // `buildIndex` 的读盘腿自 2026-10-16 批量 IO 批起走这一条，缺它整条索引建不起来
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = TEXTS[path];
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      });
    },
    async stat(path: string) {
      const text = TEXTS[path];
      return text === undefined ? null : { size: text.length, mtimeMs: null, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(TEXTS)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
}

/** 极小上下文体（与 `language-service.test.ts` 同做法：各文件自带夹具，避免并行改同一文件） */
function activate(): {
  services: Map<string, unknown>;
  /** 直接问那枚贡献（`kind` 由这里补上，调用方只给查询三件事） */
  workspaceSymbols: (q: { query: string; project: null; limit?: number }) => unknown;
} {
  const services = new Map<string, unknown>();
  const slots: Array<{ kind: string; contribution: Record<string, unknown> }> = [];
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: { on: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe, once: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe, emit: noop },
    inject: <T2I,>(key: string): T2I => {
      if (key === 'kernel.io') return fakeIO() as unknown as T2I;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T2I;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    slots: {
      register: (kind: string, contribution: Record<string, unknown>) => {
        slots.push({ kind, contribution });
        return noop;
      },
      query: () => [],
    },
    onDispose: (_fn: () => void) => undefined,
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  const hit = slots.find(
    (s) => s.kind === 'ui.editor.languageService' && s.contribution.id === 'erb-workspace-symbols',
  );
  if (!hit) throw new Error("ui.editor.languageService 'erb-workspace-symbols' 未注册");
  const provide = hit.contribution.provide as (request: unknown) => unknown;
  return {
    services,
    workspaceSymbols: (q) => provide({ ...q, kind: 'workspaceSymbol' }),
  };
}

describe('erb-workspace-symbols · 装配与三态', () => {
  it('索引尚未构建（未开项目）→ undefined：**不答**，而不是答"没有这个名字"', () => {
    const { workspaceSymbols } = activate();
    expect(workspaceSymbols({ query: 'ALPHA', project: null })).toBeUndefined();
  });

  it('建好索引后应答：中文名与原生大写名都查得到，`totalMatched` 随结果给出', async () => {
    const { services, workspaceSymbols } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex([T]);

    const hit = workspaceSymbols({ query: 'alpha', project: null, limit: 10 }) as {
      kind: string;
      symbols: { name: string; filePath: string; line: number; kind: string }[];
      totalMatched: number;
    };
    expect(hit.kind).toBe('workspaceSymbol');
    expect(hit.symbols.map((s) => [s.name, s.filePath, s.line])).toEqual([['ALPHA', T1, 1]]);
    expect(hit.totalMatched).toBe(1);

    const zh = workspaceSymbols({ query: '训练', project: null }) as { symbols: { name: string }[] };
    expect(zh.symbols.map((s) => s.name)).toEqual(['训练度检查']);

    // 认得这个查询但确实没人叫这个名 → 空数组（不猜）
    const none = workspaceSymbols({ query: '根本不存在的名', project: null }) as { symbols: unknown[] };
    expect(none.symbols).toEqual([]);
  });
});
