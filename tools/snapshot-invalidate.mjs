#!/usr/bin/env node
/**
 * 索引快照的**受控作废**复现器（PERF-12a 判据①的真壳一侧）。
 *
 * 只动本插件自己的存储域（`{appData}/store/erb-parser/index-v*-*.json`）：
 * 把盘上那份快照改成四条作废触发面之一，再交给 `tools/boot-watermarks.mjs` 量「作废后首开」。
 * **不碰语料盘**（语料整体只读），不改任何等待上限，也不给快照判据开后门。
 *
 * 用法（`--root` 必须显式给：项目根不落进仓库任何文件；版本号从源码 `SNAPSHOT_VERSION` 自解析）：
 *   node tools/snapshot-invalidate.mjs status                 --root "D:/path/to/语料"
 *   node tools/snapshot-invalidate.mjs to-legacy              --root ...   # 换代：当前版 → 落后代形态 + 落后代键
 *   node tools/snapshot-invalidate.mjs damage <N>             --root ...   # 单条目损坏：前 N 条改坏（元数不符）
 *   node tools/snapshot-invalidate.mjs retarget                --root ...   # rootDir 写法不符（反斜杠形态）
 *   node tools/snapshot-invalidate.mjs drop                    --root ...   # 真·冷（当前键那份删掉）
 * 每个模式都会先打印改前的读数，改后再打印一次盘上清单（可复跑、可核对）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const MODE = argv[0];
const rootIdx = argv.indexOf('--root');
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : null;
const EXTRA = Number(argv[1]);

const SCOPE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'dev.kojo.editor', 'store', 'erb-parser');

/**
 * 当前快照版本**从源码读**（W8-D 批：工具原先硬编码 v7/v6，SNAPSHOT_VERSION 已换代到 10，
 * 旧键号全部打空）。解析 `snapshot.ts` 的 `export const SNAPSHOT_VERSION = <n>;`，
 * 落后代 = `CUR - 1`（与 `snapshot-salvage.test.ts` 的 legacy 键同口径）。
 */
const SNAPSHOT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'plugins', 'erb-parser', 'src', 'snapshot.ts');
const CUR = Number(fs.readFileSync(SNAPSHOT_SRC, 'utf-8').match(/export const SNAPSHOT_VERSION = (\d+)/)?.[1]);
if (!Number.isInteger(CUR) || CUR < 1) {
  console.error(`[inv] 无法从 ${SNAPSHOT_SRC} 解析 SNAPSHOT_VERSION`);
  process.exit(2);
}
const PREV = CUR - 1;

