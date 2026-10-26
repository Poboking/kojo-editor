/**
 * 「刻度面统一（TOKEN-SCALE）」可执行棘轮闸（与 tools/audit-language.mjs / audit-decoupling.mjs 同族）。
 *
 * 立论（体感批 B-7 · VIS-03，2026-10-26）：tokens.css 已经把间距 / 层级 / 动效做成了**唯一档位表**，
 * 但档位表的兑现率从来没人钉——实测 `z-index` 57 条里只有 14 条吃 `--z-*`（24.6%），
 * 动效时长里裸 `ms/s` 成片（`--dur-*` / `--anim-*` 两族立档时自陈"只定义不替换"）。
 * "grep 到零"那种终态口号当天就红、第二天就没人跑，所以这里走**基线棘轮**：
 * 每文件按命中数钉进 `tools/audit-token-scale-baseline.json`，**只拦增长、放行收敛**，
 * 收敛后跑 `--update-baseline` 重钉，读数只会单调下降。
 *
 * 两类检查（编号照仓库惯例打头）：
 *   Z1(z-index 裸值)  一条 `z-index:` 声明的取值里出现**没走 `--z-*` 族**的数字即命中
 *      （`var(--z-modal)`、`calc(var(--z-modal) + 1)` 都合规；`1200`、`30`、
 *       以及槽位形态的 `var(--sticky-z, 1)` 绕开了档位表 ⇒ 记账）。
 *      为什么连槽位也记：槽位的兜底值是人手抄的第二张口径（`css-token-single-source.test.ts`
 *      的幻影台账管的就是这类），并进来才有"要么登记、要么显式豁免"的推力。
 *   D1(动效裸时长)    `transition` / `transition-duration` / `animation` / `animation-duration`
 *      的取值里出现裸 `Nms` / `Ns` 字面量即命中（`var(--dur-2)`、`var(--anim-spin)` 合规；
 *      缓动函数 `cubic-bezier(…)`、迭代次数 `infinite`、`0.01ms` 以外的数字不误伤）。
 *
 * 豁免口径（逐字继承 audit-decoupling / audit-language 三条，不另开口径）：
 *   ① 豁免必须落在**注释位**（整行注释或行尾注释），判据用同一实现 `tools/lib/audit-allow.mjs`
 *      ——`'audit-allow: …'` 这类字符串里的同名串不算；
 *   ② 必须带**非空理由**：`audit-allow:` 后面光秃秃不算豁免；
 *   ③ 注释与**数值真源文件**整体跳过：CSS 块注释在采集前先按行抹平（注释里的 `z-index: 9999`
 *      不是泄漏，是散文）；`tokens.css` 与 `themes/*.css` 是 token 定义点（= 本闸的"组合根"），
 *      字面量就是它们的工作，不进扫描面。
 *   命中数与豁免行数**都**按文件钉棘轮：想新增一行 `audit-allow`，必须在同批删掉等量旧豁免。
 *
 * 用法：
 *   node tools/audit-token-scale.mjs                     # 跑闸
 *   node tools/audit-token-scale.mjs --update-baseline    # 用当前读数重写基线
 *   node tools/audit-token-scale.mjs --selftest           # 负例自证：两族各注入一条必红 + 合法/豁免必绿
 *                                                         #   + 收紧后的豁免两条（串里随手写 / 空理由）必红
 *   node tools/audit-token-scale.mjs --root <dir> --baseline <file>   # 测试夹具用
 * 退出码：0 = 相对基线无新增；1 = 有文件超出基线 / 豁免行数上升 / 基线缺失（fail-closed）。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { licenseOf } from './lib/audit-allow.mjs';

const runExec = promisify(execFile);

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
function flagArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const UPDATE_BASELINE = argv.includes('--update-baseline');
const SELFTEST = argv.includes('--selftest');
const ROOT = path.resolve(flagArg('--root') ?? path.resolve(import.meta.dirname, '..'));
const BASELINE_FILE = path.resolve(flagArg('--baseline') ?? path.join(ROOT, 'tools', 'audit-token-scale-baseline.json'));

/** 扫描目录（相对仓库根）：宿主样式 + 启动器 + 插件切片里的 CSS */
const SCAN_DIRS = ['packages'];
/** 数值真源＝本闸的"组合根"：tokens.css 与两档主题文件的工作就是写字面量，整体跳过 */
const EXEMPT_FILES = new Set([
  'packages/app/src/tokens.css',
  'packages/app/src/themes/light.css',
  'packages/app/src/themes/mint-dark.css',
]);

