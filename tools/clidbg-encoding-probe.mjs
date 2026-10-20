// 引擎编码取证：同一份中文 ERB 文本按「UTF-8 无 BOM / UTF-8 带 BOM / 代码页字节」三次落盘，
// 让真引擎（--CliDebug）各读一遍，把**打印出来的行**逐字对拍。
//
// 为什么要有这个工具（BOARD EMUERA-CLI #19，2026-10-20）：
//   编辑器写盘的 .ERB 有没有 BOM，从编辑器里看是**没有区别**的；而引擎读错编码时文件照样加载成功
//   （只是屏上成 乱码），所以"能加载"从来不是证据。唯一可信的读数是**引擎自己打印出来的字符串**。
//   本工具把三种字节形态摆在一起跑，输出相同 ⇒ 解码与 BOM 无关；不同 ⇒ 直接看到错成什么样。
//
// 用法:
//   node tools/clidbg-encoding-probe.mjs [选项]
//     --engine <DIR|EXE>   含 --CliDebug 版引擎的目录或 exe 本体（默认 KOJO_CLIDBG_DIR）
//     --config <FILE>      沙盒里原样使用的 emuera.config（默认取 --engine 目录自带的那份；
//                          想把"真实安装的配置"搬进来的就指它——编码相关的那行 `DEFAULT ANSI
//                          ENCODING` 是英文键名，只在英文键集的配置文件里生效，见下）
//     --gbk                多加一份 GBK 字节（代码页 936）对照样本（Windows：借 PowerShell 转码）
//     --keep               保留沙盒（默认跑完删干净）
//     --timeout <SEC>      单跑看门狗，默认 90
//   KOJO_CLIDBG_EXE 可直接给 exe 路径（与 clidbg-run.cjs 同口径）。
//
// 纪律:
//   * **引擎目录只读**：本工具把 exe + CSV + config 拷进 %TEMP% 沙盒再跑，绝不 spawn 在 vendor 目录里
//     （clidbg-run.cjs 会把 ERB/ 清空重写，直接跑在共享探针目录里会踩别人）。
//   * 沙盒落点只许在系统临时目录；落在仓库 / 引擎目录之下一律拒绝执行。
//   * 判定口径：三次跑都必须打印出期望的中文行，且 BOM 档与无 BOM 档的 out 行**完全相等**。
//
// 已知坑（实测踩过，别再踩）:
//   * 配置键名按**配置文件自己的语言**匹配：英文键集的 config 认 `DEFAULT ANSI ENCODING:...`，
//     日文键集的认 `内部で使用する東アジア言語:...`。混写的那行会被无视（引擎不报错，只是没生效）。
//   * 样本里 `#DIM` 必须紧贴 `@函数` 声明之后（放文件头 = `関数宣言の直後以外で#行が使われています`，
//     变量根本没定义，后面一赋值就 error）。
//   * `@SYSTEM_TITLE` 里用 RETURN 收尾会被判「予期しないスクリプト終端」；用 QUIT 才是干净退出。
'use strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const EXE_NAME = 'Emuera_skiaV16_x64.exe';
const SENTENCE = '中文输出测试：少女之梦';
const EXPECT = [SENTENCE, '变量值=42', '来自中文命名的函数：星屑のカケラ'];
const USAGE = 'node tools/clidbg-encoding-probe.mjs [--engine <DIR|EXE>] [--config <FILE>] [--gbk] [--keep] [--timeout SEC]';

const argv = process.argv.slice(2);
const opts = { engine: process.env.KOJO_CLIDBG_DIR || '', config: '', gbk: false, keep: false, timeoutSec: 90 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (a === '--engine') opts.engine = argv[++i] ?? '';
  else if (a === '--config') opts.config = argv[++i] ?? '';
  else if (a === '--gbk') opts.gbk = true;
  else if (a === '--keep') opts.keep = true;
  else if (a === '--timeout') opts.timeoutSec = Number(argv[++i]);
  else { console.error('[用法] 未知选项: ' + a + '\n' + USAGE); process.exit(2); }
}
const die = (m) => { console.error('[FAIL] ' + m); process.exit(1); };

