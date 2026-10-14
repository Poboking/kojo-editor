// 整游戏加载实测自动化：硬链接镜像 + --CliDebug 双跑（A 基线 / B 换入）增量警告对拍。
// 用法: node tools/engine-loadtest.mjs [选项]
//   --map <artifact>=<语料相对路径>   可重复。artifact = 已转译 .ERB 或 .kojo（.kojo 走 clidbg-run 同款
//                                     vitest 内联转译）；target = 镜像根下的相对路径（真副本覆盖硬链接）。
//                                     不给 --map 则纯基线双跑（A/B 同镜像状态，验证警告集可复现）。
//   --strip-color-dupes              换入前剥掉 artifact 里目标原文件没有定义的 @*COLOR* 函数块
//                                     （防 已经被定义过 类撞名新增警告；剥除动作逐文件打印）。
//   --corpus DIR                     默认 KOJO_CORPUS_DIR || C:/game/eratw-sub-modding-eratw4.980（全程只读）。
//   --engine EXE                     默认 KOJO_CLIDBG_EXE || KOJO_CLIDBG_DIR/Emuera_skiaV16_x64.exe
//                                     || C:/DSH/vendor/clidbg-probe/Emuera_skiaV16_x64.exe。
//   --workdir DIR                    默认 %TEMP%/kojo-loadtest-mirror；跑完删除（--keep 保留）。
//   --timeout SEC                    单跑 watchdog，默认 240。
//   --keep                           保留镜像目录。
// 判定: 两次跑均见「ファイル読み込みが完了しました」 + W(B)−W(A)=∅（警告行= 警告Lv1/Lv2 前缀或含
//   已经被定义过/解釈不可能；归一化剥 elapsed 数字） + 语料完整性抽查（3 个随机 ERB 前后哈希）不变。
//   加载完成提示之后的 fatal（原版语料已知 title→menu 崩溃）一律忽略。
// 镜像 hazard 防线: 引擎可能就地改写的文件（setting.json/emuera.config/emuera.log/debug_log.log/sav/、profile/）
//   与 --map 换入目标一律断开硬链写真副本；语料本体防护 = 事后 3 文件哈希对拍（硬护栏，必跑；
//   attrib +R 递归在 2 万文件量级不划算，按规格走哈希抽查分支）。
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE_NAME = 'Emuera_skiaV16_x64.exe';
const LOAD_DONE_RE = /ファイル読み込みが完了しました。経過時間：([\d.]+)秒/;
const DEFAULT_CORPUS = process.env.KOJO_CORPUS_DIR || 'C:/game/eratw-sub-modding-eratw4.980';
const DEFAULT_ENGINE = process.env.KOJO_CLIDBG_EXE
  || path.join(process.env.KOJO_CLIDBG_DIR || 'C:/DSH/vendor/clidbg-probe', EXE_NAME);
const DEFAULT_WORKDIR = path.join(os.tmpdir(), 'kojo-loadtest-mirror');
// 引擎在 cwd 就地读写的根文件 + 目录（这些不进硬链接，直接真副本）
const FORCE_COPY_ROOT = new Set(['setting.json', 'emuera.config', 'emuera.log', 'debug_log.log', 'lazyloading.bin', 'lazyloading.dat', 'lazyloadingfiles.bin', 'lazyloadingfiles.dat']);
const FORCE_COPY_DIRS = ['sav/', 'profile/'];

const fail = (msg) => { console.error('[FAIL] ' + msg); process.exit(1); };
const usageErr = (msg) => { console.error('[用法] ' + msg); process.exit(2); };

// ── 参数解析 ──
const argv = process.argv.slice(2);
const opts = { maps: [], keep: false, stripColorDupes: false, corpus: DEFAULT_CORPUS, engine: DEFAULT_ENGINE, workdir: DEFAULT_WORKDIR, timeoutSec: 240 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep') opts.keep = true;
  else if (a === '--strip-color-dupes') opts.stripColorDupes = true;
  else if (a === '--map') { const v = argv[++i]; v === undefined ? usageErr('--map 需要 <artifact>=<相对路径>') : opts.maps.push(v); }
  else if (a.startsWith('--map=')) opts.maps.push(a.slice(6));
  else if (a === '--corpus') opts.corpus = argv[++i];
  else if (a === '--engine') opts.engine = argv[++i];
  else if (a === '--workdir') opts.workdir = argv[++i];
  else if (a === '--timeout') opts.timeoutSec = Number(argv[++i]);
  else usageErr('未知选项: ' + a);
}
opts.corpus = path.resolve(opts.corpus);
opts.engine = path.resolve(opts.engine);
opts.workdir = path.resolve(opts.workdir);
const maps = opts.maps.map((m) => {
  const eq = m.indexOf('=');
  if (eq <= 0) usageErr('--map 需要 <artifact>=<相对路径>，得到: ' + m);
  return { artifact: path.resolve(m.slice(0, eq)), target: m.slice(eq + 1) };
});
if (!fs.existsSync(opts.corpus)) usageErr('语料目录不存在: ' + opts.corpus);
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

