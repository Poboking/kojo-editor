/**
 * 转到定义 · `.kojo` 侧（`resolveKojoDefinition`）单测。
 *
 * 语义（见 `src/definition.ts` 头注）：`.kojo` 里的函数名指向**编译产物 ERB 里的函数**，
 * 反查两条腿——① 名字由本文件产出（转译 → 找 `@NAME` → `sourceOf` 把产物行折回源行）；
 * ② 名字来自别处（复用项目 ERB 索引 `byName`）。本文件两条腿都钉：前者用**桩转译结果**
 * 精确驱动（含"生成头无源行 → 向下取最近有源行"与"不得越过下一个函数"两种边界），
 * 后者用真转译产物验证"真实 codegen 造出的头，`findGeneratedHeaderLine` 找得到"。
 */

import { describe, expect, it } from 'vitest';
import type { ErbIndex, SugarTranspileResult } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { findGeneratedHeaderLine, resolveKojoDefinition, type KojoDefinitionDeps } from '../src/definition';
import { stubDict, stubFaceTable } from './support';

const KOJO = 'C:\\ws\\K101.kojo';
const LIB = 'C:\\game\\lib.ERB';

/** 桩索引：只填 `byName`（本模块只消费它；`files` 给空表即可） */
function indexOf(entries: Record<string, { filePath: string; startLine: number }[]>): ErbIndex {
  const byName = new Map(
    Object.entries(entries).map(([name, refs]) => [
      name.toUpperCase(),
      refs.map((r) => ({ name, normalizedName: name.toUpperCase(), ...r, endLine: r.startLine })),
    ]),
  );
  return { files: new Map(), byName };
}

/** 桩转译结果：`erb` 行 + `[产物行, 源行|null]` 源映射（与真实 `sourceOf` 同口径） */
function stubResult(lines: string[], map: [number, number | null][]): SugarTranspileResult {
  return {
    erb: lines.join('\n') + '\n',
    sourceMap: map.map(([generatedLine, sourceLine]) => ({ generatedLine, sourceLine })),
    diagnostics: [],
  };
}

function depsOf(result: SugarTranspileResult, index: ErbIndex | null): KojoDefinitionDeps {
  return {
    transpile: () => result,
    sourceOf: (r, generatedLine) => {
      const e = r.sourceMap.find((x) => x.generatedLine === generatedLine);
      return e && e.sourceLine !== null ? { line: e.sourceLine, column: 1 } : null;
    },
    index: () => index,
  };
}

/** `|` 标光标（行列都由标记位置推出；`|` 在原文里的 0 基下标 + 1 即列） */
function requestAt(text: string, marked: string, path = KOJO) {
  const idx = marked.indexOf('|');
  const before = marked.slice(0, idx);
  return {
    path,
    text,
    line: before.split('\n').length,
    column: idx - before.lastIndexOf('\n'),
  };
}

const CALLER = `; 调用别处的库函数\nCALL LIB_FUNC(1)\n`;

/** 在 CALLER 原文里用 `|` 标光标（第二行带标记，故行号必须由原文推出） */
const markedCaller = (mark: string): string => `; 调用别处的库函数\n${mark}\n`;

