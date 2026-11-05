#!/usr/bin/env node
/**
 * 「状态回放」面板的真编辑器冒烟（2026-11-05，回放面板可用性批）。
 *
 * 为什么要有这把刀：面板这一批改的全是**屏上才能看见**的东西——并集槽位、候选
 * datalist、假设徽章、换函数重置、文案。单测喂的是纯函数与假 DOM，接线一旦接错
 * （选择器、事件通道、state 没接上），单测照样全绿而作者按下去没反应。所以这里
 * 起**真调试宿 + 真 vite + 真浏览器（CDP）+ 真语料**，按作者路径一步步点，逐条断言。
 *
 * 与既有刀的分工：
 *   - `tools/debug-web-smoke.mjs`：编辑器**通用**能力（开项目/开文件/Monaco/命令/事件/语言面），
 *     夹具是 `fixtures/mini-game`（没有真实存档、没有口上规模的条件索引）；
 *   - 本刀：只钉「状态回放」面板的交互链，语料用**真实 eraTW 盘**（默认按内容自动发现，
 *     可用 KOJO_CORPUS_DIR / --project 指定），因此能覆盖真实存档解析 + 真条件索引 + 真槽位。
 *
 * 断言链（a–h，与面板可用性批的验收项一一对应）：
 *   a. 能打开「状态回放」面板（走 `workbench.stateReplay` 命令，与真人同一条路）；
 *   b. 选存档 + 选角色 K49（觉）后视图就绪；
 *   c. 输入 ARGS 分派函数 → 判定 → 未知文案是「面板没给这一格填值」，
 *      **且旧文案「注入的实参只填了部分槽位」一处都不许出现**；
 *   d. 「场景参数」折叠区里出现 ARGS 输入框（并集槽位）；输入框挂到 datalist（有候选时）；
 *   e. 勾「按默认场景 0 试算」→ 再判定 → 结果区出现「基于假设」；
 *   f. 换一个函数 → 槽位输入被重置（全空）；
 *   g. 结果区/选择区存在缓冲文本口径提示（「有未保存编辑时按编辑器缓冲文本判定」）；未建模写口径在场；
 *      有 INLINE / call-context 计数时，对应提示必须在场；
 *   i. 整档体检（本档全部角色，边界批 S4）：入口按钮 + title 写明预算；真跑完出摘要
 *      （已扫 > 0 角色、含「全未知」计数）；摘要可展开成角色行 + 「全局最该看」并**点了就判**；
 *      再点一次能在 busy 期取消（摘要带「已取消」）；
 *   j. 未建模写分桶（边界批）：语料里挑「行首 CALL + 状态写」/「平跳后还有写」的真函数，
 *      判定后结果区必须出现「另有 N 处调用 / 跳转」，且 call / jump 行**不铺成逐行按钮**；
 *   k. 未保存文本口径：真改 Monaco 缓冲（真语料是只读项目 ⇒ `executeEdits` 被 Monaco 静默吞掉，
 *      退回任务书给的备用口径 `setValue`；不保存）→ 判定 → 结果区标出「编辑器里的未保存文本」
 *      → `setValue` 还原（正文逐字回原文，全程不写盘）；
 *   h. 截图落到 `.arts/`（不入库；`--out` 可改），打印读数摘要。
 *
 * 真语料是**只读**打开的（规范 §5：游戏目录整体只读）：调试宿 `--readonly` 登记读根，
 * 写权限审批弹窗走「只读浏览」那条腿（`.modal .ghost`）。全程不写语料盘。
 *
 * 用法：
 *   node tools/replay-panel-smoke.mjs [--project <语料目录>] [--out <截图目录>] [--keep] [--headful]
 *   node tools/replay-panel-smoke.mjs --help
 *
 * 前置：本机有 Chrome/Edge（KOJO_DEBUG_BROWSER 可指定）；`pnpm install` 过（vite 在位）；
 *       盘上有真实语料（或 KOJO_CORPUS_DIR 指过去）。
 * 退出码：0 全绿；1 有断言红；2 前置不满足（没浏览器 / vite 不在位 / 没语料 / 参数不合法）。
 *
 * 可复跑纪律（同既有 smoke）：
 *   - 每轮独立工作目录（系统临时目录下，`replay-panel-smoke-<pid>`），browser profile 也在里面；
 *     退出时按工作目录认领逃出树杀的 Edge 子进程再删目录（PITFALLS 332 同族坑）；
 *   - 端口一律 freePort 起步 + strictPort，撞口即红，不静默换口；
 *   - 断言失败不中断：能继续读的读数继续读（一次跑完拿全证据），最后按失败数退出非零；
 *   - 致命前置（页面起不来 / 项目打不开 / 面板 DOM 形态不认识）当场取证并退出，不拿假绿兜底。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugServer } from './debug-server.mjs';
import {
  Cdp,
  cdpClick,
  cdpPage,
  debugHome,
  dismissDevNoteMask,
  findBrowser,
  freePort,
  killProcessesMarked,
  openFileViaSearchSurface,
  portOpen,
  resolveMemoryBudget,
  memorySourceLabel,
  MEMORY_TIGHT_MB,
  sleep,
  waitFor,
} from './debug-lib.mjs';
import { assertPageOrigin } from './smoke-lib.mjs';
import { CorpusError, corpusHint, inspectCorpus, resolveCorpusDir } from './corpus.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
// 与 debug-web-smoke 同口径：工作目录落在系统临时目录（browser-profile 会被浏览器锁住，
// 落在仓库里会让整树 watcher 的工具 EBUSY 崩——别人的测试不该被这把刀弄红）。
const WORK = path.join(debugHome(), `replay-panel-smoke-${process.pid}`);

/* ------------------------------ 断言目标（可改，改就是改验收口径） ------------------------------ */

/** 目标函数 A：ARGS 分派型口上（函数体 `SELECTCASE ARGS` → 一堆 `CASE OPR_*`）。 */
const FN_ARGS = 'M_KOJO_MESSAGE_NK_COM_K49_SUIKA';
/** 目标函数 B：条件里确定性读数值槽 `ARG`（`IF LOCAL:1 && ARG == 0`）——
 *  勾「按默认场景 0 试算」后，这条谓词必须被标「基于假设」。 */
const FN_INT_ARG = 'M_KOJO_ORTHODOX_SPEVENT_K49_2';
/** 打开的口上文件（快速打开那条腿的搜索词；也是「打开一份口上文件」的验收对象）。 */
const KOJO_FILE_FRAG = 'M_KOJO_K49_310_其它事件.ERB';
/**
 * 缓冲文本探针（k1）用的口上文件：选一份**有活函数**的（`其它事件` 整篇在 SKIPSTART 里，
 * 抽取侧不发布那区里的函数，拿它测不出缓冲文本腿）。搜索词仍是「快速打开」那条腿。
 */
const BUFFER_FILE_FRAG = 'M_KOJO_K49_310_会话.ERB';
/** 角色：K49 古明地觉。 */
const CHARA_NO = 49;

/** 预算（真语料比夹具慢一个量级：条件索引是 3,000+ ERB 的全量扫描）。 */
const OPEN_PROJECT_MS = 300000;
const VIEW_MS = 180000;
const JUDGE_MS = 300000;
const PANEL_MS = 60000;
/**
 * 整档体检（本档全部角色）：168 角色 × 每角色 20 段、全档 2,000 段封顶的**真回放**。
 * 真机 60–120s 起（段落大的话更久），给足 5 分钟——超时就是"跑不完"，不拿假绿兜底。
 */
const ARCHIVE_SCAN_MS = 300000;
/** 取消后的收尾预算：每段开始前读旗标，当前段跑完才停（大段落可能要几十秒）。 */
const ARCHIVE_SCAN_CANCEL_MS = 120000;
/**
 * 「整档体检」按钮要等条件索引就绪（全语料抽取：4,072 ERB / 近 50 万谓词，真机几十秒起）。
 * 给 7 分钟；等不到就是这颗入口在真语料上不可达（读数照报，不静默跳过）。
 */
const ARCHIVE_INDEX_MS = 420000;

/* ------------------------------ 命令行参数 ------------------------------ */

const USAGE = `用法：node tools/replay-panel-smoke.mjs [选项]

选项：
  --project <目录>   显式指定真实语料目录（默认按内容自动发现：KOJO_CORPUS_DIR > 扫盘）
  --out <目录>       截图输出目录（默认 .arts/replay-panel-smoke-<时间戳>，不入库）
  --keep             保留本轮工作目录（browser profile / 日志），排查用
  --headful          有头浏览器（默认 --headless=new）
  -h, --help         打印本页

退出码：0 全绿；1 有断言红；2 前置不满足（无浏览器 / 无 vite / 无语料 / 参数不合法）。
`;

function parseArgs(argv) {
  const opts = { project: null, out: null, keep: false, headful: false, help: false };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--headful') opts.headful = true;
    else if (a === '--project' || a === '--corpus') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) {
        throw new UsageError(`${a} 需要一个目录参数`);
      }
      opts.project = v;
    } else if (a.startsWith('--project=')) opts.project = a.slice('--project='.length);
    else if (a === '--out') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) throw new UsageError('--out 需要一个目录参数');
      opts.out = v;
    } else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else unknown.push(a);
  }
  if (unknown.length) throw new UsageError(`未知参数：${unknown.join(' ')}`);
  return opts;
}

class UsageError extends Error {}

/* ------------------------------ 结果账本 ------------------------------ */

const results = [];
const notes = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
/** N/A 读数（不算红也不算绿）：把它单独记下来，报告里能一眼看见"哪些项本函数没覆盖"。 */
const note = (msg) => {
  notes.push(msg);
  console.log(`• ${msg}`);
};

/* ------------------------------ 进程与清理 ------------------------------ */

const children = [];
const cleanupAll = [];
let shuttingDown = false;

async function rmRetry(target, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(600);
    }
  }
  return false;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const fn of cleanupAll.reverse()) {
    try {
      await fn();
    } catch {}
  }
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawnSync(`taskkill /PID ${c.pid} /T /F`, { shell: true, stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch {}
  }
  // Edge 会逃出树杀锁着 browser-profile：按工作目录认领再收一轮，才谈得上删目录
  killProcessesMarked(WORK);
  await sleep(600);
  if (!OPTS.keep) await rmRetry(WORK);
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length ? `❌ 状态回放面板冒烟 ${failed.length} 项红（共 ${results.length} 项）` : `✅ 状态回放面板冒烟全绿（${results.length} 项）`);
  if (code === 2) console.log('[smoke] 退出码 2 ＝ 前置不满足（见上面的 [FAIL] 行）');
  process.exit(failed.length ? 1 : code === 1 ? 1 : 0);
}
process.on('SIGINT', () => void shutdown(1));

/* ------------------------------ 页内小工具 ------------------------------ */

/**
 * 装一页受控输入助手（React 受控组件必须走**原生 setter + 冒泡事件**，
 * 直接 `el.value = x` 会被 React 的 value tracker 吞掉，onChange 不触发）。
 *
 * 选择器一律以**文本锚**找（"选项里含『选择存档』的那个 select"），不按 nth-child 排——
 * 「场景参数」折叠区展开后会多出一个 scene select，按下标取必然错位。
 */
async function installPageHelpers(cdp) {
  await cdp.evalJs(`(() => {
    if (globalThis.__rpSmoke) return true;
    const protoOf = (el) => (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    const setNative = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(protoOf(el), 'value');
      if (!d || typeof d.set !== 'function') throw new Error('value setter 不在：' + (el && el.tagName));
      d.set.call(el, v);
    };
    const panel = () => document.querySelector('.panel-state-replay');
    const selectByOptionText = (needle) => {
      const all = [...document.querySelectorAll('.panel-state-replay select')];
      return all.find((s) => [...s.options].some((o) => (o.textContent || '').includes(needle))) ?? null;
    };
    globalThis.__rpSmoke = {
      ready: () => !!panel(),
      optionsOf(needle) {
        const s = selectByOptionText(needle);
        return s ? [...s.options].map((o) => ({ value: o.value, text: (o.textContent || '').trim() })) : null;
      },
      /** 把含 needle 的那个 select 设为 value（选项必须是已存在的 value） */
      setSelect(needle, value) {
        const s = selectByOptionText(needle);
        if (!s) return { ok: false, reason: 'no-select:' + needle };
        const exists = [...s.options].some((o) => o.value === value);
        if (!exists) return { ok: false, reason: 'no-option:' + value };
        setNative(s, value);
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: s.value };
      },
      setInput(sel, v) {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, reason: 'no-element:' + sel };
        setNative(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      },
      scrollIntoView(sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        return true;
      },
      panelText() {
        const p = panel();
        return p ? p.innerText : '';
      },
      /** 面板 DOM 骨架（形态不认识时用来定位是"没渲染"还是"选择器过时"） */
      outline() {
        const p = panel();
        if (!p) return '(no .panel-state-replay)';
        const walk = (el, depth) => {
          if (depth > 4) return '';
          let out = '';
          for (const c of el.children) {
            if (!(c instanceof HTMLElement)) continue;
            const cls = String(c.className || '').split(/\\s+/).filter(Boolean).slice(0, 4).join('.');
            out += '  '.repeat(depth) + c.tagName.toLowerCase() + (cls ? '.' + cls : '') + '\\n';
            out += walk(c, depth + 1);
          }
          return out;
        };
        return walk(p, 0).slice(0, 6000);
      },
    };
    return true;
  })()`);
}

