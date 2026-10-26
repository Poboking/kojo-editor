import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin, relative as nodeRel, resolve as nodeResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * 本文件每个用例都要**全仓扫几遍**（各 3–5 s）。20 s 缺省超时在单跑时够用，在全量套件
 * 并行时不够——不是判据变钝了，是同一台机器同时在跑 800 多个测试文件。整文件如实声明慢，
 * 免得逐条打补丁（漏掉一条就是随机的红）。
 */
vi.setConfig({ testTimeout: 120000 });

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
 * 5. **宿主层只许发布上传摘要这一处哈希**（2026-10-18 修订）—— 扫描面含 `.rs`：
 *    下行校验锚（`pack.json` 的逐文件 / 整包 sha256）仍只住 TS；宿主的唯一例外是
 *    发布请求强制的 `x-market-zip-sha256`（必须描述实际上传字节，不能由预览结果代传），
 *    且该例外必须窄到 `market.rs` 的 `Sha256::new` 一处；`market_tests.rs` 的已知向量
 *    属测试夹具。其余 SHA-256 / sha2 / Digest:: / md5 出现即红。
 * 6. **出网只有一条路** —— market.rs 里 Client::builder 与 .send() 各恰一处、下载与取文本都经
 *    guarded_send；代理不从 JS 递进来（两个市场命令的签名里都没有 proxy 参数）。
 * 7. **远程面只有一个入口名** —— kernel.remote 的 fetchText：半截改名（桥一个名、服务另一个名）即红，
 *    且 FileIO 契约面上不许出现任何远程方法。
 */

const ROOT = nodeResolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SELF = nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'tests', 'single-source.test.ts');
const ONLY_SHA_SOURCE = 'packages/plugins/kojo-market/src/digest.ts';
const ONLY_COMPARE_SOURCE = 'packages/plugin-api/src/market.ts';
/** 宿主唯一允许的哈希：发布上传摘要（`market.rs` 一处）+ 其测试向量（`market_tests.rs`） */
const HOST_DIGEST_SOURCE = 'packages/app/src-tauri/src/market.rs';
const HOST_DIGEST_TEST_SOURCE = 'packages/app/src-tauri/src/market_tests.rs';

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
/**
 * 归档容器守卫（L0 批从 `market.rs` 抽出）：ZIP 容器原语、条目闸、命名闸、解压与字节上限住这里。
 * 「单源」判据口径不变——仍按**定义恰好一处**数，只是扫描面从单个文件变成容器侧的合并面
 * （拆文件不许让任何一条计数放宽；把实现复制回 `market.rs` 会当场翻倍即红）。
 */
