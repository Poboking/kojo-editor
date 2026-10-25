/**
 * 「语言面统一（LAU）」可执行闸（棘轮版；与 tools/audit-decoupling.mjs 同族）。
 *
 * 把 docs/ARCH-language-unification.md §9 判据 1 / 7（§5.6 判据 1、§3-R1/R4/R6 复核口径）
 * 从"grep 零命中"的终态口号落成**当天就能跑、红绿可解释**的门禁：
 * 终态判据不许当单批 DoD（§3-R1 明示），所以三类检查都走**基线棘轮**——
 * 每个文件按行数钉进 tools/audit-language-baseline.json，**只拦增长、放行收敛**；
 * 收敛后跑 `--update-baseline` 重钉，读数只会单调下降。
 *
 * 三类检查（编号 M，报告里以此打头）：
 *   M1(游戏名·引擎词汇)  §9-7 / §5.6-1：游戏名（清单 auditWord，大小写不敏感）与 era 引擎
 *      变量族词汇（大小写敏感白名单，见 ENGINE_WORDS 的取舍注释）在扫描目录里只许出现在
 *      法定落点——`adapter-manifest.ts`（整文件豁免）、`era*-adapter` 包（不在扫描目录内，
 *      天然豁免）、带 `// audit-allow:` 的行。扫描目录：packages/app/src（宿主）、
 *      packages/kojo-lang/src、packages/erb-syntax-tree/src（语言面/语法面）。
 *      注：erb-parser 的引擎变量族白名单（undefined-name.ts:148-240）按 §9-7 口径属
 *      LAU-D2 外提对象，插件层由 audit-decoupling D 项负责，本闸不重复扫。
 *   M2(语言id分支)       §9-1 / §3-R1：packages/app/src/monaco/ 里按具体语言 id 分支
 *      （`*_LANGUAGE_ID` 常量）的存量计数；终态只许出现在 descriptor 自身与别名表，
 *      今日基线按文件钉死，新增即红。
 *   M3(旧token名)        §9-1 同族的 token 命名遗留：`sugar.*` / `kojo2.*` / `keyword.erb*`
 *      只许出现在别名表/词表定义处（LAU-2 之后才成立），先按计数棘轮。
 *
 * 豁免口径（§5.6-1 钦定，照抄 audit-decoupling）：
 *   ① 行尾 `// audit-allow: <理由>` 豁免；② 注释行豁免（isCommentLine 与其同一实现）；
 *   ③ 组合根/清单豁免（本仓即 adapter-manifest.ts 整文件 + 其余落点靠 audit-allow 行）。
 * 因此本闸的行数与 §9 引用的**裸 grep 数**（257 / 62）口径不同：那是对全部行的 grep，
 * 本闸只数"代码行"（注释与豁免行不进基线）。
 * 交付批实测（feef111a）：kojo-lang/src 与 erb-syntax-tree/src 纳入扫描面后**代码行命中
 * 为 0**（此前 grep 到的 `kojo2.` 一处落在块注释里，按上述口径豁免）——即"纳入即红"的
 * 担忧未兑现，基线 M1/M3 里这两目录无条目；若未来它们真进代码行，棘轮会当场拦下。
 *
 * 用法：
 *   node tools/audit-language.mjs                 # 跑闸（pnpm audit:language）
 *   node tools/audit-language.mjs --update-baseline   # 用当前读数重写基线
 *   node tools/audit-language.mjs --selftest          # 自证负例：三族各注入一条违规，必须红
 *   node tools/audit-language.mjs --root <dir> --baseline <file>   # 测试夹具用
 * 退出码：0 = 相对基线无新增；1 = 有文件超出基线 / 基线缺失（fail-closed）。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { manifestAuditWords, MANIFEST_REL } from './adapter-manifest-words.mjs';

const runExec = promisify(execFile);

/* ---------------- 参数与常量 ---------------- */

