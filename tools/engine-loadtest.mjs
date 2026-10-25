// 整游戏加载实测自动化：硬链接镜像 + --CliDebug 双跑（A 基线 / B 换入）增量警告对拍。
// 用法: node tools/engine-loadtest.mjs [选项]
//   --map <artifact>=<语料相对路径>   可重复。artifact = 已转译 .ERB 或 .kojo（.kojo 走 clidbg-run 同款
//                                     vitest 内联转译；产物落**仓库外**沙盒 C:/tmp/kojo-generated-erb，
//                                     KOJO_GENERATED_DIR 可覆盖；落点在语料/游戏根之下 = 直接 FAIL，见 tools/generated-output.cjs）；
//                                     target = 镜像根下的相对路径（真副本覆盖硬链接）。
//                                     不给 --map 则纯基线双跑（A/B 同镜像状态，验证警告集可复现）。
//   --strip-color-dupes              换入前剥掉 artifact 里目标原文件没有定义的 @*COLOR* 函数块
//                                     （防 已经被定义过 类撞名新增警告；剥除动作逐文件打印）。
//   --corpus DIR                     默认按内容自动发现语料（认内容不认名，见 tools/corpus.mjs）；
//                                     优先级 --corpus > KOJO_CORPUS_DIR > 扫 C:/game/* 筛 ERB/+CSV/（全程只读）。
//   --engine EXE                     默认 KOJO_CLIDBG_EXE || KOJO_CLIDBG_DIR/Emuera_skiaV16_x64.exe（两者都缺 = 用法错误）。
//   --workdir DIR                    默认 %TEMP%/kojo-loadtest-mirror；跑完删除（--keep 保留）。
//   --timeout SEC                    单跑 watchdog，默认 240。
//   --keep                           保留镜像目录。
//   --list-warnings                  跑完后打印基线 A 的全部警告行（归一化去重后逐条，含 文件:第N行 定位；
//                                     兼容选项 EXECUTE ERROR LINES:NO 时解释不成立的行即以 Lv2 警告形态出现，
//                                     fatal「无法解释的行」本身不带定位，靠本开关捞取）+ fatal 上下文行。
//   --no-title                       跳过 title 流程实测相位（省 ~30s；默认执行）。
// 判定: 两次跑均见「ファイル読み込みが完了しました」 + W(B)−W(A)=∅（警告行= 警告Lv1/Lv2 前缀或含
//   已经被定义过/解釈不可能；归一化剥 elapsed 数字） + 语料完整性抽查（3 个随机 ERB 前后哈希 + 全根级
//   文件 stat 对拍）不变 + title 流程真走到菜单（见下）。
// title 流程（V3 定论 = 可绕）：语料出厂 emuera.config 的 EXECUTE ERROR LINES:NO 会让 beginTitle() 在进
//   @SYSTEM_TITLE 之前就用无定位 fatal 终止（Process.SystemProc.cs:201）；镜像内把该开关置 YES（语料零改动）
//   后 title→菜单 实测可达，TITLE.ERB:21 `SAVEGLOBAL` 亦成功落盘。菜单行没出现 = 本工具直接判 FAIL 并打印
//   [天花板] 定位与出处，不留空跑绿。
// 镜像 hazard 防线（口径 = 不靠名单猜，靠位置判）：
//   根级一级文件（profile / setting.json / emuera.config / *.log / lazyloading.* 等引擎 cwd 就地改写物）
//   一律真副本；子目录默认硬链接，仅 RW_DIRS（存档 / 调试输出类）整树真副本；--map 换入目标真副本。
//   建完镜像跑 inode 自检：必真副本的文件若仍与语料同 inode = 直接 FAIL 并点名（防后人往名单里加漏项）。
//   语料本体防护 = 事后 3 个随机 ERB 哈希对拍 + 全根级文件 stat（ino/nlink/size/mtime）对拍（硬护栏，必跑）。
// 退出码: 0=PASS 1=FAIL（缺 exe/语料/参数错 = 2）。
'use strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveCorpusDir, discoverCorpora, corpusHint } from './corpus.mjs';
import gen from './generated-output.cjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE_NAME = 'Emuera_skiaV16_x64.exe';
const LOAD_DONE_RE = /ファイル読み込みが完了しました。経過時間：([\d.]+)秒/;
// 语料目录不设默认名（认内容不认名）：见 tools/corpus.mjs 与下面的 resolveCorpusDir 调用。
const DEFAULT_ENGINE = process.env.KOJO_CLIDBG_EXE
  || (process.env.KOJO_CLIDBG_DIR ? path.join(process.env.KOJO_CLIDBG_DIR, EXE_NAME) : undefined);
