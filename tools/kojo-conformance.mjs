#!/usr/bin/env node
/**
 * kojo-conformance 的仓库内运行外壳（开发期）。
 *
 * 为什么不是直接 `node packages/kojo-conformance/src/main.ts`：
 * 仓库没有 TS 构建步骤、也没有装 tsx；包的 TS 内部 import 用 `.js` 说明符
 * （Node 类型剥离不做 `.js`→`.ts` 解析）。本文件因此用仓库**已有**的 Vite
 * （root devDependency）以 SSR 方式加载 TS 真入口——语义等价于 `tsx src/main.ts`，
 * 不新增依赖、不落构建产物。
 *
 * 分工：
 * - 真 IO / argv / `process.exitCode` 全在 `packages/kojo-conformance/src/main.ts`；
 * - 本文件只做转发：起 Vite → 加载 main.ts → 关 Vite → 调 `main(process.argv.slice(2))`。
 * - **`migrate-diff` 子命令**（K2-MIGRATION-DIFFERENTIAL）多一步接线：判定逻辑全在
 *   `packages/kojo-conformance/src/migration.ts`（纯逻辑、可注入 IO），本文件只负责把
 *   **三条真入口**装进去——v1 侧 = kojo-sugar 真转译服务（表与 golden 测试同源）、
 *   2.0 侧 = 真 core + 真 eraTW backend、迁移 = core 语义层。换 adapter / 换语料只需换
 *   这里的注入，不改判定。
 * - **`language` 子命令**（K2-LANG-CONFORMANCE）同理：套件与判定全在 `src/language.ts`
 *   （纯逻辑、IO 注入）；本文件只把 fixture 与真 eraTW adapter/backend 装进注册表
 *   （`--adapter fixture|eratw`），换 adapter 不改判定。
 * - **`corpus` 子命令**（K2-CORPUS-REAL）同样薄：发现 / 状态聚合 / 抽样 / manifest 全在
 *   `src/corpus.ts`；本文件只负责三件事——①把 `tools/corpus.mjs` 的真实解析链装成
 *   `resolveRoot`（缺席 = SKIP，不猜目录名）；②三条真入口与迁移植入同一批注入；
 *   ③`node:crypto` 的 sha256 与字节读写。`--generate-manifest` 的落点固定为仓内
 *   真实语料 fixture 目录，本文件不给"任意落点"参数。
 *
 * 用法（与 bin 一致）：
 *   node tools/kojo-conformance.mjs list-cases
 *   node tools/kojo-conformance.mjs check --adapter fixture --dir packages/kojo-conformance/tests/fixtures
 *   node tools/kojo-conformance.mjs check --golden <源.kojo2>:<产物.erb> --json
 *   node tools/kojo-conformance.mjs language --json
 *   node tools/kojo-conformance.mjs language --adapter eratw --json
 *   node tools/kojo-conformance.mjs migrate-diff --dir packages/kojo-core/tests/fixtures/migrate-corpus
 *   node tools/kojo-conformance.mjs migrate-diff --dir <语料机目录> --json
 *   node tools/kojo-conformance.mjs corpus --json
 *   node tools/kojo-conformance.mjs corpus --dir <语料根> --limit 200 --json
 *   node tools/kojo-conformance.mjs corpus --generate-manifest
 * 退出码：透传 main.ts / migration.ts / corpus.ts 的 0 / 1 / 2；启动失败 = 1。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createServer } from 'vite';

import { CorpusError, corpusHint, resolveCorpusDir } from './corpus.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = '/packages/kojo-conformance/src/main.ts';
const START_ATTEMPTS = 2;
const MIGRATE_COMMAND = 'migrate-diff';
const LANGUAGE_COMMAND = 'language';
const CORPUS_COMMAND = 'corpus';

/** migrate-diff 需要额外加载的 TS 入口（真 core / 真 v1 转译 / 真 adapter backend / 判定逻辑） */
const MIGRATE_ENTRIES = {
  migration: '/packages/kojo-conformance/src/migration.ts',
  core: '/packages/kojo-core/src/index.ts',
  sugar: '/packages/plugins/kojo-sugar/src/service.ts',
  support: '/packages/plugins/kojo-sugar/tests/support.ts',
  eratw: '/packages/plugins/eratw-adapter/src/kojo2/index.ts',
};

