/**
 * 启动面 · **懒装载判据**（ADAPTER-LAZY 批，2026-10-26）。
 *
 * 开工背景：`eratw-adapter` 是两个 eager 插件之一，`plugin.ts` 曾静态挂 `GameAdapter.launch`
 * ⇒ 整份 `launch.ts`（28.8 KB）随适配器进开机图（PS-10 读数 195 文件 / 2,899 KB）。
 * 本批把**同步声明**搬进已在图里的 `constants.ts`、把 `probe` / `buildProfile` 留懒边。
 *
 * 四条判据（缺一条这批就是"看着瘦了、其实坏了"）：
 * 1. **同步字段未装载即可读**，且逐字段与改前一致（`saveLayout` / `contentRoots` /
 *    `defaultEncoding` 用字面量钉住，`logRules` 用真日志原句钉住）——实例库 / 存档页 / 日志
 *    解析开机就要它们，绝不能等 `import()`；
 * 2. **懒实现只装载 / 只实例化一次**：`probe` 两次 + `buildProfile` 一次 ⇒ 工厂只建一次
 *    （`vi.mock` 包一层计数器，底下仍是**真实现**，断言的是"缓存生效"而不是替身行为）；
 * 3. **首次调用后结果仍然正确**：真实现穿过懒边，候选 / cwd / argv / 存档根 / 内容根照旧；
 * 4. **反向闸**：`src/**` 里任何 eager 文件都不许静态 import `./launch`（只许 `import()`），
 *    防止下一批把它"顺手写回去"——读数据闸（ps10）要等比体积涨完才响，这条在涨之前就红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type {
  DirEntry,
  FileIO,
  GameAdapter,
  GameAdapterContribution,
  GameLaunchAdapter,
  Logger,
  LogParseRules,
  PluginContext,
} from '@kojo/plugin-api';

/* `vi.mock` 的工厂在模块求值时就跑 ⇒ 计数器必须提升（否则工厂里读到未初始化的绑定） */
const { createCalls } = vi.hoisted(() => ({ createCalls: [] as number[] }));

vi.mock('../src/launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/launch')>();
  return {
    ...actual,
    /** 计数外壳：底下调**真工厂**（真实现、真行为），只额外记下"建了几次" */
    createEratwLaunchAdapter: (...args: Parameters<typeof actual.createEratwLaunchAdapter>) => {
      createCalls.push(args.length);
      return actual.createEratwLaunchAdapter(...args);
    },
  };
});

import { LAUNCH_CONTENT_ROOTS, LAUNCH_DEFAULT_ENCODING, LAUNCH_LOG_RULES, LAUNCH_SAVE_LAYOUT } from '../src/constants';
import { createEratwAdapterPlugin } from '../src/plugin';

/* ------------------------------- 测试地面 ------------------------------- */

const ROOT = '/game';
const MEASURED_X64 = 'Emuera_LazyLoadingV3.0_x64.exe';
/** 带齐 ERB/ CSV/ resources/ sav/ 的"完整盘" */
const DIRS = ['ERB', 'CSV', 'resources', 'sav'] as const;

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 最小假 io：列举只认根层，存在性按名单（`probe` / `buildProfile` 只用 `listDir` + `exists`） */
function fakeIO(): FileIO {
  return {
    async listDir(dirPath: string): Promise<DirEntry[]> {
      if (dirPath !== ROOT) return [];
      return [
        ...DIRS.map((name) => ({ name, path: `${ROOT}/${name}`, isDirectory: true })),
        { name: MEASURED_X64, path: `${ROOT}/${MEASURED_X64}`, isDirectory: false },
      ];
    },
    async exists(target: string): Promise<boolean> {
      const rel = target.startsWith(`${ROOT}/`) ? target.slice(ROOT.length + 1) : '';
      return (DIRS as readonly string[]).includes(rel) || rel === MEASURED_X64;
    },
    async readText(): Promise<never> {
      throw new Error('本测试不读文件');
    },
    async readTexts(): Promise<never> {
      throw new Error('本测试不读文件');
    },
  } as unknown as FileIO;
}

