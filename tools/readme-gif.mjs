#!/usr/bin/env node
/**
 * README 演示 GIF 录制器（2026-11-02 README 重构批）。
 *
 * 一句话：把「调试模式会话里的一次真实操作」录成一张 GIF——帧由 CDP 连续采样，
 * 编码交给 ffmpeg 两段调色板；场景是 JSON，落在 `tools/gif-scenarios/`，
 * 因此 README 里每一张动图都可重放、可审计（改场景 → 重录 → 字节数与帧数当场报）。
 *
 * 前置：`node tools/debug-cli.mjs serve --headless` 已起（本工具只连会话，不拉整套）。
 *
 * 子命令：
 *   list                              # 列场景（名字 / 标题 / 步数 / 是否含演示工程同步）
 *   record <场景|all> [--out-dir D]   # 录制并编码（缺省 out-dir = docs/assets）
 *   probe  <场景|all>                 # 只跑动作不采帧（调场景用，秒级）
 * 公共开关：
 *   --fps N          采样帧率（缺省取场景，再缺省 8）
 *   --width N        输出宽（px，缺省 1100；高度按比例）
 *   --clip SEL       覆盖场景的裁剪选择器（null＝整视口）
 *   --keep-frames    保留帧目录（默认录完删）
 *   --keyframes N    额外导出 N 张等间隔帧 PNG（人/agent 读图验收用）
 *   --max-kb N       超预算则降档重编（fps→宽度；仍超则如实报，不静默）
 *   --project DIR    演示工程落点（缺省 = 调试沙盒下 readme-demo/）
 *   --no-sync        不把 tools/gif-scenarios/demo-project 覆盖到演示工程
 *   --session FILE   显式会话文件（缺省按本工作树找 debug-cli 的会话）
 *
 * 口径：
 * - 演示数据 = `tools/gif-scenarios/demo-project/`（全合成，不含任何真实游戏内容），
 *   录制前整目录覆盖到沙盒 ⇒ 每张 GIF 的起点是同一份已知状态；
 * - 帧与中间产物一律落 `%TEMP%/kojo-gif/`（DEBUG-MODE §五 4 落点纪律：仓库内不留运行时产物），
 *   只有最终 .gif 按 --out-dir 落仓库；
 * - 录完必报读数：帧数 / 时长 / 尺寸 / 字节 / 编码档位，以及逐帧动作日志（哪一步在什么时候发生）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp, cdpPage, debugHome, sessionDir, sleep } from './debug-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCENARIO_DIR = path.join(HERE, 'gif-scenarios');
const DEMO_TEMPLATE = path.join(SCENARIO_DIR, 'demo-project');
const GIF_HOME = process.env.KOJO_GIF_HOME ?? path.join(debugHome(), '..', 'kojo-gif');

/* ------------------------------ 纯函数（可单测） ------------------------------ */

/** 场景步白名单：写错 kind 要当场报，不要静默跳过一步（静默＝GIF 里少了动作还看不出来） */
export const STEP_KINDS = new Set([
  'note', 'sleep', 'holdFrames', 'startSample', 'stopSample',
  'cli', 'eval', 'run', 'key', 'type', 'click', 'clickText', 'cursor',
  'guard', 'waitExpr', 'setInput', 'unlock', 'pauseSample', 'resumeSample',
]);

/** 一步的动作名 = 第一个认识的关键字（`note` 是标签、`allowFail` 是修饰，都不抢 kind） */
export function stepKind(st) {
  const keys = Object.keys(st);
  return keys.find((k) => k !== 'note' && STEP_KINDS.has(k)) ?? (keys.includes('note') ? 'note' : null);
}

/** 校验场景形状，返回错误清单（空数组＝合法） */
export function validateScenario(s) {
  const errs = [];
  if (!s || typeof s !== 'object') return ['场景不是对象'];
  if (!s.name || typeof s.name !== 'string') errs.push('缺 name（字符串）');
  if (!Array.isArray(s.steps) || s.steps.length === 0) errs.push('steps 必须是非空数组');
  if (s.fps !== undefined && !(Number(s.fps) > 0)) errs.push('fps 必须是正数');
  if (s.clip !== undefined && s.clip !== null && typeof s.clip !== 'string') errs.push('clip 必须是选择器字符串或 null');
  for (const [i, st] of (s.steps ?? []).entries()) {
    if (!st || typeof st !== 'object') { errs.push(`steps[${i}] 不是对象`); continue; }
    const kind = stepKind(st);
    if (!kind) {
      errs.push(`steps[${i}] 的动作名不认识：${Object.keys(st).join('/')}（可用：${[...STEP_KINDS].join(', ')}）`);
      continue;
    }
    if (kind === 'cli' && !Array.isArray(st.cli)) errs.push(`steps[${i}].cli 必须是参数数组`);
    if (kind === 'type' && typeof st.type !== 'string') errs.push(`steps[${i}].type 必须是字符串`);
    if (kind === 'key' && typeof st.key !== 'string') errs.push(`steps[${i}].key 必须是字符串`);
    if (kind === 'click' && typeof st.click !== 'string') errs.push(`steps[${i}].click 必须是选择器或 "x,y"`);
    if (kind === 'clickText' && (!st.clickText?.selector || !st.clickText?.text)) errs.push(`steps[${i}].clickText 需要 {selector, text}`);
    if (kind === 'cursor' && !Array.isArray(st.cursor)) errs.push(`steps[${i}].cursor 必须是 [行, 列]`);
    if (kind === 'eval' && typeof st.eval !== 'string') errs.push(`steps[${i}].eval 必须是字符串`);
    if (kind === 'run' && typeof st.run !== 'string') errs.push(`steps[${i}].run 必须是命令 id`);
    if (kind === 'setInput' && typeof st.setInput?.text !== 'string') errs.push(`steps[${i}].setInput 需要 {text}`);
  }
  return errs;
}

