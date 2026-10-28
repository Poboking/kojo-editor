/**
 * 结构叠层 · **窗口 / 缓存那三条腿的不变量**（TSIT3-D 的定位闸）。
 *
 * ## 与等价闸的分工（不是重复量一遍）
 *
 * `tests/tree-sitter-incremental-fuzz.test.ts` 是**判据**：1,800 步随机编辑逐字节对账，
 * 红了只说"哪一步不等价"。本文件是**定位**：三条各 1–2 击的手写最小用例，一条一个成因，
 * 谁把哪条规则改坏了就红在哪一条上，不必再从 344 步里捞。
 *
 * ## 钉住的三条（2026-10-19 那条真缺陷的三个成因，逐个钉死）
 *
 * 1. **作废跨度的右端必须盖住"被删掉的那一段"**：改动一直伸到文末时，窗口的最后一枚顶层节点
 *    只能盖到新版文档的末尾，落在被删区间里的缓存条目会满足"整枚在窗口之后"而被**平移复用** ⇒
 *    屏上凭空多出删掉的着色段。
 * 2. **窗口外的槽，平移之后必须仍等于整篇**：折叠的止行除了节点自身，还依赖"块后面那段空白 +
 *    其后第一枚正文行"（那些行不在节点的码元段里）⇒ 只看槽段就把这一枚判成"整枚在窗口之前"，
 *    留下的是一份**过期止行**。
 * 3. **报给 `tree.edit` 的起点要往前推**：一枚块头能不能把改动区间吞进自己身体，由它**后面**的
 *    文本决定，而改动之前的顶层节点会被当成已经收束的成品复用 ⇒ 树本身就与冷解不等，
 *    后面三面怎么查都追不回来（这一条必须在**编辑链**上才量得到：同一条编辑接在冷解的树上不漂，
 *    实测见用例③的注释）。
 *
 * ## 判据形态（三条都是"增量 == 整篇逐字节"，但额外钉住"确实走了那条路"）
 *
 * 只比"增量 == 整篇"是可以被**把窗口拆掉、每击键整篇重查**糊过去的（那就不叫增量了）。所以
 * ①②另外钉 `queryScope === 'window'`：这两步必须**走缓存拼装**还对；③另外钉 `reparseFrom`
 * 确实早于本次编辑起点（推及起点这条规则真的接上了）。
 *
 * ## 为什么可以直接在池子里碰 wasm
 *
 * 每台引擎各解 1–3 击、文档只有几行，与 `tree-sitter-diagnostics.test.ts` 同一档位；
 * `docs/PITFALLS.md` 第 138 条那条"解过档的进程收尾必 Zone 中止"是在**大档 × 上百次**那一档
 * 才把 fork 顶爆（所以 fuzz / perf 两池才搬子进程）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StructureEngine } from '../src/monaco/tree-sitter/engine';
import { commonEdit } from '../src/monaco/tree-sitter/edit';
import type {
  KojoStructureFold,
  KojoStructureReply,
  KojoStructureSyntaxFault,
  KojoStructureToken,
} from '../src/monaco/tree-sitter/types';

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const syntaxPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');

const assets = {
  runtimeWasm: join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  grammarWasm: readFileSync(join(syntaxPkg, 'tree-sitter-kojo.wasm')),
  highlightsQuery: readFileSync(join(syntaxPkg, 'queries', 'highlights.scm'), 'utf8'),
  foldsQuery: readFileSync(join(syntaxPkg, 'queries', 'folds.scm'), 'utf8'),
  indentsQuery: readFileSync(join(syntaxPkg, 'queries', 'indents.scm'), 'utf8'),
};

/** 一步编辑：第 `row` 行（0 基）行首再往后 `col` 码元起，删 `del` 码元、插 `ins` */
interface CaseEdit {
  readonly row: number;
  readonly col?: number;
  readonly del: number;
  readonly ins: string;
}

interface Faces {
  readonly tokens: readonly KojoStructureToken[] | null;
  readonly folds: readonly KojoStructureFold[] | null;
  readonly faults: readonly KojoStructureSyntaxFault[] | null;
}

interface StepRecord {
  readonly queryScope: 'window' | 'full' | 'none';
  readonly windowNodes: number;
  readonly reparseFrom: number;
  readonly editStart: number;
  readonly got: Faces;
  readonly want: Faces;
}