/** 按 `plugin.test.ts` 同一套最小 ctx 激活插件，取 `game.adapter` 槽里那枚 adapter */
function activate(io: FileIO): GameAdapter {
  const registrations: GameAdapterContribution[] = [];
  const ctx = {
    pluginId: 'eratw-adapter',
    log: silentLog,
    bus: { emit: () => {}, on: () => () => {} },
    onDispose: () => {},
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') {
        return { list: async () => [], projectDir: (id: string) => `/ws/${id}` } as unknown as T;
      }
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: GameAdapterContribution) => {
        if (slot === 'game.adapter') registrations.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return registrations[0]!.adapter;
}

function launchOf(io: FileIO = fakeIO()): GameLaunchAdapter {
  const launch = activate(io).launch;
  if (launch === undefined) throw new Error('适配器没有挂 launch（本批判据前提）');
  return launch;
}

/* ═══════════════════════ 1. 同步字段：未装载就可读，且与改前一致 ═══════════════════════ */

describe('同步声明面：懒实现尚未装载时就可读，逐字段与改前相同', () => {
  it('激活后一回都没有建过实现，但四个同步字段全在', () => {
    const callsBefore = createCalls.length;
    const launch = launchOf();
    // 关键断言：读同步字段 ≠ 触发装载（否则"开机可读"是假的）
    expect(createCalls.length).toBe(callsBefore);
    expect(launch.saveLayout).toBeDefined();
    expect(launch.contentRoots).toBeDefined();
    expect(launch.logRules).toBeDefined();
    expect(launch.defaultEncoding).toBeDefined();
  });

  it('saveLayout / contentRoots / defaultEncoding 与改前逐字段相同（字面量钉住，不看常量）', () => {
    const launch = launchOf();
    expect(launch.saveLayout).toEqual({
      roots: [
        {
          id: 'sav',
          label: '存档（sav/）',
          relativePath: 'sav',
          format: 'emuera-sav',
          writableInShared: false,
        },
      ],
      listRule: { extensions: ['.sav'], labelFromFileName: true },
    });
    expect(launch.contentRoots).toEqual([
      { id: 'erb', label: 'ERB 脚本', relativePath: 'ERB', kind: 'script', accepts: ['script'], writableInShared: true },
      { id: 'csv', label: 'CSV 数据表', relativePath: 'CSV', kind: 'data', accepts: ['data'], writableInShared: false },
      {
        id: 'resources',
        label: 'resources 素材',
        relativePath: 'resources',
        kind: 'resource',
        accepts: ['resource'],
        writableInShared: false,
      },
    ]);
    expect(launch.defaultEncoding).toEqual({ mode: 'auto', fallback: 'utf-8' });
    // 单源：适配器给的就是常量表那一份（不是就地又抄了一遍字面量）
    expect(launch.saveLayout).toBe(LAUNCH_SAVE_LAYOUT);
    expect(launch.contentRoots).toBe(LAUNCH_CONTENT_ROOTS);
    expect(launch.defaultEncoding).toBe(LAUNCH_DEFAULT_ENCODING);
  });

  it('logRules 未装载就可解析真盘原句（三条定位行 + 错误/噪声判据）', () => {
    const launch = launchOf();
    expect(launch.logRules).toBe(LAUNCH_LOG_RULES);
    const rules = launch.logRules as Required<LogParseRules>;
    expect(rules.parseLocation('MOVEMENTS\\物件関連\\COMMON2.ERB在30行错误发生在:Emuera.NET')).toEqual({
      relativePath: 'MOVEMENTS/物件関連/COMMON2.ERB',
      line: 30,
    });
    expect(rules.parseLocation('函数: @GET_MAPID（MOVEMENTS\\物件関連\\COMMON2.ERB的26行）')).toEqual({
      relativePath: 'MOVEMENTS/物件関連/COMMON2.ERB',
      line: 26,
    });
    // 绝对路径不回显；错误行 / 噪声行的口径照旧
    expect(rules.parseLocation('C:\\game\\ERB\\SYSTEM.ERB在12行')).toBeNull();
    expect(rules.isErrorLine('错误内容:可能进入了无限循环因此选择强制终止')).toBe(true);
    expect(rules.isErrorLine('★基本标志未设定（警告）')).toBe(false);
    expect(rules.isNoiseLine("<shape type='space' param='100'>")).toBe(true);
    expect(rules.isNoiseLine('要变成谁呢？')).toBe(false);
  });
});