/**
 * 体积超档时的降档序列：先降帧率（动作仍完整，只是略跳），再降宽度（字会小）。
 * 返回 null＝没有更多档可降（此时如实报字节数，不做静默截断）。
 */
export function nextAttempt({ attempt = 0, fps, width }) {
  if (attempt === 0) return { fps, width };
  if (attempt === 1) return { fps: Math.max(4, Math.round(fps * 0.75)), width };
  if (attempt === 2) return { fps: Math.max(4, Math.round(fps * 0.75)), width: Math.round(width * 0.85) };
  if (attempt === 3) return { fps: 4, width: Math.round(width * 0.75) };
  return null;
}

/**
 * ffmpeg 两段调色板（palettegen + paletteuse）的单命令形态。
 *
 * `-framerate` 是**采样**帧率（决定每帧在时间轴上的位置），`fps=` 滤镜才是**编码**帧率——
 * 降档时只让后者变小（丢帧），前者不动；两者一起改会把动画整体加速。
 */
export function ffmpegArgs({ framesDir, sampleFps, fps, width, out }) {
  const filter = [
    `fps=${fps}`,
    `scale=${width}:-1:flags=lanczos`,
    'split[s0][s1]',
    '[s0]palettegen=stats_mode=diff[p]',
    '[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  ].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(sampleFps),
    '-i', path.join(framesDir, '%05d.png'), '-vf', filter, out];
}

/* ------------------------------ 会话与页 ------------------------------ */

function readSession(explicit) {
  const file = explicit ?? path.join(sessionDir(REPO), 'session.json');
  if (!fs.existsSync(file)) {
    die(`会话文件不在：${file}\n   先起整套：node tools/debug-cli.mjs serve --headless`);
  }
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!s.cdpPort || !s.vitePort) die(`会话缺 cdpPort/vitePort：${file}`);
  return s;
}

function die(msg, code = 1) {
  // 抛而不是 process.exit：录制半途红的时候，调用方还要把**已跑过的动作日志**吐出来
  // （哪一步没成、确认框点的什么，比一句 FAIL 有用得多）。顶层统一收口。
  const e = new Error(msg);
  e.gifExitCode = code;
  throw e;
}

