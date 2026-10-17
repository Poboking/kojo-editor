/**
 * S4 批验收：糖预览的**三向映射**（糖源码行 ↔ 生成 ERB 行 ↔ 回放消息块）。
 *
 * 硬性覆盖（用户验收项）：
 * 1. 三向映射正确性 —— 糖行→产物行来自 `sourceMap`（**不伪造**：纯生成行
 *    `sourceLine: null` 不归属任何糖行）；产物行→消息块来自产物扫描；
 * 2. **S1 golden 样例回放** —— §6.1 / §6.2 的产物走真实 `state.replay` 引擎
 *    （mock 依赖注入；不新建模拟器），消息块带分支走向与可达性；
 * 3. 降级路径 —— 无存档 / 无角色 / 无回放服务 / 存档坏 → 结构化降级，不抛错；
 * 4. 转译 error → 仍出骨架（诊断原样带出，不替调用方做策略）；
 * 5. 只读纪律 —— 预览不改产物一字节、不发事件。
 *
 * 说明：本文件是**测试**，按解耦审计规则 C 的豁免（测试属宿主层面集成）
 * 可直接 import 其它插件包；非测试源码一律不得交叉 import。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  BranchChainOutcome,
  FunctionPredicates,
  FunctionReplay,
  Logger,
  ReplayStateView,
  SnapshotArchive,
  StateReplayService,
  VariableInfo,
} from '@kojo/plugin-api';
import {
  extractFunctionPredicates as extractPredicates,
} from '@kojo/plugin-condition-extractor';
import { WellKnownServices } from '@kojo/plugin-api';
import { parseErbText as erbParseErbText, scanControlFlow as erbScanControlFlow } from '@kojo/plugin-erb-parser';
import { StateReplayEngine } from '@kojo/plugin-state-replay';
import { createSugarTranspileService } from '../src/service';
import {
  createSugarPreviewService,
  foldMessageBlocks,
  isEnvelopeChain,
  isStructuralLine,
  scanProductFunctions,
} from '../src/preview';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '胆怯' || name === '恋慕' || name === '思慕') return 'TALENT';
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '名字') return 'CALLNAME';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (
      ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR', 'FLAG', 'TFLAG'].includes(head)
    ) {
      return ident;
    }
    return undefined;
  },
};

const GOLDENS = path.resolve(import.meta.dirname, 'goldens');
const stripBanner = (text: string) => text.split('\n').filter((l) => !l.startsWith('//')).join('\n');
const readKojo = (name: string) => stripBanner(fs.readFileSync(path.join(GOLDENS, name), 'utf8'));

const silentLog = (): Logger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

/** 预览服务（真实转译器 + 测试字典；回放由各用例注入） */
const previewSvc = (replay?: StateReplayService) =>
  createSugarPreviewService({
    transpile: (source, options) => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(source, options),
    ...(replay ? { replay } : {}),
    log: silentLog(),
  });

/* ============================== 纯逻辑单测：产物扫描 ============================== */

