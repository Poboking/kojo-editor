#!/usr/bin/env node
/**
 * scan-bytes — 源码树里的「裸字节」体检：NUL / BOM / 非法 UTF-8（可选：孤立 CR）。
 *
 * 为什么要有这个工具，而不是一行 grep：
 *   `grep -c $'\x00' file` 量出「355 行全命中」，而文件里其实**一个 NUL 都没有**。
 *   原因是 shell 参数里传不了 NUL —— bash 把 `$'\x00'` 截成空串，pattern 变成"匹配所有行"。
 *   于是"全命中"被读成"全是问题"，结论完全反了（2026-10-31 在 CMD-NUL-BYTE 上实拍）。
 *   ⇒ 查裸字节只能在**字节层面**做，不能经过 shell 的参数字符串。
 *
 * 判据：
 *   ① NUL（0x00）：任何文本源码含裸 NUL，`file` 会判二进制，其后整段在 grep/diff/评审里失明。
 *   ② BOM（EF BB BF）：JS/TS 的 BOM 会让首行 token 前多一个不可见字符；本仓约定不写 BOM。
 *   ③ 非法 UTF-8：`TextDecoder('utf-8', {fatal:true})` 抛错 ⇒ 该文件在别的工具链里会变乱码。
 *   ④ 孤立 CR（`\r` 后不跟 `\n`，需 `--cr`）：EOL 归一里它算换行，源码里出现几乎总是事故；
 *      但语料夹具可能**故意**含它，所以默认不查，只在显式要求时报。
 *
 * 用法：
 *   node tools/scan-bytes.mjs              # 默认扫 packages / tools / docs / 根配置
 *   node tools/scan-bytes.mjs --cr         # 连孤立 CR 一起查
 *   node tools/scan-bytes.mjs --json       # 机器可读
 *   node tools/scan-bytes.mjs --root . --only packages/app/src
 * 退出码：发现问题 1，干净 0。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const CHECK_CR = has('--cr');
const AS_JSON = has('--json');
const ONLY = valOf('--only', null);

/** 只看这些后缀：文本源码与文档；二进制素材（png/ico/zip）本就不该被扫 */
const EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.json', '.jsonc', '.md', '.mdx', '.html', '.htm',
  '.toml', '.yml', '.yaml', '.rs', '.txt', '.erb', '.erh',
  '.kojo', '.kojo1', '.kojo2', '.snap',
]);

/** 与 vitest / tsc 的排除口径对齐：产物与依赖不进体检 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'target',
  '.turbo', '.vite', '.cache', '.workbuddy', 'out', '.output',
]);

const DEFAULT_ROOTS = ['packages', 'tools', 'docs', 'scripts'];

/**
 * 故意"带病"的位置逐枚登记——体检工具不给自己留"永远红"的口子，否则没人会跑。
 * `kind` 必须与问题类型一致；`match` 打绝对相对路径（正斜杠）。
 */
const ALLOW = [
  {
    kind: 'BOM',
    match: /(^|\/)bom-narration\.[^/]*$/,
    why: '夹具：文件名即意图（`bom-narration`），测的就是"读到 BOM 怎么办"，必须含 BOM',
  },
];
const isAllowed = (kind, rel) => ALLOW.some((a) => a.kind === kind && a.match.test(rel));

/** @type {{file:string,line:number,offset:number,kind:string,detail:string}[]} */
const findings = [];
let scanned = 0;
let skippedExt = 0;

const lineOf = (buf, off) => {
  let n = 1;
  for (let i = 0; i < off && i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
};

function checkFile(abs, rel) {
  // 输出统一正斜杠：Windows 上 path.join 给的是反斜杠，报表跨主机要能直接粘进提交信息
  const posix = rel.split(path.sep).join('/');
  const push = (kind, line, offset, detail) => {
    if (isAllowed(kind, posix)) return;
    findings.push({ file: posix, line, offset, kind, detail });
  };
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    findings.push({ file: posix, line: 0, offset: 0, kind: 'READ', detail: String(err) });
    return;
  }
  scanned++;

  // ① NUL：逐字节找，绝不经 shell
  for (let i = buf.indexOf(0x00); i >= 0; i = buf.indexOf(0x00, i + 1)) {
    push(
      'NUL',
      lineOf(buf, i),
      i,
      `0x${i.toString(16)} 处有裸 NUL（文件会被判成二进制，其后整段在 grep/diff 里失明）`,
    );
  }

  // ② BOM：只可能在文件头
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    push('BOM', 1, 0, 'UTF-8 BOM：首行第一个 token 前多一个不可见字符（本仓约定不写 BOM）');
  }

  // ③ 非法 UTF-8：严格解码，一个字节都不放过
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 定位首个坏序列：按 UTF-8 前导字节算长度（1/2/3/4），哪一步解不开就是它。
    // 不用"逐字节 + 试所有长度"——那会把一个孤立的续字节误判成它前一个字符。
    let off = 0;
    for (let i = 0; i < buf.length; ) {
      const b = buf[i];
      const len = b < 0x80 ? 1 : b >= 0xf0 && b <= 0xf7 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      const end = Math.min(i + len, buf.length);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(i, end));
        i = end;
      } catch {
        off = i;
        break;
      }
    }
    push(
      'UTF8',
      lineOf(buf, off),
      off,
      `非法 UTF-8 序列（首个可疑字节 0x${off.toString(16)}）；跨工具链会变乱码`,
    );
  }

  // ④ 孤立 CR：`\r` 后不是 `\n` 也不是文件尾
  if (CHECK_CR) {
    for (let i = buf.indexOf(0x0d); i >= 0; i = buf.indexOf(0x0d, i + 1)) {
      if (buf[i + 1] === 0x0a) continue;
      push(
        'CR',
        lineOf(buf, i),
        i,
        '孤立 CR（不是 CRLF）：归一化后算一次换行，源码里出现通常是事故',
      );
    }
  }
}

function walk(absDir, relDir) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const rel = path.join(relDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, rel);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!EXTS.has(ext)) {
      skippedExt++;
      continue;
    }
    // 超大文件跳过（>8MB）：源码不该有这么大的文本文件，真有大文件另行人工看
    try {
      if (statSync(abs).size > 8 * 1024 * 1024) continue;
    } catch {
      continue;
    }
    checkFile(abs, rel);
  }
}

const roots = ONLY ? [ONLY] : DEFAULT_ROOTS;
// 用 resolve 而不是 join：`--only` 要能接受绝对路径（红验证/单点排查时用）
for (const r of roots) walk(path.resolve(ROOT, r), r);

// 根目录下的零散配置也扫（package.json / tsconfig 等）
if (!ONLY) {
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!EXTS.has(ext)) continue;
    checkFile(path.join(ROOT, e.name), e.name);
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ scanned, skippedExt, count: findings.length, findings }, null, 2));
} else {
  const byKind = findings.reduce((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  console.log(
    `scan-bytes: 扫 ${scanned} 个文本文件` +
      `${CHECK_CR ? '（含孤立 CR）' : ''} ⇒ ` +
      (findings.length === 0
        ? '干净：NUL / BOM / 非法 UTF-8 零命中'
        : `${findings.length} 处问题 ${JSON.stringify(byKind)}`),
  );
  for (const f of findings) {
    console.log(`  ${f.kind.padEnd(5)} ${f.file}:${f.line}  ${f.detail}`);
  }
  if (findings.length > 0) {
    console.log('\n提示：查裸字节不要用 `grep -c $\'\\x00\'` —— shell 参数里传不了 NUL，pattern 会被截成空串。');
  }
}

process.exit(findings.length === 0 ? 0 : 1);
