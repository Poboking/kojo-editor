#!/usr/bin/env node
/**
 * tree-sitter 结构解析 · **增量 == 全量 随机编辑等价闸**的执行体（父进程 = `tests/tree-sitter-incremental-fuzz.test.ts`）。
 *
 * ## 这个文件同时是两样东西
 *
 * 1. **纯字符串侧的共用口径**（父进程 `import` 它拿种子/夹具表/编辑算子）：`buildFuzzSequence()`
 *    只用 `slice`/行表算术把"随机编辑序列"算出来，不碰 wasm、不 import 引擎；父子各自算同一份 ⇒
 *    父进程可以拿每一版的 `docLength` 核子进程"确实解的是那一份文本"（编辑点一漂，等价判据就比的是空气）；
 * 2. **子进程执行体**（`node <本文件> --fuzz-child <夹具> <种子> <起始步>`）：在这里才动态 `import()`
 *    生产引擎 `src/monaco/tree-sitter/engine.ts` 与 `src/monaco/tree-sitter/edit.ts` 本体，
 *    走的是 worker 那一条真实增分路（`commonEdit` → `change()` 里的 `tree.edit` + 有界取字重解 +
 *    脏段窗口拼装），**不另写简化版**。
 *
 * ## 为什么必须搬进子进程（照 `tree-sitter-perf-child.mjs` 的条例，不是新造的规矩）
 *
 * web-tree-sitter 0.27 + Node 24（Windows）实测：同一进程只要解过一次档，退出时必在 V8
 * `DisposeIsolate` 报 `Fatal process out of memory: Zone` 中止；且**每解一次**原生 RSS 抬
 * 数 MB 到上百 MB 且**不还给操作系统**（本闸实测：7.5 KB 档、每步"1 次增量 + 1 次整篇"
 * ≈ 11 MB/步，90 步即 ~950 MB）。父进程（vitest fork）亲自碰 wasm ⇒ 整条池子收尾被判崩。
 * ⇒ **退出码不作判据**，只认 stdout 最后一行 JSON（`docs/PITFALLS.md` 第 138 条那条假读数事故的
 * 纪律：先证明进程给的读数可信，再谈它的数）。
 *
 * 因为每子进程只能扛几十步，本闸按 **RSS 预算自适应切子进程**：一台子进程跑到
 * `FUZZ_MAX_STEPS_PER_CHILD` 步或 RSS 顶到 `FUZZ_RSS_BUDGET_MB` 就收摊，父进程用同一条纯字符串
 * 序列从 `起始步` 续跑下一台。切法不影响判据（每步仍与"同一内容从零整篇重解"对账）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ============================ 共用口径（纯字符串） ============================ */

/** 固定种子（写死 ⇒ 任何一条红都能逐字复现） */
export const FUZZ_SEEDS: readonly number[] = [0x5bd1e95a, 0x1f123bb5, 0x2545f491];

/** 每条序列的编辑次数下限（判据要求 ≥200） */
export const FUZZ_EDITS_PER_SEQUENCE = 200;

/** 单子进程最多跑几步（RSS 之外第二道闸，见文件头实测 11 MB/步） */
export const FUZZ_MAX_STEPS_PER_CHILD = 40;

/** 单子进程 RSS 预算（MB）：顶到就回话，让父进程换一台接着跑 */
export const FUZZ_RSS_BUDGET_MB = 520;

/** 一条序列最多换几台子进程（超过就是父子的切法出问题了，直接红而不是死循环） */
export const FUZZ_MAX_CHILDREN_PER_SEQUENCE = 30;

/**
 * 夹具表：`real` = 真实语料形状（块嵌套 + 制表符缩进 + 尾随空行，直接取仓库里的 `.kojo` 黄金件）；
 * `broken` = 故意残缺（错误恢复下的等价才是真等价）。
 */
export interface FuzzFixture {
  readonly id: string;
  readonly path: string;
  readonly shape: 'real' | 'broken';
}