/* ---------------- 判据 ---------------- */

const PROPS_Z = new Set(['z-index']);
const PROPS_D = new Set([
  'transition',
  'transition-duration',
  'transition-delay',
  'animation',
  'animation-duration',
  'animation-delay',
]);
/** 裸时长：数字（可带小数）紧跟 ms / s，且前面不是标识符字符（`26s` 记、`ease-in-out` 不记） */
const BARE_DURATION = /(?:^|[^\w-])(\d+(?:\.\d+)?)(m?s)(?![\w-])/;
/** 把 var( … ) 整段抹成空格（含兜底），于是 `var(--z-modal)` 不再被当成裸数 */
function maskVars(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('var(', i)) {
      out += 'var(';
      i += 4;
      let d = 1;
      while (i < text.length && d > 0) {
        const c = text[i];
        if (c === '(') d++;
        else if (c === ')') {
          d--;
          if (d === 0) {
            out += c;
            i++;
            break;
          }
          out += ' ';
          i++;
          continue;
        }
        out += ' ';
        i++;
      }
      continue;
    }
    out += text[i++];
  }
  return out;
}

const CHECKS = [
  {
    id: 'Z1(z-index裸值)',
    props: PROPS_Z,
    /** 合规：取值里任何一处引用了 `--z-*` 族；其余（裸数、别的槽位 var）一律记账 */
    hit: (value) => !/--z-[A-Za-z0-9-]+/.test(value),
  },
  {
    id: 'D1(动效裸时长)',
    props: PROPS_D,
    hit: (value) => BARE_DURATION.test(maskVars(value)),
  },
];

/* ---------------- 采集 ---------------- */

async function walk(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'coverage' || e.name === 'target') continue;
      await walk(p, acc);
    } else if (e.name.endsWith('.css')) {
      acc.push(p);
    }
  }
  return acc;
}

const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

/**
 * 块注释抹平（**保留行数与每行的列位**）：注释里的 `z-index: 9999` 是散文不是泄漏（= 注释行跳过
 * 的 CSS 等价物），而行尾的 audit-allow 块注释要留给 licenseOf 判——所以只在**注释起点**处
 * 切断：本行的前缀（代码位）保留，起点之后原样交回给 licenseOf 那条判据另行处理。
 */
function maskBlockComments(lines) {
  const out = [];
  const stripped = []; // 代码位（注释已删）
  let inBlock = false;
  for (const line of lines) {
    let text = line;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end < 0) {
        stripped.push('');
        out.push(line);
        continue;
      }
      text = text.slice(end + 2);
      inBlock = false;
    }
    // 逐个切掉行内单行/跨行块注释的**代码位**部分
    let code = '';
    let rest = text;
    for (;;) {
      const start = rest.indexOf('/*');
      if (start < 0) {
        code += rest;
        break;
      }
      const end = rest.indexOf('*/', start + 2);
      if (end < 0) {
        code += rest.slice(0, start);
        inBlock = true;
        break;
      }
      code += rest.slice(0, start);
      rest = rest.slice(end + 2);
    }
    stripped.push(code);
    out.push(line);
  }
  return { raw: out, code: stripped };
}

