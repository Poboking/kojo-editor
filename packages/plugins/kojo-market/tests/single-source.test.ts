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
 * 5. **宿主层不算任何哈希**（2026-10-15 扩面）—— 扫描面含 `.rs`：Rust 侧出现 SHA-256 / sha2 /
 *    Digest:: / md5 任何一处即红（"哈希只住 TS"过去只有注释担保，现在有机器闸）。
 * 6. **出网只有一条路** —— market.rs 里 Client::builder 与 .send() 各恰一处、下载与取文本都经
 *    guarded_send；代理不从 JS 递进来（两个市场命令的签名里都没有 proxy 参数）。
 * 7. **远程面只有一个入口名** —— kernel.remote 的 fetchText：半截改名（桥一个名、服务另一个名）即红，
 *    且 FileIO 契约面上不许出现任何远程方法。
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
    // `.rs` 也在扫描面内（2026-10-15）：哈希锚只许住 TS，宿主层"顺手算一份"就是第二份实现，
    // 而它过去**只有注释担保** ⇒ 没有机器闸。`src-tauri/target` 按目录名跳过，不会扫进依赖。
    else if (/\.(ts|tsx|mts|rs)$/.test(name)) out.push(p);
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

/** 宿主层（Rust）源码目录与两个关键文件：出网判定与哈希口径都住这里 */
const RUST_SRC = nodeJoin(ROOT, 'packages', 'app', 'src-tauri', 'src');
const RUST_MARKET_RS = nodeJoin(RUST_SRC, 'market.rs');
const TAURI_BRIDGE = nodeJoin(ROOT, 'packages', 'app', 'src', 'bridge', 'tauri-bridge.ts');

/**
 * 远程入口的**生产面**（不含 tests：测试替身允许出现方法名，产品代码里出现第二处才是要防的事）。
 */
const PROD_SURFACE = [
  nodeJoin(ROOT, 'packages', 'plugin-api', 'src'),
  nodeJoin(ROOT, 'packages', 'kernel', 'src'),
  nodeJoin(ROOT, 'packages', 'plugins'),
  nodeJoin(ROOT, 'packages', 'app', 'src'),
].flatMap((r) => sourceFiles(r)).filter((f) => !/(^|[\\/])(tests|__tests__)([\\/]|$)/.test(f));

/** 注释行（TS 的 `//` `/*` `*` 续行 + Rust 的 `//` `///` `//!`）：误伤口径与 `scan(skipComments)` 一致 */
function isCommentLine(t: string): boolean {
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/** 数**代码行**里的匹配处数（注释里"提到"不算实现点）；入参是文件内容原文 */
function codeMatchCount(text: string, re: RegExp): number {
  const per = new RegExp(re.source, re.flags.replace('g', '').replace('m', '') + 'g');
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (isCommentLine(t)) continue;
    const hits = t.match(per);
    if (hits !== null) n += hits.length;
  }
  return n;
}

/**
 * 市场语义的**运行时代码面**（A5/A3 守卫用）：注册表怎么被读、落点怎么派生，
 * 这几处是后来者会顺手"加个 latest / 存个路径"的地方，注释拦不住，测试拦得住。
 */
