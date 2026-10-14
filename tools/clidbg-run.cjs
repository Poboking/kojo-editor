// kojo → ERB → 真引擎验收一键工具（SKIA 自编译版，--CliDebug JSON Lines）。
// 用法: node tools/clidbg-run.cjs <xxx.kojo|xxx.erb> [函数名...]
//   引擎沙盒目录: 环境变量 KOJO_CLIDBG_DIR（默认 C:/DSH/vendor/clidbg-probe，需含 --CliDebug 版 exe + CSV/GAMEBASE.CSV）
//   exe 名覆盖:   KOJO_CLIDBG_EXE
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const REPO = path.resolve(__dirname, '..');
const PROBE_DIR = process.env.KOJO_CLIDBG_DIR || 'C:/DSH/vendor/clidbg-probe';
const EXE = process.env.KOJO_CLIDBG_EXE || path.join(PROBE_DIR, 'Emuera_skiaV16_x64.exe');

function die(msg) { console.error('[FAIL] ' + msg); process.exit(1); }

const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0] === '-h') {
  console.log('用法: node tools/clidbg-run.cjs <xxx.kojo|xxx.erb> [函数名...]');
  console.log('  .kojo → 先转译成 ERB（仓库内 kojo-sugar），再让 SKIA 引擎真加载并逐个 TRYCCALLFORM 执行。');
  process.exit(argv.length ? 0 : 2);
}
const input = path.resolve(argv[0]);
fs.existsSync(input) || die('找不到输入: ' + input);
fs.existsSync(EXE) || die('找不到引擎 exe: ' + EXE + '（KOJO_CLIDBG_EXE / KOJO_CLIDBG_DIR 可覆盖）');
const isKojo = /\.kojo$/i.test(input);

// ── 1. 转译（.kojo 才需要）：经 vitest 跑一段内联测试，复用仓库 TS 服务 ──
let erbPath = input;
if (isKojo) {
  const tmpTest = path.join(REPO, 'packages/plugins/kojo-sugar/tests/__tmp.clidbg-transpile.test.ts');
  const outFile = input + '.generated.ERB';
  fs.writeFileSync(tmpTest, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { expect, it } from 'vitest';",
    "import { createSugarTranspileService } from '../src/service';",
    "import { stubDict, stubFaceTable } from './support';",
    "it('transpile for clidbg', () => {",
    `  const src = readFileSync(${JSON.stringify(input)}, 'utf8').replace(/^\\uFEFF/, '')`,
    "    .split('\\n').filter((l) => !l.startsWith('//')).join('\\n');", // fixture 约定的 // 横幅不进转译（同 golden.test readKojo）
    '  const r = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);',
    "  const errs = r.diagnostics.filter(d => d.severity === 'error');",
    "  expect(errs, JSON.stringify(errs)).toEqual([]);",
    `  writeFileSync(${JSON.stringify(outFile)}, '\\uFEFF' + r.erb.replace(/\\n/g, '\\r\\n'), 'utf8');`,
    '});',
    '',
  ].join('\n'));
  const t = spawnSync('pnpm', ['vitest', 'run', tmpTest.replace(/\\/g, '/')], { cwd: REPO, encoding: 'utf8', shell: true });
  fs.rmSync(tmpTest, { force: true });
  if (t.status !== 0) die('转译失败:\n' + (t.stdout || '') + (t.stderr || ''));
  erbPath = outFile;
  console.log('[1/3] 转译 OK →', erbPath);
}

// ── 2. 布置沙盒：产物 + @SYSTEM_TITLE 里逐函数 TRYCCALLFORM（错一个不炸全批）──
const erbText = fs.readFileSync(erbPath, 'utf8').replace(/^\uFEFF/, '');
// 函数头允许带 `参数:` 声明（@NAME(ARG,ARG:1)），提取时剥掉声明段
const fnMatches = [...erbText.matchAll(/^@([A-Za-z0-9_一-龥]+)(?:\([^\s)]*\))?$/gm)].map((m) => m[1]);
const targets = argv.length > 1 ? argv.slice(1) : fnMatches;
targets.length || die('未找到可执行的函数（第二个参数可显式指定函数名）');

