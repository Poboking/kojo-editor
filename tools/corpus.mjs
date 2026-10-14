// 真实语料（eraTW 游戏目录）解析：**认内容不认名**。
// 语料目录名会被反复重排（同一份 4.980 内容 2026-10-14 一天内已换过两次名），硬编码目录名必然过期；
// 而「过期了还静默换个版本继续跑」比报错更糟——基线数字/golden/命中率会张冠李戴。故本模块的规则：
//   优先级：explicit（调用方的 --corpus 参数，显式即授权，只查存在性）
//        >  环境变量 KOJO_CORPUS_DIR（查存在性 + 内容条件，不符就抛错并列盘上候选，**绝不静默退化**）
//        >  扫盘自动发现（默认扫 C:/game/*，大小写盘符/目录名都能中；语料放别处就设 KOJO_CORPUS_SCAN_DIRS=<根>）
// 内容条件：根下必须有 ERB/ 与 CSV/；调用方可追加
//   needChecker → tool/erb_check.py 在位；needSaves → sav/ 非空。
// 多命中时的确定性判据（可解释、可复现，实测盘上三版语料能唯一指到基线那份）：
//   ① sav/ 非空优先 ② .ERB 文件数多者 ③ 目录名升序（码点序，与 locale 无关）。
//   为什么 ① 在 ② 前：本机「魔王改版」的 .ERB 计数（3,931）比基线「画蛇添足版」（3,818）还多，
//   单看「谁 ERB 多」会挑错版本；而 sav/ 有档正是本项目全部基线数字所依据那份的指纹（存档类闸也依赖它），
//   所以 sav 在位是第一判据，ERB 数只作同档次的次级判据。
// 一个都不命中 → 返回 null，调用方保持既有「缺前置就 SKIP/FAIL」的行为（提示文案须带 KOJO_CORPUS_DIR）。
// 纪律：本模块**只读**——只 readdir/stat，绝不写语料盘、不建临时文件。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_VAR = 'KOJO_CORPUS_DIR';
export const ENV_SCAN_DIRS = 'KOJO_CORPUS_SCAN_DIRS';   // 设了则**替换**默认扫描根（分隔符 = path.delimiter；QA 机语料在 D:\Game 时用这个）
const DEFAULT_SCAN_ROOTS = ['C:/game'];
// 基础内容条件：这两样缺一个就不是语料目录（名字随意，目录名照旧大小写不敏感匹配）。
const BASE_DIRS = ['ERB', 'CSV'];
const CHECKER_REL = ['tool', 'erb_check.py'];
const SAV_DIR = 'sav';

export class CorpusError extends Error {}

/** 扫描根：KOJO_CORPUS_SCAN_DIRS 优先（整体替换），否则默认 C:/game；去空去重（大小写不敏感）。 */
function scanRootsFromEnv(env = process.env) {
  const raw = (env[ENV_SCAN_DIRS] || '').trim();
  const list = raw ? raw.split(path.delimiter) : DEFAULT_SCAN_ROOTS;
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const t = r.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** 大小写不敏感地在 root 下找一个条目，返回盘上真实名（找不到 null）。 */
function findEntry(root, name, wantDir) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const lower = name.toLowerCase();
  for (const ent of entries) {
    if (ent.name.toLowerCase() !== lower) continue;
    if (wantDir && !ent.isDirectory()) continue;
    return ent.name;
  }
  return null;
}

/** 盘上真实路径（Windows 走 realpath 取官方大小写；失败就用原路径）。 */
function canonical(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : p; } catch { return p; }
}

/** 递归数 .erb 文件（大小写不敏感）；遇符号链接不跟随（防环，语料盘本就无链）。 */
function countErb(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
      else if (ent.isFile() && /\.erb$/i.test(ent.name)) n++;
    }
  }
  return n;
}

function savCount(dir) {
  const savName = findEntry(dir, SAV_DIR, true);
  if (!savName) return 0;
  try { return fs.readdirSync(path.join(dir, savName)).length; } catch { return 0; }
}

function hasChecker(dir) {
  let cur = dir;
  for (const seg of CHECKER_REL) {
    const last = seg === CHECKER_REL[CHECKER_REL.length - 1];
    const found = findEntry(cur, seg, !last);
    if (!found) return false;
    cur = path.join(cur, found);
  }
  return true;
}

/**
 * 单个目录的内容体检：全过返回指纹信息，任一不符返回 null（供筛选）。
 * needSaves / needChecker 由调用方加严；explicit 调用方自行保证，不走这里。
 */
export function inspectCorpus(dir, opts = {}) {
  const { needChecker = false, needSaves = false } = opts;
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const dirs = {};
  for (const base of BASE_DIRS) {
    const found = findEntry(dir, base, true);
    if (!found) return null;
    dirs[base.toLowerCase()] = found;
  }
  const hasCheckerFile = hasChecker(dir);
  if (needChecker && !hasCheckerFile) return null;
  const saves = savCount(dir);
  if (needSaves && saves === 0) return null;
  return { dir: canonical(dir), erbCount: countErb(path.join(dir, dirs.erb)), savCount: saves, hasChecker: hasCheckerFile };
}

/** 扫 scanRoots 下的一级目录，返回按 ①sav ②ERB 数 ③名 排序的候选（指纹全带上）。 */
export function discoverCorpora(opts = {}) {
  const { needChecker = false, needSaves = false, scanRoots = scanRootsFromEnv(opts.env) } = opts;
  const hits = [];
  for (const root of scanRoots) {
    let ents;
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      const info = inspectCorpus(path.join(root, ent.name), { needChecker, needSaves });
      if (info) hits.push(info);
    }
  }
  hits.sort((a, b) => (b.savCount > 0 ? 1 : 0) - (a.savCount > 0 ? 1 : 0)
    || b.erbCount - a.erbCount
    || a.dir.localeCompare(b.dir));
  return hits;
}