/** 从一份 CSS 里取「声明」序列：prop / value / 起始行号 / 该声明横跨的原文行（供 licenseOf 判豁免） */
function declarations(lines) {
  const { raw, code } = maskBlockComments(lines);
  const out = [];
  let cur = '';
  let startLine = 1;
  let depth = 0;
  const flush = (endLine) => {
    const idx = cur.indexOf(':');
    if (idx > 0) {
      const prop = cur.slice(0, idx).trim().toLowerCase();
      if (/^[a-z-]+$/.test(prop)) {
        out.push({
          prop,
          value: cur.slice(idx + 1),
          line: startLine,
          // 豁免判据逐行看**原始行**（行尾注释在这些行里），与 audit-language 同一实现
          rawLines: raw.slice(startLine - 1, endLine),
          text: `${prop}: ${cur.slice(idx + 1)}`.replace(/\s+/g, ' ').trim().slice(0, 140),
        });
      }
    }
    cur = '';
  };
  for (let i = 0; i < code.length; i++) {
    const cLine = code[i];
    let pos = 0;
    while (pos < cLine.length) {
      const ch = cLine[pos];
      if (ch === '{' || ch === '}' || ch === ';') {
        if (depth >= 1) flush(i + 1);
        cur = ''; // 选择器 / at-rule 前导不是一声明：开块即清，否则 `.x { z-index: 1 }` 的 prop 会读成 `.x z-index`
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
        startLine = i + 1;
        pos++;
        continue;
      }
      cur += ch;
      pos++;
    }
    if (cur.trim() !== '') cur += ' ';
  }
  return out;
}

/**
 * 跑一遍采集：返回 { [checkId]: { hits: { [relFile]: [{line, text}] }, exempt: { [relFile]: n } } }。
 * hits 只含**代码行**上的违规声明（注释位与合法豁免不进基线）；
 * exempt 是被合法豁免（注释位 + 非空理由）的行数，单独进棘轮。
 */
async function collect() {
  const result = {};
  const files = [];
  for (const d of SCAN_DIRS) files.push(...(await walk(path.join(ROOT, d))));
  for (const check of CHECKS) {
    const perFile = {};
    const exempt = {};
    for (const f of files) {
      const r = rel(f);
      if (EXEMPT_FILES.has(r)) continue;
      const text = await fs.readFile(f, 'utf8');
      for (const d of declarations(text.split(/\r?\n/))) {
        if (!check.props.has(d.prop)) continue;
        // 豁免先判：与 audit-language 同一实现（注释位 + 非空理由；串里的同名串不算）
        if (d.rawLines.some((l) => licenseOf(l) !== null)) {
          exempt[r] = (exempt[r] ?? 0) + 1;
          continue;
        }
        if (check.hit(d.value)) (perFile[r] ??= []).push({ line: d.line, text: d.text });
      }
    }
    result[check.id] = { hits: perFile, exempt };
  }
  return result;
}

/* ---------------- 基线读写（与 audit-language 同形态） ---------------- */