/**
 * 面板读数（一次 CDP 往返拿全）：选择区 / 折叠区 / 槽位行 / 结果区 / 提示带。
 * 所有判据都落在这份读数上——断言函数里不再零散 query，红的时候打印的就是读到的原件。
 */
async function readPanel(cdp) {
  return await cdp.evalJs(
    `(() => {
      const panel = document.querySelector('.panel-state-replay');
      if (!panel) return { present: false };
      const txt = (el) => (el ? (el.textContent || '').trim() : '');
      const secs = [...panel.querySelectorAll('.dbg-sec')];
      const secByTitle = (t) => secs.find((s) => txt(s.querySelector('.dbg-sec-title')) === t) || null;
      const res = secByTitle('判定结果');
      const preds = res
        ? [...res.querySelectorAll('.rp-pred-btn')].map((b) => ({
            kind: txt(b.querySelector('.rp-kind')),
            outcome: txt(b.querySelector('.rp-outcome')),
            text: txt(b.querySelector('.rp-pred-text')),
            title: b.getAttribute('title') || '',
            badges: [...b.querySelectorAll('.rp-badge')].map((x) => txt(x)),
          }))
        : [];
      const fold = panel.querySelector('.dbg-fold');
      const foldHead = fold ? fold.querySelector('.dbg-fold-head') : null;
      const foldBody = fold ? fold.querySelector('.dbg-fold-body') : null;
      const slotRows = foldBody
        ? [...foldBody.querySelectorAll('.rp-slot-input')].map((i) => {
            const row = i.closest('label.rp-slot');
            const listId = i.getAttribute('list');
            const dl = listId ? document.getElementById(listId) : null;
            return {
              label: txt(row ? row.querySelector('.rp-slot-idx') : null),
              title: i.getAttribute('title') || '',
              placeholder: i.getAttribute('placeholder') || '',
              value: i.value,
              listId,
              listOptions: dl ? dl.querySelectorAll('option').length : -1,
              hasAssumeBadge: !!(row && row.querySelector('.rp-badge.assume')),
            };
          })
        : [];
      const dlAll = [...panel.querySelectorAll('datalist')].map((d) => ({
        id: d.id,
        options: d.querySelectorAll('option').length,
      }));
      const fields = [...panel.querySelectorAll('.dbg-fields select')].map((s) => s.value);
      const cb = foldBody ? foldBody.querySelector('input[type="checkbox"]') : null;
      const hints = [...panel.querySelectorAll('.rp-hint')].map((e) => txt(e));
      return {
        present: true,
        title: txt(panel.querySelector('.dbg-head-title')),
        sub: txt(panel.querySelector('.dbg-head-sub')),
        status: txt(panel.querySelector('.rp-status')),
        error: txt(panel.querySelector('.rp-error')),
        notes: [...panel.querySelectorAll('.dbg-notes .dbg-note')].map((e) => txt(e)),
        archiveValue: fields[0] ?? null,
        charaValue: fields[1] ?? null,
        fnInputValue: panel.querySelector('.rp-fn-input') ? panel.querySelector('.rp-fn-input').value : null,
        isBusy: (() => {
          const b = panel.querySelector('.dbg-row-fn button');
          return !!b && /判定中|推演中/.test(txt(b));
        })(),
        fold: fold
          ? {
              expanded: foldHead ? foldHead.getAttribute('aria-expanded') === 'true' : null,
              head: txt(foldHead),
              summary: txt(foldHead ? foldHead.querySelector('.dbg-fold-note') : null),
              bodyPresent: !!foldBody,
            }
          : null,
        assumeToggle: cb ? { present: true, checked: cb.checked } : { present: false },
        preds,
        slotRows,
        datalists: dlAll,
        secs: secs.map((s) => ({ title: txt(s.querySelector('.dbg-sec-title')), note: txt(s.querySelector('.dbg-sec-note')) })),
        resultText: res ? res.innerText : '',
        resultBadges: res ? [...res.querySelectorAll('.rp-badge')].map((x) => txt(x)) : [],
        assumeBadges: res ? [...res.querySelectorAll('.rp-badge.assume')].map((x) => txt(x)) : [],
        unknownBadges: res ? [...res.querySelectorAll('.rp-unknowns .rp-badge')].map((x) => txt(x)) : [],
        hints,
        panelText: panel.innerText,
        titleAttrs: [...panel.querySelectorAll('[title]')].map((e) => e.getAttribute('title') || ''),
      };
    })()`,
    45000,
  );
}

/**
 * 「整档体检」区读数（2026-11-05 边界批 · 车道 S4）。
 *
 * 为什么不并进 `readPanel`：这一段**只在跑过（或正在跑）体检后才存在**，还自带角色行 /
 * 全局最该看行 / 取消按钮三套骨架。把它混进主读数，会让"面板骨架不认识"的失败面变大；
 * 而这一段恰恰就是"跑得出来 / 跑不出来"的判据本身，单独一条读数更好排障。
 *
 * 角色行与「全局最该看」按钮都靠**文案/title 判据**认（没有专属 class）：
 * - 角色行：按钮文本 `K<号> <名字>`；
 * - 最该看：title = 「切到 K<号> 并判定「<函数名>」」（面板自己写的那句，见 index.ts）。
 */
async function readArchiveScan(cdp) {
  return await cdp.evalJs(
    `(() => {
      const panel = document.querySelector('.panel-state-replay');
      if (!panel) return { present: false };
      const txt = (el) => (el ? (el.textContent || '').trim() : '');
      const sec = [...panel.querySelectorAll('.dbg-sec')].find((s) => txt(s.querySelector('.dbg-sec-title')) === '整档体检');
      if (!sec) return { present: false };
      const all = [...sec.querySelectorAll('button')];
      const row = (b) => ({
        text: txt(b),
        title: b.getAttribute('title') || '',
        disabled: b.disabled === true,
      });
      const charButtons = all.filter((b) => /^K\\d+\\s/.test(txt(b))).map(row);
      const worstButtons = all
        .filter((b) => {
          const t = b.getAttribute('title') || '';
          return t.startsWith('切到 K') && t.includes('并判定');
        })
        .map((b) => ({
          ...row(b),
          charaNo: Number((b.getAttribute('title') || '').replace(/^切到 K(\\d+)[\\s\\S]*$/, '$1')),
        }));
      const expand = all.find((b) => /展开明细|收起明细/.test(txt(b)));
      return {
        present: true,
        note: txt(sec.querySelector('.dbg-sec-note')),
        notes: [...sec.querySelectorAll('.dbg-note')].map((e) => txt(e)),
        buttons: all.map(row),
        charButtons,
        worstButtons,
        expanded: expand ? /收起/.test(txt(expand)) : null,
        sectionText: sec.innerText.slice(0, 1200),
      };
    })()`,
    45000,
  );
}

/**
 * 结果区「未建模写」分桶读数（`.rp-unmodeled`；边界批把 call / jump 从逐行按钮里分出去）。
 *
 * 一次拿全三层：**head**（整句文案，含「另有 N 处调用、M 处跳转」）、**headTitle**
 * （悬停里那 3 条示例行号）、**buttons**（只该是「确定写点」的行号按钮）。
 */
async function readUnmodeled(cdp) {
  return await cdp.evalJs(
    `(() => {
      const panel = document.querySelector('.panel-state-replay');
      if (!panel) return { present: false };
      const txt = (el) => (el ? (el.textContent || '').trim() : '');
      const res = [...panel.querySelectorAll('.dbg-sec')].find((s) => txt(s.querySelector('.dbg-sec-title')) === '判定结果');
      if (!res) return { present: false, reason: 'no-result-section' };
      const note = txt(res.querySelector('.dbg-sec-note'));
      const un = res.querySelector('.rp-unmodeled');
      if (!un) return { present: false, resultNote: note, reason: 'no-unmodeled-section' };
      const headEl = un.firstElementChild;
      const lineOf = (b) => {
        const fromText = /第\\s*(\\d+)\\s*行/.exec(txt(b));
        if (fromText) return Number(fromText[1]);
        const fromTitle = /:(\\d+)\\r?\\n/.exec(b.getAttribute('title') || '');
        return fromTitle ? Number(fromTitle[1]) : null;
      };
      const buttons = [...un.querySelectorAll('.rp-unmodeled-line')].map((b) => ({
        line: lineOf(b),
        text: txt(b),
        title: b.getAttribute('title') || '',
      }));
      const tail = un.lastElementChild && un.lastElementChild !== headEl ? un.lastElementChild : null;
      return {
        present: true,
        resultNote: note,
        head: txt(headEl),
        headTitle: headEl ? headEl.getAttribute('title') || '' : '',
        buttons,
        more: txt(tail),
        fullText: un.innerText,
      };
    })()`,
    45000,
  );
}

/* ------------------------------ 取证 ------------------------------ */

async function forensics(cdp, label, outDir) {
  console.error(`[smoke] —— 取证（${label}）——`);
  try {
    const text = await cdp.evalJs(
      `(() => { const p = document.querySelector('.panel-state-replay'); return p ? p.innerText.slice(0, 2500) : document.body.innerText.slice(0, 1200); })()`,
    );
    console.error(`[smoke] 面板/屏上文本：\n${text}`);
    const outline = await cdp.evalJs(`globalThis.__rpSmoke ? __rpSmoke.outline() : '(helpers 未装)'`);
    console.error(`[smoke] 面板 DOM 骨架：\n${outline}`);
    const events = await cdp
      .evalJs(`__kojoDebug.bus.recent(80).map((e) => ({ name: e.name ?? e.type ?? '?', at: e.at ?? null })).slice(-25)`)
      .catch(() => null);
    if (events) console.error(`[smoke] 最近事件：${JSON.stringify(events)}`);
  } catch (err) {
    console.error(`[smoke] 文本取证失败：${String(err?.message ?? err)}`);
  }
  try {
    const shot = await cdp.screenshot(false);
    await fsp.mkdir(outDir, { recursive: true });
    const p = path.join(outDir, `fail-${label.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.png`);
    await fsp.writeFile(p, shot);
    console.error(`[smoke] 失败截图：${p}（${(shot.length / 1024).toFixed(0)} KB）`);
  } catch (err) {
    console.error(`[smoke] 截图取证失败：${String(err?.message ?? err)}`);
  }
}

/* ------------------------------ 交互动作 ------------------------------ */