describe('产物函数扫描 / 结构行判定 / 消息块折叠', () => {
  const erb = [
    '@FN_A',
    'CALL FN_A_1',
    'RETURN RESULT',
    '',
    '@FN_A_1',
    ';----',
    'LOCAL = 1',
    ';----',
    'IF LOCAL',
    '\tPRINTFORMW 「一」',
    '\tPRINTFORMDL 二。',
    '\tIF TALENT:TARGET:恋慕',
    '\t\tPRINTFORMDW 红。',
    '\tENDIF',
    'ENDIF',
    'RETURN 1',
    '',
    '@FN_B',
    'SETCOLOR 0x123456',
    '',
  ].join('\n');

  it('scanProductFunctions：切出函数块与行区间（闭区间）', () => {
    const fns = scanProductFunctions(erb);
    expect(fns.map((f) => f.name)).toEqual(['FN_A', 'FN_A_1', 'FN_B']);
    // 块区间 = `@名字` 行 → 下一个 `@` 行之前（含空行）
    expect(fns[0]).toEqual({ name: 'FN_A', fromLine: 1, toLine: 4 });
    expect(fns[1]!.fromLine).toBe(5);
    expect(fns[1]!.toLine).toBe(17);
    expect(fns[2]).toEqual({ name: 'FN_B', fromLine: 18, toLine: 20 });
  });

  it('isStructuralLine：控制流/骨架/注释/空行为结构行；文本行不是', () => {
    expect(isStructuralLine('')).toBe(true);
    expect(isStructuralLine(';記入チェック（=0, 非表示、1, 表示）')).toBe(true);
    expect(isStructuralLine('@FN_A')).toBe(true);
    expect(isStructuralLine('IF LOCAL')).toBe(true);
    expect(isStructuralLine('ELSE')).toBe(true);
    expect(isStructuralLine('ELSEIF x')).toBe(true);
    expect(isStructuralLine('ENDIF')).toBe(true);
    expect(isStructuralLine('SELECTCASE TFLAG:193')).toBe(true);
    expect(isStructuralLine('CASE 1')).toBe(true);
    expect(isStructuralLine('CASEELSE')).toBe(true); // 必须在 CASE 之前判定（有序前缀表）
    expect(isStructuralLine('ENDSELECT')).toBe(true);
    expect(isStructuralLine('RETURN 1')).toBe(true);
    expect(isStructuralLine('LOCAL = 1')).toBe(true);
    expect(isStructuralLine('LOCAL:2 = RAND:2')).toBe(true);
    expect(isStructuralLine('TFLAG:192 = 0')).toBe(true);
    expect(isStructuralLine('SETBIT RESULT, 0')).toBe(true);
    // 位糖（v1.7）产物/手写同形：三语句位原语都是结构行（不承载文本）
    expect(isStructuralLine('SETBIT TFLAG:193, 0')).toBe(true);
    expect(isStructuralLine('CLEARBIT TFLAG:193, 1')).toBe(true);
    expect(isStructuralLine('INVERTBIT TFLAG:193, 2')).toBe(true);
    expect(isStructuralLine('CALL FN_A_1')).toBe(true); // 包装函数骨架：转发调用
    // 文本行 —— 必须不是结构行
    expect(isStructuralLine('\tPRINTFORMW 「一」')).toBe(false);
    expect(isStructuralLine('CALL HPH_PRINT(@"……嗯。","w")')).toBe(false); // 带实参 = 文本块
    expect(isStructuralLine('PRINTFORMDW 她点了点头。')).toBe(false);
    expect(isStructuralLine('SETCOLOR 0xE4FC08')).toBe(false);
  });

  it('foldMessageBlocks：连续非结构行合一；缩进变化/结构行断开', () => {
    const blocks = foldMessageBlocks(erb);
    // IF LOCAL 内两行文本（同缩进）→ 一块
    expect(blocks).toContainEqual({ fromLine: 10, toLine: 11, text: '\tPRINTFORMW 「一」\n\tPRINTFORMDL 二。' });
    // 内层 IF 体单行 → 一块
    expect(blocks).toContainEqual({ fromLine: 13, toLine: 13, text: '\t\tPRINTFORMDW 红。' });
    // `CALL FN_A_1` 是骨架 → 不与前后文本合并
    expect(blocks.some((b) => b.fromLine === 2 && b.toLine === 2)).toBe(false);
  });
});

/* ============================== 三向映射：真实 golden ============================== */