/** 与 `snapshot.ts:snapshotKeyFor` 同一条 FNV-1a（32 位 → 8 位十六进制） */
function keyFor(rootDir, version) {
  let h = 0x811c9dc5;
  for (let i = 0; i < rootDir.length; i++) {
    h ^= rootDir.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `index-v${version}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function listStore() {
  if (!fs.existsSync(SCOPE_DIR)) return [];
  return fs
    .readdirSync(SCOPE_DIR)
    .filter((n) => /^index-v\d+-[0-9a-f]{8}\.json$/.test(n))
    .map((n) => {
      const file = path.join(SCOPE_DIR, n);
      const st = fs.statSync(file);
      let version = -1;
      let entries = -1;
      let rootDir = '';
      let arity = -1;
      try {
        const p = JSON.parse(fs.readFileSync(file, 'utf-8'));
        version = p.version;
        rootDir = p.rootDir;
        entries = Object.keys(p.entries ?? {}).length;
        const first = Object.values(p.entries ?? [])[0];
        arity = Array.isArray(first) ? first.length : -1;
      } catch {
        /* 读不出就当 -1，只报体积 */
      }
      return { n, key: n.slice(0, -'.json'.length), bytes: st.size, version, entries, arity, rootDir };
    });
}

function report(tag) {
  const rows = listStore();
  console.log(`[inv] ${tag}：${SCOPE_DIR}`);
  if (rows.length === 0) console.log('  (盘上没有索引快照文件)');
  for (const r of rows) {
    console.log(`  ${r.key}  ${(r.bytes / 1048576).toFixed(2)} MiB  version=${r.version} entries=${r.entries} 元组 arity=${r.arity} rootDir=${r.rootDir}`);
  }
  return rows;
}

if (!MODE || MODE === 'status') {
  report('status');
  if (ROOT) console.log(`  当前键（v${CUR}）= ${keyFor(ROOT, CUR)} ／ 旧键（v${PREV}）= ${keyFor(ROOT, PREV)}`);
  process.exit(0);
}
if (!ROOT) {
  console.error('[inv] 这个模式要 --root "<项目根>"');
  process.exit(2);
}

const v7key = keyFor(ROOT, CUR);
const file7 = path.join(SCOPE_DIR, `${v7key}.json`);
report('改前');
if (!fs.existsSync(file7)) {
  console.error(`[inv] 当前键那份快照不在：${v7key}（先跑一次开项目把它落盘）`);
  process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(file7, 'utf-8'));
const entries = payload.entries ?? {};
const paths = Object.keys(entries);

if (MODE === 'to-legacy') {
  // 落后代形态（v10 → v9 口径）：键换成 PREV、信封 version 同步。
  // 条目内容对"未命中"不敏感——`salvageSnapshot` 在信封版本闸（SALVAGEABLE_VERSIONS）
  // 就整份拒绝 v9，根本读不到 entries；此处仍把函数元组第 7 位（nameColumn，v9 起才有）剥掉，
  // 只为让盘上形态与真 v9 语义尽量同形（dims 的值语义差异无法合成，注释为证）。
  const out = {};
  for (const [p, t] of Object.entries(entries)) {
    out[p] = Array.isArray(t) && Array.isArray(t[5]) ? [...t.slice(0, 5), t[5].map((f) => (Array.isArray(f) && f.length > 6 ? f.slice(0, 6) : f)), ...t.slice(6)] : t;
  }
  const legacyKey = keyFor(ROOT, PREV);
  fs.writeFileSync(path.join(SCOPE_DIR, `${legacyKey}.json`), JSON.stringify({ ...payload, version: PREV, entries: out }));
  fs.rmSync(file7);
  console.log(`[inv] to-legacy：${paths.length} 条降到 v${PREV} 形态并搬进 ${legacyKey}（当前键已删）`);
} else if (MODE === 'damage') {
  if (!Number.isInteger(EXTRA) || EXTRA <= 0) {
    console.error('[inv] damage 要给正整数 N');
    process.exit(2);
  }
  const n = Math.min(EXTRA, paths.length);
  for (const p of paths.slice(0, n)) entries[p] = entries[p].slice(0, 4); // 元数不符 = 读不懂这一条
  fs.writeFileSync(file7, JSON.stringify({ ...payload, entries }));
  console.log(`[inv] damage：改坏 ${n}/${paths.length} 条（其余原样，期望只重读这 ${n} 棵）`);
} else if (MODE === 'retarget') {
  // 同一个根的**另一种写法**：rootDir 与条目键一起换斜杠方向 ⇒ 键换、rootDir 换、数据一字未动。
  // 真壳的 rootDir 常是反斜杠形态，所以变体必须"往反方向换"，否则换完全等于是同一个键。
  const altSep = ROOT.includes('\\') ? '/' : '\\';
  const backRoot = ROOT.replace(/[\\/]/g, altSep);
  if (keyFor(backRoot, CUR) === v7key) {
    console.error('[inv] retarget：换完写法与当前键相同（无变体可造），什么都不改');
    process.exit(2);
  }
  const out = {};
  for (const p of paths) out[p.replace(/[\\/]/g, altSep)] = entries[p];
  const backKey = keyFor(backRoot, CUR);
  fs.writeFileSync(path.join(SCOPE_DIR, `${backKey}.json`), JSON.stringify({ ...payload, rootDir: backRoot, entries: out }));
  fs.rmSync(file7);
  console.log(`[inv] retarget：写入 ${backKey}（rootDir=${backRoot}），当前键已删`);
} else if (MODE === 'drop') {
  fs.rmSync(file7);
  console.log('[inv] drop：当前键那份已删（真·冷基线）');
} else {
  console.error(`[inv] 不认识的模式：${MODE}`);
  process.exit(2);
}
report('改后');