const RUST_ARCHIVE_GUARD_RS = nodeJoin(RUST_SRC, 'archive_guard.rs');
const hostContainerSources = (): string =>
  readFileSync(RUST_MARKET_RS, 'utf8') + readFileSync(RUST_ARCHIVE_GUARD_RS, 'utf8');
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
    // `/tests/` 里的 node:crypto 是**对拍 oracle**（校验被测实现与标准库一致），不是第二份校验锚。
    expect(
      scan([/createHash\(\s*['"]sha256['"]\s*\)/, /\.digest\(\s*['"]SHA-256['"]\s*,/], ALL).filter(
        (f) => !f.includes('/tests/'),
      ),
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
    // 哈希扫描面必须真的扫到宿主两处（生产摘要 + 测试向量），不是空闸
    const hostHits = scan([/\bSha256\b/], [nodeJoin(ROOT, 'packages', 'app', 'src-tauri')], true);
    const hostFiles = [...new Set(hostHits.map((h) => h.split(':')[0]))].sort();
    // 测试向量不必出现 `Sha256` 字面；生产摘要所在的 market.rs 必须被扫到
    expect(hostFiles).toEqual([HOST_DIGEST_SOURCE]);
  });

  it('SHA-256 只住 TS（宿主唯一例外：发布上传容器摘要）', () => {
    const PATTERNS = [
      /createHash\(\s*['"]sha256['"]\s*\)/,
      /\.digest\(\s*['"]SHA-256['"]\s*,/,
      /\bSha256\b/,
      /\bsha2\b/,
      /Digest::/,
      /ring::digest/,
      /\bmd5\b/i,
    ];
    const hits = scan(PATTERNS, ALL).filter(
      (f) =>
        f !== HOST_DIGEST_SOURCE &&
        f !== HOST_DIGEST_TEST_SOURCE &&
        // 测试里用标准库做 oracle 不算第二份实现（同上一枚用例的口径）
        !f.includes('/tests/'),
    );
    expect(hits).toEqual([ONLY_SHA_SOURCE]);
    // 例外必须窄：宿主只准有一处上传摘要原语，且下行校验锚仍只住 TS
    const rs = readFileSync(RUST_MARKET_RS, 'utf8');
    expect(codeMatchCount(rs, /Sha256::new\s*\(/g), '宿主上传摘要原语处数').toBe(1);
    expect(rs, '上传摘要头').toContain('MARKET_ZIP_SHA256_HEADER');
    expect(rs).not.toMatch(/ring::digest/);
    // 除 market.rs / market_tests.rs 外，其他 Rust 源文件一个哈希原语都不许有
    expect(
      scan(PATTERNS, [RUST_SRC]).filter(
        (f) => f !== HOST_DIGEST_SOURCE && f !== HOST_DIGEST_TEST_SOURCE,
      ),
    ).toEqual([]);
  });

  it('出网只有两条形态（下载 / 发布），闸同一份形态两张表：client 构造与 send 各恰其数', () => {
    // 「两份判定必然漂」的机器版本：本层只要多出一次 Client::builder / 一次裸 send，
    // 白名单或逐跳重核就有人能绕过 ⇒ 计数而不是"有没有"。
    // 2026-10-16 发布通道批起出网 = 两条形态：下载（guarded_send）与发布（guarded_post），
    // **各一个 client**（双闸独立性：client 不共用，闸实现共用、放行表分开）。
    // 体积累计闸（`advance_byte_cap`）随容器闸一起搬进 `archive_guard.rs`（L0 批）：
    // 扫描面取容器侧合并面，定义 1 + 共用 1 这两条计数的口径不变。
    const rs = hostContainerSources();
    expect(codeMatchCount(rs, /Client::builder/), 'client 构造处数（下载 + 发布）').toBe(2);
    expect(codeMatchCount(rs, /\.send\(\)/), 'send 调用处数（guarded_send / guarded_post / 令牌）').toBe(3);
    expect(codeMatchCount(rs, /reqwest::get\b/), '不许有 reqwest::get 旁路').toBe(0);
    expect(codeMatchCount(rs, /guarded_send\s*\(/), 'guarded_send 定义 1 + 调用 2').toBe(3);
    expect(codeMatchCount(rs, /guarded_post\s*\(/), 'guarded_post 定义 1 + 发布调用 1').toBe(2);
    expect(codeMatchCount(rs, /advance_byte_cap\s*\(/), '体积累计闸定义 1 + 共用 1').toBe(2);
    expect(codeMatchCount(rs, /Policy::custom\s*\(/), '逐跳重核策略两条链路各一处（同一实现）').toBe(2);
    expect(codeMatchCount(rs, /redirect_action_for\s*\(/), '逐跳重核实现定义 1 + 两个 client 各 1').toBe(3);
    expect(codeMatchCount(rs, /url_problem_in\s*\(/), 'URL 闸参数化实现定义 1 + 下载/发布/逐跳各 1').toBe(4);
    expect(codeMatchCount(rs, /publish_host_in_allowlist\b/), '发布白名单定义 1 + PUBLISH_GATE 1').toBe(2);
    expect(codeMatchCount(rs, /\bhost_in_allowlist\b/), '下载白名单定义 1 + DOWNLOAD_GATE 1（前置 \\b 防误吸 publish_ 粘连）').toBe(2);
  });

  it('代理不从 JS 递进来：四个市场命令的签名里没有 proxy 参数（SSRF 收口）', () => {
    const rs = readFileSync(RUST_MARKET_RS, 'utf8');
    for (const cmd of ['market_download', 'market_fetch_text', 'market_publish', 'market_device_token']) {
      const m = new RegExp(`async fn ${cmd}\\(([\n\\s\\S]*?)\\n\\) ->`).exec(rs);
      expect(m, `找不到命令 ${cmd} 的签名`).not.toBeNull();
      expect(m![1]!.toLowerCase(), `${cmd} 的签名里出现了 proxy`).not.toContain('proxy');
    }
    // 四条链路都**固定** proxy: None ⇒ 代理只可能来自进程环境（reqwest system-proxy）
    expect(codeMatchCount(rs, /proxy: None,/), '四个命令各写一次 None').toBe(4);
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

/* ---------------- 2026-10-16 安装面批（KM-10..12）：容器原语与"一条路径"的机器闸 ---------------- */

const KOJO_MARKET_SERVICE = nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src', 'service.ts');
const UI_MARKET_SRC = nodeJoin(ROOT, 'packages', 'plugins', 'ui-market', 'src');
const CONTRACT_MARKET = nodeJoin(ROOT, 'packages', 'plugin-api', 'src', 'market.ts');

describe('安装面单一真源守门（KM-10..12）', () => {
  it('容器下载/解压/发布与 fetchText 同键同面：生产面只住那四个文件，Rust 只有五条市场命令', () => {
    // 新开一个服务键、或让某个插件自己 invoke Rust，都是"第二条远程路"——当场红。
    // `\b` 只钉**端口方法**：契约纯函数 `marketDownloadTimeoutMs` / `marketPublishTimeoutMs`
    // （住 market.ts）不许误命中。
    // 2026-10-16 发布通道批：`marketPublish` / `marketDeviceToken` 与下载同住那四个文件
    // （桥 / 内核透传 / 契约 / 服务），且各只出现一份。
    expect(
      scan([/marketDownload\b|marketExtract\b|marketPublish\b|marketDeviceToken\b/], PROD_SURFACE).map(rel).sort(),
    ).toEqual([
      'packages/app/src/bridge/tauri-bridge.ts',
      'packages/kernel/src/remote.ts',
      'packages/plugin-api/src/platform.ts',
      'packages/plugins/kojo-market/src/service.ts',
    ]);
    expect(codeMatchCount(readFileSync(RUST_MARKET_RS, 'utf8'), /#\[tauri::command\]/), 'market.rs 的命令数').toBe(5);
  });

  it('装卸与发布共用同一条校验路径：清单读取、搬运、双向对平、逐文件锚各只有一处', () => {
    const svc = readFileSync(KOJO_MARKET_SERVICE, 'utf8');
    // 定义 1 + 目录源 1 + 容器源 1 + 发布预校验 1 ⇒ 4；任何一条源自己另起一套读写都会让计数变大
    expect(codeMatchCount(svc, /readSourceManifest\s*\(/), '清单读取处数').toBe(4);
    expect(codeMatchCount(svc, /commitPack\s*\(/), '搬运路径处数').toBe(3);
    expect(codeMatchCount(svc, /parseManifest\s*\(/), '清单校验调用处数').toBe(1);
    expect(codeMatchCount(svc, /packContainerProblem\s*\(/), '双向对平调用处数（容器安装 1 + 发布预校验 1）').toBe(2);
    expect(codeMatchCount(svc, /'entry-sha256'/), '逐文件锚拒码处数').toBe(1);
    // 搬运 1 + 发布预校验 1 + zip 预判 2（stat 读不到 / readBytes 失败）
    expect(codeMatchCount(svc, /'source-unreadable'/), '源文件读不到拒码处数（搬运 1 + 发布预校验 1 + zip 预判 2）').toBe(4);
    expect(codeMatchCount(svc, /previewForPublish\s*\(/), '发布预校验定义 1 + 编排调用 1').toBe(2);
    expect(scan([/^export function packContainerProblem\(/m], ALL)).toEqual([
      'packages/plugins/kojo-market/src/manifest.ts',
    ]);
  });

  it('容器名只从契约派生：TS 运行时面不出现 .zip 字面量，Rust 那道闸也没被放宽', () => {
    const names = [
      KOJO_MARKET_SERVICE,
      nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src', 'index.ts'),
      nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src', 'manifest.ts'),
    ];
    // 拦的是**自己拼容器名的字符串字面量**（`entry.zip.url` 那种属性访问不算）；
    // skipComments：文件头的链路图里要写 `.staging/<id>-<version>.zip` 说明落点形态。
    expect(scan([/['"]\.(?:zip|unpacked)['"]/], names, true), '容器名应当只由契约派生').toEqual([]);
    // 面板连暂存区都不该知道（"面板不摸盘"那条纪律的延伸）
    expect(scan([/'\.staging'/, /'packs'/, /'\.zip'/], [UI_MARKET_SRC])).toEqual([]);
    expect(codeMatchCount(readFileSync(CONTRACT_MARKET, 'utf8'), /^export function packContainerName\(/m), '容器名派生处数').toBe(1);
    const rs = hostContainerSources();
    // 容器名后缀闸的**单源形态**（W14 之后）：这道闸不再持有本地常量，而是读编译期内嵌的
    // 共享表（`plugin-api/fixtures/zip-roundtrip/contract.json`）——判因此从"本地那个
    // `ZIP_SUFFIX` 被用了一次"变成"表里那一次 `ends_with(rule.suffix.as_str())`"。
    // 三条计数一条都不放宽：表读第二次、退回本地字面量、留一份 `".zip"` 硬编码，都当场红。
    // L0 批把这道闸搬进 `archive_guard.rs` ⇒ 扫描面取容器侧合并面（计数口径不变）。
    expect(
      rs,
      '后缀闸必须读内嵌共享表（include_str! 的那份 contract.json）',
    ).toContain('include_str!("../../../plugin-api/fixtures/zip-roundtrip/contract.json")');
    expect(codeMatchCount(rs, /ends_with\(rule\.suffix\.as_str\(\)\)/), '容器名后缀闸处数（读共享表那一次）').toBe(1);
    expect(codeMatchCount(rs, /ZIP_SUFFIX/), 'Rust 侧不许再留本地后缀常量').toBe(0);
    expect(codeMatchCount(rs, /"\.zip"/), 'Rust 侧不许再写死后缀字面量').toBe(0);
    expect(codeMatchCount(rs, /container_name_problem\s*\(/), '定义 1 + 下载与解压各 1').toBe(3);
  });

  it('解压限额三个数只住契约：service 里不许出现第二个 5000 / 128 MiB', () => {
    const svc = readFileSync(KOJO_MARKET_SERVICE, 'utf8');
    expect(codeMatchCount(svc, /\b5000\b/), '条目数上限的字面量').toBe(0);
    expect(codeMatchCount(svc, /134217728|128 \* 1024 \* 1024/), '解压体积上限的字面量').toBe(0);
    for (const c of ['MARKET_MAX_FILE_ENTRIES', 'MARKET_MAX_PATH_DEPTH', 'MARKET_MAX_UNPACKED_BYTES']) {
      expect(svc, c).toContain(c);
    }
  });

  it('版本比较与三态判定只住契约：面板只消费 packUpdateCheck，不自己比版本', () => {
    expect(
      scan([/compareVersions|PackUpdateState/], [UI_MARKET_SRC], true).map((s) => String(s)),
      '面板自己比版本 = 第二份口径',
    ).toEqual([]);
    expect(codeMatchCount(readFileSync(CONTRACT_MARKET, 'utf8'), /^export function packUpdateCheck\(/m), '三态判定定义处数').toBe(1);
    expect(scan([/PackUpdateState|packUpdateCheck/], [nodeJoin(ROOT, 'packages', 'kernel')], true)).toEqual([]);
  });
});

/* ---------------- 2026-10-17 MK-1：即时失效 + 两套更新语义并一 的机器闸 ---------------- */

const APP_UPDATE_CHECK = nodeJoin(ROOT, 'packages', 'app', 'src', 'ui', 'update-check.ts');
const UI_MARKET_RECONCILE = nodeJoin(ROOT, 'packages', 'plugins', 'ui-market', 'src', 'reconcile.ts');
const UI_MARKET_PANEL = nodeJoin(ROOT, 'packages', 'plugins', 'ui-market', 'src', 'index.ts');
const UI_MARKET_VIEW = nodeJoin(UI_MARKET_SRC, 'market-view.ts');

describe('更新语义与即时失效的单一真源守门（MK-1）', () => {
  it('关系判定只有一条实现链：updateRelationOf 只住契约，宿主侧只接 compareVersions 不许自己数点号', () => {
    expect(scan([/^export function updateRelationOf\(/m], ALL)).toEqual([ONLY_COMPARE_SOURCE]);
    const app = readFileSync(APP_UPDATE_CHECK, 'utf8');
    expect(app, '宿主侧要用契约那把尺').toContain('compareVersions');
    expect(codeMatchCount(app, /split\(\s*['"]\.\s*['"]\s*\)/), '宿主侧自己数点号的处数').toBe(0);
    expect(scan([/compareVersions|updateRelationOf/], [UI_MARKET_SRC], true)).toEqual([]);
  });

  it('失败话术只有两处生成点（契约 + 宿主复刻），面板零处：面板只显示 failure.note', () => {
    expect(scan([/^export function makeUpdateFailure\(/m], ALL)).toEqual([ONLY_COMPARE_SOURCE]);
    // 扫描面 = **更新链路那几个文件**（别的插件里"重新保存即可重试"那种话不算第二套更新话术）
    const withRetry = scan(
      [/可重试/],
      [
        CONTRACT_MARKET,
        APP_UPDATE_CHECK,
        UI_MARKET_SRC,
        nodeJoin(ROOT, 'packages', 'plugins', 'kojo-market', 'src'),
      ],
      true,
    )
      .map((s) => String(s).split(':')[0])
      .sort();
    expect(withRetry).toEqual([
      'packages/app/src/ui/update-check.ts',
      'packages/plugin-api/src/market.ts',
    ]);
    expect(readFileSync(UI_MARKET_VIEW, 'utf8')).toContain('failure?.note');
  });

  it('清单变更只有一个发出点、一个订阅面：装卸两条路共用同一条通知，面板不自己定时轮询', () => {
    const svc = readFileSync(KOJO_MARKET_SERVICE, 'utf8');
    expect(codeMatchCount(svc, /notifyInstalledChanged\s*\(/), '通知调用点处数').toBe(3);
    const missAt = svc.indexOf("'installed-missing'");
    const notifyAt = svc.indexOf("notifyInstalledChanged('uninstalled'");
    expect(missAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeGreaterThan(missAt);
    expect(
      scan([/onInstalledChanged/], [UI_MARKET_SRC], true)
        .map((s) => String(s).split(':')[0])
        .sort(),
    ).toEqual(['packages/plugins/ui-market/src/reconcile.ts']);
    expect(scan([/onInstalledChanged/], [nodeJoin(ROOT, 'packages', 'app', 'src')], true)).toEqual([]);
    for (const f of [UI_MARKET_PANEL, UI_MARKET_RECONCILE]) {
      expect(codeMatchCount(readFileSync(f, 'utf8'), /setTimeout\(|setInterval\(/), rel(f)).toBe(0);
    }
  });

  it('市场取数纪律不动：仍然只读盘上那份 index.json（不新增第二条远程路、不碰 latest）', () => {
    expect(scan([/releases\/latest/], MARKET_CODE_SURFACE, true)).toEqual([]);
    expect(scan([/marketDownload\b|marketExtract\b/], PROD_SURFACE).map(rel).sort()).toEqual([
      'packages/app/src/bridge/tauri-bridge.ts',
      'packages/kernel/src/remote.ts',
      'packages/plugin-api/src/platform.ts',
      'packages/plugins/kojo-market/src/service.ts',
    ]);
  });
});