async function readBaseline() {
  try {
    return JSON.parse(await fs.readFile(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function renderBaseline(collected) {
  const checks = {};
  for (const [id, { hits: perFile, exempt: exemptPerFile }] of Object.entries(collected)) {
    const files = {};
    for (const [f, hits] of Object.entries(perFile).sort((a, b) => a[0].localeCompare(b[0]))) files[f] = hits.length;
    const exemptFiles = {};
    for (const [f, n] of Object.entries(exemptPerFile).sort((a, b) => a[0].localeCompare(b[0]))) exemptFiles[f] = n;
    checks[id] = {
      total: Object.values(files).reduce((s, n) => s + n, 0),
      files,
      exempt: { total: Object.values(exemptFiles).reduce((s, n) => s + n, 0), files: exemptFiles },
    };
  }
  return {
    _readme:
      'tools/audit-token-scale.mjs 的棘轮基线：每文件只数代码行上的违规声明数（files）与被合法豁免的行数（exempt），两者都只拦增长。收敛后跑 `node tools/audit-token-scale.mjs --update-baseline` 重钉。',
    checks,
  };
}

/* ---------------- 判定与报告 ---------------- */

function judge(collected, baseline) {
  const report = [];
  let red = false;
  for (const check of CHECKS) {
    const { hits: perFile, exempt: exemptPerFile } = collected[check.id];
    const baseFiles = baseline?.checks?.[check.id]?.files ?? {};
    const exceeded = [];
    let shrunk = 0;
    let totalNow = 0;
    for (const [f, hits] of Object.entries(perFile)) {
      totalNow += hits.length;
      const allowed = baseFiles[f] ?? 0;
      if (hits.length > allowed) exceeded.push({ file: f, hits, allowed });
      else if (hits.length < allowed) shrunk++;
    }
    for (const [f, allowed] of Object.entries(baseFiles)) {
      if (allowed > 0 && !(f in perFile)) shrunk++;
    }
    const baseExempt = baseline?.checks?.[check.id]?.exempt?.files ?? {};
    const exemptExceeded = [];
    let exemptNow = 0;
    for (const [f, n] of Object.entries(exemptPerFile)) {
      exemptNow += n;
      const allowed = baseExempt[f] ?? 0;
      if (n > allowed) exemptExceeded.push({ file: f, now: n, allowed });
    }
    if (exceeded.length > 0 || exemptExceeded.length > 0) red = true;
    report.push({
      check: check.id,
      totalNow,
      baseTotal: baseline?.checks?.[check.id]?.total ?? 0,
      exceeded,
      shrunk,
      exemptNow,
      exemptBase: baseline?.checks?.[check.id]?.exempt?.total ?? 0,
      exemptExceeded,
    });
  }
  return { red, report };
}

function printReport(report, baselineSource) {
  console.log('=== 刻度面审计（audit-token-scale · 棘轮）===');
  console.log(`基线：${baselineSource}\n`);
  for (const r of report) {
    const exemptLine = `豁免行 ${r.exemptNow} 行 / 基线 ${r.exemptBase} 行`;
    if (r.exceeded.length === 0 && r.exemptExceeded.length === 0) {
      console.log(`✅ ${r.check}：代码行命中 ${r.totalNow} 行，未超基线 ${r.baseTotal} 行；${exemptLine}${r.shrunk > 0 ? `（有 ${r.shrunk} 个文件低于基线，可 --update-baseline 重钉）` : ''}`);
    } else {
      if (r.exceeded.length > 0) {
        console.log(`❌ ${r.check}：${r.exceeded.length} 个文件超出基线（当前共 ${r.totalNow} 行 / 基线 ${r.baseTotal} 行；${exemptLine}）`);
        for (const e of r.exceeded) {
          console.log(`   [${r.check}] ${e.file}：命中 ${e.hits.length} 行 > 基线 ${e.allowed} 行`);
          for (const h of e.hits.slice(0, 10)) console.log(`       :${h.line}  ${h.text}`);
          if (e.hits.length > 10) console.log(`       …还有 ${e.hits.length - 10} 行`);
        }
      } else {
        console.log(`❌ ${r.check}：豁免行数上升（当前 ${r.exemptNow} 行 / 基线 ${r.exemptBase} 行；${exemptLine}）`);
      }
      for (const e of r.exemptExceeded) {
        console.log(`   [${r.check}] ${e.file}：豁免 ${e.now} 行 > 基线 ${e.allowed} 行——新增 audit-allow 先删等量旧豁免`);
      }
    }
    console.log('');
  }
}

/* ---------------- 自证负例（--selftest） ---------------- */

/**
 * 沙箱里两族各注入一条违规 + 一组"必须不红"的合法/豁免样例 + 收紧后的两条豁免反例，
 * 以 --root 重入本脚本真跑子进程：违规⇒红、合法⇒绿，方向全对才算过。
 */
async function selftest() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-audit-scale-'));
  const write = async (relPath, content) => {
    const abs = path.join(tmp, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  };
  const created = [];
  const run = async (extraFiles) => {
    for (const p of created) await fs.rm(path.join(tmp, p), { force: true });
    created.length = 0;
    for (const [p, c] of Object.entries(extraFiles)) {
      await write(p, c);
      created.push(p);
    }
    try {
      const res = await runExec(process.execPath, [path.join(import.meta.dirname, 'audit-token-scale.mjs'), '--root', tmp]);
      return { code: 0, out: `${res.stdout}\n${res.stderr}` };
    } catch (err) {
      const e = err;
      return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
    }
  };

  // 沙箱基线：全零（任何命中都算"超基线"），但给对照组那条合法豁免钉一格豁免位
  const sandboxBaseline = {
    _readme: 'selftest 沙箱基线',
    checks: Object.fromEntries(
      CHECKS.map((c) => [
        c.id,
        { total: 0, files: {}, exempt: { total: 1, files: { 'packages/app/src/selftest-clean.css': 1 } } },
      ]),
    ),
  };
  await write('tools/audit-token-scale-baseline.json', `${JSON.stringify(sandboxBaseline, null, 2)}\n`);

  const cases = [];
  // 0) 对照组：token 消费 + 注释 + 行尾 audit-allow（带理由），必须绿
  const clean = await run({
    'packages/app/src/selftest-clean.css': [
      '/* 注释里写 z-index: 9999 与 transition: all 5s 都不算违规（注释位不是代码位） */',
      '.a { z-index: var(--z-modal); }',
      '.b { z-index: calc(var(--z-modal) + 1); }',
      '.c { transition: background-color var(--dur-1) var(--ease-out); }',
      '.d { z-index: 4321; /* audit-allow: 组合根示例行，本面自成一档已登记 */ }',
      '',
    ].join('\n'),
  });
  cases.push({ name: '合法落点/注释/audit-allow ⇒ 绿', want: 0, got: clean.code, out: clean.out });
  // 1) Z1：裸 z-index 进代码行
  const z1 = await run({ 'packages/app/src/selftest-z1.css': '.x { z-index: 1200; }\n' });
  cases.push({ name: 'Z1 裸 z-index ⇒ 红', want: 1, got: z1.code, out: z1.out });
  // 2) D1：裸动效时长（跨行声明也要抓到）
  const d1 = await run({ 'packages/app/src/selftest-d1.css': '.y {\n  transition:\n    left 320ms ease-out;\n}\n' });
  cases.push({ name: 'D1 裸时长（多行 transition）⇒ 红', want: 1, got: d1.code, out: d1.out });
  // 3) 豁免反例①：audit-allow 落在字符串/选择器里（非注释位）⇒ 不豁免，照样红
  const allowInString = await run({
    'packages/app/src/selftest-allow-string.css': '.z { z-index: 1200; content: "audit-allow: 行中随手写不该免责"; }\n',
  });
  cases.push({ name: 'audit-allow 不在注释位 ⇒ 红', want: 1, got: allowInString.code, out: allowInString.out });
  // 4) 豁免反例②：注释位但理由为空 ⇒ 红
  const allowNoReason = await run({ 'packages/app/src/selftest-allow-noreason.css': '.w { z-index: 1200; /* audit-allow: */ }\n' });
  cases.push({ name: '注释位 audit-allow 但理由为空 ⇒ 红', want: 1, got: allowNoReason.code, out: allowNoReason.out });

  await fs.rm(tmp, { recursive: true, force: true });

  console.log('=== audit-token-scale --selftest（负例自证）===');
  let allOk = true;
  for (const c of cases) {
    const ok = c.got === c.want && (c.want === 0 || c.out.includes('❌'));
    if (!ok) allOk = false;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}（期望 rc=${c.want}，实得 rc=${c.got}）`);
    if (!ok) console.log(c.out);
  }
  console.log(
    allOk
      ? '自证通过：两族违规都会红，合法与豁免不红，非注释位 / 空理由也不再免责。'
      : '自证失败：闸不可信，别交付。',
  );
  process.exit(allOk ? 0 : 1);
}

/* ---------------- 主流程 ---------------- */

if (SELFTEST) {
  await selftest();
}

const collected = await collect();

if (UPDATE_BASELINE) {
  const out = renderBaseline(collected);
  await fs.mkdir(path.dirname(BASELINE_FILE), { recursive: true });
  await fs.writeFile(BASELINE_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  const totals = Object.entries(out.checks).map(([id, c]) => `${id} ${c.total} 行`).join('；');
  console.log(`基线已重写：${BASELINE_FILE}\n${totals}`);
  process.exit(0);
}

const baseline = await readBaseline();
if (!baseline) {
  console.error(`审计中止：读不到基线 ${BASELINE_FILE}（无基线 = 无闸；先跑 --update-baseline 或恢复该文件）。`);
  process.exit(1);
}

const { red, report } = judge(collected, baseline);
printReport(report, `${BASELINE_FILE}（棘轮：只拦增长）`);
console.log(red ? '❌ 刻度面审计：存在超出基线的新增命中。' : '✅ 刻度面审计：两类检查均未超出基线。');
process.exit(red ? 1 : 0);
