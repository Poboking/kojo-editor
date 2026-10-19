/**
 * 结构解析（tree-sitter）· **真增量与墙钟读数**（TSIT2-C 的量数那一半）。
 *
 * ## 为什么这个文件存在
 *
 * wave 1 把叠层建起来了，但"增量到底是真还是假"没人量过：`tree.edit()` 调了不等于树真的被复用，
 * 每次击键把整篇重解一遍在功能测试里**看不出差别**（结果一样，只是贵）。这一池把它钉成两件事：
 * ① **局部性**（结构判据，不靠时间）——一次单击键改动一行时，引擎向文本取了几段、取字窗口落在哪；
 * ② **墙钟读数**（p50/p95）——冷全量解与增量解各是多少毫秒，16 ms 一帧线到底达没达标。
 *
 * ## 打的是生产代码，不是替身
 *
 * 直接 `new StructureEngine(...)`：worker 本体（`kojo-ts.worker.ts`）现在只剩消息环，
 * 引擎就是 worker 里面那一台，**没有第二条"测试专用"的调用形状**。编辑事件也走
 * `edit.ts` 的 `commonEdit()` + `applyEdit()`（与 `client.ts` 完全同一条缝合口径），
 * 所以"主线程算的编辑"与"引擎用的编辑"漂移会在这里红，而不是在屏上红。
 *
 * ## 本池量不到什么（写明而不是藏着）
 *
 * 1. **真 Worker**：`?worker` 是 Vite 后缀，vitest 的 node 环境没有 `Worker` 构造 ⇒
 *    线程创建、`postMessage` 序列化、Monaco provider 的取数往返都不在这一池里。
 *    引擎调用形状与 worker 里逐字相同，但**跨线程那份拷贝**没量到；
 *    TODO（真壳）：`tools/smoke-tauri-dom.mjs` 那条壳里翻开 `editor.treeSitter` 后按同一条口径
 *    量一次"击键 → 语义着色上屏"，与本文件的 parse/change 数对照；
 * 2. **真语法**：语法包（`packages/kojo-syntax-tree`）正被另一条线重写（块嵌套），本文件的断言
 *    只看**行级区间与档位**与"增量结果 == 整篇重解结果"，不看块形状 ⇒ 语法升级后判据照旧成立
 *    （若块容器让全量解变贵，翻线的是绝对上界那条，读数会自己说出来）；
 * 3. **进程 RSS**：本机实测 wasm 线性内存是**平的**（`Parser` 复用 + 每份 `tree.delete()`，
 *    40 轮解下来 heap 稳定 32 MB、`heapUsed` ≤ 20 MB ⇒ 不是泄漏），但 **Windows 上进程 RSS
 *    每轮"解 + 跑查询"涨 15–20 MB 且不还给操作系统**（V8 已提交页的高水位）。
 *    本文件因此把轮数压到 20 + 12 + 一份 200 行小档，峰值 RSS ≈ 1.8 GB；
 *    **要加轮数请先看这个数**（同池满载时更高）。真壳那条线要盯的是同一个数——
 *    长文件连打几百击键后 worker 的内存读数，本文件只把它打印出来，不当判据。
 *
 * 断言口径照 `docs/PITFALLS.md` §72 与同池那几份 perf 用例：**结构判据为主 + 比值 + 极松绝对上界**，
 * 墙钟只报数不钉死（满载时同一条腿能差 2–4 倍）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StructureEngine, STRUCTURE_READ_CHUNK, type StructureParseStat } from '../src/monaco/tree-sitter/engine';
import { applyEdit, commonEdit } from '../src/monaco/tree-sitter/edit';
import type { KojoStructureReply, KojoStructureRequest, KojoStructureToken } from '../src/monaco/tree-sitter/types';

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const syntaxPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');
/** 与 worker 里 `assets.ts` 同一批文件；node 池用 `fs` 读（`?url` / `?raw` 在这池里解析不了） */
const assets = {
  runtimeWasm: join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  kojoWasm: readFileSync(join(syntaxPkg, 'tree-sitter-kojo.wasm')),
  highlightsQuery: readFileSync(join(syntaxPkg, 'queries', 'highlights.scm'), 'utf8'),
  foldsQuery: readFileSync(join(syntaxPkg, 'queries', 'folds.scm'), 'utf8'),
  indentsQuery: readFileSync(join(syntaxPkg, 'queries', 'indents.scm'), 'utf8'),
};