export const FUZZ_FIXTURES: readonly FuzzFixture[] = [
  {
    id: 'hasei',
    path: 'packages/plugins/kojo-sugar/tests/goldens/corpus-k12-lumia-hasei.kojo',
    shape: 'real',
  },
  {
    id: 'broken-unclosed-block',
    path: 'packages/kojo-syntax-tree/tests/fixtures/broken-unclosed-block.kojo',
    shape: 'broken',
  },
  {
    id: 'broken-unterminated-string',
    path: 'packages/kojo-syntax-tree/tests/fixtures/broken-unterminated-string.kojo',
    shape: 'broken',
  },
];

/** 编辑形状（判据要求逐类覆盖；一条序列里每一类都必须至少出现过一次，否则闸是空转的） */
export const FUZZ_EDIT_KINDS = [
  'insertLine',
  'pasteBlock',
  'deleteRange',
  'inlineInsert',
  'inlineDelete',
  'blankLineAtBoundary',
  'splitLine',
  'joinLines',
] as const;

export type FuzzEditKind = (typeof FUZZ_EDIT_KINDS)[number];

/** 一步编辑：对旧文本的一次 splice（`offset` 起删 `deleteCount` 码元、插 `insert`） */
export interface FuzzEdit {
  readonly step: number;
  readonly kind: FuzzEditKind;
  readonly offset: number;
  readonly deleteCount: number;
  readonly insert: string;
  /** 起点行/列（旧文本坐标系，0 基；只为断言消息服务） */
  readonly row: number;
  readonly column: number;
  /** 删掉的那一段旧文本（截断到 40 码元，供人读） */
  readonly removed: string;
  /** 编辑后的文档码元数（父进程据此核对子进程真的走到同一版文本） */
  readonly nextLength: number;
}

/** mulberry32：32 位整数算术，父子逐位相同（不依赖 Math.random、不依赖任何平台浮点技巧） */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 行首偏移表（0 基行号 → 码元偏移；与 `tree-sitter-perf-corpus.ts` 同一条口径） */
export function fuzzLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * 按一步编辑把旧文本缝成新文本（父子唯一的"应用"口径）。
 *
 * 参数取**结构子集**（`offset/deleteCount/insert` 三格就是这条算式读的全部）：序列生成期先算出
 * 未贴 `nextLength` 的那一枚编辑（`Omit<FuzzEdit, 'nextLength'>`），贴上长度是下一步的事；
 * 传完整 `FuzzEdit` 照样接（子集是它的超型），判据逻辑一个字没动。
 */
export function applyFuzzEdit(text: string, edit: Pick<FuzzEdit, 'offset' | 'deleteCount' | 'insert'>): string {
  return text.slice(0, edit.offset) + edit.insert + text.slice(edit.offset + edit.deleteCount);
}

/** 插入用的行池：块头 / 更深正文 / 台词 / 旁白 / 注释 / 收束词 / 空行 / 带代理对的一行 */
const FUZZ_LINE_POOL: readonly string[] = [
  '角色: 12',
  '时机 指令 300 成否: 游戏判定：',
  '\t如果 CFLAG:ブチギレ == 1：',
  '\t\t随机：',
  '\t\t\tPRINTFORMW 「就算是%CALLNAME:MASTER%也不能原谅啊ー」',
  '\t\t\t「现在不想说话啊ー？」',
  '\t\t否则：',
  '\t\t\t「……哼」😀',
  '\t\t\t「笨ー蛋！略略略！」',
  '\t否则如果 TCVAR:302 || TFLAG:193 < 0：',
  '\t\t「能不能聊点别的？」',
  '\t\t等待',
  '\t结束',
  '循环结束',
  ';这里是注释行，作者拿来分节',
  '着色 0xFF8080：',
  '\t「这句用作者色」',
  '结束',
  '心形 「还想做……舒服ー的事……HPH」 续',
  '',
  '  ',
  '\t',
  '空行',
  '隐藏情景: 如果 她的诶嘿嘿 == 0',
  'PRINTFORMW 她的呼吸乱了半拍。',
  '    选项：',
  '        「用亲吻代替回答」：',
  '            「……唔。」',
];

