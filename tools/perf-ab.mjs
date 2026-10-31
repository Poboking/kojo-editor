#!/usr/bin/env node
/**
 * perf-ab.mjs —— **同树 A/B 量具**（F 批 / R10，2026-10-31）。
 *
 * ## 它解决什么
 *
 * `docs/STATE.md` §四 记着此前每批 A/B 都是手搓：`git worktree add` + 两份独立
 * `KOJO_MEM_STORAGE_DIR` + 肉眼对两段日志。够用，但"每次都要人记得同样的口径"——
 * 忘了交替跑就吃机器漂移，忘了清存储就把热载当冷开，忘了多轮就只看一次噪声。
 * 口径一散，两批读数就不可比，而性能结论全靠跨批比较。
 *
 * 本文件把口径钉死成代码：
 *
 * 1. **两侧必不同源**：`--a` / `--b` 是 git ref 时各建一棵游离树（`git worktree add --detach`）；
 * 2. **交替跑**：第 1 轮 A→B，第 2 轮 B→A ……机器温度 / 后台进程 / OS 文件缓存这些
 *    时间相关的漂移对两侧**同权**，而不是全压在 B 头上；
 * 3. **多轮取中位数**：`--rounds`（默认 4，偶数才对称）≥3 时取中位数而不是均值——一次 GC 抖动就能把均值拉歪；
 * 4. **A/A 自证**：`--a` 与 `--b` 同 ref 时自动进入自证模式，判据 **比值 1.00±0.08**。
 *    这是量具的准入门槛：连"同一份代码跑两遍"都测不出 1.00 的话，它给出的任何 A/B
 *    结论都只是噪声的另一种排列。
 *
 * ## 为什么依赖用 junction 而不是 pnpm install
 *
 * 游离树没有 `node_modules`（被 gitignore），而 `packages/kernel/tests/helpers/node-bridge.ts`
 * 要 `iconv-lite`、`eratw-adapter` 要 `react`。`pnpm install` 能解决但要联网、要几分钟，
 * 且会重写 `pnpm-lock.yaml`。这里改为**把主树每个 `node_modules` 目录 junction 到游离树同位置**
 * （`fs.symlinkSync(..., 'junction')`，Windows 免管理员）。第三方包本来就是同一份，链接过去不改变语义。
 *
 * **风险与对策**：pnpm 会在 `node_modules/@kojo/` 里放**相对符号链接**（`../../../plugin-api`），
 * junction 之后它们会解析到主树源码 ⇒ "两侧其实跑同一份代码"。所以探针 `perf-cold-open.mjs`
 * 用 `registerHooks` 把 `@kojo/` 前缀强制指回**本树**的 `packages/<name>/src`，并在跑完自证每一条落点
 * 都在本树内（`[probe] selfcheck=ok`）。量具这边把 `selfcheck != ok` 的行直接判红。
 *
 * ## 跑法
 *
 * ```
 * # 自证（量具准入门槛）
 * node tools/perf-ab.mjs --a HEAD --b HEAD --corpus "$(node tools/corpus.mjs --print)"
 *
 * # 真实 A/B
 * node tools/perf-ab.mjs --a HEAD~1 --b HEAD --rounds 3 --corpus <语料>
 *
 * # 用现成目录（已有两棵手工树时）
 * node tools/perf-ab.mjs --a /tmp/before --b . --corpus <语料>
 *
 * # 只量某几个指标 + JSON 输出
 * node tools/perf-ab.mjs --a HEAD~1 --b HEAD --metric total_ms --metric seg_refs --json
 * ```
 *
 * 退出码：0＝跑完且判据通过（A/A 自证 / 非自证模式恒 0）；1＝判据未过；2＝配置错误；
 * 3＝任一轮探针失败（含探针自证判红）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/* ============================== 参数 ============================== */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);