/* ------------------------------ 合成语料 ------------------------------ */

/**
 * 5,000 行合成 `.kojo`：块头 / 更深正文 / 台词 / 旁白 / 注释 / 原生直通混着来，
 * 词形取自 `packages/plugins/kojo-sugar/tests/goldens/corpus-k12-*.kojo` 与
 * `fixtures/sugar/teaching-full.kojo` 的同族写法（**取写法不取语料本体**：语料目录名会变、
 * 也可能整目录暂离，perf 基线不许依赖它在位）。
 */
const SYNTHETIC_LINES: readonly string[] = [
  '时机 指令 300 成否: 游戏判定：',
  '\t如果 CFLAG:ブチギレ == 1：',
  '\t\t随机：',
  '\t\t\tPRINTFORMW 「就算是%CALLNAME:MASTER%也不能原谅啊ー」',
  '\t\t\t「现在不想说话啊ー？」',
  '\t\t\t「笨ー蛋！略略略！」',
  '\t\t否则：',
  '\t\t\t「……哼」',
  '\t\t\t「肚子饿了啊ー」',
  '\t否则如果 TCVAR:302 || TFLAG:193 < 0：',
  '\t\t「能不能聊点别的？」',
  '\t\t「真无ー聊」',
  '\t\t等待',
  '\t结束',
  ';这里是注释行，作者拿来分节',
  '着色 0xFF8080：',
  '\t「这句用作者色」',
  '结束',
  '心形 「还想做……舒服ー的事……HPH」 续',
  '空行',
  '隐藏情景: 如果 她的诶嘿嘿 == 0',
  'PRINTFORMW 她的呼吸乱了半拍。',
  '$NATIVE_DIRECTIVE_LINE',
];

const DOC_LINES = 5_000;

function syntheticDoc(lines = DOC_LINES): string {
  const out = ['角色: 12', '旁白色: 作者色', ';perf 合成语料（结构解析增量基线）', ''];
  for (let i = 0; out.length < lines; i++) out.push(SYNTHETIC_LINES[i % SYNTHETIC_LINES.length]!);
  return `${out.slice(0, lines).join('\n')}\n`;
}

/* ------------------------------ 量数工具 ------------------------------ */

interface Latency {
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
  readonly runs: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function latency(samples: readonly number[]): Latency {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    runs: sorted.length,
  };
}

const fmt = (l: Latency): string =>
  `p50 ${l.p50.toFixed(2)} ms / p95 ${l.p95.toFixed(2)} ms（min ${l.min.toFixed(2)}、max ${l.max.toFixed(2)}、n=${l.runs}）`;

/** 行首偏移表（造编辑用，与被测代码无关） */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

const COLD_RUNS = 20;
const EDIT_RUNS = 12;

/** 最近一轮的回话（每轮清空：不留着 20 × 2,606 条 token 让 RSS 白涨一截） */
let replies: KojoStructureReply[] = [];
/** 跨轮累计的"整档停用级别"错误（判据用，容量极小） */
const fatalSeen: KojoStructureReply[] = [];
let engine: StructureEngine | null = null;
let coldReading: Latency | null = null;

/** 本池只有一份文档、一个引擎：`doc` 号恒为 1，但协议要求每条内容回复都带它（跨文档隔离闸） */
const PERF_DOC = 1;

function changeRequest(version: number, edit: ReturnType<typeof commonEdit>): Extract<KojoStructureRequest, { type: 'change' }> {
  return {
    type: 'change',
    doc: PERF_DOC,
    version,
    start: edit.start,
    oldEnd: edit.oldEnd,
    newEnd: edit.newEnd,
    newText: edit.newText,
  };
}