const argv = process.argv.slice(2);
function flagArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const UPDATE_BASELINE = argv.includes('--update-baseline');
const SELFTEST = argv.includes('--selftest');
const ROOT = path.resolve(flagArg('--root') ?? path.resolve(import.meta.dirname, '..'));
const BASELINE_FILE = path.resolve(flagArg('--baseline') ?? path.join(ROOT, 'tools', 'audit-language-baseline.json'));

/** 与 audit-decoupling 同口径的注释行判定（:53-63 原样搬运——注释里的元描述不是泄漏） */
function isCommentLine(line) {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('///') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith(';') ||
    t.startsWith('//!')
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * M1 引擎词汇表（**大小写敏感**——era 引擎词汇全大写，误伤小写标识符的机会为零）。
 * 取自 §5.6-1 点名的 Monarch 变量族（erb-language.ts:159）与 erb-parser 引擎保留名清单里
 * **判别度高**的成员；刻意不收 `EXP`/`BASE`/`EX`/`NO`/`MARK`/`FLAG`/`TIME` 这类
 * 与工程通用词撞车的短名（收了会把基线灌满假阳性，稀释闸值）——漏掉的族名今后
 * 想收进黑名单时，应当先在 §9-7 台账里对上数。
 */
const ENGINE_WORDS = [
  'ABL', 'ASSIPLAY', 'CALLNAME', 'CFLAG', 'CDFLAG', 'CHARANUM', 'CSTR', 'CDOWN', 'CUP',
  'DOWNBASE', 'EQUIP', 'GAMEBASE', 'GOTJUEL', 'JUEL', 'LOSEBASE', 'MASTER', 'MASTERNAME',
  'NOWEX', 'PALAM', 'PALAMLV', 'PREVCOM', 'SELECTCOM', 'STAIN', 'TALENT', 'TCVAR',
  'TEQUIP', 'TFLAG', 'TRAINNAME', 'TSTR',
];
const ENGINE_RE = new RegExp(`\\b(?:${ENGINE_WORDS.join('|')})\\b`);
/** 词表之外补一刀：era 引擎实现名出现在代码行同样算事实面泄漏 */
const ENGINE_RE2 = /\bEmuera\b/;

/** M2：monaco 语言层里按具体语言 id 分支的常量形态（`ERB_LANGUAGE_ID` 等） */
const LANGUAGE_ID_RE = /\b[A-Z][A-Z0-9_]*_LANGUAGE_ID\b/;

/** M3：旧 token 名前缀（sugar./kojo2./keyword.erb*） */
const LEGACY_TOKEN_RE = /\b(?:sugar|kojo2)\.[A-Za-z_][\w.]*|keyword\.erb[\w.]*/;

/** 各检查的扫描目录与豁免文件（相对仓库根） */
const CHECKS = [
  {
    id: 'M1(游戏名·引擎词汇)',
    dirs: ['packages/app/src', 'packages/kojo-lang/src', 'packages/erb-syntax-tree/src'],
    exemptFiles: new Set([MANIFEST_REL]), // adapter-manifest.ts＝游戏名清单的法定落点
    pattern: 'gameWords|engineWords', // 特判：两条正则 + 清单词动态合成
  },
  {
    id: 'M2(语言id分支)',
    dirs: ['packages/app/src/monaco'],
    exemptFiles: new Set([MANIFEST_REL]),
    pattern: LANGUAGE_ID_RE,
  },
  {
    id: 'M3(旧token名)',
    dirs: ['packages/app/src', 'packages/kojo-lang/src', 'packages/erb-syntax-tree/src'],
    exemptFiles: new Set([MANIFEST_REL]),
    pattern: LEGACY_TOKEN_RE,
  },
];

/* ---------------- 采集 ---------------- */

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'target') continue;
      out.push(...(await walk(p)));
    } else if (/\.(ts|tsx|rs|mjs)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

/**
 * 跑一遍采集：返回 { [checkId]: { [relFile]: [{line, text}] } }，只含**代码行**
 * （注释行、`audit-allow:` 行、豁免文件整体跳过——与 audit-decoupling 同一口径）。
 */
async function collect() {
  // M1 的游戏名来自适配器清单；读不到就判红（fail-closed，照抄 decoupling :30-35）
  let gameRe;
  try {
    const words = manifestAuditWords(ROOT);
    const extra = words.map((w) => (/^[\x20-\x7e]+$/.test(w) ? `\\b${escapeRegExp(w)}\\b` : escapeRegExp(w))).join('|');
    gameRe = new RegExp(`${extra}|M_KOJO|個人口上`, 'i');
  } catch (err) {
    console.error(`审计中止：读不到适配器清单的游戏名词（${String(err)}）`);
    process.exit(1);
  }

  const result = {};
  for (const check of CHECKS) {
    const perFile = {};
    for (const dirRel of check.dirs) {
      const dirAbs = path.join(ROOT, dirRel);
      const files = await walk(dirAbs);
      for (const f of files) {
        const r = rel(f);
        if (check.exemptFiles.has(r)) continue;
        const text = await fs.readFile(f, 'utf8');
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          if (/audit-allow:/.test(line)) continue;
          const hit =
            check.pattern === 'gameWords|engineWords'
              ? gameRe.test(line) || ENGINE_RE.test(line) || ENGINE_RE2.test(line)
              : check.pattern.test(line);
          if (hit) (perFile[r] ??= []).push({ line: i + 1, text: line.trim().slice(0, 140) });
        }
      }
    }
    result[check.id] = perFile;
  }
  return result;
}

