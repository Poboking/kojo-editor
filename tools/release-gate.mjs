#!/usr/bin/env node
/**
 * K2-RELEASE-GATE · 发布门槛的一次性真跑器（零新依赖、不写盘）。
 *
 * 设计稿 §16.10 R9.1–R9.6 的机器可跑面：把「双 typecheck / 解耦审计 / conformance /
 * 两池测试 / 可选 app build」串成一条命令，逐项记录读数，最后统一给 `RESULT: PASS|FAIL`。
 *
 * 两条硬纪律：
 * - **失败不被洗成 warning**：任何一项 `rc !== 0`（或超时）都进 `failed`，最终 exit 1；
 * - **失败隔离**：一项红了继续跑后面的（`--fail-fast` 才提前停），这样一次就能拿到全量账。
 *
 * K2-RELEASE-CI 加的三个**可选项**（默认不跑，缺前置记 SKIP 并写清原因，绝不静默）：
 * - `corpus`：先 `node tools/corpus.mjs --print` 探语料在不在位；**缺语料 = SKIP 不是 FAIL**
 *   （CI/无游戏机的常态），但 `KOJO_CORPUS_DIR` 指了坏路径（探针 rc=2）仍按硬失败算；
 * - `smoke-dom` / `smoke-ipc`：桌面壳 DOM / 真实 IPC 冒烟（`--shell` 或 `--only` 才跑），
 *   需桌面会话 + WebView2，CI 上必然跑不起来。
 * 这三项都**不改变**核心 4+2 项的默认账：CI 快速档就是 `--skip-tests`，全量档只多两池。
 *
 * K2-RELEASE-AUTOMATION 加的 `--release` 档（§16.10 R9.5–R9.7 的发版机器面）在默认账之外**另加四项**
 * （`releaseOnly`：默认不跑、只在 `--release` 或显式 `--only` 时跑，其余情况记 SKIP + 原因）：
 * - `version-sync`：三处 `version`（root `package.json` / `packages/app/package.json` /
 *   `packages/app/src-tauri/tauri.conf.json`）逐字相等（AGENTS §七；`app-version.test.ts` 钉住）；
 * - `language-suite`：`node tools/kojo-conformance.mjs language --json`（语言面套件属另一条线；
 *   当前 CLI 尚无 `language` 子命令 ⇒ rc=2 且「未知命令：language」⇒ SKIP 并写明，绝不自己实现）；
 * - `artifact-audit`：先 `pnpm --filter @kojo/app build`，再量 `packages/app/dist`
 *   入口块 / 总量 / 件数上界（阈值取 `docs/STATE.md` 基线；2026-10-26 启动器批重钉为 ≤1,100 kB / ≤11.0 MiB / ≤90 件）；
 * - `cargo-test`：`cargo test --lib`（15 分钟上限）。**必须经 node 起**（PITFALLS：Git-Bash 的
 *   `TMP=/tmp` 会让 MSVC `link.exe` 报 LNK1104），并兜底把 TMP/TEMP/TMPDIR 换成 Windows 形态。
 * `--release` 的默认项序固定为 `RELEASE_ITEM_IDS`（version-sync 第一，cargo-test 最后），
 * `--shell` / `--corpus` 仍按开关追加；`--only` 优先于 `--release`。
 *
 * 车道 GATE 追加的 `launcher-smoke`（启动器真壳冒烟）也是**可选项**，默认 SKIP：
 * 它要一台**真桌面壳**（`tools/debug-cli.mjs shell --isolate`：冷 cargo 构建数分钟 + WebView2 +
 * 桌面会话），CI / 无桌面机上根本没有这条通道；更重要的一条口径是「通道可用才跑」——
 * 脚本以 rc=2 + `[launcher-smoke] SKIP reason=…` 如实报「跑不了」，本项把它改判成 SKIP
 * （rc=2 ⇒ SKIP，rc=1 仍是 FAIL，绝不把断言红洗成跳过）。显式 `--launcher-smoke` 或
 * `--only=launcher-smoke` 才收它，默认账（CI 快速档）一项不动。
 *
 * 结构：
 * - `createReleaseGate({ run })` = 纯执行编排（runner 注入，单测用假 runner）；
 * - `createProcessRunner()` = 真 spawn + 超时杀进程树 + 捕获 stdout/stderr；
 * - 读数是**解析真实输出**得到的（tsc 错误数 / 审计插件数 / conformance JSON / vitest 汇总），
 *   解析失败只标 `parsed:false`，绝不因此把失败洗白（判定始终以 rc 为准）。
 *
 * 用法与退出码见 `USAGE`；`node tools/release-gate.mjs --help`。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReadingLine as parseLauncherSmokeReading, parseSkipLine as parseLauncherSmokeSkip } from './launcher-smoke.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const IS_WINDOWS = process.platform === 'win32';

/** 每项最多保留的输出行数（JSON 报告里的 `tail`） */
export const TAIL_LINES = 40;
/** 单个流最多缓存的字符数；超出保留尾部（汇总行总在最后） */
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

const TIMEOUT = Object.freeze({
  typecheck: 5 * 60 * 1000,
  audit: 3 * 60 * 1000,
  conformance: 5 * 60 * 1000,
  tests: 30 * 60 * 1000,
  build: 10 * 60 * 1000,
  corpusProbe: 60 * 1000,
  corpus: 30 * 60 * 1000,
  smoke: 10 * 60 * 1000,
  /** `cargo test --lib`：冷 target 首编译可能十几分钟，故给足 15 分钟（超时 = rc 124 FAIL） */
  cargoTest: 15 * 60 * 1000,
  /** version-sync 只读三个 JSON，不 spawn：留个非零值只为「每项都有超时」的形状一致 */
  versionSync: 60 * 1000,
  /** 启动器真壳冒烟：冷 cargo 构建 + 起壳（实测热 target 42s，冷构建数分钟）后再驱动，给 20 分钟 */
  launcherSmoke: 20 * 60 * 1000,
});

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** 去掉 ANSI，统一换行；读数与 tail 都走这里 */
export function stripAnsi(text = '') {
  return String(text).replace(ANSI, '').replace(/\r\n?/g, '\n');
}

function lastLines(text, limit = TAIL_LINES) {
  const lines = stripAnsi(text)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.slice(-limit).join('\n');
}

function readAll(raw) {
  return `${raw?.stdout ?? ''}\n${raw?.stderr ?? ''}`;
}

/** tsc：数 `error TSxxxx`，并按 `file(line,col): error` 去重文件 */
export function parseTypecheckOutput(text = '') {
  const clean = stripAnsi(text);
  const errors = [...clean.matchAll(/error TS\d+/g)].length;
  const files = new Set();
  for (const match of clean.matchAll(/^(.+?)\(\d+,\d+\):\s+error TS\d+/gm)) files.add(match[1].trim());
  return { errors, files: files.size };
}

/** audit-decoupling：成功行给插件数，失败行给违规数；认不出就 null（不猜 0） */
export function parseAuditOutput(text = '') {
  const clean = stripAnsi(text);
  const plugins = /插件（(\d+)\s*个）/.exec(clean);
  const violations = /发现\s*(\d+)\s*处违规/.exec(clean);
  return {
    plugins: plugins ? Number(plugins[1]) : null,
    violations: violations ? Number(violations[1]) : /全部通过/.test(clean) ? 0 : null,
  };
}

/** conformance CLI 的 `--json` 报告（只取发布门槛关心的读数） */
export function parseConformanceJson(text = '') {
  const clean = stripAnsi(text);
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) return { parsed: false };
  let report;
  try {
    report = JSON.parse(clean.slice(start, end + 1));
  } catch {
    return { parsed: false };
  }
  const cases = Array.isArray(report.cases) ? report.cases : [];
  return {
    parsed: true,
    adapter: typeof report.adapter === 'string' ? report.adapter : null,
    files: Array.isArray(report.files) ? report.files.length : 0,
    cases: cases.length,
    passed: cases.filter((item) => item?.ok === true).length,
    failed: cases.filter((item) => item?.ok !== true).length,
    failures: Array.isArray(report.failures) ? report.failures.length : 0,
    contractOk: report.readings?.contract?.ok ?? null,
  };
}