/** 演示工程：整目录覆盖到录制落点（起点必须已知，否则 GIF 不可重放） */
async function syncDemoProject(dest) {
  if (!fs.existsSync(DEMO_TEMPLATE)) die(`演示工程模板不在：${DEMO_TEMPLATE}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(DEMO_TEMPLATE, dest, { recursive: true });
  const n = (function walk(d) {
    return fs.readdirSync(d, { withFileTypes: true })
      .reduce((a, e) => a + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0);
  })(dest);
  console.log(`[gif] 演示工程已重置：${dest}（${n} 个文件，全合成数据）`);
  return dest;
}

/** 屏上有确认框时按按钮文字点掉（没有框就是 no-op——重置流程要能幂等重放） */
async function waitExpr(cdp, expr, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evalJs(expr).catch(() => null)) return true;
    await sleep(200);
  }
  die(`等不到 ${what ?? expr}（${timeoutMs}ms）——先 node tools/debug-cli.mjs status 看会话`);
}

/**
 * 每个场景的统一起点：关项目（丢弃脏改动）→ 重置演示工程 → 可写打开 → 放行写权限 → 展开角色分组。
 *
 * 展开分组这一步不是便利：文件树按角色分组且**默认折叠**，而 `debug-cli open-file` 的展开逻辑
 * 只点目录行、点不到分组头（实测），所以这里自己点一次——场景里就能稳定点到组内的文件。
 */
/** 确认框可能晚于 open-project 返回才出现：轮询到点为止（超时不算失败——可能这一趟压根没弹） */
async function passModalWithin(cdp, buttonText, timeoutMs = 8000) {
  return passModalsWithin(cdp, [buttonText], timeoutMs);
}

/**
 * 一次可能**叠两枚**确认框（实测：关掉全部标签后「这一个文件丢不丢」和「整批丢不丢」同时在场，
 * 上面那枚的按钮是「丢弃修改」，不是「丢弃修改并关闭」）——逐层点，直到屏上没有 `.modal`。
 * 交回点过的按钮文案串，没弹过交回 `none`。
 */
async function passModalsWithin(cdp, buttonTexts, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const passed = [];
  while (Date.now() < deadline) {
    const r = await cdp.evalJs(
      `(()=>{const m=document.querySelector('.modal');if(!m)return 'none';
        const bs=[...m.querySelectorAll('button')];
        for(const want of ${JSON.stringify(buttonTexts)}){
          const b=bs.find(x=>(x.textContent||'').includes(want));
          if(b){b.click();return 'clicked:'+want}}
        return 'no-button:'+bs.map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,4).join('/')})()`,
    );
    // 「还没有框」要**继续等**（实测询问约在键后 500ms 才挂进 DOM），别一上来就当这趟没弹
    if (r === 'none') {
      if (passed.length > 0) break; // 点过一轮且屏上收干净了 ⇒ 完事
      await sleep(200);
      continue;
    }
    if (String(r).startsWith('no-button')) {
      passed.push(String(r));
      await sleep(300);
      continue;
    }
    passed.push(String(r).slice('clicked:'.length));
    await sleep(450);
  }
  if (passed.length === 0) return 'none';
  return passed.filter((x) => !x.startsWith('no-button')).slice(0, 4).join('+') || passed[0];
}

/**
 * 屏上残留的确认框一律先收掉（Esc 走各弹窗自带的 `useModalEscape` = 安全那一侧；
 * Esc 不收的再点安全按钮）。不清场，后面每一步都会打在遮罩上：实测一次失败的录制留下
 * 一枚引导框，之后所有键击落空、解锁与改名一起假红。
 */
async function clearModals(cdp, log) {
  let cleared = 0;
  for (let i = 0; i < 6; i += 1) {
    if (!(await cdp.evalJs(`!!document.querySelector('.modal')`))) break;
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(350);
    cleared += 1;
    if (await cdp.evalJs(`!!document.querySelector('.modal')`)) {
      const clicked = await cdp.evalJs(
        `(()=>{const m=document.querySelector('.modal');
          const want=['知道了','以后再说','保持只读','不用了','取消','关闭'];
          const bs=[...m.querySelectorAll('button')];
          for(const w of want){const b=bs.find(x=>(x.textContent||'').includes(w));if(b){b.click();return w}}
          return null})()`,
      );
      if (!clicked) {
        log.push(`   ↳ 残留确认框收不掉：${JSON.stringify(await cdp.evalJs(`[...document.querySelectorAll('.modal button')].map(b=>(b.textContent||'').trim()).slice(0,6)`))}`);
        break;
      }
      cleared += 1;
      await sleep(350);
    }
  }
  if (cleared > 0) log.push(`   ↳ 开场收掉残留确认框 ${Math.ceil(cleared / 2)} 层`);
  return cleared;
}

/** 左栏切回「口上文件」——活动栏的选择**跨项目保留**，停在搜索/大纲那面时文件树不渲染。
 *  但**已经在文件树那面时不能再点**：活动栏条目是开关，再点一次会把整面收起
 *  （2026-11-02 实测：收起后 `open-project` 等不到 `.file-tree`，一路假红）。 */
async function showFilesPanel(cdp) {
  for (let i = 0; i < 3; i += 1) {
    if (await cdp.evalJs(`!!document.querySelector('.file-tree')`)) return true;
    await cdp.evalJs(
      `(()=>{const b=[...document.querySelectorAll('.ab-item')].find(x=>(x.title||'').includes('口上文件'));b?.click()})()`,
    );
    await sleep(600);
  }
  return false;
}

/** 相位读数在开/关项目的切换瞬间会短暂落到 `unknown`（实测），所以判"到哪一相"要**同时认结构锚** */
const AT_WELCOME = `__kojoDebug.state().phase==='welcome' || !!document.querySelector('.welcome-open')`;
const AT_PROJECT = `__kojoDebug.state().phase==='project' || !!document.querySelector('.file-tree')`;

async function resetProject(cdp, demoDir) {
  const log = { push: (s) => console.log(`[gif] ${String(s).trim()}`) };
  await clearModals(cdp, log);
  await showFilesPanel(cdp);
  cli(['close-project']);
  console.log(`[gif] 未保存确认框：${await passModalsWithin(cdp, ['丢弃修改并关闭', '丢弃修改'], 5000)}`);
  // 不整页重载：实测 reload 后第一次 open-project 会被应用退回欢迎页、第二次把相位留在
  // `unknown`（2026-11-02），显式清理反而稳定——底部面板 / 标签 / 通知逐样关干净。
  await waitExpr(cdp, AT_WELCOME, 40000, '回到欢迎相位');
  await clearModals(cdp, log);
  await syncDemoProject(demoDir);
  // open-project 的「1.5s 回流欢迎页」判据在慢会话上是假红（实测：项目其实开了）——
  // 所以这里不采信它的退出码，一律以屏上结构锚为准。
  cli(['open-project', demoDir, '--writable', '--timeout', '120000']);
  console.log(`[gif] 写权限确认框：${await passModalWithin(cdp, '允许写入')}`);
  await waitExpr(cdp, AT_PROJECT, 90000, '进入工程相位（文件树在场）');
  await showFilesPanel(cdp);
  const expanded = await cdp.evalJs(
    `(()=>{let n=0;document.querySelectorAll('.tree-group').forEach(g=>{
        if(!g.querySelector('.tree-file') && g.querySelector('.tree-group-btn')){g.querySelector('.tree-group-btn').click();n++}});
      return n})()`,
  );
  // 屏上残留的报错通知与旧标签都会进 GIF，先清成一张白屏
  const toasts = await cdp.evalJs(`(()=>{const n=document.querySelectorAll('.toast').length;
    document.querySelectorAll('.toast button').forEach(b=>b.click());return n})()`);
  let tabs = 0;
  for (let i = 0; i < 12; i += 1) {
    const closed = await cdp.evalJs(`(()=>{const b=document.querySelector('.tab-close');if(!b)return false;b.click();return true})()`);
    if (!closed) break;
    tabs += 1;
    await sleep(300);
  }
  const docks = await cdp.evalJs(`(()=>{const n=document.querySelectorAll('.dock-cell-close').length;
    document.querySelectorAll('.dock-cell-close').forEach(b=>b.click());return n})()`);
  // 左栏回到「口上文件」：上一场景可能把活动栏停在搜索/大纲那面，残影会进下一张 GIF
  const filesPanel = await showFilesPanel(cdp);
  await sleep(400);
  const writable = await cdp.evalJs(`document.body.innerText.includes('可写')`);
  console.log(`[gif] 起点就绪：工程已开 · 可写=${writable} · 展开 ${expanded} 个空分组 · 清通知 ${toasts} 条 · 关旧标签 ${tabs} 个 · 关底部格 ${docks} 个 · 文件树在场=${filesPanel} · 树上文件 ${await cdp.evalJs('document.querySelectorAll(".tree-file").length')} 个`);
}

/**
 * 树里点开文件后**编辑区可能仍停在空态**（标签条有那一枚 `editor-tab preview`，
 * `.monaco-editor` 却没挂上；实测「关掉全部标签再开」时必现）。点一下标签即挂载。
 * 交回是否做了自愈，调用方据此再等一下渲染。
 */
async function ensureMounted(cdp, log) {
  const healed = await cdp.evalJs(
    `(()=>{if(document.querySelector('.monaco-editor'))return false;
      const t=document.querySelector('.editor-tab.active')||document.querySelector('.editor-tab');
      if(!t)return false;t.click();return true})()`,
  );
  if (healed) log.push('   ↳ 自愈：编辑区停在空态 ⇒ 点标签挂载 Monaco');
  return healed;
}

/** 复用 debug-cli 的成熟动作（开项目 / 开文件 / 跑命令面板），不另立第二套驱动 */function cli(argsArr) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'debug-cli.mjs'), ...argsArr], {
    cwd: REPO, encoding: 'utf8', timeout: 300000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) {
    // open-project 的「回流欢迎页」判据在慢盘上会假红（实测：项目其实开了）——
    // 所以调用方可以标 okIf: 允许特定文案失败，这里只如实把原文带出来
    console.log(`[gif][warn] debug-cli ${argsArr.join(' ')} rc=${r.status}\n${out.split('\n').map((l) => '   | ' + l).join('\n')}`);
  }
  return { rc: r.status ?? 1, out };
}

/* ------------------------------ 页内原语 ------------------------------ */

/**
 * 让 Monaco 收到真键盘事件：只 `focus()`，**不点鼠标**。
 * 实测（2026-11-02）：点 `.native-edit-context` 的左上角会把光标挪到该字符边界上
 * （7:10 → 7:1），于是「查找引用」读到的是另一个词——演示点必须停在场景指定的行列上。
 */
async function focusEditor(cdp) {
  const ok = await cdp.evalJs(
    `(()=>{
      // 焦点已经在真输入框里（F2 重命名框、命令面板、搜索框都是 <input>）⇒ 不许抢回编辑器，
      // 抢回去会把要打的字落进正文（实测：重命名演示里 "_V2" 被打进了函数名中间）
      const ae=document.activeElement;
      if(ae && (ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'||ae.tagName==='SELECT'))return true;
      const el=document.querySelector('.monaco-editor .native-edit-context')||document.querySelector('.monaco-editor textarea');
      if(!el)return false;
      // 已经聚焦就别再 focus()：重复 focus 会**打断 Monaco 的和弦等待**
      // （实测 Ctrl+K 之后再 focus 一次，Ctrl+I 就当普通键落进正文）
      if(document.activeElement!==el)el.focus();return true})()`,
  );
  if (!ok) die('页面上没有 Monaco 输入面（.monaco-editor）——先 open-file');
  return ok;
}

/** 键名 → CDP 键参数（覆盖演示要用的字母/数字/符号/功能键；不认识的如实报） */
export function keyParams(ch) {
  const code = (c) => ({ key: c, code: `Key${c.toUpperCase()}`, keyCode: c.toUpperCase().charCodeAt(0) });
  const named = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    f2: { key: 'F2', code: 'F2', keyCode: 113 },
    f12: { key: 'F12', code: 'F12', keyCode: 123 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  };
  const k = ch.toLowerCase();
  if (k === ' ') return { ...named.space, shift: false };
  if (named[k]) return { ...named[k], shift: false };
  if (/^[A-Z_]$/i.test(ch)) {
    const base = ch === '_' ? { key: '_', code: 'Minus', keyCode: 189 } : code(ch);
    return { ...base, key: ch, shift: /[A-Z_]/.test(ch) };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  const symbol = { '#': { code: 'Digit3', keyCode: 51, shift: true }, '@': { code: 'Digit2', keyCode: 50, shift: true }, $: { code: 'Digit4', keyCode: 52, shift: true }, '[': { code: 'BracketLeft', keyCode: 219, shift: false }, ']': { code: 'BracketRight', keyCode: 221, shift: false }, '(': { code: 'Digit9', keyCode: 57, shift: true }, ')': { code: 'Digit0', keyCode: 48, shift: true }, ',': { code: 'Comma', keyCode: 188, shift: false }, '.': { code: 'Period', keyCode: 190, shift: false }, ':': { code: 'Semicolon', keyCode: 186, shift: true }, ';': { code: 'Semicolon', keyCode: 186, shift: false }, '=': { code: 'Equal', keyCode: 187, shift: false }, '/': { code: 'Slash', keyCode: 191, shift: false }, '%': { code: 'Digit5', keyCode: 53, shift: true }, '"': { code: 'Quote', keyCode: 222, shift: true } };
  if (symbol[ch]) return { key: ch, ...symbol[ch] };
  return null;
}

async function pressKey(cdp, ch, mods = []) {
  const p = keyParams(ch);
  if (!p) die(`录制器不认识这个键：${ch}（要加就在 keyParams 里补，别静默丢键）`);
  const modifiers = (mods.includes('ctrl') ? 2 : 0) | (mods.includes('shift') ? 8 : 0) | (mods.includes('alt') ? 1 : 0);
  const base = { windowsVirtualKeyCode: p.keyCode, nativeVirtualKeyCode: p.keyCode, code: p.code, key: p.key, modifiers };
  const shifted = p.shift && !mods.includes('shift');
  const full = { ...base, modifiers: shifted ? modifiers | 8 : modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...full });
  // char 只给「可打印单字符且没按 Ctrl/Alt」：
  // - 功能键发 char 会把「F12」当字插进文档（实测触发过只读解锁框）；
  // - Ctrl 组合发 char 会把和弦的字母打进正文（实测 `Ctrl+K Ctrl+I` 曾把 i 插进函数名里）。
  //   Shift 仍可发 char（大写与 `#` 这类上档符号靠它）。
  if (p.key.length === 1 && !(full.modifiers & 2) && !(full.modifiers & 1)) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: p.key, key: p.key, ...full });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...full });
}

