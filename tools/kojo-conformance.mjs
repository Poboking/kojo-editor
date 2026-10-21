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
 *
 * 用法（与 bin 一致）：
 *   node tools/kojo-conformance.mjs list-cases
 *   node tools/kojo-conformance.mjs check --adapter fixture --dir packages/kojo-conformance/tests/fixtures
 *   node tools/kojo-conformance.mjs check --golden <源.kojo2>:<产物.erb> --json
 *   node tools/kojo-conformance.mjs migrate-diff --dir packages/kojo-core/tests/fixtures/migrate-corpus
 *   node tools/kojo-conformance.mjs migrate-diff --dir <语料机目录> --json
 * 退出码：透传 main.ts / migration.ts 的 0 / 1 / 2；启动失败 = 1。
 */
import * as path from 'node:path';
import { createServer } from 'vite';

const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = '/packages/kojo-conformance/src/main.ts';
const START_ATTEMPTS = 2;
const MIGRATE_COMMAND = 'migrate-diff';

/** migrate-diff 需要额外加载的 TS 入口（真 core / 真 v1 转译 / 真 adapter backend / 判定逻辑） */
const MIGRATE_ENTRIES = {
  migration: '/packages/kojo-conformance/src/migration.ts',
  core: '/packages/kojo-core/src/index.ts',
  sugar: '/packages/plugins/kojo-sugar/src/service.ts',
  support: '/packages/plugins/kojo-sugar/tests/support.ts',
  eratw: '/packages/plugins/eratw-adapter/src/kojo2/index.ts',
};

/**
 * 起一个 Vite SSR 服务器把 TS 入口载进来；载完即关（后续调用不会再触发模块加载）。
 *
 * `configFile` 指向仓库的 `vitest.config.ts`：那份配置是**包别名（`@kojo/*`）的单一真源**，
 * 这里复用它，避免在工具里抄第二份 alias 表（抄了必漂移）。
 */
async function loadModules(needMigration) {
  const server = await createServer({
    configFile: path.join(REPO, 'vitest.config.ts'),
    root: REPO,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });
  try {
    const main = await server.ssrLoadModule(ENTRY);
    if (typeof main.main !== 'function') throw new Error('src/main.ts 未导出 main()');
    const modules = { main };
    if (!needMigration) return modules;
    for (const [key, entry] of Object.entries(MIGRATE_ENTRIES)) {
      modules[key] = await server.ssrLoadModule(entry);
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

/** 迁移真入口：core 语义层（`当` / `分支` / `初回` 三落点） */
function createMigrator(core) {
  return (source) => {
    const result = core.migrateKojoSourceSemantic(source);
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
    migrate: createMigrator(core),
  });
  const text = migration.formatMigrationReport(result.report, { json: effective.includes('--json') });
  if (result.exitCode === 2) process.stderr.write(text);
  else process.stdout.write(text);
  return result.exitCode;
}

let modules;
let lastError;
for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
  try {
    modules = await loadModules(process.argv[2] === MIGRATE_COMMAND);
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
  process.exitCode = argv[0] === MIGRATE_COMMAND ? runMigrateDiff(modules, argv) : modules.main.main(argv);
}
