// 离线验收工具的「转译产物落点」+「语料盘写入门禁」——两个 node 工具共用（clidbg-run.cjs / engine-loadtest.mjs）。
//
// 为什么要有这个模块（ALS-R3，2026-10-14）：
//   这两个工具直接用 fs 写盘，**绕开了内核 io 的写允许域**，而旧落点是「输入文件旁边」：
//   ① 输入是仓库夹具 → 产物写进仓库（tests/goldens/ 里凭空多出 `.kojo.generated.ERB`，
//      既污染 golden 抽样（当时的语料转译闸被迫去排除自家工具产物），
//      又破「工作树干净」这一并发前提（禁 add -A 的纪律正好卡在误吞路径上）；
//   ② 输入是**语料目录里的 .kojo** → 产物写进游戏盘，直接违反架构铁律 5（游戏目录整体只读；
//      本机已发生过引擎经硬链接镜像就地改写真实语料的事故，见 docs/PITFALLS.md 56，不可还原）。
//   ⇒ 落点搬到仓库外的固定沙盒（C:/tmp 下，与既有探针目录同族，跨主机可复现，不用 os.tmpdir 的随机路径），
//     并在**任何一次写盘之前**加一道位置判定：目标落在语料/游戏根之下 = 直接报错退出（**绝不静默改路径**）。
//
// 纪律：本模块**全是纯函数**——只算路径、只做字符串判定，不建目录、不扫盘、不读语料、
//   不碰引擎，因此可脱离真语料/真引擎单测（tools/tests/generated-output.test.ts）。
// 路径语义：Windows（这两个工具只在 Windows 上驱真引擎，落点写死 C:/tmp），故一律按 win32 规则归一，
//   比较默认大小写不敏感——单测在任意 host 平台跑结果都一致。
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

/** 落点覆盖开关（与 KOJO_CLIDBG_DIR 一族同风格；QA 机想换盘就用这个）。 */
const ENV_OUT_DIR = 'KOJO_GENERATED_DIR';
/** 默认落点：仓库外的固定沙盒目录（不是 os.tmpdir()，避免每次换路径没法复现）。 */
const DEFAULT_OUT_ROOT = 'C:/tmp/kojo-generated-erb';
const ERB_SUFFIX = '.generated.ERB';
const MAP_SUFFIX = '.generated.map.json';

/** 门禁拒绝 / 派生入参不合法时抛这个（调用方一律硬失败退出，绝不退化成"换个路径继续跑"）。 */
class GeneratedOutputError extends Error {}

/** win32 归一：反斜杠→正斜杠、折叠 `.`/`..`、去尾斜杠（保留盘符根）。 */
function normPath(p) {
  const n = path.win32.normalize(String(p)).replace(/[\\/]+/g, '/');
  const stripped = n.replace(/\/+$/, '');
  return stripped || n;
}

/** 大小写不敏感（Windows）时做小写折叠；由 opts.caseInsensitive 决定，默认跟随 process.platform。 */
function fold(p, ci) {
  return ci ? p.toLowerCase() : p;
}

/** target 是否落在 root 之内（含「就是 root 本身」）；按目录段比较，不做前缀字符串猜。 */
function isWithin(target, root, opts = {}) {
  const ci = opts.caseInsensitive ?? process.platform === 'win32';
  const t = fold(normPath(target), ci);
  const r = fold(normPath(root), ci);
  if (t === r) return true;
  return t.startsWith(r.endsWith('/') ? r : r + '/');
}

/** 落点根目录（env 覆盖优先）；绝对化，便于后续门禁比较。 */
function resolveOutRoot(env = process.env) {
  const raw = (env[ENV_OUT_DIR] || '').trim();
  return path.win32.resolve(raw || DEFAULT_OUT_ROOT);
}

/**
 * 由输入文件路径派生一对产物路径（纯函数，不建目录）。
 * 派生规则（可预期 + 不撞名）：`<落点根>/<输入基名去扩展>.<输入绝对路径 sha256 前 10 位>.generated.ERB`
 *  ——同名夹具放在不同目录也各得其所（key 来自解析后的绝对路径），后跑的不覆盖先跑的。
 * 产物**成对同目录同基名**：scene-run.cjs:128 的回映按「产物同名兄弟」找 map
 *  （`x.generated.ERB` → `x.generated.map.json`），拆开就断了。
 * @param {string} input 夹具/语料里的 .kojo 或 .erb 路径
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{root:string, input:string, key:string, erbPath:string, mapPath:string}}
 */
function deriveGeneratedPaths(input, opts = {}) {
  if (!input) throw new GeneratedOutputError('deriveGeneratedPaths 需要输入路径（得到空值）');
  const absInput = path.win32.resolve(String(input));
  const base = path.win32.basename(absInput);
  const stem = base.replace(/\.[^.]*$/, '') || base;
  const key = crypto.createHash('sha256').update(absInput.toLowerCase()).digest('hex').slice(0, 10);
  const root = path.win32.resolve(opts.root || resolveOutRoot(opts.env || process.env));
  return {
    root,
    input: absInput,
    key,
    erbPath: path.win32.join(root, `${stem}.${key}${ERB_SUFFIX}`),
    mapPath: path.win32.join(root, `${stem}.${key}${MAP_SUFFIX}`),
  };
}

/**
 * 写盘前门禁：目标（一个或一串）只要落在任一受保护根（语料/游戏目录）之下就抛错。
 * **只拒绝，不改路径**——静默换个落点等于把「写进语料盘」这件事藏起来。
 * @param {string|string[]} targets
 * @param {string[]} protectedRoots 受保护根清单（调用方负责发现，见 tools/corpus.mjs）
 * @param {{caseInsensitive?:boolean, label?:string}} [opts]
 */
function assertOutsideRoots(targets, protectedRoots, opts = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const roots = (protectedRoots || []).filter(Boolean);
  const hits = [];
  for (const t of list) {
    for (const r of roots) {
      if (isWithin(t, r, opts)) hits.push(`${t} ⊂ ${r}`);
    }
  }
  if (hits.length) {
    throw new GeneratedOutputError(
      `${opts.label || '产物落点'}拒绝写盘：目标位于语料/游戏根之下（架构铁律 5：游戏目录整体只读，`
      + `本工具用 fs 直写、不经内核 io 写允许域）→ ${hits.join(' ; ')}。`
      + `\n  处置：把落点挪出游戏盘（去掉 ${ENV_OUT_DIR} 覆盖，或用 ${ENV_OUT_DIR}=<仓库外目录>），**不做静默改写**。`,
    );
  }
  return list;
}

/** 建落点目录由调用方在门禁通过后做（两个工具都是在内联 vitest 里 mkdirSync，
 *  本模块自身不写盘——保持纯函数才可脱离引擎/语料单测）。 */

module.exports = {
  ENV_OUT_DIR,
  DEFAULT_OUT_ROOT,
  ERB_SUFFIX,
  MAP_SUFFIX,
  GeneratedOutputError,
  normPath,
  isWithin,
  resolveOutRoot,
  deriveGeneratedPaths,
  assertOutsideRoots,
};