/** corpus 子命令的额外入口（与 migrate-diff 同一批真链路；判定/发现全在 corpus.ts） */
const CORPUS_ENTRIES = {
  corpus: '/packages/kojo-conformance/src/corpus.ts',
  core: '/packages/kojo-core/src/index.ts',
  sugar: '/packages/plugins/kojo-sugar/src/service.ts',
  support: '/packages/plugins/kojo-sugar/tests/support.ts',
  eratw: '/packages/plugins/eratw-adapter/src/kojo2/index.ts',
};

/**
 * 缺席快路唯一的入口：`corpus-skip.ts` 是**零运行时依赖**的叶子（`import type` 被转译层擦掉），
 * 缺席报告的两个纯函数（`skipReport` / `renderCorpusSkipText`）就住在那里——文本仍只有一处实现，
 * `corpus.ts` 的缺席分支调的也是它。
 *
 * 为什么不直接载 `corpus.ts`：它静态 import `./migration.js`，后者吃 `@kojo/kojo-core` 的桶入口；
 * 本机逐枚计时＝桶单体 SSR 冷载 **63.6s**（叶子 `migrate/indent.ts` 2.5s），载完整条缺席路径空闲
 * 38.0s、在全量池里能顶穿用例自己的 240s 预算（读数退化成 `status:null`）。见 PITFALLS 187。
 */
const CORPUS_ABSENT_ENTRIES = {
  skip: '/packages/kojo-conformance/src/corpus-skip.ts',
};

/** language 子命令的固定入口（套件纯逻辑） */
const LANGUAGE_SUITE_ENTRY = '/packages/kojo-conformance/src/language.ts';

/**
 * language 子命令按 `--adapter` **按需**加载的真方言入口（SDK B5a：三种列 + 抽象列）。
 *
 * 为什么按需而不是齐载：一枚 adapter 包就是一条 `kojo-core` 桶入口的 SSR 冷载
 * （PITFALLS 187 记的 60s 量级传输超时）。三轮全载会把启动面顶到超时线上，
 * 而一次命令只会用到一个 adapter——多载的两枚纯属陪跑。
 */
const LANGUAGE_ADAPTER_ENTRIES = {
  eratw: '/packages/plugins/eratw-adapter/src/kojo2/index.ts',
  erafl: '/packages/plugins/erafl-adapter/src/kojo2/index.ts',
  // 第三列（SDK B5a 的终态判据）：一枚最小 profile + 它自己的机壳，住在 conformance 的
  // fixture 目录里。它证明"新增一个包 ⇒ 多一列"——套件与 CLI 一个字都不用改。
  demo: '/packages/kojo-conformance/tests/fixtures/dialect-demo/index.ts',
};

/** `--adapter <名称>`（缺省 fixture）；只认最朴素的 `--adapter X` 形态，其余交给 language.ts 判用法 */
function languageAdapterOf(argv) {
  const index = argv.indexOf('--adapter');
  const name = index >= 0 ? argv[index + 1] : undefined;
  return name === undefined || name.startsWith('--') ? 'fixture' : name;
}

/** language 子命令的入口组：套件 + 本次真要用的那一枚 adapter（未知名称 ⇒ 只有套件，交给 CLI 报错） */
function languageEntries(argv) {
  const entries = { language: LANGUAGE_SUITE_ENTRY };
  const adapter = languageAdapterOf(argv);
  const entry = LANGUAGE_ADAPTER_ENTRIES[adapter];
  if (entry !== undefined) entries[adapter] = entry;
  return entries;
}

/**
 * 起一个 Vite SSR 服务器把 TS 入口载进来；载完即关（后续调用不会再触发模块加载）。
 *
 * `configFile` 指向仓库的 `vitest.config.ts`：那份配置是**包别名（`@kojo/*`）的单一真源**，
 * 这里复用它，避免在工具里抄第二份 alias 表（抄了必漂移）。
 *
 * `watch: null`：本工具**只读一次**模块，从不靠 HMR——但默认开启的 chokidar 会在起服时
 * 整树爬一遍，把 SSR 的 `fetchModule` 排在同一线程的后面；实测（2026-10-28）不开：eraTW
 * 一枚入口就撞 `transport invoke timed out after 60000ms`（超时的是 `table.ts` / `parser.ts`
 * 这类小文件，说明排队而不慢在文件本身）；开 `watch: null` 后同一条命令六枚入口全载 3.8s。
 * 这是 PITFALLS 187（桶冷载 63.6s 贴着 60s 传输超时线）的放大器，别关回去。
 *
 * `kind === 'corpus-absent'` 时连 `main.ts` 都不载（见 `CORPUS_ABSENT_ENTRIES`）：那枚入口
 * 把整条真链路拖进 SSR，本机实测单体 67.1s、六枚齐载 137–140s。
 */
