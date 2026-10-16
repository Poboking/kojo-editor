/**
 * 墙钟计时用例的**分池真源**（唯一一份谓词 + 扫描逻辑）。
 *
 * 为什么要有这个文件：`pnpm test` 把计时用例和功能用例挤在同一个并行池里，
 * 计时用例互相饿死 → CI 墙钟断言随机红（重跑即绿）。机制层的修法只有一个：
 * **计时用例单独进串行静默池**。这里定义"哪些文件算计时用例"，
 * `vitest.config.ts`（排除它们）与 `vitest.perf.config.ts`（只跑它们）共用同一次扫描。
 *
 * 谓词是**源码级**的（不靠用例作者自觉打标记），两条证据任一成立即入池：
 * 1. 文件名 `*.perf.test.ts` —— 作者已经声明"这是读数用例"；
 * 2. 源码同时含 `performance.now(` **且**含一条对墙钟量的比较断言
 *    （`expect(<墙钟量>).toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual`）。
 *
 * 为什么不放宽到"只要出现 `<` 比较就算"：`packages/app/tests/cascade-watermarks.test.ts`
 * 用**假时钟**（自己喂 `() => t`，全文没有 `performance.now(`），它的 `ms` 是算术结果而非墙钟量
 * —— 把它拉进串行池就是把机制的开销花在不需要静默的文件上，所以判 false。
 * 反过来 `x.length` / `steps` / `items.length` 这类断言也不是墙钟量（名字表里没有 `length`/`steps`）。
 *
 * 类型声明见 `perf-suite.d.mts`（root `tsconfig.json` 的 include 里有 `vitest.config.ts`，
 * 它 import 本模块，strict + noUncheckedIndexedAccess 下必须有 .d.mts，否则 TS7016）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（win32 下也能跑：靠往上找 workspace 清单，不硬编码分隔符） */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 默认扫描根：从本文件所在目录往上找 `pnpm-workspace.yaml`；找不到就退回本目录 */
function defaultRootDir() {
  let dir = MODULE_DIR;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return MODULE_DIR;
}

/** `*.perf.test.ts` —— 文件名即意图，不需要再猜源码 */
const PERF_NAME_RE = /\.perf\.test\.ts$/;

/** 墙钟量的比较方法（只有这四条：比值/预算/单调都落在它们身上） */
const COMPARATOR_TAIL_RE =
  /^\s*(?:\.not)?\s*\.\s*(?:toBeLessThanOrEqual|toBeLessThan|toBeGreaterThanOrEqual|toBeGreaterThan)\s*\(/;

/**
 * 计时惯用名，三种式样（全部要求**词尾是词的尽头**，见下面每条的环视）：
 * - 后缀式 `fastMs` / `qMs` / `syncCost` / `coldTime`：只认**大写了的** `Ms`——
 *   小写 `ms` 会命中 `items` / `systems` / `names` 这类普通复数，正是本判据要排除的假阳性；
 * - 前缀式 `msAfter` / `msBefore`（本仓库 marker-hotpath 的命名习惯）：小写 `ms` 紧跟大写字母；
 * - 整词式 `ms` / `median` / `p95` / `elapsed` / `cold` / `warm` / `hot` / `best` / `budget` …：
 *   两端都不能贴着的标识符字符（`.median` 的点是允许的，`items` 里的 `ms` 不允许）。
 */
const TIMING_NAME_RE = new RegExp(
  [
    String.raw`[A-Za-z0-9_$][A-Za-z0-9_$]*(?:Ms|Time|Duration|Latency|Cost|Budget)(?![A-Za-z0-9_$])`,
    String.raw`(?<![A-Za-z0-9_$])ms[A-Z][A-Za-z0-9_$]*(?![A-Za-z0-9_$])`,
    String.raw`(?<![A-Za-z0-9_$])(?:ms|median|mean|p50|p75|p95|p99|elapsed|latency|cost|duration|budget|cold|warm|hot|best)(?![A-Za-z0-9_$])`,
  ].join('|'),
);

const PERF_NOW = 'performance.now(';
const IDENT_ESC = /[.+*?^${}()|[\]\\]/g;

const wordRe = (/** @type {string} */ word) =>
  new RegExp(String.raw`(?<![A-Za-z0-9_$])` + word.replace(IDENT_ESC, '\\$&') + String.raw`(?![A-Za-z0-9_$])`);

/**
 * 从 `open` 处（`expect(` 的左括号**之后**第一个字符）读配对括号内的内容。
 * @param {string} src
 * @param {number} open
 * @returns {{ text: string; end: number } | null} `end` = 右括号下标
 */
function readBalanced(src, open) {
  let depth = 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { text: src.slice(open, i), end: i };
    } else if (c === '`' || c === '"' || c === "'") {
      // 跳过字符串字面量（里面的括号不参与配对）
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
  }
  return null;
}

