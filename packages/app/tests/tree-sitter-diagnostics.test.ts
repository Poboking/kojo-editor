import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineDecoration } from '@kojo/plugin-api';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { diagnosticDecorations } from '../../plugins/ui-sugar-editor/src/panel-logic';
import { StructureEngine } from '../src/monaco/tree-sitter/engine';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  DECORATOR_MARKER_OWNER,
  STRUCTURE_SYNTAX_OWNER,
  STRUCTURE_SYNTAX_SOURCE,
  blockHeadWord,
  closeWord,
  createStructureSyntaxPresenter,
  dropLinesAlreadyErrored,
  missingStructureName,
  syntaxErrorCode,
  syntaxFaultDecorations,
  syntaxFaultMessage,
  type StructureSyntaxPresenter,
} from '../src/monaco/tree-sitter/syntax-decorations';
import { onStructureDegradation, reportStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import {
  KOJO_STRUCTURE_MAX_SYNTAX_FAULTS,
  KOJO_STRUCTURE_SYNTAX_KINDS,
  type KojoStructureReply,
  type KojoStructureSyntaxFault,
} from '../src/monaco/tree-sitter/types';
import {
  disposeStructureOverlay,
  installStructureOverlay,
  structureOverlayLanguageStates,
  structureOverlayState,
} from '../src/monaco/tree-sitter/providers';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import type * as Monaco from '../src/monaco/entry';

/**
 * 结构残缺 → 行级波浪线（TSIT2-D：阶段3「错误必须看得见，并且说人话」）。
 *
 * ## 分两层打（哪一层证明什么，写明不装）
 *
 * **① 真语法 + 真 wasm（`StructureEngine`）**：本池起不了 Worker，但引擎就是 worker 里面
 * 那一台（`kojo-ts.worker.ts` 只剩消息环），所以"从 CST 折出来的残缺事实对不对"在这一层是真的——
 * 落点行、类别、块头文本、该等的收束记号，全部来自真树的真 ERROR / MISSING 节点。
 *
 * **② 纯判据 + 假 Monaco**：文案、诊断码、同一行不叠第二条、关掉/坏了清零。上屏器只碰
 * `getModelMarkers` / `setModelMarkers` / `onDidChangeMarkers` 三件 API，假对象就能逐条钉住。
 * **证不到的**：真 worker 线程的收发、真 Monaco 的渲染（归 `tools/smoke-tauri-*` 真壳）。
 *
 * ## 四条硬判据
 *
 * 1. **一处残缺一条波浪线，落在作者该看的那一行**：没收盘的块 ⇒ 落点 = 块头行
 *    （MISSING 记号本身零宽，指着那儿作者什么也看不见）；未闭合的 `「` / `{` ⇒ 落点 = 出错行；
 * 2. **文案是人话**：带行号、带"缺的是哪个写形"，屏上不出现 tree-sitter / ERROR / MISSING / CST；
 * 3. **不重复计数**：同一行、同一严重级、列区间相交的转译器那一路 error ⇒ 我们这条不画
 *    （`kojo-decorators` 那份 markers 就是判据真源，不另立台账）；同一行不同区间各画各的；
 * 4. **闸门与 fail-open**：偏好为关时上屏器根本不诞生（对 Monaco 零调用）；扫描/线程失败 ⇒
 *    装饰清零 + 台账说一次 + 绝不把异常抛回编辑链。
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const syntaxPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');
const FIXTURE_DIR = join(syntaxPkg, 'tests', 'fixtures');

const assets = {
  runtimeWasm: join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  grammarWasm: readFileSync(join(syntaxPkg, 'tree-sitter-kojo.wasm')),
  highlightsQuery: readFileSync(join(syntaxPkg, 'queries', 'highlights.scm'), 'utf8'),
  foldsQuery: readFileSync(join(syntaxPkg, 'queries', 'folds.scm'), 'utf8'),
  indentsQuery: readFileSync(join(syntaxPkg, 'queries', 'indents.scm'), 'utf8'),
};

const fixture = (name: string): string => readFileSync(join(FIXTURE_DIR, name), 'utf8');

/* ─────────────── ① 真语法：CST 的 ERROR / MISSING → 残缺事实 ─────────────── */

describe('结构残缺事实（真 wasm 折出来的那些行）', () => {
  let engines: StructureEngine[] = [];
  beforeEach(() => {
    engines = [];
  });
  afterEach(() => {
    for (const engine of engines) engine.dispose();
  });

  /** 整篇解一份，只取 `syntax` 那条腿（引擎就是 worker 里那一台，没有第二条调用形状） */
  async function faultsOf(text: string): Promise<{ faults: readonly KojoStructureSyntaxFault[]; truncated: boolean }> {
    const replies: KojoStructureReply[] = [];
    const engine = new StructureEngine({ assets, emit: (reply) => replies.push(reply) });
    engines.push(engine);
    expect(await engine.init(), '真 wasm 没起来').toBe(true);
    engine.parse(1, 1, text); // doc=1、version=1（协议要求内容回复带跨文档隔离号，这里只有一份文档）
    const reply = replies.find((r) => r.type === 'syntax');
    if (!reply || reply.type !== 'syntax') throw new Error('引擎没有回 syntax 这条腿');
    return { faults: reply.faults, truncated: reply.truncated };
  }

  it('没收盘的块：落点在块头行，带块头文本与该等的收束记号', async () => {
    const { faults } = await faultsOf(fixture('broken-unclosed-block.kojo'));
    const unclosed = faults.filter((f) => f.kind === 'unclosed-block');
    expect(unclosed.map((f) => f.row).sort((a, b) => a - b), '循环块在 0 基 14 行、出错处理块在 0 基 20 行').toEqual([14, 20]);
    expect(unclosed.map((f) => f.expectedToken).sort()).toEqual(['catch_end', 'loop_end']);
    expect(unclosed.map((f) => f.blockHeadText).sort()).toEqual(['出错处理：', '循环：']);
    // 残缺点（MISSING 插入点）跟着块走：文案要说"开到第几行"就靠它
    expect(unclosed.every((f) => f.faultRow > f.row)).toBe(true);
    // 错误被限制住：靠回缩收盘的 `如果` 块**不该**报（本 DSL 没有「如果结束」这个写形）
    expect(faults.some((f) => f.blockHeadText?.includes('如果'))).toBe(false);
    expect(faults.every((f) => f.kind === 'unclosed-block'), `不该掺进别的类别：${JSON.stringify(faults)}`).toBe(true);
    // 真事实 → 真人话（这一行就是"上屏的那两句话长什么样"的证据，不是合成输入的对照）
    const messages = faults.map((f) => syntaxFaultMessage(f));
    expect(messages).toContain('第 15 行的「循环」块没有等到「循环结束」——它一直开到第 17 行；请在收回缩进的那一行补写「循环结束」。');
    expect(messages).toContain('第 21 行的「出错处理」块没有等到「出错处理结束」——它一直开到第 22 行；请在收回缩进的那一行补写「出错处理结束」。');
  }, 180_000);

  it('块体内一条没写完的台词：ERROR 落自己那一行，类别是「台词引号没合上」', async () => {
    const { faults } = await faultsOf(fixture('broken-unclosed-string-in-block.kojo'));
    expect(faults).toHaveLength(1);
    expect(faults[0]?.kind).toBe('unterminated-string');
    expect(faults[0]?.row).toBe(6); // 第 7 行（0 基 6）
  }, 180_000);

  it('未闭合的「」与未闭合的 {} 各自落在自己那一行', async () => {
    const string = await faultsOf(fixture('broken-unterminated-string.kojo'));
    expect(string.faults.map((f) => f.kind)).toEqual(['unterminated-string']);
    expect(string.faults[0]?.row).toBe(4);
    const interp = await faultsOf(fixture('broken-unterminated-interp.kojo'));
    expect(interp.faults.map((f) => f.kind)).toEqual(['unterminated-interp']);
    expect(interp.faults[0]?.row).toBe(4);
  }, 180_000);

  it('未闭合台词（MISSING:speech_close）：文案点名「台词右引号」，落点在开引号那一行行尾（1 基列）', async () => {
    const { faults } = await faultsOf(fixture('broken-unterminated-string.kojo'));
    const fault = faults.find((f) => f.expectedToken === 'speech_close');
    expect(fault, '真语法应当把未闭合的「报成 MISSING:speech_close').toBeDefined();
    const message = syntaxFaultMessage(fault!);
    expect(message, '文案必须带上作者要补的那个人话名').toContain('「台词右引号」');
    expect(message, '机器记号名不许上屏').not.toContain('speech_close');
    const [decoration] = syntaxFaultDecorations([fault!]);
    // 第 5 行（0 基 4）行尾：`「这句台词忘了写右引号，行尾也没有折行符` 共 20 个码元 ⇒ 1 基 [21, 22)
    expect({ line: decoration?.line, start: decoration?.startColumn, end: decoration?.endColumn }).toEqual({
      line: 5,
      start: 21,
      end: 22,
    });
  }, 180_000);

  it('未闭合循环 / 出错处理：落点是块头（不是 MISSING 的零宽点），文案各点名收束词', async () => {
    const { faults } = await faultsOf(fixture('broken-unclosed-block.kojo'));
    const loop = faults.find((f) => f.expectedToken === 'loop_end');
    const caught = faults.find((f) => f.expectedToken === 'catch_end');
    expect(loop, '循环块应当有 MISSING:loop_end').toBeDefined();
    expect(caught, '出错处理块应当有 MISSING:catch_end').toBeDefined();
    expect(syntaxFaultMessage(loop!)).toContain('「循环结束」');
    expect(syntaxFaultMessage(caught!)).toContain('「出错处理结束」');
    const decorations = syntaxFaultDecorations([loop!, caught!]);
    // 两处落点都是块头行（第 15 / 21 行），列区间盖住块头词（1 基、末端排他）
    expect(decorations.map((d) => [d.line, d.startColumn, d.endColumn])).toEqual([
      [15, 5, 8],
      [21, 5, 10],
    ]);
  }, 180_000);

  it('文件末的未闭合结构：落点不跑到文外——块头在前、缺口行与最后一行自洽', async () => {
    const loopText = ['角色: 12', '时机 指令 310：', '    循环：', '        「一句。」'].join('\n');
    const loop = await faultsOf(loopText);
    expect(loop.faults).toHaveLength(1);
    expect(loop.faults[0]).toMatchObject({ row: 2, faultRow: 3, kind: 'unclosed-block', expectedToken: 'loop_end' });
    expect(syntaxFaultMessage(loop.faults[0]!)).toContain('第 4 行');

    const speechText = ['角色: 12', '时机 指令 310：', '「没写完'].join('\n');
    const speech = await faultsOf(speechText);
    expect(speech.faults).toHaveLength(1);
    expect(speech.faults[0]?.faultRow).toBe(2); // 文件最后一行（0 基 2），不跑到文外
    const [decoration] = syntaxFaultDecorations(speech.faults);
    expect({ line: decoration?.line, start: decoration?.startColumn, end: decoration?.endColumn }).toEqual({
      line: 3,
      start: 1,
      end: 5, // `「没写完` 共 4 个码元 ⇒ 1 基 [1, 5)
    });
  }, 180_000);

  it('同一处未闭合插值：真转译器与结构层各报一条 error ⇒ 只留转译器那条（最近邻），两边说法不打架', async () => {
    const text = ['角色: 12', '时机 指令 310：', '    {她的胆怯 ? 1 : 2'].join('\n');
    // 结构层：CST 的 ERROR → kojo.unterminated-interp
    const { faults } = await faultsOf(text);
    const structure = faults.filter((f) => f.kind === 'unterminated-interp');
    expect(structure, '结构层应当在这一行报未闭合插值').toHaveLength(1);
    // 插件层：真转译器 → interpolation-unclosed（同一个故障，两面各报一条）
    const sugar = createSugarTranspileService();
    const plugin: LineDecoration[] = diagnosticDecorations(
      sugar.transpile(text, { filePath: 'probe.kojo' }).diagnostics,
    ).filter((d) => d.code === 'interpolation-unclosed');
    expect(plugin, '转译器应当在同一行报插值未闭合').toHaveLength(1);
    expect(plugin[0]?.line).toBe(3);
    expect(plugin[0]?.severity).toBe('error');
    // 口径不冲突：两句话都在说"插值没闭合"，不是同一行两种说法
    const structureMessage = syntaxFaultMessage(structure[0]!);
    expect(plugin[0]?.message).toContain('插值');
    expect(structureMessage).toContain('插值');
    expect(structureMessage).toContain('}');
    // 去重：保留插件侧（语义判定的最近邻），结构层这一条退让
    expect(dropLinesAlreadyErrored(syntaxFaultDecorations(structure), plugin)).toEqual([]);
  }, 180_000);

  it('嵌套两层都没收盘：最内层那一枚先报（内层的块头行在前）', async () => {
    const text = ['角色: 12', '时机 指令 900：', '    循环：', '        循环：', '            「里层。」'].join('\n');
    const { faults } = await faultsOf(text);
    const unclosed = faults.filter((f) => f.kind === 'unclosed-block');
    expect(unclosed.length).toBeGreaterThanOrEqual(2);
    expect(unclosed[0]?.row, '深度优先：内层块头（0 基 3）先于外层（0 基 2）').toBe(3);
    expect(unclosed.map((f) => f.row).sort((a, b) => a - b)).toEqual([2, 3]);
  }, 180_000);

  it('写全了的文件：零残缺（真语料样本 + 一份写收盘的合成档）', async () => {
    const closed = ['角色: 12', '时机 指令 900：', '    循环：', '        「循环体。」', '    循环结束'].join('\n');
    expect((await faultsOf(closed)).faults).toEqual([]);
    for (const name of ['teaching-full.kojo', 'sample-310.kojo']) {
      const file = join(repoRoot, 'fixtures', 'sugar', name);
      if (!existsSync(file)) continue;
      const { faults } = await faultsOf(readFileSync(file, 'utf8'));
      expect(faults, `${name} 上真语法应当零 ERROR / 零 MISSING`).toEqual([]);
    }
  }, 180_000);

  it('一处残缺都不许跑到文外，且落点行 ≤ 残缺点行（文案里的两个行号要自洽）', async () => {
    for (const name of ['broken-unclosed-block.kojo', 'broken-unclosed-string-in-block.kojo', 'broken-unterminated-string.kojo', 'broken-unterminated-interp.kojo']) {
      const text = fixture(name);
      const lineCount = text.split('\n').length;
      const { faults } = await faultsOf(text);
      for (const fault of faults) {
        expect(fault.row).toBeGreaterThanOrEqual(0);
        expect(fault.row).toBeLessThan(lineCount);
        expect(fault.faultRow).toBeLessThan(lineCount);
        expect(fault.row).toBeLessThanOrEqual(fault.faultRow);
        expect(fault.column).toBeGreaterThanOrEqual(0);
        expect(fault.endColumn).toBeGreaterThan(fault.column);
      }
    }
  }, 180_000);

  it('残缺过多时截断并如实带 truncated（不把编辑器变成装饰刷）', async () => {
    // 形状：200 条**各自独立**的未收盘循环，每条都带正文与台词体 ⇒ 实测 64 条（= MAX）残缺 + truncated。
    // 为什么换形状：上一版用"1040 行连续未闭合的「"；台词串改成带子节点的规则之后，恢复器把它们
    // **并成 2 枚**（一枚没合上的引号不该画 1040 条波浪线，这是改进）⇒ 旧形状再也够不上截断门槛。
    const body = Array.from(
      { length: 200 },
      (_unused, i) => `    循环：\n        变量${i} = ${i}\n        「句 ${i}。」`,
    ).join('\n');
    const text = ['角色: 12', '时机 指令 900：', body].join('\n');
    const { faults, truncated } = await faultsOf(text);
    expect(truncated).toBe(true);
    expect(faults.length).toBeLessThanOrEqual(KOJO_STRUCTURE_MAX_SYNTAX_FAULTS);
  }, 180_000);

  it('1040 行连续未闭合的「：恢复器并成少数几枚，上屏条数有界且落点自洽', async () => {
    const text = Array.from({ length: 1040 }, (_unused, i) => `「第 ${i} 句没写完`).join('\n');
    const { faults, truncated } = await faultsOf(text);
    const lineCount = text.split('\n').length;
    // 并成 2 枚 ⇒ 够不上截断门槛；但"上屏条数有界 + 每条都指得回作者那一行"这条不变量照旧成立。
    expect(truncated).toBe(false);
    expect(faults.length).toBeLessThanOrEqual(2);
    for (const fault of faults) {
      expect(fault.kind).toBe('unterminated-string');
      expect(fault.row).toBeGreaterThanOrEqual(0);
      expect(fault.row).toBeLessThan(lineCount);
      expect(fault.faultRow).toBeLessThan(lineCount);
      expect(fault.row).toBeLessThanOrEqual(fault.faultRow);
      expect(fault.endColumn).toBeGreaterThan(fault.column);
    }
  }, 180_000);
});

/* ──────────────────── ② 文案与码（纯函数，上屏的那几句话） ──────────────────── */

const fault = (over: Partial<KojoStructureSyntaxFault> = {}): KojoStructureSyntaxFault => ({
  row: 4,
  endRow: 4,
  column: 2,
  endColumn: 9,
  faultRow: 4,
  kind: 'unexpected-token',
  ...over,
});

describe('文案：说清"哪里没闭合 / 期望什么"，屏上零机器词', () => {
  const BANNED = /tree-sitter|tree sitter|\bCST\b|\bERROR\b|\bMISSING\b|web-tree-sitter|wasm|worker/i;

  it('没收收盘的块：点名块头那一族与它该等的收束词，两个行号都给', () => {
    const message = syntaxFaultMessage(
      fault({ kind: 'unclosed-block', row: 14, faultRow: 16, blockHeadText: '循环：', blockHeadRow: 14, expectedToken: 'loop_end' }),
    );
    expect(message).toContain('第 15 行');
    expect(message).toContain('「循环」块');
    expect(message).toContain('「循环结束」');
    expect(message).toContain('第 17 行');
    expect(message.endsWith('。'), `文案以句号收尾（面板与悬浮里读起来是一句话）`).toBe(true);
    expect(message).not.toMatch(BANNED);
  });

  it('表外的收束记号：说"没等到它的收束词"，绝不编一个看起来像的词', () => {
    const message = syntaxFaultMessage(
      fault({ kind: 'unclosed-block', row: 3, faultRow: 8, blockHeadText: '数据表：', expectedToken: 'some_new_end' }),
    );
    expect(message).toContain('没有等到它的收束词');
    expect(message).not.toContain('循环结束');
    expect(message).not.toMatch(BANNED);
  });

  it.each([
    ['unterminated-string', '台词', '」'],
    ['unterminated-interp', '插值', '}'],
    ['unexpected-token', '读不通', ''],
  ] as const)('%s：带行号、说清缺什么（%s）', (kind, needle, extra) => {
    const message = syntaxFaultMessage(fault({ kind, row: 6 }));
    expect(message).toContain('第 7 行');
    expect(message).toContain(needle);
    if (extra) expect(message).toContain(extra);
    expect(message).not.toMatch(BANNED);
  });

  it('块头取词：`循环：`→循环、`时机 指令 900：`→时机、`如果 她的恋慕 > 30：`→如果', () => {
    expect(blockHeadWord('  循环：')).toBe('循环');
    expect(blockHeadWord('时机 指令 900：')).toBe('时机');
    expect(blockHeadWord('  如果 她的恋慕 > 30：')).toBe('如果');
    expect(blockHeadWord('')).toBeNull();
    expect(blockHeadWord(undefined)).toBeNull();
  });

  it('每一类都有码：`kojo.` + kind（闭集拼法由生产方唯一决定）', () => {
    expect(syntaxErrorCode('unclosed-block')).toBe('kojo.unclosed-block');
    for (const kind of KOJO_STRUCTURE_SYNTAX_KINDS) {
      expect(syntaxErrorCode(kind)).toBe(`kojo.${kind}`);
      const decorated: LineDecoration = { line: 1, severity: 'error', message: '', code: syntaxErrorCode(kind) };
      expect(decorated.code).toMatch(/^kojo\./);
    }
  });
});

describe('机器记号名 → 人话名：唯一一张表（以后加族只改这里）', () => {
  it.each([
    ['speech_close', '台词右引号'],
    ['loop_end', '循环结束'],
    ['catch_end', '出错处理结束'],
    ['data_end', '数据表结束'],
  ] as const)('%s → %s', (token, name) => {
    expect(missingStructureName(token)).toBe(name);
  });

  it('表外记号不编词；缺省不猜', () => {
    expect(missingStructureName('some_new_end')).toBeNull();
    expect(missingStructureName(undefined)).toBeNull();
    expect(missingStructureName('')).toBeNull();
  });

  it('块收束词仍只从收束词族取：台词右引号不是「收束词」', () => {
    expect(closeWord('loop_end')).toBe('循环结束');
    expect(closeWord('speech_close')).toBeNull();
  });
});

describe('装饰成形：一处一行、1 基、带码、按行升序', () => {
  it('行/列换算与排序', () => {
    const decorations = syntaxFaultDecorations([
      fault({ row: 10, column: 3, endColumn: 7, kind: 'unterminated-string' }),
      fault({ row: 2, column: 0, endColumn: 4, kind: 'unclosed-block', blockHeadText: '循环：', expectedToken: 'loop_end' }),
    ]);
    expect(decorations.map((d) => d.line)).toEqual([3, 11]);
    expect(decorations[0]?.startColumn).toBe(1);
    expect(decorations[0]?.code).toBe('kojo.unclosed-block');
    expect(decorations[1]?.startColumn).toBe(4);
    expect(decorations[1]?.endColumn).toBe(8);
    expect(decorations.every((d) => d.severity === 'error')).toBe(true);
    expect(decorations.every((d) => d.source === STRUCTURE_SYNTAX_SOURCE)).toBe(true);
  });

  it('同一行两处残缺 ⇒ 折成一条（两条红波浪线读起来还是一条，且多算一次）', () => {
    const decorations = syntaxFaultDecorations([fault({ row: 5 }), fault({ row: 5, kind: 'unterminated-string' })]);
    expect(decorations).toHaveLength(1);
  });

  it('脏输入不画（行号 NaN / 负数都不许变成"第 1 行的错"）', () => {
    expect(syntaxFaultDecorations([fault({ row: Number.NaN }), fault({ row: -3 })])).toEqual([]);
  });

  it('空清单 ⇒ 零装饰（有效文件本来就什么都不画）', () => {
    expect(syntaxFaultDecorations([])).toEqual([]);
  });
});

/* ─────────────────────── ③ 不重复计数（去重判据） ─────────────────────── */

describe('同一区间只许一条红：转译器说过的段我们不再叠', () => {
  const ours: LineDecoration[] = [
    { line: 5, severity: 'error', message: '第 5 行的台词开了「却没有等到」。', code: 'kojo.unterminated-string' },
    { line: 9, severity: 'error', message: '第 9 行的块没有等到「循环结束」。', code: 'kojo.unclosed-block' },
  ];

  it('同一行已有 error ⇒ 我们那条不画', () => {
    const kept = dropLinesAlreadyErrored(ours, [{ line: 5, severity: 'error' }]);
    expect(kept.map((d) => d.line)).toEqual([9]);
  });

  it('warning / info 不顶掉结构残缺（不同严重度说的是不同的事）', () => {
    expect(dropLinesAlreadyErrored(ours, [{ line: 5, severity: 'warning' }, { line: 9, severity: 'info' }]).map((d) => d.line)).toEqual([5, 9]);
  });

  it('没人说话 ⇒ 一条不动；我们没东西 ⇒ 也不动（都不新建引用之外的内容）', () => {
    expect(dropLinesAlreadyErrored(ours, [])).toEqual(ours);
    expect(dropLinesAlreadyErrored([], [{ line: 1, severity: 'error' }])).toEqual([]);
  });

  it('不修改入参（面板与调用方都持有同一份引用）', () => {
    const input: LineDecoration[] = [{ line: 3, severity: 'error', message: 'x' }];
    dropLinesAlreadyErrored(input, [{ line: 3, severity: 'error' }]);
    expect(input).toHaveLength(1);
  });

  it('同一行、同一严重级、区间相交 ⇒ 只留装饰通道那一条（插件是最近邻，结构层退让）', () => {
    const structure: LineDecoration[] = [
      { line: 5, severity: 'error', message: '结构层', code: 'kojo.unterminated-interp', startColumn: 5, endColumn: 18 },
    ];
    const kept = dropLinesAlreadyErrored(structure, [
      { line: 5, severity: 'error', startColumn: 1, endColumn: 7 },
    ]);
    expect(kept).toEqual([]);
  });

  it('同一行但区间不相交 ⇒ 各说各事，不互相顶掉（不同问题不按行连坐）', () => {
    const structure: LineDecoration[] = [
      { line: 5, severity: 'error', message: '结构层', code: 'kojo.unclosed-block', startColumn: 10, endColumn: 20 },
    ];
    const kept = dropLinesAlreadyErrored(structure, [
      { line: 5, severity: 'error', startColumn: 1, endColumn: 6 },
    ]);
    expect(kept.map((d) => d.code)).toEqual(['kojo.unclosed-block']);
  });

  it('区间缺列 ⇒ 按整行算（旧口径不退化：插件只说"这一行有错"时结构层仍退让）', () => {
    const structure: LineDecoration[] = [
      { line: 5, severity: 'error', message: '结构层', code: 'kojo.unclosed-block', startColumn: 10, endColumn: 20 },
    ];
    expect(dropLinesAlreadyErrored(structure, [{ line: 5, severity: 'error' }])).toEqual([]);
  });
});

/* ─────────────── ④ 上屏器：owner / 去重接线 / 撤下（假 Monaco） ─────────────── */

/** 假 model：只给上屏器（与 `decorationsToMarkers`）真读的那几件；其余一概不需要 */
function fakeModel(lines: readonly string[], languageId: string = KOJO_LANGUAGE_ID): Monaco.editor.ITextModel {
  return {
    uri: { toString: () => 'inmemory://model/kojo-fake.kojo' },
    isDisposed: () => false,
    getLanguageId: () => languageId,
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1]?.length ?? 0) + 2,
  } as unknown as Monaco.editor.ITextModel;
}