/** 真鼠标点一下（CDP 派发，不是 DOM .click()）：只有这条路能让 Monaco 内部认账「我聚焦了」 */
async function mouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** 解析 "x,y" 或选择器 → 视口坐标（元素中心） */
async function pointOf(cdp, selOrPoint) {
  if (/^\s*-?[\d.]+\s*,\s*-?[\d.]+\s*$/.test(selOrPoint)) {
    const [x, y] = selOrPoint.split(',').map(Number);
    return { x, y };
  }
  const box = await cdp.evalJs(
    `(()=>{const el=document.querySelector(${JSON.stringify(selOrPoint)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`,
  );
  if (!box) die(`选择器没命中元素：${selOrPoint}`);
  return box;
}

/* ------------------------------ 帧采样 ------------------------------ */

class Sampler {
  constructor(cdp, { fps, clip, dir }) {
    this.cdp = cdp;
    this.interval = 1000 / fps;
    this.clip = clip;
    this.dir = dir;
    this.on = false;
    this.n = 0;
    this.busy = false;
  }
  async resolveClip() {
    if (!this.clip) return null;
    const r = await this.cdp.evalJs(
      `(()=>{const el=document.querySelector(${JSON.stringify(this.clip)});if(!el)return null;const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`,
    );
    if (!r || r.width < 40 || r.height < 40) die(`裁剪选择器不可用：${this.clip}（读数 ${JSON.stringify(r)}）`);
    return { ...r, scale: 1 };
  }
  async frame() {
    const params = { format: 'png' };
    if (this.clipRect) params.clip = this.clipRect;
    const shot = await this.cdp.send('Page.captureScreenshot', params);
    this.n += 1;
    await fsp.writeFile(path.join(this.dir, `${String(this.n).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
  }
  async run() {
    this.clipRect = await this.resolveClip();
    let next = Date.now();
    while (!this.stopped) {
      if (this.on && !this.paused && !this.busy) {
        this.busy = true;
        try { await this.frame(); } catch (err) { console.log(`[gif][warn] 丢一帧：${err.message}`); }
        this.busy = false;
      }
      next += this.interval;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      else next = Date.now(); // 落后了就重新对齐，不补拍（补拍会让慢动作看起来更快）
    }
    return this.n;
  }
  stop() { this.stopped = true; }
}

/* ------------------------------ 场景执行 ------------------------------ */

/** 场景里的 `{{demoProject}}` → 本次录制的演示工程绝对路径（会话沙盒随工作树变，不写死） */
function subst(v, tokens) {
  if (typeof v === 'string') {
    let out = v;
    for (const [k, val] of Object.entries(tokens)) out = out.split(`{{${k}}}`).join(val);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => subst(x, tokens));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, tokens)]));
  return v;
}

async function runSteps(cdp, scenario, { sampler, log, tokens }) {
  const steps = scenario.steps ?? [];
  for (const [rawIdx, raw] of steps.entries()) {
    const st = subst(raw, tokens ?? {});
    const i = rawIdx;
    const kind = stepKind(st);
    const tag = `#${i + 1} ${kind}`;
    if (st.note) log.push(`${tag}（${st.note}）`);
    else log.push(`${tag}`);
    switch (kind) {
      case 'note': break;
      case 'sleep': await sleep(Number(st.sleep) || 0); break;
      case 'holdFrames': await sleep((Number(st.holdFrames) || 1) * (1000 / (sampler?.fps ?? 8))); break;
      case 'startSample': if (sampler) sampler.on = true; await sleep(120); break;
      case 'stopSample': await sleep(120); if (sampler) sampler.on = false; break;
      case 'cli': {
        const r = cli(st.cli);
        // open-project 的「回流欢迎页」判据在慢盘上会假红（实测：项目其实开了）⇒ allowFail 让场景自己判后续
        if (r.rc !== 0 && !st.allowFail) die(`debug-cli ${st.cli.join(' ')} 失败（rc=${r.rc}）——上面有原文`);
        break;
      }
      case 'eval': {
        let v;
        try {
          v = await cdp.evalJs(st.eval);
        } catch (e) {
          die(`eval 读数抛错：${e instanceof Error ? e.message : String(e)}`);
        }
        if (st.returns) console.log(`   ↳ ${kind} 读数：${JSON.stringify(v).slice(0, 900)}`);
        break;
      }
      case 'run':
        await cdp.evalJs(`__kojoDebug.commands.run(${JSON.stringify(st.run)})`);
        await sleep(Number(st.settle ?? 500));
        break;
      case 'key': {
        await focusEditor(cdp);
        await pressKey(cdp, st.key, st.mods ?? []);
        await sleep(Number(st.settle ?? 350));
        break;
      }
      case 'type': {
        await focusEditor(cdp);
        for (const ch of [...String(st.type)]) {
          await pressKey(cdp, ch, st.mods ?? []);
          await sleep(Number(st.perCharMs ?? 110));
        }
        await sleep(Number(st.settle ?? 400));
        break;
      }
      case 'setInput': {
        // 搜索框 / 命令面板这类普通输入：走页内赋值（比逐字符快，视觉上是「字出现了」）。
        // **必须走 HTMLInputElement 的原生 setter**：React 的受控输入有自己的 value 追踪器，
        // 直接 `el.value = …` 会被它当成"React 自己写的"而吞掉 onChange（实测搜索框一个字不进）。
        const ok = await cdp.evalJs(
          `(()=>{const el=document.querySelector(${JSON.stringify(st.setInput.selector ?? 'input')});if(!el)return false;
            el.focus();
            const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set
              ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;
            if(set)set.call(el,${JSON.stringify(st.setInput.text)});else el.value=${JSON.stringify(st.setInput.text)};
            el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
        );
        if (!ok) die(`setInput 没找到输入框：${st.setInput.selector ?? 'input'}`);
        await sleep(Number(st.setInput.settle ?? 400));
        const shown = await cdp.evalJs(
          `(()=>{const el=document.querySelector(${JSON.stringify(st.setInput.selector ?? 'input')});return el?el.value:null})()`,
        );
        log.push(`   ↳ setInput 框内实际值=${JSON.stringify(shown)}`);
        if (shown !== st.setInput.text) die(`setInput 赋了值没进框（期望 ${JSON.stringify(st.setInput.text)}，实得 ${JSON.stringify(shown)}）——受控输入的赋值腿不对`);
        break;
      }
      case 'click': {
        const p = await pointOf(cdp, st.click);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await sleep(80);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await sleep(Number(st.settle ?? 400));
        break;
      }
      case 'clickText': {
        const hit = await cdp.evalJs(
          `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(st.clickText.selector)})];
            const el=els.find(e=>(e.textContent||'').includes(${JSON.stringify(st.clickText.text)}));
            if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        if (!hit) die(`clickText 没命中：${st.clickText.selector} 里没有文本含「${st.clickText.text}」的元素`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
        await sleep(Number(st.clickText.settle ?? 400));
        if (await ensureMounted(cdp, log)) await sleep(500);
        // 首次打开游戏目录 ERB 会弹一次「要不要用语法糖视图」引导——它盖住整屏，
        // 不清掉的话后面的键击全打在遮罩上（实测：解锁与改名一起假红）。
        await clearModals(cdp, log);
        break;
      }
      case 'cursor': {
        const [line, column] = st.cursor;
        await cdp.evalJs(`__kojoDebug.editor.revealLine(${Number(line)})`);
        const ok = await cdp.evalJs(`__kojoDebug.editor.setCursor(${Number(line)}, ${Number(column)})`);
        if (!ok) die(`cursor 设不上：${line}:${column}（没有焦点编辑器？）`);
        await sleep(Number(st.settle ?? 250));
        break;
      }
      case 'guard': {
        const clicked = await cdp.evalJs(
          `(()=>{const m=document.querySelector('.modal');if(!m)return 'none';
            const b=[...m.querySelectorAll('button')].find(x=>(x.textContent||'').includes(${JSON.stringify(st.guard.button ?? '仍要直接编辑')}));
            if(!b)return 'no-button';b.click();return 'clicked'})()`,
        );
        log.push(`   ↳ guard=${clicked}`);
        await sleep(400);
        break;
      }
      case 'waitExpr': {
        const deadline = Date.now() + Number(st.waitExpr.timeout ?? 8000);
        let v = null;
        while (Date.now() < deadline) {
          v = await cdp.evalJs(st.waitExpr.expr).catch(() => null);
          if (v) break;
          await sleep(150);
        }
        if (!v) die(`waitExpr 超时：${st.waitExpr.expr}`);
        break;
      }
      case 'pauseSample':
        // 采样暂停：连续 `Page.captureScreenshot` 会让渲染面失焦，Monaco 的**和弦键**
        // （Ctrl+K Ctrl+I 这类两段式）在采帧中会被丢掉（实测 vis:false，停采后即真）。
        // 单段键（F12 / Shift+F12）不受影响，所以只在和弦前后用这一对。
        if (sampler) sampler.paused = true;
        await sleep(60);
        break;
      case 'resumeSample':
        await sleep(60);
        if (sampler) sampler.paused = false;
        break;
      case 'unlock': {
        // 游戏目录里的文件默认「只读保护」，而 Monaco 在 readOnly 下**不问语言服务**
        // （悬停 / 参数提示 / 补全 / 改名都出不来）。演示这些能力前必须先解锁：
        // 键入空格触发 `onDidAttemptReadOnlyEdit` → 点「仍要直接编辑」→ 按**真落进文档的空格数**退格。
        // 两条实测教训：① 无条件退格会在行首把上一行并下来（演示稿被改出 38 行，后面全乱）；
        // ② 确认框可能晚于第一次键击才出现（2.5s 内没等到要再敲一次，别一上来就判死）。
        await focusEditor(cdp);
        // 真点一下正文：DOM activeElement 已经是 native-edit-context 时，Monaco **内部**
        // 仍可能是未聚焦态（从树里点开文件就是这样），那键盘根本进不了编辑面 ⇒ 只读询问永不弹。
        const clickHere = await pointOf(cdp, '.view-lines');
        await mouseClick(cdp, clickHere.x, clickHere.y);
        await sleep(250);
        const len = async () => await cdp.evalJs('(__kojoDebug.editor.info()||{}).value?.length ?? -1');
        const before = await len();
        let r = 'none';
        for (let i = 0; i < 4 && r === 'none'; i += 1) {
          await pressKey(cdp, ' ');
          const seen = await passModalsWithin(cdp, ['仍要直接编辑'], 3000);
          if (seen !== 'none') r = seen;
        }
        const after = await len();
        const inserted = after - before;
        for (let i = 0; i < Math.min(inserted, 4); i += 1) await pressKey(cdp, 'backspace');
        const isUnlocked = await cdp.evalJs(
          `Array.from(document.querySelectorAll('.erb-mode-hint')).some(e=>(e.textContent||'').includes('已解锁'))`,
        );
        log.push(`   ↳ unlock=${r} · 落进文档 ${inserted} 字符（已退格撤掉）· 解锁态=${isUnlocked}`);
        if (!isUnlocked) die(`unlock 之后文件仍是只读（确认框应答=${r}）——只读下 Monaco 不问语言服务，这张 GIF 拍不出东西`);
        await sleep(500);
        break;
      }
      default: die(`动作没实现：${kind}`);
    }
  }
}

/* ------------------------------ 编码 ------------------------------ */

function encodeGif({ framesDir, sampleFps, fps, width, out }) {
  const r = spawnSync('ffmpeg', ffmpegArgs({ framesDir, sampleFps, fps, width, out }), { encoding: 'utf8' });
  if (r.status !== 0) die(`ffmpeg 编码失败（rc=${r.status}）：\n${r.stderr}`);
  return fs.statSync(out).size;
}

function gifInfo(out) {
  // 一次一行的 %n/%s 不能整段读（每帧一行，split 会把下一帧的数字当成高度）：
  // 帧数取最后一行的序号，尺寸只看第 0 帧
  const last = spawnSync('magick', ['identify', '-format', '%s\\n', out], { encoding: 'utf8' });
  const size = spawnSync('magick', ['identify', '-format', '%wx%h', `${out}[0]`], { encoding: 'utf8' });
  if (last.status !== 0 || size.status !== 0) return null;
  const lines = last.stdout.trim().split(/\r?\n/).filter(Boolean);
  const [w, h] = size.stdout.trim().split(/[x×]/).map(Number);
  return { frames: Number(lines.at(-1)) + 1, w, h };
}

/* ------------------------------ 主流程 ------------------------------ */

function loadScenarios(names) {
  // 清单是显式的一份（`scenarios.json`）：不 readdir，否则清单自己会被当成一个场景，
  // 而且新增场景忘了登记也能被 `tools/tests/readme-gif.test.ts` 的出厂自检抓到
  const manifest = path.join(SCENARIO_DIR, 'scenarios.json');
  if (!fs.existsSync(manifest)) die(`场景清单不在：${manifest}`);
  const all = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const picked = names?.length && names[0] !== 'all' ? names : all;
  const missing = picked.filter((n) => !all.includes(n));
  if (missing.length) die(`场景不存在：${missing.join(', ')}\n   现有：${all.join(', ')}`);
  return picked.map((name) => {
    const s = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, `${name}.json`), 'utf8'));
    s.name ??= name;
    const errs = validateScenario(s);
    if (errs.length) die(`场景 ${name} 不合法：\n   ${errs.join('\n   ')}`);
    return s;
  });
}

