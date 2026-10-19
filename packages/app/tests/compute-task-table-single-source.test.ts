import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComputeTaskTable, ConditionExtractorService, ErbParserService, Logger } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '@kojo/kernel';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin, erbParserTasks, scanControlFlow } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConditionExtractorPlugin, conditionExtractorTasks } from '@kojo/plugin-condition-extractor';
import { computeTasks, hasWorkerTask } from '../src/compute-tasks';

/**
 * 装配层任务表单源闸（#23，2026-10-20）。
 *
 * ## 为什么存在
 *
 * "传数据不传函数"要求两侧各持一张 `kind → 实现` 映射，而本仓的**唯一判据**是装配层那张：
 * `app/src/compute-tasks.ts` 逐项并入插件导出的任务表，`hasWorkerTask(kind)` 决定装饰器走真
 * worker 还是异步就地，`bootstrap.ts` 按同一张表 `registerTask`，`compute-worker.ts` 把同一张表
 * 交给 worker。**但这张表历来只被手写清单逐处抄一遍**（`integration-plugins.test.ts` /
 * `fixtures-mini.test.ts` / `jump-to-state.corpus.test.ts` / `marker-hotpath.test.ts` 各自再拼一次
 * 插件表），所以"插件加了任务表 / 装饰器声明了没人实现的 kind / 装配表漏拼一项"没有任何门禁会红。
 *
 * 2026-10-20 的 `ca721a0` 就是这类漂移的现案：PS-11 把单文件抽取整链搬进跨插件合成任务
 * `condition.extractFile` 之后，语料测试那条装配块没有并入任务表 ⇒ 逐文件抛
 * "No local implementation registered"、条件索引**整片归零**（分母 0），靠人工二分四个提交才定位。
 * 修法是测试内补注册 + 一条归因断言，**但那条断言只在语料在位时才跑**（`describe.skipIf(!SMOKE)`），
 * 无语料的机器上这条漂移依旧无人看守。本闸把那次二分变成机器判据，且用语料无关的
 * `fixtures/mini-game/` 跑同一条因果链。
 *
 * ## 四条独立可证的判据
 *
 * 1. **①** 插件导出的任务表必须被装配表并入（源形状扫 + 运行时 key 集合对撞）；
 * 2. **②** 装饰器声明的 `offloadKind` 要么在装配表里有人实现，要么进**钉死处数的就地豁免表**；
 * 3. **③** 生产接线两侧不许换表（`bootstrap` 按 `computeTasks` 注册、worker 入口交 `computeTasks`、
 *    宿主派发判据即 `hasWorkerTask`）；
 * 4. **④** 消费者侧不静默：装配表里少一个 kind ⇒ 抽取整片为空**且必须留下报告**（A/B 双内核）。
 *
 * 手法照 `kojo-extension-single-source.test.ts` / `boot-sweep-single-source.test.ts`：
 * `readFileSync` 扫**源码形状**，豁免做成"多一处少一处都红"的账目项。
 * 两处口径分工：**禁止形态**连注释一起查（抄判据的第一站就是注释），
 * **正向接线**（"这行必须在"）只看代码行——否则把 `bootstrap` 那行注释掉，
 * 注释里残留的字样还能替它交差（见 `codeLines`）。
 * 依赖方向 `app → kernel/plugins` ⇒ 本闸住 `packages/app/tests/`（内核测试不许 import app）。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** 扫某目录下的 .ts/.tsx 源文件（相对仓库根，斜杠分隔） */
function sourceFiles(dirRel: string): string[] {
  const walk = (rel: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(child));
      else if (/\.tsx?$/.test(e.name)) out.push(child);
    }
    return out;
  };
  return walk(dirRel);
}

const PLUGIN_SRCS = (): string[] => sourceFiles('packages/plugins').filter((rel) => rel.includes('/src/'));

/**
 * 摘掉注释行（口径照 `audit-decoupling.mjs` 的 `isCommentLine`）：正向判据只认代码行，
 * 注释里的字样不能替一处真接线交差（文件头注有理由）。
 */