/** vitest 汇总行：`Test Files 667 passed | 21 skipped (688)` / `Tests ...` */
export function parseVitestSummary(text = '') {
  const clean = stripAnsi(text);
  const filesLine = clean.match(/^\s*Test Files\s+(.+)$/m)?.[1] ?? null;
  const testsLine = clean.match(/^\s*Tests\s+(.+)$/m)?.[1] ?? null;
  if (filesLine === null && testsLine === null) return { parsed: false };

  const parseLine = (line) => {
    const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
      counts[match[2]] = Number(match[1]);
    }
    const total = /\((\d+)\)/.exec(line);
    return { ...counts, total: total ? Number(total[1]) : null };
  };
  const duration = /^\s*Duration\s+([\d.]+)\s*(ms|s)\b/m.exec(clean);
  const durationMs = duration ? Number(duration[1]) * (duration[2] === 's' ? 1000 : 1) : null;
  return {
    parsed: true,
    files: filesLine === null ? null : parseLine(filesLine),
    tests: testsLine === null ? null : parseLine(testsLine),
    durationMs: durationMs === null ? null : Math.round(durationMs),
  };
}

/** vite build：`✓ built in 26.5s` + 产物条数（dist/ 行） */
export function parseBuildOutput(text = '') {
  const clean = stripAnsi(text);
  const built = /built in\s+([\d.]+)\s*(ms|s)/.exec(clean);
  const assets = clean.split('\n').filter((line) => /\bdist[\\/]/.test(line)).length;
  if (built === null) return { parsed: false, assets };
  return {
    parsed: true,
    builtInMs: Math.round(Number(built[1]) * (built[2] === 's' ? 1000 : 1)),
    assets,
  };
}

/**
 * 桌面壳冒烟（`smoke-tauri-dom.mjs` / `smoke-tauri-ipc.mjs`）的读数。
 * 两者口径不同，认得出哪种就记哪种（认不出返回 parsed:false，不猜绿）：
 * - DOM：`[smoke] checks: {...} exited=false` + 结尾 `✅ tauri DOM smoke passed` / `❌ … failed`；
 * - IPC：`================ 冒烟汇总 ================` + `共 N 项；FAIL M` + 同款 ✅/❌ 结尾行。
 * 判定仍以 rc 为准（✅ 只用于读数，不能把 rc=1 洗成 PASS）。
 */
export function parseSmokeOutput(text = '') {
  const clean = stripAnsi(text);
  const total = /共\s*(\d+)\s*项[；;]\s*FAIL\s*(\d+)/.exec(clean);
  const domChecks = /\[smoke\] checks:\s*\{/.test(clean);
  const green = /✅\s*tauri\s*(?:DOM|IPC)\s*(?:smoke\s+passed|冒烟全部通过)/.test(clean);
  const red = /❌\s*tauri\s*(?:DOM|IPC)\s*(?:smoke\s+failed|冒烟存在失败项)/.test(clean);
  if (!green && !red && total === null && !domChecks) return { parsed: false };
  let failedChecks = total ? Number(total[2]) : null;
  let checks = null;
  const json = /\[smoke\] checks:\s*(\{[^}]*\})\s*exited=/.exec(clean);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]);
      checks = Object.keys(parsed).length;
      if (failedChecks === null) failedChecks = Object.values(parsed).filter((value) => value === false).length;
    } catch {
      checks = null;
    }
  }
  return {
    parsed: true,
    verdict: green ? 'passed' : red ? 'failed' : null,
    checks,
    total: total ? Number(total[1]) : null,
    failed: failedChecks,
  };
}

