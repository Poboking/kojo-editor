// CliDebug -capable SKIA 引擎一键重建安装（看板 V4）：dotnet 检查 → clone/更新 → publish → 安装 → 冒烟。
// 用法: node tools/engine-setup.mjs [--dest DIR] [--fresh] [--exe-only]
//   --dest DIR     沙盒目录，默认 KOJO_CLIDBG_DIR || C:/DSH/vendor/clidbg-probe。
//                  只往里写 Emuera_skiaV16_x64.exe / ERB/ / CSV/，**绝不删除沙盒本体**。
//   --fresh        源码 clone 目录删除重克隆（只作用于源码目录，不碰沙盒）。
//   --exe-only     仍 clone+publish+装 exe，但跳过 CSV 布置（假定沙盒 CSV 已就绪）。
//   源码目录: KOJO_EMUERA_SRC || C:/DSH/vendor/emuera-skia；脏/分支不符时自动退化到 %TEMP% 全新克隆。
// 冒烟: 安装完后 spawn dest 内 exe --CliDebug，等 hello+ready 后 quit；hello 里的 version 打出来。
// 退出码: 0=成功 1=冒烟/其他失败 2=缺 dotnet SDK / 参数错。
// 铁律: **绝不自动安装 SDK**——缺 dotnet 只打印 `winget install Microsoft.DotNet.SDK.8` 提示后停。
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { resolveCorpusDir, corpusHint } from './corpus.mjs';

const SRC_URL = 'https://gitgud.io/minus010001/emuera_lazyloading_selfmodified_version';
const BRANCH = 'develop-skiasharp';
const PROXY = 'http://127.0.0.1:7890';
const EXE_NAME = 'Emuera_skiaV16_x64.exe';

// ── CLI 解析 ──
const argv = process.argv.slice(2);
let dest = process.env.KOJO_CLIDBG_DIR || 'C:/DSH/vendor/clidbg-probe';
let fresh = false;
let exeOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dest') dest = path.resolve(argv[++i] ?? die2('--dest 缺参数'));
  else if (a === '--fresh') fresh = true;
  else if (a === '--exe-only') exeOnly = true;
  else if (a === '-h' || a === '--help') { console.log('用法: node tools/engine-setup.mjs [--dest DIR] [--fresh] [--exe-only]'); process.exit(0); }
  else die2(`未知参数: ${a}`);
}
const SRC_DIR = process.env.KOJO_EMUERA_SRC || 'C:/DSH/vendor/emuera-skia';
const PUBLISH_OUT = path.join(os.tmpdir(), 'emuera-build');
// 语料 CSV 来源：只有沙盒缺 CSV 时才需要，故**惰性**解析（认内容不认名，见 tools/corpus.mjs）。
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

function die1(msg) { console.error('[FAIL] ' + msg); process.exit(1); }
function die2(msg) { console.error('[FAIL] ' + msg); process.exit(2); }

/** 语料 CSV 目录（KOJO_CORPUS_DIR 优先，其次按内容发现；env 设了但不成立 = 硬失败）。 */
function corpusCsvSource() {
  let dir;
  try {
    dir = resolveCorpusDir({ label: 'engine-setup' });
  } catch (e) {
    return { err: e.message };
  }
  if (!dir) return { err: `未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）；${corpusHint()}` };
  const csv = path.join(dir, 'CSV');
  return fs.existsSync(csv) ? { csv } : { err: `语料无 CSV/: ${csv}（KOJO_CORPUS_DIR 可覆盖）` };
}