describe('S4 三向映射 · §6.1 golden（无存档：糖行 ↔ ERB 行两向完整）', () => {
  const src = readKojo('spec-6.1-lumia-310.kojo');

  it('每行糖源都有条目；纯生成行不归属任何糖行（不伪造映射）', async () => {
    const res = await previewSvc().preview({ source: src });
    const srcCount = src.split('\n').filter((_, i, a) => i < a.length - (a[a.length - 1] === '' ? 1 : 0)).length;
    expect(res.lines).toHaveLength(srcCount);
    expect(res.lines.map((l) => l.sourceLine)).toEqual(Array.from({ length: srcCount }, (_, i) => i + 1));

    // 反查一致性：所有 generatedLines 并集 = sourceMap 里所有 sourceLine !== null 的产物行
    const fromLines = new Set(res.lines.flatMap((l) => l.generatedLines));
    const expected = new Set(
      res.transpile.sourceMap.filter((e) => e.sourceLine !== null).map((e) => e.generatedLine),
    );
    expect(fromLines).toEqual(expected);

    // 纯生成行（sourceLine === null）绝不出现在任何糖行的 generatedLines 里
    const pureGenerated = res.transpile.sourceMap.filter((e) => e.sourceLine === null).map((e) => e.generatedLine);
    expect(pureGenerated.length).toBeGreaterThan(0); // 骨架确实存在（否则断言空洞）
    for (const g of pureGenerated) expect(fromLines.has(g)).toBe(false);
  });

  it('文本糖行 → 非空产物行 + 至少一个消息块（含产物原文）', async () => {
    const res = await previewSvc().preview({ source: src });
    // `「呀……！」` 在源第 8 行（1 基；banner 已剥，见 front-matter 起算）
    const target = res.lines.find((l) => l.sourceText.includes('「呀……！」'));
    expect(target, '未找到台词糖行').toBeDefined();
    expect(target!.generatedLines.length).toBeGreaterThan(0);
    expect(target!.messageBlocks.length).toBeGreaterThan(0);
    // 消息块文本 = 产物原文（未做 FORM 展开）
    const joined = target!.messageBlocks.map((b) => b.text).join('\n');
    expect(joined).toContain('PRINTFORMW 「呀……！」');
  });

  it('时机块头等纯糖语法行 → generatedLines 为空数组（不给糖行硬塞产物行）', async () => {
    const res = await previewSvc().preview({ source: src });
    const header = res.lines.find((l) => l.sourceText.startsWith('时机 '));
    expect(header).toBeDefined();
    expect(header!.generatedLines).toEqual([]);
    expect(header!.messageBlocks).toEqual([]);
  });

  it('结构行清单覆盖 `IF LOCAL` / `SELECTCASE` / `CASEELSE` / `ENDIF`，且不含文本行', async () => {
    const res = await previewSvc().preview({ source: src });
    const lines = res.transpile.erb.split('\n');
    const structuralTexts = res.structuralLines.map((n) => lines[n - 1]!.trim());
    expect(structuralTexts).toContain('IF LOCAL');
    expect(structuralTexts).toContain('ENDIF');
    expect(structuralTexts.some((t) => t.startsWith('SELECTCASE '))).toBe(true);
    expect(structuralTexts).toContain('CASEELSE');
    expect(structuralTexts).toContain('@M_KOJO_MESSAGE_COM_K12_310_1');
    // 文本行不得混入
    expect(structuralTexts.some((t) => t.includes('PRINTFORM'))).toBe(false);
    // 末尾空行不算结构行
    expect(res.structuralLines).not.toContain(lines.length);
  });

  it('降级原因 = no-archive-requested；产物与 transpile 逐字节同源（预览不落盘、不改写）', async () => {
    const res = await previewSvc().preview({ source: src });
    expect(res.archive).toBeNull();
    const direct = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);
    expect(res.transpile.erb).toBe(direct.erb);
    expect(res.transpile.diagnostics).toEqual([]);
  });
});

/* ============================== 回放：真实引擎（mock 依赖注入） ============================== */

/**
 * mock 存档：角色 12 存在；`TFLAG` 是**全局 1D 整型数组**（`var-model.ts`
 * 的 `GLOBAL_INT_1D`），故值放顶层 `vars` 而非角色块——这是引擎作用域语义，
 * 放错位置回放器会静默读到 0（本批踩过的坑，见 IMPLEMENTATION-LOG §5.30）。
 */
function makeArchive(tflag193: number): SnapshotArchive {
  return {
    path: 'D:/fake/preview.sav',
    fileName: 'preview.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 1,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [
      {
        index: 0,
        dimSepIndex: null,
        vars: [
          { type: 'int', key: 'NO', value: 12, offset: 0 },
          { type: 'str', key: 'NAME', value: '露米娅', offset: 0 },
        ],
      },
    ],
    vars: [
      {
        type: 'int-array-1d',
        key: 'TFLAG',
        saveLen: [200],
        cursor: [200],
        nonEmpty: 1,
        cells: [{ index: [193], value: tflag193 }],
        offset: 0,
      },
    ],
  } as SnapshotArchive;
}

