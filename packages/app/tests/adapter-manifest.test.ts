/**
 * 适配器清单的自证闸（多游戏适配的「单一清单」不能只靠自觉）。
 *
 * 过去接一个新游戏要改六七个文件，漏一处不会立刻红，只会在别的机器上以别的形态炸。
 * 清单把**身份**收成一处后，剩下的散点（别名、依赖、导出名、审计词表）由本闸
 * **双向**核对：清单说有的，文件里必须真有；文件里有的，清单里必须列得下。
 *
 * 判据全部是「读文件 + 逐字比」，不启动壳、不碰真盘。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTER_MANIFEST, projectAdapters } from '../src/adapter-manifest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
const pluginsDir = path.join(repoRoot, 'packages/plugins');

/** 磁盘上的适配器目录（`packages/plugins/*-adapter`） */
function adapterDirsOnDisk(): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('-adapter'))
    .map((e) => e.name)
    .sort();
}

/** 配置文件里指向适配器包的别名目录名（root/app tsconfig 与 vitest 三种写法都认） */
function aliasDirs(source: string): Set<string> {
  const out = new Set<string>();
  const re = /@kojo\/plugin-([a-z0-9-]+-adapter)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1]!);
  return out;
}

describe('适配器清单 · 与磁盘互为完备', () => {
  it('磁盘上的每个 *-adapter 目录都在清单里，清单里的每个目录都在磁盘上', () => {
    const onDisk = adapterDirsOnDisk();
    const inManifest = ADAPTER_MANIFEST.map((e) => e.dir).sort();
    expect(inManifest).toEqual(onDisk);
  });

  it('id / 工厂名不重复（重复＝两次注册同一个适配器）', () => {
    const ids = ADAPTER_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const factories = ADAPTER_MANIFEST.map((e) => e.factory);
    expect(new Set(factories).size).toBe(factories.length);
  });

  it('包名与目录名自洽（@kojo/plugin-<dir>）', () => {
    for (const entry of ADAPTER_MANIFEST) {
      expect(entry.packageName, entry.id).toBe(`@kojo/plugin-${entry.dir}`);
      const pkgPath = path.join(pluginsDir, entry.dir, 'package.json');
      expect(existsSync(pkgPath), `${entry.dir} 缺 package.json`).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      expect(pkg.name, entry.dir).toBe(entry.packageName);
    }
  });

  it('工厂名在适配器包的导出面上真的存在（清单不会指着一个不存在的函数）', () => {
    for (const entry of ADAPTER_MANIFEST) {
      const index = read(path.join('packages/plugins', entry.dir, 'src/index.ts'));
      expect(index, entry.dir).toContain(entry.factory);
    }
  });

  it('项目级条目都有动态装载口；常驻条目没有（常驻走静态 import）', () => {
    for (const entry of ADAPTER_MANIFEST) {
      if (entry.scope === 'project') {
        expect(typeof entry.load, entry.id).toBe('function');
      } else {
        expect(entry.load, entry.id).toBeUndefined();
      }
    }
    expect(projectAdapters().length).toBeGreaterThan(0);
  });
});

describe('适配器清单 · 与散点双向自证', () => {
  it('app 包依赖里有每一枚适配器', () => {
    const pkg = JSON.parse(read('packages/app/package.json')) as {
      dependencies?: Record<string, string>;
    };
    for (const entry of ADAPTER_MANIFEST) {
      expect(pkg.dependencies?.[entry.packageName], entry.packageName).toBeDefined();
    }
  });

  it('别名没有陈旧项：每个别名都指向磁盘上真实存在的适配器包', () => {
    const aliasSets: Array<[string, Set<string>]> = [
      ['tsconfig.json', aliasDirs(read('tsconfig.json'))],
      ['packages/app/tsconfig.json', aliasDirs(read('packages/app/tsconfig.json'))],
      ['vitest.config.ts', aliasDirs(read('vitest.config.ts'))],
    ];
    const onDisk = new Set(adapterDirsOnDisk());
    for (const [file, dirs] of aliasSets) {
      for (const dir of dirs) {
        expect(onDisk.has(dir), `${file} 里的别名指向不存在的适配器目录：${dir}`).toBe(true);
      }
    }
    // 两处「测试侧解析面」必须一致（root tsc 与 vitest 各编一份，少一处＝某台机器上找不到）
    const [, rootDirs] = aliasSets[0]!;
    const [, vitestDirs] = aliasSets[2]!;
    expect([...vitestDirs].sort()).toEqual([...rootDirs].sort());
    // app 侧可以更少（走 workspace 包解析），但不能有 root 侧没有的别名
    const [, appDirs] = aliasSets[1]!;
    for (const dir of appDirs) {
      expect(rootDirs.has(dir), `app tsconfig 的别名 ${dir} 在 root tsconfig 里没有`).toBe(true);
    }
  });

  it('每枚适配器包都能按包名解析（exports 指向 src/index.ts）', () => {
    for (const entry of ADAPTER_MANIFEST) {
      const pkg = JSON.parse(read(path.join('packages/plugins', entry.dir, 'package.json'))) as {
        exports?: Record<string, string>;
      };
      expect(pkg.exports?.['.'], entry.dir).toBe('./src/index.ts');
    }
  });

  it('审计词表从清单派生：清单里的每个游戏名都被审计读走，且审计脚本不再自带新游戏名', () => {
    const manifestSrc = read('packages/app/src/adapter-manifest.ts');
    const wordsInManifest = [...manifestSrc.matchAll(/auditWord:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(wordsInManifest).toEqual(ADAPTER_MANIFEST.map((e) => e.auditWord));
    // 审计脚本走清单派生（不再自带游戏名清单）
    const audit = read('tools/audit-decoupling.mjs');
    expect(audit).toContain('manifestAuditWords');
    expect(audit).toContain('withManifestWords');
    // 只看**代码行**（注释里提一句「eratw / eraK」是设计说明，不是词表）
    const codeLines = audit
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const word of ADAPTER_MANIFEST.map((e) => e.auditWord)) {
      expect(codeLines.includes(word), `审计脚本的代码行里出现了 ${word}：应当只由清单派生`).toBe(false);
    }
  });
});
