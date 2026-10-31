/**
 * 市场真壳冒烟（`tools/smoke-tauri-market.mjs`）的**判据叶子**：纯函数、零 IO、零 CDP。
 *
 * 为什么单独成文件：f2/g/h 的索引形状闸与 k 的滞后判据原来直接写死在"一起壳就跑"的脚本里，
 * 判据既没法单测，也就没法证明"改的是判据口径、不是把功能断言写松"。抽到这里以后
 * `tools/tests/market-smoke-rules.test.ts` 能直接打三条路：
 *   ① `parseIndexBytes` —— schema 合规（**不钉外部内容的字节数 / sha256 / 包条数**）；
 *   ② `resolveInstallTarget` —— 装包目标从**这一次取回的注册表**现场解析；
 *   ③ `rowLagToleranceMs` / `uninstallTailProblems` —— 采样粒度换算成容差（恒 > 2× 采样周期）。
 *
 * 口径来源（只读、不 import TS 源，脚本要能脱离构建单跑）：
 * `packages/plugin-api/src/market.ts` 的 `MarketIndex` / `MarketIndexEntry` /
 * `MARKET_SCHEMA_VERSION` / `MARKET_PACK_KINDS` / `MARKET_MAX_INDEX_BYTES`。
 *
 * 一条纪律（看板 MK-SMOKE-RECAL 的根因）：**锚点只钉本仓可控的东西**。
 * 端点字面、schema 版本、包种类、体积上限是本仓说了算的；注册表里有哪些包、共多少字节、
 * 摘要多少是**外部内容**，社区一投稿就变——钉住它们等于把"注册表长大了"判成"本仓回归"。
 */

/** 索引 schema 版本（契约 `MARKET_SCHEMA_VERSION` 同值） */
export const INDEX_SCHEMA_VERSION = 1;

/** 包种类（契约 `MARKET_PACK_KINDS` 同值：跨游戏通用的三档） */
export const MARKET_PACK_KINDS = Object.freeze(['kojo-pack', 'dict-pack', 'template-pack']);

/** 索引体积上限（契约 `MARKET_MAX_INDEX_BYTES` = 512 KiB） */
export const INDEX_MAX_BYTES = 512 * 1024;

/**
 * 屏上行消失相对「卸载结果句上屏」的容差**地板**（毫秒）。
 *
 * 900ms = 3 × 300ms：k 项的一轮采样 ≈ 一次 CDP 往返（~200ms）+ 间隔，实测周期就在 300ms 量级，
 * 而旧判据拿 300ms 当容差 ⇒ 正好踩在一个采样周期上，测出来的是"这一轮谁先被采到"而不是产品滞后
 * （实测 469ms / 2,013ms 两跑皆红，盘上/记账/屏幕全对）。地板取 3 倍周期，配合
 * `rowLagToleranceMs(实测周期)` 的 `max(地板, 3×周期)` ⇒ **恒 > 2× 采样周期**。
 *
 * ⚠ 这是**探针噪声地板**，不是产品承诺：真断裂的形态（行不消失 / 结果句不上屏 /
 * 屏上先于盘上消失）照旧判红，见 `uninstallTailProblems`。
 */
export const ROW_LAG_FLOOR_MS = 900;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_TRIPLE = /^\d+\.\d+\.\d+$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const intAtLeast = (v, min) => Number.isInteger(v) && v >= min;
const show = (v) => JSON.stringify(v ?? null);

/** https 直链判据（封面与容器同一条：契约里市场只许 https） */
export function httpsUrlProblem(url) {
  if (!nonEmptyString(url)) return '不是非空字符串';
  let u;
  try {
    u = new URL(url);
  } catch {
    return '不是合法 URL';
  }
  return u.protocol === 'https:' ? null : `协议是 ${u.protocol}，只许 https:`;
}

/** 放行主机形态（Rust 侧 `host_in_allowlist` 的 GitHub 系；这里只作终止 URL 的形态闸） */
export function hostAllowlisted(host) {
  if (typeof host !== 'string') return false;
  return /(^|\.)github\.io$/i.test(host) || /(^|\.)github\.com$/i.test(host);
}