const MARKET_CODE_SURFACE = [
  nodeJoin(ROOT, 'packages', 'plugin-api', 'src', 'market.ts'),
  nodeJoin(ROOT, 'packages', 'kernel', 'src'),
  nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market'),
  nodeJoin(ROOT, 'packages', 'plugins', 'ui-market'),
  nodeJoin(ROOT, 'packages', 'app', 'src'),
];

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

  it('市场只认 index.json：代码行里不许出现 releases/latest（契约 A5）', () => {
    // 实测：`make_latest=false` 去不掉 GitHub 的 Latest 徽章（GET /releases/latest 照样 200），
    // 所以"哪个是最新"在平台上根本不可靠 —— 版本事实一律从 index.json 的条目读。
    // skipComments：契约里那条说明自身要提到这个字面量，注释不算违规。
    expect(scan([/releases\/latest/], MARKET_CODE_SURFACE, true)).toEqual([]);
  });

  it('已装记录里没有第二份真相：无落点字段、无一词两义的容器摘要（契约 A2/A3）', () => {
    expect(scan([/^\s*dir:\s/, /zipSha256/], [nodeJoin(ROOT, 'packages', 'plugin-api', 'src', 'market.ts')], true)).toEqual([]);
    const contract = readFileSync(nodeJoin(ROOT, 'packages', 'plugin-api', 'src', 'market.ts'), 'utf8');
    for (const f of ['contentDigest', 'containerSha256']) expect(contract, f).toContain(f);
  });

  /* ---------------- 2026-10-15 收口批：远程面 + 宿主层哈希的机器闸 ---------------- */

  it('扫描面真的含 .rs（哈希守卫不是"只扫 TS"的空闸）', () => {
    const rs = sourceFiles(RUST_SRC).filter((f) => f.endsWith('.rs')).map(rel);
    for (const must of ['market.rs', 'lib.rs', 'market_tests.rs']) {
      expect(rs.some((p) => p.endsWith(must)), `${must} 不在扫描面内`).toBe(true);
    }
    // `target` 目录按名跳过 ⇒ 依赖源码不算违例（否则整棵树都是红的）
    expect(rs.some((p) => p.includes('/target/')), 'target 目录漏进了扫描面').toBe(false);
    expect(scan([/\bSha256\b/], [nodeJoin(ROOT, 'packages', 'app', 'src-tauri')], true)).toEqual([]);
  });

  it('SHA-256 只住 TS：宿主层出现哈希原语即红（含 .rs）', () => {
    expect(
      scan(
        [
          /createHash\(\s*['"]sha256['"]\s*\)/,
          /\.digest\(\s*['"]SHA-256['"]\s*,/,
          /\bSha256\b/,
          /\bsha2\b/,
          /Digest::/,
          /ring::digest/,
          /\bmd5\b/i,
        ],
        ALL,
      ),
    ).toEqual([ONLY_SHA_SOURCE]);
  });

  it('出网只有一条路：client 构造与 send 各恰一处，下载与取文本都经 guarded_send', () => {
    // 「两份判定必然漂」的机器版本：本层只要多出一次 Client::builder / 一次裸 send，
    // 白名单或逐跳重核就有人能绕过 ⇒ 计数而不是"有没有"。
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /Client::builder/), 'client 构造处数').toBe(1);
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /\.send\(\)/), 'send 调用处数').toBe(1);
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /reqwest::get\b/), '不许有 reqwest::get 旁路').toBe(0);
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /guarded_send\s*\(/), 'guarded_send 定义 1 + 调用 2').toBe(3);
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /advance_byte_cap\s*\(/), '体积累计闸定义 1 + 共用 1').toBe(2);
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /Policy::custom\s*\(/), '逐跳重核策略只许一处').toBe(1);
  });

  it('代理不从 JS 递进来：两个市场命令的签名里没有 proxy 参数（SSRF 收口）', () => {
    const rs = readFileSync(RUST_MARKET_RS, 'utf8');
    for (const cmd of ['market_download', 'market_fetch_text']) {
      const m = new RegExp(`async fn ${cmd}\\(([\n\\s\\S]*?)\\n\\) ->`).exec(rs);
      expect(m, `找不到命令 ${cmd} 的签名`).not.toBeNull();
      expect(m![1].toLowerCase(), `${cmd} 的签名里出现了 proxy`).not.toContain('proxy');
    }
    // 两条链路都**固定** proxy: None ⇒ 代理只可能来自进程环境（reqwest system-proxy）
    expect(codeMatchCount(rs, /proxy: None,/), '两个命令各写一次 None').toBe(2);
    expect(readFileSync(TAURI_BRIDGE, 'utf8').toLowerCase()).not.toContain('proxy');
  });

  it('远程面只有一个入口名：fetchRemoteText 全仓 0 次，生产面 fetchText 只住四个文件', () => {
    // 半截改名（桥一个名、服务另一个名）就是"两条路"的开始 ⇒ 当场统一并钉住
    expect(scan([/fetchRemoteText/], ALL)).toEqual([]);
    expect(
      scan([/fetchText/], PROD_SURFACE).map(rel).sort(),
    ).toEqual([
      'packages/app/src/bridge/tauri-bridge.ts',
      'packages/kernel/src/remote.ts',
      'packages/plugin-api/src/platform.ts',
      'packages/plugins/kojo-market/src/service.ts',
    ]);
    // FileIO 契约面上没有任何远程方法（远程走 `kernel.remote`，两处并存 = 两份真相）
    expect(scan([/fetchText|fetchRemote|\bhttps?:\/\//], [nodeJoin(ROOT, 'packages', 'plugin-api', 'src', 'io.ts'), nodeJoin(ROOT, 'packages', 'kernel', 'src', 'io.ts')], true)).toEqual([]);
  });
});