// ── spawn 帮助：win32 走 shell:true（dotnet/git 是仓库惯例）；拼命令串免 DEP0190 ──
function q(a) { return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const command = [cmd, ...args.map(q)].join(' ');
    const p = spawn(command, {
      cwd: opts.cwd, env: process.env, shell: true,
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    if (opts.capture) {
      p.stdout.on('data', (d) => { out += d.toString('utf8'); });
      p.stderr.on('data', (d) => { out += d.toString('utf8'); });
    }
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
    p.on('error', () => resolve({ code: 1, out }));
  });
}
// git 网络操作：直连优先，失败退化到本地代理重试一次。
async function gitNet(args, opts = {}) {
  const r = await run('git', args, opts);
  if (r.code === 0) return r;
  console.log('  直连失败，经代理重试: git -c http.proxy=' + PROXY);
  return run('git', ['-c', `http.proxy=${PROXY}`, ...args], opts);
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ── [1/5] dotnet SDK 检查（绝不自动安装）──
console.log('[1/5] 检查 dotnet SDK…');
{
  const r = await run('dotnet', ['--version'], { capture: true });
  if (r.code !== 0) {
    console.error('[FAIL] 未检测到 dotnet SDK。请手动安装后重试：\n  winget install Microsoft.DotNet.SDK.8');
    process.exit(2);
  }
  console.log('  dotnet ' + r.out.trim().split(/\r?\n/).pop());
}

// ── [2/5] 源码 clone / 更新 ──
console.log('[2/5] 源码仓库（' + BRANCH + '）…');
let workDir = SRC_DIR;
{
  const isClone = fs.existsSync(path.join(SRC_DIR, '.git'));
  if (fresh && isClone) {
    console.log('  --fresh：删除源码目录重克隆 ' + SRC_DIR);
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(path.join(SRC_DIR, '.git'))) {
    const br = await run('git', ['-C', SRC_DIR, 'branch', '--show-current'], { capture: true });
    const st = await run('git', ['-C', SRC_DIR, 'status', '--porcelain'], { capture: true });
    const dirty = st.out.trim().length > 0;
    const branchOk = br.out.trim() === BRANCH;
    if (dirty || !branchOk) {
      workDir = path.join(os.tmpdir(), 'emuera-skia-setup-fresh');
      console.log(`  共享 clone ${dirty ? '有未提交改动' : '分支不符'}（→ 不动它，改用临时全新克隆: ${workDir}）`);
      fs.rmSync(workDir, { recursive: true, force: true });
      const c = await gitNet(['clone', '--branch', BRANCH, SRC_URL, workDir]);
      if (c.code !== 0) die1('clone 失败:\n' + c.out);
    } else {
      console.log('  已有干净 clone：fetch + 快进更新');
      const f = await gitNet(['-C', SRC_DIR, 'fetch', 'origin', BRANCH]);
      if (f.code !== 0) die1('fetch 失败:\n' + f.out);
      const co = await run('git', ['-C', SRC_DIR, 'checkout', BRANCH], { capture: true });
      if (co.code !== 0) die1('checkout 失败:\n' + co.out);
      const m = await run('git', ['-C', SRC_DIR, 'merge', '--ff-only', 'FETCH_HEAD'], { capture: true });
      if (m.code !== 0) die1('快进合并失败（本地分叉？）:\n' + m.out);
    }
  } else {
    if (fs.existsSync(SRC_DIR)) die2(`源码路径已存在但不是 git 仓库: ${SRC_DIR}`);
    fs.mkdirSync(path.dirname(SRC_DIR), { recursive: true });
    console.log('  全新克隆 → ' + SRC_DIR);
    const c = await gitNet(['clone', '--branch', BRANCH, SRC_URL, SRC_DIR]);
    if (c.code !== 0) die1('clone 失败:\n' + c.out);
    workDir = SRC_DIR;
  }
  const head = await run('git', ['-C', workDir, 'log', '--oneline', '-1'], { capture: true });
  console.log('  HEAD: ' + head.out.trim());
}

// ── [3/5] dotnet publish（产物落 %TEMP%\emuera-build，保持 clone 干净）──
console.log('[3/5] dotnet publish（win-x64 单文件，可能要几分钟）…');
{
  fs.rmSync(PUBLISH_OUT, { recursive: true, force: true });
  const r = await run('dotnet', ['publish', '-c', 'Release', '--runtime', 'win-x64',
    '-o', PUBLISH_OUT, path.join(workDir, 'Emuera', 'Emuera.csproj')]);
  if (r.code !== 0) die1('publish 失败 exit=' + r.code);
  const built = path.join(PUBLISH_OUT, 'Emuera.exe');
  if (!fs.existsSync(built)) die1('publish 后找不到 ' + built);
  console.log(`  产物 ${built}（${(fs.statSync(built).size / 1048576).toFixed(1)} MB）耗时 ${el()}`);
}

// ── [4/5] 安装到沙盒 ──
console.log('[4/5] 安装 → ' + dest);
fs.mkdirSync(dest, { recursive: true });
{
  const built = path.join(PUBLISH_OUT, 'Emuera.exe');
  const target = path.join(dest, EXE_NAME);
  if (fs.existsSync(target) && sha256(target) === sha256(built)) {
    console.log('  exe 与已装版 sha256 一致：跳过复制（不留新 .bak）');
  } else {
    if (fs.existsSync(target)) {
      const bak = target + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(target, bak);
      console.log('  旧 exe 备份 → ' + path.basename(bak));
    }
    fs.copyFileSync(built, target);
    console.log('  已安装 ' + EXE_NAME);
  }
  fs.mkdirSync(path.join(dest, 'ERB'), { recursive: true });
  if (!exeOnly) {
    const csvDir = path.join(dest, 'CSV');
    if (fs.existsSync(csvDir)) {
      console.log('  CSV 已存在：不动（' + csvDir + '）');
    } else {
      const src = corpusCsvSource();
      if (src.err) die1(src.err);
      console.log('  布置 CSV（语料只读拷出 ' + src.csv + '）…');
      fs.cpSync(src.csv, csvDir, { recursive: true });
      // Windows 大小写不敏感：语料里的 GameBase.csv 已满足 GAMEBASE.CSV；仅在完全没有时兜底最小版。
      if (!fs.existsSync(path.join(csvDir, 'GAMEBASE.CSV'))) {
        fs.writeFileSync(path.join(csvDir, 'GAMEBASE.CSV'),
          '\uFEFFコード,7153\r\nバージョン,proto\r\nタイトル,eraTW cli-setup minimal\r\n', 'utf8');
        console.log('  语料无 GameBase.csv → 写入最小 GAMEBASE.CSV');
      }
    }
  } else {
    console.log('  --exe-only：跳过 CSV 布置');
  }
}

// ── [5/5] 冒烟：--CliDebug hello/ready → quit ──
console.log('[5/5] CliDebug 冒烟…');
{
  const exe = path.join(dest, EXE_NAME);
  const p = spawn(exe, ['--CliDebug'], { cwd: dest });
  let hello = null; let ready = false; let id = 0;
  const send = (o) => { try { p.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 进程已退出 */ } };
  const closed = new Promise((res) => {
    readline.createInterface({ input: p.stdout }).on('line', (l) => {
      let ev; try { ev = JSON.parse(l); } catch { return; }
      if (ev.type === 'hello') { hello = ev; }
      if (ev.type === 'ready') { ready = true; send({ cmd: 'quit', id: ++id }); }
      // 握手期若冒出等待（例如首次运行弹配置），推空输入放行，避免卡死。
      if (ev.type === 'wait' && !ready) send({ cmd: 'input', id: ++id, text: '' });
      if (ev.type === 'exit') res('exit-event');
    });
    p.on('exit', () => res('process-exit'));
    p.on('error', (e) => die1('无法启动 exe: ' + e.message));
  });
  const killer = setTimeout(() => { p.kill(); die1(`冒烟超时 120s（hello=${hello ? '有' : '无'} ready=${ready ? '有' : '无'}）`); }, 120000);
  await closed;
  clearTimeout(killer);
  if (!hello || !ready) die1(`握手不完整: hello=${JSON.stringify(hello)} ready=${ready}`);
  console.log(`  PASS version=${hello.version} pid=${hello.pid}（握手+退出全程 ${el()} 总计）`);
}
console.log(`[OK] 引擎重建安装完成，总耗时 ${el()}`);
process.exit(0);