/** 行内插入用的碎片池（短、跨形状：台词引号 / 插值花括号 / 制表符 / 引擎指令尾巴） */
const FUZZ_INLINE_POOL: readonly string[] = [
  '「插一句」',
  '{A}',
  '{',
  '「',
  '\t\t',
  ' ',
  'IF FLAG:70',
  'ENDIF',
  '%CALLNAME:MASTER%',
  '😀',
  '循环结束',
];

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length]!;
}

function randInt(rng: () => number, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  return Math.floor(rng() * maxExclusive) % maxExclusive;
}

/**
 * 这一行的"结构边界"判定（`blankLineAtBoundary` 的落点候选）：
 * 块首（行尾带 `：`）、缩进边界（与上一行缩进不同）、以及档尾。
 * 返回该边界的**行首偏移**（在其前插空行）与一句人话理由。
 */
function structuralBoundaries(text: string): { offset: number; why: string }[] {
  const starts = fuzzLineStarts(text);
  const out: { offset: number; why: string }[] = [];
  const indentOf = (line: string): number => /^[ \t]*/.exec(line)![0].length;
  for (let row = 0; row < starts.length - 1; row++) {
    const from = starts[row]!;
    const to = starts[row + 1]!;
    const line = text.slice(from, to - 1);
    if (row === 0 || line.trimEnd().endsWith('：') || line.trimEnd().endsWith(':')) {
      out.push({ offset: from, why: `块首/文件首（第 ${row + 1} 行之前）` });
    } else if (indentOf(line) !== indentOf(text.slice(starts[row - 1]!, from - 1))) {
      out.push({ offset: from, why: `缩进边界（第 ${row + 1} 行之前）` });
    }
  }
  out.push({ offset: text.length, why: '档尾' });
  return out;
}

/**
 * 生成一条定长随机编辑序列（**纯字符串算术**：父子各自算同一份，谁也不给谁发文本）。
 *
 * 形状覆盖由前 8 步的"轮转"保证（每一类各占一步，落不进就去掉重选），之后完全按 rng 抽；
 * 文本被删空 ⇒ 只许插入；文本长过上限 ⇒ 只许删（否则 200 步会把档撑到解不动）。
 */
export function buildFuzzSequence(initialText: string, seed: number, steps: number): FuzzEdit[] {
  const rng = makeRng(seed);
  const growthCap = Math.max(initialText.length * 3, 4_000);
  let text = initialText;
  const edits: FuzzEdit[] = [];
  const used = new Set<FuzzEditKind>();

  for (let step = 0; step < steps; step++) {
    const remaining = steps - step;
    const missing = FUZZ_EDIT_KINDS.filter((kind) => !used.has(kind));
    let kind: FuzzEditKind | null = null;
    // 还够不到"每类都出现过"这一条时优先补类，补不动（不合法）就回随机
    for (const candidate of missing.length >= remaining ? missing : []) {
      if (kindEligible(candidate, text)) {
        kind = candidate;
        break;
      }
    }
    if (kind === null) kind = chooseKind(rng, text, growthCap, used, missing);
    const edit = makeEdit(kind, step, text, rng);
    used.add(kind);
    text = applyFuzzEdit(text, edit);
    edits.push({ ...edit, nextLength: text.length });
  }
  return edits;
}

function kindEligible(kind: FuzzEditKind, text: string): boolean {
  const starts = fuzzLineStarts(text);
  switch (kind) {
    case 'insertLine':
    case 'pasteBlock':
    case 'blankLineAtBoundary':
      return true;
    case 'inlineInsert':
    case 'inlineDelete':
    case 'splitLine':
      return text.length > 0;
    case 'deleteRange':
      return text.length > 0;
    case 'joinLines':
      return starts.length > 1;
  }
}

function chooseKind(
  rng: () => number,
  text: string,
  growthCap: number,
  used: Set<FuzzEditKind>,
  missing: readonly FuzzEditKind[],
): FuzzEditKind {
  const growing = text.length > growthCap;
  const eligible = FUZZ_EDIT_KINDS.filter((kind) => kindEligible(kind, text));
  if (growing) {
    const shrinking = eligible.filter((kind) => kind === 'deleteRange' || kind === 'inlineDelete' || kind === 'joinLines');
    return pick(rng, shrinking);
  }
  // 每 5 步里留一步给"还没出现过"的那一类（前 8 步的轮转之外再兜一次，覆盖率判据才稳）
  if (used.size < FUZZ_EDIT_KINDS.length && missing.length > 0 && rng() < 0.5) {
    const candidates = missing.filter((kind) => kindEligible(kind, text));
    if (candidates.length > 0) return pick(rng, candidates);
  }
  return pick(rng, eligible);
}