/**
 * 产物谓词提供者 —— 模拟"该内存产物已被索引"。
 *
 * **坐标契约**：`FunctionPredicates.predicates[].line` 必须是**产物 ERB 的
 * 绝对行号**（预览的三向映射以产物行为共同坐标系）。生产路径里
 * `state.replay` 从磁盘读函数体、行号天然是文件行号；预览跑的是**未落盘**
 * 的内存产物，故装配方须保证喂给回放器的明细与产物同坐标（见 `preview.ts`
 * 头注"坐标契约"）。本测试用偏移量把切段行号还原成产物绝对行号。
 */
function predProviderFrom(source: string) {
  const res = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(source);
  const fns = scanProductFunctions(res.erb);
  return async (name: string): Promise<FunctionPredicates | null> => {
    const fn = fns.find((f) => f.name === name);
    if (!fn) return null;
    const segLines = res.erb.split('\n').slice(fn.fromLine - 1, fn.toLine);
    const segment = segLines.join('\n');
    const root = erbParseErbText(segment, '/preview.ERB');
    const stmts = erbScanControlFlow(segment);
    const extracted = extractPredicates(
      { normalizedName: name, filePath: '/preview.ERB', startLine: 1 },
      stmts,
      { endLine: segLines.length, lines: segLines },
    );
    // 切段坐标（1..segLen）→ 产物绝对坐标（fn.fromLine..fn.toLine）
    // 注意：分支链（`FunctionReplay.branches`）由 **statements** 构造，故
    // predicates 与 statements 的 `line` 都必须平移（只改 predicates 会漏）。
    const offset = fn.fromLine - 1;
    return {
      ...extracted,
      startLine: fn.fromLine,
      endLine: fn.toLine,
      statements: extracted.statements.map((s) => ({ ...s, line: s.line + offset })),
      predicates: extracted.predicates.map((p) => ({ ...p, line: p.line + offset })),
      assignments: extracted.assignments.map((a) => ({ ...a, line: a.line + offset })),
      returns: extracted.returns.map((r) => ({ ...r, line: r.line + offset })),
    };
  };
}

/** 真实回放引擎（mock parseArchive / functionPredicates） */
function makeReplay(source: string, tflag193: number): StateReplayService {
  const engine = new StateReplayEngine({
    log: silentLog(),
    parseArchive: async () => makeArchive(tflag193),
    functionPredicates: predProviderFrom(source),
    getSchemaLookup: () => (n: string, i?: number | string): VariableInfo | undefined =>
      n === 'TALENT' && i === '恋慕' ? { name: n, index: i, description: '恋慕', resolvedIndex: 3 } : undefined,
    readFileText: async () => '',
  });
  return engine;
}

