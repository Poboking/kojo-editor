#!/usr/bin/env node
/**
 * structure-edit-wire.mjs —— **差集路不退化**的那一条读数（LAU-1 的 DoD 第 5 条）。
 *
 * 量什么：6,003 行档每敲一键，主线程发给 worker 的**文本量**（UTF-16 码元数）。
 *
 * - `v3`：今天的 `StructureClient`（协议 v3，`parse{edit, baseTreeId}`）——每键只发改动那一段，
 *   整篇只在开文件 / 基线丢了时发；
 * - `legacy`：`client-v2.ts`（LAU-1 之前的 `change` 消息，同一份差集逻辑）——这是"改前"的口径；
 * - `full`：整篇长度本身（对照量：改前若退化成每键全文，就是这一格）。
 *
 * ## 为什么不用真 worker / 真 wasm
 *
 * 这条读数只关心**线上字节**，与解析结果无关；真 wasm 反而会把 Windows 上"解过档的进程收尾必崩
 * `Fatal process out of memory: Zone`"那条坑拖进来（见 PITFALLS）。故 worker 用可编程替身：
 * `postMessage` 记账并按当前版本回一条形状合法的 v3 / v2 回话，主线程打的仍是**生产代码**。
 *
 * ## 跑法（两条都行）
 *
 * ```
 * node --experimental-transform-types tools/structure-edit-wire.mjs
 * KOJO_EDIT_WIRE_KEYS=50 node --experimental-transform-types tools/structure-edit-wire.mjs
 * ```
 *
 * 为什么必须带 `--experimental-transform-types`：宿主模块链从 `@kojo/kojo-core` 的桶里拖进了
 * 带**参数属性**的 TS 文件（`expr/parse.ts`），strip-only 模式解不了；下面那两枚 resolve 钩子
 * 负责把仓内的 `.js` 相对说明符与无扩展名相对导入指回 `.ts`（Node ESM 不认这两条）。
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`]) {
        if (candidate !== base && existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return next(specifier, context);
  },
});

/* ------------------------------ 6,003 行合成档 ------------------------------ */

/** 与 `kojo2-worker.test.ts` 的 5,000 行档同一形状（场景 / 台词 / 旁白 / @算 / 条件链），凑到 6,003 行 */
function synthetic(lines) {
  const out = [];
  for (let n = 0; out.length < lines; n++) {
    out.push(`# 幕 场景${n}`);
    out.push(`灵梦：「今天也一起加油吧，第${n}次。」(心形)`);
    out.push(`> 她把脸别了过去，因为{原因}而不知所措。`);
    out.push('@算');
    out.push(`    人数 = 队伍状态.长度 + ${n}`);
    out.push('    今天已触发 = 人数');
    out.push('? 恋慕 >= 500');
    out.push('    > 她停下扫帚，眼神柔和下来。');
    out.push('? 否');
    out.push('    灵梦：「……早。」');
  }
  return out.slice(0, lines).join('\n');
}

const LINES = 6_003;
const KEYS = Number.parseInt(process.env.KOJO_EDIT_WIRE_KEYS ?? '20', 10) || 20;
const BASE_TEXT = synthetic(LINES);

/* ------------------------------- 假模型 / 假线程 ------------------------------- */