const DEFAULT_WORKDIR = path.join(os.tmpdir(), 'kojo-loadtest-mirror');
// 引擎在 cwd 就地改写的对象。根级一级文件不设名单、全量真副本（profile 是「文件」而非目录，
// 任何按目录前缀 / 具体文件名的猜法都漏过它——上一会话就这样把语料盘上的 profile 就地改写了）。
// 子目录默认硬链接（16k 文件的性能命脉），只有下列可写子树走真副本；名字匹配大小写不敏感。
const RW_DIRS = new Set(['sav', 'profile', 'debug', 'logs', 'log', 'backup', 'tmp', 'temp']);
function mustRealCopy(rel) {
  const segs = rel.split('/');
  if (segs.length === 1) return true;                                  // 根级文件：一律真副本
  return segs.slice(0, -1).some((s) => RW_DIRS.has(s.toLowerCase()));  // 可写子树：真副本
}

const fail = (msg) => { console.error('[FAIL] ' + msg); process.exit(1); };
const usageErr = (msg) => { console.error('[用法] ' + msg); process.exit(2); };

// ── 参数解析 ──
const argv = process.argv.slice(2);
const opts = { maps: [], keep: false, stripColorDupes: false, listWarnings: false, noTitle: false, corpus: undefined, engine: DEFAULT_ENGINE, workdir: DEFAULT_WORKDIR, timeoutSec: 240 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep') opts.keep = true;
  else if (a === '--strip-color-dupes') opts.stripColorDupes = true;
  else if (a === '--list-warnings') opts.listWarnings = true;
  else if (a === '--no-title') opts.noTitle = true;
  else if (a === '--map') { const v = argv[++i]; v === undefined ? usageErr('--map 需要 <artifact>=<相对路径>') : opts.maps.push(v); }
  else if (a.startsWith('--map=')) opts.maps.push(a.slice(6));
  else if (a === '--corpus') opts.corpus = argv[++i];
  else if (a === '--engine') opts.engine = argv[++i];
  else if (a === '--workdir') opts.workdir = argv[++i];
  else if (a === '--timeout') opts.timeoutSec = Number(argv[++i]);
  else usageErr('未知选项: ' + a);
}
// 语料目录：--corpus > KOJO_CORPUS_DIR > 扫盘按内容发现（env 设了但不成立 = 硬失败，绝不静默换版本）。
try {
  opts.corpus = resolveCorpusDir({ explicit: opts.corpus, label: 'loadtest' });
} catch (e) {
  usageErr(e.message);
}
if (!opts.corpus) usageErr(`未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）；${corpusHint()}`);
opts.corpus = path.resolve(opts.corpus);
if (!opts.engine) usageErr('引擎 exe 未指定：--engine 或环境变量 KOJO_CLIDBG_EXE / KOJO_CLIDBG_DIR');
opts.engine = path.resolve(opts.engine);
opts.workdir = path.resolve(opts.workdir);
const maps = opts.maps.map((m) => {
  const eq = m.indexOf('=');
  if (eq <= 0) usageErr('--map 需要 <artifact>=<相对路径>，得到: ' + m);
  return { artifact: path.resolve(m.slice(0, eq)), target: m.slice(eq + 1) };
});
if (!fs.existsSync(opts.engine)) usageErr('引擎 exe 不存在: ' + opts.engine);
if (opts.workdir === opts.corpus || opts.workdir.startsWith(opts.corpus + path.sep)) usageErr('镜像目录不能落在语料内: ' + opts.workdir);
if (opts.corpus.startsWith(opts.workdir + path.sep)) usageErr('语料不能在镜像目录内: ' + opts.corpus);

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