async function loadModules(kind, argv = []) {
  const server = await createServer({
    configFile: path.join(REPO, 'vitest.config.ts'),
    root: REPO,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, watch: null },
  });
  try {
    const modules = {};
    if (kind !== 'corpus-absent') {
      const main = await server.ssrLoadModule(ENTRY);
      if (typeof main.main !== 'function') throw new Error('src/main.ts 未导出 main()');
      modules.main = main;
    }
    const extra =
      kind === 'migrate'
        ? MIGRATE_ENTRIES
        : kind === 'language'
          ? languageEntries(argv)
          : kind === 'corpus'
            ? CORPUS_ENTRIES
            : kind === 'corpus-absent'
              ? CORPUS_ABSENT_ENTRIES
              : null;
    if (extra !== null) {
      for (const [key, entry] of Object.entries(extra)) {
        modules[key] = await server.ssrLoadModule(entry);
      }
    }
    return modules;
  } finally {
    await server.close();
  }
}

/** v1 真入口：kojo-sugar 转译服务（与 kojo-sugar golden / 迁移语料同一套表） */
function createV1Compiler(sugar, support) {
  const service = sugar.createSugarTranspileService({
    dictionary: support.stubDict,
    faceTable: support.stubFaceTable(),
  });
  return (source) => {
    const result = service.transpile(source);
    return {
      ok: result.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
      text: result.erb,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        // 行号 additive：blocked 成因定位（`indent-mismatch` 的哪一行）
        line: diagnostic.loc?.line ?? null,
      })),
    };
  };
}

/**
 * 2.0 真入口：core 编译 + eraTW backend。
 *
 * 取色口径与迁移语料同源：`narrationColor = 'default'`（v1 未声明 `旁白色` 时旁白是 D 系；
 * adapter 缺省 `author` 是"作者色"口径——拿它对比会把配置差异记成迁移差异）。
 */
function createV2Compiler(core, eratw) {
  const backend = eratw.createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
  const adapter = {
    ...eratw.ERATW_GAME_ADAPTER,
    profile: { ...eratw.ERATW_GAME_ADAPTER.profile, narrationColor: 'default' },
  };
  return (source) => {
    const result = core.compileKojoSource({ source, adapter, backend });
    return {
      ok: result.ok,
      text: result.erb,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
      })),
    };
  };
}

/**
 * 迁移真入口：core 语义层（`当` / `分支` / `初回` 三落点）。
 *
 * 事件目录**从真 adapter 注入**：`时机` 面词白名单 + 参数形状都是 adapter 事实（core 零游戏知识）。
 * - `eventNames`：不在 `ERATW_EVENT_NAMES` 的面词在迁移期落 unsupported（不产 `# 机`）；
 * - `eventArgs`：`projectEventArgs(ERATW_EVENT_CATALOG)` 的投影——`时机 初见 3` 这类
 *   "面词命中但参数形状不合"的写法同样在迁移期挡掉，不产会撞 `event/argument` 的 `# 机`。
 */
function createMigrator(core, eratw) {
  const eventArgs = core.projectEventArgs(eratw.ERATW_EVENT_CATALOG);
  return (source) => {
    const result = core.migrateKojoSourceSemantic(source, {
      eventNames: eratw.ERATW_EVENT_NAMES,
      eventArgs,
    });
    return {
      ok: result.ok,
      code: result.code,
      unsupported: result.unsupported.map((entry) => ({
        line: entry.line,
        construct: entry.construct,
        code: entry.code,
      })),
    };
  };
}