function firstLine(text, limit = 220) {
  const line = stripAnsi(text)
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/* ------------------------------------------------------------------ *
 * K2-RELEASE-AUTOMATION（--release 档）的三块本地检查 + cargo 读数
 * - version-sync / artifact-audit 是**进程内检查**（`item.local`）：前者只读三个 JSON，
 *   后者的构建由 `item.preflight` 起子进程、本地只量盘上产物；
 * - 两者都把 `readText` / `readDist` 做成注入点（单测用假函数，真跑用 fs），
 *   这样阈值与判定逻辑可被逐字钉住，又不必往仓库里塞 8 MB 假产物。
 * ------------------------------------------------------------------ */

/** AGENTS §七 / §16.10 R9.5：三处 version 必须逐字相等（顺序即报告里的输出顺序） */
export const VERSION_FILES = Object.freeze([
  { key: 'rootPkg', rel: 'package.json', label: 'package.json' },
  { key: 'appPkg', rel: 'packages/app/package.json', label: 'packages/app/package.json' },
  { key: 'tauriConf', rel: 'packages/app/src-tauri/tauri.conf.json', label: 'packages/app/src-tauri/tauri.conf.json' },
]);

/** 默认读文件（只在 runner 层用；单测注入假 readText） */
async function defaultReadText(absPath) {
  return fs.readFile(absPath, 'utf8');
}

/**
 * 三处 version 逐字比较。**读不到 / JSON 坏 / version 非非空字符串都算 FAIL**（不猜绿）：
 * 返回 `{ rc, readings, tail }`，readings 固定带三值（读不到的记 null）与 `matched`。
 */
export async function inspectVersionSync({ root = ROOT, readText = defaultReadText } = {}) {
  const readings = { present: true, rootPkg: null, appPkg: null, tauriConf: null, matched: false };
  const broken = [];
  const found = [];
  for (const spec of VERSION_FILES) {
    const abs = path.join(root, spec.rel);
    let text;
    try {
      text = await readText(abs);
    } catch (error) {
      broken.push({ ...spec, reason: `读不到文件（${errorText(error).split('\n')[0]}）` });
      continue;
    }
    let version = null;
    try {
      version = JSON.parse(String(text))?.version ?? null;
    } catch {
      broken.push({ ...spec, reason: 'JSON 解析失败' });
      continue;
    }
    if (typeof version !== 'string' || version.trim().length === 0) {
      broken.push({ ...spec, reason: 'version 缺失或不是非空字符串' });
      continue;
    }
    readings[spec.key] = version;
    found.push({ ...spec, version });
  }
  readings.present = broken.length === 0 && found.length === VERSION_FILES.length;
  readings.matched = readings.present && new Set(found.map((entry) => entry.version)).size === 1;

  if (readings.matched) {
    const [version] = found.map((entry) => entry.version);
    return {
      rc: 0,
      readings,
      tail: `[version-sync] 三处 version 一致：${version}（${VERSION_FILES.map((spec) => spec.label).join(' / ')}）`,
    };
  }

  const lines = ['[version-sync] FAIL：三处 version 不一致（必须逐字相等，AGENTS §七）'];
  if (broken.length > 0) {
    lines.push('  读不到/读不懂的文件：');
    for (const entry of broken) lines.push(`    - ${entry.label}：${entry.reason}`);
  }
  if (found.length > 0) {
    lines.push('  实测三值：');
    for (const spec of VERSION_FILES) {
      const value = readings[spec.key];
      lines.push(`    ${spec.label} = ${value === null ? '（读不到）' : value}`);
    }
  }
  lines.push('  规则：root package.json / packages/app/package.json /');
  lines.push('        packages/app/src-tauri/tauri.conf.json 的 version 逐字相等');
  lines.push('        （packages/app/tests/app-version.test.ts 钉住；发版提交三处同步）。');
  return { rc: 1, readings, tail: lines.join('\n') };
}

/**
 * `docs/STATE.md` 的既有基线换算成上界（设计稿 §16.10 R9.7 的产物面）：
 * 入口块 1,035 kB（批次七实测）→ 上限 1,100 kB；dist 72 件 8.97 MiB → 上限 10.5 MiB / 85 件。
 * 口径：vite 报的 `kB` 是 1000 字节；`MB` 按 MiB 计（上界留余量，防正常增件即红）。
 */
export const ARTIFACT_LIMITS = Object.freeze({
  entryBytes: 1_100_000,
  /*
   * 2026-10-26 启动器落地批：件数 85 → 90、总量 10.5 → 11.0 MiB。
   *
   * 增量逐笔点名（`packages/app/dist` 实测 84 件 / 10.65 MiB，闸量到 85 件含 index.html）：
   * · 启动器自己的三个懒块 `LauncherView-*.js` 35.2 KB + `LauncherView-*.css` 11.6 KB +
   *   `launcher-bridge-*.js` 3.1 KB（视图与宿主桥都在动态边上，开机图未变）；
   * · `@kojo/plugin-launcher-core` 与 `kernel/launcher` 的懒块（core 骨架 + 内容包/插件门禁/存档编排）；
   * · 其余为本批之前的累积漂移（编辑器对标批之后各批的增量）。
   * 两枚数仍是"收紧的上界"：11.0 MiB 距现值 0.35 MiB、90 件距现值 5 件——正常增件不红，
   * 一次性进整包才会红。启动器的内容包 / 插件 / 存档面板还会再加几个懒块，届时按同一口径重钉。
   */
  distBytes: Math.round(11.1 * 1024 * 1024),
  /*
   * 2026-10-27 LAU-3b 收尾批：件数 90 → 92（顶格，零余量）、总量与入口不动。
   *
   * 增量逐枚点名（同一棵树改前/改后各真实构建一次，`dist/assets` 89 → 91 枚）：
   * · `kojo1-rename-*.js`——`.kojo → .kojo1` 改名对话框自己的懒块（只在命令面板 /
   *   设置页显式发起时取字节，开机图零增量）；
   * · `kit-check-*.js`——**不是新代码，是共享边界搬了位置**：`KitCheck` 此前只被
   *   同一个块里的消费者引用（内联进 ProjectView 块），改名对话框成为第二个块里的
   *   消费者 ⇒ rollup 把它抽成共享块。字节量近中性（内联的那份变引用），件数 +1。
   * 口径同 ps10 文件闸：**顶格不预留**——下一枚进图模块要先挪一枚出去，或按本节
   * 同款"逐笔点名 + 改前改后各量一次"重钉。
   *
   * 2026-10-27 LAU-3b-FLIP 批：件数 92 → 93（同一合并边界，总量与入口未动上限）。
   *
   * 增量不是本批引入：本批在变基前的树上真实构建 = 92 件（`dist/assets` 91 枚 +
   * index.html），与 LAU-3b 收尾批的顶格读数逐字相同；变基到 dev `57f7029b` 后
   * 同一命令再构建一次 = **93 件**（assets 92 枚 + index.html）、入口 249,187 →
   * **253,055 B**（`index-GdRjxu03.js`），增量来自上游五笔（UI 反馈批 · 编辑器组拖拽 ·
   * 工作区块两笔 · 闸面收口）。**未拆到单一 chunk**（要拆得在 dev 尖端另起一棵游离树
   * 构建对拍，本批未做）——按"上游合流推高、本支零新增分块"记 +1；若上游回落后
   * 实测值降到 92，下次改动顺手把闸收回。
   *
   * 2026-10-27 LAU-1 / D2 合流批：件数 93 → 95、总量 11.0 → 11.1 MiB。
   *
   * 增量逐枚点名（同一棵树一次真实构建，`dist/assets` 92 → 94 枚 + index.html）：
   * · `protocol-*.js` **1.9 KB**——协议 v3 的纯契约叶子，被「v3 主路」与「v2 回滚路」
   *   两个块共同引用，rollup 只能抽成共享块（LAU-1 的双跑窗口就是它存在的理由）；
   * · `edit-*.js` **0.6 KB**——差集工具（`commonEdit` / `applyEdit`）同理由共享。
   * 总量 11,560,993 B（11.03 MiB）顶穿旧上限 11.0 MiB 约 26 KB，故一并抬到 11.1 MiB；
   * 入口 253,336 B 不动。两枚都是"共享边界搬位置"而非新功能体量。
   *
   * 2026-10-27 LAU-6 注入批：件数 95 → 96、总量与入口不动。
   *
   * 增量逐枚点名（同一棵树改前/改后各真实构建一次，`dist/assets` 94 → 95 枚）：
   * · `injection-*.js` **7.6 KB**——`@原生` 子树执行器（`tree-sitter/injection.ts`），
   *   被 `kojo2-semantic` 与 worker 侧两块共同引用 ⇒ 只能是共享块；**不在开机图上**
   *   （ps10 文件数 198 不动，KB +1 已在那边落账）。总量 11.06 MiB（上限 11.1）、
   *   入口 262,461 B（上限 1,100 kB）。
   */
  files: 96,
});

const MIB = 1024 * 1024;

/** 入口块 = index.html 的 `<script type="module" src=…>`；认不出退到最大的 `.js`（tail 里会注明） */
export function findEntryRel(indexHtml = '', files = []) {
  const match = /<script\b[^>]*\bsrc=["']([^"']+\.js)["']/i.exec(String(indexHtml));
  if (match !== null) {
    const rel = match[1].replace(/^\.?\//, '').replaceAll('\\', '/');
    if (files.some((file) => file.rel === rel)) return rel;
  }
  const js = files
    .filter((file) => file.rel.endsWith('.js'))
    .sort((left, right) => right.bytes - left.bytes);
  return js[0]?.rel ?? null;
}

/** 纯测量：给定产物清单（`{rel,bytes}`）与 index.html，算三个上界是否被突破 */
export function measureArtifacts({ files = [], indexHtml = '', limits = ARTIFACT_LIMITS, entryRel } = {}) {
  const normalized = files.map((file) => ({
    rel: String(file.rel).replaceAll('\\', '/'),
    bytes: Number(file.bytes) || 0,
  }));
  const distBytes = normalized.reduce((sum, file) => sum + file.bytes, 0);
  const entry = entryRel ?? findEntryRel(indexHtml, normalized);
  const entryBytes = entry === null ? null : (normalized.find((file) => file.rel === entry)?.bytes ?? null);
  const exceeded = [];
  if (entryBytes === null) exceeded.push('entry-missing');
  else if (entryBytes > limits.entryBytes) exceeded.push('entry');
  if (distBytes > limits.distBytes) exceeded.push('dist');
  if (normalized.length > limits.files) exceeded.push('files');
  return { files: normalized.length, distBytes, entry, entryBytes, exceeded, limits };
}

/**
 * 真读 `packages/app/dist`：缺目录返回 `{ present:false }`（不抛），其余抛给调用方记 FAIL。
 * `indexHtml` 读不到就空串（入口块退到「最大的 .js」，读数里仍可追溯）。
 */
export async function defaultReadDist({ root = ROOT } = {}) {
  const base = path.join(root, 'packages/app/dist');
  const walk = async (rel) => {
    const dir = rel.length === 0 ? base : path.join(base, rel);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const next = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await walk(next)));
      else if (entry.isFile()) files.push({ rel: next.replaceAll('\\', '/'), bytes: (await fs.stat(path.join(dir, entry.name))).size });
    }
    return files;
  };
  let files;
  try {
    files = await walk('');
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, dir: base };
    throw error;
  }
  let indexHtml = '';
  try {
    indexHtml = await fs.readFile(path.join(base, 'index.html'), 'utf8');
  } catch {
    indexHtml = '';
  }
  return { present: true, dir: base, files, indexHtml };
}

/**
 * 产物上界检查（构建由 `item.preflight` 先跑）。**缺 dist = FAIL 且可读**：
 * 报告里点名缺的是哪个目录、下一步跑什么，而不是一句 `rc=1`。
 */