/* ---------------- 基线读写 ---------------- */

async function readBaseline() {
  try {
    const raw = await fs.readFile(BASELINE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function renderBaseline(collected) {
  const checks = {};
  for (const [id, perFile] of Object.entries(collected)) {
    const files = {};
    for (const [f, hits] of Object.entries(perFile).sort((a, b) => a[0].localeCompare(b[0]))) files[f] = hits.length;
    checks[id] = { total: Object.values(files).reduce((s, n) => s + n, 0), files };
  }
  return {
    _readme:
      'tools/audit-language.mjs 的棘轮基线：每文件只数代码行命中数，只拦增长。收敛后跑 `node tools/audit-language.mjs --update-baseline` 重钉。',
    checks,
  };
}

/* ---------------- 判定与报告 ---------------- */

function judge(collected, baseline) {
  const report = [];
  let red = false;
  for (const check of CHECKS) {
    const perFile = collected[check.id];
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
      if (allowed > 0 && !(f in perFile)) shrunk++; // 整文件清零也算收敛
    }
    if (exceeded.length > 0) red = true;
    report.push({ check: check.id, totalNow, baseTotal: baseline?.checks?.[check.id]?.total ?? 0, exceeded, shrunk });
  }
  return { red, report };
}

function printReport(report, baselineSource) {
  console.log('=== 语言面/事实面审计（audit-language · 棘轮）===');
  console.log(`基线：${baselineSource}\n`);
  for (const r of report) {
    if (r.exceeded.length === 0) {
      console.log(`✅ ${r.check}：代码行命中 ${r.totalNow} 行，未超基线 ${r.baseTotal} 行${r.shrunk > 0 ? `（有 ${r.shrunk} 个文件低于基线，可 --update-baseline 重钉）` : ''}`);
    } else {
      console.log(`❌ ${r.check}：${r.exceeded.length} 个文件超出基线（当前共 ${r.totalNow} 行 / 基线 ${r.baseTotal} 行）`);
      for (const e of r.exceeded) {
        console.log(`   [${r.check}] ${e.file}：命中 ${e.hits.length} 行 > 基线 ${e.allowed} 行`);
        for (const h of e.hits.slice(0, 10)) console.log(`       :${h.line}  ${h.text}`);
        if (e.hits.length > 10) console.log(`       …还有 ${e.hits.length - 10} 行`);
      }
    }
    console.log('');
  }
}

/* ---------------- 自证负例（--selftest） ---------------- */

/**
 * 在临时沙箱里注入三族各一条违规 + 一组"必须不红"的合法/豁免样例，
 * 以 --root 重入本脚本真跑子进程：违规⇒红、合法⇒绿，四个方向全对才算过。
 * 基线取仓库真基线（探针文件名不在基线里 ⇒ 任何命中都是"超基线"）。
 */
async function selftest() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-audit-lang-'));
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
      const res = await runExec(process.execPath, [path.join(import.meta.dirname, 'audit-language.mjs'), '--root', tmp]);
      return { code: 0, out: `${res.stdout}\n${res.stderr}` };
    } catch (err) {
      const e = err;
      return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
    }
  };

  // 沙箱骨架：真清单（决定 M1 游戏名词表）+ 真基线（棘轮语义同真跑）
  const manifestSrc = await fs.readFile(path.join(ROOT, MANIFEST_REL), 'utf8');
  await write(MANIFEST_REL, manifestSrc);
  const baselineSrc = await fs.readFile(BASELINE_FILE, 'utf8');
  await write('tools/audit-language-baseline.json', baselineSrc);

  const cases = [];
  // 0) 对照组：合法落点 + 注释豁免 + audit-allow 行，必须绿
  const clean = await run({
    'packages/app/src/monaco/selftest-clean.ts': [
      "// 注释里提 erafl 与 CFLAG、ERB_LANGUAGE_ID、sugar.view 都不算泄漏",
      "const id = 1; // audit-allow: 组合根示例行",
      "export const marker = id;\n",
    ].join('\n'),
  });
  cases.push({ name: '合法落点/注释/audit-allow ⇒ 绿', want: 0, got: clean.code, out: clean.out });
  // 1) M1 游戏名（代码行、清单 auditWord）
  const m1g = await run({ 'packages/app/src/selftest-m1-game.ts': "export const GAME = 'erafl';\n" });
  cases.push({ name: 'M1 游戏名进宿主代码行 ⇒ 红', want: 1, got: m1g.code, out: m1g.out });
  // 2) M1 引擎词汇
  const m1e = await run({ 'packages/kojo-lang/src/selftest-m1-engine.ts': "export const FAMILY = 'CFLAG';\n" });
  cases.push({ name: 'M1 引擎词汇进语言面 ⇒ 红', want: 1, got: m1e.code, out: m1e.out });
  // 3) M2 语言 id 分支
  const m2 = await run({
    'packages/app/src/monaco/selftest-m2.ts': "if (model.getLanguageId() === ERB_LANGUAGE_ID) register();\n",
  });
  cases.push({ name: 'M2 monaco 语言id分支 ⇒ 红', want: 1, got: m2.code, out: m2.out });
  // 4) M3 旧 token
  const m3 = await run({ 'packages/app/src/selftest-m3.ts': "export const T = 'sugar.section.body';\n" });
  cases.push({ name: 'M3 旧 token 名 ⇒ 红', want: 1, got: m3.code, out: m3.out });

  await fs.rm(tmp, { recursive: true, force: true });

  console.log('=== audit-language --selftest（负例自证）===');
  let allOk = true;
  for (const c of cases) {
    const ok = c.got === c.want && (c.want === 0 || c.out.includes('❌'));
    if (!ok) allOk = false;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}（期望 rc=${c.want}，实得 rc=${c.got}）`);
    if (!ok) console.log(c.out);
  }
  console.log(allOk ? '自证通过：三族违规都会红，豁免与合法落点不红。' : '自证失败：闸不可信，别交付。');
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
console.log(red ? '❌ 语言面审计：存在超出基线的新增命中。' : '✅ 语言面审计：三类检查均未超出基线。');
process.exit(red ? 1 : 0);