/** `--metric x` 可重复；也认 `--metric=x` */
const many = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${name}=`)) out.push(argv[i].slice(name.length + 1));
  }
  return out;
};

if (has('--help') || has('-h') || argv.length === 0) {
  console.log(`用法：node tools/perf-ab.mjs --a <ref|目录> --b <ref|目录> [选项]

  --a <ref|dir>         A 侧：git ref（建游离树）或现成目录
  --b <ref|dir>         B 侧
  --corpus <dir>        语料目录（默认 KOJO_SMOKE_PROJECT）
  --rounds N            轮数，默认 4（偶数才两侧对称）；每轮两侧各跑一次，顺序交替
  --rounds-ahead N      正式读数前先跑的丢弃轮（默认 0；文件缓存未热时可设 1）
  --metric <name>       只报这些指标（可重复；默认全部数值指标）
  --probe-arg <arg>     透传给探针的参数（可重复，两侧共用）
  --probe-a <arg>       只给 A 侧的探针参数（可重复）
  --probe-b <arg>       只给 B 侧的探针参数（可重复；与 --probe-a 不同则不进自证模式）
  --tolerance X         判据宽容度，默认 0.08（即 1.00±0.08）
  --timeout-ms N        单次探针超时，默认 180000
  --keep                保留游离树与探针输出（排错用）
  --json                机器可读输出
  --help

