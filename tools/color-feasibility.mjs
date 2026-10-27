#!/usr/bin/env node
/**
 * tools/color-feasibility.mjs — LAU-2「18 档 role.* 角色色」可行性探针（离线，不改产品码）。
 *
 * 回答一个问题：设计稿 `docs/ARCH-language-unification.md` §4.2 的 18 个语义角色，
 * 在 6 套主题（kojo-dark/light/mint-dark + kojo2-dark/light/mint-dark）的底色上，
 * 是否存在「两两 CIE76 ΔE ≥ 12 且各自对底色 WCAG 对比度 ≥ 4.5」的 18 色解。
 *
 * 度量口径**逐字复用** `packages/app/tests/kojo2-theme.test.ts` :71-113
 * （channelLuminance / relativeLuminance / contrast / toLab / deltaE，CIE76 + WCAG），
 * 阈值同闸：ΔE ≥ 12、对比度 ≥ 4.5。不另发明度量。
 *
 * 输入：
 *  - 6 套底色：全部从 `packages/app/src/monaco/theme.ts` 源码现场正则读出
 *    （KOJO_DARK/LIGHT/MINT_COLORS 的 `editor.background`）；`kojo2-*` 三套在 SDK B4 之后
 *    只声明**侧名**（`componentPalette`），底色即宿主同侧那一枚——两套读数同源，不抄死值。
 *    角色规则（档数与前景色）借 esbuild 现场打包 `packages/kojo-lang/src/monaco-theme.ts`
 *    从 `KOJO2_THEMES` 模块真值读出。
 *  - 候选色空间：sRGB 均匀网格，缺省步长 8（0,8,...,248,255 ⇒ 33 级/通道，35937 色；
 *    网格相邻点在 Lab 中相距 ~3-4，远小于阈值 12，离散化说明见输出尾注）。
 *  - 档数 N：缺省 18。
 *
 * 求解（确定性、可复现，全程无随机数）：
 *  1) 贪心打包（5 种确定性排序）：按序收「与已选全部 ΔE ≥ 阈值」的色；
 *  2) 最远点采样（8 个确定性种子：最大对比度点 / L、a、b 各轴极值点 / 彩度极值点）；
 *  3) 回溯 DFS（固定序 + 节点预算上限）：贪心/最远点拿不到目标档数时补搜。
 *  「可解」= 给出**显式见证色组**（对离散网格是充分证明）；「不可解」= 三法+DFS 在
 *  网格与预算内未找到（弱结论，输出如实标注 dfsExhausted）。
 *
 * 输出五项读数：
 *  ① N 档在 6 套主题下各自可解/不可解（底色相同者同解；6 套其实只有 3 个不同底色）；
 *  ② 每个底色的最大可解档数（下界 + 见证）；
 *  ③ 全局上限 = 各底色取最严格者；
 *  ④ 可解 ⇒ 见证色组；不可解 ⇒ 反算「ΔE 降到多少 / 对比度闸降到多少能让 N 档可解」；
 *  ⑤ 现状参照系：kojo2 三套主题 token 色去重后唯一色数、最小两两 ΔE、最小对比度余量。
 *
 * 用法：node tools/color-feasibility.mjs [--n 18] [--de 12] [--contrast 4.5] [--step 8]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ------------------------------ CLI 参数 ------------------------------ */

function arg(name, dflt) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return Number(process.argv[i + 1]);
  return dflt;
}

const N = arg('n', 18);
const DE = arg('de', 12);
const CONTRAST = arg('contrast', 4.5);
const STEP = arg('step', 8);

/* ============ 色彩度量（逐字复用 kojo2-theme.test.ts :71-113） ============ */