function codeLines(rel: string): string {
  return read(rel)
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('///') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}

/** 插件导出任务表的形状标注（装配层与 worker 两侧共用的那张表的类型记号） */
const TABLE_ANNOTATION = /:\s*ComputeTaskTable\b/;
/** 所属 export 行：常量表 / 造表器（标注行往上找最近的一条，跨过参数续行） */
const EXPORT_HEAD = /^export (const|function) (\w+)\b/;

/**
 * 账目项①：插件侧导出的可搬运任务表（文件 + 符号 + 造表形态），**一处不多一处不少**。
 * 新增一张表（或删一张）⇒ 这里必须同步登记，同时装配层必须并入它，否则下面两条分别红。
 */
const PLUGIN_TASK_TABLES: ReadonlyArray<{
  readonly file: string;
  readonly symbol: string;
  readonly shape: 'const' | 'factory';
}> = [
  { file: 'packages/plugins/condition-extractor/src/offload.ts', symbol: 'conditionExtractorTasks', shape: 'factory' },
  { file: 'packages/plugins/erb-parser/src/offload.ts', symbol: 'erbParserTasks', shape: 'const' },
];

/**
 * 账目项②：符号 → 运行时那张表（②把源扫到的表与运行时真表绑在一起，
 * 只在源里挂名、运行时取不到表的符号 = 红）。`conditionExtractorTasks` 是造表器，
 * 这里就用装配层同一个扫描器实参把它填上——填不出表 = 装配层也填不出。
 */
const RUNTIME_TABLES: Readonly<Record<string, () => ComputeTaskTable>> = {
  erbParserTasks: () => erbParserTasks,
  conditionExtractorTasks: () => conditionExtractorTasks(scanControlFlow),
};

/** 源扫到的任务表导出（文件 + 符号 + 形态）：按 `: ComputeTaskTable` 标注行往上找所属 export */
function discoveredTaskTables(): { file: string; symbol: string; shape: 'const' | 'factory' }[] {
  const out: { file: string; symbol: string; shape: 'const' | 'factory' }[] = [];
  for (const rel of PLUGIN_SRCS()) {
    const lines = read(rel).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!TABLE_ANNOTATION.test(line)) return;
      let head: { keyword: string; name: string } | null = null;
      for (let j = i; j >= Math.max(0, i - 20) && !head; j--) {
        const m = EXPORT_HEAD.exec(lines[j]!);
        if (m) head = { keyword: m[1]!, name: m[2]! };
      }
      if (!head) {
        throw new Error(`${rel}:${i + 1} 有 ': ComputeTaskTable' 标注，但 20 行内找不到所属 export（闸自己塌了）`);
      }
      out.push({ file: rel, symbol: head.name, shape: head.keyword === 'const' ? 'const' : 'factory' });
    });
  }
  return out.sort((a, b) => `${a.file}#${a.symbol}`.localeCompare(`${b.file}#${b.symbol}`));
}

/** `export const NAME = '字面量'` 全表：用来把装饰器 `offloadKind` 的符号解成 kind 字符串 */
function constLiteralsIn(rel: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of read(rel).matchAll(/^export const (\w+)\s*=\s*'([^']+)'/gm)) out.set(m[1]!, m[2]!);
  return out;
}

/** 所有插件源里的字符串常量（kind 常量通常与任务表同文件，跨文件也要能解） */
function pluginKindLiterals(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of PLUGIN_SRCS()) for (const [k, v] of constLiteralsIn(rel)) if (!out.has(k)) out.set(k, v);
  return out;
}