/** `migrate-diff`：argv → 判定（migration.ts）→ 文本 + 退出码 */
function runMigrateDiff(modules, argv) {
  const { migration, core, sugar, support, eratw, main } = modules;
  // 语料路径是参数；未给 `--dir` 时读环境变量（真实语料机到位后一键复跑的口子）
  const effective = [...argv];
  if (!effective.includes('--dir') && process.env.KOJO_MIGRATION_CORPUS_DIR) {
    effective.push('--dir', process.env.KOJO_MIGRATION_CORPUS_DIR);
  }
  const result = migration.runMigrationCli(effective, {
    io: main.createNodeIo(),
    compileV1: createV1Compiler(sugar, support),
    compile2: createV2Compiler(core, eratw),
    migrate: createMigrator(core, eratw),
  });
  const text = migration.formatMigrationReport(result.report, { json: effective.includes('--json') });
  if (result.exitCode === 2) process.stderr.write(text);
  else process.stdout.write(text);
  return result.exitCode;
}

/**
 * `language`：语言 fixture 注册表。
 *
 * 两档列（SDK B5a）：
 * - `fixture`（缺省）＝**抽象列**：`# 机 开场` 这类占位事件，与具体方言的事件表无关；
 * - `eratw` / `erafl` / `demo` ＝**共享列**：同一份 fixture、同一份 body golden（只比
 *   `# 机` 之后的语义面），机壳由各列的 backend 给。故三列的 JSON 可直接逐字对拍。
 *
 * 旧口径（真方言也跑抽象列、42/47 `event-unknown`）仍在 `runLanguageSuite` 层面可复现
 * （`packages/kojo-conformance/tests/language.test.ts` 注入 eraTW 那条），不是被删掉。
 */
function runLanguage(modules, argv) {
  const { language, eratw, erafl, demo, main } = modules;
  const compileText = (expr) => expr.text;
  const registrations = { ...language.createLanguageAdapters() };
  // 按需装载（见 `languageEntries`）：没载进来的列不进注册表，CLI 会如实报"未知 adapter"
  if (eratw !== undefined) {
    registrations.eratw = {
      adapter: eratw.ERATW_GAME_ADAPTER,
      backend: eratw.createEratwEmitBackend({ compileExpression: compileText, charNo: '12' }),
      column: 'shared',
    };
  }
  if (erafl !== undefined) {
    registrations.erafl = {
      adapter: erafl.ERAFL_GAME_ADAPTER,
      backend: erafl.createEraflEmitBackend({ compileExpression: compileText }),
      column: 'shared',
    };
  }
  if (demo !== undefined) {
    registrations.demo = {
      adapter: demo.DEMO_GAME_ADAPTER,
      backend: demo.createDemoEmitBackend({ compileExpression: compileText }),
      column: 'shared',
    };
  }
  return main.runMain({ argv, languageAdapters: registrations });
}

/* ---------------------------- corpus（真实语料机） ---------------------------- */

/**
 * 真实语料解析链（`tools/corpus.mjs` 的 `resolveCorpusDir`）：**语料不在位 = SKIP**。
 *
 * 返回值是纯逻辑可消费的 `CorpusRootResolution`：`ok:false` 的 reason 必须写清
 * "缺席"这件事（rc=1 = 盘上没发现；rc=2 = env/--corpus 指了坏路径），
 * 不许把缺席转成空目录去跑。
 */
function createCorpusRootResolver() {
  return () => {
    try {
      const dir = resolveCorpusDir({ label: 'kojo-conformance corpus', print: false });
      if (dir !== null) return { ok: true, dir };
      return {
        ok: false,
        dir: null,
        reason: `语料不在位（node tools/corpus.mjs --print rc=1）：盘上未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）；${corpusHint()}`,
      };
    } catch (error) {
      // CorpusError = 环境变量/显式路径指了坏位置（corpus.mjs CLI 的 rc=2 档）
      const message = error instanceof CorpusError ? error.message : error instanceof Error ? error.message : String(error);
      return { ok: false, dir: null, reason: `语料不在位（corpus.mjs 解析失败 rc=2）：${message}` };
    }
  };
}

/** corpus 的 IO：真文件系统 + 字节面（保真副本 / sha256 都按字节） */
function createCorpusIo(main) {
  const nodeIo = main.createNodeIo();
  const cwd = process.cwd();
  const absolute = (target) => (path.isAbsolute(target) ? target : path.resolve(cwd, target));
  return {
    ...nodeIo,
    readBytes: (target) => new Uint8Array(readFileSync(absolute(target))),
    writeBytes: (target, bytes) => {
      const file = absolute(target);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    },
    mkdir: (dir) => mkdirSync(absolute(dir), { recursive: true }),
  };
}