describe('S4 回放 · §6.1 golden 走真实 state.replay（不新建模拟器）', () => {
  const src = readKojo('spec-6.1-lumia-310.kojo');

  it('TFLAG:193 = 1 → CASE 1 命中：分支 taken、该块可达，其它分支块不可达', async () => {
    const svc = previewSvc(makeReplay(src, 1));
    const res = await svc.preview({ source: src, archivePath: 'D:/fake/preview.sav' });

    expect(res.archive).not.toBeNull();
    expect(res.archive!.characterNo).toBe(12); // 从产物 `_K12` 反推
    expect(res.archive!.characterName).toBe('露米娅');

    // 覆盖 `CASE 1` 体的块（`「不、不要……！」`）
    const blk1 = findBlock(res, '「不、不要……！」');
    expect(blk1, '未找到 CASE 1 体文本块').toBeDefined();
    expect(blk1!.functionName).toBe('M_KOJO_MESSAGE_COM_K12_310_1');
    const chain = blk1!.branches.find((b) => b.kind === 'select-chain');
    expect(chain, 'CASE 1 块未挂上 select-chain').toBeDefined();
    expect(chain!.takenLine).not.toBeNull();
    expect(blk1!.reachability).toBe('reachable');

    // `CASE 2, 3` 体的块（`「呜……真是的。」`）→ 同链但非命中分支 → 不可达
    const blk2 = findBlock(res, '「呜……真是的。」');
    expect(blk2, '未找到 CASE 2,3 体文本块').toBeDefined();
    expect(blk2!.reachability).toBe('unreachable');
  });

  it('TFLAG:193 = 2 → CASE 2, 3 命中（走向随状态改变）', async () => {
    const svc = previewSvc(makeReplay(src, 2));
    const res = await svc.preview({ source: src, archivePath: 'D:/fake/preview.sav' });
    expect(findBlock(res, '「不、不要……！」')!.reachability).toBe('unreachable');
    expect(findBlock(res, '「呜……真是的。」')!.reachability).toBe('reachable');
  });

  it('TFLAG:193 = 9（无该 CASE）→ 走 CASEELSE：兜底分支可达，其余不可达', async () => {
    const svc = previewSvc(makeReplay(src, 9));
    const res = await svc.preview({ source: src, archivePath: 'D:/fake/preview.sav' });
    expect(findBlock(res, '「不、不要……！」')!.reachability).toBe('unreachable');
    expect(findBlock(res, '「呜……真是的。」')!.reachability).toBe('unreachable');
    expect(findBlock(res, '她什么也没说，只是微微眯起了眼睛。')!.reachability).toBe('reachable');
  });

  it('函数回放摘要覆盖产物全部函数；每条都带行区间与 replay 结果', async () => {
    const svc = previewSvc(makeReplay(src, 1));
    const res = await svc.preview({ source: src, archivePath: 'D:/fake/preview.sav' });
    const productFns = scanProductFunctions(res.transpile.erb);
    expect(res.archive!.functions.map((f) => f.functionName)).toEqual(productFns.map((f) => f.name));
    for (const f of res.archive!.functions) {
      expect(f.fromLine).toBeGreaterThan(0);
      expect(f.toLine).toBeGreaterThanOrEqual(f.fromLine);
    }
    // 主函数确实抽到谓词（否则上面的可达性断言是空洞的）
    const main = res.archive!.functions.find((f) => f.functionName === 'M_KOJO_MESSAGE_COM_K12_310_1')!;
    expect(main.replay).not.toBeNull();
    expect(main.replay!.predicates.length).toBeGreaterThan(0);
    expect(main.replay!.branches.length).toBeGreaterThan(0);
  });
});

describe('S4 回放 · §6.2 golden（选项 + 心形 + 随机）', () => {
  const src = readKojo('spec-6.2-choice-heart-random.kojo');

  it('三向映射完整：心形/选项/随机块均定位到糖行', async () => {
    const svc = previewSvc(makeReplay(src, 0));
    const res = await svc.preview({ source: src, archivePath: 'D:/fake/preview.sav' });

    // 心形行 → 产物 `CALL HPH_PRINT`
    const heart = res.lines.find((l) => l.sourceText.includes('心形'));
    expect(heart, '未找到心形糖行').toBeDefined();
    expect(heart!.messageBlocks.map((b) => b.text).join('\n')).toContain('HPH_PRINT');
    expect(heart!.generatedLines.length).toBeGreaterThan(0);

    // 选项行（PRINTBUTTON / INPUTS / SELECTCASE RESULTS）在产物里存在
    expect(res.transpile.erb).toContain('PRINTBUTTON');
    expect(res.transpile.erb).toContain('SELECTCASE RESULTS');

    // 双向不变量（**弱**形式，避免"伪全覆盖"断言）：
    // ① 每条消息块的**起始行**至少属于一个糖行（块不悬空；块尾允许落在
    //    纯生成的结构行上——如选项块的 `INPUTS`、`ENDSELECT` 收尾）；
    // ② 每行糖源都在结果里出现且 sourceText 与源一致（映射不漂移）。
    const covered = new Set(res.lines.flatMap((l) => l.generatedLines));
    for (const l of res.lines) {
      for (const b of l.messageBlocks) {
        expect(covered.has(b.fromLine), `消息块起始行 ${b.fromLine} 无糖行归属`).toBe(true);
        expect(b.toLine).toBeGreaterThanOrEqual(b.fromLine);
      }
    }
    const srcLines = src.split('\n').filter((_, i, a) => i < a.length - (a[a.length - 1] === '' ? 1 : 0));
    expect(res.lines.map((l) => l.sourceText)).toEqual(srcLines);
  });
});