function makeEdit(kind: FuzzEditKind, step: number, text: string, rng: () => number): Omit<FuzzEdit, 'nextLength'> {
  const starts = fuzzLineStarts(text);
  const lineCount = starts.length - 1; // 最后一行之后的 "" 不算行
  const rowOf = (offset: number): number => {
    let row = 0;
    while (row < starts.length && starts[row]! <= offset) row++;
    return row - 1;
  };
  const lineText = (row: number): string =>
    text.slice(starts[row]!, row + 1 < starts.length ? starts[row + 1]! - 1 : text.length);

  let offset = 0;
  let deleteCount = 0;
  let insert = '';

  switch (kind) {
    case 'insertLine': {
      const row = randInt(rng, lineCount + 1);
      offset = starts[Math.min(row, lineCount)]!;
      insert = `${pick(rng, FUZZ_LINE_POOL)}\n`;
      break;
    }
    case 'pasteBlock': {
      // 跨行插入：一整段（块头 + 更深缩进的正文 + 收束），3..14 行，内部再随机塞空行
      const row = randInt(rng, lineCount + 1);
      offset = starts[Math.min(row, lineCount)]!;
      const bodyRows = 3 + randInt(rng, 12);
      const head = pick(rng, ['\t如果 CFLAG:1 == 1：', '时机 指令 300 成否: 游戏判定：', '    选项：']);
      const lines = [head];
      for (let i = 0; i < bodyRows; i++) {
        if (rng() < 0.18) lines.push(rng() < 0.5 ? '' : '\t\t');
        else lines.push(`\t\t\t「粘贴第 ${i} 句」`);
      }
      lines.push(pick(rng, ['\t结束', '结束', '循环结束']));
      insert = `${lines.join('\n')}\n`;
      break;
    }
    case 'deleteRange': {
      // 整段删除：连续 1..3 行（含行末换行），末尾几行也允许（删到档尾）
      const row = randInt(rng, lineCount);
      const span = 1 + randInt(rng, 3);
      offset = starts[row]!;
      const endRow = Math.min(row + span, lineCount);
      deleteCount = (endRow < starts.length - 1 ? starts[endRow]! : text.length) - offset;
      break;
    }
    case 'inlineInsert': {
      const row = randInt(rng, lineCount);
      const line = lineText(row);
      offset = starts[row]! + randInt(rng, line.length + 1);
      insert = pick(rng, FUZZ_INLINE_POOL);
      break;
    }
    case 'inlineDelete': {
      const row = randInt(rng, lineCount);
      const line = lineText(row);
      if (line.length === 0) {
        // 空行没得删：退成删掉这一行的换行（合并两条），形状仍是"行内删除"的退化例
        offset = starts[row]!;
        deleteCount = 1;
        break;
      }
      const take = Math.min(1 + randInt(rng, 4), line.length);
      offset = starts[row]! + randInt(rng, line.length - take + 1);
      deleteCount = take;
      break;
    }
    case 'blankLineAtBoundary': {
      const bounds = structuralBoundaries(text);
      const bound = pick(rng, bounds);
      offset = bound.offset;
      // 一半给真·空行，一半给"只有缩进"的空行（缩进记号正是本语法增量最容易糊的地方）
      insert = rng() < 0.5 ? '\n' : `${pick(rng, ['\t', '  ', '\t\t'])}\n`;
      break;
    }
    case 'splitLine': {
      const row = randInt(rng, lineCount);
      const line = lineText(row);
      if (line.length < 3) {
        offset = starts[row]!;
        insert = '\n';
        break;
      }
      offset = starts[row]! + 1 + randInt(rng, line.length - 2);
      insert = `\n${pick(rng, ['', '\t', '\t\t', '        '])}`;
      break;
    }
    case 'joinLines': {
      const row = randInt(rng, lineCount); // 删掉第 row 行行末的那枚换行 ⇒ 上下合并
      offset = starts[row + 1]! - 1;
      deleteCount = 1;
      break;
    }
  }

  return {
    step,
    kind,
    offset,
    deleteCount,
    insert,
    row: rowOf(offset),
    column: offset - starts[rowOf(offset)]!,
    removed: text.slice(offset, offset + deleteCount).slice(0, 40),
  };
}