export async function inspectArtifacts({ root = ROOT, readDist = defaultReadDist } = {}) {
  let dist;
  try {
    dist = await readDist({ root });
  } catch (error) {
    return {
      rc: 1,
      readings: { present: null, error: firstLine(errorText(error)) },
      tail: `[artifact-audit] 读 packages/app/dist 抛错：${errorText(error)}`,
    };
  }
  if (dist?.present !== true) {
    const dir = dist?.dir ?? path.join(root, 'packages/app/dist');
    return {
      rc: 1,
      readings: { present: false, dir },
      tail: [
        `[artifact-audit] FAIL：产物目录不存在或为空：${dir}`,
        '  先跑 pnpm --filter @kojo/app build（本项 --release 档会自动先构建；--only 单跑同样先构建）',
        '  构建失败时本项按构建的 rc 计 FAIL，tail 见构建输出。',
      ].join('\n'),
    };
  }
  const measured = measureArtifacts({ files: dist.files ?? [], indexHtml: dist.indexHtml ?? '', limits: ARTIFACT_LIMITS });
  const distMiB = Math.round((measured.distBytes / MIB) * 100) / 100;
  const entryKB = measured.entryBytes === null ? null : Math.round(measured.entryBytes / 1000);
  // 上界三个数**只从 `ARTIFACT_LIMITS` 渲染**：此前这里手抄过一份「40 件 / 8 MiB」，
  // 而闸早已改成 85 件 / 10.5 MiB ⇒ summary 长期在报一个不存在的上界（2026-10-25 件数批修正）。
  // 判据一个字没动，改的只是这句话的取值来源。
  const limitFiles = ARTIFACT_LIMITS.files;
  const limitMiB = Math.round((ARTIFACT_LIMITS.distBytes / MIB) * 100) / 100;
  const limitEntryKB = Math.round(ARTIFACT_LIMITS.entryBytes / 1000);
  const readings = {
    present: true,
    files: measured.files,
    distBytes: measured.distBytes,
    distMiB,
    entry: measured.entry,
    entryBytes: measured.entryBytes,
    entryKB,
    limits: { entryKB: limitEntryKB, distMiB: limitMiB, files: limitFiles },
    exceeded: measured.exceeded,
  };
  const summary = `[artifact-audit] 实测：${measured.files} 件 / dist ${distMiB} MiB / 入口 ${measured.entry ?? '（认不出）'} ${entryKB === null ? '—' : `${entryKB} kB`}（上限 ${limitFiles} 件 / ${limitMiB} MiB / ${limitEntryKB.toLocaleString('en-US')} kB）`;
  if (measured.exceeded.length === 0) return { rc: 0, readings, tail: summary };

  const lines = ['[artifact-audit] FAIL：产物超出上界'];
  if (measured.exceeded.includes('entry-missing')) lines.push('  dist 里认不出入口块：index.html 无 script src，且无 .js 产物');
  if (measured.exceeded.includes('entry')) {
    lines.push(`  入口块 ${measured.entry} = ${entryKB} kB ＞ 上限 1,100 kB`);
  }
  if (measured.exceeded.includes('dist')) lines.push(`  dist 总量 = ${distMiB} MiB ＞ 上限 ${limitMiB} MiB`);
  if (measured.exceeded.includes('files')) lines.push(`  产物件数 = ${measured.files} ＞ 上限 ${limitFiles}`);
  lines.push(summary);
  return { rc: 1, readings, tail: lines.join('\n') };
}

/** `packages/app/src-tauri`（cargo 的 cwd）与 cargo test 的参数 */
export const CARGO_TEST_DIR = 'packages/app/src-tauri';
export const CARGO_TEST_COMMAND = 'cargo test --lib';

/**
 * cargo 必须**经 node 起**（docs/PITFALLS.md：Git-Bash 的 `TMP=/tmp` 让 MSVC `link.exe` 报
 * LNK1104 ⇒ 直跑必挂）。这里起一层 node，内层 `execSync` 照 AGENTS §三 的形态跑，并把
 * TMP/TEMP/TMPDIR 显式换成 Windows 形态（`os.tmpdir()`）——两道都上，CI 与本机 Git-Bash 都稳。
 * 输出整段写回 stdout/stderr（runner 侧仍能抓 tail 与 parsec），失败透传 rc。
 */
export function buildCargoTestScript({ root = ROOT, platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  const cwd = path.join(root, CARGO_TEST_DIR);
  const windows = platform === 'win32';
  const envExpr = windows
    ? `{ ...process.env, TMP: ${JSON.stringify(tmpdir)}, TEMP: ${JSON.stringify(tmpdir)}, TMPDIR: ${JSON.stringify(tmpdir)} }`
    : 'process.env';
  return [
    "const { execSync } = require('node:child_process');",
    `const cwd = ${JSON.stringify(cwd)};`,
    `const env = ${envExpr};`,
    'try {',
    `  process.stdout.write(execSync(${JSON.stringify(CARGO_TEST_COMMAND)}, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));`,
    '} catch (error) {',
    '  if (error && error.stdout) process.stdout.write(String(error.stdout));',
    '  if (error && error.stderr) process.stderr.write(String(error.stderr));',
    "  if (error && !error.stdout && !error.stderr) process.stderr.write(`${(error && error.message) ?? error}\\n`);",
    "  process.exit(typeof error?.status === 'number' ? error.status : 1);",
    '}',
  ].join('\n');
}

/** cargo 汇总：`test result: ok. 194 passed; 0 failed; 5 ignored; 0 measured; …`（取最后一段） */
export function parseCargoTestOutput(text = '') {
  const clean = stripAnsi(text);
  const matches = [
    ...clean.matchAll(/test result:\s*(ok|FAILED)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;\s*(\d+)\s*ignored/g),
  ];
  if (matches.length === 0) return { parsed: false };
  const last = matches[matches.length - 1];
  return {
    parsed: true,
    verdict: last[1],
    passed: Number(last[2]),
    failed: Number(last[3]),
    ignored: Number(last[4]),
    suites: matches.length,
  };
}

/**
 * `language` 子命令的 `--json` 报告（该套件属另一条线，形状未定 ⇒ 只认通用读数）：
 * 有 `cases` 就记用例数，否则只记 JSON 顶层键数；解析不出 = parsed:false（判定仍以 rc 为准）。
 */
export function parseLanguageSuiteJson(text = '') {
  const clean = stripAnsi(text);
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) return { parsed: false };
  let report;
  try {
    report = JSON.parse(clean.slice(start, end + 1));
  } catch {
    return { parsed: false };
  }
  const cases = Array.isArray(report?.cases) ? report.cases : null;
  const failures = Array.isArray(report?.failures) ? report.failures.length : null;
  return {
    parsed: true,
    keys: report !== null && typeof report === 'object' ? Object.keys(report).length : 0,
    cases: cases === null ? null : cases.length,
    passed: cases === null ? null : cases.filter((item) => item?.ok === true).length,
    failed: cases === null ? null : cases.filter((item) => item?.ok !== true).length,
    failures,
  };
}

/** 已存在的 `language` 子命令识别：唯一可靠的「没有」证据是 CLI 的未知命令分支 */
const UNKNOWN_LANGUAGE = /未知(?:命令|子命令)\s*[：:]\s*language|unknown\s+(?:command|subcommand)\s*[：:]?\s*language/i;

function languageSkipReason(text) {
  if (!UNKNOWN_LANGUAGE.test(stripAnsi(text))) return null;
  return (
    'conformance CLI 尚无 language 子命令（rc=2「未知命令：language」）：' +
    '语言面套件属另一条线，本项按 SKIP 记账，不在这里自己实现'
  );
}

function nodeItem(id, rel, args, kind, timeoutMs, parse, extra = {}) {
  return {
    id,
    kind,
    cmd: `node ${rel}${args.length > 0 ? ` ${args.join(' ')}` : ''}`,
    command: NODE,
    args: [path.join(ROOT, rel), ...args],
    shell: false,
    timeoutMs,
    parse,
    ...extra,
  };
}

/** Windows 上 pnpm 只有 .cmd/.ps1 垫片：经 cmd.exe 起，避免 Node `shell:true` 的 DEP0190 */
function pnpmInvocation(args) {
  if (!IS_WINDOWS) return { command: 'pnpm', args: [...args] };
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg));
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `pnpm ${quoted.join(' ')}`] };
}

function pnpmItem(id, args, kind, timeoutMs, parse, extra = {}) {
  const invocation = pnpmInvocation(args);
  return {
    id,
    kind,
    cmd: `pnpm ${args.join(' ')}`,
    command: invocation.command,
    args: invocation.args,
    shell: false,
    timeoutMs,
    parse,
    ...extra,
  };
}

/** AGENTS §三 的真实语料集成冒烟（语料由 `KOJO_SMOKE_PROJECT` 指路，测试文件自身 skipIf 守门） */
export const CORPUS_INTEGRATION = 'packages/kernel/tests/integration-plugins.test.ts';