function lastSemantic(): readonly KojoStructureToken[] | null {
  for (let i = replies.length - 1; i >= 0; i--) {
    const reply = replies[i]!;
    if (reply.type === 'semantic') return reply.tokens;
  }
  return null;
}

const replyTypes = (): string => replies.map((reply) => reply.type).join('+') || '（无回话）';

const rssMb = (): number => Math.round((process.memoryUsage().rss ?? 0) / 1048576);

function requireEngine(): StructureEngine {
  if (engine === null) throw new Error('引擎没装配起来（beforeAll 红了就不该走到这里）');
  return engine;
}

/** 跑一轮整篇解（顺带把回话台账清给下一轮） */
function parseRound(version: number, doc: string): number {
  const target = requireEngine();
  replies = [];
  const t0 = performance.now();
  target.parse(PERF_DOC, version, doc);
  return performance.now() - t0;
}

beforeAll(async () => {
  engine = new StructureEngine({
    assets,
    emit: (message) => {
      replies.push(message);
      if (message.type === 'error' && message.capability === 'all') fatalSeen.push(message);
    },
  });
  const ok = await engine.init();
  expect(ok, `引擎装配失败：${JSON.stringify(replies.filter((r) => r.type === 'error'))}`).toBe(true);
}, 180_000);

afterAll(() => {
  engine?.dispose();
  engine = null;
  replies = [];
});

/* ================================= 用例 ================================= */

describe('结构解析 · 偏移口径（UTF-16 码元，不是字节）', () => {
  it('代理对（emoji / astral）改一处：增量结果仍与整篇重解逐字相等', () => {
    // web-tree-sitter 的 `Edit.startIndex` 与 `Node.startIndex` 都是 **JS 字符串下标 = UTF-16 码元**；
    // `edit.ts` 的 `pointAt()` 也按码元计列。谁哪天换成字节偏移（UTF-8）来过这道闸，
    // 这一条立刻红——代理对前后每一格的偏移都会差一格，树被编辑歪就是着色歪。
    const target = requireEngine();
    const doc = [
      '角色: 12',
      '旁白色: 作者色',
      '时机 指令 300 成否: 游戏判定：',
      '\t如果 她的诶嘿嘿 😀 == 1：',
      '\t\tPRINTFORMW 「第一行台词 🎵 带代理对」',
      '\t\t「第二行 🈴」',
      '\t否则：',
      '\t\t「第三行 😇」',
      '结束',
      ';注释里也有一枚 😀',
    ].join('\n');
    expect(doc.length).toBeGreaterThan([...doc].length); // 确有代理对（码元数 > 码点数）
    parseRound(1, doc);
    const nextDoc = `${doc.slice(0, doc.indexOf('😀'))}🙂${doc.slice(doc.indexOf('😀') + 2)}`;
    const edit = commonEdit(doc, nextDoc);
    expect(applyEdit(doc, edit)).toBe(nextDoc);

    replies = [];
    target.change(changeRequest(2, edit));
    const incremental = lastSemantic()!;
    const stat = target.lastStat!;
    const realigned = (() => {
      parseRound(3, nextDoc);
      return lastSemantic()!;
    })();
    console.log(`\n===== ⑤b 偏移口径（代理对一处替换）=====`);
    console.log(`增量取字 ${stat.reads} 段 / 编辑点 ${stat.editStart}..${stat.editEnd}（码元）/ 结构段 ${incremental.length} 条`);
    expect(stat.incremental, '这一趟没走增量').toBe(true);
    expect(incremental, '代理对编辑后的增量着色段与整篇重解不等 ⇒ 偏移口径漂了').toEqual(realigned);
    expect(incremental.length).toBeGreaterThan(0);
  });
});