// ── 语料枚举 / 完整性抽查 ──
function walkFiles(root, rel = '', acc = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink()) { acc.push({ rel: r, symlink: true }); continue; }
    if (st.isDirectory()) walkFiles(root, r, acc);
    else if (st.isFile()) acc.push({ rel: r });
  }
  return acc;
}
const corpusFiles = walkFiles(opts.corpus);
const erbRels = corpusFiles.filter((f) => /^ERB\/.*\.erb$/i.test(f.rel)).map((f) => f.rel);
if (erbRels.length < 3) fail('ERB 文件不足 3 个，无法做完整性抽查: ' + opts.corpus);
const pick3 = (() => {
  const idx = new Set();
  while (idx.size < 3) idx.add(crypto.randomInt(erbRels.length));
  return [...idx].sort((a, b) => a - b).map((i) => erbRels[i]);
})();
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const integrityBefore = pick3.map((r) => ({ rel: r, hash: sha(path.join(opts.corpus, r)) }));
// 根级文件全量 stat 快照（引擎 cwd 就地改写物；profile / setting.json / global.sav / *.log / lazyloading.*）：跑完对拍 ino/size/mtime。
// 注意判「根级」只能用 rel 里没有 '/'——path.dirname('profile') 在 win32 返回 '.' 而非 ''，
// 旧代码 !path.dirname(rel) 恒假，正是「根文件强制真副本」名单形同虚设、profile 被硬链进镜像的根因。
const rootStat = (rel) => { const s = fs.statSync(path.join(opts.corpus, rel)); return { ino: s.ino, dev: s.dev, nlink: s.nlink, size: s.size, mtimeMs: Math.round(s.mtimeMs) }; };
const rootFiles = corpusFiles.filter((f) => !f.symlink && f.rel.indexOf('/') < 0).map((f) => f.rel);
const rootBefore = new Map(rootFiles.map((r) => [r, rootStat(r)]));