const engines: StructureEngine[] = [];

afterEach(() => {
  for (const engine of engines) engine.dispose();
  engines.length = 0;
});

async function mkEngine(): Promise<{ engine: StructureEngine; replies: KojoStructureReply[] }> {
  const replies: KojoStructureReply[] = [];
  const engine = new StructureEngine({ assets, emit: (reply) => replies.push(reply) });
  engines.push(engine);
  expect(await engine.init(), '真 wasm 没起来（本用例的判据全部依赖真语法）').toBe(true);
  return { engine, replies };
}

function facesOf(replies: readonly KojoStructureReply[]): Faces {
  const last = (type: KojoStructureReply['type']) => {
    for (let i = replies.length - 1; i >= 0; i--) if (replies[i]!.type === type) return replies[i];
    return null;
  };
  const semantic = last('semantic');
  const folds = last('folds');
  const syntax = last('syntax');
  return {
    tokens: semantic && semantic.type === 'semantic' ? semantic.tokens : null,
    folds: folds && folds.type === 'folds' ? folds.folds : null,
    faults: syntax && syntax.type === 'syntax' ? syntax.faults : null,
  };
}

function lineStart(text: string, row: number): number {
  let index = 0;
  for (let seen = 0; seen < row; seen++) {
    const newline = text.indexOf('\n', index);
    expect(newline, `用例的文本没有第 ${row + 1} 行`).toBeGreaterThan(-1);
    index = newline + 1;
  }
  return index;
}

/**
 * 把一条编辑链同时喂给"增量台"与"整篇台"（后者每击都从同一份文本冷解一遍 = 真值）。
 * 增量台走的就是 worker 那条路：`commonEdit` → `change()`（`tree.edit` + 有界取字重解 + 窗口拼装）。
 * `base` = 动手之前那一份的三面（用例用它自证"这一步真的改掉了东西"，不是比两份空表）。
 */
async function replay(text0: string, edits: readonly CaseEdit[]): Promise<{ base: Faces; steps: StepRecord[] }> {
  const inc = await mkEngine();
  const truth = await mkEngine();
  let text = text0;
  inc.engine.parse(1, 1, text);
  truth.engine.parse(1, 1, text);
  const base = facesOf(inc.replies);
  const steps: StepRecord[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const offset = lineStart(text, edit.row) + (edit.col ?? 0);
    const next = text.slice(0, offset) + edit.ins + text.slice(offset + edit.del);
    const change = commonEdit(text, next);
    inc.replies.length = 0;
    truth.replies.length = 0;
    inc.engine.change({ type: 'change', doc: 1, version: i + 2, ...change });
    truth.engine.parse(1, i + 2, next);
    const stat = inc.engine.lastStat!;
    steps.push({
      queryScope: stat.queryScope,
      windowNodes: stat.windowNodes,
      reparseFrom: stat.reparseFrom,
      editStart: change.start.offset,
      got: facesOf(inc.replies),
      want: facesOf(truth.replies),
    });
    text = next;
  }
  return { base, steps };
}

/**
 * 顶格注释若干行做前缀：改动必须只是文档的**一小段**，否则"窗口盖住半篇 ⇒ 退回整篇"那条判据
 * 会先接住这一步，用例量的就不是拼装那条腿了（`queryScope === 'window'` 那条自证会当场红）。
 */
function filler(rows: number): string {
  return Array.from({ length: rows }, (_unused, index) => `;填充注释 ${index}`).join('\n');
}

const PREFIX_LINES = 24;

/** 三面逐字节对账的断言话术（红了要说清是哪一面、两侧各是什么） */
function expectEquivalent(step: StepRecord, invariant: string): void {
  for (const face of ['tokens', 'folds', 'faults'] as const) {
    expect(
      step.got[face],
      `${invariant}：${face} 不等 ⇒ 增量 ${JSON.stringify(step.got[face])} / 整篇 ${JSON.stringify(step.want[face])}（scope=${step.queryScope}）`,
    ).toEqual(step.want[face]);
  }
}