/**
 * 语料前置探针：`node tools/corpus.mjs --print`（AGENTS §三 的取值口径）。
 * 返回三态，**调用方必须区分「缺」与「坏」**：
 * - `{ skip }`  = 盘上无符合内容条件的语料（corpus.mjs rc=1）或打印为空 ⇒ SKIP，不是 FAIL；
 * - `{ fail }`  = 探针超时 / 起不来 / `KOJO_CORPUS_DIR` 指了坏路径（rc=2，corpus.mjs 自己定的硬失败）；
 * - `{ env, readings }` = 在位 ⇒ 把目录塞进 `KOJO_SMOKE_PROJECT`，读数记下选了哪份。
 */
export async function probeCorpus({ run, cwd = ROOT } = {}) {
  if (typeof run !== 'function') throw new TypeError('probeCorpus 需要注入 run({id,command,args,...})');
  const started = Date.now();
  let raw;
  try {
    raw = await run({
      id: 'corpus-probe',
      command: NODE,
      args: [path.join(ROOT, 'tools/corpus.mjs'), '--print'],
      cwd,
      timeoutMs: TIMEOUT.corpusProbe,
      shell: false,
    });
  } catch (error) {
    return {
      fail: {
        rc: 127,
        tail: `[release-gate] 语料探针抛错：${errorText(error)}`,
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs: Date.now() - started },
      },
    };
  }
  const timedOut = raw?.timedOut === true;
  // runner 没回报结果 ⇒ 不能当成「缺语料」（那会静默降级成 SKIP）
  if (raw === undefined || raw === null) {
    return {
      fail: {
        rc: 127,
        tail: '[release-gate] 语料探针 runner 未返回结果',
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs: Date.now() - started },
      },
    };
  }
  const rc = timedOut ? 124 : normalizeRc(raw?.rc);
  const stdout = String(raw?.stdout ?? '');
  const stderr = String(raw?.stderr ?? '');
  const probeMs = Math.max(0, Date.now() - started);
  const dir = stripAnsi(stdout).trim();

  if (timedOut) {
    return {
      fail: {
        rc,
        tail: `${stdout}\n${stderr}`,
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs, timeout: true },
      },
    };
  }
  // rc=1 = 盘上确实没有（CI / 无游戏机的常态）⇒ SKIP；不许把「缺」当失败，也不许静默。
  if (rc === 1) {
    return {
      skip: `语料不在位（node tools/corpus.mjs --print rc=1）：${firstLine(stderr) || '盘上未发现符合内容条件的语料目录'}`,
    };
  }
  // rc=2 = KOJO_CORPUS_DIR / --corpus 指了不成立的路径：这是配置错，不是缺，按硬失败算。
  if (rc !== 0) {
    return {
      fail: {
        rc,
        tail: `${stdout}\n${stderr}`,
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs },
      },
    };
  }
  if (dir.length === 0) {
    return { skip: '语料探针 rc=0 但 --print 未打印目录（tools/corpus.mjs 输出异常）' };
  }
  return {
    env: { KOJO_SMOKE_PROJECT: dir },
    readings: { phase: 'corpus-probe', corpusPresent: true, corpusDir: dir, probeMs },
  };
}

/** 语料集成项：先探位，在位才跑 AGENTS §三 那条 vitest（缺位记 SKIP，不记 FAIL） */
function corpusItem() {
  const args = ['run', CORPUS_INTEGRATION];
  return {
    id: 'corpus',
    kind: 'test',
    optional: 'corpus',
    skipReason: '可选：需真实语料（未传 --corpus / --only=corpus）',
    cmd: `KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" node node_modules/vitest/vitest.mjs ${args.join(' ')}`,
    command: NODE,
    args: [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), ...args],
    shell: false,
    timeoutMs: TIMEOUT.corpus,
    parse: (text) => parseVitestSummary(text),
    preflight: ({ run, cwd }) => probeCorpus({ run, cwd }),
  };
}

/**
 * version-sync（--release 首项）：三处 version 逐字比较。进程内只读三个 JSON，
 * 不 spawn、不需要构建；判定与读数见 `inspectVersionSync`。
 */
function versionSyncItem() {
  return {
    id: 'version-sync',
    kind: 'core',
    cmd: '比较 package.json / packages/app/package.json / packages/app/src-tauri/tauri.conf.json 的 version',
    command: NODE,
    args: [],
    shell: false,
    timeoutMs: TIMEOUT.versionSync,
    releaseOnly: true,
    skipReason: '仅 --release 或 --only=version-sync 时跑（三处版本同步闸）',
    parse: () => ({}),
    local: ({ cwd, readText }) => inspectVersionSync({ root: cwd, readText }),
  };
}

/**
 * artifact-audit：先 `pnpm --filter @kojo/app build`（preflight，失败即 FAIL 并把构建 tail 带出），
 * 再量 `packages/app/dist` 的入口块 / 总量 / 件数上界。阈值见 `ARTIFACT_LIMITS`。
 */
function artifactAuditItem() {
  return {
    id: 'artifact-audit',
    kind: 'build',
    cmd: 'pnpm --filter @kojo/app build → 量 packages/app/dist（入口 ≤1,100 kB / ≤10.5 MiB / ≤85 件）',
    command: NODE,
    args: [],
    shell: false,
    timeoutMs: TIMEOUT.build,
    releaseOnly: true,
    skipReason: '仅 --release 或 --only=artifact-audit 时跑（先构建 app，再量 dist 上界）',
    parse: () => ({}),
    preflight: ({ run, cwd }) => buildAppForAudit({ run, cwd }),
    local: ({ cwd, readDist }) => inspectArtifacts({ root: cwd, readDist }),
  };
}

/** artifact-audit 的构建前置：rc / 超时 / 抛错都变成该项的 FAIL（附构建输出） */
async function buildAppForAudit({ run, cwd }) {
  const started = Date.now();
  const invocation = pnpmInvocation(['--filter', '@kojo/app', 'build']);
  let raw;
  try {
    raw = await run({
      id: 'artifact-audit-build',
      command: invocation.command,
      args: invocation.args,
      cwd,
      timeoutMs: TIMEOUT.build,
      shell: false,
    });
  } catch (error) {
    return {
      fail: {
        rc: 127,
        tail: `[artifact-audit] 构建抛错：${errorText(error)}`,
        readings: { phase: 'artifact-build', buildRc: 127, buildMs: Date.now() - started },
      },
    };
  }
  const timedOut = raw?.timedOut === true;
  const rc = timedOut ? 124 : normalizeRc(raw?.rc);
  const text = readAll(raw);
  const parsed = parseBuildOutput(text);
  const readings = {
    phase: 'artifact-build',
    buildRc: rc,
    buildMs: Date.now() - started,
    builtInMs: parsed.parsed ? parsed.builtInMs : null,
    assets: parsed.assets,
  };
  if (timedOut) return { fail: { rc, tail: text, readings: { ...readings, timeout: true } } };
  if (rc !== 0) return { fail: { rc, tail: text, readings } };
  return { readings };
}

/** cargo-test：经 node 起 `cargo test --lib`（PITFALLS 的 TMP 坑），15 分钟上限 */
function cargoTestItem() {
  return {
    id: 'cargo-test',
    kind: 'rust',
    releaseOnly: true,
    skipReason: '仅 --release 或 --only=cargo-test 时跑（需 Rust 工具链，15 分钟上限）',
    cmd: `node -e "execSync('${CARGO_TEST_COMMAND}', { cwd: '${CARGO_TEST_DIR}' })"`,
    command: NODE,
    args: ['-e', buildCargoTestScript()],
    shell: false,
    timeoutMs: TIMEOUT.cargoTest,
    parse: (text) => parseCargoTestOutput(text),
  };
}

/**
 * language-suite：`node tools/kojo-conformance.mjs language --json`。
 * 该子命令属另一条线：当前 CLI 还没有它（rc=2「未知命令：language」）⇒ `interpret` 把
 * 这一种 rc=2 定性为 SKIP 并写明原因；真跑红（rc≠0 且不是未知命令）仍是 FAIL，绝不洗白。
 */
function languageSuiteItem() {
  return {
    id: 'language-suite',
    kind: 'core',
    releaseOnly: true,
    skipReason: '仅 --release 或 --only=language-suite 时跑（语言面套件；子命令不存在则 SKIP 并说明）',
    cmd: 'node tools/kojo-conformance.mjs language --json',
    command: NODE,
    args: [path.join(ROOT, 'tools/kojo-conformance.mjs'), 'language', '--json'],
    shell: false,
    timeoutMs: TIMEOUT.conformance,
    parse: (text) => parseLanguageSuiteJson(text),
    interpret: ({ rc, text }) => {
      if (rc !== 2) return null;
      const reason = languageSkipReason(text);
      return reason === null ? null : { skip: reason };
    },
  };
}