// ── 镜像构建（硬链接为性能命脉；强制真副本口径见 mustRealCopy / RW_DIRS） ──
function clearReadOnly(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) clearReadOnly(p);
    else { try { fs.chmodSync(p, 0o666); } catch { /* 尽力而为 */ } }
  }
}
function rmMirror() {
  if (!fs.existsSync(opts.workdir)) return;
  clearReadOnly(opts.workdir);
  fs.rmSync(opts.workdir, { recursive: true, force: true });
}
function buildMirror(label) {
  rmMirror();
  const t0 = Date.now();
  fs.mkdirSync(opts.workdir, { recursive: true });
  let links = 0, copies = 0;
  for (const { rel, symlink } of corpusFiles) {
    const src = path.join(opts.corpus, rel);
    const dst = path.join(opts.workdir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const force = mustRealCopy(rel);
    if (symlink || force) { fs.copyFileSync(src, dst); copies++; }
    else {
      try { fs.linkSync(src, dst); links++; }
      catch { fs.copyFileSync(src, dst); copies++; } // 跨卷 / 0 字节等 link 失败 → 退化为真副本
    }
  }
  fs.copyFileSync(opts.engine, path.join(opts.workdir, path.basename(opts.engine)));
  copies++;
  assertRealCopies(label);
  const ms = Date.now() - t0;
  console.log(`[${label}] 镜像构建 ${fmt(ms)}：硬链接 ${links} + 真副本 ${copies}（workdir=${opts.workdir}）`);
  return ms;
}

// 自检：必真副本的每个文件都得跟语料断了链（ino 不同）；同 ino = 引擎就地改写会溅射语料盘 → 立即失败。
function assertRealCopies(label) {
  const offenders = [];
  let checked = 0;
  for (const { rel, symlink } of corpusFiles) {
    if (symlink || !mustRealCopy(rel)) continue;
    checked++;
    const src = path.join(opts.corpus, rel);
    const dst = path.join(opts.workdir, ...rel.split('/'));
    if (!fs.existsSync(dst)) continue; // 理论不会发生（上面刚建），防御式跳过而非崩
    const a = fs.statSync(src);
    const b = fs.statSync(dst);
    if (a.dev === b.dev && a.ino === b.ino) offenders.push(`${rel} (ino=${b.ino} nlink=${b.nlink})`);
  }
  if (offenders.length) {
    fail(`镜像自检失败（${label}）：${checked} 个「必须真副本」文件里有 ${offenders.length} 个仍与语料同 inode，`
      + `引擎退出时的就地重写会直接落在语料盘上 → ${offenders.join(', ')}。`
      + `\n  修法：根级一级文件由 mustRealCopy 自动全量覆盖；子目录请补进 RW_DIRS（不要再用具体文件名名单）。`);
  }
  console.log(`[${label}] 真副本自检 OK：${checked} 个必副本文件全部与语料断链`);
}

// ── 引擎驱动（--CliDebug JSON Lines；加载完成前逐个 wait 推 input，完成/终结提示后 quit） ──
// warm 模式 = 预热跑：冷镜像缺 lazyloading.bin 表，引擎会全量重建且不打出加载完成行；
// 预热把表建好（并吃掉首个 fatal 提示），随后的实测跑才能复现「ファイル読み込みが完了」。
const FINISH_PROMPT_RE = /按回车键或者点击鼠标左键结束程序/;
// title 模式（V3）：加载完成后不退出，逐个 wait 推 input，直到 title 菜单行出现（或 8 次 wait 用尽）。
const TITLE_MENU_RE = /\[\d+\][ \t]*开始游戏/;
const TITLE_RESUME_RE = /继续游戏/;
const TITLE_FATAL_RE = /无法解释|停止运行|错误发生在|错误内容/;
function runEngine(label, { measure = true, mode = 'load' } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const exe = path.join(opts.workdir, path.basename(opts.engine));
    const p = spawn(exe, ['--CliDebug'], { cwd: opts.workdir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = [];
    let id = 0, loadDone = false, loadReportedSec = null, loadWallMs = null, quitSent = false, dialogCount = 0, waitCount = 0, timedOut = false, titleWaits = 0;
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 引擎已退出 */ } };
    const quitOnce = () => { if (!quitSent) { quitSent = true; send({ cmd: 'quit', id: ++id }); } };
    const rl = createInterface({ input: p.stdout });
    rl.on('line', (raw) => {
      let ev; try { ev = JSON.parse(raw); } catch { return; }
      if (ev.type === 'out') {
        const text = ev.text ?? '';
        lines.push(text);
        const m = LOAD_DONE_RE.exec(text);
        if (m && !loadDone) {
          loadDone = true;
          loadReportedSec = parseFloat(m[1]);
          loadWallMs = Date.now() - t0;
          // 留 1.5s 收完尾随 out 行（首 wait 到达前的兜底）；title 模式要继续走菜单，不在此收工
          if (mode !== 'title') setTimeout(quitOnce, 1500);
        }
        if (!loadDone && FINISH_PROMPT_RE.test(text)) {
          // fatal 终结提示先于加载完成（预热没生效/语料异常）：warm 收尾继续；实测跑直接收工报错
          if (!measure) setTimeout(quitOnce, 800);
          else quitOnce();
        }
      } else if (ev.type === 'wait') {
        waitCount++;
        if (!loadDone) send({ cmd: 'input', id: ++id, text: '' });
        else if (mode === 'title') {
          titleWaits++;
          if (lines.some((l) => TITLE_MENU_RE.test(l)) || titleWaits >= 8) quitOnce();
          else send({ cmd: 'input', id: ++id, text: '' });
        } else quitOnce(); // 加载完成后的第一个 wait = 收工信号（不进菜单）
      } else if (ev.type === 'dialog') dialogCount++;
    });
    const fallback = measure ? null : setTimeout(() => { send({ cmd: 'input', id: ++id, text: '' }); quitOnce(); }, 120000); // warm 兜底：120s 后强制推进并退出
    const killer = setTimeout(() => { timedOut = true; try { p.kill(); } catch { /* noop */ } }, opts.timeoutSec * 1000);
    p.on('exit', () => {
      clearTimeout(killer);
      if (fallback) clearTimeout(fallback);
      rl.close();
      resolve({ lines, loadDone, loadReportedSec, loadWallMs, dialogCount, waitCount, timedOut, wallMs: Date.now() - t0 });
    });
    p.on('error', (e) => { clearTimeout(killer); if (fallback) clearTimeout(fallback); console.error(`[${label}] 引擎启动失败: ${e.message}`); resolve({ lines, loadDone: false, timedOut: true, wallMs: Date.now() - t0, dialogCount: 0, waitCount: 0 }); });
  });
}