/** 装饰器贡献里声明的 `offloadKind:` 现场（文件 + 行 + 解出的 kind） */
function offloadKindSites(): { file: string; line: number; kind: string }[] {
  const literals = pluginKindLiterals();
  const sites: { file: string; line: number; kind: string }[] = [];
  for (const rel of PLUGIN_SRCS()) {
    read(rel)
      .split(/\r?\n/)
      .forEach((text, i) => {
        const t = text.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // 文档行里的 `offloadKind:` 不是现场
        const m = /^\s*offloadKind:\s*(.+)$/.exec(text);
        if (!m) return;
        // 行尾注释与尾逗号都要摘掉（`offloadKind: X, // 就地理由` 是这里的常态写法）
        const raw = m[1]!.replace(/\/\/.*$/, '').replace(/,\s*$/, '').trim();
        const inline = /^'([^']+)'$/.exec(raw);
        if (inline) {
          sites.push({ file: rel, line: i + 1, kind: inline[1]! });
          return;
        }
        if (!/^\w+$/.test(raw)) {
          throw new Error(`${rel}:${i + 1} 的 offloadKind 取值 ${raw} 解不出 kind（闸自己塌了）`);
        }
        const kind = literals.get(raw);
        if (kind === undefined) {
          throw new Error(`${rel}:${i + 1} 的 offloadKind 符号 ${raw} 没有 'export const ${raw} = "..."' 字面量可解`);
        }
        sites.push({ file: rel, line: i + 1, kind });
      });
  }
  return sites.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
}

/**
 * 账目项③：**刻意只就地执行**的 `offloadKind`（文件 + kind + 处数逐字钉死，多一处少一处都红）。
 * 这些 kind 天生搬不进 worker（实现要吃插件内注入的项目服务），所以"不在装配表"是**决定**而不是漂移；
 * 决定要留名，改动要过账。
 */
const SYNC_ONLY_DECORATOR_OFFLOADS: ReadonlyArray<{
  readonly file: string;
  readonly kind: string;
  readonly count: number;
  readonly why: string;
}> = [
  {
    file: 'packages/plugins/ui-sugar-editor/src/index.ts',
    kind: 'sugar.diagnostics',
    count: 1,
    why: '转译器要吃项目内注入的适配器表，worker 复现不了 ⇒ 只请出同步轮、异步就地',
  },
];

const isSyncOnlyExempt = (file: string, kind: string): boolean =>
  SYNC_ONLY_DECORATOR_OFFLOADS.some((e) => e.file === file && e.kind === kind);

/* ─────────────────────────── ① 插件任务表必须被装配表并入 ─────────────────────────── */

describe('① 插件导出的任务表 = 装配表的并集（源形状 + 运行时对撞）', () => {
  it('插件侧任务表清单钉死（文件 + 符号 + 形态）：新增一张、少一张、形态变了都红', () => {
    expect(discoveredTaskTables()).toEqual(PLUGIN_TASK_TABLES);
  });

  it('每张登记在册的表都取得到运行时真身（只在源里挂名不算数）', () => {
    for (const t of PLUGIN_TASK_TABLES) {
      const take = RUNTIME_TABLES[t.symbol];
      expect(typeof take, `${t.symbol} 没有登记运行时取表函数`).toBe('function');
      expect(Object.keys(take!()).length, `${t.symbol} 的表是空壳`).toBeGreaterThan(0);
    }
    expect(Object.keys(RUNTIME_TABLES).sort()).toEqual(PLUGIN_TASK_TABLES.map((t) => t.symbol).sort());
  });

  it('装配层源码逐项并入每张表（注释掉 `...erbParserTasks` 之类即红）', () => {
    const text = read('packages/app/src/compute-tasks.ts');
    for (const t of PLUGIN_TASK_TABLES) {
      const splice = new RegExp(`^\\s*\\.\\.\\.${t.symbol}\\b`, 'm');
      expect(splice.test(text), `compute-tasks.ts 里没有并入 ${t.symbol}（表 ${t.file}）`).toBe(true);
    }
  });

  it('装配表的 key 集合 == 各插件表 key 的并集（插件加一条装配漏一条、装配凭空多一条，都红）', () => {
    const fromPlugins = new Set<string>();
    for (const t of PLUGIN_TASK_TABLES) for (const kind of Object.keys(RUNTIME_TABLES[t.symbol]!())) fromPlugins.add(kind);
    expect(Object.keys(computeTasks).sort()).toEqual([...fromPlugins].sort());
  });

  it('装配表里每条实现都是可调用函数（并入时被覆盖成 undefined 也算漂移）', () => {
    for (const [kind, impl] of Object.entries(computeTasks)) {
      expect(typeof impl, `kind ${kind} 的实现不是函数`).toBe('function');
    }
  });
});