// ── 定位引擎目录 / exe ──
const engineArg = path.resolve(opts.engine || process.env.KOJO_CLIDBG_EXE || '');
if (!opts.engine && !process.env.KOJO_CLIDBG_EXE) { console.error('[用法] 未指定引擎：--engine 或 KOJO_CLIDBG_DIR\n' + USAGE); process.exit(2); }
const engineExe = /\.exe$/i.test(engineArg) ? engineArg : path.join(engineArg, EXE_NAME);
const engineDir = path.dirname(engineExe);
fs.existsSync(engineExe) || die('找不到引擎 exe: ' + engineExe + '（需 --CliDebug 版）');

// ── 沙盒（系统临时目录；绝不落在引擎目录 / 仓库里）──
const sandbox = path.join(os.tmpdir(), 'kojo-engine-encoding');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
for (const [label, root] of [['引擎目录', engineDir], ['仓库', repoRoot]]) {
  if (norm(sandbox) === norm(root) || norm(sandbox).startsWith(norm(root) + path.sep)) die(`沙盒落点 ${sandbox} 落在${label}之下，拒绝执行`);
}
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'ERB'), { recursive: true });
fs.copyFileSync(engineExe, path.join(sandbox, path.basename(engineExe)));
for (const sub of ['CSV']) {
  const from = path.join(engineDir, sub);
  if (!fs.existsSync(from)) die(`引擎目录缺 ${sub}/（引擎加载必需）: ${from}`);
  fs.cpSync(from, path.join(sandbox, sub), { recursive: true });
}
const cfgSrc = opts.config ? path.resolve(opts.config) : path.join(engineDir, 'emuera.config');
if (fs.existsSync(cfgSrc)) fs.copyFileSync(cfgSrc, path.join(sandbox, 'emuera.config'));
else console.error('[warn] 未找到 emuera.config（' + cfgSrc + '）——引擎将用内置默认，编码口径可能不同于真实安装');
const engineExeLocal = path.join(sandbox, path.basename(engineExe));