function fakeModel(text) {
  let value = text;
  const listeners = new Set();
  return {
    getValue: () => value,
    isDisposed: () => false,
    onDidChangeContent: (fn) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    edit: (next) => {
      value = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

/** 一条可编程线程：记下发出去的消息，按"请求形状属于哪一版"回一条合法回话 */
function fakeWorker(kind) {
  const worker = {
    onmessage: null,
    onerror: null,
    sent: [],
    terminated: false,
    reply(data) {
      worker.onmessage?.({ data });
    },
    terminate() {
      worker.terminated = true;
    },
    postMessage(data) {
      worker.sent.push(data);
      const message = data;
      if (kind === 'v3') {
        if (message.kind === 'open') {
          worker.reply({ ok: true, id: message.id, kind: 'ready', protocol: 3, loadMs: 0 });
          return;
        }
        worker.reply({
          ok: true,
          id: message.id,
          kind: 'parse',
          doc: message.doc,
          version: message.version,
          treeId: `t${worker.sent.length}`,
          incremental: message.text === undefined,
          facets: {
            semantic: { names: [], nodes: [], spans: [] },
            folds: { spans: [] },
            indent: { increasePatterns: [], decreasePatterns: [], enterPatterns: [] },
            syntax: { faults: [], truncated: false },
          },
          metrics: { parseMs: 0, queryMs: 0, textLength: 0 },
        });
        return;
      }
      if (message.type === 'init') {
        worker.reply({ type: 'ready', version: 0 });
        return;
      }
      if (message.type === 'parse' || message.type === 'change') {
        const doc = message.doc;
        const version = message.version;
        worker.reply({ type: 'semantic', doc, version, tokens: [] });
        worker.reply({ type: 'folds', doc, version, folds: [] });
        worker.reply({ type: 'indent', doc, version, rules: { increasePatterns: [], decreasePatterns: [], enterPatterns: [] } });
      }
    },
  };
  return worker;
}

/** 一条消息带的**文本量**（UTF-16 码元）：整篇 / 差集各按它真正交出去的那一段算 */
function textUnitsOf(message) {
  if (typeof message.text === 'string') return message.text.length;
  if (message.edit !== undefined && typeof message.edit.newText === 'string') return message.edit.newText.length;
  if (typeof message.newText === 'string') return message.newText.length;
  return 0;
}

function jsonBytes(message) {
  return JSON.stringify(message).length;
}

/* --------------------------------- 量两档 --------------------------------- */

globalThis.window = globalThis; // 两枚 client 的等待票都走 `window.setTimeout`

const v3 = await import(pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/client.ts')).href);
const v2 = await import(pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/client-v2.ts')).href);

/** 20 次击键：每次在某一行的行中插一个字符（位置确定性轮转，两次跑逐字节相同） */
function keystrokes(text, count) {
  const out = [];
  let current = text;
  let offset = 0;
  const stride = Math.max(1, Math.floor(current.length / (count + 1)));
  for (let i = 0; i < count; i++) {
    offset = Math.min(current.length, offset + stride);
    const filler = '。';
    current = current.slice(0, offset) + filler + current.slice(offset);
    out.push(current);
    offset += filler.length;
  }
  return out;
}

async function measureV3() {
  const worker = fakeWorker('v3');
  const client = new v3.StructureClient({
    runtime: { runtimeWasmUrl: 'r', grammarWasmUrl: 'g', createWorker: () => worker },
    timeoutMs: 1_000,
  });
  client.start();
  const model = fakeModel(BASE_TEXT);
  await client.tokens(model); // 首解（整篇）
  const first = worker.sent.filter((m) => m.kind === 'parse');
  const samples = [];
  for (const next of keystrokes(BASE_TEXT, KEYS)) {
    const before = worker.sent.length;
    model.edit(next);
    await client.tokens(model);
    const fresh = worker.sent.slice(before);
    for (const message of fresh) samples.push({ message, units: textUnitsOf(message), bytes: jsonBytes(message) });
  }
  client.dispose();
  return { samples, initial: first };
}

async function measureLegacy() {
  const worker = fakeWorker('v2');
  const client = new v2.StructureClientV2({
    runtime: { runtimeWasmUrl: 'r', grammarWasmUrl: 'g', createWorker: () => worker },
    timeoutMs: 1_000,
  });
  client.start();
  const model = fakeModel(BASE_TEXT);
  await client.tokens(model); // 首解（整篇 parse）
  const samples = [];
  for (const next of keystrokes(BASE_TEXT, KEYS)) {
    const before = worker.sent.length;
    model.edit(next);
    await client.tokens(model);
    for (const message of worker.sent.slice(before)) {
      samples.push({ message, units: textUnitsOf(message), bytes: jsonBytes(message) });
    }
  }
  client.dispose();
  return { samples };
}

const stats = (xs) => {
  if (xs.length === 0) return { n: 0, avg: 0, peak: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  return { n: xs.length, avg: sum / xs.length, peak: Math.max(...xs) };
};

const v3run = await measureV3();
const v2run = await measureLegacy();

const v3units = stats(v3run.samples.map((s) => s.units));
const v3bytes = stats(v3run.samples.map((s) => s.bytes));
const v2units = stats(v2run.samples.map((s) => s.units));
const v2bytes = stats(v2run.samples.map((s) => s.bytes));
const fullUnits = BASE_TEXT.length;

// 自检：v3 的每一条增量请求必须是 `edit` 形态（没有 text），否则"不退化"这句话没有依据
const v3edits = v3run.samples.filter((s) => s.message.kind === 'parse');
const offenders = v3edits.filter((s) => s.message.text !== undefined || s.message.edit === undefined);

const report = {
  lines: LINES,
  chars: fullUnits,
  keys: KEYS,
  v3: { messages: v3units.n, avgTextUnits: +v3units.avg.toFixed(2), peakTextUnits: v3units.peak, avgJsonBytes: +v3bytes.avg.toFixed(1) },
  legacy: { messages: v2units.n, avgTextUnits: +v2units.avg.toFixed(2), peakTextUnits: v2units.peak, avgJsonBytes: +v2bytes.avg.toFixed(1) },
  fullTextUnits: fullUnits,
  v3VsFullPercent: +((v3units.peak / fullUnits) * 100).toFixed(3),
  v3VsLegacyRatio: +(v3units.avg / Math.max(1, v2units.avg)).toFixed(2),
  initialRequestTextUnits: textUnitsOf(v3run.initial[0] ?? {}),
  v3EditShapeOffenders: offenders.length,
};

console.log(`[structure-edit-wire] ${JSON.stringify(report)}`);

const failures = [];
if (v3units.n === 0) failures.push('v3 一条增量请求都没截到');
if (offenders.length > 0) failures.push(`v3 有 ${offenders.length} 条增量请求仍带整篇 text`);
if (v3units.peak > 64) failures.push(`v3 每键文本量峰值 ${v3units.peak} 码元（>64 就说明差集退化）`);
if (v3units.avg > v2units.avg + 8) failures.push(`v3 每键文本量 ${v3units.avg} 大于改前 ${v2units.avg} 一个量级以上`);
if (v3run.initial[0] === undefined || textUnitsOf(v3run.initial[0]) !== fullUnits) failures.push('首条 parse 不是整篇');

if (failures.length > 0) {
  for (const line of failures) console.error(`[structure-edit-wire] FAIL：${line}`);
  process.exitCode = 1;
}
