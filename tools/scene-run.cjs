// V2 场景级运行时断言 runner：真引擎（SKIA --CliDebug）沙盒里 置状态 → CALL 函数 → 断言打印行。
// 用法:
//   node tools/scene-run.cjs [scene.json ...]        不给路径 = tools/scenes/*.scene.json（排除 *.wrong.*）
//   node tools/scene-run.cjs --selftest              反假绿自检：正例(arg-plumbing)必须全绿 且 反例(selftest.wrong)必须报红
//   选项: --mapfile <path.json>  transpile sourceMap 回映（FAIL 时打印 产物第N行 → .kojo 第M行）
//         --no-alias-check       关闭每场景自带的别名回环自证（默认开，防最小 CSV 桩把分支静默吞掉）
//         --keep-sandbox         兼容占位（当前实现本来就保留沙盒取证；下次运行整根重建）
// 成本模型：一场景一次引擎启动（~1-2s 加载 + CALL 批量执行），场景内多 call 共享同一次启动。
// 环境变量: KOJO_CLIDBG_DIR(骨架源,默认 C:/DSH/vendor/clidbg-probe) KOJO_CLIDBG_EXE KOJO_SCENE_SANDBOX(默认 C:/DSH/vendor/clidbg-probe-scene)
// 退出码: 普通模式 = 失败 call 数（cap 255）；--selftest = 0 证明红/绿符合预期, 1 反证失败。
// 纪律: 语料目录严格只读；沙盒骨架从 clidbg-probe 取副本（exe 硬链接 / CSV 实复制），绝不写回 clidbg-probe。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const REPO = path.resolve(__dirname, '..');
const SCENES_DIR = path.join(REPO, 'tools', 'scenes');
const MASTER = process.env.KOJO_CLIDBG_DIR || 'C:/DSH/vendor/clidbg-probe';
const EXE = process.env.KOJO_CLIDBG_EXE || path.join(MASTER, 'Emuera_skiaV16_x64.exe');
const SANDBOX_ROOT = process.env.KOJO_SCENE_SANDBOX || 'C:/DSH/vendor/clidbg-probe-scene';
// 别名回环自证（反假绿前置闸）：向 12 号角色写哨兵值再读回。
// 这三个名字 2026-10-14 已核实存在于沙盒 CSV（与语料 CSV 同版）；若桩退化致名字静默归 0，回环先红，全场景判 FAIL。
const ALIAS = {
  lines: [
    'TALENT:12:恋慕 = 7',
    'CFLAG:12:既成事實 = 1',
    'EXP:子宮口開発経験 = 60',
    'PRINTFORML [ALIAS] LIANMU={TALENT:12:恋慕} JSEI={CFLAG:12:既成事實} EXP={EXP:子宮口開発経験}',
    'TALENT:12:恋慕 = 0',
    'CFLAG:12:既成事實 = 0',
    'EXP:子宮口開発経験 = 0',
  ],
  probe: /\[ALIAS\] LIANMU=(\d+) JSEI=(\d+) EXP=(\d+)/,
  want: ['7', '1', '60'],
};

function die(msg) { console.error('[FATAL] ' + msg); process.exit(255); }
function usage() {
  console.log('用法: node tools/scene-run.cjs [--selftest] [--mapfile x.map.json] [--no-alias-check] [scene.json ...]');
}

// ── argv ──
const argv = process.argv.slice(2);
let mapfileCli = null, selftest = false, aliasCheck = true;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--selftest') selftest = true;
  else if (a === '--mapfile') mapfileCli = argv[++i];
  else if (a === '--no-alias-check') aliasCheck = false;
  else if (a === '--keep-sandbox') { /* 本来就保留 */ }
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('--')) die('未知选项: ' + a);
  else positional.push(a);
}
fs.existsSync(EXE) || die('找不到引擎 exe: ' + EXE);
fs.existsSync(path.join(MASTER, 'CSV', 'GAMEBASE.CSV')) || die('骨架缺 CSV/GAMEBASE.CSV: ' + MASTER);