/**
 * launcher-smoke 的读数：直接复用脚本自己的读数行解析（单源，不在两处抄正则）。
 * 解析不出返回 `{parsed:false}`——判定仍以 rc 为准，读数缺失不许把红洗绿。
 */
export function parseLauncherSmokeLine(text = '') {
  const reading = parseLauncherSmokeReading(stripAnsi(text));
  if (reading.parsed !== true) return { parsed: false };
  return {
    parsed: true,
    rc: reading.rc,
    elapsedMs: reading.elapsedMs,
    assertions: reading.assertions,
    passed: reading.passed,
    failed: reading.failed,
    mode: reading.mode,
    bootMs: reading.bootMs,
  };
}

/**
 * launcher-smoke（车道 GATE）：真壳里驱动启动器的只读面（instance/process/task 三条）
 * + 两条负向（不存在实例的 start / 缺 profile 的 create）。**默认 SKIP**——理由见文件头：
 * 它是「需要真桌面壳与隔离 appData」的可选项；显式点名后若通道仍不可用（脚本 rc=2），
 * `interpret` 把它改判成 SKIP 并把脚本自报的原因带进报告（rc=1 的断言红不受影响）。
 */
function launcherSmokeItem() {
  return {
    id: 'launcher-smoke',
    kind: 'shell',
    optional: 'launcherSmoke',
    skipReason: '可选：需真桌面壳（未传 --launcher-smoke / --only=launcher-smoke）',
    cmd: 'node tools/launcher-smoke.mjs --start（真壳 shell --isolate；只读三条 + 两条负向）',
    command: NODE,
    args: [path.join(ROOT, 'tools', 'launcher-smoke.mjs'), '--start'],
    shell: false,
    timeoutMs: TIMEOUT.launcherSmoke,
    parse: (text) => parseLauncherSmokeLine(text),
    interpret: ({ rc, text }) => {
      if (rc !== 2) return null;
      return { skip: parseLauncherSmokeSkip(text) ?? 'launcher-smoke 通道不可用（rc=2 但未给出原因）' };
    },
  };
}

/**
 * 项清单 = 发布门槛的全部机器面。顺序即执行顺序（前 6 项是默认账，其余 9 项可选 / 分档）。
 * 可选性由 `optional` 声明（= 解锁开关名：build / corpus / shell / launcherSmoke），
 * `skipReason` 是默认不跑时写进报告的原因（SKIP 必须可解释）。
 * `smoke-dom` / `smoke-ipc` 需桌面会话 + WebView2，`corpus` 需真实游戏目录：
 * 三者在 CI / 无游戏机上「没得跑」而不是「跑挂了」，故只 SKIP；`launcher-smoke` 同理
 * （真桌面壳 + 隔离 appData，且它自己还会在通道不可用时以 rc=2 报 SKIP）。
 *
 * 末尾四项是 K2-RELEASE-AUTOMATION 的 `--release` 档（`releaseOnly`：默认档不跑、记 SKIP，
 * 只有 `--release` 或显式 `--only` 才跑）；最后一项 `launcher-smoke` 是车道 GATE 的可选项。
 * **追加在最后**是为了不挪既有 10 项的位置（JSON 消费方按顺序认 build-app / corpus / smoke-*）。
 */
export const DEFAULT_ITEMS = Object.freeze([
  pnpmItem('typecheck-root', ['typecheck'], 'core', TIMEOUT.typecheck, (text) => parseTypecheckOutput(text)),
  pnpmItem('typecheck-app', ['--filter', '@kojo/app', 'typecheck'], 'core', TIMEOUT.typecheck, (text) =>
    parseTypecheckOutput(text),
  ),
  nodeItem('audit', 'tools/audit-decoupling.mjs', [], 'core', TIMEOUT.audit, (text) => parseAuditOutput(text)),
  nodeItem('conformance', 'tools/kojo-conformance.mjs', ['check', '--suite', '--json'], 'core', TIMEOUT.conformance, (text) =>
    parseConformanceJson(text),
  ),
  nodeItem('test-unit', 'node_modules/vitest/vitest.mjs', ['run', '--config', 'vitest.config.ts'], 'test', TIMEOUT.tests, (text) =>
    parseVitestSummary(text),
  ),
  nodeItem('test-perf', 'node_modules/vitest/vitest.mjs', ['run', '--config', 'vitest.perf.config.ts'], 'test', TIMEOUT.tests, (text) =>
    parseVitestSummary(text),
  ),
  pnpmItem(
    'build-app',
    ['--filter', '@kojo/app', 'build'],
    'build',
    TIMEOUT.build,
    (text) => parseBuildOutput(text),
    { optional: 'build', skipReason: '可选：未传 --build' },
  ),
  corpusItem(),
  nodeItem(
    'smoke-dom',
    'tools/smoke-tauri-dom.mjs',
    [],
    'shell',
    TIMEOUT.smoke,
    (text) => parseSmokeOutput(text),
    { optional: 'shell', skipReason: '可选：需桌面壳（未传 --shell / --only=smoke-dom）' },
  ),
  nodeItem(
    'smoke-ipc',
    'tools/smoke-tauri-ipc.mjs',
    [],
    'shell',
    TIMEOUT.smoke,
    (text) => parseSmokeOutput(text),
    { optional: 'shell', skipReason: '可选：需桌面壳（未传 --shell / --only=smoke-ipc）' },
  ),
  versionSyncItem(),
  cargoTestItem(),
  artifactAuditItem(),
  languageSuiteItem(),
  launcherSmokeItem(),
]);

/**
 * `--release` 的默认项序（§16.10 R9.5–R9.7 的发版机器面）：
 * 版本同步 → 双 typecheck → 审计 → conformance → 语言套件 → 两池 → 产物上界 → Rust。
 * 顺序是判定顺序的语义表达（版本不一致不该先花 10 分钟跑测试），故与 DEFAULT_ITEMS 的
 * 追加顺序解耦，由这张表钉住。
 */
export const RELEASE_ITEM_IDS = Object.freeze([
  'version-sync',
  'typecheck-root',
  'typecheck-app',
  'audit',
  'conformance',
  'language-suite',
  'test-unit',
  'test-perf',
  'artifact-audit',
  'cargo-test',
]);

export const ITEM_IDS = Object.freeze(DEFAULT_ITEMS.map((item) => item.id));

export const USAGE = [
  '用法：node tools/release-gate.mjs [选项]',
  '',
  '选项：',
  '  --json             stdout 只输出机器可读 JSON（schemaVersion=1），不含人类文本',
  '  --release          发布全量档（§16.10 R9.5–R9.7）：version-sync → 双 typecheck → audit →',
  '                     conformance → language-suite → 两池 → artifact-audit → cargo-test；',
  '                     --shell / --corpus / --build 仍按开关追加；--only 优先于本档',
  '  --only=<id,...>    只跑指定项（按项清单顺序执行，不是参数顺序；点名的可选项照跑）',
  '  --skip-tests       跳过 test-unit / test-perf / corpus（快速档；显式 --only 点名的仍会跑）',
  '  --fail-fast        首项失败后不再执行后续项（默认失败隔离：一项红继续跑）',
  '  --build            追加 build-app（默认不跑，构建耗时且非每次发布门槛必需）',
  '  --corpus           追加 corpus（先探语料在不在位；缺语料记 SKIP，不当失败）',
  '  --shell            追加 smoke-dom / smoke-ipc 两项桌面壳冒烟（需桌面会话 + WebView2）',
  '  --launcher-smoke   追加 launcher-smoke（启动器真壳冒烟；需桌面壳 + 隔离 appData，默认 SKIP）',
  '  -h, --help         显示本帮助',
  '',
  `项：${ITEM_IDS.join(', ')}`,
  '可选五项默认 SKIP 并记原因：build-app(--build) / corpus(--corpus) / smoke-dom,smoke-ipc(--shell) /',
  'launcher-smoke(--launcher-smoke)。',
  '仅 --release（或显式 --only）才跑：version-sync / cargo-test / artifact-audit / language-suite。',
  '',
  '退出码：0 = 全绿；1 = 有失败（含超时 / runner 异常）；2 = 用法错误',
].join('\n');

