import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin, relative as nodeRel, resolve as nodeResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 单一真源守门（可复跑判据，违例直接红）：
 *
 * 1. **SHA-256 全仓只许一份实现** —— 只准住在
 *    `packages/plugins/kojo-market/src/digest.ts`。校验锚有两份实现 = 市场校验是装饰。
 *    （`tools/*.mjs` 的构建脚本按 node:crypto 校验下载产物，不在这条口径内：
 *    它们不在运行时路径上、也不读 `pack.json`。）
 * 2. **校验锚不许拿非密码学哈希顶替** —— 市场包的**源码**里不许出现
 *    `foldDigest`/`stableHash`/`combineDigests`（那两个是 FNV 折叠，不是校验锚）。
 * 3. **版本比较全仓只许一份实现** —— `compareVersions` 的定义只准住在契约里。
 * 4. **落点目录名只住在契约常量里** —— 插件与内核只准引用常量，不许再写字面量。
 */

const ROOT = nodeResolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SELF = nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'tests', 'single-source.test.ts');
const ONLY_SHA_SOURCE = 'packages/plugins/kojo-market/src/digest.ts';
const ONLY_COMPARE_SOURCE = 'packages/plugin-api/src/market.ts';

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (statSync(dir).isFile()) {
    out.push(dir);
    return out;
  }
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target') continue;
    const p = nodeJoin(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string): string => nodeRel(ROOT, p).replaceAll('\\', '/');

/** 扫描面排除本文件（它自己就是这些正则的载体） */
function scan(patterns: RegExp[], roots: string[], skipComments = false): string[] {
  const files = roots.flatMap((r) => sourceFiles(r)).filter((f) => f !== SELF);
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!skipComments) {
      if (patterns.some((re) => re.test(text))) hits.push(rel(f));
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (patterns.some((re) => re.test(line))) {
        hits.push(`${rel(f)}:${t.slice(0, 60)}`);
        break;
      }
    }
  }
  return hits;
}

const ALL = [nodeJoin(ROOT, 'packages')];

describe('市场单一真源守门', () => {
  it('仓库根解析正确（判据不跑在假目录上）', () => {
    expect(readFileSync(nodeJoin(ROOT, 'package.json'), 'utf8')).toContain('"name": "kojo-editor"');
  });

  it('SHA-256 实现全仓唯一（真调用点，不是提及）', () => {
    expect(
      scan([/createHash\(\s*['"]sha256['"]\s*\)/, /\.digest\(\s*['"]SHA-256['"]\s*,/], ALL),
    ).toEqual([ONLY_SHA_SOURCE]);
  });

  it('市场包源码不拿非密码学哈希当校验锚', () => {
    expect(
      scan(
        [/foldDigest/, /stableHash/, /combineDigests/],
        [nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market')],
        true,
      ),
    ).toEqual([]);
  });

  it('compareVersions 的定义全仓唯一', () => {
    expect(scan([/^export function compareVersions\(/m], ALL)).toEqual([ONLY_COMPARE_SOURCE]);
  });

  it('落点目录名只住契约常量（构造落点的源码里不许写字面量）', () => {
    // manifest.ts 不在扫描面内：那里的 `packs` 是 index.json 的**字段名**（schema 自带），不是目录名
    const hits = scan([/'\.staging'/, /'packs'/, /'market'/], [
      nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src', 'service.ts'),
      nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src', 'index.ts'),
    ]);
    expect(hits).toEqual([]);
    const svc = readFileSync(nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src', 'service.ts'), 'utf8');
    for (const c of ['MARKET_PACKS_DIR', 'MARKET_STAGING_DIR', 'MARKET_CONTENT_DIR', 'MARKET_INDEX_FILE', 'MARKET_MANIFEST_FILE']) {
      expect(svc, c).toContain(c);
    }
  });
});