/** 真实点击（CDP 鼠标）+ 先行滚进视口：面板在副侧栏里，折叠区可能在滚动容器下方。 */
async function realClick(cdp, selector, { optional = false } = {}) {
  const present = await cdp.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`,
  );
  if (!present) {
    if (optional) return false;
    throw new Error(`页面上没有 ${selector}（DOM 形态不认识或该控件未渲染）`);
  }
  await cdpClick(cdp, selector);
  return true;
}

/** 结果区就位、且「判定结果」段的 note（= 归一化函数名）等于 wantFn 的页内判据。 */
function resultNoteIs(wantFn) {
  return `(() => {
    const res = [...document.querySelectorAll('.panel-state-replay .dbg-sec')].find((s) => ((s.querySelector('.dbg-sec-title') || {}).textContent || '').trim() === '判定结果');
    if (!res) return false;
    const note = ((res.querySelector('.dbg-sec-note') || {}).textContent || '').trim();
    return note.toUpperCase() === ${JSON.stringify(String(wantFn).toUpperCase())};
  })()`;
}

/**
 * 点「判定」并等**这一次**的结果落地（或明确报错）。返回 { ok, note, error, busySeen, elapsedMs }。
 *
 * 为什么判据是调用方给的页面表达式，而不是"note === 函数名"一把梭：同一个函数连判两次
 * （e1 基线 → e3 勾「按 0 试算」再判）时，**旧结果的 note 早就等于目标名**——只按 note 判会
 * 当场返回旧结果，读到"没有基于假设"的假红。所以 e3 的判据是"本轮才可能出现的徽章"。
 * 顺带盯 `.rp-error`：判定报错时快速失败，不干等满预算。
 */
async function clickJudgeAndWaitFor(cdp, condition, { label = '判定结果', timeoutMs = JUDGE_MS } = {}) {
  const t0 = Date.now();
  const clicked = await cdp.evalJs(
    `(() => {
      const b = document.querySelector('.panel-state-replay .dbg-row-fn button');
      if (!b) return { ok: false, reason: 'no-button' };
      if (b.disabled) return { ok: false, reason: 'disabled' };
      b.scrollIntoView({ block: 'center' });
      return { ok: true, text: (b.textContent || '').trim() };
    })()`,
  );
  if (!clicked?.ok) return { ok: false, reason: clicked?.reason ?? 'no-button', elapsedMs: 0 };
  await cdpClick(cdp, '.panel-state-replay .dbg-row-fn button');
  let last = null;
  let busySeen = false;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(400);
    const snap = await cdp.evalJs(
      `(() => {
        const panel = document.querySelector('.panel-state-replay');
        if (!panel) return { present: false };
        const txt = (el) => (el ? (el.textContent || '').trim() : '');
        const res = [...panel.querySelectorAll('.dbg-sec')].find((s) => txt(s.querySelector('.dbg-sec-title')) === '判定结果');
        const btn = panel.querySelector('.dbg-row-fn button');
        return {
          present: true,
          busy: !!btn && /判定中/.test(txt(btn)),
          error: txt(panel.querySelector('.rp-error')),
          note: res ? txt(res.querySelector('.dbg-sec-note')) : null,
          hit: !!(${condition}),
        };
      })()`,
    );
    last = snap;
    busySeen = busySeen || snap?.busy === true;
    if (snap?.hit) return { ok: true, note: snap.note, busySeen, elapsedMs: Date.now() - t0 };
    if (snap?.error && !snap.busy && Date.now() - t0 > 4000) {
      return { ok: false, reason: 'panel-error', error: snap.error, busySeen, last, elapsedMs: Date.now() - t0 };
    }
  }
  return { ok: false, reason: `timeout(${label})`, busySeen, last, elapsedMs: Date.now() - t0 };
}

/** 等槽位输入全部为空（换函数后的重置判据）。 */
async function waitSlotsCleared(cdp, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await cdp.evalJs(
      `(() => {
        const body = document.querySelector('.panel-state-replay .dbg-fold-body');
        if (!body) return { bodyPresent: false, count: 0, values: [] };
        const inputs = [...body.querySelectorAll('.rp-slot-input')];
        return { bodyPresent: true, count: inputs.length, values: inputs.map((i) => i.value) };
      })()`,
    );
    if (last?.bodyPresent && last.count > 0 && last.values.every((v) => v === '')) return last;
    await sleep(400);
  }
  return last;
}

/**
 * 按页内表达式找元素并真点（CDP 鼠标，不是 `el.click()`）。
 *
 * `expr` 求值为 Element 或 null。两段式：先滚进视口（布局会变），隔一拍再取**滚动之后**
 * 的中心——一次性取中心会点到旧位置（面板在副侧栏，整档体检那块常在滚动容器下方）。
 * 禁用态如实返回 `disabled`（不点空处冒充成功）。
 */
async function clickMatch(cdp, expr) {
  const found = await cdp.evalJs(`(() => {
    const el = (${expr});
    if (!el) return { ok: false, reason: 'no-element' };
    if (el.disabled === true) return { ok: false, reason: 'disabled', text: (el.textContent || '').trim().slice(0, 80) };
    el.scrollIntoView({ block: 'center' });
    return { ok: true, text: (el.textContent || '').trim().slice(0, 80) };
  })()`);
  if (!found?.ok) return found ?? { ok: false, reason: 'no-element' };
  await sleep(220);
  const rect = await cdp.evalJs(`(() => {
    const el = (${expr});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!rect || !(rect.w >= 2 && rect.h >= 2)) return { ok: false, reason: 'no-rect', text: found.text };
  await cdpClick(cdp, { x: rect.x, y: rect.y });
  return { ok: true, text: found.text, x: rect.x, y: rect.y };
}

/**
 * 等「判定结果」段的 note（= 归一化函数名）变成 wantFn。
 *
 * 与 `clickJudgeAndWaitFor` 的分工：那条负责**按按钮**并发起一次判定（判据是"本轮才
 * 可能出现的东西"）；本条只负责**等结果落地**——整档体检里的「全局最该看」是面板自己
 * 切角色 + 判定的（没有可点的「判定」按钮），只能等。顺带盯 `.rp-error` 快速失败。
 */
async function waitJudgeNote(cdp, wantFn, { timeoutMs = JUDGE_MS, label = '判定结果' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(400);
    last = await cdp.evalJs(`(() => {
      const p = document.querySelector('.panel-state-replay');
      if (!p) return { present: false };
      const txt = (el) => (el ? (el.textContent || '').trim() : '');
      const res = [...p.querySelectorAll('.dbg-sec')].find((s) => txt(s.querySelector('.dbg-sec-title')) === '判定结果');
      const btn = p.querySelector('.dbg-row-fn button');
      return {
        present: true,
        busy: !!btn && /判定中/.test(txt(btn)),
        error: txt(p.querySelector('.rp-error')),
        note: res ? txt(res.querySelector('.dbg-sec-note')) : null,
      };
    })()`);
    if (last?.note && last.note.toUpperCase() === String(wantFn).toUpperCase()) {
      return { ok: true, note: last.note, elapsedMs: Date.now() - t0 };
    }
    if (last?.error && !last.busy && Date.now() - t0 > 3000) {
      return { ok: false, reason: 'panel-error', error: last.error, last, elapsedMs: Date.now() - t0 };
    }
  }
  return { ok: false, reason: `timeout(${label})`, last, elapsedMs: Date.now() - t0 };
}

/* ------------------------------ 引导 ------------------------------ */

/**
 * 开项目（只读）：目录对话框自动应答 → 真实点击「打开项目」→ 写权限审批走「只读浏览」。
 * 与 debug-cli `open-project` 同一条腿（不新造通道），只是没有 CLI 子进程那层。
 */
async function openProjectReadOnly(cdp, serverPort, corpus) {
  const res = await fetch(`http://127.0.0.1:${serverPort}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // 必须同时登记读根（readonly）与对话框应答（chooseDir）：只给 chooseDir 时宿的读域里
    // 没有这个目录，打开会在读文件阶段一路卡到超时（debug-cli 同注）。
    body: JSON.stringify({ readonly: [corpus], chooseDir: corpus }),
  });
  if (!res.ok) throw new Error(`POST /policy 失败：HTTP ${res.status}`);

  if (!(await dismissDevNoteMask(cdp))) {
    throw new Error('「开发者的碎碎念」纸条关不掉（ghost 点击未生效）——屏幕被遮罩盖住');
  }
  await waitFor(cdp, `!!document.querySelector('.welcome-open')`, { timeoutMs: 30000, label: '欢迎页打开按钮' });
  await cdpClick(cdp, '.welcome-open');

  const stage = await waitFor(
    cdp,
    `(() => {
      if (document.querySelector('.modal[aria-label="写权限确认"]')) return 'modal';
      if (document.querySelector('.file-tree')) return 'tree';
      const t = [...document.querySelectorAll('.toast-error')].map((e) => (e.textContent || '').trim()).filter(Boolean);
      if (t.length > 0) return 'toast:' + t[0];
      return '';
    })()`,
    { timeoutMs: OPEN_PROJECT_MS, intervalMs: 300, label: '写权限审批 / 文件树' },
  );
  if (typeof stage === 'string' && stage.startsWith('toast:')) {
    throw new Error(`应用拒绝了这次打开：${stage.slice(6)}`);
  }
  if (stage === 'modal') {
    // primary = 允许写入；ghost = 只读浏览。真语料只读（规范 §5）
    await cdpClick(cdp, '.modal .ghost');
  }
  await waitFor(cdp, `!!document.querySelector('.file-tree')`, { timeoutMs: OPEN_PROJECT_MS, label: '文件树' });
  const rootDir = await waitFor(cdp, `(__kojoDebug.state().project ?? {}).rootDir ?? ''`, {
    timeoutMs: OPEN_PROJECT_MS,
    label: 'project.rootDir',
  });
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(rootDir) !== norm(corpus)) {
    throw new Error(`打开的目录与请求不一致（假绿拦截）：请求 ${corpus}，实际 ${rootDir}`);
  }
  return String(rootDir);
}

/** 走「快速打开」那条腿开文件（= debug-cli open-file 的第二入口：点一行，落应用自己的 onOpenFile）。 */
async function openFile(cdp, frag) {
  const surface = {
    async openPalette() {
      await cdp.evalJs(`__kojoDebug.commands.run('workbench.quickOpen')`);
      await waitFor(cdp, `!!document.querySelector('.picker .picker-input')`, { timeoutMs: 15000, label: '快速打开面板' });
      await cdpClick(cdp, '.picker-input');
    },
    async setQuery(term) {
      await cdp.send('Input.insertText', { text: String(term ?? '') });
    },
    async readRows() {
      return await cdp.evalJs(`[...document.querySelectorAll('.picker-item')].map((el) => ({
        idx: Number(el.getAttribute('data-idx')),
        primary: (el.querySelector('.picker-primary')?.textContent || '').trim(),
        dir: (el.querySelector('.picker-secondary')?.getAttribute('title') || '').trim(),
      }))`);
    },
    async pickRow(idx) {
      await cdpClick(cdp, `.picker-item[data-idx="${idx}"]`);
    },
    async close() {
      await cdpClick(cdp, '.picker-backdrop').catch(() => {});
    },
  };
  const via = await openFileViaSearchSurface(surface, frag);
  if (!via.opened) {
    await surface.close().catch(() => {});
    throw new Error(`「快速打开」没点中「${frag}」（词=${via.term} · 候选 ${via.rows} 行 · ${via.reason}）`);
  }
  await waitFor(cdp, `!!document.querySelector('.monaco-editor')`, { timeoutMs: 60000, label: 'Monaco 挂载' });
  const want = String(frag).toLowerCase();
  const t0 = Date.now();
  let actual = null;
  while (Date.now() - t0 < 30000) {
    const info = await cdp.evalJs('__kojoDebug.editor.info()').catch(() => null);
    actual = info?.path ?? null;
    if (actual && String(actual).toLowerCase().includes(want)) return { path: String(actual), via };
    await sleep(250);
  }
  throw new Error(`点了「${frag}」那一行，30s 内编辑器没切过去——实际 path：${actual ?? 'null'}`);
}

/* ------------------------------ 语料里挑写点样本（j 组） ------------------------------ */

/**
 * 与 `packages/plugins/state-replay/src/writes.ts` **同源的判据**（这里是镜像，不是 import：
 * 本工具是 .mjs，不能吃 TS）。镜像只用来**挑样本**——"哪些行真算写点 / 真算调用"这句话
 * 的最终解释权在面板与引擎，屏上读数一律以面板输出为准（断言里对拍的就是那一边）。
 *
 * 挑样本的两条口径与任务书一致：
 * - j1：函数体里有**行首调用族**（CALL / TRYCALL…），也有**状态写**（CFLAG/TFLAG/SETBIT/VARSET…）；
 * - j2：有平跳（GOTO/JUMP 的平跳形），且**跳转行之后还有写**（否则引擎按防刷屏判据不报跳转）。
 */
const SCAN_CALL_VERBS = new Set([
  'CALL',
  'CALLEVENT',
  'CALLF',
  'CALLFORM',
  'CALLFORMF',
  'CALLSHARP',
  'CALLTRAIN',
  'TRYCALL',
  'TRYCALLF',
  'TRYCALLFORM',
  'TRYCALLFORMF',
  'TRYCALLLIST',
  'TRYCCALL',
  'TRYCCALLFORM',
]);
const SCAN_WRITE_VERBS = new Set([
  'SETBIT',
  'CLEARBIT',
  'INVERTBIT',
  'INPUT',
  'INPUTS',
  'INPUTANY',
  'INPUTMOUSEKEY',
  'ONEINPUT',
  'BINPUT',
  'BINPUTS',
  'TINPUT',
  'TINPUTS',
  'TONEINPUT',
  'TONEINPUTS',
  'ADDCHARA',
  'DELCHARA',
  'ADDCOPYCHARA',
  'SWAPCHARA',
  'SORTCHARA',
  'ADDVOIDCHARA',
  'RESETDATA',
  'RESETGLOBAL',
  'TIMES',
  'SAVEDATA',
  'SAVEGLOBAL',
  'LOADDATA',
  'LOADGLOBAL',
  'RANDOMIZE',
  'VARSET',
  'CVARSET',
  'VARSIZE',
  'ARRAYCOPY',
  'ARRAYSHIFT',
  'ARRAYREMOVE',
  'ARRAYSORT',
  'SWAP',
  'EQUIP',
  'UNEQUIP',
  'DT_CELL_SET',
  'DT_ROW_ADD',
  'MAP_SET',
  'RESET_STAIN',
]);
const SCAN_JUMP_VERBS = new Set(['GOTO', 'GOTOFORM', 'JUMP', 'JUMPFORM']);
/** 这些目标族的直线赋值**已被建模**（locals.ts / 调用上下文），不算未建模写 */
const SCAN_MODELED_TARGETS = new Set(['LOCAL', 'LOCALS', 'RESULT', 'RESULTS', 'ARG', 'ARGS']);
const SCAN_ASSIGN_RE =
  /^(?:SIF\s+\S.*?\s)?([A-Z_][A-Z0-9_]*'*)(?::([^=\s]+))?\s*(<<=|>>=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|=)(?!=)/i;
const SCAN_VERB_RE = /^([A-Z_][A-Z0-9_]*)\b/i;

/** 剥 `;!;` / `;#;` 代码前缀（与 `erbCodeBodyOf` 同口径；只为挑样本） */
function scanErbBody(raw) {
  let t = String(raw).trim();
  for (const p of [';!;', ';#;']) if (t.startsWith(p)) t = t.slice(p.length).trim();
  return t;
}

/** 去行内注释（引号外的 `;` 起注释；ERB 只有双引号字符串） */
function scanStripComment(code) {
  let quoted = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) return code.slice(0, i);
  }
  return code;
}

/**
 * 扫语料（`<corpus>/ERB/**\/*.erb`）挑 j1 / j2 的候选口上函数。
 *
 * 全量扫（本机 4,000 份 ≈ 7s）：不提前退出，`scanned` 才是 N/A 报告里那个"扫了多少份"
 * 的可信数字（j2 候选天然稀少，扫一半就说"没有"是假读数）。
 * 候选里只留 `M_KOJO_*`（口上函数，确定在条件索引里）；按"有条件的、体量小的"排序，
 * 判定更快、结果也更有意义；同分按名字定序，保证复跑取同一个样本。
 */
async function scanCorpusWriteSamples(corpus, { cap = 400 } = {}) {
  const files = [];
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.erb$/i.test(e.name)) files.push(p);
    }
  };
  await walk(path.join(corpus, 'ERB'));
  const j1 = [];
  const j2 = [];
  let scanned = 0;
  for (const file of files) {
    scanned += 1;
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let cur = null;
    const flush = () => {
      if (cur === null) return;
      const { name, start, end, calls, jumps, writes, conds } = cur;
      if (!/^M_KOJO_/i.test(name)) return;
      const base = { name, file, start, bodyLines: end - start + 1, conds };
      if (calls.length > 0 && writes.length > 0 && j1.length < cap) {
        j1.push({ ...base, callLines: calls.slice(), jumpLines: jumps.slice(), concreteCount: writes.length });
      }
      if (jumps.length > 0) {
        const jumpLines = jumps.filter((j) => writes.some((w) => w > j));
        if (jumpLines.length > 0 && j2.length < cap) {
          j2.push({ ...base, jumpLine: jumpLines[0], jumpLines, callLines: calls.slice(), concreteCount: writes.length });
        }
      }
    };
    let inSkip = false;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (/^@/.test(raw)) {
        flush();
        cur = {
          name: raw.slice(1).split(/[(\s,]/)[0].trim(),
          start: i + 1,
          end: i + 1,
          calls: [],
          jumps: [],
          writes: [],
          conds: 0,
        };
        inSkip = false;
        continue;
      }
      if (cur === null) continue;
      cur.end = i + 1;
      const body = scanErbBody(raw);
      if (inSkip) {
        if (body === '[SKIPEND]') inSkip = false;
        continue;
      }
      if (body === '[SKIPSTART]') {
        inSkip = true;
        continue;
      }
      if (body === '') continue;
      const head = body.charAt(0);
      if (head === ';' || head === '#' || head === '$') continue;
      const code = scanStripComment(body).trim();
      if (code === '') continue;
      if (/^(IF|ELSEIF|SIF|SELECTCASE)\b/i.test(code)) cur.conds += 1;
      const assign = SCAN_ASSIGN_RE.exec(code);
      if (assign) {
        const target = assign[1].replace(/'/g, '').toUpperCase();
        if (!SCAN_MODELED_TARGETS.has(target)) cur.writes.push(i + 1);
        continue;
      }
      const verb = SCAN_VERB_RE.exec(code);
      if (!verb) continue;
      const upper = verb[1].toUpperCase();
      if (SCAN_CALL_VERBS.has(upper)) {
        cur.calls.push(i + 1);
        continue;
      }
      if (SCAN_JUMP_VERBS.has(upper)) {
        cur.jumps.push(i + 1);
        continue;
      }
      if (SCAN_WRITE_VERBS.has(upper)) cur.writes.push(i + 1);
    }
    flush();
  }
  const order = (a, b) => (b.conds > 0 ? 1 : 0) - (a.conds > 0 ? 1 : 0) || a.bodyLines - b.bodyLines || (a.name < b.name ? -1 : 1);
  j1.sort(order);
  j2.sort(order);
  return { scanned, j1, j2 };
}