function channelLuminance(value) {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 对比度（前景 / 背景；两色不分前后） */
function contrast(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** sRGB → CIE Lab（D65） */
function toLab(hex) {
  const linear = [0, 2, 4].map((offset) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  const [r, g, b] = linear;
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 色差 */
function deltaE(a, b) {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/* ================ 底色读取（从源码现场读，不抄死值） ================ */

const strip = (h) => h.replace(/^#/, '').toLowerCase();
const toHex6 = (r, g, b) => [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function readV1Backgrounds() {
  const src = readFileSync(path.join(ROOT, 'packages/app/src/monaco/theme.ts'), 'utf8');
  const out = {};
  for (const [pref, constName] of [
    ['dark', 'KOJO_DARK_COLORS'],
    ['light', 'KOJO_LIGHT_COLORS'],
    ['mint-dark', 'KOJO_MINT_COLORS'],
  ]) {
    const i = src.indexOf(`const ${constName}`);
    if (i < 0) throw new Error(`theme.ts 里找不到 ${constName}`);
    const m = /'editor\.background':\s*'#([0-9a-fA-F]{6})'/.exec(src.slice(i, i + 4000));
    if (!m) throw new Error(`${constName} 里找不到 editor.background`);
    out[pref] = m[1].toLowerCase();
  }
  return out;
}

async function loadKojo2Module() {
  // 借 node_modules/.pnpm 里的 esbuild 现场打包语言面库的 `monaco-theme.ts`（SDK B4 起
  // 三套 `kojo2-*` 的身份与角色规则住在那里）：其静态依赖只有同包的两枚零 import 叶子
  // （theme-rules / semantic-roles，type-only import 运行时被抹掉），node 可直跑。
  // ⚠ 这里读不到 `colors`——部件色属编辑器 chrome，B4 起由宿主落点按侧名补
  //   （底色见下面 `SIDE_TO_V1_BG`，与 v1 同族同一批 values）。
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
  const dirs = readdirSync(pnpmDir).filter((d) => /^esbuild@/.test(d)).sort();
  let esbuild = null;
  for (const d of dirs) {
    const pkgDir = path.join(pnpmDir, d, 'node_modules', 'esbuild');
    if (!existsSync(pkgDir)) continue;
    try {
      esbuild = createRequire(path.join(ROOT, 'tools', 'noop.js'))(pkgDir);
      break;
    } catch {
      /* 换下一个候选目录 */
    }
  }
  if (!esbuild) throw new Error('node_modules/.pnpm 里找不到可加载的 esbuild');
  const res = esbuild.buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(
        path.join(ROOT, 'packages/kojo-lang/src/monaco-theme.ts'),
      )};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'lau-probe-entry.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false,
  });
  const code = res.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/* ================ 候选色网格（每底色建一次，缓存） ================ */

function gridLevels(step) {
  const lv = [];
  for (let v = 0; v < 255; v += step) lv.push(v);
  lv.push(255);
  return lv;
}

function buildCandidates(bgHex, step) {
  const lv = gridLevels(step);
  const hex = [];
  for (const r of lv) for (const g of lv) for (const b of lv) hex.push(toHex6(r, g, b));
  const labFlat = new Float64Array(hex.length * 3);
  for (let i = 0; i < hex.length; i += 1) {
    const l = toLab(hex[i]);
    labFlat[i * 3] = l[0];
    labFlat[i * 3 + 1] = l[1];
    labFlat[i * 3 + 2] = l[2];
  }
  const contrasts = hex.map((h) => contrast(h, bgHex));
  return { bg: bgHex, hex, contrasts, labFlat, n: hex.length };
}

function deFlat(c, i, j) {
  const a = c.labFlat;
  return Math.hypot(a[i * 3] - a[j * 3], a[i * 3 + 1] - a[j * 3 + 1], a[i * 3 + 2] - a[j * 3 + 2]);
}

/* ============ 求解器（确定性：固定序贪心 + 最远点 + 预算回溯） ============ */

const DFS_NODE_BUDGET = 8_000_000; // 预算口径=DFS 内层候选探测次数

/** 贪心打包：按 order 序，收所有与已选两两 ΔE ≥ de 的色（确定性，一次线性扫描） */
function packGreedy(c, order, de, target) {
  const chosen = [];
  for (const i of order) {
    let ok = true;
    for (let k = 0; k < chosen.length; k += 1) {
      if (deFlat(c, chosen[k], i) < de) {
        ok = false;
        break;
      }
    }
    if (ok) {
      chosen.push(i);
      if (target && chosen.length >= target) break;
    }
  }
  return chosen;
}

/** 最远点采样：从 seed 起，每步收「离已选最近点最远」的候选，直到最远距离 < de */
function farthestPoint(c, allowed, seed, de, target) {
  const inSet = new Set([seed]);
  const chosen = [seed];
  const minDist = new Float64Array(c.n).fill(Infinity);
  for (const i of allowed) minDist[i] = deFlat(c, seed, i);
  for (;;) {
    let best = -1;
    let bestD = de;
    for (const i of allowed) {
      if (inSet.has(i)) continue;
      if (minDist[i] > bestD) {
        bestD = minDist[i];
        best = i;
      }
    }
    if (best < 0) break;
    inSet.add(best);
    chosen.push(best);
    for (const i of allowed) {
      const d = deFlat(c, best, i);
      if (d < minDist[i]) minDist[i] = d;
    }
    if (target && chosen.length >= target) break;
  }
  return chosen;
}

/** 回溯 DFS：固定序枚举 target 档团；found=见证，exhausted=约简网格上不可解的证明。预算按内层探测次数计 */
function dfsPack(c, ordered, de, target, budget) {
  let probes = 0;
  let aborted = false;
  const chosen = [];
  function rec(from) {
    if (chosen.length === target) return true;
    if (target - chosen.length > ordered.length - from) return false;
    for (let i = from; i < ordered.length; i += 1) {
      const cand = ordered[i];
      probes += 1;
      if (probes > budget) {
        aborted = true;
        return false;
      }
      let ok = true;
      for (let k = 0; k < chosen.length; k += 1) {
        if (deFlat(c, chosen[k], cand) < de) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      chosen.push(cand);
      if (rec(i + 1)) return true;
      chosen.pop();
      if (aborted) return false;
    }
    return false;
  }
  const found = rec(0);
  return { found, chosen: found ? [...chosen] : [], probes, exhausted: !aborted };
}

function minPairOfSet(c, set) {
  let m = Infinity;
  for (let a = 0; a < set.length; a += 1)
    for (let b = a + 1; b < set.length; b += 1) {
      const d = deFlat(c, set[a], set[b]);
      if (d < m) m = d;
    }
  return set.length >= 2 ? m : Infinity;
}

/**
 * 单底色一次求解（target=N 时找到即早退；target=null 时求最大下界）。
 * 返回 { size, witness, minPairDE, minContrast, allowed, dfsExhausted }
 */
function solveFor(c, de, ratio, target) {
  const allowed = [];
  for (let i = 0; i < c.n; i += 1) if (c.contrasts[i] >= ratio) allowed.push(i);
  if (allowed.length === 0)
    return { size: 0, witness: [], minPairDE: Infinity, minContrast: Infinity, allowed: 0, dfsExhausted: true };

  const chroma = (i) => Math.hypot(c.labFlat[i * 3 + 1], c.labFlat[i * 3 + 2]);
  const byContrastDesc = [...allowed].sort((a, b) => c.contrasts[b] - c.contrasts[a] || a - b);
  const byLDesc = [...allowed].sort((a, b) => c.labFlat[b * 3] - c.labFlat[a * 3] || a - b);
  const byLAsc = [...allowed].sort((a, b) => c.labFlat[a * 3] - c.labFlat[b * 3] || a - b);
  const byChromaDesc = [...allowed].sort((a, b) => chroma(b) - chroma(a) || a - b);
  const byHexAsc = [...allowed].sort((a, b) => (c.hex[a] < c.hex[b] ? -1 : c.hex[a] > c.hex[b] ? 1 : a - b));

  let best = [];
  for (const order of [byContrastDesc, byLDesc, byLAsc, byChromaDesc, byHexAsc]) {
    const w = packGreedy(c, order, de, target);
    if (w.length > best.length) best = w;
    if (target && best.length >= target) break;
  }
  if (!target || best.length < target) {
    const seeds = [
      byContrastDesc[0],
      byLDesc[0],
      byLAsc[0],
      byChromaDesc[0],
      [...allowed].sort((a, b) => c.labFlat[a * 3 + 1] - c.labFlat[b * 3 + 1] || a - b)[0],
      [...allowed].sort((a, b) => c.labFlat[b * 3 + 1] - c.labFlat[a * 3 + 1] || a - b)[0],
      [...allowed].sort((a, b) => c.labFlat[a * 3 + 2] - c.labFlat[b * 3 + 2] || a - b)[0],
      [...allowed].sort((a, b) => c.labFlat[b * 3 + 2] - c.labFlat[a * 3 + 2] || a - b)[0],
    ];
    for (const s of new Set(seeds)) {
      const w = farthestPoint(c, allowed, s, de, target);
      if (w.length > best.length) best = w;
      if (target && best.length >= target) break;
    }
  }

  // 仍不足 ⇒ 预算回溯：在 ΔE≥de*0.7 约简网（按对比度降序）上从 best+1 逐档上探
  let dfsExhausted = false;
  const want = target ?? best.length + 2;
  if (best.length < want) {
    const net = packGreedy(c, byContrastDesc, de * 0.7, 0);
    const netSorted = net
      .slice()
      .sort((a, b) => c.contrasts[b] - c.contrasts[a] || a - b);
    for (let t = best.length + 1; t <= want; t += 1) {
      const r = dfsPack(c, netSorted, de, t, DFS_NODE_BUDGET);
      if (r.found) {
        best = r.chosen;
        if (target && best.length >= target) break;
        continue;
      }
      if (r.exhausted && t === best.length + 1) dfsExhausted = true;
      break;
    }
  }

  const minCon = best.length ? Math.min(...best.map((i) => c.contrasts[i])) : Infinity;
  return {
    size: best.length,
    witness: best,
    minPairDE: minPairOfSet(c, best),
    minContrast: minCon,
    allowed: allowed.length,
    dfsExhausted,
  };
}

/* =============== 反算：要 N 档，阈值须降到多少（粗→细，确定性） =============== */

/** 保对比度 ratio，求「N 档可解」的最大 ΔE 阈值（12 → 3，步 0.25；0=连 3 都不可解） */
function backSolveDE(c, ratio, target) {
  for (let t = 12; t >= 3 - 1e-9; t -= 0.25) {
    const th = Math.round(t * 4) / 4;
    const r = solveFor(c, th, ratio, target);
    if (r.size >= target) return th;
  }
  return 0;
}

/** 保 ΔE=de，求「N 档可解」的最大对比度闸（4.5 → 1.0，步 0.05；0=连 1.0 都不可解） */
function backSolveContrast(c, de, target) {
  for (let t = 4.5; t >= 1 - 1e-9; t -= 0.05) {
    const th = Math.round(t * 20) / 20;
    const r = solveFor(c, de, th, target);
    if (r.size >= target) return th;
  }
  return 0;
}

/* =============== 现状测量（kojo2 三套现有 token 色） =============== */

function measureCurrent(theme, bgHex) {
  const fgs = [...new Set(theme.rules.map((r) => r.foreground).filter(Boolean))].map(strip);
  let minPair = Infinity;
  for (let i = 0; i < fgs.length; i += 1)
    for (let j = i + 1; j < fgs.length; j += 1) {
      const d = deltaE(fgs[i], fgs[j]);
      if (d < minPair) minPair = d;
    }
  const minCon = Math.min(...fgs.map((f) => contrast(f, bgHex)));
  return { unique: fgs.length, minPairDE: fgs.length > 1 ? minPair : 0, minContrast: minCon };
}

/* ============================== 主流程 ============================== */

const fmt1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const fmt2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

async function main() {
  const t0 = Date.now();
  const v1 = readV1Backgrounds();
  const kojo2 = await loadKojo2Module();
  // 供方只声明**侧名**（`componentPalette`），底色因此就是宿主同侧部件色的 `editor.background`
  // ——`theme-color-gates.test.ts` 钉的"同一主题族 v1 与 2.0 逐键相等"就是这条同源关系。
  const SIDE_TO_V1_BG = { dark: 'dark', light: 'light', mint: 'mint-dark' };
  const kojo2Bg = {};
  for (const id of kojo2.KOJO2_THEME_IDS) {
    const side = kojo2.KOJO2_THEMES[id].componentPalette ?? 'dark';
    const pref = SIDE_TO_V1_BG[side];
    if (pref === undefined) throw new Error(`未知的部件色侧「${side}」（主题三套）`);
    kojo2Bg[id] = v1[pref];
  }

  const THEMES = [
    { theme: 'kojo-dark', bg: v1.dark },
    { theme: 'kojo-light', bg: v1.light },
    { theme: 'kojo-mint-dark', bg: v1['mint-dark'] },
    { theme: 'kojo2-dark', bg: kojo2Bg['kojo2-dark'] },
    { theme: 'kojo2-light', bg: kojo2Bg['kojo2-light'] },
    { theme: 'kojo2-mint-dark', bg: kojo2Bg['kojo2-mint-dark'] },
  ];

  const lv = gridLevels(STEP);
  console.log('=== LAU-2 色可行性探针（tools/color-feasibility.mjs） ===');
  console.log(`参数：档数 N=${N}｜ΔE≥${DE}（CIE76）｜对比度≥${CONTRAST}（WCAG）｜候选：sRGB 网格步长 ${STEP}（${lv.length} 级/通道 = ${lv.length ** 3} 色）`);
  console.log('度量源：packages/app/tests/kojo2-theme.test.ts :71-113 逐字复用；求解确定性：固定序贪心/最远点/预算回溯，无随机数');
  console.log('\n底色（源码现场读取）：');
  for (const t of THEMES) console.log(`  ${t.theme.padEnd(16)} #${t.bg}`);

  const uniqBgs = [...new Set(THEMES.map((t) => t.bg))];
  console.log(`\n6 套主题实为 ${uniqBgs.length} 个不同底色：${uniqBgs.map((b) => `#${b}`).join('、')}（同底 ⇒ 同解）`);

  const candCache = new Map();
  const solCache = new Map();
  function candsOf(bg) {
    if (!candCache.has(bg)) candCache.set(bg, buildCandidates(bg, STEP));
    return candCache.get(bg);
  }
  function solveCached(bg, de, ratio, target) {
    const key = `${bg}|${de}|${ratio}|${target ?? 'max'}`;
    if (!solCache.has(key)) solCache.set(key, solveFor(candsOf(bg), de, ratio, target));
    return solCache.get(key);
  }

  // ① 逐主题 18 档判定（先 max 跑，顺带得 ②）
  console.log(`\n--- ① ${N} 档逐底色判定 @ ΔE≥${DE} ∧ 对比≥${CONTRAST} ---`);
  const perBg = new Map();
  for (const bg of uniqBgs) perBg.set(bg, solveCached(bg, DE, CONTRAST, null));
  for (const bg of uniqBgs) {
    const r = perBg.get(bg);
    console.log(
      `  #${bg}：过对比闸候选 ${r.allowed} 色 ⇒ ${r.size >= N ? '✅ 可解' : '❌ 未找到解'}；` +
        `本次实拿 ${r.size} 档（见证 min两两ΔE ${fmt1(r.minPairDE)}｜min对比度 ${fmt2(r.minContrast)}｜余量 ${fmt2(r.minContrast - CONTRAST)}）`,
    );
  }
  console.log('  逐主题：');
  for (const t of THEMES) {
    const r = perBg.get(t.bg);
    console.log(`    ${t.theme.padEnd(16)} ${r.size >= N ? `✅ ${N} 档可解` : `❌ 网格+预算内 ${N} 档不可解（最大 ${r.size} 档，下界）`}`);
  }

  // ② 最大可解档数
  console.log('\n--- ② 每底色最大可解档数（贪心+最远点+回溯下界；exhausted=约简网格上已证不能再大） ---');
  for (const bg of uniqBgs) {
    const r = perBg.get(bg);
    console.log(
      `  #${bg}：${r.size} 档${r.dfsExhausted ? '（ΔE≥' + (DE * 0.7).toFixed(1) + ' 约简网格上 DFS 穷尽 ⇒ 该网格内即最大）' : '（DFS 未穷尽 ⇒ 真实上限或更高）'}`,
    );
  }

  // ③ 全局上限
  const globalMax = Math.min(...uniqBgs.map((b) => perBg.get(b).size));
  const tightest = uniqBgs.find((b) => perBg.get(b).size === globalMax);
  console.log(`\n--- ③ 全局上限（取最严格底色）：${globalMax} 档 @ #${tightest} ⇒ ${N} 档${globalMax >= N ? '全主题可达' : '不可达'} ---`);

  // ④ 见证色组 / 阈值反算
  console.log(`\n--- ④ ${N} 档候选色组（可解底色）/ 阈值反算（不可解底色） ---`);
  const deStars = new Map();
  const conStars = new Map();
  for (const bg of uniqBgs) {
    const r = perBg.get(bg);
    const c = candsOf(bg);
    if (r.size >= N) {
      const pal = r.witness.slice(0, N).map((i) => `#${c.hex[i]}`);
      console.log(`  #${bg}：${N} 档见证色组：${pal.join(' ')}`);
    } else {
      const deStar = backSolveDE(c, CONTRAST, N);
      const conStar = backSolveContrast(c, DE, N);
      deStars.set(bg, deStar);
      conStars.set(bg, conStar);
      console.log(`  #${bg}：${N} 档@(ΔE ${DE}, 对比 ${CONTRAST}) 未找到解 ⇒ 反算：`);
      console.log(
        `     · 保对比 ${CONTRAST}：ΔE 闸须降到 ≤ ${fmt1(deStar)}${deStar > 0 ? `（现 ${DE}；若定 ${fmt1(deStar)} 则 ${N} 档可解）` : '（连 ΔE 3 都不可解）'}`,
      );
      console.log(
        `     · 保 ΔE ${DE}：对比度闸须降到 ≤ ${fmt2(conStar)}${conStar > 0 ? `（现 ${CONTRAST}）` : '（连对比 1.0 都不可解）'}`,
      );
    }
  }
  if (globalMax < N && deStars.size) {
    const worstDe = Math.min(...deStars.values());
    const worstCon = Math.min(...conStars.values());
    const worstBg = [...deStars.entries()].sort((a, b) => a[1] - b[1])[0];
    console.log(
      `  全局（6 套同时）：要么保对比 ${CONTRAST} 把 ΔE 降到 ≤ ${fmt1(worstDe)}（瓶颈底色 #${worstBg[0]}），` +
        `要么保 ΔE ${DE} 把对比闸降到 ≤ ${fmt2(worstCon)}；否则档数上限 ${globalMax}。`,
    );
  }

  // ⑤ 现状参照系
  console.log('\n--- ⑤ 现状参照系：kojo2 三套 token 色去重实测（同一指标口径） ---');
  let curUnique = 0;
  for (const id of kojo2.KOJO2_THEME_IDS) {
    const m = measureCurrent(kojo2.KOJO2_THEMES[id], kojo2Bg[id]);
    curUnique = Math.max(curUnique, m.unique);
    console.log(
      `  ${id.padEnd(16)}：${m.unique} 唯一色｜最小两两 ΔE ${fmt1(m.minPairDE)}（闸 ${DE} ⇒ 余量 ${fmt1(m.minPairDE - DE)}）｜` +
        `最小对比度 ${fmt2(m.minContrast)}（闸 ${CONTRAST} ⇒ 余量 ${fmt2(m.minContrast - CONTRAST)}）`,
    );
  }
  console.log(`  对照：现 ${curUnique} 色全过双闸；${N} 档 ⇒ 同一底色要再塞 ${N - curUnique} 个两两 ΔE≥${DE} 的色。`);

  const gridStepDE = deltaE('000000', toHex6(STEP, STEP, STEP));
  console.log(
    `\n[方法尾注] 「可解」= 离散网格上的**显式见证**，且网格点本身就是真实 8-bit sRGB 色（ΔE 判定与闸同用 ≥、无容差）⇒ 对见证色组这是完备结论，不存在“色造不出来”的问题。` +
      `网格的离散性只影响**完备性方向**：相邻网格点在 Lab 中相距 ${fmt1(gridStepDE)} 级（角点最小、白端略大），` +
      `连续空间恰卡在阈值线上的解可能网格上不显——但阈值余量只要有 ~${fmt1(gridStepDE)} 就稳。` +
      `「不可解」= 贪心×5 + 最远点×8 + 约简网 DFS（预算 ${DFS_NODE_BUDGET} 次探测）皆无解，是网格+方法覆盖内的弱结论。` +
      `全程无随机数：同参数重跑读数逐字一致。`,
  );
  console.log(`[耗时] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('探针失败：', e);
  process.exit(1);
});