// ── 警告集（多重集：归一化 = 剥 elapsed 数字，保留 文件:行 + 文本） ──
const isWarn = (t) => /^警告Lv[12]:/.test(t) || t.includes('已经被定义过') || t.includes('解釈不可能');
const normWarn = (t) => t.replace(/経過時間[：:]\s*\d+(?:\.\d+)?秒/g, '経過時間：N秒');
function warningSet(lines) {
  const m = new Map();
  for (const l of lines) {
    if (!isWarn(l)) continue;
    const k = normWarn(l);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
const multisetSize = (m) => [...m.values()].reduce((a, b) => a + b, 0);
function deltaW(B, A) {
  const d = [];
  for (const [k, c] of B) {
    const extra = c - (A.get(k) || 0);
    for (let i = 0; i < extra; i++) d.push(k);
  }
  return d;
}

// ── .kojo 转译（clidbg-run.cjs 步骤 1 同款内联 vitest 技巧） ──
// 产物落点 = 仓库外固定沙盒（tools/generated-output.cjs），**不再写输入文件旁边**：
// 传进来的 .kojo 可能位于语料/游戏目录（--map 的 artifact 由用户指），旧写法会把转译产物
// 直接写进语料盘——绕过内核 io 写允许域、违反铁律 5。写盘前先过门禁，命中即 fail 退出（不静默改路径）。
let gameRootsCache = null;
/** 受保护根 = 本次镜像的语料 + 盘上全部符合内容条件的语料候选（认内容不认名；只算一次，纯 readdir/stat）。 */
function gameRoots() {
  if (!gameRootsCache) {
    const all = [opts.corpus, ...discoverCorpora().map((h) => h.dir)]
      .map((p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, ''));
    gameRootsCache = [...new Set(all)];
  }
  return gameRootsCache;
}
function transpileKojo(kojoPath) {
  const tmpTest = path.join(REPO, 'packages/plugins/kojo-sugar/tests/__tmp.loadtest-transpile.test.ts');
  const derived = gen.deriveGeneratedPaths(kojoPath);
  const outFile = derived.erbPath;
  try {
    gen.assertOutsideRoots(outFile, gameRoots(), { label: 'loadtest 产物' });
  } catch (e) {
    fail(e.message);
  }
  fs.writeFileSync(tmpTest, [
    "import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';",
    "import { expect, it } from 'vitest';",
    "import { createSugarTranspileService } from '../src/service';",
    "import { stubDict, stubFaceTable } from './support';",
    "it('transpile for loadtest', () => {",
    `  const src = readFileSync(${JSON.stringify(kojoPath)}, 'utf8').replace(/^\\uFEFF/, '')`,
    "    .split('\\n').filter((l) => !l.startsWith('//')).join('\\n');",
    "  const r = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);",
    "  const errs = r.diagnostics.filter(d => d.severity === 'error');",
    "  expect(errs, JSON.stringify(errs)).toEqual([]);",
    `  mkdirSync(${JSON.stringify(derived.root)}, { recursive: true });`,
    `  writeFileSync(${JSON.stringify(outFile)}, '\\uFEFF' + r.erb.replace(/\\n/g, '\\r\\n'), 'utf8');`,
    '});',
    '',
  ].join('\n'));
  const t = spawnSync('pnpm', ['vitest', 'run', tmpTest.replace(/\\/g, '/')], { cwd: REPO, encoding: 'utf8', shell: true });
  fs.rmSync(tmpTest, { force: true });
  if (t.status !== 0) fail('.kojo 转译失败（' + kojoPath + '）:\n' + (t.stdout || '') + (t.stderr || ''));
  console.log('[transpile] ' + path.basename(kojoPath) + ' → ' + outFile + '（仓库外落点）');
  return outFile;
}

// ── COLOR 撞名剥除：artifact 定义了而目标原文件没定义的 @*COLOR* 函数块 ──
function stripColorDupesBlock(payloadText, originalText) {
  const eol = /\r\n/.test(payloadText) ? '\r\n' : '\n';
  const lines = payloadText.split(/\r\n|\n/);
  const origLines = originalText.split(/\r\n|\n/);
  const origDefines = (name) => origLines.some((l) => l === '@' + name || l.startsWith('@' + name + '('));
  const out = [];
  const removed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^@([A-Za-z0-9_]*COLOR[A-Za-z0-9_]*)(?:\([^\s)]*\))?$/.exec(lines[i]);
    if (m && !origDefines(m[1])) {
      removed.push(m[1]);
      let j = i + 1;
      while (j < lines.length && !/^@/.test(lines[j])) j++; // 块 = 头行起，到下个头行（或 EOF）止
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return { text: out.join(eol), removed };
}

// ── title 流程实测（V3 定论：可绕，绕行法 = 镜像里把兼容性开关 EXECUTE ERROR LINES 置 YES）──
// 依据（SKIA 源码 develop-skiasharp）：
//   Runtime/Script/Process.SystemProc.cs:201 beginTitle() —— 「有行解释不了」(!noError) 且
//   CompatiErrorLine=false（即 emuera.config `EXECUTE ERROR LINES:NO`，eraTW 4.980 出厂值）时，
//   引擎在进 @SYSTEM_TITLE **之前**就打印无定位的「由于ERB脚本出现无法解释的行」并终止；
//   语料里解释不了的行 = DLC\ATTACK_SANATCH_FOOD_CHARA.ERB:51/53/55（`out` 撞 v24 保留字，基线 3 条 Lv2 警告）。
//   Runtime/Script/Statements/Variable/VariableEvaluator.cs:2842 SaveGlobal() —— 写 SavDir+global.sav 时
//   catch(SystemException) 一律换成「保存全局数据时发生错误」= TITLE.ERB:21 那条定位错的出处（落盘失败类，
//   非语料语义问题：镜像里 sav/ 走真副本后同一条 SAVEGLOBAL 成功落盘，fatal 不再出现）。
// 因此本相位只在**镜像内**改 emuera.config（根级文件=真副本，语料零改动），置 YES 后真走 title→菜单。
function patchMirrorConfigForTitle() {
  const dst = path.join(opts.workdir, 'emuera.config');
  const src = path.join(opts.corpus, 'emuera.config');
  if (!fs.existsSync(dst)) fail('title 相位缺镜像 emuera.config: ' + dst);
  if (fs.existsSync(src)) {
    const a = fs.statSync(src), b = fs.statSync(dst);
    if (a.dev === b.dev && a.ino === b.ino) fail('镜像 emuera.config 仍与语料同 inode（真副本自检漏网），拒绝改兼容性开关以免溅射语料盘: ' + src);
  }
  const text = fs.readFileSync(dst, 'utf8');
  const re = /^([ \t]*EXECUTE ERROR LINES[ \t]*:[ \t]*)(\w+)[ \t]*$/im;
  const hit = re.exec(text);
  if (!hit) {
    fs.writeFileSync(dst, text.replace(/\r?\n$/, '') + '\r\nEXECUTE ERROR LINES:YES\r\n');
    return 'EXECUTE ERROR LINES:YES（原行缺失，追加）';
  }
  if (hit[2].toUpperCase() === 'YES') return 'EXECUTE ERROR LINES:YES（语料本就是 YES，无需改）';
  fs.writeFileSync(dst, text.slice(0, hit.index) + hit[1] + 'YES' + text.slice(hit.index + hit[0].length));
  return `EXECUTE ERROR LINES:${hit[2]}→YES（仅镜像）`;
}

async function titleFlowPhase() {
  const patched = patchMirrorConfigForTitle();
  console.log(`[title] 兼容性开关: ${patched}`);
  const run = await runEngine('TITLE', { measure: true, mode: 'title' });
  const menuLine = run.lines.find((l) => TITLE_MENU_RE.test(l));
  const resumeLine = run.lines.find((l) => TITLE_RESUME_RE.test(l));
  const fatals = run.lines.filter((l) => TITLE_FATAL_RE.test(l));
  const reached = !!run.loadDone && !!menuLine && fatals.length === 0;
  console.log(`[title] ${reached ? 'PASS' : 'FAIL'}：加载完成=${run.loadDone} 菜单行=${menuLine ? JSON.stringify(menuLine.slice(0, 40)) : '无'} 继续游戏项=${resumeLine ? '有' : '无'} fatal行=${fatals.length} waits=${run.waitCount} 用时=${fmt(run.wallMs)}`);
  for (const f of fatals) console.log('  [title-fatal] ' + f.slice(0, 160));
  if (!reached) {
    console.log('  [天花板] 加载实测到 title 流程在 SKIA 引擎上不可达：定位 = TITLE.ERB:21 `SAVEGLOBAL`（VariableEvaluator.cs:2877 catch(SystemException)→「保存全局数据时发生错误」）'
      + '；另一阻塞点 = beginTitle()（Process.SystemProc.cs:201）在 EXECUTE ERROR LINES:NO 下不进 @SYSTEM_TITLE。');
    console.log('  [天花板] 本镜像已置 EXECUTE ERROR LINES:YES 仍不可达 ⇒ 不是兼容性开关问题，需按上面的 fatal 行逐条排查（勿当成绿）。');
  }
  return { reached, menuLine: menuLine || null, fatals, wallMs: run.wallMs };
}

// ── 主流程 ──
const timings = [];
const tAll = Date.now();

const buildA = buildMirror('A');
timings.push(['镜像 A 构建', buildA]);
const warmA = await runEngine('A-warm', { measure: false });
timings.push(['预热 A（建懒加载表）', warmA.wallMs]);
console.log(`[A-warm] ${fmt(warmA.wallMs)}（loadDone=${warmA.loadDone}，忽略结果，仅生成 lazyloading 表）`);
const runA = await runEngine('A');
timings.push(['跑 A（基线）', runA.wallMs]);
if (!runA.loadDone) fail(`跑 A 未见加载完成行（timedOut=${runA.timedOut}, waits=${runA.waitCount}, dialogs=${runA.dialogCount}）；输出尾部: ${runA.lines.slice(-5).join(' | ')}`);
const W0 = warningSet(runA.lines);
console.log(`[A] 加载完成：引擎报 ${runA.loadReportedSec}s / 实测 ${fmt(runA.loadWallMs)}（跑至退出 ${fmt(runA.wallMs)}）；警告 ${multisetSize(W0)} 条（去重 ${W0.size}），waits=${runA.waitCount}, dialogs=${runA.dialogCount}`);
if (opts.listWarnings) {
  for (const [k, c] of W0) console.log(`[warn×${c}] ${k}`);
  for (const l of runA.lines) if (/无法解释|停止运行|解釈不可能/.test(l)) console.log('[fatal上下文] ' + l);
}

// 跑 B 前重建镜像：保证 B 与 A 的差 = 换入产物本身（引擎残留归零）
const buildB = buildMirror('B');
timings.push(['镜像 B 构建', buildB]);
for (const { artifact, target } of maps) {
  if (!fs.existsSync(artifact)) fail('换入产物不存在: ' + artifact);
  const payloadPath = /\.kojo$/i.test(artifact) ? transpileKojo(artifact) : artifact;
  const rel = target.replaceAll('\\', '/').replace(/^\/+/, '');
  const dst = path.resolve(opts.workdir, ...rel.split('/'));
  if (dst !== opts.workdir && !dst.startsWith(opts.workdir + path.sep)) fail('--map 目标越出镜像目录: ' + target);
  const origInCorpus = path.join(opts.corpus, ...rel.split('/'));
  let buf = fs.readFileSync(payloadPath);
  if (opts.stripColorDupes) {
    const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const text = (bom ? buf.subarray(3) : buf).toString('utf8');
    const original = fs.existsSync(origInCorpus) ? fs.readFileSync(origInCorpus).toString('utf8') : '';
    const { text: stripped, removed } = stripColorDupesBlock(text, original);
    if (removed.length) console.log(`[swap] ${rel}: 剥除撞名 COLOR 块 ${removed.join(', ')}`);
    buf = Buffer.concat([bom ? Buffer.from([0xEF, 0xBB, 0xBF]) : Buffer.alloc(0), Buffer.from(stripped, 'utf8')]);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.rmSync(dst, { force: true }); // 断硬链接——原语料内容不受影响
  fs.writeFileSync(dst, buf);      // 真副本，引擎就地写不溅射语料
  console.log(`[swap] ${path.basename(payloadPath)} → ${rel}`);
}
const warmB = await runEngine('B-warm', { measure: false });
timings.push(['预热 B（建懒加载表）', warmB.wallMs]);
console.log(`[B-warm] ${fmt(warmB.wallMs)}（loadDone=${warmB.loadDone}，忽略结果，仅重建 lazyloading 表以覆盖换入文件）`);
const runB = await runEngine('B');
timings.push(['跑 B（换入）', runB.wallMs]);
if (!runB.loadDone) fail(`跑 B 未见加载完成行（timedOut=${runB.timedOut}, waits=${runB.waitCount}）；输出尾部: ${runB.lines.slice(-5).join(' | ')}`);
const W1 = warningSet(runB.lines);
console.log(`[B] 加载完成：引擎报 ${runB.loadReportedSec}s / 实测 ${fmt(runB.loadWallMs)}（跑至退出 ${fmt(runB.wallMs)}）；警告 ${multisetSize(W1)} 条（去重 ${W1.size}），waits=${runB.waitCount}, dialogs=${runB.dialogCount}`);

// 语料完整性抽查（强制护栏）—— 先跑 title 相位（引擎会就地重写镜像内 profile/sav/global.sav，
// 真副本自检已保证这些不是硬链，抽查必须在 title 之后才有意义）
let title = { skipped: true, reached: true };
if (!opts.noTitle) {
  title = await titleFlowPhase();
  timings.push(['title 流程', title.wallMs]);
} else console.log('[title] 跳过（--no-title）');

let corrupted = [];
for (const s of integrityBefore) {
  const now = sha(path.join(opts.corpus, s.rel));
  console.log(`[integrity] ${s.rel}: ${now === s.hash ? 'OK 未变' : 'CHANGED ' + s.hash + ' → ' + now}`);
  if (now !== s.hash) corrupted.push(s.rel);
}
// 根级文件 stat 对拍（profile / setting.json / emuera.config / lazyloading.* 等）
let rootLeak = [];
for (const [rel, before] of rootBefore) {
  const now = rootStat(rel);
  const rewritten = now.ino !== before.ino || now.size !== before.size || now.mtimeMs !== before.mtimeMs;
  if (rewritten) rootLeak.push(rel);
  console.log(`[integrity:root] ${rel}: ${rewritten ? `CHANGED ino ${before.ino}→${now.ino} size ${before.size}→${now.size} mtime ${new Date(before.mtimeMs).toISOString()}→${new Date(now.mtimeMs).toISOString()}` : `OK 未变（nlink ${now.nlink}${now.nlink !== before.nlink ? ' ⚠外部又建了硬链' : ''}）`}`);
}

const delta = deltaW(W1, W0);
const vanished = [...W0.keys()].filter((k) => !W1.has(k));
console.log(`[delta] W(B)−W(A) 新增 ${delta.length} 条${vanished.length ? `；消失 ${vanished.length} 条（不判负，仅提示）` : ''}`);
for (const w of delta) console.log('  [新警告] ' + w);

if (!opts.keep) rmMirror();
console.log(`[mirror] ${opts.keep ? '保留 ' + opts.workdir + '（--keep）' : '已删除镜像'}`);

console.log('\n timings:');
for (const [name, ms] of timings) console.log(`  ${name.padEnd(12, ' ')} ${fmt(ms)}`);
console.log(`  ${'总计'.padEnd(11, ' ')} ${fmt(Date.now() - tAll)}`);

const reasons = [];
if (corrupted.length) reasons.push('语料被改写（硬链接事故）: ' + corrupted.join(', '));
if (rootLeak.length) reasons.push('语料根级文件被就地改写（硬链接泄漏）: ' + rootLeak.join(', '));
if (delta.length) reasons.push(`新增警告 ${delta.length} 条（见上）`);
if (!title.skipped && !title.reached) reasons.push('title 流程未走到菜单（详见 [title] / [天花板] 行）');
if (reasons.length) fail('加载实测 FAIL：\n  ' + reasons.join('\n  '));
console.log(`\nPASS  双跑加载完成（A ${runA.loadReportedSec}s / B ${runB.loadReportedSec}s），无新增警告，语料抽查 ${integrityBefore.length}/3 ERB 哈希未变 + ${rootBefore.size} 个根级文件 stat 未变，title 流程 ${title.skipped ? '跳过' : '到菜单（' + JSON.stringify(String(title.menuLine).slice(0, 24)) + '）'}。`);
process.exit(0);