function addOnly(options, raw, errors) {
  const ids = String(raw)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    errors.push('--only= 需要至少一个项 id');
    return;
  }
  for (const id of ids) if (!options.only.includes(id)) options.only.push(id);
}

/** argv 只做解析，不执行；未知参数进 errors（调用方决定 exit 2） */
export function parseArgs(argv = []) {
  const options = {
    json: false,
    release: false,
    skipTests: false,
    failFast: false,
    build: false,
    corpus: false,
    shell: false,
    launcherSmoke: false,
    only: [],
    help: false,
  };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--release') options.release = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--fail-fast') options.failFast = true;
    else if (arg === '--build') options.build = true;
    else if (arg === '--corpus') options.corpus = true;
    else if (arg === '--shell') options.shell = true;
    else if (arg === '--launcher-smoke') options.launcherSmoke = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only') {
      const value = argv[index + 1];
      if (value === undefined) errors.push('--only 需要一个值');
      else {
        addOnly(options, value, errors);
        index += 1;
      }
    } else if (arg.startsWith('--only=')) addOnly(options, arg.slice('--only='.length), errors);
    else errors.push(`未知参数：${arg}`);
  }
  return { options, errors };
}

/**
 * 选项目：缺省 = 6 个核心项（其余 5 个可选，4 个 releaseOnly 默认不做）。
 * - `--skip-tests` 去掉测试池（test-unit / test-perf / corpus），但**显式点名**的优先
 *   （`--only=test-unit --skip-tests` 仍跑，便于只跑单池）；
 * - `optional` 声明的开关（build / corpus / shell / launcherSmoke）打开才收可选段；`--only` 点名的**无视开关**
 *   （`--only=smoke-dom` 不带 `--shell` 也跑，便于单点复跑）。
 * - `releaseOnly` 项（version-sync / cargo-test / artifact-audit / language-suite）只在
 *   `--release` 或显式 `--only` 时跑，否则记 SKIP + `skipReason`——默认档（CI 快速档）账不变。
 * - `--release` 的项序由 `RELEASE_ITEM_IDS` 决定（不是 DEFAULT_ITEMS 顺序）；开关追加的可选项
 *   仍按 DEFAULT_ITEMS 顺序接在末尾；`--only` 存在时**优先于** `--release`（单点复跑用）。
 * 返回的 skipped 记录未跑项与原因，JSON/human 都直接消费。
 */
export function resolveSelectedItems({
  only = [],
  skipTests = false,
  build = false,
  corpus = false,
  shell = false,
  launcherSmoke = false,
  release = false,
} = {}) {
  const unknown = only.filter((id) => !ITEM_IDS.includes(id));
  if (unknown.length > 0) {
    return { error: `未知项：${unknown.join(', ')}（可用项：${ITEM_IDS.join(', ')}）` };
  }
  const explicit = new Set(only);
  const unlocked = { build, corpus, shell, launcherSmoke };
  const byId = new Map(DEFAULT_ITEMS.map((item) => [item.id, item]));

  let selected;
  if (only.length > 0) {
    selected = DEFAULT_ITEMS.filter((item) => explicit.has(item.id));
  } else if (release) {
    const releaseItems = RELEASE_ITEM_IDS.map((id) => byId.get(id)).filter(Boolean);
    const extras = DEFAULT_ITEMS.filter(
      (item) =>
        !RELEASE_ITEM_IDS.includes(item.id) && item.optional !== undefined && unlocked[item.optional] === true,
    );
    selected = [...releaseItems, ...extras];
  } else {
    selected = DEFAULT_ITEMS.filter(
      (item) =>
        item.releaseOnly !== true && (item.optional === undefined || unlocked[item.optional] === true),
    );
  }
  if (skipTests) selected = selected.filter((item) => item.kind !== 'test' || explicit.has(item.id));

  if (selected.length === 0) return { error: '没有可执行的项（检查 --only / --skip-tests / --release）' };

  const skipped = DEFAULT_ITEMS.filter((item) => !selected.includes(item)).map((item) => ({
    id: item.id,
    reason:
      item.kind === 'test' && skipTests
        ? '--skip-tests'
        : item.releaseOnly === true
          ? item.skipReason
          : item.optional !== undefined && unlocked[item.optional] !== true
            ? item.skipReason
            : '--only 未选中',
  }));
  return { items: selected, skipped };
}

function normalizeRc(value) {
  const rc = Number(value);
  return Number.isInteger(rc) && rc >= 0 ? rc : 1;
}

