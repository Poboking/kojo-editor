// 语料盘**内容指纹**（2026-11-06 批）：给「按盘钉数」的语料闸一个能说清"是哪份盘"的身份。
//
// 为什么要它：本仓一批真实语料活闸把命中数**钉死成某个具体数字**，而那些数字是在**另一版语料盘**
// 上量的。目录名会被用户随时重排（`tools/corpus.mjs` 的头注已经把这条写成铁律：认内容不认名），
// 于是"红"有两种完全不同的原因——代码坏了 / 盘不对。分不清就是最坏的读数。
// 本模块只回答一个问题：**这份盘的内容是什么**（逐扩展名计数 + 逐文件 `相对路径|字节数` 摘要），
// 并让闸按指纹查表取期望：**命中已知版 ⇒ 走该版期望；未知版 ⇒ 响亮地红，并把这份盘的实测数打出来供登记**。
//
// 三条口径（不许自创第二套）：
// 1. **严禁按目录名**：指纹的输入只有相对路径与字节数，`dir` 只进人话文案、绝不进判据；
// 2. **不许 skip / 不许放宽**：盘不对是红，不是跳过，也不是"阈值松一点"；
// 3. `digest` 覆盖 **语言源**（.erb/.erh/.als/.kojo/.kojo1/.kojo2），`savDigest` 只覆盖 `sav/` 顶层——
//    分两枚是因为玩家打一局只动存档，不该把只钉 ERB 读数的闸一起带红；钉存档的闸自己带上 `savDigest`。
//
// 纪律：只读（readdir/stat），绝不写语料盘、不在盘上建任何东西。
//
/* CLI（取证 / 登记用，一行一个 JSON）：
     node tools/corpus-fingerprint.mjs                  → 人话：解析链选中的那份盘 + 指纹
     node tools/corpus-fingerprint.mjs --print          → 只打选中盘的指纹 JSON（一行）
     node tools/corpus-fingerprint.mjs --print-all      → 盘上**全部**符合内容条件的语料，一行一个 {dir,fp}
     node tools/corpus-fingerprint.mjs --print <目录>   → 指定目录（显式即授权，只查存在性）
   退出码：0 有解 / 1 盘上无符合内容的语料 / 2 指定路径不成立。 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalDirName, discoverCorpora, inspectCorpus, corpusHint, resolveCorpusDir } from './corpus.mjs';

/** 指纹算法版本：口径变了就抬它，避免旧登记值被新算法误配。 */
export const FINGERPRINT_VERSION = 'fp1';

/** 语言源后缀 → 指纹字段名（大小写不敏感；同一字段累加多种写法）。 */
const SOURCE_EXT_FIELDS = [
  ['erb', /\.erb$/i],
  ['erh', /\.erh$/i],
  ['als', /\.als$/i],
  ['kojo2', /\.kojo2$/i],
  ['kojo', /\.kojo1?$/i],
];
const SAV_DIR_NAME = 'sav';

/** 逐盘缓存（一次 vitest worker 里多枚闸共用一次遍历；key 已做大小写/尾斜杠归一）。 */
const cache = new Map();
const keyOf = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');

/** 递归收集 `root` 下的语言源文件：返回 `[{ rel, size }]`（rel = 相对 root、`/` 分隔、码点序）。 */
function collectSources(root) {
  const out = [];
  const stack = [[root, '']];
  while (stack.length > 0) {
    const [dir, relPrefix] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      const rel = relPrefix + ent.name;
      if (ent.isDirectory()) stack.push([abs, `${rel}/`]);
      else if (ent.isFile() && SOURCE_EXT_FIELDS.some(([, re]) => re.test(ent.name))) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = -1;
        }
        out.push({ rel: rel.replaceAll('\\', '/'), size });
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.size - b.size));
  return out;
}

/** `sav/` 顶层档（只认目录内容，不看外层盘名）。目录不在位 ⇒ 空数组。 */
function collectSaves(root) {
  const name = canonicalDirName(root, SAV_DIR_NAME);
  if (!name) return [];
  const dir = path.join(root, name);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || ent.isSymbolicLink()) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, ent.name)).size;
    } catch {
      size = -1;
    }
    out.push({ rel: ent.name.toLowerCase(), size });
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.size - b.size));
  return out;
}

