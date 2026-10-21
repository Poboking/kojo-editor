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
 *
 * 用法（与 bin 一致）：
 *   node tools/kojo-conformance.mjs list-cases
 *   node tools/kojo-conformance.mjs check --adapter fixture --dir packages/kojo-conformance/tests/fixtures
 *   node tools/kojo-conformance.mjs check --golden <源.kojo2>:<产物.erb> --json
 * 退出码：透传 main.ts 的 0 / 1 / 2；启动失败 = 1。
 */
import * as path from 'node:path';
import { createServer } from 'vite';

const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = '/packages/kojo-conformance/src/main.ts';
const START_ATTEMPTS = 2;

/** 起一个 Vite SSR 服务器把 main.ts 载进来；载完即关（后续调用不会再触发模块加载） */
async function loadMain() {
  const server = await createServer({
    configFile: false,
    root: REPO,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule(ENTRY);
    if (typeof module.main !== 'function') throw new Error('src/main.ts 未导出 main()');
    return module.main;
  } finally {
    await server.close();
  }
}

let main;
let lastError;
for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
  try {
    main = await loadMain();
    break;
  } catch (error) {
    // 本机实测过一次并发起两个 Vite 时的瞬时 transform 错（同一条命令随后单跑即绿）；
    // 只对**启动**重试，检查结果本身不重跑、不吞失败。
    lastError = error;
  }
}

if (main === undefined) {
  console.error(`[kojo-conformance] 启动失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  process.exitCode = 1;
} else {
  process.exitCode = main(process.argv.slice(2));
}
