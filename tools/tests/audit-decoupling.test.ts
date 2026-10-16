/**
 * audit-decoupling.mjs 的 B 项回归（2026-10-16 修复批）：
 *
 * 脚本以 `import.meta.dirname` 定 ROOT ⇒ 把脚本复制进夹具同位目录（<tmp>/tools/），
 * 再喂一个迷你插件树，真跑 `node audit-decoupling.mjs`，验退出码与报告文本。
 * 修复前 B 项正则漏掉副作用导入形态 `import '@kojo/kernel'`（无 from / 无动态 import），
 * 插件可以零引用、副作用地拉起内核而静默过闸——漏报。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../audit-decoupling.mjs', import.meta.url));

async function runAudit(files: Record<string, string>): Promise<{ code: number; output: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-audit-'));
  try {
    await fs.mkdir(path.join(tmp, 'tools'), { recursive: true });
    await fs.copyFile(SCRIPT, path.join(tmp, 'tools', 'audit-decoupling.mjs'));
    // A 项对 NEUTRAL_DIRS 里的单文件条目（bootstrap.ts）无条件 readFile：夹具必须提供它，
    // 否则脚本 ENOENT 崩溃——退出码 1 但报告是堆栈而非 B 项文本，三个用例全废。
    await fs.mkdir(path.join(tmp, 'packages', 'app', 'src'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'packages', 'app', 'src', 'bootstrap.ts'), '// 组合根占位\n', 'utf8');
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }
    try {
      const res = await run('node', [path.join(tmp, 'tools', 'audit-decoupling.mjs')]);
      return { code: 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      };
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('audit-decoupling · B 项（插件禁依赖内核）', () => {
  it('副作用导入 import \'@kojo/kernel\' 也算违规（漏掉这一支 = 插件静默拉起内核）', async () => {
    const { code, output } = await runAudit({
      'packages/plugins/bad/src/index.ts': "import '@kojo/kernel';\nexport const marker = 1;\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('B(插件禁依赖内核)');
    expect(output).toContain('bad');
  });

  it('副作用导入 @kojo/plugin-api 不误伤（合法形态必须继续放行）', async () => {
    const { code, output } = await runAudit({
      'packages/plugins/clean/src/index.ts':
        "import '@kojo/plugin-api';\nimport { definePlugin } from '@kojo/plugin-api';\nexport const marker = 1;\n",
    });
    expect(code).toBe(0);
    expect(output).toContain('全部通过');
  });

  it('既有形态（命名导入 / 动态导入）仍被拦（钉住不回退）', async () => {
    const named = await runAudit({
      'packages/plugins/named/src/index.ts': "import { x } from '@kojo/kernel';\nexport const y = x;\n",
    });
    expect(named.code).toBe(1);
    expect(named.output).toContain('B(插件禁依赖内核)');
    const dynamic = await runAudit({
      'packages/plugins/dyn/src/index.ts': "await import('@kojo/kernel');\nexport const marker = 1;\n",
    });
    expect(dynamic.code).toBe(1);
  });
});
