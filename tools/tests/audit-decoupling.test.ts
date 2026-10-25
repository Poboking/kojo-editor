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
/** 审计脚本的清单读取助手（脚本 import 它；夹具必须一起复制，否则脚本加载即崩） */
const WORDS_HELPER = fileURLToPath(new URL('../adapter-manifest-words.mjs', import.meta.url));
/** `audit-allow` 判据（与 audit-language 共用；同上，不复制就 MODULE_NOT_FOUND） */
const ALLOW_HELPER = fileURLToPath(new URL('../lib/audit-allow.mjs', import.meta.url));

async function runAudit(files: Record<string, string>): Promise<{ code: number; output: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-audit-'));
  try {
    await fs.mkdir(path.join(tmp, 'tools'), { recursive: true });
    await fs.copyFile(SCRIPT, path.join(tmp, 'tools', 'audit-decoupling.mjs'));
    await fs.copyFile(WORDS_HELPER, path.join(tmp, 'tools', 'adapter-manifest-words.mjs'));
    await fs.mkdir(path.join(tmp, 'tools', 'lib'), { recursive: true });
    await fs.copyFile(ALLOW_HELPER, path.join(tmp, 'tools', 'lib', 'audit-allow.mjs'));
    // A 项对 NEUTRAL_DIRS 里的单文件条目（bootstrap.ts / adapter-manifest.ts）无条件
    // readFile：夹具必须提供它们，否则脚本 ENOENT 崩溃——退出码 1 但报告是堆栈而非
    // B 项文本，三个用例全废。清单里的 auditWord 决定审计词表（读不到就判红）。
    await fs.mkdir(path.join(tmp, 'packages', 'app', 'src'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'packages', 'app', 'src', 'bootstrap.ts'), '// 组合根占位\n', 'utf8');
    await fs.writeFile(
      path.join(tmp, 'packages', 'app', 'src', 'adapter-manifest.ts'),
      "export const ADAPTER_MANIFEST = [{ auditWord: 'fakegame' }];\n",
      'utf8',
    );
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

/* ------------------------------------------------------------------ *
 * A 项语言包在册清单（2026-10-25 K4 批）
 *
 * 语言包 = tree-sitter 语法层（`packages/<语言>-syntax-tree`），与内核/契约同属
 * 「零游戏名词」面。背景：`packages/kojo-syntax-tree/src` 2026-10-19 就收编进
 * NEUTRAL_DIRS，而 `packages/erb-syntax-tree/src` 一直漏册——那个包在 package.json
 * 与 grammar.js 里自陈「语言层，零游戏名词」，却没有任何机器判据兑这个承诺。
 *
 * 三面钉子：
 *  1. 两门一等语言（.kojo / ERB）都在册（点名，防再次漏一门）；
 *  2. 凡磁盘上存在 `packages/*-syntax-tree/src` 就必须在册（将来加第三门语言时，
 *     漏加目录清单当场判红，而不是等某天泄漏了才发现没闸）；在册的语法层目录
 *     也必须真实存在（目录搬家 ⇒ 闸变哑炮）；
 *  3. 在册不是「脚本源码里多一个字符串」——夹具里真跑审计，游戏名词进语言包必须
 *     真判 A 项红，干净的语言层文件（ERB 控制词）不得误伤。
 * ------------------------------------------------------------------ */

/** 仓库根（测试在 tools/tests/，审计脚本在 tools/） */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 从审计脚本源码抽出 NEUTRAL_DIRS 的字面量条目（注释行不参与解析）。 */
async function neutralDirsFromScript(): Promise<string[]> {
  const source = await fs.readFile(SCRIPT, 'utf8');
  const block = /const NEUTRAL_DIRS\s*=\s*\[([\s\S]*?)\n\];/.exec(source);
  if (!block) throw new Error('audit-decoupling.mjs 里没解析到 NEUTRAL_DIRS —— 本钉子失去判据');
  const body = block[1]
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/** 磁盘上现有/新增的语言包源码目录：`packages/<语言>-syntax-tree/src`（src 不存在的不算）。 */
async function languagePackageSrcDirs(): Promise<string[]> {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('-syntax-tree')) continue;
    const rel = `packages/${e.name}/src`;
    try {
      const st = await fs.stat(path.join(REPO_ROOT, rel));
      if (st.isDirectory()) out.push(rel);
    } catch {
      /* 只有清单没有实体 ⇒ 不算在册义务（由反向检查拦） */
    }
  }
  return out.sort();
}

describe('audit-decoupling · A 项语言包在册清单（两门一等语言都要有闸）', () => {
  it('两门一等语言的语言包（.kojo / ERB）都在 NEUTRAL_DIRS 册上', async () => {
    const dirs = await neutralDirsFromScript();
    expect(dirs).toContain('packages/kojo-syntax-tree/src');
    expect(dirs).toContain('packages/erb-syntax-tree/src');
  });

  it('packages/*-syntax-tree/src 与在册清单双向对账（新语言漏册 / 目录搬家都拦）', async () => {
    const [dirs, onDisk] = await Promise.all([neutralDirsFromScript(), languagePackageSrcDirs()]);
    const notRegistered = onDisk.filter((d) => !dirs.includes(d));
    expect(notRegistered).toEqual([]);
    const notOnDisk = dirs.filter((d) => /-syntax-tree\/src$/.test(d) && !onDisk.includes(d));
    expect(notOnDisk).toEqual([]);
  });

  it('语言包在册即真判红：游戏名词进语言层 = A 项违规；ERB 控制词不误伤', async () => {
    const langs = await languagePackageSrcDirs();
    expect(langs.length).toBeGreaterThanOrEqual(2);
    for (const dir of langs) {
      const leak = await runAudit({
        // packages/plugins 必须非空，否则审计脚本读 adapter 豁免名单即崩（同 B 项夹具）
        'packages/plugins/probe/src/index.ts': 'export const marker = 1;\n',
        [`${dir}/index.ts`]: "export const GAME_PREFIX = 'M_KOJO';\n",
      });
      expect(leak.code).toBe(1);
      expect(leak.output).toContain('A(内核零游戏知识)');
      expect(leak.output).toContain(dir);
    }
    // 反例：语言层自己的控制词（ERB 与 Kojo 同级、非游戏约定）必须继续放行
    const clean = await runAudit({
      'packages/plugins/probe/src/index.ts': 'export const marker = 1;\n',
      'packages/erb-syntax-tree/src/index.ts': "export const CLOSE_LINE = /^[\\[ENDIF\\]]\\s*$/i.source;\n",
    });
    expect(clean.code).toBe(0);
    expect(clean.output).toContain('全部通过');
  });
});

describe('audit-decoupling · audit-allow 判据与 audit-language 同一实现（2026-10-26 收紧）', () => {
  it('注释位 + 非空理由 ⇒ 豁免（既有写法不许被收紧误伤）', async () => {
    const { code, output } = await runAudit({
      'packages/plugins/probe/src/index.ts': 'export const marker = 1;\n',
      'packages/kernel/src/index.ts': "export const X = 'M_KOJO'; // audit-allow: 组合根示例行\n",
    });
    expect(code).toBe(0);
    expect(output).toContain('全部通过');
  });

  it('字符串里的同名串不算豁免（行中随手写就免责是那条缝）', async () => {
    const { code, output } = await runAudit({
      'packages/plugins/probe/src/index.ts': 'export const marker = 1;\n',
      'packages/kernel/src/index.ts': "export const X = 'M_KOJO'; export const NOTE = 'audit-allow: 字符串里不算';\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('A(内核零游戏知识)');
  });

  it('光秃秃的空理由不算豁免（占位不许生效）', async () => {
    const { code, output } = await runAudit({
      'packages/plugins/probe/src/index.ts': 'export const marker = 1;\n',
      'packages/kernel/src/index.ts': "export const X = 'M_KOJO'; // audit-allow:\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('A(内核零游戏知识)');
  });
});