describe('resolveKojoDefinition · 本文件产出的函数（折回 .kojo 行）', () => {
  it('产物头是纯生成行（sourceOf = null）→ 向下取最近有源行，落在本文件对应行', () => {
    const result = stubResult(
      ['@M_KOJO_K101_X', '\tPRINTFORMW "hi"', '\tRETURN 1'],
      [
        [1, null], // @ 头：生成行
        [2, 7], // 正文首行 ← 源第 7 行
        [3, null],
      ],
    );
    const text = `CALL M_KOJO_K101_X(1)\n`;
    const locs = resolveKojoDefinition(requestAt(text, 'CALL M_KOJO_K101|_X(1)'), depsOf(result, null));
    expect(locs).toEqual([{ filePath: KOJO, line: 7 }]);
  });

  it('产物头本身有源行（原生直通块）→ 精确映射，不向下取', () => {
    const result = stubResult(['@NATIVE_FN', '\tRETURN 1'], [[1, 3], [2, 4]]);
    const text = 'CALL NATIVE_FN\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL NATIVE|_FN'), depsOf(result, null));
    expect(locs).toEqual([{ filePath: KOJO, line: 3 }]);
  });

  it('向下找时**不得越过下一个函数头**（头后即是空函数）→ 不给位置，退回索引', () => {
    const result = stubResult(['@EMPTY_FN', '@OTHER_FN', '\tRETURN 1'], [[1, null], [2, null], [3, 9]]);
    const index = indexOf({ EMPTY_FN: [{ filePath: LIB, startLine: 42 }] });
    const text = 'CALL EMPTY_FN\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL EMPTY|_FN'), depsOf(result, index));
    expect(locs).toEqual([{ filePath: LIB, line: 42 }]); // 退回索引那条腿，而不是折到 9（那是别的函数）
  });

  it('转译产 error 诊断 → 源映射不可信，整条自证腿放弃，退回索引', () => {
    const result: SugarTranspileResult = {
      ...stubResult(['@M_KOJO_K101_X', '\tRETURN 1'], [[1, null], [2, 5]]),
      diagnostics: [{ code: 'internal', severity: 'error', message: 'boom', loc: null }],
    };
    const index = indexOf({ M_KOJO_K101_X: [{ filePath: LIB, startLine: 8 }] });
    const text = 'CALL M_KOJO_K101_X\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL M_KOJO_K101|_X'), depsOf(result, index));
    expect(locs).toEqual([{ filePath: LIB, line: 8 }]);
  });

  it('大小写不敏感：小写引用命中大写的产物头', () => {
    const result = stubResult(['@M_KOJO_K101_X', '\tRETURN 1'], [[1, null], [2, 4]]);
    const text = 'CALL m_kojo_k101_x\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL m_kojo_k101|_x'), depsOf(result, null));
    expect(locs).toEqual([{ filePath: KOJO, line: 4 }]);
  });
});

describe('resolveKojoDefinition · 别处的函数（复用项目索引 byName）', () => {
  it('本文件不产出该名字 → 查索引，命中编译产物 ERB 里的定义行', () => {
    const result = stubResult(['@M_KOJO_K101_X', '\tRETURN 1'], [[1, null], [2, 3]]);
    const index = indexOf({ LIB_FUNC: [{ filePath: LIB, startLine: 17 }] });
    const locs = resolveKojoDefinition(requestAt(CALLER, markedCaller('CALL LIB|_FUNC(1)')), depsOf(result, index));
    expect(locs).toEqual([{ filePath: LIB, line: 17 }]);
  });

  it('重名多处定义 → 全部返回', () => {
    const result = stubResult(['@OTHER', '\tRETURN 1'], [[1, null], [2, 2]]);
    const index = indexOf({
      LIB_FUNC: [{ filePath: LIB, startLine: 17 }, { filePath: 'C:\\game\\lib2.ERB', startLine: 3 }],
    });
    const locs = resolveKojoDefinition(requestAt(CALLER, markedCaller('CALL LIB|_FUNC(1)')), depsOf(result, index));
    expect(locs.map((l) => l.line)).toEqual([17, 3]);
  });

  it('索引缺席（未打开项目）→ 空数组（不猜）', () => {
    const result = stubResult(['@OTHER', '\tRETURN 1'], [[1, null], [2, 2]]);
    expect(resolveKojoDefinition(requestAt(CALLER, markedCaller('CALL LIB|_FUNC(1)')), depsOf(result, null))).toEqual(
      [],
    );
  });
});