describe('结构解析 · 冷全量解读数（5,000 行合成档）', () => {
  const doc = syntheticDoc();
  let stat: StructureParseStat | null = null;

  it(`${COLD_RUNS} 轮整篇重解：p50/p95 + 取字段数与文档规模挂钩`, () => {
    const target = requireEngine();
    const cold: number[] = [];
    for (let run = 0; run < COLD_RUNS; run++) cold.push(parseRound(run + 1, doc));
    stat = target.lastStat;
    const reading = latency(cold);
    coldReading = reading;
    const lineCount = doc.split('\n').length - 1;
    console.log(`\n===== ⑤ 结构解析墙钟（node 直调引擎，非真 Worker；${lineCount} 行 / ${doc.length} 码元）=====`);
    console.log(`冷全量解（parse + 查询 + 回话）: ${fmt(reading)}`);
    console.log(`整篇解取字 ${stat?.reads} 段 / 段上限 ${STRUCTURE_READ_CHUNK} 码元 ⇒ 窗口 ${stat?.readStart}..${stat?.readEnd}（覆盖全文）`);
    console.log(`本机进程 RSS（这一轮量完）      : ${rssMb()} MB`);
    expect(reading.runs).toBe(COLD_RUNS);
    expect(stat, '整篇解之后没有读数').not.toBeNull();
    // 引擎走的是有界 stringer ⇒ 一份全文至少要取"全文码元 / 段上限"这么多次
    expect(stat!.reads, '整篇解的取字段数少于"覆盖全文"的下界 ⇒ 引擎没把全文喂给解析器').toBeGreaterThanOrEqual(
      Math.floor(doc.length / STRUCTURE_READ_CHUNK),
    );
    expect(stat!.incremental, 'parse 消息不该冒充增量').toBe(false);
    // 极松绝对上界：本机实测 p95 是 2×10¹ ms 量级，这一条只抓"有人把整篇扫描改贵了一个数量级"。
    expect(reading.p95, `整篇解 p95 ${reading.p95.toFixed(1)} ms 超宽松上界`).toBeLessThan(400);
    expect(fatalSeen, `整篇解期间出现整档停用级别的错误：${JSON.stringify(fatalSeen)}`).toHaveLength(0);
  });

  it('语法没解出错误恢复的糊块（否则上面的时间判据量的是别的东西）', () => {
    const tokens = lastSemantic();
    expect(tokens, '三面里 semantic 一个字都没回 ⇒ 查询或档位表漂了').not.toBeNull();
    expect(tokens!.length).toBeGreaterThan(1_000);
    const wide = tokens!.filter((token) => token.endRow - token.startRow > 200);
    console.log(`结构段总数 ${tokens!.length}，其中跨 >200 行的 ${wide.length} 段（错误恢复跑飞的形状判据）`);
    expect(wide, '出现跨 >200 行的结构段 ⇒ 语法错误恢复在合成档上跑飞，先修语法再谈性能').toHaveLength(0);
  });
});