function resolveManifestPath(p, sceneFile) {
  if (path.isAbsolute(p)) return p;
  const cand = [path.resolve(REPO, p), path.resolve(path.dirname(sceneFile), p)];
  for (const c of cand) if (fs.existsSync(c)) return c;
  die('清单路径解析失败: ' + p + '（相对 ' + sceneFile + '）');
}
function loadScene(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  m.__file = file;
  m.__name = m.name || path.basename(file).replace(/\.scene\.json$/, '');
  m.__artifact = resolveManifestPath(m.artifact, file);
  m.__imports = (m.imports || []).map((p) => resolveManifestPath(p, file));
  m.setup = m.setup || [];
  m.calls = m.calls || [];
  m.calls.length || die('场景 ' + m.__name + ' 没有 calls');
  return m;
}

// ── 沙盒：运行前整根重建；exe 硬链接（23MB 零拷贝，引擎永不写 exe），其余实复制（引擎会重写 setting.json 等） ──
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function rmRetry(dir) {
  for (let i = 0; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); return; }
    catch (e) { if (i >= 4) throw e; sleepMs(300); }
  }
}
function buildSandbox(name) {
  const dir = path.join(SANDBOX_ROOT, name.replace(/[^A-Za-z0-9_.-]/g, '_'));
  rmRetry(dir);
  fs.mkdirSync(path.join(dir, 'ERB'), { recursive: true });
  try { fs.linkSync(EXE, path.join(dir, path.basename(EXE))); }
  catch { fs.copyFileSync(EXE, path.join(dir, path.basename(EXE))); }
  fs.cpSync(path.join(MASTER, 'CSV'), path.join(dir, 'CSV'), { recursive: true });
  for (const f of ['emuera.config', 'setting.json']) {
    const s = path.join(MASTER, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, f));
  }
  return dir;
}
const toErb = (text) => '\uFEFF' + text.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');

// ── main.ERB：TITLE 态 ADDDEFCHARA 骨架 → 别名回环 → TARGET=12 → setup → 每 call BEGIN/CALL/END 哨兵 ──
// TARGET=12 已实锤可赋值（Int1D 系统变量）；setup 行用裸名写（CFLAG:既成事實=1 等），与产物体内裸读同落 12 号角色。
function buildMain(m) {
  const useAlias = aliasCheck && m.alias_check !== false;
  const L = ['@SYSTEM_TITLE',
    'PRINTFORML [SCENE] ' + m.__name,
    'FOR LOCAL, 0, 13',
    'ADDDEFCHARA',
    'NEXT',
    'PRINTFORML [HARNESS] CHARANUM={CHARANUM}'];
  if (useAlias) L.push(...ALIAS.lines);
  L.push('TARGET = 12', ...m.setup);
  m.calls.forEach((c, i) => {
    const call = (c.args && c.args.length) ? `CALL ${c.fn}(${c.args.join(', ')})` : 'CALL ' + c.fn;
    L.push(`PRINTFORML [SCENE-BEGIN ${i}]`, call, `PRINTFORML [SCENE-END ${i}]`);
  });
  L.push('WAIT', 'RETURN', '');
  return L.join('\r\n');
}