function errorText(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * 纯执行编排：runner 由调用方注入（真跑用 `createProcessRunner()`，单测用假函数）。
 * runner 契约：`async ({ id, command, args, cwd, timeoutMs, shell, env? }) =>
 *   ({ rc, stdout, stderr, timedOut?, ms? })`。
 * runner 抛错 = rc 127；超时 = rc 124；两者都 FAIL，且不中断后续项（除 failFast）。
 *
 * 前置探针（`item.preflight`）跑在该项之前，能把一项**变成 SKIP**（缺前置）或**变成 FAIL**
 * （前置坏了）——两种都由项自己说清原因，编排层不改口径：
 *   `{ skip: reason }` / `{ fail: { rc, tail, readings } }` / `{ env, readings }`。
 *
 * 两类不进 runner 的检查（`--release` 档）：
 * - `item.local({ cwd, readText, readDist }) → { rc, readings, tail }`：进程内读盘/量产物
 *   （version-sync / artifact-audit），结果形状与子进程项**逐字同构**（六键）；
 * - `item.interpret({ rc, timedOut, stdout, stderr, text, readings }) → { skip } | null`：
 *   按输出定性（language 子命令不存在 = SKIP 而非 FAIL）；只允许改判成 SKIP，绿色/红色仍由 rc 定。
 */
export function createReleaseGate({
  run,
  now = () => Date.now(),
  readText = defaultReadText,
  readDist = defaultReadDist,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createReleaseGate 需要注入 run({id,command,args,...})');

  async function preflightItem(item, cwd) {
    if (typeof item.preflight !== 'function') return null;
    try {
      return await item.preflight({ run, cwd });
    } catch (error) {
      return {
        fail: {
          rc: 127,
          tail: `[release-gate] 前置探针抛错：${errorText(error)}`,
          readings: { phase: 'preflight', preflightError: true },
        },
      };
    }
  }

  async function executeItem(item, cwd = ROOT) {
    const started = now();
    const prepared = await preflightItem(item, cwd);
    if (prepared !== null && typeof prepared === 'object') {
      if (typeof prepared.skip === 'string' && prepared.skip.length > 0) {
        return { skip: { id: item.id, reason: prepared.skip } };
      }
      if (prepared.fail !== undefined) {
        const failRc = normalizeRc(prepared.fail?.rc);
        const failReadings =
          prepared.fail?.readings !== null && typeof prepared.fail?.readings === 'object' ? prepared.fail.readings : {};
        return {
          result: {
            id: item.id,
            cmd: item.cmd,
            rc: failRc,
            ms: Math.max(0, now() - started),
            readings: { ...failReadings },
            tail: lastLines(String(prepared.fail?.tail ?? '')),
          },
          ok: false,
        };
      }
    }

    // 进程内检查：没有 command 可跑，但结果必须与子进程项同构（id/cmd/rc/ms/readings/tail）
    if (typeof item.local === 'function') {
      let outcome;
      try {
        outcome = await item.local({ cwd, readText, readDist });
      } catch (error) {
        outcome = {
          rc: 127,
          readings: { phase: 'local', localError: true },
          tail: `[release-gate] 本地检查抛错：${errorText(error)}`,
        };
      }
      const localRc = normalizeRc(outcome?.rc);
      let localReadings =
        outcome?.readings !== null && typeof outcome?.readings === 'object' && !Array.isArray(outcome.readings)
          ? { ...outcome.readings }
          : {};
      if (prepared?.readings !== null && typeof prepared?.readings === 'object') {
        localReadings = { ...prepared.readings, ...localReadings };
      }
      return {
        result: {
          id: item.id,
          cmd: item.cmd,
          rc: localRc,
          ms: Math.max(0, now() - started),
          readings: localReadings,
          tail: lastLines(String(outcome?.tail ?? '')),
        },
        ok: localRc === 0,
      };
    }

    let raw;
    const request = {
      id: item.id,
      command: item.command,
      args: [...item.args],
      cwd,
      timeoutMs: item.timeoutMs,
      shell: item.shell,
    };
    if (prepared?.env !== undefined && prepared.env !== null) request.env = { ...prepared.env };
    try {
      raw = await run(request);
    } catch (error) {
      raw = { rc: 127, stdout: '', stderr: `[release-gate] runner 抛错：${errorText(error)}`, timedOut: false };
    }

    const timedOut = raw?.timedOut === true;
    const rc = timedOut ? 124 : normalizeRc(raw?.rc);
    const stdout = String(raw?.stdout ?? '');
    const stderr = String(raw?.stderr ?? '');
    let readings;
    try {
      readings = item.parse ? item.parse(readAll({ stdout, stderr }), rc) : {};
    } catch (error) {
      readings = { parsed: false, parseError: error instanceof Error ? error.message : String(error) };
    }
    if (readings === null || typeof readings !== 'object' || Array.isArray(readings)) readings = {};
    // 探针读数（如语料目录）垫在下面：命令自己的读数优先，但探针信息不许丢。
    if (prepared?.readings !== null && typeof prepared?.readings === 'object') {
      readings = { ...prepared.readings, ...readings };
    }
    if (timedOut) readings = { ...readings, timeout: true };

    // 按输出定性：只允许「改判成 SKIP」（缺子命令等），不能把红洗绿。
    if (typeof item.interpret === 'function') {
      let verdict = null;
      try {
        verdict = item.interpret({ rc, timedOut, stdout, stderr, text: readAll({ stdout, stderr }), readings });
      } catch {
        verdict = null;
      }
      if (verdict !== null && typeof verdict === 'object' && typeof verdict.skip === 'string' && verdict.skip.length > 0) {
        return { skip: { id: item.id, reason: verdict.skip } };
      }
    }

    const measured = Number(raw?.ms);
    const ms = Number.isFinite(measured) ? Math.max(0, Math.round(measured)) : Math.max(0, now() - started);
    return {
      result: { id: item.id, cmd: item.cmd, rc, ms, readings, tail: lastLines(`${stdout}\n${stderr}`) },
      ok: rc === 0 && !timedOut,
    };
  }

  async function execute(items, { cwd = ROOT, failFast = false } = {}) {
    const results = [];
    const failed = [];
    const skipped = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const outcome = await executeItem(item, cwd);
      // 前置不满足 ⇒ SKIP（不是 FAIL，也不静默：原因一路带到报告里）
      if (outcome.skip !== undefined) {
        skipped.push(outcome.skip);
        continue;
      }
      results.push(outcome.result);
      if (!outcome.ok) {
        failed.push(item.id);
        if (failFast && index + 1 < items.length) {
          for (const rest of items.slice(index + 1)) skipped.push({ id: rest.id, reason: '--fail-fast' });
          break;
        }
      }
    }
    return { items: results, failed, skipped };
  }

  return { executeItem, execute };
}

/** 真 runner：spawn + 超时杀进程树 + 捕获输出（不落盘）。`env` 为附加环境变量（语料项用） */
export function createProcessRunner({ spawnImpl = spawn, killTree, maxCaptureChars = MAX_CAPTURE_CHARS } = {}) {
  return function run({ command, args = [], cwd = ROOT, timeoutMs = 0, shell = false, env }) {
    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let timer = null;
      let graceTimer = null;

      const push = (stream, chunk) => {
        const text = String(chunk);
        if (stream === 'stdout') {
          stdout += text;
          if (stdout.length > maxCaptureChars) {
            stdout = stdout.slice(-maxCaptureChars);
            stdoutTruncated = true;
          }
        } else {
          stderr += text;
          if (stderr.length > maxCaptureChars) {
            stderr = stderr.slice(-maxCaptureChars);
            stderrTruncated = true;
          }
        }
      };

      const finish = (rc) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        resolve({
          rc,
          stdout,
          stderr,
          timedOut,
          ms: Date.now() - started,
          stdoutTruncated,
          stderrTruncated,
        });
      };

      let child;
      try {
        child = spawnImpl(command, args, {
          cwd,
          shell,
          windowsHide: true,
          detached: !IS_WINDOWS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...(env ?? {}) },
        });
      } catch (error) {
        finish(127);
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => push('stdout', chunk));
      child.stderr?.on('data', (chunk) => push('stderr', chunk));
      child.on('error', (error) => {
        push('stderr', `[release-gate] spawn 失败：${errorText(error)}\n`);
        finish(127);
      });
      child.on('close', (code) => finish(timedOut ? 124 : normalizeRc(code ?? 1)));

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            (killTree ?? defaultKillTree)(child.pid);
          } catch {
            /* 杀不动也要收尾：下面的 grace 会兜底 resolve */
          }
          graceTimer = setTimeout(() => finish(124), 3000);
        }, timeoutMs);
      }
    });
  };
}

function defaultKillTree(pid) {
  if (!pid) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

/** 稳定 JSON：顶层与每项的键序固定，测试与 CI 可直接断言结构 */
export function formatReport(report, { json = false } = {}) {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [];
  lines.push(
    `kojo release gate · ${report.items.length} 项 · ${report.result} · ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  report.items.forEach((item, index) => {
    lines.push(
      `[${index + 1}/${report.items.length}] ${item.id} — ${item.rc === 0 ? 'PASS' : 'FAIL'} · ${item.ms}ms · rc=${item.rc}`,
    );
    if (Object.keys(item.readings).length > 0) lines.push(`      readings: ${JSON.stringify(item.readings)}`);
    if (item.rc !== 0 && item.tail.length > 0) {
      for (const line of item.tail.split('\n')) lines.push(`      | ${line}`);
    }
  });
  for (const entry of report.skipped) lines.push(`SKIP ${entry.id}（${entry.reason}）`);
  lines.push(`RESULT: ${report.result}`);
  if (report.failed.length > 0) lines.push(`failed: ${report.failed.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/**
 * CLI 级入口（可测、不碰 process.exitCode）：解析 argv → 选项目 → 执行 → 格式化。
 * 返回 `{ code, report, text }`；帮助 `code=0`，用法错误 `code=2`（report=null）。
 */
export async function runReleaseGate({
  argv = [],
  run,
  cwd = ROOT,
  now = () => Date.now(),
  readText = defaultReadText,
  readDist = defaultReadDist,
  writeOut = (text) => void process.stdout.write(text),
  writeErr = (text) => void process.stderr.write(text),
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    const text = `${USAGE}\n`;
    writeOut(text);
    return { code: 0, report: null, text };
  }
  if (parsed.errors.length > 0) {
    const text = `${parsed.errors.join('\n')}\n\n${USAGE}\n`;
    writeErr(text);
    return { code: 2, report: null, text };
  }

  const selected = resolveSelectedItems(parsed.options);
  if (selected.error) {
    const text = `${selected.error}\n\n${USAGE}\n`;
    writeErr(text);
    return { code: 2, report: null, text };
  }

  const runner = run ?? createProcessRunner();
  const gate = createReleaseGate({ run: runner, now, readText, readDist });
  const started = now();
  const execution = await gate.execute(selected.items, { cwd, failFast: parsed.options.failFast });
  const durationMs = Math.max(0, Math.round(now() - started));
  const report = {
    tool: 'release-gate',
    schemaVersion: 1,
    result: execution.failed.length === 0 ? 'PASS' : 'FAIL',
    exitCode: execution.failed.length === 0 ? 0 : 1,
    durationMs,
    items: execution.items,
    failed: execution.failed,
    skipped: [...selected.skipped, ...execution.skipped],
  };
  const text = formatReport(report, { json: parsed.options.json });
  writeOut(text);
  return { code: report.exitCode, report, text };
}

function isDirectInvocation() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  runReleaseGate({ argv: process.argv.slice(2) })
    .then(({ code }) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[release-gate] 未捕获异常：${errorText(error)}`);
      process.exitCode = 1;
    });
}

