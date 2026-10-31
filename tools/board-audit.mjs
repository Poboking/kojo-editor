#!/usr/bin/env node
/**
 * board-audit — 看板（`docs/BOARD.md`）的结构与引用体检。
 *
 * 立论：**看板会漂**。2026-10-31 一天内撞到两例，形状完全不同：
 *   ① 僵尸卡：判据早已全部满足，行还挂在"待认领"（CMD-NUL-BYTE —— 裸 NUL 早就是 0 个、
 *      `ps14-source-cache` 早就绿，只是没人删行）。
 *   ② 过期判据：卡上写的那条**架构事实**被后续批次推翻（TUT-UGUIDE 判据写"默认档只认 v1"，
 *      而 10-27 的 LAU-3b-FLIP 已把 `.kojo` 让给 2.0，照旧判据写会写出反的）。
 *
 * 边界（必须说清，否则会误以为"跑绿了卡就没问题"）：
 *   ② 那种漂移**抓不住**——判据是中文，机器无法判定它是否仍成立。
 *   本工具只管**机械可验的那一半**：结构、格式、引用是否还指向存在的东西。
 *   语义那一半靠协议：**认领前先跑判据、核判据依赖的架构事实**，不符就先改卡再开工。
 *
 * 两级输出：
 *   ERROR（退出码 1）：列数不符、ID 重复/格式不符、"认领"缺主机或日期、日期非法、
 *                      `PITFALLS <n>` 指向不存在的条目、带路径的文件引用不存在
 *   WARN（只打印，不影响退出码）：状态列没有日期、日期晚于今天、裸文件名在仓里找不到
 *
 * 用法：
 *   node tools/board-audit.mjs            # 人读
 *   node tools/board-audit.mjs --json     # 机器读
 *   node tools/board-audit.mjs --strict   # WARN 也判失败（发版前用）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');
const valOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// `--board` / `--pitfalls` 是为了红验证与跨仓复用：默认就是本仓那两份
const BOARD = path.resolve(ROOT, valOf('--board', 'docs/BOARD.md'));
const PITFALLS = path.resolve(ROOT, valOf('--pitfalls', 'docs/PITFALLS.md'));

const errors = [];
const warns = [];
const err = (id, msg) => errors.push({ id, msg });
const warn = (id, msg) => warns.push({ id, msg });

// ── 读看板 ─────────────────────────────────────────────────────────────────
let boardText;
try {
  boardText = readFileSync(BOARD, 'utf8');
} catch (e) {
  console.error(`board-audit: 读不到 ${path.relative(ROOT, BOARD)}：${e.message}`);
  process.exit(2);
}
const lines = boardText.split('\n');

/** 表格数据行：`|` 开头、不是分隔行、不是表头 */
const isRow = (l) => l.startsWith('|') && !/^\|[\s:|-]+\|?\s*$/.test(l) && !l.startsWith('|ID|');
const rowIdx = lines.map((l, i) => (isRow(l) ? i : -1)).filter((i) => i >= 0);