function digestOf(rows) {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(`${r.rel}|${r.size}\n`);
  return h.digest('hex').slice(0, 12);
}

/**
 * 一份盘的指纹。字段全部可复算，与目录名无关：
 * `{ erb, erh, als, kojo, kojo2, srcBytes, digest, savFiles, savBytes, savNames, savDigest }`
 */
export function corpusFingerprint(dir) {
  if (!dir) throw new TypeError('corpusFingerprint(dir)：dir 不能为空');
  const abs = path.resolve(dir);
  const hit = cache.get(abs);
  if (hit) return hit;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`语料目录不存在或不是目录：${abs}`);
  }
  const sources = collectSources(abs);
  const counts = { erb: 0, erh: 0, als: 0, kojo: 0, kojo2: 0 };
  let srcBytes = 0;
  for (const s of sources) {
    for (const [field, re] of SOURCE_EXT_FIELDS) {
      if (re.test(s.rel)) {
        counts[field]++;
        break;
      }
    }
    srcBytes += Math.max(0, s.size);
  }
  const saves = collectSaves(abs);
  const fp = Object.freeze({
    v: FINGERPRINT_VERSION,
    ...counts,
    srcBytes,
    digest: digestOf(sources),
    savFiles: saves.length,
    savBytes: saves.reduce((n, s) => n + Math.max(0, s.size), 0),
    savNames: Object.freeze(saves.map((s) => s.rel)),
    savDigest: digestOf(saves),
  });
  cache.set(abs, fp);
  return fp;
}

/** 盘上全部符合内容条件的语料 + 各自指纹（`dir` 只进文案，判据一律走指纹）。 */
export function discoverCorpusFingerprints(opts = {}) {
  return discoverCorpora(opts).map((h) => ({ dir: h.dir, erbCount: h.erbCount, savCount: h.savCount, fp: corpusFingerprint(h.dir) }));
}

/** 人话一行：`erb 2,317 · erh 153 · als 19 · kojo 12 · kojo2 0 · src 123,456,789B · digest ab12cd34ef56 · sav 6 件/1,234B · savDigest 9f8e7d6c5b4a` */
export function formatFingerprint(fp) {
  const n = (x) => Number(x).toLocaleString('en-US');
  return `erb ${n(fp.erb)} · erh ${n(fp.erh)} · als ${n(fp.als)} · kojo ${n(fp.kojo)} · kojo2 ${n(fp.kojo2)} · src ${n(fp.srcBytes)}B · digest ${fp.digest} · sav ${fp.savFiles} 件/${n(fp.savBytes)}B · savDigest ${fp.savDigest}`;
}

/**
 * 期望登记行里的指纹子集是否被当前盘满足（逐字段严格相等；`digest` / `savDigest` 也算字段）。
 * 字段名拼错 = 红（见 `missingFields`），不许写错一个键就悄悄不匹配。
 */
export function matchesFingerprint(fp, pin) {
  return Object.entries(pin).every(([k, v]) => fp[k] === v);
}

/** 登记行里当前盘指纹**没有**的字段名（拼错键名的兜底）。 */
export function unknownPinFields(pin) {
  const known = new Set(['v', 'erb', 'erh', 'als', 'kojo', 'kojo2', 'srcBytes', 'digest', 'savFiles', 'savBytes', 'savNames', 'savDigest']);
  return Object.keys(pin).filter((k) => !known.has(k));
}

/**
 * 查表：命中登记过的盘 ⇒ 返回那一行；未知盘 ⇒ `ok:false` + 完整红文案（含这份盘的实测指纹与全部已登记盘指纹）。
 *
 * 文案硬要求（这批闸存在的**反面**就是静默放过，所以这里只许红）：
 * ① 期望指纹逐行列出；② 当前盘指纹原样给出；③ 当前盘的**实测读数**（`live`）打出来供登记；
 * ④ 盘上其它候选一并列出（`--print-all` 口径）；⑤ 取指纹的命令写全。
 */