/**
 * 抽出所有"由 `const/let/var NAME = …` 或 `function NAME(...) {…}` 声明"的 NAME → 其初始化文本。
 * 初始化文本按括号深度扫到深度 0 后的第一个换行/分号，因此多行箭头函数体也算在内。
 * @param {string} src
 */
function declarations(src) {
  /** @type {{ name: string; text: string }[]} */
  const out = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*|\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    let i = (m[1] ? m.index + m[0].length : src.indexOf('{', re.lastIndex));
    if (i < 0 || i >= src.length) continue;
    let depth = 0;
    let start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0 && m[2] === undefined) {
          // 值式初始化：深度归零后继续吃到本条语句结束
        }
      } else if (depth === 0 && (c === '\n' || c === ';')) break;
      if (i - start > 20000) break; // 病态兜底
    }
    out.push({ name, text: src.slice(start, i) });
  }
  return out;
}

/**
 * 这个文件里"承载墙钟量"的名字集合：直接由 `performance.now(` 喂出来的，
 * 加上逐层传递（初值里引用了已知计时名 / `xs.push(performance.now() - t0)` 这类收集器）。
 * @param {string} src
 */
function timingVars(src) {
  /** @type {Set<string>} */
  const known = new Set();
  const decls = declarations(src);
  /** 收集器：`xs.push(<含墙钟量的表达式>)` ⇒ `xs` 也装的是墙钟量 */
  for (const m of src.matchAll(/\b([A-Za-z0-9_$]+)\s*\.\s*(?:push|set|add|unshift)\s*\(([^;]*)/g)) {
    const bucket = m[1];
    if (!bucket) continue;
    if (m[2] && (m[2].includes(PERF_NOW) || [...known].some((v) => wordRe(v).test(m[2])))) known.add(bucket);
  }
  for (const { name, text } of decls) if (text.includes(PERF_NOW)) known.add(name);
  for (let pass = 0; pass < 6; pass++) {
    let grew = false;
    for (const { name, text } of decls) {
      if (known.has(name) || !text) continue;
      for (const v of known) {
        if (wordRe(v).test(text)) {
          known.add(name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  return known;
}

/**
 * 源码是不是"墙钟预算用例"：`performance.now(` + 一条对它（或它的派生量）的比较断言。
 * @param {string} src
 * @returns {boolean}
 */
export function isTimingBudgetSource(src) {
  if (!src.includes(PERF_NOW)) return false; // 假时钟用例（如 cascade-watermarks）在这一条就被排除
  const vars = timingVars(src);
  let i = 0;
  while ((i = src.indexOf('expect(', i)) !== -1) {
    const open = i + 'expect('.length;
    const got = readBalanced(src, open);
    if (!got) break;
    if (COMPARATOR_TAIL_RE.test(src.slice(got.end + 1, got.end + 90))) {
      const arg = got.text;
      if (TIMING_NAME_RE.test(arg)) return true;
      for (const v of vars) if (wordRe(v).test(arg)) return true;
    }
    i = open;
  }
  return false;
}

/** 跳过这些目录（构建产物 / 依赖 / git） */
function skip(dirName) {
  return dirName === 'node_modules' || dirName === 'dist' || dirName === '.git' || dirName.startsWith('.');
}

/**
 * 按主配置的 include 口径递归收集测试文件：
 * `packages/**\/tests/**\/ *.test.ts` 与 `tools/tests/**\/*.test.ts`。
 * @param {string} root
 * @param {string} rel
 * @param {string[]} out
 */
function collect(root, rel, out) {
  const abs = rel ? join(root, rel) : root;
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (skip(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      collect(root, childRel, out);
    } else if (e.isFile() && e.name.endsWith('.test.ts')) {
      const top = childRel.split('/')[0] ?? '';
      const parts = childRel.split('/');
      const inPackages = top === 'packages' && parts.includes('tests');
      const inTools = childRel.startsWith('tools/tests/');
      if (inPackages || inTools) out.push(childRel);
    }
  }
  return out;
}

/**
 * 扫两张池。返回 posix 风格、相对 `rootDir` 的路径，三个数组各自升序。
 * @param {string} [rootDir]
 * @returns {{ perf: string[]; normal: string[]; all: string[] }}
 */
export function scanPerfTestFiles(rootDir) {
  const root = rootDir ?? defaultRootDir();
  /** @type {string[]} */
  const perf = [];
  /** @type {string[]} */
  const normal = [];
  for (const rel of collect(root, '', [])) {
    let src = '';
    try {
      src = readFileSync(join(root, ...rel.split('/')), 'utf8');
    } catch {
      src = '';
    }
    if (PERF_NAME_RE.test(rel) || isTimingBudgetSource(src)) perf.push(rel);
    else normal.push(rel);
  }
  perf.sort();
  normal.sort();
  return { perf, normal, all: [...perf, ...normal].sort() };
}

/** vitest 默认 exclude 的等价物（写了自定义 exclude 就得自己列全） */
const VITEST_DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

/**
 * 主配置（并行功能池）的 `test.exclude`：默认三项 + 全部计时文件。
 * @param {string} [rootDir]
 */
export function mainExclude(rootDir) {
  return [...VITEST_DEFAULT_EXCLUDE, ...scanPerfTestFiles(rootDir).perf];
}

/**
 * 计时池（串行静默）的 `test.include`：与 `mainExclude()` 出自同一个谓词。
 * @param {string} [rootDir]
 */
export function perfInclude(rootDir) {
  return scanPerfTestFiles(rootDir).perf;
}

export { VITEST_DEFAULT_EXCLUDE };

/* ============================== CLI：`node tools/perf-suite.mjs --print` ============================== */

/** 直接 `node tools/perf-suite.mjs` 跑时才打印（被配置 import 时不产生输出） */
const invokedDirectly = process.argv[1] !== undefined && basename(process.argv[1]) === 'perf-suite.mjs';

if (invokedDirectly) {
  const root = defaultRootDir();
  const pools = scanPerfTestFiles(root);
  if (process.argv.slice(2).includes('--print')) {
    console.log(`[perf-suite] root = ${root}`);
    console.log(`[perf-suite] 计时串行池 ${pools.perf.length} 个文件：`);
    for (const f of pools.perf) console.log(`  perf   ${f}`);
    console.log(`[perf-suite] 功能并行池 ${pools.normal.length} 个文件（清单略）`);
    // 自证：池里每个文件都必须能被谓词/文件名两条理由之一解释（防手改清单）
    const bad = pools.perf.filter(
      (f) => !PERF_NAME_RE.test(f) && !isTimingBudgetSource(readFileSync(join(root, ...f.split('/')), 'utf8')),
    );
    console.log(`[perf-suite] 自证：无凭据的文件 ${bad.length} 个${bad.length ? ` → ${bad.join(', ')}` : ''}`);
  } else {
    console.log(JSON.stringify(pools, null, 2));
  }
}