/* ============================== 子进程契约 ============================== */

/** 一步的对账记录（`mismatch` 为 null = 三面逐字相等；字符串 = 第一条差异，带期望/实际） */
export interface FuzzStepRecord {
  readonly step: number;
  readonly kind: string;
  readonly row: number;
  readonly offset: number;
  readonly deleteCount: number;
  readonly insertPreview: string;
  readonly removedPreview: string;
  readonly docLength: number;
  readonly lineCount: number;
  readonly deltaRows: number;
  readonly queryScope: 'window' | 'full' | 'none';
  readonly windowNodes: number;
  readonly changedRanges: number;
  readonly queryFullReason: string;
  /** 三面条数（增量那一趟；整篇真值的条数只在不等时进 `mismatch`） */
  readonly tokens: number;
  readonly folds: number;
  readonly faults: number;
  /** 与"同一内容从零整篇重解"的逐字对账结果（null = 等价） */
  readonly mismatch: string | null;
  /** 这一步逐字比过多少个元素（三面条数相加；父进程用它报总比较次数） */
  readonly comparedElements: number;
}

export interface FuzzChildResult {
  readonly fixtureId: string;
  readonly seed: number;
  readonly startStep: number;
  readonly fixtureLength: number;
  readonly records: readonly FuzzStepRecord[];
  /** 每台子进程开头那一次整篇打底（增量链的起点）也算一次解，不算判据 */
  readonly baselineCount: number;
  readonly fatal: readonly string[];
  readonly memory: { readonly peakRssMb: number };
  readonly error: string | null;
}

/** 三面逐字对账：相等回 null，不等回第一条差异（带两侧同位置元素与条数，够定位漂在哪一段） */
export function diffFuzzFaces(
  got: { tokens: unknown[] | null; folds: unknown[] | null; faults: unknown[] | null; truncated: boolean | null },
  want: { tokens: unknown[] | null; folds: unknown[] | null; faults: unknown[] | null; truncated: boolean | null },
): string | null {
  const faces: Array<['行分类序列' | '折叠区间' | '语法诊断', 'tokens' | 'folds' | 'faults']> = [
    ['行分类序列', 'tokens'],
    ['折叠区间', 'folds'],
    ['语法诊断', 'faults'],
  ];
  for (const [label, face] of faces) {
    const a = got[face];
    const b = want[face];
    if (a === null || b === null) {
      if (a !== b) return `${label}：增量这一趟没回这一面（${JSON.stringify(a)}），整篇真值回了 ${b === null ? 'null' : `${b.length} 条`}`;
      continue;
    }
    if (a.length !== b.length) {
      return `${label}：条数不等 增量 ${a.length} / 整篇 ${b.length}（增量首条 ${JSON.stringify(a[0])} / 整篇首条 ${JSON.stringify(b[0])}）`;
    }
    for (let i = 0; i < a.length; i++) {
      const x = JSON.stringify(a[i]);
      const y = JSON.stringify(b[i]);
      if (x !== y) {
        return `${label}：第 ${i} 条不等 ⇒ 期望（整篇重解）${y}、实际（增量）${x}｜前一条 期望 ${JSON.stringify(b[i - 1] ?? null)} / 实际 ${JSON.stringify(a[i - 1] ?? null)}`;
      }
    }
  }
  if (got.truncated !== want.truncated) return `语法诊断截断标记不等 增量 ${got.truncated} / 整篇 ${want.truncated}`;
  return null;
}

/* ================================ 子进程 ================================ */

const FUZZ_CHILD_FLAG = '--fuzz-child';