describe('结构解析 · 单击键增量（真 tree.edit + 有界取字）', () => {
  it('一次改一行：结果与整篇重解逐字相等，且取字窗口只贴着改动点', () => {
    const target = requireEngine();
    const doc = syntheticDoc();
    parseRound(1, doc);
    const baseline = lastSemantic()!;
    expect(baseline.length).toBeGreaterThan(0);

    // 走宿主同一条缝：模型侧只改了 1200 行那一行 ⇒ commonEdit 算出那一条编辑
    const starts = lineStarts(doc);
    const row = 1200;
    const at = starts[row]!;
    const nextDoc = `${doc.slice(0, at)}// 改了这一行\n${doc.slice(starts[row + 1]!)}`;
    const edit = commonEdit(doc, nextDoc);
    expect(applyEdit(doc, edit), 'commonEdit/applyEdit 与手改的下一版文本不一致 ⇒ 缝合口径漂了').toBe(nextDoc);

    replies = [];
    target.change(changeRequest(2, edit));
    const stat = target.lastStat!;
    const incremental = lastSemantic()!;
    const emitted = replyTypes();

    const realigned = (() => {
      parseRound(3, nextDoc);
      return lastSemantic()!;
    })();

    // ① 判据（结构不变）：增量解出来的着色段必须与整篇重解逐字相等
    expect(incremental, '增量这一趟没有回 semantic').not.toBeNull();
    expect(incremental, '增量结果与整篇重解不等 ⇒ 树没被正确复用（把错的树留在手上着色）').toEqual(realigned);

    // ② 判据（局部性）：向文本取字的窗口必须贴着编辑点，而不是全文
    const window = stat.readEnd - stat.readStart;
    console.log(`\n===== ⑥ 单击键增量（${DOC_LINES} 行档，改第 ${row + 1} 行）=====`);
    console.log(`改动前结构段数      : ${baseline.length}`);
    console.log(`用得上旧树          : ${stat.incremental}`);
    console.log(`取字段数 / 窗口     : ${stat.reads} 段 / ${stat.readStart}..${stat.readEnd}（窗口 ${window} 码元 = 全文的 ${((window / nextDoc.length) * 100).toFixed(2)}%）`);
    console.log(`编辑点（新文本）    : ${stat.editStart}..${stat.editEnd}，文档 ${stat.documentLength} 码元`);
    console.log(`这一趟的回话        : ${emitted}`);
    console.log(`本机进程 RSS        : ${rssMb()} MB`);
    expect(stat.incremental, '这一次没有走增量（旧树没被用上）').toBe(true);
    expect(stat.reads, '增量取字段数超过"改动附近几段"的量级 ⇒ 实际在重解全文').toBeLessThanOrEqual(8);
    expect(window, '取字窗口占了全文的两成以上 ⇒ 局部性不成立').toBeLessThan(nextDoc.length * 0.2);
    expect(stat.readStart, '取字起点不在编辑点附近').toBeGreaterThanOrEqual(stat.editStart - STRUCTURE_READ_CHUNK);
    expect(stat.readEnd, '取字终点不在编辑点附近').toBeLessThanOrEqual(stat.editEnd + 2 * STRUCTURE_READ_CHUNK);
    expect(stat.documentLength).toBe(nextDoc.length);
    expect(emitted, '增量这一趟只该回 semantic（folds/indents 查询本批无捕获 ⇒ 装配时就已回落）').toBe('semantic');
    expect(fatalSeen, `增量期间出现整档停用级别的错误：${JSON.stringify(fatalSeen)}`).toHaveLength(0);
  });

  it(`${EDIT_RUNS} 次单击键增量：p50/p95（目标 <16 ms 一帧）`, () => {
    const target = requireEngine();
    const doc = syntheticDoc();
    target.parse(PERF_DOC, 1, doc);
    let current = doc;
    const starts = lineStarts(current);
    const editSamples: number[] = [];
    const readSamples: number[] = [];
    const tokenSamples = new Set<number>();
    for (let run = 0; run < EDIT_RUNS; run++) {
      const row = 50 + ((run * 173) % (starts.length - 80));
      const at = starts[row]!;
      const nextDoc = `${current.slice(0, at)}X${current.slice(at)}`;
      const edit = commonEdit(current, nextDoc);
      replies = [];
      const t0 = performance.now();
      target.change(changeRequest(run + 2, edit));
      editSamples.push(performance.now() - t0);
      readSamples.push(target.lastStat!.reads);
      tokenSamples.add(lastSemantic()?.length ?? 0);
      current = nextDoc;
    }
    const reading = latency(editSamples);
    const full = coldReading;
    expect(full, '冷全量解读数还没跑（比值判据要有对照）').not.toBeNull();
    console.log(`\n===== ⑦ 单击键增量 p50/p95（同一台引擎、同一份 ${DOC_LINES} 行档）=====`);
    console.log(`增量解（parse + 查询 + 回话）: ${fmt(reading)}`);
    console.log(`对照·整篇重解（⑤ 那一轮）   : ${fmt(full!)}`);
    console.log(`增量取字段数                : 中位 ${quantile([...readSamples].sort((a, b) => a - b), 0.5)} / 最大 ${Math.max(...readSamples)}`);
    console.log(`每一击键的结构段数          : ${[...tokenSamples].join(' / ')}（不随击键漂移 = 增量没把树解歪）`);
    console.log(`目标线 16 ms：${reading.p95 < 16 ? '达标' : '未达标'}（p95 = ${reading.p95.toFixed(2)} ms，余量 ${(16 / reading.p95).toFixed(2)}×）`);
    console.log(`本机进程 RSS（这一轮量完）   : ${rssMb()} MB`);
    expect(reading.runs).toBe(EDIT_RUNS);
    // 结构判据（比值，不靠绝对毫秒）：增量必须比整篇重解便宜。
    // 系数只取 1.2（本机实测 1.55–1.85 倍）——**大头是每击键那一遍全文查询**，不是 parse：
    // 本批另测（一次性、不入库的取数量法）同一台引擎只解不跑查询时增量 p50 ≈ 2.8 ms / p95 ≈ 3.3 ms，
    // 跑完 highlights 查询后 9–11 ms ⇒ 想再往下压击键延迟要动的是"查询只跑改动范围"，
    // 不是 parse（TODO 给下一批：`Query.captures(tree.changedRanges)` 那一路）。
    // 系数不敢取大：真翻这一条的形态是"有人把整篇重解塞回 change()"，那时比值直接回到 1.0 以下。
    expect(
      reading.p50 * 1.2,
      `增量 p50 ${reading.p50.toFixed(2)} ms 已经不像增量（整篇重解 p50 ${full!.p50.toFixed(2)} ms）⇒ 有人把全文重解塞回来了`,
    ).toBeLessThan(full!.p50);
    // 极松绝对上界：一帧线 16 ms 的 10 倍。真翻这一条 = 已经不是"抖一下"，而是量级变了。
    expect(reading.p95, `增量 p95 ${reading.p95.toFixed(1)} ms 超宽松上界`).toBeLessThan(160);
    // 取字窗口与文档规模解耦（每击键只该取改动附近那几段）
    expect(Math.max(...readSamples), '某次击键取了 16 段以上 ⇒ 增量退化成全文重扫').toBeLessThanOrEqual(16);
    expect(fatalSeen, `增量循环出现整档停用级别的错误：${JSON.stringify(fatalSeen)}`).toHaveLength(0);
  });

  it('没有旧树时退回整篇重解（而"有旧树"那一趟确实是增量）', async () => {
    const fresh: StructureEngine[] = [];
    const engine2 = new StructureEngine({
      assets,
      emit: (message) => {
        replies.push(message);
        if (message.type === 'error' && message.capability === 'all') fatalSeen.push(message);
      },
    });
    fresh.push(engine2);
    const before = replies.length;
    // 未装配就投递 change ⇒ 引擎一个字都不该回（worker 那一侧由"尚未装配"分支说出去）
    engine2.change(changeRequest(1, commonEdit('', 'x')));
    expect(replies.length, '未装配的引擎不该自己回话（worker 的"尚未装配"分支才该说）').toBe(before);
    expect(engine2.lastStat).toBeNull();

    await engine2.init();
    const doc = syntheticDoc(200);
    engine2.parse(PERF_DOC, 1, doc);
    const cold = engine2.lastStat!;
    expect(cold.incremental, 'parse 消息不该冒充增量').toBe(false);

    const nextDoc = `${doc.slice(0, 10)}Y${doc.slice(10)}`;
    engine2.change(changeRequest(2, commonEdit(doc, nextDoc)));
    const stat = engine2.lastStat!;
    console.log(`小档（200 行）无旧树那一次：incremental=${cold.incremental} 取字 ${cold.reads} 段；有旧树：incremental=${stat.incremental} 取字 ${stat.reads} 段`);
    expect(stat.incremental).toBe(true);
    expect(stat.reads).toBeLessThanOrEqual(8);
    for (const one of fresh) one.dispose();
  });
});