/** 假 Monaco：只给上屏器用到的那三件 API + `decorationsToMarkers` 要的 MarkerSeverity */
function fakeMonaco(decoratorMarkers: Monaco.editor.IMarker[] = []): {
  monaco: typeof Monaco;
  published: Array<{ owner: string; markers: Monaco.editor.IMarkerData[] }>;
  fireMarkerChange: () => void;
} {
  const published: Array<{ owner: string; markers: Monaco.editor.IMarkerData[] }> = [];
  const listeners = new Set<(resources: readonly unknown[]) => void>();
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      registerDocumentSemanticTokensProvider: () => ({ dispose: () => undefined }),
      registerFoldingRangeProvider: () => ({ dispose: () => undefined }),
      setLanguageConfiguration: () => ({ dispose: () => undefined }),
    },
    editor: {
      getModelMarkers: (filter: { owner?: string }) => (filter.owner === DECORATOR_MARKER_OWNER ? decoratorMarkers : []),
      setModelMarkers: (_model: unknown, owner: string, markers: Monaco.editor.IMarkerData[]) => {
        published.push({ owner, markers });
      },
      onDidChangeMarkers: (listener: (resources: readonly unknown[]) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      getEditors: () => [],
      onDidCreateEditor: () => ({ dispose: () => undefined }),
    },
  };
  return {
    monaco: monaco as unknown as typeof Monaco,
    published,
    fireMarkerChange: () => {
      for (const listener of [...listeners]) listener([{ toString: () => 'inmemory://model/kojo-fake.kojo' }]);
    },
  };
}