// ── 样本：同文三态。中文注释 / 中文名变量 / 中文名函数 / 中文输出 ──
const LINES = [
  '; 中文注释：本文件按「原生起手包」的写法保存，注释里也有中文',
  '@SYSTEM_TITLE',
  '#DIM 现在BGM参数1', // 必须紧贴 @ 声明（否则 関数宣言の直後以外で#行…）
  'PRINTL [PROBE] ASCII-MARKER-OK',
  '现在BGM参数1 = 42',
  'PRINTL ' + SENTENCE,
  'PRINTFORML 变量值={现在BGM参数1}',
  'CALL 中文函数名',
  'PRINTL [PROBE] ASCII-END',
  'QUIT', // RETURN 收尾会被判「予期しないスクリプト終端」，QUIT 才干净
  '',
  '@中文函数名',
  'PRINTL 来自中文命名的函数：星屑のカケラ',
  'RETURN',
  '',
].join('\r\n');
const utf8 = Buffer.from(LINES, 'utf8');
const samples = [
  { label: 'A  UTF-8 无 BOM (CRLF)', file: 'A-bomless.ERB', bytes: utf8 },
  { label: 'A2 UTF-8 无 BOM (LF)', file: 'A2-bomless-lf.ERB', bytes: Buffer.from(LINES.replace(/\r\n/g, '\n'), 'utf8') },
  { label: 'B  UTF-8 带 BOM (CRLF)', file: 'B-bom.ERB', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) },
];
for (const s of samples) fs.writeFileSync(path.join(sandbox, s.file), s.bytes);
if (opts.gbk) {
  // 对照 = 同一段文本的 GBK 字节：用来回答「错解码长什么样」。node 无 GBK 编码器，借系统 PowerShell。
  const src = path.join(sandbox, '_gbk-src.txt');
  fs.writeFileSync(src, utf8);
  const ps = `$t=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes('${src.replace(/'/g, "''")}'));` +
    `[IO.File]::WriteAllBytes('${path.join(sandbox, 'C-gbk.ERB').replace(/'/g, "''")}',[Text.Encoding]::GetEncoding(936).GetBytes($t))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(path.join(sandbox, 'C-gbk.ERB'))) die('GBK 对照样本生成失败: ' + (r.stderr || r.stdout || ''));
  samples.push({ label: 'C  GBK 字节 (CRLF)', file: 'C-gbk.ERB', bytes: fs.readFileSync(path.join(sandbox, 'C-gbk.ERB')) });
}

// ── 跑一趟引擎：沙盒 ERB/ 只放一个样本，收 out 事件 ──
function runSample(s) {
  const erbDir = path.join(sandbox, 'ERB');
  for (const f of fs.readdirSync(erbDir)) fs.rmSync(path.join(erbDir, f), { force: true });
  fs.copyFileSync(path.join(sandbox, s.file), path.join(erbDir, 'probe.ERB'));
  for (const junk of ['emuera.log', '_clidbg_run.jsonl']) fs.rmSync(path.join(sandbox, junk), { force: true });
  return new Promise((resolve) => {
    const p = spawn(engineExeLocal, ['--CliDebug'], { cwd: sandbox, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let stderr = '', id = 0, done = false;
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 已退出 */ } };
    const finish = () => { if (!done) { done = true; send({ cmd: 'quit', id: ++id }); } };
    // stderr 必须收：引擎报错时异常栈走 stderr，不读会把管道写满 → 子进程卡死（实测踩过）
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    createInterface({ input: p.stdout }).on('line', (l) => {
      let ev; try { ev = JSON.parse(l); } catch { return; }
      if (ev.type === 'out') {
        const t = ev.text ?? '';
        out.push(t);
        // 收工信号：脚本自己的 QUIT 之后引擎不会自己退（CliDebug 循环还在等 stdin），
        // 所以见到最后一个标记就补一条 quit；致命错误那行同理兜底。
        if (t.includes('[PROBE] ASCII-END')) setTimeout(finish, 200);
        if (/按回车键或者点击鼠标左键结束程序|エンターキーもしくはクリックで終了/.test(t)) setTimeout(finish, 300);
      } else if (ev.type === 'wait') send({ cmd: 'input', id: ++id, text: '' });
      else if (ev.type === 'dialog') finish();
      else if (ev.type === 'exit') p.kill();
    });
    const killer = setTimeout(() => { console.error('[warn] ' + s.label + ' 超时 ' + opts.timeoutSec + 's'); p.kill(); }, opts.timeoutSec * 1000);
    p.on('exit', () => {
      clearTimeout(killer);
      const logPath = path.join(sandbox, 'emuera.log');
      resolve({ ...s, out, stderr: stderr.slice(0, 400), log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '' });
    });
    p.on('error', (e) => { clearTimeout(killer); resolve({ ...s, out, log: '', spawnError: e.message }); });
  });
}

const results = [];
for (const s of samples) {
  const r = await runSample(s);
  results.push(r);
  console.log(`\n=== ${r.label} (${r.bytes.length} bytes, sha256 ${crypto.createHash('sha256').update(r.bytes).digest('hex').slice(0, 16)}) ===`);
  if (r.spawnError) console.log('  引擎启动失败: ' + r.spawnError);
  for (const t of r.out) console.log('  out| ' + JSON.stringify(t));
  const warn = r.log.split(/\r?\n/).filter((l) => /警告Lv[12]|失败|了错误|エラー/.test(l) && !l.includes('报错指导文件'));
  if (warn.length) console.log('  警告/错误: ' + warn.join(' / '));
}

// ── 判定 ──
const key = (r) => r.out.filter((t) => /^(中文输出测试|变量值|来自中文命名)/.test(t));
const base = results[0];
const baseLines = key(base);
const missing = EXPECT.filter((e) => !baseLines.includes(e));
let ok = missing.length === 0;
console.log('\n=== 判定 ===');
for (const r of results) {
  const lines = key(r);
  const same = JSON.stringify(lines) === JSON.stringify(baseLines);
  console.log(`  ${r.label}: ${lines.length} 行中文输出, 与 A 相同=${same}${lines.length ? '' : '（一行都没打印：多半整文件没加载，见上）'}`);
  if (r !== base && r.label.startsWith('B') && !same) ok = false;
  if (r.label.startsWith('C') && lines.length && !same) {
    console.log('   ↳ C 与 A 不同 = 该引擎把「非配置代码页字节」解成了别的东西；对照行: ' + JSON.stringify(lines[0]));
  }
}
if (missing.length) { console.log('  A 缺行: ' + JSON.stringify(missing)); ok = false; }
console.log(ok
  ? '[OK] BOM-less UTF-8 与带 BOM 变体打印**逐行相同**，且中文行全部正确 ⇒ 引擎对无 BOM UTF-8 解码正确（非 ANSI 乱码）'
  : '[FAIL] 变体之间输出不一致或缺行 ⇒ 见上逐行读数');

if (!opts.keep) fs.rmSync(sandbox, { recursive: true, force: true });
else console.log('[keep] 沙盒保留在: ' + sandbox);
process.exit(ok ? 0 : 1);