describe('结构叠层 · 窗口/缓存三条不变量（每一步增量都必须与整篇逐字节相等，并且确实走了那条路）', () => {
  it('①删掉一直伸到文末的区间：落在被删区间里的结果要作废，不许当成"窗口之后"平移复用', async () => {
    // 文末两行各带一条会着色的内容（注释 + 赋值头）。整段删到 EOF 时，窗口只能盖到新版文档
    // 末尾那一枚节点 ⇒ 被删区间里那两条若按"整枚在窗口之后"平移复用，屏上就是删掉的行还在着色。
    // 尾行**刻意不用台词**：2026-10-20 起"编辑碰了 「」⇒ 这一趟整篇重查"是硬规则（两枚台词串
    // 会被并成一枚、合并跨度起点落在窗口外），用台词做夹具会让这条用例走 full 而钉不住窗口那条腿。
    const tail = ';收尾注释\n变量甲 = 1\n';
    const doc = `${filler(PREFIX_LINES)}\n${tail}`;
    const { base, steps } = await replay(doc, [{ row: PREFIX_LINES, del: tail.length, ins: '' }]);
    const step = steps[0]!;
    expectEquivalent(step, '不变量①（文末整段删除）');
    // 这条必须是**真窗口**：靠退回整篇蒙对不算钉住（窗口拆了就等于没这条判据）
    expect(
      step.queryScope,
      `这一步没走查询窗口（窗口节点 ${step.windowNodes}）⇒ 本用例没量到拼装那条腿，要改前缀行数`,
    ).toBe('window');
    expect(step.windowNodes, '窗口里一枚顶层节点都没有 ⇒ queryScope 说的走窗口是空的').toBeGreaterThan(0);
    // 并且这一步真的"少了几条"：删掉的那两行确实各带着一条着色段
    expect(
      step.want.tokens!.length,
      `整篇真值该比改前少 ${base.tokens!.length - step.want.tokens!.length} 条；没少就说明夹具是空的`,
    ).toBeLessThan(base.tokens!.length);
  }, 120_000);

  it('②窗口外的槽平移后必须仍等于整篇：块后第一枚正文行被改空 ⇒ 折叠止行要跟着伸', async () => {
    // 最外层的块止于正文第 3 行（`「第二句」`），其后那一行原本是正文（`等待`）⇒ 止行不伸；
    // 把那一行删成空行后整篇要伸过去。只看槽段 [块起..块末] 会把这一枚判成"整枚在窗口之前"
    // 原样复用 ⇒ 留下的正是过期止行（等价闸实测的形状：增量 94-95 / 整篇 94-96）。
    const head = PREFIX_LINES;
    const doc = `${filler(head)}\n时机 指令 2 类型: SCOM：\n\t「第一句」\n\t「第二句」\n等待\n`;
    const { steps } = await replay(doc, [{ row: head + 3, del: '等待'.length, ins: '' }]);
    const step = steps[0]!;
    // 先证整篇那一侧真的伸了行（否则这条用例比的是空气）：块头行 head、正文末行 head+2
    const block = step.want.folds!.find((fold) => fold.startRow === head);
    expect(block, `整篇真值里该有从第 ${head + 1} 行起的块：${JSON.stringify(step.want.folds)}`).toBeDefined();
    expect(block!.endRow, '整篇真值应当把止行伸进被删空的那一行').toBeGreaterThan(head + 2);
    expectEquivalent(step, '不变量②（折叠的尾随空行依赖）');
    expect(step.queryScope, '这一步没走查询窗口 ⇒ 量不到拼装那条腿').toBe('window');
  }, 120_000);

  it('③链上的块头：报给 tree.edit 的起点必须往前推到"还可能被接长"的那枚顶层节点', async () => {
    // 第一击删掉收尾那一行（把旧树推进一次），第二击在块头后面的空行处粘一整段更深缩进的内容。
    // 冷解会把那一行的块头读成"吞到粘贴段末尾"的一枚块（⇒ 多出一条从块头行起的折叠），而只报
    // 真实区间的增量会把那枚块头留在"孤立块头"的形状上，并且一路带到序列末尾。
    // **实测**：同一条编辑接在刚冷解完的树上不漂（必须链上第二击才漂），所以这一条写两击；
    // 漂的时候即使三面退回整篇重查也追不回来——错的是树，不是缓存。
    const head = PREFIX_LINES;
    const doc = `${filler(head)}\n时机 指令 2 类型: SCOM：\n\n;下面原本是一条顶格注释\n「收尾台词」\n`;
    const { steps } = await replay(doc, [
      { row: head + 3, del: '「收尾台词」\n'.length, ins: '' },
      { row: head + 2, del: 0, ins: '\t如果 CFLAG:1 == 1：\n\t\t「粘贴的一句」\n\t结束\n' },
    ]);
    const step = steps[1]!;
    expect(
      step.want.folds!.some((fold) => fold.startRow === head),
      `整篇真值该把第 ${head + 1} 行读成块头（实际 ${JSON.stringify(step.want.folds)}）⇒ 夹具形状不对，本条量不到东西`,
    ).toBe(true);
    expectEquivalent(step, '不变量③（推及起点 / 解析腿）');
    // 推及起点这条规则真的接上了：报给 tree.edit 的起点早于本次编辑的真实起点
    expect(
      step.reparseFrom,
      `报给 tree.edit 的起点没往前推（${step.reparseFrom} vs 编辑起点 ${step.editStart}）`,
    ).toBeLessThan(step.editStart);
    expect(step.reparseFrom, '往前推不能推出文档外').toBeGreaterThanOrEqual(0);
  }, 120_000);

  /**
   * ④**同一份文本再问一次不重解**（R8 首帧分层的第二、三拍靠它）。
   *
   * 首帧分层把一次开文件拆成三条 `parse`（`client.ts::FRAME_BEATS`：折叠 → 语义 → 缩进+残缺），
   * 后两条的文本与版本一字未变。这条闸钉三件事：
   * - 后一拍**不重解**（`parseMs` 归零、树身份不换）——不然"折叠先上"省下的时间会被第二次整篇
   *   解析吃回去，着色反而更晚；
   * - 它补查出来的面与**同一份文本从零整篇解**逐字相等（缓存是这棵树的，不是碰巧没坏）；
   * - 文本一变就必须真解（不许把"变了"也吞成"没变"）。
   */
  it('④同一份文本再问一次：不重解、树身份不换，补查的面与整篇逐字相等；文本变了必须真解', async () => {
    const doc = `${filler(4)}\n时机 指令 2 类型: SCOM：\n\t「第一句」\n等待\n`;
    const { engine, replies } = await mkEngine();
    // 装配期那条 `indent` 回落（`indents.scm` 在 kojo 语法上没有捕获）不算这一趟的回话
    replies.length = 0;
    // 第一拍：只要折叠
    engine.parse(1, 1, doc, ['folds']);
    const foldFaces = replies.filter((reply) => reply.type !== 'error').map((reply) => reply.type);
    expect(foldFaces, '第一拍只该说折叠').toEqual(['folds']);
    const foldTree = engine.treeId;
    expect(engine.lastTimings.parseMs, '第一拍是真解，读数不该是 0').toBeGreaterThan(0);
    // 第二拍：同一份文本、同一版本，补语义 + 残缺
    replies.length = 0;
    engine.parse(1, 1, doc, ['semantic', 'syntax']);
    expect(engine.lastTimings.parseMs, '第二拍重解了 ⇒ R8 省下的时间会被它吃回去').toBe(0);
    expect(engine.treeId, '树没换过 ⇒ 树身份也不许换').toBe(foldTree);
    // 只看面（`error` 是"捕获没档位"那种一次性说明，这一拍第一次跑语义查询才说）
    const faces = replies.filter((reply) => reply.type !== 'error').map((reply) => reply.type).sort();
    expect(faces, '第二拍只该补点名的面').toEqual(['semantic', 'syntax']);
    // 真值：同一份文本从零整篇解一遍
    const truth = await mkEngine();
    truth.engine.parse(1, 1, doc);
    const got = facesOf(replies);
    const want = facesOf(truth.replies);
    expect(got.tokens, '补查出来的着色必须与整篇解逐字相等').toEqual(want.tokens);
    expect(got.tokens!.length, '夹具该有可比的着色段（否则这条比的是两份空表）').toBeGreaterThan(0);
    expect(got.faults, '补查出来的诊断也必须与整篇解逐字相等').toEqual(want.faults);
    // 文本变了 ⇒ 必须真解（这条闸不许把"变了"也当成"没变"）
    replies.length = 0;
    engine.parse(1, 2, `${doc};多出来的一行`);
    expect(engine.lastTimings.parseMs, '文本变了就必须重解').toBeGreaterThan(0);
    expect(engine.treeId, '重解了 ⇒ 树身份必须换').not.toBe(foldTree);
  }, 120_000);
});