/** 一条索引条目的形状问题（空数组 = 合规）；`where` 只用于报错定位 */
export function entryShapeProblems(entry, where) {
  const problems = [];
  if (!isObject(entry)) return [`${where} 不是对象：${show(entry)}`];
  if (!MARKET_PACK_KINDS.includes(entry.kind)) {
    problems.push(`${where} kind=${show(entry.kind)} 不在 ${MARKET_PACK_KINDS.join('/')} 之内`);
  }
  if (!nonEmptyString(entry.id)) problems.push(`${where} id 不是非空字符串：${show(entry.id)}`);
  if (typeof entry.version !== 'string' || !VERSION_TRIPLE.test(entry.version)) {
    problems.push(`${where} version=${show(entry.version)} 不是 x.y.z`);
  }
  for (const key of ['name', 'author', 'license', 'minAppVersion']) {
    if (!nonEmptyString(entry[key])) problems.push(`${where} ${key} 不是非空字符串：${show(entry[key])}`);
  }
  if (!intAtLeast(entry.fileCount, 1)) problems.push(`${where} fileCount=${show(entry.fileCount)} 不是 ≥1 的整数`);
  if (!intAtLeast(entry.unpackedBytes, 0)) problems.push(`${where} unpackedBytes=${show(entry.unpackedBytes)} 不是 ≥0 的整数`);
  if (!isObject(entry.zip)) problems.push(`${where} zip 不是对象：${show(entry.zip)}`);
  else {
    const zipProblem = httpsUrlProblem(entry.zip.url);
    if (zipProblem !== null) problems.push(`${where} zip.url ${zipProblem}：${show(entry.zip.url)}`);
    if (typeof entry.zip.sha256 !== 'string' || !SHA256_HEX.test(entry.zip.sha256)) {
      problems.push(`${where} zip.sha256 不是 64 位小写十六进制：${show(entry.zip.sha256)}`);
    }
    if (!intAtLeast(entry.zip.bytes, 1)) problems.push(`${where} zip.bytes=${show(entry.zip.bytes)} 不是 ≥1 的整数`);
  }
  if (entry.cover !== undefined) {
    if (!isObject(entry.cover)) problems.push(`${where} cover 不是对象：${show(entry.cover)}`);
    else {
      const coverProblem = httpsUrlProblem(entry.cover.url);
      if (coverProblem !== null) problems.push(`${where} cover.url ${coverProblem}：${show(entry.cover.url)}`);
      if (!intAtLeast(entry.cover.bytes, 1)) problems.push(`${where} cover.bytes=${show(entry.cover.bytes)} 不是 ≥1 的整数`);
    }
  }
  return problems;
}

/** 一条合法条目 → 判据要用的那一份（索引里没有逐文件明细，只有摘要） */
export function rowOfEntry(entry) {
  return {
    kind: entry?.kind,
    id: entry?.id,
    version: entry?.version,
    fileCount: entry?.fileCount,
    unpackedBytes: entry?.unpackedBytes,
    zipSha256: isObject(entry?.zip) ? entry.zip.sha256 : undefined,
    zipBytes: isObject(entry?.zip) ? entry.zip.bytes : undefined,
  };
}

/**
 * 索引字节 → `{ problems, bytes, json, packs }`。
 *
 * `problems` 空 = schema 合规（仍**不**断言包数 / 字节数 / 摘要——那是外部内容）；
 * `packs` 是逐条归一后的行（`rowOfEntry`），便于"远程 ⇔ 盘上"逐条对平。
 */