/** `corpus`：argv → 发现/聚合/抽样（corpus.ts）→ 文本 + 退出码 */
function runCorpus(modules, argv) {
  const { corpus, core, sugar, support, eratw, main } = modules;
  const result = corpus.runCorpusCli(argv, {
    io: createCorpusIo(main),
    compileV1: createV1Compiler(sugar, support),
    compile2: createV2Compiler(core, eratw),
    migrate: createMigrator(core, eratw),
    sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    resolveRoot: createCorpusRootResolver(),
    // 落点固定为仓内真实语料 fixture 目录：不给"任意落点"参数（写盘允许域是声明出来的）
    realCorpusDir: path.join(REPO, corpus.REAL_CORPUS_DIR),
  });
  const text = corpus.formatCorpusReport(result.report, { json: argv.includes('--json') });
  if (result.exitCode === 2) process.stderr.write(text);
  else process.stdout.write(text);
  return result.exitCode;
}

/**
 * 缺席快路：文本由 `corpus-skip.ts` 那枚**唯一实现**产出，与 `runCorpusCli` 走到缺席分支时
 * 逐字节同形（相等性由 `packages/kojo-conformance/tests/corpus.test.ts` 钉住，不是"看起来一样"）。
 */
function runCorpusAbsent(modules, argv, resolution) {
  const { skip } = modules;
  const text = skip.renderCorpusSkipText(skip.skipReport(resolution.dir ?? '', resolution.reason), argv.includes('--json'));
  process.stderr.write(text);
  return skip.SKIP_EXIT_CODE;
}

/**
 * 快路只认**最朴素的两种调用**：`corpus` 与 `corpus --json`。
 *
 * 其余形态（`--dir` / `--limit` / `--generate-manifest` / `--help` / 任何未知参数）一律走全量入口，
 * 由 `corpus.ts` 的 `parseCorpusArgs` 权威地决定是用法错误、help 还是真读盘——这条判据是**保守方向**
 * 的：将来 corpus.ts 新增旗标而这里没登记，最多是慢一点，绝不会把"用法错误"错报成"语料不在位"。
 */
function skipFastEligible(argv) {
  const rest = argv.slice(1);
  return rest.length === 0 || (rest.length === 1 && rest[0] === '--json');
}

/**
 * argv → 需要加载的入口组（未知子命令走 main.ts，行为与改动前一致）。
 *
 * `corpus` 多一条**缺席快路**（见 `CORPUS_ABSENT_ENTRIES` 的计时账）：预检判定语料不在位且调用
 * 形态是 `skipFastEligible` 那两种时，只载零依赖的叶子 `corpus-skip.ts`。
 * 判据一个字没动：缺席仍是 rc=2 + stderr「语料不在位」+ `verdict: skip`，且文本与全量路径同出处。
 */
function planFor(argv) {
  const command = argv[0];
  if (command === MIGRATE_COMMAND) return { kind: 'migrate', resolution: null };
  if (command === LANGUAGE_COMMAND) return { kind: 'language', resolution: null };
  if (command === CORPUS_COMMAND) {
    if (!skipFastEligible(argv)) return { kind: 'corpus', resolution: null };
    const resolution = createCorpusRootResolver()();
    return resolution.ok ? { kind: 'corpus', resolution: null } : { kind: 'corpus-absent', resolution };
  }
  return { kind: null, resolution: null };
}

const argv = process.argv.slice(2);
const plan = planFor(argv);

let modules;
let lastError;
for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
  try {
    modules = await loadModules(plan.kind, argv);
    break;
  } catch (error) {
    // 本机实测过一次并发起两个 Vite 时的瞬时 transform 错（同一条命令随后单跑即绿）；
    // 只对**启动**重试，检查结果本身不重跑、不吞失败。
    lastError = error;
  }
}

if (modules === undefined) {
  console.error(`[kojo-conformance] 启动失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  process.exitCode = 1;
} else if (plan.kind === 'corpus-absent') {
  process.exitCode = runCorpusAbsent(modules, argv, plan.resolution);
} else if (argv[0] === MIGRATE_COMMAND) process.exitCode = runMigrateDiff(modules, argv);
else if (argv[0] === LANGUAGE_COMMAND) process.exitCode = runLanguage(modules, argv);
else if (argv[0] === CORPUS_COMMAND) process.exitCode = runCorpus(modules, argv);
else process.exitCode = modules.main.main(argv);