const fmtCount = (n) => n.toLocaleString('en-US');

/** 候选清单一行式描述，用于报错文案（列盘上候选是硬要求：让「为什么没选中」永远看得见）。 */
export function describeCandidates(hits) {
  if (hits.length === 0) return '（盘上无符合 ERB/+CSV/ 的目录）';
  return hits.map((h) => `${h.dir}（ERB ${fmtCount(h.erbCount)} / sav ${h.savCount} 件 / erb_check.py ${h.hasChecker ? '有' : '无'}）`).join('；');
}

export const corpusHint = () => `设 ${ENV_VAR}=<语料目录> 可指定（不设则按内容自动发现：需 ERB/ 与 CSV/）；语料不在 ${DEFAULT_SCAN_ROOTS.join('/')} 下时再设 ${ENV_SCAN_DIRS}=<扫描根，${path.delimiter} 分隔>`;

/**
 * 主入口：返回语料目录绝对路径，或 null（自动发现一个都不命中）。
 * opts：
 *   explicit  调用方 --corpus 参数（最高优先；只查存在性，显式即授权）
 *   env       默认 process.env（测试可注入）
 *   needChecker / needSaves / scanRoots  见文件头
 *   print     命中多个时是否打印选择说明（默认 true）
 *   label     打印前缀里带调用方名，便于在长输出里定位
 * 抛 CorpusError：env 设了但不成立（不存在 / 内容不符）——调用方必须把它当硬失败处理。
 */
export function resolveCorpusDir(opts = {}) {
  const {
    explicit, env = process.env, needChecker = false, needSaves = false,
    scanRoots = scanRootsFromEnv(env), print = true, label = 'corpus',
  } = opts;

  if (explicit) {
    const dir = path.resolve(explicit);
    if (!fs.existsSync(dir)) {
      throw new CorpusError(`--corpus 指向的目录不存在: ${dir}\n  盘上候选: ${describeCandidates(discoverCorpora({ scanRoots }))}\n  ${corpusHint()}`);
    }
    return canonical(dir);
  }

  const envDir = (env[ENV_VAR] || '').trim();
  if (envDir) {
    const dir = path.resolve(envDir);
    // 报错时列**基础筛选**（ERB/+CSV/）的全部候选，调用方加的 needChecker/needSaves 不拿来遮蔽视野。
    if (!fs.existsSync(dir)) {
      throw new CorpusError(`${ENV_VAR} 指向的目录不存在: ${dir}\n  盘上候选: ${describeCandidates(discoverCorpora({ scanRoots }))}\n  ${corpusHint()}`);
    }
    const info = inspectCorpus(dir, { needChecker, needSaves });
    if (!info) {
      const missing = [];
      for (const base of BASE_DIRS) if (!findEntry(dir, base, true)) missing.push(`${base}/`);
      if (needChecker && !hasChecker(dir)) missing.push('tool/erb_check.py');
      if (needSaves && savCount(dir) === 0) missing.push(`${SAV_DIR}/ 非空`);
      throw new CorpusError(`${ENV_VAR} 指向的目录内容不符（缺 ${missing.join('、')}）: ${dir}\n  盘上候选: ${describeCandidates(discoverCorpora({ scanRoots }))}\n  ${corpusHint()}`);
    }
    if (print) console.log(`[${label}] 语料（${ENV_VAR} 指定）${info.dir}（ERB ${fmtCount(info.erbCount)} / sav ${info.savCount} 件 / erb_check.py ${info.hasChecker ? '有' : '无'}）`);
    return info.dir;
  }

  const hits = discoverCorpora({ needChecker, needSaves, scanRoots });
  if (hits.length === 0) return null;
  const chosen = hits[0];
  if (print) {
    const why = hits.length > 1
      ? `判据 ①sav/ 非空优先 ②.ERB 数 ③目录名；其余候选: ${hits.slice(1).map((h) => `${h.dir}（ERB ${fmtCount(h.erbCount)} / sav ${h.savCount} / erb_check.py ${h.hasChecker ? '有' : '无'}）`).join('，')}`
      : '判据 ①sav/ 非空优先 ②.ERB 数 ③目录名（盘上仅此一份符合内容条件）';
    console.log(`[${label}] 自动选定语料 ${chosen.dir}（ERB ${fmtCount(chosen.erbCount)} / sav ${chosen.savCount} 件 / erb_check.py ${chosen.hasChecker ? '有' : '无'}）— ${why}；要固定就设 ${ENV_VAR}=<语料目录>`);
  }
  return chosen.dir;
}

/* CLI（供文档与 shell 内联取值，别在文档里手写 node -e import）：
     node tools/corpus.mjs            → 打印解析过程（人看）
     node tools/corpus.mjs --print    → 只打目录名（KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)"）
   退出码：0 有解 / 1 盘上无符合内容的语料 / 2 KOJO_CORPUS_DIR 或 --corpus 指了不成立的路径。 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const quiet = process.argv.slice(2).includes('--print');
  try {
    const dir = resolveCorpusDir({ print: !quiet });
    if (!dir) { console.error(`[FAIL] 盘上未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）；${corpusHint()}`); process.exit(1); }
    if (quiet) process.stdout.write(dir);
  } catch (e) {
    console.error(`[FAIL] ${e instanceof CorpusError ? e.message : e?.stack ?? e}`);
    process.exit(2);
  }
}