/* ═══════════════════════ 2/3. 懒边：只装载一次，结果照旧 ═══════════════════════ */

describe('probe / buildProfile：实现经懒边装载，一次装载多次复用', () => {
  it('首次调用装载并实例化一次；第二次 probe 与 buildProfile 都不再建', async () => {
    const launch = launchOf();
    const before = createCalls.length;
    expect(createCalls.length).toBe(before); // 读同步字段与激活都没动过懒边

    await launch.probe(ROOT);
    expect(createCalls.length).toBe(before + 1);
    await launch.probe(ROOT);
    await launch.buildProfile(ROOT, 'eratw-lazyloading-x64');
    // 一次 import ⇒ 一次建实例：缓存失效会让这里变成 3
    expect(createCalls.length).toBe(before + 1);
  });

  it('首次调用后结果仍然正确（候选 / cwd / argv / 存档根 / 内容根与改前一致）', async () => {
    const launch = launchOf();
    const candidates = await launch.probe(ROOT);
    expect(candidates.map((candidate) => [candidate.id, candidate.executableRelativePath])).toEqual([
      ['eratw-lazyloading-x64', MEASURED_X64],
    ]);

    const profile = await launch.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(profile.candidateId).toBe('eratw-lazyloading-x64');
    expect(profile.executable.relativePath).toBe(MEASURED_X64);
    expect(profile.cwdRelative).toBe('.');
    expect(profile.executable.args).toEqual([]);
    expect(profile.saveRoots.map((root) => root.relativePath)).toEqual(['sav']);
    expect(profile.contentRoots.map((root) => root.relativePath)).toEqual(['ERB', 'CSV', 'resources']);
    // 与同步声明面同一份常量（不是懒实现里另抄了一份）
    expect(profile.contentRoots).toEqual([...LAUNCH_CONTENT_ROOTS]);
    // 用户选项整份覆盖照旧生效
    const overridden = await launch.buildProfile(ROOT, 'eratw-lazyloading-x64', {
      encoding: { mode: 'fixed', fallback: 'shift_jis' },
    });
    expect(overridden.encoding).toEqual({ mode: 'fixed', fallback: 'shift_jis' });
  });
});

/* ═══════════════════════════════ 4. 反向闸 ═══════════════════════════════ */

describe('反向闸：eager 文件不许静态 import `./launch`（只许 import()）', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

  const STATIC_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

  /** 具名导入里是否含"有值"绑定（`import type` / `{ type X }` 会被擦除，允许） */
  function hasValueBinding(clause: string): boolean {
    return clause.split(',').some((part) => part.trim() !== '' && !/^\s*type\b/.test(part.trim()));
  }

  function sourcesOf(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) out.push(...sourcesOf(abs));
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(abs);
    }
    return out;
  }

  it('`src/**`（除 launch.ts 自己）零静态值引用；桶 index.ts 只留 type 面', () => {
    const offenders: string[] = [];
    for (const abs of sourcesOf(srcDir)) {
      if (path.basename(abs) === 'launch.ts') continue;
      const src = readFileSync(abs, 'utf8');
      const specs = new Set<string>();
      for (const m of src.matchAll(STATIC_FROM_RE)) if (hasValueBinding(m[1]!)) specs.add(m[2]!);
      for (const m of src.matchAll(BARE_IMPORT_RE)) specs.add(m[1]!);
      for (const spec of specs) if (/(^|\/)launch(\.js)?$/.test(spec)) offenders.push(`${path.basename(abs)} → ${spec}`);
    }
    expect(offenders).toEqual([]);

    // 桶：只许 type 面转出（`export type { … } from './launch'` 会被擦除、不进图）
    const barrel = readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/(?:^|\n)\s*export\s+\{[^}]*\}\s*from\s*'\.\/launch'/);
    expect(barrel).toContain(`export type { EratwLaunchDeps } from './launch'`);
  });

  it('反空匹配自证：plugin.ts 里懒边确实在（没有它，上面那条零命中只能证明"功能被删了"）', () => {
    const plugin = readFileSync(path.join(srcDir, 'plugin.ts'), 'utf8');
    expect(plugin).toContain(`import('./launch')`);
    expect(plugin).toContain('createLazyLaunchFace');
  });
});