/* ─────────────────────────── ② 装饰器 offloadKind 要么有实现要么有账 ─────────────────────────── */

describe('② `ui.editor.decorator` 声明的 offloadKind：装配表里有实现，否则须进钉死的就地豁免账', () => {
  it('offloadKind 声明现场总数钉死（账目项；新增装饰器搬运 = 红，逼一次显式记账）', () => {
    // 现值 3：进表的两条 = `erb.structureDecorations`（erb-parser/src/plugin.ts:872）与
    // `erb.exprSyntaxDecorations`（condition-extractor/src/index.ts:191）；就地豁免账里那条 =
    // `sugar.diagnostics`（ui-sugar-editor/src/index.ts:198）。
    // 抬账口径：新增一处搬运 = 这一条红，红的是账不是码——改数字、附一句为什么，正是本仓账目项的用法。
    expect(offloadKindSites()).toHaveLength(3);
  });

  it('每一处声明的 kind 都能被 `hasWorkerTask` 判出来：在表里，或在豁免账里点名到文件', () => {
    const offenders = offloadKindSites()
      .filter(({ file, kind }) => !hasWorkerTask(kind) && !isSyncOnlyExempt(file, kind))
      .map(({ file, line, kind }) => `${file}:${line} 声明 offloadKind '${kind}'：装配表里没人实现，也不在就地豁免账里`);
    expect(offenders).toEqual([]);
  });

  it('豁免账自身：文件 + kind + 处数逐字对账，多一处少一处都红', () => {
    const sites = offloadKindSites();
    for (const e of SYNC_ONLY_DECORATOR_OFFLOADS) {
      const n = sites.filter((s) => s.file === e.file && s.kind === e.kind).length;
      expect(n, `${e.file} 里 kind '${e.kind}' 的就地豁免处数（${e.why}）`).toBe(e.count);
    }
    // 反向：豁免账不许变成僵尸（那条 kind 哪天真的进了装配表，就地豁免就该删账）
    for (const e of SYNC_ONLY_DECORATOR_OFFLOADS) {
      expect(hasWorkerTask(e.kind), `'${e.kind}' 已在装配表里 ⇒ 豁免账 ${e.file} 该行须删`).toBe(false);
    }
  });
});

/* ─────────────────────────── ③ 生产接线两侧不许换表 ─────────────────────────── */