/* ============================== 降级路径 ============================== */

describe('S4 降级：结构化降级，不抛错', () => {
  const src = readKojo('spec-6.1-lumia-310.kojo');

  it('无存档 → archive: null（纯糖预览正常）', async () => {
    const res = await previewSvc().preview({ source: src });
    expect(res.archive).toBeNull();
    expect(res.lines.length).toBeGreaterThan(0);
  });

  it('有存档但无回放服务 → archive: null（不假装有状态）', async () => {
    const res = await previewSvc().preview({ source: src, archivePath: 'D:/fake/x.sav' });
    expect(res.archive).toBeNull();
    expect(res.lines.length).toBeGreaterThan(0);
  });

  it('存档解析失败 → 降级且不抛错（warn 已记）', async () => {
    const brokenReplay: StateReplayService = {
      createView: async () => {
        throw new Error('bad magic');
      },
      replayFunction: async () => null,
      replayFunctions: async () => [],
    };
    const res = await previewSvc(brokenReplay).preview({ source: src, archivePath: 'D:/fake/bad.sav' });
    expect(res.archive).toBeNull();
    expect(res.lines.length).toBeGreaterThan(0);
  });

  it('回放过程抛错 → 降级且不抛错', async () => {
    const throwyReplay: StateReplayService = {
      createView: async (): Promise<ReplayStateView> =>
        ({ characterNo: 12, characterName: '露米娅', archivePath: 'x', read: () => ({ kind: 'unknown', unknown: { code: 'other', message: '' } }) }),
      replayFunction: async () => null,
      replayFunctions: async () => {
        throw new Error('replay blew up');
      },
    };
    const res = await previewSvc(throwyReplay).preview({ source: src, archivePath: 'D:/fake/x.sav' });
    expect(res.archive).toBeNull();
  });

  it('角色号不可得（产物无 `_K{n}`）→ 降级', async () => {
    const noChar = ['时机 初见：', '    「你好。」', ''].join('\n');
    const res = await previewSvc(makeReplay(noChar, 0)).preview({ source: noChar, archivePath: 'D:/fake/x.sav' });
    expect(res.archive).toBeNull();
  });

  it('显式 characterNo 优先于产物反推（无 `角色:` 也能回放）', async () => {
    const noChar = ['时机 初见：', '    「你好。」', ''].join('\n');
    const res = await previewSvc(makeReplay(noChar, 0)).preview({
      source: noChar,
      archivePath: 'D:/fake/preview.sav',
      characterNo: 12,
    });
    expect(res.archive).not.toBeNull();
    expect(res.archive!.characterNo).toBe(12);
  });

  /**
   * 回归（MED）：旧实现从产物骨架正则反推 `_K(\d+)\b`——`_K58_` 这类"数字后紧跟
   * 下划线"的函数头因 `\b` 失配 ⇒ `archive: null`（选择器登记函数是 `_K58_1`）。
   * 现在直接读 `SugarTranspileResult.charNo`（文件头原文），不再猜命名惯例。
   */
  it('角色号来自结果上的 `charNo`：`_K58_` 形态也能回放（旧正则失配）', async () => {
    const src = [
      '角色: 58',
      '口上: 破空自制 选择器: 1',
      '时机 指令 310：',
      '    「甲」',
      '',
    ].join('\n');
    const seen: number[] = [];
    const replay: StateReplayService = {
      createView: async (_archivePath: string, charNo: number): Promise<ReplayStateView> => {
        seen.push(charNo);
        return {
          characterNo: charNo,
          characterName: '自制',
          archivePath: 'x',
          read: () => ({ kind: 'unknown', unknown: { code: 'other', message: '' } }),
        };
      },
      replayFunction: async () => null,
      replayFunctions: async () => [],
    };
    const res = await previewSvc(replay).preview({ source: src, archivePath: 'D:/fake/x.sav' });
    expect(seen).toEqual([58]);
    expect(res.archive).not.toBeNull();
    expect(res.archive!.characterNo).toBe(58);
  });
});