// ── 镜像构建（硬链接；强制真副本名单见 FORCE_COPY_*） ──
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
    const force = !path.dirname(rel) && FORCE_COPY_ROOT.has(path.basename(rel))
      || FORCE_COPY_DIRS.some((d) => rel.startsWith(d));
    if (symlink || force) { fs.copyFileSync(src, dst); copies++; }
    else {
      try { fs.linkSync(src, dst); links++; }
      catch { fs.copyFileSync(src, dst); copies++; } // 跨卷 / 0 字节等 link 失败 → 退化为真副本
    }
  }
  fs.copyFileSync(opts.engine, path.join(opts.workdir, path.basename(opts.engine)));
  copies++;
  const ms = Date.now() - t0;
  console.log(`[${label}] 镜像构建 ${fmt(ms)}：硬链接 ${links} + 真副本 ${copies}（workdir=${opts.workdir}）`);
  return ms;
}

// ── 引擎驱动（--CliDebug JSON Lines；加载完成前逐个 wait 推 input，完成/终结提示后 quit） ──
// warm 模式 = 预热跑：冷镜像缺 lazyloading.bin 表，引擎会全量重建且不打出加载完成行；
// 预热把表建好（并吃掉首个 fatal 提示），随后的实测跑才能复现「ファイル読み込みが完了」。
const FINISH_PROMPT_RE = /按回车键或者点击鼠标左键结束程序/;
function runEngine(label, { measure = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const exe = path.join(opts.workdir, path.basename(opts.engine));
    const p = spawn(exe, ['--CliDebug'], { cwd: opts.workdir, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let id = 0, loadDone = false, loadReportedSec = null, loadWallMs = null, quitSent = false, dialogCount = 0, waitCount = 0, timedOut = false;
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
          setTimeout(quitOnce, 1500); // 留 1.5s 收完尾随 out 行（首 wait 到达前的兜底）
        }
        if (!loadDone && FINISH_PROMPT_RE.test(text)) {
          // fatal 终结提示先于加载完成（预热没生效/语料异常）：warm 收尾继续；实测跑直接收工报错
          if (!measure) setTimeout(quitOnce, 800);
          else quitOnce();
        }
      } else if (ev.type === 'wait') {
        waitCount++;
        if (loadDone) quitOnce(); // 加载完成后的第一个 wait = 收工信号（不进菜单）
        else send({ cmd: 'input', id: ++id, text: '' });
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
function transpileKojo(kojoPath) {
  const tmpTest = path.join(REPO, 'packages/plugins/kojo-sugar/tests/__tmp.loadtest-transpile.test.ts');
  const outFile = kojoPath + '.generated.ERB';
  fs.writeFileSync(tmpTest, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { expect, it } from 'vitest';",
    "import { createSugarTranspileService } from '../src/service';",
    "import { stubDict, stubFaceTable } from './support';",
    "it('transpile for loadtest', () => {",
    `  const src = readFileSync(${JSON.stringify(kojoPath)}, 'utf8').replace(/^\\uFEFF/, '')`,
    "    .split('\\n').filter((l) => !l.startsWith('//')).join('\\n');",
    "  const r = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);",
    "  const errs = r.diagnostics.filter(d => d.severity === 'error');",
    "  expect(errs, JSON.stringify(errs)).toEqual([]);",
    `  writeFileSync(${JSON.stringify(outFile)}, '\\uFEFF' + r.erb.replace(/\\n/g, '\\r\\n'), 'utf8');`,
    '});',
    '',
  ].join('\n'));
  const t = spawnSync('pnpm', ['vitest', 'run', tmpTest.replace(/\\/g, '/')], { cwd: REPO, encoding: 'utf8', shell: true });
  fs.rmSync(tmpTest, { force: true });
  if (t.status !== 0) fail('.kojo 转译失败（' + kojoPath + '）:\n' + (t.stdout || '') + (t.stderr || ''));
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

// 语料完整性抽查（强制护栏）
let corrupted = [];
for (const s of integrityBefore) {
  const now = sha(path.join(opts.corpus, s.rel));
  console.log(`[integrity] ${s.rel}: ${now === s.hash ? 'OK 未变' : 'CHANGED ' + s.hash + ' → ' + now}`);
  if (now !== s.hash) corrupted.push(s.rel);
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
if (delta.length) reasons.push(`新增警告 ${delta.length} 条（见上）`);
if (reasons.length) fail('加载实测 FAIL：\n  ' + reasons.join('\n  '));
console.log(`\nPASS  双跑加载完成（A ${runA.loadReportedSec}s / B ${runB.loadReportedSec}s），无新增警告，语料抽查 ${integrityBefore.length}/3 未变。`);
process.exit(0);
