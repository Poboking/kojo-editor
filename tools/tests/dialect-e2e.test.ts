/**
 * 方言脚手架的**真实端到端**（默认跳过：它要在真实仓库里临时生成一个包）。
 *
 * 为什么默认跳过：这个用例会往 `packages/plugins/` 写一个包、往清单/依赖/别名各插一行
 * （结束必删、逐字节还原），而 vitest 默认**并行**跑测试文件——它跑的同时别的文件
 * 正在读清单（`adapter-manifest.test.ts` 的双向自证会看到"半成品树"）。所以它是
 * **显式开关**，不进并行池：
 *
 *   KOJO_DIALECT_E2E=1 node node_modules/vitest/vitest.mjs run tools/tests/dialect-e2e.test.ts
 *
 * 它钉的是"新增一个方言 = 新增一个包 + 清单一行"的**整条链**：
 * 1. `tools/new-dialect.mjs` 生成包 + 清单条目 + 散点；
 * 2. `adapter-manifest.test.ts` 的双向自证在生成物在场时仍绿；
 * 3. 生成包自带的 purity / 形态闸绿；
 * 4. `node tools/kojo-conformance.mjs language --adapter <新 id>` 的 11 条共享用例
 *    产物与 `tests/fixtures/language-shared/*.body.erb` **逐字节相等**；
 * 5. 生成物本身过 `tsc`（含清单里那行动态 import 的解析）。
 *
 * 收尾：删包、把 5 个共享文件还原成进入测试时的字节（任一断言失败也照做）。
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ENABLED = process.env.KOJO_DIALECT_E2E === '1';
const describeE2E = ENABLED ? describe : describe.skip;

const ID = 'kdialecte2e';
const DIR = ID + '-adapter';

/** 共享文件：生成器会插行，测试结束必须逐字节还原 */
const SHARED_FILES = [
  'packages/app/src/adapter-manifest.ts',
  'packages/app/package.json',
  'tsconfig.json',
  'packages/app/tsconfig.json',
  'vitest.config.ts',
];

/** 共享列的 fixture 与 golden（id `shared/<file>` → `<file>.body.erb`） */
const SHARED_DIR = path.join(REPO, 'packages/kojo-conformance/tests/fixtures/language-shared');

async function execNode(args: readonly string[], timeout = 240_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, args, { cwd: REPO, timeout, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
    };
  }
}

describeE2E('方言脚手架 · 真实端到端（KOJO_DIALECT_E2E=1）', () => {
  it(
    '生成 → 清单自证 → 包内测试 → conformance 11 条 golden 逐字 → tsc → 清理',
    async () => {
      const pluginDir = path.join(REPO, 'packages/plugins', DIR);
      const original = new Map<string, string>();
      for (const rel of SHARED_FILES) original.set(rel, await fs.readFile(path.join(REPO, rel), 'utf8'));
      const tempTsconfig = path.join(REPO, '.dialect-e2e-tsconfig.json');
      expect(existsSync(pluginDir), '清理残留：' + pluginDir).toBe(false);

      try {
        /* 1. 生成 */
        const scaffold = await execNode(['tools/new-dialect.mjs', '--id', ID, '--title', 'E2E Dialect', '--ext', 'kojo2']);
        expect(scaffold.code, scaffold.stderr).toBe(0);
        expect(existsSync(path.join(pluginDir, 'src/index.ts'))).toBe(true);
        const manifest = await fs.readFile(path.join(REPO, 'packages/app/src/adapter-manifest.ts'), 'utf8');
        expect(manifest).toContain("id: '" + ID + "'");

        /* 2 + 3. 清单双向自证 + 生成包自带闸（真跑 vitest，不经本进程） */
        const vitest = await execNode([
          'node_modules/vitest/vitest.mjs',
          'run',
          'packages/plugins/' + DIR + '/tests',
          'packages/app/tests/adapter-manifest.test.ts',
        ]);
        expect(vitest.code, vitest.stdout + vitest.stderr).toBe(0);
        expect(vitest.stdout).toContain('adapter-manifest.test.ts');

        /* 4. conformance：清单驱动认出新方言，11 条共享用例逐字节对 golden */
        const conform = await execNode(['tools/kojo-conformance.mjs', 'language', '--adapter', ID, '--json']);
        expect(conform.code, conform.stderr || conform.stdout.slice(-2000)).toBe(0);
        const report = JSON.parse(conform.stdout) as {
          adapter: string;
          ok: boolean;
          summary: { cases: number; pass: number; differs: number; blocked: number };
          cases: Array<{ id: string; status: string; artifact: string | null; golden: string | null }>;
        };
        expect(report.adapter).toBe(ID);
        expect(report.ok).toBe(true);
        expect(report.summary).toMatchObject({ cases: 11, pass: 11, differs: 0, blocked: 0 });
        for (const item of report.cases) {
          const file = item.id.replace(/^shared\//, '');
          const goldenFile = await fs.readFile(path.join(SHARED_DIR, file + '.body.erb'), 'utf8');
          // body 取的是"从产物里切出来的那几行"（不带上文件末尾的换行），故末尾换行剥一次
          const golden = goldenFile.endsWith('\n') ? goldenFile.slice(0, -1) : goldenFile;
          expect(item.status, item.id).toBe('pass');
          expect(item.golden, item.id).toBe(golden);
          expect(item.artifact, item.id).toBe(golden);
        }

        /* 5. 生成物过 tsc（extends 根配置；清单那行动态 import 也一起解析） */
        await fs.writeFile(
          tempTsconfig,
          JSON.stringify(
            {
              extends: './tsconfig.json',
              include: [
                'packages/plugins/' + DIR + '/src/**/*.ts',
                'packages/plugins/' + DIR + '/tests/**/*.ts',
                'packages/app/src/adapter-manifest.ts',
              ],
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
        const tsc = await execNode(['node_modules/typescript/bin/tsc', '-p', tempTsconfig]);
        expect(tsc.code, tsc.stdout + tsc.stderr).toBe(0);
      } finally {
        await fs.rm(pluginDir, { recursive: true, force: true });
        for (const [rel, text] of original) await fs.writeFile(path.join(REPO, rel), text, 'utf8');
        await fs.rm(tempTsconfig, { force: true });
      }

      /* 收尾自证：包没了、共享文件逐字节回到进测试时的样子 */
      expect(existsSync(pluginDir)).toBe(false);
      for (const [rel, text] of original) {
        expect(await fs.readFile(path.join(REPO, rel), 'utf8'), rel).toBe(text);
      }
    },
    600_000,
  );
});