export function resolvePinnedRow(gateId, rows, fp, live, candidates) {
  const badFields = rows.flatMap((r) => unknownPinFields(r.fp).map((k) => `${r.label} 行：字段名 ${k} 不在指纹字段表里`));
  const matched = rows.find((r) => matchesFingerprint(fp, r.fp));
  if (matched && badFields.length === 0) return { ok: true, row: matched, message: '' };
  const lines = [];
  lines.push(`【语料盘指纹不符】${gateId}`);
  if (badFields.length > 0) lines.push(`  登记行字段名拼错：\n${badFields.map((s) => `    - ${s}`).join('\n')}`);
  if (matched) lines.push('  登记行有拼错字段，**未**采用其期望值（拒绝按错键放行）。');
  lines.push(`  当前盘实测指纹：${formatFingerprint(fp)}`);
  if (live !== undefined && live !== null) lines.push(`  当前盘实测读数：${formatReadings(live)}`);
  lines.push('  已登记的盘（按指纹，不看目录名）：');
  for (const r of rows) {
    lines.push(`    · ${r.label} ⇒ fp{${Object.entries(r.fp).map(([k, v]) => `${k}:${v}`).join(', ')}} 期望{${formatReadings(r.expect)}}`);
  }
  if (candidates && candidates.length > 0) {
    lines.push('  盘上其它候选：');
    for (const c of candidates) lines.push(`    · ${c.dir} ⇒ ${formatFingerprint(c.fp)}`);
  }
  lines.push('  处理：这不是 skip 条件，也不是放宽阈值的理由。');
  lines.push('    若这份盘就是当前基准 ⇒ 用上面「当前盘实测读数」在本闸的登记表新增一行（fp + expect 都取实测）；');
  lines.push('    若想跑已登记的盘 ⇒ 设 KOJO_CORPUS_DIR=<那份盘>（或把那份盘放回扫描根），取指纹：node tools/corpus-fingerprint.mjs --print-all');
  lines.push(`  ${corpusHint()}`);
  return { ok: false, row: null, message: lines.join('\n') };
}

function formatReadings(readings) {
  if (typeof readings === 'string') return readings;
  try {
    return JSON.stringify(readings);
  } catch {
    return String(readings);
  }
}

/** 供测试复用：把"找不到的金样本档"写成一条带候选盘 sav 读数的红文案。 */
export function savCandidatesReadout(candidates) {
  if (candidates.length === 0) return '盘上没有符合内容条件（ERB/ 与 CSV/）的语料目录';
  return candidates.map((c) => `${c.dir}（${c.fp.savFiles} 件：${c.fp.savNames.join('/') || '空'}）`).join('；');
}

/* ------------------------------ CLI ------------------------------ */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const print = args.includes('--print') || args.includes('--print-all');
  const positional = args.find((a) => !a.startsWith('--'));
  try {
    if (args.includes('--print-all')) {
      const list = discoverCorpusFingerprints();
      if (list.length === 0) {
        console.error(`[FAIL] 盘上未发现符合内容条件的语料目录；${corpusHint()}`);
        process.exit(1);
      }
      process.stdout.write(`${list.map((c) => JSON.stringify({ dir: c.dir, fp: c.fp })).join('\n')}\n`);
      process.exit(0);
    }
    const dir = positional ?? resolveCorpusDir({ print: !print });
    if (!dir) {
      console.error(`[FAIL] 盘上未发现符合内容条件的语料目录；${corpusHint()}`);
      process.exit(1);
    }
    const fp = corpusFingerprint(dir);
    if (print) process.stdout.write(`${JSON.stringify({ dir, fp })}\n`);
    else console.log(`${dir}\n  ${formatFingerprint(fp)}`);
  } catch (e) {
    console.error(`[FAIL] ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** 供 `--print` 与测试复用：目录存在性检查（`inspectCorpus` 的薄封装，避免调用方各写一份）。 */
export function assertCorpusDir(dir) {
  return inspectCorpus(dir);
}