async function runChildMode(fixtureId: string, seed: number, startStep: number, maxSteps: number): Promise<FuzzChildResult> {
  const { registerHooks } = await import('node:module');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith('.')) {
          for (const suffix of ['.ts', '/index.ts']) {
            try {
              return nextResolve(specifier + suffix, context);
            } catch {
              /* 换下一个后缀再试 */
            }
          }
        }
        throw error;
      }
    },
  });

  const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests/helpers
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const tsDir = join(repoRoot, 'packages', 'app', 'src', 'monaco', 'tree-sitter');
  const urlOf = (file: string) => pathToFileURL(file).href;
  const { StructureEngine } = (await import(urlOf(join(tsDir, 'engine.ts')))) as {
    StructureEngine: new (options: unknown) => ChildEngine;
  };
  const { commonEdit, applyEdit } = (await import(urlOf(join(tsDir, 'edit.ts')))) as {
    commonEdit: (a: string, b: string) => unknown;
    applyEdit: (a: string, b: { start: { offset: number }; oldEnd: { offset: number } }) => string;
  };

  /** 引擎对测试暴露的那点面（用结构型写，免得子进程再引一遍类型） */
  interface ChildEngine {
    init(): Promise<boolean>;
    parse(doc: number, version: number, text: string): void;
    change(request: Record<string, unknown>): void;
    dispose(): void;
    /** 引擎自己那份文本（`engine.ts` 明写"只给诊断/测试用"，这里正是用它核缝合） */
    readonly text: string;
    lastStat: {
      incremental: boolean;
      queryScope: 'window' | 'full' | 'none';
      windowNodes: number;
      changedRanges: number;
      queryFullReason: string;
    };
  }

  const fixture = FUZZ_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`未知夹具：${fixtureId}`);
  const fixtureText = readFileSync(join(repoRoot, fixture.path), 'utf8');

  const assets = {
    runtimeWasm: join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    kojoWasm: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'tree-sitter-kojo.wasm')),
    highlightsQuery: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'queries', 'highlights.scm'), 'utf8'),
    foldsQuery: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'queries', 'folds.scm'), 'utf8'),
    indentsQuery: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'queries', 'indents.scm'), 'utf8'),
  };

  const mkEngine = () => {
    const replies: any[] = [];
    const fatal: string[] = [];
    const engine = new StructureEngine({
      assets,
      emit: (message: any) => {
        replies.push(message);
        if (message.type === 'error' && message.capability === 'all') fatal.push(message.message);
      },
    });
    return { engine, replies, fatal };
  };
  const lastReply = (replies: any[], type: string) => {
    for (let i = replies.length - 1; i >= 0; i--) if (replies[i]!.type === type) return replies[i];
    return null;
  };
  const facesOf = (replies: any[]) => ({
    tokens: lastReply(replies, 'semantic')?.tokens ?? null,
    folds: lastReply(replies, 'folds')?.folds ?? null,
    faults: lastReply(replies, 'syntax')?.faults ?? null,
    truncated: lastReply(replies, 'syntax') ? Boolean(lastReply(replies, 'syntax')!.truncated) : null,
  });

  const incremental = mkEngine();
  const truth = mkEngine();
  const okInc = await incremental.engine.init();
  const okTruth = await truth.engine.init();
  if (!okInc || !okTruth) throw new Error(`引擎装配失败：${JSON.stringify([incremental.fatal, truth.fatal])}`);

  // 纯字符串重放到 startStep（父子同一条 buildFuzzSequence ⇒ 不需要跨进程传文本）
  const edits = buildFuzzSequence(fixtureText, seed, FUZZ_EDITS_PER_SEQUENCE);
  let text = fixtureText;
  for (let i = 0; i < startStep; i++) text = applyFuzzEdit(text, edits[i]!);

  incremental.engine.parse(1, 1, text);
  truth.engine.parse(1, 1, text);
  const baselineCount = (lastReply(incremental.replies, 'semantic')?.tokens ?? []).length;
  incremental.replies.length = 0;
  truth.replies.length = 0;

  const MB = 1048576;
  let peakRssMb = Math.round(process.memoryUsage().rss / MB);
  const records: FuzzStepRecord[] = [];
  const endStep = Math.min(FUZZ_EDITS_PER_SEQUENCE, startStep + maxSteps);
  const fatalAll = [...incremental.fatal, ...truth.fatal];

  for (let step = startStep; step < endStep; step++) {
    const edit = edits[step]!;
    const nextText = applyFuzzEdit(text, edit);
    const change = commonEdit(text, nextText) as any;
    const version = step + 2;
    // 缝合自检（与宿主 `client.ts` 同一条口径）：引擎自己那份文本必须与这份文档逐字相等，
    // 否则后面比的就不是同一份文档，等价判据全部作废 ⇒ 把它报成一步"不等价"，不静默。
    const beforeText = incremental.engine.text;
    const stitched = applyEdit(text, change as never) === nextText && beforeText === text;
    incremental.engine.change({ type: 'change', doc: 1, version, ...change });
    truth.engine.parse(1, version, nextText);

    const got = facesOf(incremental.replies);
    const want = facesOf(truth.replies);
    const stat = incremental.engine.lastStat;
    const drift =
      stitched && incremental.engine.text === nextText
        ? null
        : `缝合自检失败：引擎内部 ${beforeText.length}→${incremental.engine.text.length} 码元，应有 ${text.length}→${nextText.length}` +
          `（编辑 ${change.start.offset}..${change.oldEnd.offset}→${change.newEnd.offset}，newText ${JSON.stringify(change.newText.slice(0, 40))}）` +
          ` ⇒ 两侧比的不是同一份文本`;
    records.push({
      step,
      kind: edit.kind,
      row: edit.row,
      offset: edit.offset,
      deleteCount: edit.deleteCount,
      insertPreview: JSON.stringify(edit.insert.slice(0, 40)),
      removedPreview: JSON.stringify(edit.removed),
      docLength: nextText.length,
      lineCount: fuzzLineStarts(nextText).length - 1,
      deltaRows: change.newEnd.row - change.oldEnd.row,
      queryScope: stat.queryScope,
      windowNodes: stat.windowNodes,
      changedRanges: stat.changedRanges,
      queryFullReason: stat.queryFullReason,
      tokens: got.tokens ? got.tokens.length : -1,
      folds: got.folds ? got.folds.length : -1,
      faults: got.faults ? got.faults.length : -1,
      mismatch: drift ?? diffFuzzFaces(got, want),
      comparedElements:
        (got.tokens ? got.tokens.length : 0) + (got.folds ? got.folds.length : 0) + (got.faults ? got.faults.length : 0),
    });

    text = nextText;
    incremental.replies.length = 0;
    truth.replies.length = 0;
    peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / MB));
    if (peakRssMb >= FUZZ_RSS_BUDGET_MB) break; // 换一台子进程接着跑（父进程从 records 数推出下一步）
    if (fatalAll.length > 0) break; // 增量链已经停用，再跑只能比"没有回话"，白烧内存
  }

  const result: FuzzChildResult = {
    fixtureId,
    seed,
    startStep,
    fixtureLength: fixtureText.length,
    records,
    baselineCount,
    fatal: [...incremental.fatal, ...truth.fatal],
    memory: { peakRssMb },
    error: null,
  };
  incremental.engine.dispose();
  truth.engine.dispose();
  return result;
}

const result: FuzzChildResult = {
  fixtureId: '',
  seed: 0,
  startStep: 0,
  fixtureLength: 0,
  records: [],
  baselineCount: 0,
  fatal: [],
  memory: { peakRssMb: 0 },
  error: null,
};

if (process.argv[2] === FUZZ_CHILD_FLAG) {
  try {
    Object.assign(
      result,
      await runChildMode(
        process.argv[3] ?? '',
        Number(process.argv[4] ?? '0'),
        Number(process.argv[5] ?? '0'),
        Number(process.argv[6] ?? String(FUZZ_MAX_STEPS_PER_CHILD)),
      ),
    );
  } catch (error: unknown) {
    // 字段是 readonly（回话形状与判据同源，不许谁想写就写）⇒ 出错路径照 Object.assign 的写法贴值
    Object.assign(result, {
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
  }
  // 同步写 stdout：本进程随后（见文件头）会在退出时被 V8 中止，异步 flush 指望不上。
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