// ── sourceMap 回映（--mapfile > manifest.map > 产物同名兄弟 <x>.generated.map.json / <x>.map.json） ──
function resolveMap(m) {
  let file = null;
  const explicit = mapfileCli || m.map || null;
  if (explicit) file = resolveManifestPath(explicit, m.__file);
  if (!file) {
    for (const cand of [m.__artifact.replace(/\.generated\.ERB$/i, '.generated.map.json'),
      m.__artifact.replace(/\.ERB$/i, '.map.json')]) {
      if (cand !== m.__artifact && fs.existsSync(cand)) { file = cand; break; }
    }
  }
  if (!file) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const arr = Array.isArray(j) ? j : (j.sourceMap || j.map || []);
  const map = new Map();
  for (const e of arr) if (e && typeof e.generatedLine === 'number') map.set(e.generatedLine, e.sourceLine);
  return { file: path.relative(REPO, file).replace(/\\/g, '/'), map };
}
function fnLines(erbText, fn) {
  const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^@' + esc + '(\\(|$)');
  const out = [];
  erbText.split(/\r?\n/).forEach((line, idx) => { if (re.test(line)) out.push(idx + 1); });
  return out;
}

// ── 驱动引擎（单场景单启动）：PRINTFORMW 每行一个 wait，全部 END 后才 quit，否则逐个推输入（300 上限） ──
function runEngine(dir, nCalls, sceneName) {
  return new Promise((resolve) => {
    const p = spawn(path.join(dir, path.basename(EXE)), ['--CliDebug'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = [];
    const tsBegin = new Map(), tsEnd = new Map();
    let id = 0, stray = 0, stateErr = false, resolved = false;
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 管道已关 */ } };
    const finish = (how) => {
      if (resolved) return; resolved = true;
      clearTimeout(killer);
      fs.writeFileSync(path.join(dir, '_scene_run.jsonl'), JSON.stringify({ scene: sceneName, how, lines }, null, 1), 'utf8');
      resolve({ lines, tsBegin, tsEnd, stateErr, how });
    };
    const killer = setTimeout(() => { p.kill(); finish('timeout'); }, 120000);
    readline.createInterface({ input: p.stdout }).on('line', (l) => {
      let ev; try { ev = JSON.parse(l); } catch { lines.push('RAW:' + l); return; }
      if (ev.type === 'out') {
        const t = String(ev.text);
        lines.push(t);
        for (let i = 0; i < nCalls; i++) {
          if (t.includes(`[SCENE-BEGIN ${i}]`)) tsBegin.set(i, Date.now());
          if (t.includes(`[SCENE-END ${i}]`)) tsEnd.set(i, Date.now());
        }
      }
      if (ev.type === 'wait') {
        if (tsEnd.size >= nCalls || stray++ > 300) send({ cmd: 'quit', id: ++id });
        else send({ cmd: 'input', id: ++id, text: '' });
      }
      if (ev.type === 'state' && ev.state === 'Error') stateErr = true;
      if (ev.type === 'dialog') { lines.push('[DIALOG] ' + (ev.text || '')); stateErr = true; send({ cmd: 'input', id: ++id, text: '' }); }
      if (ev.type === 'exit') finish('exit');
    });
    p.on('exit', () => finish('procexit'));
    p.on('error', (e) => die('引擎启动失败: ' + e.message));
  });
}

// ── 判定 ──
function sliceFor(lines, i, nCalls) {
  const b = lines.findIndex((t) => t.includes(`[SCENE-BEGIN ${i}]`));
  if (b < 0) return { found: false, complete: false, lines: [] };
  for (let j = b + 1; j < lines.length; j++) {
    if (lines[j].includes(`[SCENE-END ${i}]`)) return { found: true, complete: true, lines: lines.slice(b + 1, j) };
    let nextBegin = false;
    for (let k = i + 1; k < nCalls; k++) if (lines[j].includes(`[SCENE-BEGIN ${k}]`)) { nextBegin = true; break; }
    if (nextBegin) return { found: true, complete: false, lines: lines.slice(b + 1, j) };
  }
  return { found: true, complete: false, lines: lines.slice(b + 1) };
}
function evaluate(m, eng) {
  const res = { scene: m.__name, alias: 'SKIP', calls: [], engineFatal: eng.stateErr, how: eng.how };
  const useAlias = aliasCheck && m.alias_check !== false;
  if (useAlias) {
    const line = eng.lines.find((t) => ALIAS.probe.test(t));
    if (!line) res.alias = 'FAIL(无回环打印行)';
    else {
      const g = ALIAS.probe.exec(line);
      const bad = ALIAS.want.map((w, k) => [w, g[k + 1]]).filter(([w, a]) => w !== a);
      res.alias = bad.length ? 'FAIL(' + bad.map(([w, a]) => `期望${w}读回${a}`).join(' ') + ')' : 'PASS';
    }
    if (res.alias !== 'PASS') { // 别名解析未证实 → 全 call 判红（反假绿），不再评估期望
      m.calls.forEach((c, i) => res.calls.push({ i, fn: c.fn, status: 'FAIL', reasons: ['别名回环未通过，名字引用可能静默归 0（假绿源）'], note: c.note || '', slice: eng.lines.slice(-20) }));
      return res;
    }
  }
  m.calls.forEach((c, i) => {
    const sl = sliceFor(eng.lines, i, m.calls.length);
    const reasons = [];
    if (!sl.found) reasons.push('缺少 [SCENE-BEGIN ' + i + '] 哨兵（引擎可能在 setup/CALL 前 fatal）');
    else if (!sl.complete) reasons.push('缺少 [SCENE-END ' + i + ']：函数未跑完' + (eng.stateErr ? '（引擎进过 Error 态）' : ''));
    const slice = sl.lines;
    for (const pat of (c.expect || [])) {
      const re = new RegExp(pat);
      if (!slice.some((t) => re.test(t))) reasons.push('期望未命中: /' + pat + '/');
    }
    for (const pat of (c.expect_absent || [])) {
      const re = new RegExp(pat);
      const hit = slice.find((t) => re.test(t));
      if (hit !== undefined) reasons.push('禁止却出现: /' + pat + '/ → ' + hit);
    }
    if (eng.stateErr && !sl.complete) reasons.push('引擎 Error 态（fatal）');
    const ms = (eng.tsBegin.has(i) && eng.tsEnd.has(i)) ? eng.tsEnd.get(i) - eng.tsBegin.get(i) : null;
    res.calls.push({ i, fn: c.fn, status: reasons.length ? 'FAIL' : 'PASS', reasons, ms, note: c.note || '', slice });
  });
  return res;
}
function failDetailLines(c, m, mapInfo) {
  const out = [];
  out.push('  ── FAIL 详情: call#' + c.i + ' ' + c.fn + ' ──');
  if (m.calls[c.i] && m.calls[c.i].note) out.push('    note: ' + m.calls[c.i].note);
  for (const reason of c.reasons) out.push('    × ' + reason);
  const slice = (c.slice || []).slice(0, 40);
  out.push('    输出片段（' + (c.slice ? c.slice.length : 0) + ' 行，截 40）:');
  for (const t of slice) out.push('      | ' + t);
  const artifact = fs.readFileSync(m.__artifact, 'utf8').replace(/^\uFEFF/, '');
  const artLines = artifact.split(/\r?\n/);
  for (const fn of [c.fn, c.fn + '_1']) {
    for (const ln of fnLines(artifact, fn)) {
      if (!mapInfo) { out.push('    map: 产物第' + ln + '行 (@' + fn + '; 未配 mapfile)'); continue; }
      // 函数头行常为纯生成行（sourceLine=null，见 preview.ts 链头约定）→ 再找函数体内首个可回映行
      let bodyHit = null;
      for (let j = ln; j < artLines.length; j++) {
        if (/^@/.test(artLines[j])) break;
        const s = mapInfo.map.get(j + 1);
        if (typeof s === 'number') { bodyHit = { gen: j + 1, src: s }; break; }
      }
      const head = mapInfo.map.has(ln) ? mapInfo.map.get(ln) : undefined;
      const headTxt = head === undefined ? '无条目' : (head === null ? '归属不明(纯生成行)' : '第' + head + '行');
      out.push('    map: 产物第' + ln + '行 → .kojo ' + headTxt + ' (@' + fn + '; ' + mapInfo.file + ')');
      if (bodyHit) out.push('    map: 产物第' + bodyHit.gen + '行 → .kojo 第' + bodyHit.src + '行 (@' + fn + ' 体内首个可回映行: ' + artLines[bodyHit.gen - 1].trim().slice(0, 48) + ')');
    }
  }
  return out;
}

// ── 主流程 ──
(async function main() {
  let files;
  if (selftest) files = [path.join(SCENES_DIR, 'arg-plumbing.scene.json'), path.join(SCENES_DIR, 'selftest.wrong.scene.json')];
  else if (positional.length) files = positional.map((p) => path.resolve(p));
  else files = fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.scene.json') && !f.includes('.wrong.')).sort().map((f) => path.join(SCENES_DIR, f));
  files.length || die('没有可跑的 scene.json');
  rmRetry(SANDBOX_ROOT);
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

  const all = [];
  for (const file of files) {
    const m = loadScene(file);
    const t0 = Date.now();
    const dir = buildSandbox(m.__name);
    fs.writeFileSync(path.join(dir, 'ERB', '10-artifact.ERB'), toErb(fs.readFileSync(m.__artifact, 'utf8')), 'utf8');
    m.__imports.forEach((p, k) => fs.writeFileSync(path.join(dir, 'ERB', `20-import${k}.ERB`), toErb(fs.readFileSync(p, 'utf8')), 'utf8'));
    fs.writeFileSync(path.join(dir, 'ERB', 'main.ERB'), toErb(buildMain(m)), 'utf8');
    const eng = await runEngine(dir, m.calls.length, m.__name);
    const r = evaluate(m, eng);
    r.dir = dir; r.totalMs = Date.now() - t0;
    r.mapInfo = resolveMap(m);
    all.push({ m, r });
  }

  // 结果表：stdout 在 GBK 控制台可能花屏；权威版同时落沙盒根 _scene_report.txt（UTF-8-BOM）
  const rep = ['kojo V2 scene-run 报告  ' + new Date().toISOString()];
  let failed = 0;
  for (const { m, r } of all) {
    rep.push('');
    rep.push('SCENE ' + r.scene + '   alias=' + r.alias + '   engine=' + (r.engineFatal ? 'FATAL' : 'ok') + '   ' + r.totalMs + 'ms   sandbox=' + r.dir);
    for (const c of r.calls) {
      rep.push('  call#' + c.i + '  ' + c.status + '  ' + c.fn + '  ' + (c.ms != null ? c.ms + 'ms' : '-'));
      if (c.status === 'FAIL') failed++;
    }
    const fails = r.calls.filter((c) => c.status === 'FAIL');
    for (const c of fails) rep.push(...failDetailLines(c, m, r.mapInfo));
  }
  const text = rep.join('\n');
  console.log(text);
  fs.writeFileSync(path.join(SANDBOX_ROOT, '_scene_report.txt'), '\uFEFF' + text + '\n', 'utf8');

  let exitCode;
  if (selftest) {
    const good = all.find((x) => x.m.__name === 'arg-plumbing');
    const bad = all.find((x) => x.m.__name === 'selftest-wrong');
    const goodOk = good && good.r.calls.length && good.r.calls.every((c) => c.status === 'PASS');
    const badRed = bad && bad.r.calls.length && bad.r.calls.every((c) => c.status === 'FAIL');
    console.log('[SELFTEST] 正例全绿=' + (goodOk ? 'YES' : 'NO') + '  反例全红=' + (badRed ? 'YES' : 'NO') + '  → 反假绿' + (goodOk && badRed ? '成立' : '不成立'));
    exitCode = goodOk && badRed ? 0 : 1;
  } else {
    exitCode = Math.min(failed, 255);
    console.log('[SUMMARY] failed calls = ' + failed + '  (exit ' + exitCode + ')');
  }
  process.exit(exitCode);
})();