A/A 自证（--a 与 --b 同 ref）是量具的准入门槛：比值必须落在 1.00±tolerance 内。`);
  process.exit(0);
}

const CORPUS = resolve(flag('--corpus', process.env.KOJO_SMOKE_PROJECT ?? ''));
const A_SPEC = flag('--a', '');
const B_SPEC = flag('--b', '');
/**
 * 默认 **4 轮**而不是 3 轮：交替序列 `A B | B A | A B | B A` 才让两侧各占两次前半、两次后半。
 * 3 轮是 `A B | B A | A B`——A 占两次前半、B 只占一次，位置效应（先跑的那侧吃冷文件缓存）
 * 会单边压在 A 头上。实测 1 轮时后跑者白得 **7%**，正好是判据宽容度的量级，不能不管。
 */
const ROUNDS = Math.max(1, Number(flag('--rounds', '4')) || 4);
const ROUNDS_AHEAD = Math.max(0, Number(flag('--rounds-ahead', '0')) || 0);
const TOLERANCE = Number(flag('--tolerance', '0.08')) || 0.08;
const TIMEOUT_MS = Number(flag('--timeout-ms', '180000')) || 180_000;
const KEEP = has('--keep');
const JSON_OUT = has('--json');
const WANT_METRICS = many('--metric');
/**
 * 透传给探针的额外参数（可重复）。用途是"对烤量具自己"：
 *
 * ```
 * node tools/perf-ab.mjs --a HEAD --b HEAD --probe-a "--parallel" --probe-a "0" --rounds 2
 * ```
 *
 * 两侧可以给不同的参数（`--probe-a` / `--probe-b`），这样就能拿一个**已知有差异**的
 * 开关去验证量具"有差异时能不能测出来"——A/A 自证只证明它不乱报，灵敏度得另外证。
 */
const PROBE_ARGS_A = many('--probe-a');
const PROBE_ARGS_B = many('--probe-b');
const PROBE_ARGS = many('--probe-arg');

if (A_SPEC === '' || B_SPEC === '') {
  console.error('[perf-ab] 两侧都要给：--a <ref|目录> --b <ref|目录>（用法见 --help）');
  process.exit(2);
}

if (CORPUS === '' || !existsSync(CORPUS)) {
  console.error(`[perf-ab] 语料不在位：${CORPUS === '' ? '(未指定)' : CORPUS}`);
  console.error('[perf-ab] 用 --corpus <目录> 指定，或先跑 node tools/corpus.mjs --print');
  process.exit(2);
}

/* ============================== 工具 ============================== */

const log = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

/** git 输出统一从仓库根跑，避免 cwd 漂移（`--a` 用相对 ref 时必须锚在主树上） */
const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 180_000, ...opts });
  if (r.status !== 0) {
    const detail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`git ${args.join(' ')} 失败：${detail}`);
  }
  return `${r.stdout ?? ''}`;
};

/** `git rev-parse --verify <ref>^{commit}`：验证 ref 存在并解析成 commit sha（短 sha 也能用） */
const revParse = (ref) => git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();

/* ============================== 侧（side）解析 ============================== */

/** 游离树根目录：放系统临时目录，跑完删（`--keep` 时保留并打印路径） */
const WORK_ROOT = mkdtempSync(join(tmpdir(), 'kojo-perf-ab-'));

/**
 * 编译缓存**固定**在临时目录下、不随这一次的 `WORK_ROOT` 删除。
 *
 * 一次冷开要转译 400+ 个 TS 文件，实测**每次启动 ~15s**——它不在测量窗口里（探针用
 * `performance.now()` 只框住 `open()` 到索引 ready），但会把批跑时间乘以二：4 轮 × 2 次
 * 就是 8 次冷启动 ≈ 2 分钟纯浪费。缓存 key 是文件内容哈希 ⇒ 两侧代码不同就各存各的，
 * 不会让 A/B 互相污染。
 */
const COMPILE_CACHE = join(tmpdir(), 'kojo-perf-ab-compile-cache');

/**
 * 把一个 `--a/--b` 参数解析成可测量的目录。
 *
 * 目录与 ref 的区别按"存在与否"判断——`--a .`（当前树）和 `--a dev`（ref）都合法，
 * 而目录名恰好与分支名同名时优先目录（人给的是路径，意图更明确）。
 */
function resolveSide(spec, name) {
  const asDir = resolve(REPO, spec);
  if (existsSync(asDir) && existsSync(join(asDir, 'packages'))) {
    return { name, spec, dir: asDir, commit: null, owned: false };
  }
  const commit = revParse(spec);
  const dir = join(WORK_ROOT, `${name}-${commit.slice(0, 8)}`);
  log(`[perf-ab] ${name}: ${spec} (${commit.slice(0, 8)}) → 建游离树 ${dir}`);
  // `--detach` 避免"分支已被另一棵 worktree 占用"（同一分支不能在两处 checkout）
  git(['worktree', 'add', dir, commit, '--detach']);
  return { name, spec, dir, commit, owned: true };
}

/**
 * 把主树的 `node_modules` 逐个 junction 到目标树同位置。
 *
 * 只补**缺失**的那些：目标树若是现成目录（本来就有 node_modules），一个都不动。
 * 用 `'junction'` 而不是 `'dir'`：Windows 上 junction 不需要管理员权限或开发者模式。
 *
 * 返回**建了哪些链接**——清理时必须先逐个摘掉它们再删目录。理由是安全：递归删除一棵
 * 里面有 42 个 junction 的树，等于让删除器走进主树的 `node_modules`（那里有 124 个包）。
 * 本机 WorkBuddy 的 safe-delete 垫片恰好拦下了（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），
 * 但那是运气，不是设计——换个没有垫片的环境就是删穿。**先摘链接、再删树**是这里的铁律。
 */
function linkNodeModules(fromRoot, toRoot) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === 'node_modules') {
        found.push(join(dir, e.name));
        continue; // 不往 node_modules 里递归
      }
      if (e.name.startsWith('.') || e.name === 'dist' || e.name === 'target') continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(fromRoot, 0);

  const created = [];
  for (const src of found) {
    const rel = relative(fromRoot, src);
    const dst = join(toRoot, rel);
    if (existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      symlinkSync(src, dst, 'junction');
      created.push(dst);
    } catch (err) {
      log(`[perf-ab] 警告：${rel} 链接失败（${err.code ?? err.message}）`);
    }
  }
  return { total: found.length, linked: created.length, created };
}

/**
 * 拆掉一棵游离树：**先摘 junction、再删目录**。
 *
 * `rmdirSync` 对 junction 是"只摘链接、不进目标"（Windows 与 POSIX 的目录链接语义一致），
 * 所以这一步是安全的；反过来直接 `rmSync` 递归就会顺着链接走进去。
 */
function teardownSide(side) {
  for (const link of side.links ?? []) {
    try {
      rmSync(link, { recursive: false, force: true });
    } catch {}
  }
  if (side.owned === true) {
    try {
      git(['worktree', 'remove', '--force', side.dir]);
      return;
    } catch {
      // git 删不掉（目录里有未跟踪残留）时再兜底；此时 junction 已摘，递归是安全的
    }
  }
  try {
    rmSync(side.dir, { recursive: true, force: true });
  } catch (err) {
    log(`[perf-ab] 提示：${side.dir} 未能自动清理（${err.code ?? err.message}），可手动删除`);
  }
}

/**
 * 确保探针在目标树里。
 *
 * A 侧常是旧 ref，那时 `tools/perf-cold-open.mjs` 还不存在——从本树复制过去。这不是"用新代码
 * 测旧代码"：探针只是量具（读产品自己打的 `index breakdown`），被测的是那棵树的 `packages/`。
 * 反过来，如果探针**存在但不兼容**（旧树缺 `parser.currentIndex()` 之类），探针会自己判红，
 * 那时该做的是给旧 ref 也补同一个探针，而不是让量具去猜。
 */
function ensureProbe(root) {
  const probe = join(root, 'tools/perf-cold-open.mjs');
  if (existsSync(probe)) {
    // 两侧探针必须同版本，否则读数不同源（改法：让两侧都用本树这一份）
    const mine = readFileSync(join(REPO, 'tools/perf-cold-open.mjs'), 'utf8');
    if (readFileSync(probe, 'utf8') !== mine) {
      log(`[perf-ab] ${basename(root)}：探针与主树不一致 → 用主树版本覆盖（量具必须同源）`);
      writeFileSync(probe, mine, 'utf8');
    }
    return probe;
  }
  log(`[perf-ab] ${basename(root)}：无探针 → 从主树复制（旧 ref 的常态）`);
  mkdirSync(dirname(probe), { recursive: true });
  writeFileSync(probe, readFileSync(join(REPO, 'tools/perf-cold-open.mjs'), 'utf8'), 'utf8');
  return probe;
}

/* ============================== 跑一轮 ============================== */

/**
 * 在某一侧跑一次探针，返回 `{ metrics, ok, reason }`。
 *
 * 探针输出是 `[probe] key=value` 一行一条。这里不做"猜哪个是指标"——凡值能转成有限数的都收，
 * 空值（探针没拿到那条日志）跳过。`--metric` 只影响**报表**，不影响采集。
 */
function runOnce(side, probe, round) {
  const t0 = Date.now();
  const extra = [...PROBE_ARGS, ...(side.name === 'A' ? PROBE_ARGS_A : PROBE_ARGS_B)];
  const r = spawnSync(process.execPath, [probe, '--corpus', CORPUS, '--label', `${side.name}${round}`, ...extra], {
    cwd: side.dir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      KOJO_SMOKE_PROJECT: CORPUS,
      NODE_COMPILE_CACHE: COMPILE_CACHE,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const wall = Date.now() - t0;

  if (r.error?.code === 'ETIMEDOUT') return { ok: false, reason: `超时 ${TIMEOUT_MS}ms`, out, wall, metrics: {} };
  if (r.status !== 0) {
    const tail = out.trim().split('\n').slice(-4).join(' | ');
    return { ok: false, reason: `退出码 ${r.status}：${tail}`, out, wall, metrics: {} };
  }

  const metrics = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\[probe\] ([a-z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m;
    if (raw === '' || raw === '/') continue; // 探针没拿到那条日志
    const n = Number(raw);
    if (Number.isFinite(n)) metrics[key] = n;
    else if (key === 'selfcheck' || key === 'tree' || key === 'fatal') metrics[key] = raw;
  }

  // 探针自证判红：这里必须拦住，否则"两侧跑同一份代码"会以漂亮的 1.00 混过去
  if (metrics.selfcheck !== 'ok') return { ok: false, reason: `探针自证失败 selfcheck=${metrics.selfcheck}`, out, wall, metrics };
  if (metrics.cold !== 1) return { ok: false, reason: `不是冷开 cold=${metrics.cold}`, out, wall, metrics };

  return { ok: true, metrics, out, wall };
}

/* ============================== 统计 ============================== */

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/** 极差占中位数的比例：用来判断"这轮读数离散得能不能用" */
const spread = (xs) => {
  if (xs.length < 2) return null;
  const m = median(xs);
  if (m === 0) return null;
  return (Math.max(...xs) - Math.min(...xs)) / m;
};

/* ============================== 主流程 ============================== */

const startedAt = Date.now();
let sides = [];
let failed = null;
let selfCheckMode = false;
const samples = { A: [], B: [] };

try {
  sides = [resolveSide(A_SPEC, 'A'), resolveSide(B_SPEC, 'B')];

  /**
   * A/A 自证模式：两侧是**同一份代码**。
   *
   * 按 commit 比而不是 ref 字面量（`HEAD` 与 `head`、`dev` 与 `origin/dev` 指向同一 commit 时都是自证）。
   * 目录模式要额外小心：两侧都是现成目录时 commit 都是 null，`null === null` 会把"两个不同目录"
   * 误判成自证——那会让量具拿一个真实的 A/B 结果去套 ±8% 判据，报出莫名其妙的红。
   */
  selfCheckMode = sides[0].commit !== null && sides[0].commit === sides[1].commit;
  if (sides[0].dir === sides[1].dir) selfCheckMode = true;
  /**
   * 两侧探针参数不同 ⇒ 这是**故意的对烤**，不是自证。
   *
   * 不加这一条的话，`--a HEAD --b HEAD --probe-a --parallel --probe-a 0` 会走进自证模式，
   * 然后因为"比值 2.0"判红——而那次红恰恰是量具有效的证据，语义正好反过来。
   */
  if (JSON.stringify(PROBE_ARGS_A) !== JSON.stringify(PROBE_ARGS_B)) selfCheckMode = false;

  for (const side of sides) {
    const { total, linked, created } = linkNodeModules(REPO, side.dir);
    side.links = created;
    if (total > 0) log(`[perf-ab] ${side.name}: node_modules ${linked}/${total} 个已链接`);
    side.probe = ensureProbe(side.dir);
  }

  log(
    `[perf-ab] 语料 ${CORPUS}\n` +
      `[perf-ab] A=${sides[0].spec}  B=${sides[1].spec}  轮数 ${ROUNDS}${ROUNDS_AHEAD > 0 ? `（预热丢弃 ${ROUNDS_AHEAD}）` : ''}` +
      `${selfCheckMode ? '  [A/A 自证模式]' : ''}`,
  );

  const totalRounds = ROUNDS_AHEAD + ROUNDS;
  for (let round = 0; round < totalRounds; round += 1) {
    // 交替：偶轮 A→B，奇轮 B→A。机器漂移对两侧同权，而不是永远让 B 吃后半程。
    const order = round % 2 === 0 ? [0, 1] : [1, 0];
    for (const idx of order) {
      const side = sides[idx];
      const res = runOnce(side, side.probe, round);
      const tag = `第 ${round + 1}/${totalRounds} 轮 ${side.name}`;
      if (!res.ok) {
        failed = `[perf-ab] ${tag} 失败：${res.reason}`;
        break;
      }
      if (round >= ROUNDS_AHEAD) {
        samples[side.name].push(res.metrics);
        const brief = ['total_ms', 'index_ms', 'seg_readparse', 'seg_refs', 'seg_walk']
          .filter((k) => res.metrics[k] !== undefined)
          .map((k) => `${k}=${res.metrics[k]}`)
          .join(' ');
        log(`[perf-ab] ${tag}  ✅ wall=${res.wall}ms  ${brief}`);
      } else {
        log(`[perf-ab] ${tag}  预热丢弃  wall=${res.wall}ms`);
      }
    }
    if (failed !== null) break;
  }
} catch (err) {
  failed = `[perf-ab] 失败：${err.message}`;
} finally {
  if (failed === null || !KEEP) {
    for (const side of sides) teardownSide(side);
    if (!KEEP && existsSync(WORK_ROOT)) {
      try {
        rmSync(WORK_ROOT, { recursive: true, force: true });
      } catch (err) {
        log(`[perf-ab] 提示：临时根 ${WORK_ROOT} 未能清理（${err.code ?? err.message}），可手动删除`);
      }
    }
  } else {
    log(`[perf-ab] --keep：游离树保留在 ${WORK_ROOT}`);
  }
}

if (failed !== null) {
  console.error(failed);
  process.exit(3);
}

/* ============================== 报表 ============================== */

// 指标取两侧并集，但顺序按"最有解释力"排：端到端在前，分段在后
const PREFERRED = [
  'total_ms',
  'open_ms',
  'index_ms',
  'build_ms',
  'seg_walk',
  'seg_stat',
  'seg_snapshot',
  'seg_readparse',
  'seg_aggregate',
  'seg_refs',
  'cond_ms',
  'lint_ms',
  'indexed_files',
  'distinct_functions',
];
const present = new Set([...samples.A, ...samples.B].flatMap((m) => Object.keys(m)));
const numeric = [...present].filter((k) => ['selfcheck', 'tree', 'fatal', 'cold', 'reused'].includes(k) === false);
const ordered = [...PREFERRED.filter((k) => numeric.includes(k)), ...numeric.filter((k) => !PREFERRED.includes(k)).sort()];
const metricsToReport = WANT_METRICS.length > 0 ? ordered.filter((k) => WANT_METRICS.includes(k)) : ordered;

const rows = [];
for (const key of metricsToReport) {
  const a = samples.A.map((m) => m[key]).filter((v) => typeof v === 'number');
  const b = samples.B.map((m) => m[key]).filter((v) => typeof v === 'number');
  if (a.length === 0 && b.length === 0) continue;
  const am = median(a);
  const bm = median(b);
  rows.push({
    metric: key,
    a: am,
    b: bm,
    ratio: am !== null && bm !== null && am !== 0 ? bm / am : null,
    aSpread: spread(a),
    bSpread: spread(b),
    aSamples: a,
    bSamples: b,
  });
}

const verdicts = selfCheckMode
  ? rows
      .filter((r) => r.ratio !== null && ['total_ms', 'index_ms', 'build_ms'].includes(r.metric))
      .map((r) => ({ metric: r.metric, ok: Math.abs(r.ratio - 1) <= TOLERANCE, ratio: r.ratio }))
  : [];
const selfCheckPassed = verdicts.length > 0 && verdicts.every((v) => v.ok);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        corpus: CORPUS,
        rounds: ROUNDS,
        roundsAhead: ROUNDS_AHEAD,
        tolerance: TOLERANCE,
        selfCheck: selfCheckMode,
        selfCheckPassed: selfCheckMode ? selfCheckPassed : null,
        a: { spec: sides[0]?.spec ?? null, commit: sides[0]?.commit ?? null },
        b: { spec: sides[1]?.spec ?? null, commit: sides[1]?.commit ?? null },
        rows,
        verdicts,
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
} else {
  console.log('');
  console.log(`=== perf-ab 读数（${ROUNDS} 轮中位数）===`);
  console.log(`A = ${sides[0].spec}${sides[0].commit !== null ? ` (${sides[0].commit.slice(0, 8)})` : ''}`);
  console.log(`B = ${sides[1].spec}${sides[1].commit !== null ? ` (${sides[1].commit.slice(0, 8)})` : ''}`);
  console.log('');
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(`${pad('metric', 20)}${padL('A(中位)', 12)}${padL('B(中位)', 12)}${padL('B/A', 9)}${padL('A极差', 9)}${padL('B极差', 9)}`);
  console.log('-'.repeat(71));
  for (const r of rows) {
    const fmt = (v) => (v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(2));
    const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);
    console.log(
      `${pad(r.metric, 20)}${padL(fmt(r.a), 12)}${padL(fmt(r.b), 12)}${padL(r.ratio === null ? '-' : r.ratio.toFixed(3), 9)}` +
        `${padL(pct(r.aSpread), 9)}${padL(pct(r.bSpread), 9)}`,
    );
  }
  console.log('');

  if (selfCheckMode) {
    console.log(`[判据] A/A 自证：比值须落在 1.00±${TOLERANCE.toFixed(2)}`);
    for (const v of verdicts) {
      console.log(`  ${v.metric.padEnd(12)} B/A = ${v.ratio.toFixed(3)}  ${v.ok ? '✅' : '❌'}`);
    }
    if (verdicts.length === 0) console.log('  （无可用比值：端到端指标缺失）');
    console.log(`  ⇒ ${selfCheckPassed ? '✅ 量具可用' : '❌ 量具噪声超预算，读数不可用于决策'}`);
  } else {
    console.log('[判据] 非自证模式，只出读数不判定。看 B/A：< 1 表示 B 更快。');
  }
  console.log(`\n[perf-ab] 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

// A/A 自证不过就是红：这是量具的准入门槛，不放行才有人去修它
process.exit(selfCheckMode && !selfCheckPassed ? 1 : 0);