describe('③ 两侧共用同一张表：宿主 registerTask / worker 入口 / 装饰派发判据', () => {
  it('bootstrap 按 `computeTasks` 全量 registerTask（换成手写清单 / 整行注释掉 = 红）', () => {
    const text = codeLines('packages/app/src/bootstrap.ts');
    expect(text).toMatch(/import \{ computeTasks \} from '\.\/compute-tasks'/);
    expect(text).toMatch(
      /^\s*for \(const \[kind, impl\] of Object\.entries\(computeTasks\)\)\s*kernel\.compute\.registerTask\(kind, impl/m,
    );
  });

  it('worker 入口把 `computeTasks` 交给协议处理器（worker 侧另立表 = 红）', () => {
    expect(codeLines('packages/app/src/compute-worker.ts')).toMatch(
      /import \{ computeTasks \} from '\.\/compute-tasks'/,
    );
    expect(codeLines('packages/app/src/compute-worker.ts')).toMatch(/void handleComputeRequest\(computeTasks,/);
  });

  it('宿主派发装饰的唯一判据就是装配表函数 `hasWorkerTask`（不许自己另猜）', () => {
    const text = codeLines('packages/app/src/ui/EditorPane.tsx');
    expect(text).toMatch(/import \{ hasWorkerTask \} from '\.\.\/compute-tasks'/);
    expect(text).toMatch(/^\s*workerHasTask: hasWorkerTask,$/m);
  });
});

/* ─────────────────────────── ④ 消费者侧：缺一个 kind 不许静默 ─────────────────────────── */

/** 与 `fixtures-mini.test.ts` 同一条目录口径（**带目录分隔符结尾**，walkDir 认的是目录） */
const MINI_DIR = path.join(ROOT, 'fixtures', 'mini-game') + path.sep;

/**
 * 用装配表开一台与生产同形的裸内核，返回条件索引 + 捕获到的 warn 文本。
 *
 * @param table 实际注册进计算池的任务表（④的 A/B 只差这一参数）
 */
async function extractWithTable(table: ComputeTaskTable): Promise<{ predicates: number; warns: string[] }> {
  const warns: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => void warns.push(message),
    error: (message: string) => void warns.push(message),
  };
  const kernel: Kernel = await createKernel({
    platform: new NodeBridge(mkdtempSync(path.join(tmpdir(), 'kojo-ctts-'))),
    plugins: [createErbParserPlugin(), createEratwAdapterPlugin(), createConditionExtractorPlugin()],
    storageBackend: new MemoryStorageBackend(),
    logger,
  });
  for (const [kind, impl] of Object.entries(table)) kernel.compute.registerTask(kind, impl as never);
  await kernel.start();
  try {
    await kernel.project.open(MINI_DIR);
    // 级联顺序与生产一致（`cascade-watermarks.ts`： erb 索引先 ready，条件索引才吃得到函数清单）
    await kernel.services.get<ErbParserService>('erb.parser').ensureIndex();
    const extractor = kernel.services.get<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
    const index = await extractor.ensureIndex();
    return { predicates: index.stats.predicates, warns };
  } finally {
    await kernel.stop();
  }
}

describe.skipIf(!existsSync(MINI_DIR))(
  '④ 消费者侧不静默：装配表少一个 kind ⇒ 抽取为空且必须留下报告（ca721a0 形态）',
  () => {
    it('注册装配表 ⇒ 条件索引非空（这条非空**就是**因为 `condition.extractFile` 有本地实现）', async () => {
      const { predicates, warns } = await extractWithTable(computeTasks);
      expect(
        predicates,
        'mini 语料条件索引谓词数为 0：装配表注册了却没抽出来 ⇒ 与 ca721a0 同形态，先查 `condition.extractFile` 是否还在表里',
      ).toBeGreaterThan(0);
      expect(
        warns.filter((w) => w.includes('No local implementation registered')),
        '注册了装配表却仍有 kind 找不到本地实现（装配表覆盖不全）',
      ).toEqual([]);
    }, 60_000);

    it('从装配表里抽掉 `condition.extractFile` ⇒ 索引归零，且报告里点名那个 kind（不静默）', async () => {
      const minusOne: ComputeTaskTable = Object.fromEntries(
        Object.entries(computeTasks).filter(([kind]) => kind !== 'condition.extractFile'),
      ) as ComputeTaskTable;
      expect(Object.keys(minusOne).length, '装配表里本来就没有 condition.extractFile？').toBe(
        Object.keys(computeTasks).length - 1,
      );
      const { predicates, warns } = await extractWithTable(minusOne);
      expect(predicates, '抽掉任务还能抽出谓词 ⇒ 本闸的因果链不成立（抽取其实不依赖装配表）').toBe(0);
      expect(
        warns.some((w) => w.includes("No local implementation registered for compute task 'condition.extractFile'")),
        '缺注册却没有任何 warn：消费者答了"什么都没找到"而不说原因 ⇒ 违反铁律 4「内核不静默」',
      ).toBe(true);
    }, 60_000);
  },
);