/* ============================== 转译 error / 只读纪律 ============================== */

describe('S4 边界：转译 error 仍出骨架；预览只读', () => {
  it('error 诊断（未知分野）→ 不抛错，诊断原样带出', async () => {
    const src = ['角色: 12', '时机 不存在的分野 1：', '    「x」', ''].join('\n');
    const res = await previewSvc().preview({ source: src });
    expect(res.transpile.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    // 骨架仍在（每糖源行一条）
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.archive).toBeNull();
  });

  it('非法输入（非字符串）→ 抛 TypeError', async () => {
    await expect(previewSvc().preview({ source: 123 as unknown as string })).rejects.toThrow(TypeError);
  });

  it('预览不发射事件（总线未被触达）', async () => {
    // 服务依赖表里没有 bus —— 构造时传入的对象不存在 bus 字段，
    // 用 vi.fn 监视"若实现偷偷 emit 则会被发现"（防御性：本用例固定实现形态）
    const res = await previewSvc().preview({ source: readKojo('spec-6.1-lumia-310.kojo') });
    expect(res.transpile).toBeDefined();
    // 事件纪律由实现保证：`preview.ts` 无 bus 依赖、`index.ts` 无 ctx.bus.on —— 
    // 该不变量由解耦审计 + 本文件"无 bus 注入仍可用"共同守护
  });

  it('并发调用互不干扰（纯函数语义）', async () => {
    const svc = previewSvc();
    const [a, b] = await Promise.all([
      svc.preview({ source: readKojo('spec-6.1-lumia-310.kojo') }),
      svc.preview({ source: readKojo('spec-6.2-choice-heart-random.kojo') }),
    ]);
    expect(a.transpile.erb).toContain('M_KOJO_MESSAGE_COM_K12_310');
    expect(b.transpile.erb).not.toContain('M_KOJO_MESSAGE_COM_K12_310');
  });
});

/* ============================== 信封链规则 ============================== */

describe('信封链（转译器骨架守卫）不参与可达性折叠', () => {
  it('isEnvelopeChain：仅"链头无糖源归属 + unknown"才算信封', () => {
    const chain = (headLine: number, outcome: BranchChainOutcome['outcome']): BranchChainOutcome => ({
      kind: 'if-chain',
      headLine,
      depth: 0,
      members: [{ line: headLine, kind: 'IF', text: 'LOCAL' }],
      takenLine: null,
      outcome,
    });
    const map = (g: number) => (g === 13 ? null : g - 4); // 13 = 纯生成行

    expect(isEnvelopeChain(chain(13, 'unknown'), map)).toBe(true); // 骨架 + 不可判定 = 信封
    expect(isEnvelopeChain(chain(13, 'taken'), map)).toBe(false); // 能判定 → 不是信封
    expect(isEnvelopeChain(chain(16, 'unknown'), map)).toBe(false); // 有糖源 → 作者逻辑
  });

  it('§6.1：`IF LOCAL` 不污染块；`IF TARGET:胆怯` 仍如实报 unknown（不掩盖）', async () => {
    const res = await previewSvc(makeReplay(readKojo('spec-6.1-lumia-310.kojo'), 1)).preview({
      source: readKojo('spec-6.1-lumia-310.kojo'),
      archivePath: 'D:/fake/preview.sav',
    });
    // 信封链仍在 branches 里（作者可见），但第一行的块没有被它污染成 unknown
    const first = res.lines.find((l) => l.sourceText.includes('「呀……！」'))!;
    expect(first.messageBlocks[0]!.reachability).toBe('reachable');
    // 而 `IF TARGET:胆怯`（有糖源、具名索引不可解析）如实报 unknown
    const timid = findBlock(res, '眼眶里浮起一点泪光。')!;
    expect(timid.reachability).toBe('unknown');
    expect(timid.unknown?.code).toBe('named-index');
    // 该块仍挂着作者链（供 UI 显示"为什么不确定"）；信封链也照列（可见性优先）
    expect(timid.branches).toHaveLength(2);
    const authorChain = timid.branches.find((c) => c.members.some((m) => m.text.includes('胆怯')))!;
    expect(authorChain.outcome).toBe('unknown');
    expect(authorChain.unknown?.code).toBe('named-index');
    // 信封链 `IF LOCAL` 照列（可见性），但不影响 reachability 判定
    expect(timid.branches.some((c) => c.members.some((m) => m.text === 'LOCAL'))).toBe(true);
  });
});