async function recordOne(scenario, opts) {
  const session = readSession(opts.session);
  const page = await cdpPage(session.cdpPort, session.vitePort);
  if (!page) die(`CDP :${session.cdpPort} 上没有本会话页面——先 node tools/debug-cli.mjs serve --headless`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();

  const outDir = path.resolve(REPO, opts.outDir ?? 'docs/assets');
  await fsp.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `${scenario.name}.gif`);
  const framesDir = path.join(GIF_HOME, scenario.name);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const fps = opts.fps ?? scenario.fps ?? 8;
  const width = opts.width ?? scenario.width ?? 1100;
  const clip = opts.clip !== undefined ? opts.clip : scenario.clip;

  const log = [];
  let frames = 0;
  let sampler = null;
  const tokens = {};
  try {
    try {
      if (scenario.needsProject !== false) {
        tokens.demoProject = (opts.project ?? path.join(session.sandbox ?? path.join(GIF_HOME, 'sandbox'), 'readme-demo')).replace(/\\/g, '/');
        if (!scenario.skipReset) await resetProject(cdp, tokens.demoProject);
        else if (!opts.noSync) await syncDemoProject(tokens.demoProject);
      }
      const probe = opts.probe;
      if (!probe) {
        sampler = new Sampler(cdp, { fps, clip, dir: framesDir });
        sampler.fps = fps;
        const pacer = sampler.run();
        try {
          await runSteps(cdp, scenario, { sampler, log, tokens });
        } finally {
          sampler.stop();
          frames = await pacer;
        }
      } else {
        await runSteps(cdp, scenario, { sampler: null, log, tokens });
      }
    } catch (e) {
      // 半途红的时候动作日志比错误本身有用（哪一步没成、确认框点的什么）——先吐出来再抛
      if (log.length > 0) console.log(`[gif] 中断前的动作日志：\n${log.map((l) => '   ' + l).join('\n')}`);
      throw e;
    }
  } finally {
    cdp.close();
  }

  if (opts.probe) {
    console.log(`[gif] probe ${scenario.name} 完成（未采帧）。动作日志：\n${log.map((l) => '   ' + l).join('\n')}`);
    return null;
  }
  if (frames < 3) die(`只采到 ${frames} 帧——场景里没有 startSample/stopSample 之间的动作？`);

  const duration = (frames / fps).toFixed(1);
  let attempt = 0;
  let params = nextAttempt({ attempt, fps, width });
  let bytes = encodeGif({ framesDir, sampleFps: fps, ...params, out });
  while (opts.maxKb && bytes > opts.maxKb * 1024) {
    const next = nextAttempt({ attempt: attempt + 1, fps, width });
    if (!next) { console.log(`[gif][warn] 已降到最低档仍超预算：${(bytes / 1024).toFixed(0)} KB > ${opts.maxKb} KB（如实报，不截帧）`); break; }
    params = next; attempt += 1;
    bytes = encodeGif({ framesDir, sampleFps: fps, ...params, out });
  }
  const info = gifInfo(out);
  console.log(`[gif] ${scenario.name} → ${path.relative(REPO, out).replace(/\\/g, '/')}`);
  console.log(`      帧 ${frames} · 采样 ${fps}fps（编码档 ${params.fps}fps/${params.width}px）· 时长 ${duration}s · ` +
    `${info ? `${info.w}×${info.h} · 编码后帧 ${info.frames}` : '尺寸未知'} · ${(bytes / 1024).toFixed(0)} KB`);

  if (opts.keyframes) {
    const files = fs.readdirSync(framesDir).sort();
    const step = Math.max(1, Math.floor(files.length / opts.keyframes));
    const picks = files.filter((_, i) => i % step === 0).slice(0, opts.keyframes);
    const kd = path.join(GIF_HOME, `${scenario.name}-keyframes`);
    fs.rmSync(kd, { recursive: true, force: true });
    fs.mkdirSync(kd, { recursive: true });
    for (const [i, f] of picks.entries()) await fsp.copyFile(path.join(framesDir, f), path.join(kd, `k${String(i + 1).padStart(2, '0')}-${f}`));
    console.log(`      等间隔帧已导出（${picks.length} 张）：${kd}`);
  }
  if (!opts.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
  else console.log(`      帧目录保留：${framesDir}`);
  console.log(`      动作日志：\n${log.map((l) => '        ' + l).join('\n')}`);
  return { name: scenario.name, frames, bytes, out };
}

function parseArgv(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--fps') opts.fps = Number(next());
    else if (a === '--width') opts.width = Number(next());
    else if (a === '--clip') opts.clip = next();
    else if (a === '--out-dir') opts.outDir = next();
    else if (a === '--keep-frames') opts.keepFrames = true;
    else if (a === '--keyframes') opts.keyframes = Number(next());
    else if (a === '--max-kb') opts.maxKb = Number(next());
    else if (a === '--project') opts.project = next();
    else if (a === '--no-sync') opts.noSync = true;
    else if (a === '--session') opts.session = next();
    else if (a === '--probe') opts.probe = true;
    else opts._.push(a);
  }
  return opts;
}