/** 从悬停 title 里抠「调用 3 处（示例：第 12、15 行）」的示例行号（面板自己的读数） */
function sampleLinesFromTitle(title, verb) {
  const m = new RegExp(`${verb}\\s*\\d+\\s*处(?:（示例：第\\s*([\\d、]+)\\s*行）)?`).exec(String(title ?? ''));
  if (!m || m[1] === undefined) return [];
  return m[1]
    .split('、')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/**
 * 依次试候选函数，直到结果区出现目标分桶（head 里有「另有 … 处调用/跳转」）。
 *
 * 为什么要换样本：语料里"含 CALL + 状态写"的函数很多，但**能不能被判出来**还取决于
 * 它有没有可判定的条件（没有就是面板那句"没有登记到可判定的条件"）。等的时候只等
 * 结果 note（快），分桶文案另外读——否则一个没有未建模写段的函数会把预算耗满。
 */
async function judgeWriteSample(cdp, candidates, { verb, label, maxTries = 4 }) {
  const attempts = [];
  const wantHead = new RegExp(`另有[^。]*\\d+\\s*处${verb}`);
  for (const cand of candidates.slice(0, maxTries)) {
    await cdp.evalJs(`__rpSmoke.setInput('.rp-fn-input', ${JSON.stringify(cand.name)})`);
    await sleep(400);
    const judged = await clickJudgeAndWaitFor(cdp, resultNoteIs(cand.name), { label: `${label} ${cand.name}` });
    const un = await readUnmodeled(cdp);
    attempts.push({
      name: cand.name,
      ok: judged.ok,
      reason: judged.ok ? '' : judged.reason,
      error: judged.error ?? '',
      head: un.present ? un.head : '(结果区没有未建模写段)',
    });
    if (judged.ok && un.present && wantHead.test(un.head)) return { candidate: cand, judge: judged, un, attempts };
  }
  return { candidate: null, attempts, un: await readUnmodeled(cdp) };
}

/** 从 ERB 正文取**活的**函数名（跳过 `[SKIPSTART]`…`[SKIPEND]`：抽取侧不发布那区里的函数） */
function liveKojoFunctions(text) {
  const out = [];
  let inSkip = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const body = scanErbBody(raw);
    if (body === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (body === '[SKIPEND]') {
      inSkip = false;
      continue;
    }
    if (inSkip) continue;
    if (!raw.startsWith('@')) continue;
    const name = raw.slice(1).split(/[(\s,]/)[0].trim();
    if (/^M_KOJO_[A-Z0-9_]+$/i.test(name)) out.push(name);
  }
  return out;
}

/* ------------------------------ 主流程 ------------------------------ */

let OPTS = { project: null, out: null, keep: false, headful: false };

const ctx = {};

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`[smoke] ${err.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  OPTS = opts;
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(opts.out ?? path.join(REPO, '.arts', 'replay-panel-smoke', stamp));
  await fsp.mkdir(outDir, { recursive: true });
  console.log(`[smoke] 截图目录：${outDir}`);

  /* ---------- 前置：浏览器 / vite / 语料 ---------- */
  const budget = resolveMemoryBudget();
  if (budget.budgetMb < MEMORY_TIGHT_MB) {
    console.warn(
      `[smoke] [warn] 内存预算 ${budget.budgetMb} MB（${memorySourceLabel(budget.source)}）低于 ${MEMORY_TIGHT_MB} MB：` +
        '本链路 + 真语料索引很容易被容器 OOM 杀掉浏览器（不是编辑器 bug）',
    );
  }
  const browser = findBrowser(null);
  if (!browser) {
    console.error('[FAIL] 前置不满足：本机没找到 Chrome/Edge（可用 KOJO_DEBUG_BROWSER 指定）——exit 2');
    process.exit(2);
  }
  const viteBin = path.join(REPO, 'packages', 'app', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    console.error(`[FAIL] 前置不满足：vite 不在位（${viteBin}）——先 pnpm install ——exit 2`);
    process.exit(2);
  }

  let corpus;
  try {
    const envScan = (process.env.KOJO_CORPUS_SCAN_DIRS || '').trim();
    // 默认扫盘根：C:/game（语料模块的默认）之外补 D:/Game（本机真实语料所在）。
    // 设了 KOJO_CORPUS_SCAN_DIRS 就完全交给模块自己的口径，不叠默认值。
    corpus = resolveCorpusDir({
      explicit: opts.project ?? undefined,
      needSaves: true,
      print: true,
      label: 'smoke',
      ...(envScan ? {} : { scanRoots: ['C:/game', 'D:/Game'] }),
    });
  } catch (err) {
    if (!(err instanceof CorpusError)) throw err;
    console.error(`[FAIL] 语料解析失败：${err.message}——exit 2`);
    process.exit(2);
  }
  if (!corpus) {
    console.error(`[FAIL] 前置不满足：盘上没找到符合内容条件的语料（需 ERB/ + CSV/ + sav/ 非空）。${corpusHint()}——exit 2`);
    process.exit(2);
  }
  const corpusInfo = inspectCorpus(corpus, { needSaves: true });
  if (!corpusInfo) {
    console.error(`[FAIL] 前置不满足：${corpus} 不是可用的语料（内容条件不满足）——exit 2`);
    process.exit(2);
  }
  console.log(`[smoke] 浏览器：${browser}`);
  console.log(`[smoke] 语料：${corpus}（ERB ${corpusInfo.erbCount} / sav ${corpusInfo.savCount} 件）`);

  /* ---------- 环境 ---------- */
  await rmRetry(WORK);
  ctx.sandbox = path.join(WORK, 'sandbox');
  ctx.appdata = path.join(WORK, 'appdata');
  await fsp.mkdir(ctx.sandbox, { recursive: true });
  await fsp.mkdir(ctx.appdata, { recursive: true });

  const server = await createDebugServer({
    port: 0,
    sandbox: ctx.sandbox,
    appdata: ctx.appdata,
    // 只读根：真语料盘整体只读（规范 §5）。宿的写域仍只有 sandbox/appdata。
    readonly: [corpus],
    log: () => {},
  });
  cleanupAll.push(() => server.close());
  ctx.server = server;
  console.log(`[smoke] 调试宿 :${server.port}`);

  ctx.vitePort = await freePort(4273);
  const vite = spawn(
    process.execPath,
    [viteBin, '--port', String(ctx.vitePort), '--strictPort', '--host', '127.0.0.1'],
    { cwd: path.join(REPO, 'packages', 'app'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(vite);
  let viteLog = '';
  vite.stdout.on('data', (d) => (viteLog += d.toString()));
  vite.stderr.on('data', (d) => (viteLog += d.toString()));
  for (let i = 0; i < 160 && !(await portOpen(ctx.vitePort)); i++) await sleep(500);
  if (!(await portOpen(ctx.vitePort))) {
    console.error(`[FAIL] vite 80s 没就绪：\n${viteLog.slice(-800)}`);
    await shutdown(1);
  }
  console.log(`[smoke] vite :${ctx.vitePort}`);

  ctx.cdpPort = await freePort(9533);
  const profile = path.join(WORK, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  ctx.url = `http://127.0.0.1:${ctx.vitePort}/?kojo-debug=${server.port}`;
  const browserProc = spawn(
    browser,
    [
      `--remote-debugging-port=${ctx.cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(opts.headful ? [] : ['--headless=new']),
      '--window-size=1600,1000',
      ctx.url,
    ],
    { stdio: 'ignore' },
  );
  children.push(browserProc);
  for (let i = 0; i < 80 && !(await portOpen(ctx.cdpPort)); i++) await sleep(400);
  if (!(await portOpen(ctx.cdpPort))) {
    console.error('[FAIL] 浏览器 CDP 32s 没就绪');
    await shutdown(1);
  }

  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    page = await cdpPage(ctx.cdpPort, ctx.vitePort).catch(() => null);
    if (!page) await sleep(500);
  }
  if (!page) {
    console.error('[FAIL] CDP 页面拿不到（vite 端口上没有属于本轮的页面）');
    await shutdown(1);
  }
  ctx.page = page;
  const cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
  ctx.cdp = cdp;
  console.log(`[smoke] 页面：${page.url}`);

  try {
    const c = ctx;
    await waitFor(cdp, `location.href !== 'about:blank'`, { timeoutMs: 30000, label: '页面导航落定' });
    const href = await assertPageOrigin(cdp, `http://127.0.0.1:${c.vitePort}`);
    console.log(`[smoke] 页面 origin 钉死：${href}`);
    await waitFor(cdp, '!!document.querySelector(".welcome")', { timeoutMs: 30000, label: '欢迎页' });
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 20000, label: '__kojoDebug' });
    await installPageHelpers(cdp);

    /* ---------- 引导：开只读项目 + 开一份口上文件 ---------- */
    const rootDir = await openProjectReadOnly(cdp, server.port, corpus);
    check('项目已只读打开', !!rootDir, `${rootDir}（写权限审批＝只读浏览）`);

    const opened = await openFile(cdp, KOJO_FILE_FRAG);
    check(
      '口上文件已打开（快速打开那条腿 + editor.info().path 对拍）',
      String(opened.path).includes(KOJO_FILE_FRAG),
      `${path.basename(opened.path)}（候选 ${opened.via.rows} 行 / 词=${opened.via.term}）`,
    );

    /* ================= a. 打开「状态回放」面板 ================= */
    await cdp.evalJs(`__kojoDebug.commands.run('workbench.stateReplay')`, 60000);
    const panelOk = await waitFor(cdp, `!!document.querySelector('.panel-state-replay')`, {
      timeoutMs: PANEL_MS,
      label: '状态回放面板挂载',
    })
      .then(() => true)
      .catch(() => false);
    let snap = panelOk ? await readPanel(cdp) : { present: false };
    if (!snap.present) {
      await forensics(cdp, 'a-面板未挂载', outDir);
      check('a 能打开「状态回放」面板', false, '`.panel-state-replay` 不在场（workbench.stateReplay 未挂载面板）');
      throw new Error('面板没挂上，后续步骤的前置不成立');
    }
    check(
      'a 能打开「状态回放」面板',
      snap.title === '状态回放',
      `标题=${JSON.stringify(snap.title)} · 副标题=${JSON.stringify(snap.sub)} · 空态=${snap.panelText.includes('尚未判定') ? '尚未判定' : '—'}`,
    );

    /* ================= b. 选存档 + 选角色 K49 → 视图就绪 ================= */
    const charaOpts = await cdp.evalJs(`__rpSmoke.optionsOf('选择角色')`);
    const k49 = Array.isArray(charaOpts) ? charaOpts.find((o) => /^K49\b/.test(o.text)) : null;
    check('b0 角色表里有 K49（觉）', !!k49, k49 ? `选项=${JSON.stringify(k49.text)} · 角色共 ${charaOpts.length - 1} 位` : `角色选项=${JSON.stringify(charaOpts)}`);
    if (!k49) throw new Error('角色表里没有 K49——语料不对或角色表没加载');

    await cdp.evalJs(`__rpSmoke.setSelect('选择角色', ${JSON.stringify(k49.value)})`);
    // 存档清单是异步扫描的：先等下拉里出现真实条目
    const archReady = await waitFor(
      cdp,
      `(() => { const o = __rpSmoke.optionsOf('选择存档'); return o && o.length > 1 ? o.length : 0; })()`,
      { timeoutMs: 120000, label: '存档清单' },
    )
      .then(() => true)
      .catch(() => false);
    const archOpts = (await cdp.evalJs(`__rpSmoke.optionsOf('选择存档')`)) ?? [];
    check(
      'b0′ 存档清单扫到了真实条目',
      archReady && archOpts.length > 1,
      `${Math.max(0, archOpts.length - 1)} 件：${archOpts.slice(1, 6).map((o) => o.text).join(' · ')}`,
    );

    // 逐个试档：真语料里 global.sav 可能是全局档、解析不出角色视图；能建视图的那份才是本次的档。
    let viewOk = null;
    const tried = [];
    for (const opt of archOpts.filter((o) => o.value !== '')) {
      await cdp.evalJs(`__rpSmoke.setSelect('选择存档', ${JSON.stringify(opt.value)})`);
      const got = await waitFor(
        cdp,
        `(() => {
          const el = document.querySelector('.panel-state-replay .rp-status');
          const t = el ? (el.textContent || '').trim() : '';
          if (t.includes('视图就绪')) return t;
          if (t.includes('视图建立失败')) return 'ERR:' + t;
          return '';
        })()`,
        { timeoutMs: VIEW_MS, intervalMs: 400, label: '视图就绪' },
      ).catch(() => null);
      tried.push(`${opt.text}:${got ? (String(got).startsWith('ERR:') ? String(got).slice(0, 80) : 'ok') : 'timeout'}`);
      if (got && !String(got).startsWith('ERR:')) {
        viewOk = { archive: opt, status: String(got) };
        break;
      }
    }
    snap = await readPanel(cdp);
    const viewBase = viewOk ? path.basename(viewOk.archive.value) : null;
    check(
      'b 选存档 + 选角色 K49 后视图就绪',
      !!viewOk && snap.charaValue === String(CHARA_NO) && /视图就绪/.test(snap.status) && /K49/.test(snap.status),
      viewOk
        ? `存档=${viewBase} · 角色=${snap.charaValue} · ${viewOk.status}`
        : `一条档都没建起视图：${tried.join(' | ')}`,
    );
    if (!viewOk) throw new Error('没有可用存档视图，后续判定无从谈起');

    /* ================= c. ARGS 分派函数 → 判定 → 未知文案 ================= */
    const setFnA = await cdp.evalJs(`__rpSmoke.setInput('.rp-fn-input', ${JSON.stringify(FN_ARGS)})`);
    check('c0 函数名输入框可写（React 受控 onChange 真触发）', setFnA?.ok === true && setFnA.value === FN_ARGS, JSON.stringify(setFnA));
    // 等函数明细到货（并集槽位依赖它；真语料首轮要建条件索引）
    const detailA = await waitFor(
      cdp,
      `(() => {
        const s = document.querySelector('.panel-state-replay .dbg-fold');
        return s ? 'fold' : '';
      })()`,
      { timeoutMs: JUDGE_MS, intervalMs: 500, label: '函数明细 / 场景参数折叠区' },
    )
      .then(() => true)
      .catch(() => false);
    check('c0′ 函数明细到货（「场景参数」折叠区出现）', detailA, detailA ? '折叠区在场' : '等不到折叠区（明细或槽位并集没算出来）');

    const judgeA = await clickJudgeAndWaitFor(cdp, resultNoteIs(FN_ARGS), { label: `${FN_ARGS} 判定结果` });
    snap = await readPanel(cdp);
    if (!judgeA.ok) await forensics(cdp, 'c-判定失败', outDir);
    check(
      'c1 判定执行并出结果',
      judgeA.ok,
      judgeA.ok
        ? `${judgeA.elapsedMs}ms · 归一化名=${judgeA.note} · 谓词 ${snap.preds.length} 条`
        : `${judgeA.reason} · ${judgeA.error ?? JSON.stringify(judgeA.last)?.slice(0, 240)}`,
    );

    const NEW_UNKNOWN = '面板没给这一格填值';
    const OLD_UNKNOWN = '注入的实参只填了部分槽位';
    const newHits = snap.preds.filter((p) => p.title.includes(NEW_UNKNOWN) || p.text.includes(NEW_UNKNOWN));
    const oldHits = [
      ...snap.preds.filter((p) => p.title.includes(OLD_UNKNOWN) || p.text.includes(OLD_UNKNOWN)).map((p) => `谓词:${p.text.slice(0, 60)}`),
      ...snap.titleAttrs.filter((t) => t.includes(OLD_UNKNOWN)).map((t) => `title:${t.slice(0, 60)}`),
      ...(snap.panelText.includes(OLD_UNKNOWN) ? ['面板正文'] : []),
    ];
    check(
      'c2 未知文案＝「面板没给这一格填值」',
      newHits.length > 0,
      newHits.length > 0
        ? `${newHits.length} 条谓词带这句 · 例：${newHits[0].text.slice(0, 60)} | ${newHits[0].title.slice(0, 120)}`
        : `0 条（判不出的谓词=${snap.preds.filter((p) => p.outcome === '未知').length} 条；未知徽章=${JSON.stringify(snap.unknownBadges)}）`,
    );
    check(
      'c3 旧文案「注入的实参只填了部分槽位」零出现',
      oldHits.length === 0,
      oldHits.length === 0 ? '面板正文/全部 title 属性都扫过' : JSON.stringify(oldHits.slice(0, 4)),
    );

    /* ================= d. 「场景参数」折叠区 / ARGS 输入框 / datalist ================= */
    const expanded = await cdp.evalJs(
      `(() => {
        const h = document.querySelector('.panel-state-replay .dbg-fold-head');
        if (!h) return { present: false };
        if (h.getAttribute('aria-expanded') !== 'true') { h.scrollIntoView({ block: 'center' }); h.click(); }
        return { present: true, wasOpen: h.getAttribute('aria-expanded') === 'true' };
      })()`,
    );
    await sleep(500);
    snap = await readPanel(cdp);
    const argsRow = snap.slotRows.find((r) => /ARGS?\s*:/.test(r.label) && /ARGS/.test(r.label)) ?? snap.slotRows.find((r) => r.label.includes('ARGS'));
    check(
      'd1 「场景参数」折叠区里出现 ARGS 输入框（并集槽位）',
      expanded?.present === true && snap.fold?.expanded === true && snap.fold?.bodyPresent === true && snap.slotRows.length > 0 && !!argsRow,
      `折开=${JSON.stringify(expanded)} · 展开=${snap.fold?.expanded} · 摘要=${JSON.stringify(snap.fold?.summary)} · 槽位 ${snap.slotRows.length} 项：` +
        snap.slotRows.map((r) => `${r.label}${r.value === '' ? '(空)' : `=${r.value}`}`).join(' / ') +
        ` · ARGS 行=${argsRow ? JSON.stringify(argsRow.label) : '缺失'}`,
    );

    // 候选 datalist 自洽（任务口径「有候选时」）：判定依据是**元素自己的 title 声称有候选**
    // ——`这个槽在函数里比过的值：…「点输入框可选」`。声称有候选却不挂 list、或 list 指向
    // 不存在的 datalist / 空 datalist，都是接线 bug；不声称就如实记成 N/A（本函数没有
    // 「槽 == 字面量」比较时这是正确读数，不是失败）。
    const claims = snap.slotRows.filter((r) => r.title.includes('这个槽在函数里比过的值'));
    const linked = claims.filter((r) => r.listId && r.listOptions > 0);
    const broken = claims.filter((r) => !r.listId || r.listOptions <= 0);
    if (claims.length === 0) {
      // 不判绿也不判红：没有候选是**正确读数**（本函数没有「槽 == 字面量/常量」比较），
      // 假绿比缺一项更糟——所以只记 N/A。
      note(`d2 N/A：本函数槽位没有「槽 == 字面量/常量」候选（datalist 共 ${snap.datalists.length} 组，槽位 title 未声称候选）`);
    } else {
      check(
        'd2 候选 datalist（有候选时输入框必须挂上）',
        broken.length === 0 && linked.length === claims.length,
        `声称有候选 ${claims.length} 项 · 挂上且有选项 ${linked.length} 项 · 断链 ${JSON.stringify(broken.map((b) => ({ label: b.label, listId: b.listId, options: b.listOptions })))} · datalist=${JSON.stringify(snap.datalists)}`,
      );
    }

    /* ================= e. 勾「按默认场景 0 试算」→「基于假设」 ================= */
    // 换成条件里确定性读数值槽的函数：FN_ARGS 那段只读 ARGS（字符串），勾开关不会把任何
    // 谓词标成假设（假设值没被任何谓词读到时不该出现徽章——这本身是正确口径）。
    await cdp.evalJs(`__rpSmoke.setInput('.rp-fn-input', ${JSON.stringify(FN_INT_ARG)})`);
    const toggleReady = await waitFor(
      cdp,
      `(() => { const cb = document.querySelector('.panel-state-replay .dbg-fold-body input[type="checkbox"]'); return cb ? 'yes' : ''; })()`,
      { timeoutMs: 120000, intervalMs: 400, label: '「按默认场景 0 试算」开关' },
    )
      .then(() => true)
      .catch(() => false);
    snap = await readPanel(cdp);
    check(
      'e0 换到读数值槽的函数后「按默认场景 0 试算」开关在场且默认未勾',
      toggleReady && snap.assumeToggle.present === true && snap.assumeToggle.checked === false,
      `开关=${JSON.stringify(snap.assumeToggle)} · 槽位=${snap.slotRows.map((r) => `${r.label}=${JSON.stringify(r.value)}`).join(' / ') || '—'}`,
    );
    if (toggleReady) {
      const base = await clickJudgeAndWaitFor(cdp, resultNoteIs(FN_INT_ARG), { label: `${FN_INT_ARG} 基线判定` });
      check('e1 基线判定（未勾假设）出结果', base.ok, base.ok ? `${base.elapsedMs}ms · ${base.note}` : `${base.reason} · ${base.error ?? ''}`);

      await realClick(cdp, '.panel-state-replay .dbg-fold-body input[type="checkbox"]');
      await sleep(300);
      const after = await readPanel(cdp);
      check('e2 开关点上了（checked=true 真落到 React state）', after.assumeToggle.checked === true, JSON.stringify(after.assumeToggle));

      // 这一次的判据不能是"note 等于函数名"：旧结果的 note 早就是它了（见 clickJudgeAndWaitFor
      // 头注）。本轮只可能出现的东西是**假设徽章**——就等它。
      const assumeCond = `(() => {
        const res = [...document.querySelectorAll('.panel-state-replay .dbg-sec')].find((s) => ((s.querySelector('.dbg-sec-title') || {}).textContent || '').trim() === '判定结果');
        if (!res) return false;
        const note = ((res.querySelector('.dbg-sec-note') || {}).textContent || '').trim().toUpperCase();
        if (note !== ${JSON.stringify(FN_INT_ARG.toUpperCase())}) return false;
        return [...res.querySelectorAll('.rp-badge.assume')].some((x) => ((x.textContent || '').trim()) === '基于假设');
      })()`;
      const assumedJudge = await clickJudgeAndWaitFor(cdp, assumeCond, { label: '勾假设后的判定结果（基于假设）' });
      snap = await readPanel(cdp);
      if (!assumedJudge.ok) await forensics(cdp, 'e-假设判定失败', outDir);
      check(
        'e3 勾「按默认场景 0 试算」后结果区出现「基于假设」',
        assumedJudge.ok && snap.assumeBadges.includes('基于假设'),
        assumedJudge.ok
          ? `结果区徽章=${JSON.stringify(snap.assumeBadges)} · 槽位行假设徽章=${snap.slotRows.filter((r) => r.hasAssumeBadge).length} 项 · 谓词里带「基于假设」=${snap.preds.filter((p) => p.badges.includes('基于假设')).length} 条`
          : `等不到「基于假设」：${assumedJudge.reason} · busySeen=${assumedJudge.busySeen} · note=${JSON.stringify(assumedJudge.note)} · error=${assumedJudge.error ?? ''} · 结果区徽章=${JSON.stringify(snap.resultBadges.slice(0, 12))} · 谓词=${JSON.stringify(snap.preds.slice(0, 4).map((p) => p.text))}`,
      );
      if (!assumedJudge.ok) {
        note(`e3 旁证：结果区正文首段=${JSON.stringify(snap.resultText.slice(0, 200))}`);
      }
    }

    /* ================= f. 换一个函数 → 槽位输入被重置（为空） ================= */
    // 先往当前槽位里塞个值：不塞就看不出"重置"（空→空 不算证据）。
    const filled = await cdp.evalJs(
      `(() => {
        const body = document.querySelector('.panel-state-replay .dbg-fold-body');
        const input = body ? body.querySelector('.rp-slot-input') : null;
        if (!input) return { ok: false, reason: 'no-slot-input' };
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(input, '77');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: input.value, label: (input.closest('label.rp-slot')?.querySelector('.rp-slot-idx')?.textContent || '').trim() };
      })()`,
    );
    check('f0 槽位输入框可手填（作者场景值真的进 state）', filled?.ok === true && filled.value === '77', JSON.stringify(filled));

    await cdp.evalJs(`__rpSmoke.setInput('.rp-fn-input', ${JSON.stringify(FN_ARGS)})`);
    const cleared = await waitSlotsCleared(cdp);
    snap = await readPanel(cdp);
    check(
      'f 换一个函数 → 槽位输入被重置（全空）',
      cleared?.bodyPresent === true && cleared.count > 0 && cleared.values.every((v) => v === ''),
      cleared?.bodyPresent
        ? `函数=${FN_ARGS} · 槽位 ${cleared.count} 项 · 值=${JSON.stringify(cleared.values)}（换前手填=${JSON.stringify(filled?.value)}）`
        : `折叠体不在场：${JSON.stringify(cleared)}`,
    );

    /* ================= g. 口径提示 / 未建模写 / INLINE 与 call-context 计数 ================= */
    const judgeG = await clickJudgeAndWaitFor(cdp, resultNoteIs(FN_ARGS), { label: `${FN_ARGS} 判定结果` });
    snap = await readPanel(cdp);
    check(
      'g1 结果区有缓冲文本口径提示（2026-11-05 批已把「读盘」改成「缓冲/磁盘」二选一）',
      snap.panelText.includes('有未保存编辑时按编辑器缓冲文本判定'),
      snap.panelText.includes('有未保存编辑时按编辑器缓冲文本判定')
        ? '提示在场（选择区常驻口径）'
        : `面板正文没这句；hints=${JSON.stringify(snap.hints)}`,
    );
    check(
      'g2 未建模写口径在场（按函数入口时刻的存档求值）',
      snap.panelText.includes('按函数入口时刻的存档求值'),
      snap.panelText.includes('按函数入口时刻的存档求值')
        ? '提示在场（函数体写不建模）'
        : `hints=${JSON.stringify(snap.hints)}`,
    );

    const inlinePreds = snap.preds.filter((p) => p.kind === 'INLINE');
    if (inlinePreds.length > 0) {
      check(
        'g3 有 INLINE 谓词时，结果区给出「未参与统计」提示',
        /另有\s*\d+\s*条行内三元条件未参与统计/.test(snap.resultText),
        `INLINE ${inlinePreds.length} 条 · 结果区首段=${JSON.stringify(snap.resultText.slice(0, 120))}`,
      );
    } else {
      note(`g3 N/A：${FN_ARGS} 的判定结果里没有 INLINE 谓词（${snap.preds.length} 条谓词，种类=${JSON.stringify([...new Set(snap.preds.map((p) => p.kind))])}）`);
    }

    const callCtxBadge = snap.unknownBadges.find((t) => t.includes('这一格由本次调用的实参决定'));
    if (callCtxBadge) {
      check(
        'g4 有 call-context 未知计数时，结果区给出「调用上下文没给」汇总',
        /条判不出是因为「调用上下文」没给/.test(snap.resultText),
        `未知徽章=${JSON.stringify(snap.unknownBadges)} · 结果区=${JSON.stringify(snap.resultText.slice(0, 160))}`,
      );
    } else {
      note(`g4 N/A：本次结果没有 call-context 未知徽章（未知徽章=${JSON.stringify(snap.unknownBadges)}）`);
    }
    check(
      'g5 判定确实出了结果（g 组读数是基于真结果的）',
      judgeG.ok && snap.preds.length > 0,
      judgeG.ok ? `谓词 ${snap.preds.length} 条 · 置信度徽章=${JSON.stringify(snap.resultBadges.slice(0, 6))}` : `${judgeG.reason} · ${judgeG.error ?? ''}`,
    );

    /* ================= i. 整档体检（本档全部角色，2026-11-05 边界批 · 车道 S4） ================= */
    // 判据全是屏上事实：`.dbg-row-fn` 里有一颗「整档体检（本档全部角色）」按钮（title 写明
    // 预算）；点下去能真跑完并出摘要；摘要展开后角色行 / 全局最该看可点（点了真切角色并判定）；
    // 再点一次能在 busy 期取消（已扫部分照常汇总，摘要带「已取消」）。
    const ARCHIVE_BTN_TEXT = '整档体检（本档全部角色）';
    const fnRow = await cdp.evalJs(
      `(() => {
        const row = document.querySelector('.panel-state-replay .dbg-row-fn');
        if (!row) return { present: false };
        const txt = (el) => (el ? (el.textContent || '').trim() : '');
        return {
          present: true,
          buttons: [...row.querySelectorAll('button')].map((b) => ({
            text: txt(b),
            title: b.getAttribute('title') || '',
            disabled: b.disabled === true,
          })),
        };
      })()`,
    );
    const archiveBtn = (fnRow?.buttons ?? []).find((b) => b.text.includes(ARCHIVE_BTN_TEXT)) ?? null;
    check(
      'i1 整档体检入口在场（按钮文案 + title 写明预算，含「每角色」与「封顶」）',
      !!archiveBtn && archiveBtn.title.includes('每角色') && archiveBtn.title.includes('封顶'),
      archiveBtn
        ? `文案=${JSON.stringify(archiveBtn.text)} · disabled=${archiveBtn.disabled} · title=${JSON.stringify(archiveBtn.title)}`
        : `没有这颗按钮；.dbg-row-fn 现有=${JSON.stringify((fnRow?.buttons ?? []).map((b) => b.text))}`,
    );

    /** 整档体检区的定位表达式（没有专属 class，按段标题认；与 readArchiveScan 同一判据） */
    const scanSectionExpr = `(() => {
      const p = document.querySelector('.panel-state-replay');
      if (!p) return null;
      const txt = (el) => (el ? (el.textContent || '').trim() : '');
      return [...p.querySelectorAll('.dbg-sec')].find((s) => txt(s.querySelector('.dbg-sec-title')) === '整档体检') ?? null;
    })()`;
    const scanButtonExpr = (want) => `(() => {
      const sec = ${scanSectionExpr};
      if (!sec) return null;
      const w = ${JSON.stringify(want)};
      return [...sec.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes(w)) ?? null;
    })()`;
    /** 摘要行（常驻）：`已扫 A/B 角色 · N 段 · 完全 x / 部分 y / 全未知 z · 耗时 t ms[ · 已取消]` */
    const scanNoteExpr = `(() => {
      const sec = ${scanSectionExpr};
      if (!sec) return '';
      const el = sec.querySelector('.dbg-sec-note');
      return el ? (el.textContent || '').trim() : '';
    })()`;
    /** 整档体检自己的红字（报错时摘要行只会说「上次整档体检失败」，原因在这里） */
    const scanErrorExpr = `(() => {
      const sec = ${scanSectionExpr};
      if (!sec) return '';
      const el = sec.querySelector('.rp-error');
      return el ? (el.textContent || '').trim() : '';
    })()`;
    const archiveBtnExpr = `(() => {
      const row = document.querySelector('.panel-state-replay .dbg-row-fn');
      if (!row) return null;
      return [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes(${JSON.stringify(ARCHIVE_BTN_TEXT)})) ?? null;
    })()`;

    /**
     * 等按钮**可用**再点：它被 `condIndex === null` 灰着，而条件索引是**全语料抽取**
     * （本机 4,072 ERB / 近 50 万谓词），真机上要几十秒起。这不是本次要测的东西，
     * 但"灰着多久"本身是读数，所以计时上报。
     *
     * 为什么要顺手制造一次无害重渲：面板只读 `extractor.currentIndex()`、**没有**订阅
     * 索引更新（`ConditionExtractorService.subscribe` 在场但没人用）；索引建完不会自己
     * 叫醒 React。折/展「场景参数」是一次无害 state 变更，能把最新的 `currentIndex()`
     * 带进下一帧——否则这颗按钮可能一直灰到别的动作碰巧触发重渲。
     */
    const readyT0 = Date.now();
    let archiveReady = false;
    let nudges = 0;
    while (Date.now() - readyT0 < ARCHIVE_INDEX_MS) {
      const st = await cdp.evalJs(`(() => {
        const row = document.querySelector('.panel-state-replay .dbg-row-fn');
        if (!row) return { present: false };
        const b = [...row.querySelectorAll('button')].find((x) => (x.textContent || '').trim().includes(${JSON.stringify(ARCHIVE_BTN_TEXT)}));
        return { present: !!b, disabled: b ? b.disabled === true : null };
      })()`);
      if (st?.present && st.disabled === false) {
        archiveReady = true;
        break;
      }
      nudges += 1;
      await cdp
        .evalJs(`(() => { const h = document.querySelector('.panel-state-replay .dbg-fold-head'); if (h) h.click(); return true; })()`)
        .catch(() => {});
      await sleep(2000);
    }
    const archiveReadyMs = Date.now() - readyT0;
    if (archiveReady) {
      note(`i2 前置：整档体检按钮等了 ${(archiveReadyMs / 1000).toFixed(1)}s 才可用（条件索引＝全语料抽取；期间强制重渲 ${nudges} 次）`);
    } else {
      check(
        'i2 整档体检能跑完并出摘要（已扫 > 0 角色 · 含「全未知」计数）',
        false,
        `${(ARCHIVE_INDEX_MS / 1000).toFixed(0)}s 内按钮一直 disabled（condIndex 未就绪 / 索引没建完）——整档体检这颗入口在真语料上不可达`,
      );
    }

    const scanT0 = Date.now();
    const scanClick = archiveReady ? await clickMatch(cdp, archiveBtnExpr) : { ok: false, reason: 'disabled' };
    /**
     * 边等边采样进度行（1s 一拍，只记变化）：整档体检的耗时是这条链上最大的未知数，
     * 超时时必须能说清"卡在哪、推进了多少"——只报一句 timeout 是没用的读数。
     */
    const scanSamples = [];
    let scanNote = { ok: false, error: 'not-started' };
    let scanLastDone = 0;
    let scanTotal = 0;
    if (scanClick.ok) {
      let last = '';
      while (Date.now() - scanT0 < ARCHIVE_SCAN_MS) {
        await sleep(1000);
        const n = String((await cdp.evalJs(scanNoteExpr).catch(() => '')) ?? '');
        if (n !== last) {
          scanSamples.push({ t: Date.now() - scanT0, note: n });
          last = n;
        }
        const p = /已扫\s*(\d+)\/(\d+)\s*段/.exec(n);
        if (p) {
          scanLastDone = Number(p[1]);
          scanTotal = Number(p[2]);
        }
        if (/已扫\s*\d+\/\d+\s*角色/.test(n)) {
          scanNote = { ok: true, note: n };
          break;
        }
      }
      if (!scanNote.ok) scanNote = { ok: false, error: `等待超时（${ARCHIVE_SCAN_MS}ms）：整档体检摘要`, last };
    } else {
      scanNote = { ok: false, error: scanClick.reason ?? 'click-failed' };
    }
    const scanWallMs = Date.now() - scanT0;
    const scanTimeline = (() => {
      const keep = scanSamples.filter((s, i) => i < 3 || i === scanSamples.length - 1 || /已扫\s*\d+\/(\d+)\s*段/.test(s.note));
      return keep.slice(0, 10).map((s) => `${(s.t / 1000).toFixed(0)}s:${s.note.replace(/^体检中… ?/, '')}`);
    })();
    if (scanTimeline.length > 0) console.log(`[smoke] 整档体检进度时间线：${scanTimeline.join(' | ')}`);
    const scanM = scanNote.ok ? /已扫\s*(\d+)\/(\d+)\s*角色/.exec(scanNote.note) : null;
    const scanUnknownM = scanNote.ok ? /全未知\s*(\d+)/.exec(scanNote.note) : null;
    const scanSelfMs = scanNote.ok ? /耗时\s*(\d+)\s*ms/.exec(scanNote.note) : null;
    if (archiveReady) {
      if (!scanNote.ok) await forensics(cdp, 'i2-整档体检没出摘要', outDir);
      check(
        'i2 整档体检能跑完并出摘要（已扫 > 0 角色 · 含「全未知」计数）',
        scanNote.ok && !!scanM && Number(scanM[1]) > 0 && !!scanUnknownM,
        scanNote.ok
          ? `摘要=${JSON.stringify(scanNote.note)} · 已扫=${scanM?.[1] ?? '?'}/${scanM?.[2] ?? '?'} 角色 · 全未知=${scanUnknownM?.[1] ?? '?'} · 面板自报耗时=${scanSelfMs?.[1] ?? '?'} ms · 墙钟=${scanWallMs} ms（含点击/渲染）· 索引就绪等待=${(archiveReadyMs / 1000).toFixed(1)}s`
          : `没出摘要：${scanNote.error ?? '未知'} · 进度停在 ${scanLastDone}/${scanTotal} 段（${scanWallMs}ms）· 时间线=${JSON.stringify(scanTimeline)} · 点击=${JSON.stringify(scanClick)} · 段内红字=${JSON.stringify(await cdp.evalJs(scanErrorExpr))}`,
      );
      // 超时别把整档留在后台烧 CPU（后面 j/k 还要判）：点「取消」收尾，读数另记。
      if (!scanNote.ok) {
        // 卡在 25 段（= 第一个让出点）时要分清两件事：**这一段本身卡住**，还是
        // `archive-scan.yieldToEventLoop` 的 MessageChannel 让出没回来。页面里现测 A/B：
        // A = 面板同款（`addEventListener('message')`，**不调** `port1.start()`）；
        // B = 同款 + 显式 `start()`。按 HTML 规范 `addEventListener` 不会自动 start，
        // A 永远收不到消息——这把"卡在让出点"与"卡在某一段"一次分开。
        const mcProbe = await cdp
          .evalJs(
            `new Promise((resolve) => {
              const out = {};
              const seen = new Set();
              const done = (k, v) => { if (seen.has(k)) return; seen.add(k); out[k] = v; if (seen.size === 2) resolve(out); };
              try {
                const a = new MessageChannel();
                a.port1.addEventListener('message', () => { try { a.port1.close(); } catch {} done('noStart', 'delivered'); });
                a.port2.postMessage(0);
                setTimeout(() => done('noStart', 'timeout(1200ms)'), 1200);
              } catch (e) { done('noStart', 'error:' + String(e)); }
              try {
                const b = new MessageChannel();
                b.port1.addEventListener('message', () => { try { b.port1.close(); } catch {} done('withStart', 'delivered'); });
                b.port1.start();
                b.port2.postMessage(0);
                setTimeout(() => done('withStart', 'timeout(1200ms)'), 1200);
              } catch (e) { done('withStart', 'error:' + String(e)); }
            })`,
            5000,
          )
          .catch((e) => `eval-failed:${String(e?.message ?? e)}`);
        const cancelClick = await clickMatch(cdp, scanButtonExpr('取消'));
        const stopped = cancelClick.ok
          ? await waitFor(cdp, `(() => { const n = ${scanNoteExpr}; return /已取消/.test(n) ? n : ''; })()`, {
              timeoutMs: 90000,
              intervalMs: 500,
              label: 'i2 超时后取消整档体检',
            }).catch(() => null)
          : null;
        note(
          `i2 旁证：超时后点「取消」${cancelClick.ok ? '成功' : `失败（${cancelClick.reason}）`}` +
            (stopped ? `，收尾摘要=${JSON.stringify(String(stopped))}` : '，90s 内没等到「已取消」（取消只在段间生效：在途段不返回就永远轮不到它）') +
            ` · 页面内 MessageChannel A/B（A=不调 start() / B=调 start()）=${JSON.stringify(mcProbe)}`,
        );
      }
    }

    // ---- i3：展开明细 → 角色行 / 全局最该看在场 → 点第一条最该看 ----
    let scan = await readArchiveScan(cdp);
    if (scan.present && scan.expanded !== true) {
      const expandClick = await clickMatch(cdp, scanButtonExpr('展开明细'));
      if (!expandClick.ok) note(`i3 展开明细没点动：${JSON.stringify(expandClick)}`);
      await sleep(400);
      scan = await readArchiveScan(cdp);
    }
    const charRows = scan.present ? scan.charButtons : [];
    const worstRows = scan.present ? scan.worstButtons : [];
    const rowsOk = scan.present === true && charRows.length > 0 && worstRows.length > 0;
    if (rowsOk) {
      check(
        'i3a 整档结果可展开（≥1 行角色 + ≥1 条「全局最该看」段落按钮）',
        true,
        `角色行 ${charRows.length} 条（例：${JSON.stringify(charRows[0]?.text)}）· 最该看 ${worstRows.length} 条（例：${JSON.stringify(worstRows[0]?.text)} → K${worstRows[0]?.charaNo}）· 展开=${scan.expanded}`,
      );
    } else if (!scan.present) {
      note('i3 N/A：屏上没有「整档体检」段（i2 没跑出摘要，明细无从展开）');
    } else {
      note(
        `i3 N/A：展开后没有可点的角色行 / 最该看段落（角色行 ${charRows.length} · 最该看 ${worstRows.length} · 摘要=${JSON.stringify(scan.note)}；` +
          `摘要停在「体检中…/已取消」说明整档没跑完——见 i2 的进度读数，不是"本档没有段落"）`,
      );
    }

    if (rowsOk) {
      const prevSnap = await readPanel(cdp);
      const targetFn = worstRows[0].text;
      const worstExpr = `(() => {
        const sec = ${scanSectionExpr};
        if (!sec) return null;
        const all = [...sec.querySelectorAll('button')].filter((b) => {
          const t = b.getAttribute('title') || '';
          return t.startsWith('切到 K') && t.includes('并判定');
        });
        return all[0] ?? null;
      })()`;
      const worstClick = await clickMatch(cdp, worstExpr);
      const i3Judge = worstClick.ok
        ? await waitJudgeNote(cdp, targetFn, { label: '整档「全局最该看」点击后的判定' })
        : { ok: false, reason: worstClick.reason ?? 'click-failed' };
      const afterSnap = await readPanel(cdp);
      if (!i3Judge.ok) await forensics(cdp, 'i3-最该看点击后没出判定', outDir);
      check(
        'i3b 点「全局最该看」→ 出判定结果且函数名一致（dbg-sec-note 对拍）',
        i3Judge.ok && String(i3Judge.note ?? '').toUpperCase() === targetFn.toUpperCase(),
        i3Judge.ok
          ? `点击=${targetFn}（K${worstRows[0].charaNo}）· 结果 note=${i3Judge.note} · 等结果 ${i3Judge.elapsedMs}ms · 角色 ${prevSnap.charaValue}→${afterSnap.charaValue} · 谓词 ${afterSnap.preds.length} 条`
          : `等不到「${targetFn}」：${i3Judge.reason} · ${i3Judge.error ?? ''} · 当前 note=${JSON.stringify(i3Judge.last?.note ?? null)}`,
      );
    }

    // ---- i4：再点一次 → busy → 取消 → 摘要带「已取消」 ----
    let i4 = { state: 'red', detail: '' };
    // 先确保上一轮真收尾了（i2 超时那轮会先点「取消」；忙态下按钮文案是「整档体检中…」）
    const i4Back = await waitFor(
      cdp,
      `(() => { const b = ${archiveBtnExpr}; return b && b.disabled === false ? 'ok' : ''; })()`,
      { timeoutMs: 120000, intervalMs: 500, label: '整档体检按钮（可再点一次）' },
    )
      .then(() => true)
      .catch(() => false);
    const rescanClick = i4Back ? await clickMatch(cdp, archiveBtnExpr) : { ok: false, reason: 'button-not-ready' };
    if (!archiveReady) {
      i4 = { state: 'na', detail: '整档体检入口一直灰着（条件索引未就绪，见 i2），取消窗口无从测起' };
    } else if (!rescanClick.ok) {
      i4 = { state: 'red', detail: `再点整档体检没点动：${rescanClick.reason ?? '?'}` };
    } else {
      const busyNote = await waitFor(cdp, `(() => { const n = ${scanNoteExpr}; return /体检中/.test(n) ? n : ''; })()`, {
        timeoutMs: 30000,
        intervalMs: 200,
        label: '整档体检 busy',
      }).catch(() => null);
      if (!busyNote) {
        const nowNote = String((await cdp.evalJs(scanNoteExpr)) ?? '');
        i4 = /已扫\s*\d+\/\d+\s*角色/.test(nowNote)
          ? { state: 'na', detail: `再点后没看到 busy 就出了摘要（${JSON.stringify(nowNote)}）——整档跑得太快，取消窗口测不到` }
          : { state: 'red', detail: `30s 内没看到 busy 态（摘要行=${JSON.stringify(nowNote)} · 段内红字=${JSON.stringify(await cdp.evalJs(scanErrorExpr))}）` };
      } else {
        // 先等它真扫了几段再取消：首段前取消也成立，但证据弱（扫了个寂寞）
        await waitFor(
          cdp,
          `(() => { const n = ${scanNoteExpr}; const m = /已扫\\s*(\\d+)\\//.exec(n); return m && Number(m[1]) > 0 ? n : ''; })()`,
          { timeoutMs: 90000, intervalMs: 300, label: '整档体检进度（先扫几段）' },
        ).catch(() => null);
        const cancelClick = await clickMatch(cdp, scanButtonExpr('取消'));
        if (!cancelClick.ok) {
          i4 = { state: 'red', detail: `busy 期点不到「取消」：${cancelClick.reason ?? '?'}（现有按钮=${JSON.stringify((scan.buttons ?? []).map((b) => b.text))}）` };
        } else {
          const t1 = Date.now();
          let cancelledNote = '';
          let finishedNote = '';
          while (Date.now() - t1 < ARCHIVE_SCAN_CANCEL_MS) {
            await sleep(400);
            const s = await cdp.evalJs(
              `(() => {
                const sec = ${scanSectionExpr};
                if (!sec) return { note: '', notes: [] };
                return {
                  note: ((sec.querySelector('.dbg-sec-note') || {}).textContent || '').trim(),
                  notes: [...sec.querySelectorAll('.dbg-note')].map((e) => (e.textContent || '').trim()),
                };
              })()`,
            );
            const joined = [s?.note ?? '', ...(s?.notes ?? [])].join(' | ');
            if (/已取消/.test(joined)) {
              cancelledNote = joined;
              break;
            }
            if (/已扫\s*\d+\/\d+\s*角色/.test(s?.note ?? '')) {
              finishedNote = s.note;
              break;
            }
          }
          if (cancelledNote !== '') {
            i4 = { state: 'ok', detail: `busy 期间点了「取消」→ ${cancelledNote} · 收尾 ${Date.now() - t1} ms` };
          } else if (finishedNote !== '') {
            i4 = { state: 'na', detail: `点「取消」前整档已经跑完（${JSON.stringify(finishedNote)}）——太快，记 N/A` };
          } else {
            i4 = { state: 'red', detail: `点「取消」后 ${ARCHIVE_SCAN_CANCEL_MS}ms 内既没「已取消」也没新摘要（最后 note=${JSON.stringify(await cdp.evalJs(scanNoteExpr))}）` };
          }
        }
      }
    }
    if (i4.state === 'na') note(`i4 N/A：${i4.detail}`);
    else check('i4 整档体检可取消（busy 期取消 → 摘要含「已取消」）', i4.state === 'ok', i4.detail);

    /* ================= j. 未建模写分桶：调用 / 跳转只报计数，不逐行铺按钮 ================= */
    let samples = null;
    try {
      samples = await scanCorpusWriteSamples(corpus);
      console.log(`[smoke] 语料扫描：${samples.scanned} 份 ERB · j1 候选 ${samples.j1.length} 个 · j2 候选 ${samples.j2.length} 个`);
    } catch (err) {
      note(`j 组 N/A：语料扫描失败（${String(err?.message ?? err)}）`);
    }

    if (samples !== null && samples.j1.length === 0) {
      note(`j1 N/A：扫了 ${samples.scanned} 份 ERB，没有「行首调用族 + 状态写」的口上函数`);
    } else if (samples !== null) {
      const pick = await judgeWriteSample(cdp, samples.j1, { verb: '调用', label: 'j1' });
      if (pick.candidate === null) {
        await forensics(cdp, 'j1-写点分桶', outDir);
        check(
          'j1 写点分桶文案（结果区出现「另有 N 处调用」）',
          false,
          `试了 ${pick.attempts.length} 个候选都没出目标文案：${JSON.stringify(pick.attempts).slice(0, 700)}`,
        );
      } else {
        const { candidate, un } = pick;
        const callCount = Number((/(\d+)\s*处调用/.exec(un.head) ?? [])[1] ?? 0);
        const concreteCount = Number((/本段有\s*(\d+)\s*处状态写未建模/.exec(un.head) ?? [])[1] ?? -1);
        check(
          'j1 写点分桶文案（结果区出现「另有 N 处调用」）',
          callCount > 0 && un.head.includes('另有'),
          `函数=${candidate.name} · 文件=${path.relative(corpus, candidate.file)}:${candidate.start} · 确定写点=${concreteCount} · 调用 ${callCount} 处 · head=${JSON.stringify(un.head)}`,
        );
        const panelCallLines = sampleLinesFromTitle(un.headTitle, '调用');
        const buttonLines = un.buttons.map((b) => b.line).filter((n) => Number.isFinite(n));
        const leakPanel = buttonLines.filter((n) => panelCallLines.includes(n));
        const leakCorpus = buttonLines.filter((n) => candidate.callLines.includes(n));
        check(
          'j1′ call 行不铺成逐行按钮（.rp-unmodeled-line ≤ 确定写点，且不含调用行）',
          un.present && un.buttons.length <= concreteCount && leakPanel.length === 0 && leakCorpus.length === 0,
          `按钮 ${un.buttons.length} 个（上限=确定写点 ${concreteCount}）· 按钮行=${JSON.stringify(buttonLines)} · 面板 title 里的调用示例行=${JSON.stringify(panelCallLines)} · 语料扫描调用行=${JSON.stringify(candidate.callLines)} · 泄漏=${JSON.stringify([...new Set([...leakPanel, ...leakCorpus])])}`,
        );
        note(`j1 样本取自扫过的 ${samples.scanned} 份 ERB（j1 候选共 ${samples.j1.length} 个）`);
      }
    }

    if (samples !== null && samples.j2.length === 0) {
      note(`j2 N/A：扫了 ${samples.scanned} 份 ERB，没有「平跳之后还有写点」的口上函数（跳转不报是引擎的防刷屏口径）`);
    } else if (samples !== null) {
      const pick2 = await judgeWriteSample(cdp, samples.j2, { verb: '跳转', label: 'j2' });
      if (pick2.candidate === null) {
        await forensics(cdp, 'j2-跳转分类', outDir);
        check(
          'j2 跳转分类（head 含「N 处跳转」计数）',
          false,
          `试了 ${pick2.attempts.length} 个候选都没出目标文案：${JSON.stringify(pick2.attempts).slice(0, 700)}`,
        );
      } else {
        const { candidate, un } = pick2;
        const jumpCount = Number((/(\d+)\s*处跳转/.exec(un.head) ?? [])[1] ?? 0);
        const concreteCount = Number((/本段有\s*(\d+)\s*处状态写未建模/.exec(un.head) ?? [])[1] ?? -1);
        const jumpLines = sampleLinesFromTitle(un.headTitle, '跳转');
        const buttonLines = un.buttons.map((b) => b.line).filter((n) => Number.isFinite(n));
        const leak = buttonLines.filter((n) => jumpLines.includes(n) || candidate.jumpLines.includes(n));
        check(
          'j2 跳转分类（head 含「N 处跳转」计数）',
          jumpCount > 0 && un.head.includes('另有'),
          `函数=${candidate.name} · 文件=${path.relative(corpus, candidate.file)}:${candidate.start}（GOTO 第 ${candidate.jumpLine} 行，其后还有写）· 确定写点=${concreteCount} · 跳转 ${jumpCount} 处 · head=${JSON.stringify(un.head)}` +
            ` · 逐行按钮=${JSON.stringify(buttonLines)}（跳转示例行=${JSON.stringify(jumpLines)}，泄漏=${JSON.stringify(leak)}）`,
        );
        note(`j2 样本取自扫过的 ${samples.scanned} 份 ERB（j2 候选共 ${samples.j2.length} 个）`);
      }
    }

    /* ================= k. 未保存文本口径（编辑器缓冲 → 判定；做不成记 N/A） ================= */
    let kSetup = null;
    try {
      const openedBuf = await openFile(cdp, BUFFER_FILE_FRAG);
      const bufferPath = String(openedBuf.path);
      const srcText = await fsp.readFile(bufferPath, 'utf8');
      const fnList = liveKojoFunctions(srcText);
      // `openFile` 只钉住「activeFileChanged 已发生 / 路径对上了」，模型可能还在换页：
      // 必须等**正文真的换过来**再读 `before`。否则读到上一份模型（run5 实测：读到的
      // 长度 11215 ≠ 本文件 3562），后续 setValue 会把别人的正文写进这份文件，
      // 判定报「没有登记到可判定的条件」——这是读数竞态，不是产品行为。
      const fnMarker = fnList[0] ?? '';
      const modelReady =
        fnMarker === ''
          ? true
          : await waitFor(
              cdp,
              `(() => {
                const i = __kojoDebug.editor.info();
                if (!i || typeof i.value !== 'string' || i.value.length === 0) return '';
                return i.value.includes(${JSON.stringify(fnMarker)}) ? 'ok' : '';
              })()`,
              { timeoutMs: 30000, intervalMs: 250, label: '编辑器正文已切到探针文件' },
            )
              .then(() => true)
              .catch(() => false);
      if (!modelReady) {
        note(`k1 N/A：30s 内编辑器正文没切到 ${path.basename(bufferPath)}（模型还在换页 / 被别的标签占着）`);
      } else if (fnList.length === 0) {
        note(`k1 N/A：${path.basename(bufferPath)} 里没有活的口上函数（整篇在 [SKIPSTART] 区，抽取侧不发布）`);
      } else {
        const before = await cdp.evalJs('__kojoDebug.editor.info()');
        if (!before || typeof before.value !== 'string' || before.value.length === 0) {
          note('k1 N/A：editor.info() 拿不到当前文件正文（Monaco 没挂 / 文件没切过去）');
        } else {
          // 先热一次判定：`runReplay` 成功后会把「函数 → 所在文件」记进 fnPathRef。
          // 紧接着改缓冲再判，面板才**知道**这段在哪份文件里 —— 缓冲文本那条腿才走得通
          // （否则 textChoiceFor 拿不到路径，会如实退回磁盘文本：那是正确行为，测不到口径句）。
          let warmFn = null;
          const warmTried = [];
          for (const name of fnList.slice(0, 3)) {
            await cdp.evalJs(`__rpSmoke.setInput('.rp-fn-input', ${JSON.stringify(name)})`);
            await sleep(500);
            const r = await clickJudgeAndWaitFor(cdp, resultNoteIs(name), { label: `k1 预热判定 ${name}`, timeoutMs: 120000 });
            warmTried.push(`${name}:${r.ok ? 'ok' : r.reason}`);
            if (r.ok) {
              warmFn = name;
              break;
            }
          }
          if (warmFn === null) {
            note(`k1 N/A：这份文件里的函数都判不出结果（没有可判定的条件）——缓冲文本口径测不到；试过=${JSON.stringify(warmTried)}`);
          } else {
            kSetup = { bufferPath, before, warmFn };
          }
        }
      }
    } catch (err) {
      note(`k1 N/A：准备缓冲文本探针失败（${String(err?.message ?? err)}）`);
    }

    if (kSetup !== null) {
      const { before, warmFn, bufferPath } = kSetup;
      const eol = before.eol === 'crlf' ? '\r\n' : '\n';
      const probeLine = '; replay-panel-smoke k1：未保存文本探针（不保存、不写盘）';
      const probeText = `${before.value}${eol}${probeLine}`;
      // 先走"像真人打字"（executeEdits）。**只读项目下 Monaco 会静默丢弃这次编辑**
      // （编辑器 option readOnly ⇒ executeEdits 直接 return false，而
      //  `__kojoDebug.editor.type()` 仍旧返回 true——调试 API 那边的诚实性缺口），
      // 丢不动就按任务书给的备用口径直接改 model（setValue）：缓冲真的变了、真的没保存，
      // 面板照样吃缓冲文本。两条都不写盘。
      const typed = await cdp.evalJs(`(() => {
        const cursorOk = __kojoDebug.editor.setCursor(1, 1);
        const ok = __kojoDebug.editor.type(${JSON.stringify(probeLine + eol)});
        const now = __kojoDebug.editor.info();
        return { cursorOk, ok, length: now ? now.value.length : -1 };
      })()`);
      const wantTypedLen = before.value.length + probeLine.length + eol.length;
      let editOk = typed?.length === wantTypedLen;
      let editVia = 'executeEdits（像真人打字）';
      let readOnlyHint = '';
      if (!editOk) {
        readOnlyHint = `executeEdits 报 ${JSON.stringify(typed?.ok)} 但正文长度没变——只读项目下被 Monaco 静默丢弃`;
        const setv = await cdp.evalJs(`(() => {
          const ok = __kojoDebug.editor.setValue(${JSON.stringify(probeText)});
          const now = __kojoDebug.editor.info();
          return { ok, length: now ? now.value.length : -1 };
        })()`);
        editOk = setv?.ok === true && setv?.length === probeText.length;
        editVia = 'setValue（只读项目下 executeEdits 被吞）';
      }
      check(
        'k1′ 编辑器缓冲已改（未保存）',
        editOk,
        `方式=${editVia} · 长度 ${typed?.length}/${wantTypedLen}（原 ${before.value.length}）· 文件=${path.basename(bufferPath)}` +
          (readOnlyHint ? ` · ${readOnlyHint}` : ''),
      );
      const dirtyHint = await waitFor(
        cdp,
        `(() => {
          const p = document.querySelector('.panel-state-replay');
          const el = p ? p.querySelector('.rp-buffer-note') : null;
          return el ? (el.textContent || '').trim() : '';
        })()`,
        { timeoutMs: 20000, intervalMs: 250, label: '未保存编辑提示' },
      ).catch(() => null);
      check(
        'k1″ 判定前屏上已标明「编辑器里有未保存的编辑」',
        !!dirtyHint,
        dirtyHint ? JSON.stringify(dirtyHint) : '等不到 .rp-buffer-note（缓冲区广播没落到面板）',
      );

      const bufCond = `(() => {
        const res = [...document.querySelectorAll('.panel-state-replay .dbg-sec')].find((s) => ((s.querySelector('.dbg-sec-title') || {}).textContent || '').trim() === '判定结果');
        if (!res) return false;
        const note = ((res.querySelector('.dbg-sec-note') || {}).textContent || '').trim();
        if (note.toUpperCase() !== ${JSON.stringify(warmFn.toUpperCase())}) return false;
        const src = res.querySelector('.rp-text-source');
        return !!src && (src.textContent || '').includes('编辑器里的未保存文本');
      })()`;
      const judged = await clickJudgeAndWaitFor(cdp, bufCond, { label: '缓冲文本判定' });
      const after = await readPanel(cdp);
      if (!judged.ok) await forensics(cdp, 'k1-未保存文本口径', outDir);
      const labelLine = (/本次判定用的是[^\n]*/.exec(after.resultText) ?? ['(结果区没读到口径句)'])[0];
      check(
        'k1 结果区标出「编辑器里的未保存文本」',
        judged.ok && /编辑器里的未保存文本/.test(after.resultText),
        judged.ok
          ? `函数=${warmFn} · ${judged.elapsedMs}ms · 口径句=${JSON.stringify(labelLine)}`
          : `等不到口径句：${judged.reason} · ${judged.error ?? ''} · 结果区首段=${JSON.stringify(after.resultText.slice(0, 180))}`,
      );

      // 还原：直接 setValue 回原文（不保存）。setValue 不进撤销栈、脏标记会留在 true
      // （版本号与基线不同），但**正文与磁盘逐字相同**；语料只读 + 自动保存默认关 ⇒ 不写盘。
      const restored = await cdp.evalJs(`(() => {
        const ok = __kojoDebug.editor.setValue(${JSON.stringify(before.value)});
        const i = __kojoDebug.editor.info();
        return { ok, length: i ? i.value.length : -1 };
      })()`);
      check(
        'k1‴ 探针已还原（不保存、不写盘）',
        restored?.ok === true && restored?.length === before.value.length,
        `还原方式=setValue（不保存）· 长度=${restored?.length}/${before.value.length} · 语料只读，全程未写盘`,
      );
    }

    /* ================= h. 截图 + 读数摘要 ================= */
    const shot = await cdp.screenshot(false);
    const shotPath = path.join(outDir, 'replay-panel-final.png');
    await fsp.writeFile(shotPath, shot);
    // 第二张：把结果区滚进视野（面板很高，首屏只有选择区）——两张都留，便于人眼核对
    await cdp.evalJs(
      `(() => { const s = [...document.querySelectorAll('.panel-state-replay .dbg-sec')].find((x) => (x.querySelector('.dbg-sec-title')?.textContent || '').trim() === '判定结果'); if (s) s.scrollIntoView({ block: 'start' }); return !!s; })()`,
    );
    await sleep(500);
    const shot2 = await cdp.screenshot(false);
    const shotPath2 = path.join(outDir, 'replay-panel-result.png');
    await fsp.writeFile(shotPath2, shot2);
    check(
      'h 截图落盘（面板 + 结果区两拍）',
      shot.length > 10000 && shot2.length > 10000 && !shot.equals(shot2),
      `${shotPath}（${(shot.length / 1024).toFixed(0)} KB）· ${shotPath2}（${(shot2.length / 1024).toFixed(0)} KB）`,
    );

    // 读数摘要：报告直接贴这一段
    const lastSnap = await readPanel(cdp);
    console.log('');
    console.log('—— 读数摘要 ——');
    console.log(
      `  语料=${corpus} · 存档=${path.basename(String(lastSnap.archiveValue ?? ''))} · 角色=${lastSnap.charaValue} · 函数=${lastSnap.fnInputValue}`,
    );
    console.log(
      `  谓词=${lastSnap.preds.length} 条 · 未知徽章=${JSON.stringify(lastSnap.unknownBadges)} · 假设徽章=${JSON.stringify(lastSnap.assumeBadges)}`,
    );
    console.log(
      `  槽位=${lastSnap.slotRows.map((r) => `${r.label}=${JSON.stringify(r.value)}`).join(' / ') || '—'} · datalist=${JSON.stringify(lastSnap.datalists)}`,
    );
    console.log(`  整档体检=${JSON.stringify(scanNote?.ok ? scanNote.note : (scanNote?.error ?? '未跑'))}`);
    console.log(
      `  语料扫描=${samples ? `${samples.scanned} 份（j1 候选 ${samples.j1.length} / j2 候选 ${samples.j2.length}）` : '未扫'} · 缓冲探针=${kSetup ? kSetup.warmFn : 'N/A'}`,
    );
    console.log(`  截图=${shotPath}`);
    console.log(`  截图=${shotPath2}`);
  } catch (err) {
    check('断言链中途失败', false, String(err?.message ?? err));
    if (ctx.cdp) await forensics(ctx.cdp, 'fatal', outDir);
  } finally {
    try {
      ctx.cdp?.close();
    } catch {}
  }

  if (notes.length) {
    console.log('');
    console.log(`—— N/A 读数（${notes.length} 条，不算红）——`);
    for (const n of notes) console.log(`  • ${n}`);
  }
  await shutdown(0);
}

await main();