/** `console.warn` 的读数收成 string[]（`mock.calls` 在 node 类型面是宽数组，同 `tree-sitter-fallback-wiring` 的做法） */
const warned = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  (spy.mock.calls as unknown[][]).map((call) => String(call[0] ?? '')).filter((line) => line.length > 0);

const markerOf = (published: Array<{ owner: string; markers: Monaco.editor.IMarkerData[] }>, index = 0): Monaco.editor.IMarkerData => {
  const entry = published.find((p) => p.owner === STRUCTURE_SYNTAX_OWNER);
  const markers = entry?.markers ?? [];
  const marker = markers[index];
  if (!marker) throw new Error(`这一份发布里没有第 ${index} 条 marker：${JSON.stringify(markers)}`);
  return marker;
};

describe('上屏器：挂自己的 owner、按转译器那一路去过重、撤下时清零', () => {
  const lines = ['角色: 12', '时机 指令 900：', '    循环：', '        「一句。」', '    「没写完的台词'];
  let presenter: StructureSyntaxPresenter | null = null;

  afterEach(() => {
    presenter?.dispose();
    presenter = null;
    vi.restoreAllMocks();
  });

  it('到货即画：一条 marker 落在残缺那一行，带中文消息与 `kojo.` 码', () => {
    const { monaco, published } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    const model = fakeModel(lines);
    presenter.show(model, [fault({ row: 4, column: 4, endColumn: 12, kind: 'unterminated-string' })], false);
    expect(published).toHaveLength(1);
    expect(published[0]?.owner).toBe(STRUCTURE_SYNTAX_OWNER);
    const marker = markerOf(published);
    expect(marker.startLineNumber).toBe(5);
    expect(marker.severity).toBe(8);
    expect(marker.code).toBe('kojo.unterminated-string');
    expect(marker.message).toContain('第 5 行');
    expect(marker.message).toContain('「');
  });

  it('派生预览 model（inmemory://sugar/…）不画结构残缺——诊断属于源文件，不跟着投影走', () => {
    const { monaco, published } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    const model = {
      ...fakeModel(lines),
      uri: { scheme: 'inmemory', authority: 'sugar', toString: () => 'inmemory://sugar/g/事件.ERB' },
    } as unknown as Monaco.editor.ITextModel;
    presenter.show(model, [fault({ row: 4, kind: 'unterminated-string' })], false);
    expect(published, '预览面被结构诊断画了红线（正常 ERB 会被误报成错）').toHaveLength(0);
  });

  it('同一行已有 error 级装饰 ⇒ 一条都不发（发的是空数组，不是"没发"）', () => {
    const { monaco, published } = fakeMonaco([
      { startLineNumber: 5, severity: 8, message: '', owner: DECORATOR_MARKER_OWNER } as unknown as Monaco.editor.IMarker,
    ]);
    presenter = createStructureSyntaxPresenter(monaco);
    presenter.show(fakeModel(lines), [fault({ row: 4, kind: 'unterminated-string' })], false);
    expect(published).toHaveLength(1);
    expect(published[0]?.owner).toBe(STRUCTURE_SYNTAX_OWNER);
    expect(published[0]?.markers).toEqual([]);
  });

  it('同行区间相交的 error ⇒ 只留装饰通道那一条；区间不相交 ⇒ 结构层照画', () => {
    const decorated: Monaco.editor.IMarker[] = [
      {
        startLineNumber: 5,
        startColumn: 1,
        endColumn: 6,
        severity: 8,
        message: '插件侧',
        owner: DECORATOR_MARKER_OWNER,
      } as unknown as Monaco.editor.IMarker,
    ];
    const { monaco, published } = fakeMonaco(decorated);
    presenter = createStructureSyntaxPresenter(monaco);
    // 结构层这一条落在第 5 行 [11,12)：与插件 [1,6) 不相交 ⇒ 不同问题，两条都该在
    presenter.show(fakeModel(lines), [fault({ row: 4, column: 10, endColumn: 11, kind: 'unclosed-block', blockHeadText: '循环：', expectedToken: 'loop_end' })], false);
    expect(published.at(-1)?.markers).toHaveLength(1);
    expect(published.at(-1)?.markers[0]?.startColumn).toBe(11);
    // 插件改成盖住整行 ⇒ 同一区间同一严重级，只留插件侧
    decorated[0] = {
      startLineNumber: 5,
      startColumn: 1,
      endColumn: 12,
      severity: 8,
      message: '插件侧',
      owner: DECORATOR_MARKER_OWNER,
    } as unknown as Monaco.editor.IMarker;
    presenter.show(fakeModel(lines), [fault({ row: 4, column: 10, endColumn: 11, kind: 'unclosed-block', blockHeadText: '循环：', expectedToken: 'loop_end' })], false);
    expect(published.at(-1)?.markers).toEqual([]);
  });

  it('装饰通道后到货（异步）⇒ 重算并按同判据撤下我们那条', () => {
    const decorator: Monaco.editor.IMarker[] = [];
    const { monaco, published, fireMarkerChange } = fakeMonaco(decorator);
    presenter = createStructureSyntaxPresenter(monaco);
    presenter.show(fakeModel(lines), [fault({ row: 4, kind: 'unterminated-string' })], false);
    expect(published[0]?.markers).toHaveLength(1);
    // 转译器随后在同一行发了 error（装饰通道是异步的，谁先到都可能）
    decorator.push({ startLineNumber: 5, severity: 8, message: '', owner: DECORATOR_MARKER_OWNER } as unknown as Monaco.editor.IMarker);
    fireMarkerChange();
    const last = published[published.length - 1];
    expect(last?.owner).toBe(STRUCTURE_SYNTAX_OWNER);
    expect(last?.markers).toEqual([]);
  });

  it('重算没变 ⇒ 不再发第二次（自激防护：marker 事件不能变成循环）', () => {
    const { monaco, published, fireMarkerChange } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    presenter.show(fakeModel(lines), [fault({ row: 4, kind: 'unterminated-string' })], false);
    const before = published.length;
    fireMarkerChange();
    fireMarkerChange();
    expect(published).toHaveLength(before);
  });

  it('clear = 这一份文档清零；clearAll / dispose = 每份都清零（不留幽灵波浪线）', () => {
    const { monaco, published } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    const model = fakeModel(lines);
    presenter.show(model, [fault({ row: 4, kind: 'unterminated-string' })], false);
    presenter.clear(model);
    expect(published.at(-1)?.markers).toEqual([]);
    presenter.show(model, [fault({ row: 2, kind: 'unclosed-block', blockHeadText: '循环：', expectedToken: 'loop_end' })], false);
    presenter.clearAll();
    expect(published.at(-1)?.markers).toEqual([]);
  });

  it('非 .kojo 的 model：一条都不画（本层只管这份源）', () => {
    const { monaco, published } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    const erb = fakeModel(lines, 'erb');
    presenter.show(erb, [fault()], false);
    expect(published).toHaveLength(0);
  });

  it('列越界被夹住（残缺来自另一条线程，不许假定它算准了列）', () => {
    const { monaco, published } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    presenter.show(fakeModel(lines), [fault({ row: 0, column: 9_999, endColumn: 99_999 })], false);
    const marker = markerOf(published);
    expect(marker.startColumn).toBeLessThanOrEqual(marker.endColumn);
    expect(marker.endColumn).toBeLessThanOrEqual((lines[0]?.length ?? 0) + 2);
  });

  it('脏输入（NaN 行 / 空清单）不抛、也不画（fail-open）', () => {
    const { monaco, published } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    const model = fakeModel(lines);
    expect(() => presenter?.show(model, [fault({ row: Number.NaN }), fault({ row: -1 })], false)).not.toThrow();
    expect(published.at(-1)?.markers).toEqual([]);
    expect(() => presenter?.show(model, [], false)).not.toThrow();
  });

  it('截断只说一次（台账去重；每解一次刷屏 = 与静默同罪）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco } = fakeMonaco();
    presenter = createStructureSyntaxPresenter(monaco);
    const model = fakeModel(lines);
    const many = Array.from({ length: 3 }, (_unused, i) => fault({ row: i, kind: 'unterminated-string' }));
    presenter.show(model, many, true);
    presenter.show(model, many, true);
    const structureWarns = warned(vi.mocked(console.warn)).filter((line) => line.includes('structure'));
    expect(structureWarns).toHaveLength(1);
  });
});