const opts = parseArgv(process.argv.slice(2));
const cmd = opts._[0];
const names = opts._.slice(1);

/** 只有被当命令跑时才动会话（单测 import 本模块读纯函数，不许顺手连浏览器） */
export async function main() {
  if (cmd === 'list') {
    for (const s of loadScenarios(names.length ? names : ['all'])) {
      console.log(`${s.name.padEnd(22)} ${String(s.steps.length).padStart(3)} 步 · ${s.fps ?? 8}fps · ${s.clip ?? '整视口'} · ${s.title ?? ''}`);
    }
  } else if (cmd === 'record' || cmd === 'probe') {
    if (!names.length) die('要录哪个场景？（record <场景|all>；list 看清单）', 2);
    opts.probe = cmd === 'probe' || opts.probe;
    const results = [];
    for (const s of loadScenarios(names)) results.push(await recordOne(s, opts));
    const done = results.filter(Boolean);
    if (done.length) {
      console.log(`\n[gif] 合计 ${done.length} 张：`);
      for (const d of done) console.log(`   ${d.name.padEnd(22)} ${(d.bytes / 1024).toFixed(0).padStart(5)} KB · ${d.frames} 帧`);
      const totalKb = done.reduce((a, d) => a + d.bytes, 0) / 1024;
      console.log(`   ${'合计'.padEnd(21)} ${totalKb.toFixed(0).padStart(5)} KB`);
    }
  } else {
    console.log(`README 演示 GIF 录制器

  node tools/readme-gif.mjs list
  node tools/readme-gif.mjs record <场景|all> [--max-kb 1500] [--keyframes 4]
  node tools/readme-gif.mjs probe  <场景|all>

前置：node tools/debug-cli.mjs serve --headless（本工具只连会话，不拉整套）`);
    process.exit(cmd ? 2 : 0);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (e) {
    console.error(`[gif][FAIL] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e?.gifExitCode ?? 1);
  }
}