/** @type {{id:string, cells:string[], line:number}[]} */
const cards = [];
const seen = new Map();
for (const i of rowIdx) {
  const cells = lines[i].split('|').slice(1, -1);
  const id = (cells[0] ?? '').trim();
  cards.push({ id, cells, line: i + 1 });
  if (!id) {
    err(`L${i + 1}`, 'ID 为空');
    continue;
  }
  if (seen.has(id)) err(id, `ID 重复（另一行在 L${seen.get(id)}）`);
  else seen.set(id, i + 1);

  if (cells.length !== 4) {
    err(id, `列数 ${cells.length} ≠ 4（表格应为 |ID|任务|关键判据|状态|）`);
  }
  if (!/^[A-Z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$/.test(id)) {
    err(id, 'ID 格式不符（期望 `大写开头-连字符分段`，段内可含数字/小写，如 SDK-B5b）');
  }
}

// ── 日期与认领 ─────────────────────────────────────────────────────────────
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
  now.getDate(),
).padStart(2, '0')}`;

for (const c of cards) {
  const status = (c.cells[3] ?? '').trim();
  const isIdle = /待认领|待派|未认领|已裁定/.test(status);
  const dates = [...status.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];

  // 只有"状态被改过"的行才要求日期：待认领/待派是静止态，写日期反而是噪声
  if (dates.length === 0 && !isIdle) {
    warn(c.id, '状态列没有日期：交付/改判据时无法追溯这一行是什么时候写下的');
  }
  for (const [, y, m, d] of dates) {
    const mm = +m;
    const dd = +d;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) err(c.id, `状态列日期非法：${y}-${m}-${d}`);
    else if (`${y}-${m}-${d}` > today) {
      warn(c.id, `状态列日期 ${y}-${m}-${d} 晚于今天 ${today}（手误？或写成了计划日）`);
    }
  }

  // 「认领：」是承诺，必须可追溯：<主机> <日期>。
  // 注意别把"待认领"当成认领——第一版就栽在这（`/认领/` 匹配了"待"字后面的那两个字）。
  if (/认领[：:]/.test(status)) {
    if (!/认领[：:]\s*[^\s·|]+\s+\d{4}-\d{2}-\d{2}/.test(status)) {
      err(c.id, `写了「认领：」但没有「<主机> <YYYY-MM-DD>」：${status}`);
    }
  } else if (/进行中|在办/.test(status)) {
    warn(c.id, `进行中却没有「认领：<主机> <日期>」：跨主机协作时找不到负责人（${status}）`);
  }
}

// ── 引用：PITFALLS 编号 ────────────────────────────────────────────────────
let pitNums = null;
try {
  const pit = readFileSync(PITFALLS, 'utf8');
  pitNums = new Set([...pit.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => +m[1]));
} catch {
  pitNums = null;
}
if (pitNums) {
  for (const c of cards) {
    const body = c.cells.join('|');
    for (const m of body.matchAll(/PITFALLS\s*(\d+)/g)) {
      const n = +m[1];
      if (!pitNums.has(n)) {
        err(c.id, `引用 PITFALLS ${n}，但该编号在 docs/PITFALLS.md 里不存在（编号被占/顺延后漏改引用？）`);
      }
    }
  }
}

// ── 引用：带路径的文件（`docs/x.md` / `tools/x.mjs` / `packages/x`）────────
const PREFIX_RE =
  /(?:^|[\s`(（])((?:docs|packages|tools|scripts)\/[A-Za-z0-9_./@-]+\.(?:md|ts|tsx|mjs|cjs|js|json|css|toml|rs|yml|yaml))/g;
for (const c of cards) {
  const body = c.cells.join('|');
  for (const m of body.matchAll(PREFIX_RE)) {
    const p = m[1];
    try {
      statSync(path.join(ROOT, p));
    } catch {
      err(c.id, `引用 ${p}，但仓里没有这个文件（改名/删除后卡没跟上）`);
    }
  }
}

// ── 引用：反引号里的**裸文件名**（无路径前缀，如 `smoke-tauri-market.mjs`）──
/** 全仓 basename 索引：只建一次，用于回答"这个文件名还存在于某处吗" */
const byBasename = new Map();
function index(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'target') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) index(abs);
    else if (e.isFile() && !byBasename.has(e.name)) byBasename.set(e.name, abs);
  }
}
index(ROOT);

const BARE_RE = /`([A-Za-z0-9_.@-]+\.(?:mjs|cjs|ts|tsx|js|md|css|json|rs|toml))`/g;
for (const c of cards) {
  const body = c.cells.join('|');
  for (const m of body.matchAll(BARE_RE)) {
    const name = m[1];
    if (!byBasename.has(name)) {
      warn(c.id, `引用 \`${name}\`，全仓找不到同名文件（可能已改名/删除）`);
    }
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────────
const ok = errors.length === 0 && (!STRICT || warns.length === 0);

if (AS_JSON) {
  console.log(
    JSON.stringify({ cards: cards.length, today, ok, errors, warns }, null, 2),
  );
} else {
  console.log(
    `board-audit: ${cards.length} 张卡 · ${errors.length} error · ${warns.length} warn` +
      `${ok ? ' ⇒ 结构干净' : ' ⇒ 有问题'}`,
  );
  for (const e of errors) console.log(`  ERROR ${e.id}  ${e.msg}`);
  for (const w of warns) console.log(`  WARN  ${w.id}  ${w.msg}`);
  if (errors.length === 0 && warns.length === 0) {
    console.log('\n边界提醒：本工具只验结构与引用。**判据本身是否仍成立**抓不住 ——');
    console.log('语义漂移（判据被后续架构推翻、或判据早已满足的僵尸卡）要靠认领前手动核。');
  }
}

process.exit(ok ? 0 : 1);