/* ───────────────── ⑤ 闸门：关掉 = 一毫米都不动（含这一层） ───────────────── */

describe('偏好为关 ⇒ 结构诊断这一层不存在', () => {
  afterEach(() => {
    disposeStructureOverlay();
    delete (globalThis as { window?: unknown }).window;
  });

  /** 计数桩：任何一次 Monaco 属性访问/调用都被记下来（关着时这张表必须是空的） */
  function countingMonaco(): { monaco: typeof Monaco; calls: string[] } {
    const calls: string[] = [];
    const make = (path: string): unknown =>
      new Proxy(() => undefined, {
        get: (_target, prop) => (typeof prop !== 'string' ? undefined : make(`${path}.${String(prop)}`)),
        apply: (_target, _thisArg, args) => {
          calls.push(`${path}(${args.length})`);
          return { dispose: () => undefined };
        },
      });
    return { monaco: make('monaco') as unknown as typeof Monaco, calls };
  }

  it('显式关着（存过 off）：装配点零调用 ⇒ 上屏器也没被创建', () => {
    // TS-DEFAULT 起默认开；要判"关 = 一毫米都不动"必须真的存过 off，而不是靠无 window
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: { getItem: () => 'off', setItem: () => undefined, removeItem: () => undefined },
    };
    const { monaco, calls } = countingMonaco();
    installStructureOverlay(monaco, []);
    expect(structureOverlayState()).toEqual({ installed: true, active: false, client: null });
    expect(calls).toEqual([]);
  });

  it('这一面的回落文案是"结构诊断"，且不裸泄机器词（作者面那一句由台账给）', () => {
    resetStructureDegradationLedger();
    const seen: string[] = [];
    const un = onStructureDegradation((degradation) => seen.push(`${degradation.capability}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(reportStructureDegradation({ capability: 'syntax', stage: 'parse', message: '结构残缺扫描失败' })).toBe(true);
    un();
    expect(seen).toEqual(['syntax']);
    expect(warn.mock.calls[0]?.[0]).toContain('syntax/parse');
    warn.mockRestore();
  });
});

/* ─────────── ⑥ 接线：worker 那一面失败 ⇒ 装饰清零 + 说一次 + 不抛 ─────────── */

/**
 * 桩只打在 `client.ts` 那一格（与 `tree-sitter-fallback-wiring.test.ts` 同一边界）：
 * 真跑的是 `providers.ts` 的 activate/deactivate 全序列与上屏器的真实接线；
 * 桩的是 worker 线程本体（node 池起不了 `?worker`）。桩的三条动作按 `client.ts`
 * 的既有形状走：`onSyntax`（到货）/ 台账 + `onSyntaxClear`（这一面停用）/ `onFatal`（整档停用）。
 */
interface StubClientShape {
  push(faults: unknown[], truncated: boolean): void;
  syntaxDead(): void;
  fatal(): void;
}

const stub = vi.hoisted(() => ({
  instance: null as StubClientShape | null,
  model: null as unknown,
}));

vi.mock('../src/monaco/tree-sitter/client', async () => {
  const { reportStructureDegradation } = await import('../src/monaco/tree-sitter/fallback');
  class StubStructureClient {
    private readonly hooks: {
      onSyntax?: (model: never, faults: unknown[], truncated: boolean) => void;
      onSyntaxClear?: (model: never) => void;
      onFatal?: (message: string) => void;
    };
    constructor(options: StubStructureClient['hooks']) {
      this.hooks = options;
      stub.instance = this as unknown as (typeof stub)['instance'];
    }
    get state(): string {
      return 'ready';
    }
    get indent(): null {
      return null;
    }
    async tokens(): Promise<null> {
      return null;
    }
    async foldingRanges(): Promise<null> {
      return null;
    }
    dispose(): void {
      /* 真 client 在这里会 releaseDoc ⇒ onSyntaxClear；本桩由 syntaxDead()/fatal() explicitly 走 */
    }
    push(faults: unknown[], truncated: boolean): void {
      this.hooks.onSyntax?.(stub.model as never, faults, truncated);
    }
    /** 真实 `client.receive()` 对 `capability: 'syntax'` 那条错误的形状：台账说一次 + 撤装饰 */
    syntaxDead(): void {
      reportStructureDegradation({ capability: 'syntax', stage: 'parse', message: '结构残缺扫描失败（桩）' });
      this.hooks.onSyntaxClear?.(stub.model as never);
    }
    fatal(): void {
      this.hooks.onFatal?.('worker 线程报错：Zone OOM（桩）');
    }
  }
  return { StructureClient: StubStructureClient, STRUCTURE_REQUEST_TIMEOUT_MS: 4_000 };
});

// A4：语言运行时由 descriptor 交回；桩掉这一格，pref-on 用例不去装配真 `?worker` / `?url`
// ERB 也登记了 structure：本文件判 Kojo 的残缺上屏，ERB 运行时同样桩掉，避免真 `?worker` 装配拖慢 flush。
vi.mock('../src/monaco/tree-sitter/erb-runtime', () => ({
  ERB_STRUCTURE_RUNTIME: {
    runtimeWasmUrl: 'runtime.wasm（桩）',
    grammarWasmUrl: 'erb.wasm（桩）',
    createWorker: () => {
      throw new Error('桩 client 不建线程（ERB）');
    },
  },
}));

vi.mock('../src/monaco/tree-sitter/kojo-runtime', () => ({
  KOJO_STRUCTURE_RUNTIME: {
    runtimeWasmUrl: 'runtime.wasm（桩）',
    grammarWasmUrl: 'kojo.wasm（桩）',
    createWorker: () => {
      throw new Error('桩 client 不建线程');
    },
    semantic: {
      legend: { tokenTypes: [], tokenModifiers: [] },
      encode: () => ({ data: new Uint32Array(0), droppedRows: 0, droppedEmpty: 0, droppedWide: 0, droppedOverlaps: 0 }),
    },
  },
}));

describe('叠层开着时的接线：到货会上屏，坏了会清零、只说一次、不抛回编辑链', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  function windowWithPref(): void {
    const store = new Map<string, string>([['kojo.ui.treeSitter.v1', 'on']]);
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    stub.instance = null;
    resetStructureDegradationLedger();
    vi.restoreAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    windowWithPref();
  });

  afterEach(() => {
    disposeStructureOverlay();
    stub.instance = null;
    stub.model = null;
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('worker 报错 / 整档停用 ⇒ 已画的波浪线清零，台账只说一次，之后再到货也不抛', async () => {
    const { monaco, published } = fakeMonaco();
    const model = fakeModel(['角色: 12', '    循环：', '        「一句。」']);
    stub.model = model;
    installStructureOverlay(monaco as unknown as typeof Monaco);
    await flush();
    expect(structureOverlayState().active).toBe(true);
    const client = stub.instance;
    if (!client) throw new Error('桩 client 没被装上（providers 的装配边界变了）');

    // ① 到货：画上一条
    client.push([{ row: 1, endRow: 1, column: 4, endColumn: 7, faultRow: 2, kind: 'unclosed-block', blockHeadText: '循环：', expectedToken: 'loop_end' }], false);
    expect(published.at(-1)?.owner).toBe(STRUCTURE_SYNTAX_OWNER);
    expect(published.at(-1)?.markers).toHaveLength(1);

    // ② 这一面停用：清零 + 台账一条
    client.syntaxDead();
    expect(published.at(-1)?.markers).toEqual([]);
    const syntaxWarns = warned(warn).filter((line) => line.includes('syntax/parse'));
    expect(syntaxWarns).toHaveLength(1);

    // ③ 同一句话再说一次也不许重复（去重的是台账，不是我们的自觉）
    client.syntaxDead();
    expect(warned(warn).filter((line) => line.includes('syntax/parse'))).toHaveLength(1);

    // ④ 整档停用：只拆 Kojo 这一门（作者回到该语言的词法层）；ERB 同级叠层不受牵连
    client.fatal();
    await flush();
    expect(structureOverlayLanguageStates()[KOJO_LANGUAGE_ID]).toBeUndefined();
    expect(structureOverlayLanguageStates()[ERB_LANGUAGE_ID]).toBeDefined();
    expect(structureOverlayState().installed).toBe(true);
    expect(published.at(-1)?.markers).toEqual([]);

    // ⑤ 停用之后又有迟到的结果：不许抛回编辑链（上屏器已经不在，回调得静默落地）
    expect(() => client.push([{ row: 1, endRow: 1, column: 0, endColumn: 3, faultRow: 1, kind: 'unexpected-token' }], false)).not.toThrow();
  });
});

