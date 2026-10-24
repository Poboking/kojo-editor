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
 * 缺席快路（`corpus` 且自动发现判定语料不在位）唯一的入口：报告是两个纯函数
 * （`skipReport` / `formatCorpusReport`），真链路（core / sugar / eratw / main.ts）一行用不上。
 */
const CORPUS_ABSENT_ENTRIES = {
  corpus: '/packages/kojo-conformance/src/corpus.ts',
};

/** language 子命令需要额外加载的 TS 入口（语言套件纯逻辑 + 可选 eraTW 注入） */
const LANGUAGE_ENTRIES = {
  language: '/packages/kojo-conformance/src/language.ts',
  eratw: '/packages/plugins/eratw-adapter/src/kojo2/index.ts',
};

/**
 * 起一个 Vite SSR 服务器把 TS 入口载进来；载完即关（后续调用不会再触发模块加载）。
 *
 * `configFile` 指向仓库的 `vitest.config.ts`：那份配置是**包别名（`@kojo/*`）的单一真源**，
 * 这里复用它，避免在工具里抄第二份 alias 表（抄了必漂移）。
 *
 * `kind === 'corpus-absent'` 时连 `main.ts` 都不载（见 `CORPUS_ABSENT_ENTRIES`）：那枚入口
 * 把整条真链路拖进 SSR，本机实测单体 67.1s、六枚齐载 137–140s。
 */
async function loadModules(kind) {
  const server = await createServer({
    configFile: path.join(REPO, 'vitest.config.ts'),
    root: REPO,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
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
          ? LANGUAGE_ENTRIES
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

/** `language`：语言 fixture 注册表（默认 fixture + 可选真 eraTW 注入；判定全在 language.ts） */
function runLanguage(modules, argv) {
  const { language, eratw, main } = modules;
  const registrations = {
    ...language.createLanguageAdapters(),
    eratw: {
      adapter: eratw.ERATW_GAME_ADAPTER,
      backend: eratw.createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' }),
    },
  };
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
  const { corpus, main } = modules;
  // 缺席快路（`main === undefined`）：io 与三条编译入口在缺席路径上不会被调用——报告是
  // `skipReport`/`formatCorpusReport` 两个纯函数产的。真被调到了就是判据走偏（或语料在预检
  // 之后才落盘），当场炸给看，比塞一枚"看起来能用"的空对象诚实。
  const tripwire = (name) => () => {
    throw new Error(`corpus 缺席快路用到了 ${name}：预检说语料不在位，却走进了真链路`);
  };
  const absent = main === undefined;
  const result = corpus.runCorpusCli(argv, {
    io: absent ? new Proxy({}, { get: () => tripwire('IO') }) : createCorpusIo(main),
    compileV1: absent ? tripwire('v1 转译') : createV1Compiler(modules.sugar, modules.support),
    compile2: absent ? tripwire('2.0 编译') : createV2Compiler(modules.core, modules.eratw),
    migrate: absent ? tripwire('迁移') : createMigrator(modules.core, modules.eratw),
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
 * argv[0] → 需要加载的入口组（未知子命令走 main.ts，行为与改动前一致）。
 *
 * `corpus` 多一条**缺席快路**：自动发现（显式 `--dir` 不走——那条自己会读盘）判定语料不在位时，
 * 只载 `corpus.ts`。动因（2026-10-24 合并 eraFL/XML 批后实测）：六枚入口齐载 137–140s（合并前
 * 同机 65–83s，plugin-api 索引面变大把 `main.ts` 拖到单体 67.1s），全量池里这条「语料不在位」
 * 用例因此顶穿它自己的 240s spawn 预算，读数变成 `status:null`（进程被掐，不是 rc 不对）。
 * 判据一个字没动：缺席仍是 rc=2 + stderr「语料不在位」+ `verdict: skip`，文本走同一个格式化函数。
 */
function moduleKindFor(argv) {
  const command = argv[0];
  if (command === MIGRATE_COMMAND) return 'migrate';
  if (command === LANGUAGE_COMMAND) return 'language';
  if (command === CORPUS_COMMAND) {
    if (argv.includes('--dir')) return 'corpus';
    return createCorpusRootResolver()().ok ? 'corpus' : 'corpus-absent';
  }
  return null;
}

let modules;
let lastError;
for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
  try {
    modules = await loadModules(moduleKindFor(process.argv.slice(2)));
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
} else {
  const argv = process.argv.slice(2);
  if (argv[0] === MIGRATE_COMMAND) process.exitCode = runMigrateDiff(modules, argv);
  else if (argv[0] === LANGUAGE_COMMAND) process.exitCode = runLanguage(modules, argv);
  else if (argv[0] === CORPUS_COMMAND) process.exitCode = runCorpus(modules, argv);
  else process.exitCode = modules.main.main(argv);
}