describe('resolveKojoDefinition · fail-visible 负例（绝不猜、不崩）', () => {
  const result = stubResult(['@LIB_FUNC', '\tRETURN 1'], [[1, null], [2, 5]]);
  const index = indexOf({ LIB_FUNC: [{ filePath: LIB, startLine: 1 }] });
  /** `text` = `marked` 去掉那一个 `|`（两串必须一致，否则测的是另一行） */
  const call = (marked: string, text: string, deps = depsOf(result, index)) =>
    resolveKojoDefinition(requestAt(text, marked), deps);

  it('未收录的名字 → 空数组', () => {
    expect(call('CALL NOPE|_X(1)\n', 'CALL NOPE_X(1)\n')).toEqual([]);
  });

  it('光标在空白 / 关键字 / CJK 上 → 空数组', () => {
    // 空白：注释行里的空格（左右都不是记号字符）
    expect(call('; |调用别处的库函数\nCALL LIB_FUNC(1)\n', '; 调用别处的库函数\nCALL LIB_FUNC(1)\n')).toEqual([]);
    // 关键字 `CALL` 本身不是函数名（不在 byName 里）
    expect(call('CALL| LIB_FUNC(1)\n', 'CALL LIB_FUNC(1)\n')).toEqual([]);
    // CJK
    expect(call('时机 |指令 310：\n', '时机 指令 310：\n')).toEqual([]);
  });

  it('行号越界（0 / 超大 / NaN）→ 空数组', () => {
    const deps = depsOf(result, index);
    expect(resolveKojoDefinition({ path: KOJO, text: CALLER, line: 0, column: 6 }, deps)).toEqual([]);
    expect(resolveKojoDefinition({ path: KOJO, text: CALLER, line: 99, column: 6 }, deps)).toEqual([]);
    expect(resolveKojoDefinition({ path: KOJO, text: CALLER, line: Number.NaN, column: 6 }, deps)).toEqual([]);
  });
});

describe('findGeneratedHeaderLine · 与真实 codegen 同源', () => {
  const service = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
  const KOJO_SRC = ['角色: 101', '口上色: 0x88AACC', '', '时机 指令 310 成否: 游戏判定：', '\t「呀……！」'].join('\n');

  it('真转译产物里的 `@` 头能被找到（名字与大小写都按产物），找不到的名字给 null', () => {
    const result = service.transpile(KOJO_SRC, { filePath: KOJO });
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    const headers = result.erb
      .split('\n')
      .map((l, i) => ({ line: i + 1, m: /^@([A-Za-z0-9_]+)/.exec(l) }))
      .filter((h) => h.m);
    expect(headers.length).toBeGreaterThan(0);
    const first = headers[0]!;
    expect(findGeneratedHeaderLine(result.erb, first.m![1]!)).toBe(first.line);
    expect(findGeneratedHeaderLine(result.erb, first.m![1]!.toLowerCase())).toBe(first.line);
    expect(findGeneratedHeaderLine(result.erb, 'NO_SUCH_FUNCTION')).toBeNull();
  });

  it('真转译 + 真 sourceOf：产物头折回的源行**落在本文件内**（不崩、不越界）', () => {
    const result = service.transpile(KOJO_SRC, { filePath: KOJO });
    // 取 `_1` 正文函数（包装函数那两行是纯生成骨架，其后一整个函数体也没有源行）
    const names = [...result.erb.matchAll(/^@([A-Za-z0-9_]+)/gm)].map((m) => m[1]!);
    const body = names.find((n) => n.endsWith('_1'));
    expect(body).toBeDefined();
    // 用一个引用该名字的请求驱动：本文件确实产出它 → 走自证腿
    const text = `CALL ${body}(1)\n`;
    const locs = resolveKojoDefinition(requestAt(text, `CALL ${body}|(1)`), {
      transpile: () => result,
      sourceOf: (r, g) => service.sourceOf(r, g),
      index: () => null,
    });
    expect(locs).toHaveLength(1);
    const lineCount = KOJO_SRC.split('\n').length;
    expect(locs[0]!.filePath).toBe(KOJO);
    expect(locs[0]!.line).toBeGreaterThanOrEqual(1);
    expect(locs[0]!.line).toBeLessThanOrEqual(lineCount);
  });
});