export function parseIndexBytes(buf, opts = {}) {
  const maxBytes = Number.isInteger(opts.maxBytes) ? opts.maxBytes : INDEX_MAX_BYTES;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  const problems = [];
  const out = { problems, bytes, json: null, packs: [] };
  if (bytes.length === 0) {
    problems.push('索引是空字节');
    return out;
  }
  if (bytes.length > maxBytes) problems.push(`索引体积 ${bytes.length} B 超过上限 ${maxBytes} B`);
  let json;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    problems.push('不是合法 JSON');
    return out;
  }
  out.json = json;
  if (!isObject(json)) {
    problems.push(`顶层不是对象：${show(json).slice(0, 80)}`);
    return out;
  }
  if (json.schema !== INDEX_SCHEMA_VERSION) {
    problems.push(`schema=${show(json.schema)}，期望 ${INDEX_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(json.generatedAt)) problems.push(`generatedAt 不是非空字符串：${show(json.generatedAt)}`);
  else if (!Number.isFinite(Date.parse(json.generatedAt))) {
    problems.push(`generatedAt 不是可解析的时间串：${show(json.generatedAt)}`);
  }
  if (!Array.isArray(json.packs)) {
    problems.push(`packs 不是数组：${show(json.packs).slice(0, 80)}`);
    return out;
  }
  const seen = new Map();
  json.packs.forEach((entry, i) => {
    const where = `packs[${i}]${isObject(entry) ? `（${entry.id ?? '?'} ${entry.version ?? '?'}）` : ''}`;
    problems.push(...entryShapeProblems(entry, where));
    out.packs.push(rowOfEntry(entry));
    if (!isObject(entry)) return;
    const key = `${entry.kind}/${entry.id}@${entry.version}`;
    if (seen.has(key)) problems.push(`${where} 与 packs[${seen.get(key)}] 是同一个 ${key}（同一条只能出现一次）`);
    else seen.set(key, i);
  });
  return out;
}

/** 逐条对平用的稳定序（种类 / id / 版本 / 文件数 / 解压字节五项全比；顺序不参与判定） */
export function sortRows(rows) {
  return [...(rows ?? [])]
    .map((r) => [r?.kind, r?.id, r?.version, r?.fileCount, r?.unpackedBytes])
    .sort((a, b) => String(a).localeCompare(String(b)));
}

/**
 * 从**这一次取回的注册表**里挑装包目标。
 *
 * 优先 `preferred` 那条（本仓夹具包，正常都还在）；它不在了就退回同种类里最小的那条——
 * 社区包能长到几十 MB，真壳冒烟不该为了"证明能装"去下载一个大包。一条可装的都没有 ⇒ `null`，
 * 调用方报 SKIP（**没有目标 ≠ 测过**）。
 */
export function resolveInstallTarget(packs, preferred) {
  if (!Array.isArray(packs) || packs.length === 0) return null;
  const exact = packs.find((p) => p?.kind === preferred.kind && p?.id === preferred.id && p?.version === preferred.version);
  if (exact !== undefined) {
    return { entry: exact, why: `注册表里仍有 ${preferred.id} v${preferred.version}` };
  }
  const same = packs.filter((p) => p?.kind === preferred.kind);
  const pool = same.length > 0 ? same : packs;
  const smallest = [...pool].sort((a, b) => (a.unpackedBytes ?? Infinity) - (b.unpackedBytes ?? Infinity))[0];
  if (smallest === undefined) return null;
  return {
    entry: smallest,
    why: `注册表里已没有 ${preferred.id} v${preferred.version}，改用同种类最小的 ${smallest.id} v${smallest.version}`,
  };
}

/**
 * 容差 = max(地板, 3 × 实测采样周期)：**恒 > 2× 采样周期**。
 * `samplingMs` 用这一轮实测的轮周期（不是常量），采样变慢时容差跟着变粗，判据不会退化到噪声面。
 */
export function rowLagToleranceMs(samplingMs) {
  const s = Number.isFinite(samplingMs) && samplingMs > 0 ? Math.ceil(samplingMs) : 0;
  return Math.max(ROW_LAG_FLOOR_MS, 3 * s);
}

/**
 * 卸载尾巴的判据（③ 屏上行消失 vs ④ 卸载结果句上屏 vs ② 落点目录消失）。
 *
 * 主判据是**同拍**：行撤掉与"已卸掉…"上屏是同一次 React 提交 ⇒ 两者的差值只受采样粒度影响，
 * 与"卸载本身要花多久"（记账写盘 / 祖先目录 / 暂存清扫）无关。旧判据拿 ③ 去比 ②，
 * 比的其实是整段卸载尾巴，再用一个等于采样周期的 300ms 去卡，于是每跑都红。
 *
 * 方向也判：屏上那条**不许比盘上先消失**（那是"屏上先于盘上"的假象）。② vs ③ 的差值只上读数。
 */
export function uninstallTailProblems(o) {
  const problems = [];
  const tol = rowLagToleranceMs(o?.samplingMs);
  const rowGoneMs = Number.isFinite(o?.rowGoneMs) ? o.rowGoneMs : null;
  const doneMs = Number.isFinite(o?.doneMs) ? o.doneMs : null;
  const dirGoneMs = Number.isFinite(o?.dirGoneMs) ? o.dirGoneMs : null;
  if (o?.failNote) problems.push(`卸载没有成功（${o.failNote}）`);
  if (rowGoneMs === null) {
    problems.push('卸载确认后 30s 屏上那条仍在（行没消失 = 功能面没走完）');
    return problems;
  }
  if (doneMs === null) problems.push('卸载结果句 30s 内没有上屏（屏上没给出结论）');
  else if (rowGoneMs > doneMs + tol) {
    problems.push(
      `屏上那条比「已卸掉…」结果句晚 ${rowGoneMs - doneMs}ms 才撤掉（判据 ≤ 结果句 + ${tol}ms；容差 > 2× 采样周期）`,
    );
  }
  if (dirGoneMs !== null && rowGoneMs + tol < dirGoneMs) {
    problems.push('屏上那条比落点目录先消失（屏上先于盘上，是假象）');
  }
  return problems;
}