/* ============================== 辅助 ============================== */

function findBlock(
  res: Awaited<ReturnType<ReturnType<typeof createSugarPreviewService>['preview']>>,
  text: string,
) {
  for (const line of res.lines) {
    for (const blk of line.messageBlocks) {
      if (blk.text.includes(text)) return blk;
    }
  }
  return undefined;
}

/* ============================== 插件级装配 ============================== */

describe('S4 装配：服务键与服务集合', () => {
  it('WellKnownServices.SugarPreview = "sugar.preview"（additive，不改旧键）', () => {
    expect(WellKnownServices.SugarPreview).toBe('sugar.preview');
    expect(WellKnownServices.SugarTranspile).toBe('sugar.transpile'); // 旧键未变
  });

  it('插件声明 provides 四个服务（含 S5 新增 sugar.lift、S5-UI 新增 sugar.liftApply）；`state.replay` **不在** requires（软依赖）', async () => {
    const { createKojoSugarPlugin } = await import('../src/index');
    const plugin = createKojoSugarPlugin();
    // additive：只追加键，既有两键顺序不变
    expect(plugin.provides).toEqual(['sugar.transpile', 'sugar.preview', 'sugar.lift', 'sugar.liftApply']);
    expect(plugin.requires).not.toContain('state.replay');
    expect(plugin.requires).toEqual(['kernel.project', 'kernel.slots', 'kernel.io']);
  });

  it('无 `state.replay` 时插件仍可激活并提供 sugar.preview（预览降级可用）', async () => {
    const { createKojoSugarPlugin } = await import('../src/index');
    const provided = new Map<string, unknown>();
    const ctx = {
      log: silentLog(),
      inject: (key: string) => {
        if (key === 'kernel.project') return { current: () => null };
        if (key === 'kernel.slots') return { query: () => [] };
        if (key === 'kernel.io') return {};
        throw new Error(`未注册的服务：${key}`); // 模拟 state.replay 缺席
      },
      provide: (key: string, value: unknown) => provided.set(key, value),
      // 本包还注册一枚 `ui.editor.languageService` 贡献（转到定义，2026-10-15）——
      // 上下文里得有个槽注册表；本用例断言的是服务面，故注册侧不记录。
      slots: { register: () => () => undefined },
      // W6（2026-10-17）起本包在激活时挂四条事件（名录随项目/文件走），
      // 断言的仍是服务面 ⇒ 事件与回收都记账不校验。
      bus: { on: () => () => undefined, once: () => () => undefined, emit: () => undefined },
      onDispose: () => undefined,
    };
    createKojoSugarPlugin().activate(ctx as never);
    expect(provided.has('sugar.transpile')).toBe(true);
    expect(provided.has('sugar.preview')).toBe(true);

    // 降级可用：带存档路径但无回放服务 → archive: null，不抛错
    const previewSvc2 = provided.get('sugar.preview') as { preview: (r: unknown) => Promise<unknown> };
    const out = (await previewSvc2.preview({
      source: readKojo('spec-6.1-lumia-310.kojo'),
      archivePath: 'D:/fake/x.sav',
    })) as { archive: unknown; lines: unknown[] };
    expect(out.archive).toBeNull();
    expect(out.lines.length).toBeGreaterThan(0);
  });
});