const dir = path.join(PROBE_DIR, 'ERB');
fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
// 产物本体（UTF-8-BOM + CRLF，语料同款）
fs.writeFileSync(path.join(dir, 'generated.ERB'), erbText.startsWith('\uFEFF') ? erbText : '\uFEFF' + erbText.replace(/\r?\n/g, '\r\n'));
// 入口：TITLE 态先 ADDDEFCHARA 注册 14 个角色再逐函数 CALL（语料直引编号 12、裸 CFLAG 需有效 TARGET）。
// CALL/DONE 成对即该函数通过；首个失败函数中断脚本，配合沙盒 emuera.log 定位。
const setup = ['@SYSTEM_TITLE',
  // ADDDEFCHARA（仅 @SYSTEM_TITLE 标签下合法）按 CSV 模板注册角色、缺模板时用伪模板；
  // 固定注册 14 个，保证语料直引的 `ABL:12:` / `CFLAG:12:` 编号 12 在范围内。
  'PRINTFORML [CLIDBG] SETUP',
  'FOR LOCAL, 0, 13',
  'ADDDEFCHARA',
  'NEXT',
  'PRINTFORML [CLIDBG] CHARANUM={CHARANUM}'];
const entry = setup
  .concat(targets.flatMap((f) => [
    `PRINTFORML [CLIDBG] CALL ${f}`,
    'CALL ' + f,
    `PRINTFORML [CLIDBG] DONE ${f}`,
  ]))
  .concat(['WAIT', 'RETURN', '']).join('\r\n');
fs.writeFileSync(path.join(dir, 'main.ERB'), entry);
console.log('[2/3] 沙盒就绪，将执行:', targets.join(', '));

// ── 3. 驱动引擎：hello/ready → 收 out 事件 → 检测最终 WAIT 后 quit ──
const p = spawn(EXE, ['--CliDebug'], { cwd: PROBE_DIR });
const lines = [];
let id = 0;
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
let stateErr = false;
let strayInput = 0;
const done = new Promise((res) => {
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    let ev; try { ev = JSON.parse(l); } catch { return; }
    if (ev.type === 'out') lines.push(ev.text);
    if (ev.type === 'wait') {
      // PRINTFORMW / PRINTW 每行都产生一次 EnterKey 等待——只有当所有目标函数都 DONE 后
      // 的等待（入口末尾的 WAIT）才是终止信号，否则逐个推输入继续执行。
      const allDone = targets.every((f) => lines.some((t) => t.includes(`[CLIDBG] DONE ${f}`)));
      if (allDone || strayInput++ > 300) { send({ cmd: 'quit', id: ++id }); res(); }
      else send({ cmd: 'input', id: ++id, text: '' });
    }
    if (ev.type === 'state' && ev.state === 'Error') stateErr = true;
    if (ev.type === 'dialog') { console.error('[dialog] ' + (ev.text || '')); stateErr = true; send({ cmd: 'input', id: ++id, text: '' }); }
    if (ev.type === 'exit') res();
  });
  p.on('exit', () => res());
});
const killer = setTimeout(() => { p.kill(); die('超时未完成（90s）——事件流尾部: ' + lines.slice(-8).join(' | ')); }, 90000);
done.then(() => {
  clearTimeout(killer);
  fs.writeFileSync(path.join(PROBE_DIR, '_clidbg_run.jsonl'), lines.map((t) => JSON.stringify({ out: t })).join('\n') + '\n');
  console.log('[3/3] 引擎输出 ' + lines.length + ' 行:');
  console.log(lines.map((t) => '  ' + t).join('\n'));
  const bad = targets.filter((f) => {
    const c = lines.filter((t) => t.includes(`[CLIDBG] CALL ${f}`)).length;
    const d = lines.filter((t) => t.includes(`[CLIDBG] DONE ${f}`)).length;
    return c === 0 || d < c;
  });
  const engineErr = lines.filter((t) => t.includes('エラーが発生しました'));
  if (stateErr) die('引擎进入 Error 态（产物可能加载失败，见上方输出）');
  if (bad.length) die('以下函数未跑完（CALL/DONE 不成对）: ' + bad.join(', ') + (engineErr.length ? ' ; 引擎报错行: ' + engineErr.join(' / ') : ''));
  if (engineErr.length) die('TRYCCALLFORM 捕获到运行时错误: ' + engineErr.join(' / '));
  console.log('[OK] .kojo→ERB→引擎执行 全链路通过（' + targets.length + ' 个函数）');
  process.exit(0);
});
