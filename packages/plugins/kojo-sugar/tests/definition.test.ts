/**
 * 转到定义 · `.kojo` 侧（`resolveKojoDefinition`）单测。
 *
 * 语义（见 `src/definition.ts` 头注）：`.kojo` 里的函数名指向**编译产物 ERB 里的函数**，
 * 反查两条腿——① 名字由本文件产出（转译 → 找 `@NAME` → `sourceOf` 把产物行折回源行）；
 * ② 名字来自别处（复用项目 ERB 索引 `byName`）。本文件两条腿都钉：前者用**桩转译结果**
 * 精确驱动（含"生成头无源行 → 向下取最近有源行"与"不得越过下一个函数"两种边界），
 * 后者用真转译产物验证"真实 codegen 造出的头，`findGeneratedHeaderLine` 找得到"。
 *
 * 文件尾追加 K2-PRE-REUSE ⑤ 面：**CJK / 全角拉丁函数头自证**——取词尺与头名尺统一到
 * `identifier-chars` 名字字符集后的红→绿用例、ASCII 逐字不变回归、全角标点 / 全角
 * 数字负断言。
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

function depsOf(
  result: SugarTranspileResult,
  index: ErbIndex | null,
  /** 列级折回桩：默认**给不出列**（纯生成行 / 无列区段的真实语义），钉住"退回行级、不猜列"这条默认路 */
  sourceColumnOf: KojoDefinitionDeps['sourceColumnOf'] = () => null,
): KojoDefinitionDeps {
  return {
    transpile: () => result,
    sourceOf: (r, generatedLine) => {
      const e = r.sourceMap.find((x) => x.generatedLine === generatedLine);
      return e && e.sourceLine !== null ? { line: e.sourceLine, column: 1 } : null;
    },
    sourceColumnOf,
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

  it('光标在空白 / 关键字 / 未收录的词上 → 空数组', () => {
    // 空白：注释行里的空格（左右都不是记号字符）
    expect(call('; |调用别处的库函数\nCALL LIB_FUNC(1)\n', '; 调用别处的库函数\nCALL LIB_FUNC(1)\n')).toEqual([]);
    // 关键字 `CALL` 本身不是函数名（不在 byName 里）
    expect(call('CALL| LIB_FUNC(1)\n', 'CALL LIB_FUNC(1)\n')).toEqual([]);
    // 未收录的中文词：K2-PRE-REUSE ⑤ 起 CJK 词**取得出整串**（这里是 `指令`），
    // 空数组的成因由"取不出词"变成"索引里没有这个名字"——断言不变，理由改写
    expect(call('时机 |指令 310：\n', '时机 指令 310：\n')).toEqual([]);
  });

  it('行号越界（0 / 超大 / NaN）→ 空数组', () => {
    const deps = depsOf(result, index);
    expect(resolveKojoDefinition({ path: KOJO, text: CALLER, line: 0, column: 6 }, deps)).toEqual([]);
    expect(resolveKojoDefinition({ path: KOJO, text: CALLER, line: 99, column: 6 }, deps)).toEqual([]);
    expect(resolveKojoDefinition({ path: KOJO, text: CALLER, line: Number.NaN, column: 6 }, deps)).toEqual([]);
  });
});

describe('resolveKojoDefinition · 折回的列（R1：列级优先，给不出就退行级、绝不猜列）', () => {
  /** 头行本身有源行的产物（原生直通那类）——只有这种行才谈得上列 */
  const withSource = stubResult(['@NATIVE_FN', '\tRETURN 1'], [[1, 3], [2, 4]]);
  const req = () => requestAt('CALL NATIVE_FN\n', 'CALL NATIVE|_FN');

  it('列级映射命中**同一个源行** → 位置带上列（宿主直接当编辑器列用）', () => {
    const locs = resolveKojoDefinition(req(), depsOf(withSource, null, () => ({ line: 3, column: 7 })));
    expect(locs).toEqual([{ filePath: KOJO, line: 3, column: 7 }]);
  });

  it('列级映射给不出（纯生成头 / 无列区段）→ 只有行，`column` 键整个不出现', () => {
    const [only] = resolveKojoDefinition(req(), depsOf(withSource, null, () => null));
    expect(only).toEqual({ filePath: KOJO, line: 3 });
    expect('column' in only!).toBe(false);
  });

  it('列级映射给的是**另一行**的列 → 丢列保行（不许把两处坐标拼成一个落点）', () => {
    const [only] = resolveKojoDefinition(req(), depsOf(withSource, null, () => ({ line: 9, column: 4 })));
    expect(only).toEqual({ filePath: KOJO, line: 3 });
  });

  it('头行是纯生成行（折回走"向下取最近有源行"）→ 一律只给行', () => {
    const generated = stubResult(['@M_KOJO_K101_X', '\tPRINTFORMW "hi"'], [[1, null], [2, 7]]);
    const locs = resolveKojoDefinition(
      requestAt('CALL M_KOJO_K101_X\n', 'CALL M_KOJO_K101|_X'),
      depsOf(generated, null, () => ({ line: 7, column: 5 })), // 桩就算给列，行级折回也不认它
    );
    expect(locs).toEqual([{ filePath: KOJO, line: 7 }]);
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
      sourceColumnOf: (r, g, c) => service.sourceColumnOf(r, g, c),
      index: () => null,
    });
    expect(locs).toHaveLength(1);
    const lineCount = KOJO_SRC.split('\n').length;
    expect(locs[0]!.filePath).toBe(KOJO);
    expect(locs[0]!.line).toBeGreaterThanOrEqual(1);
    expect(locs[0]!.line).toBeLessThanOrEqual(lineCount);
  });

  it('真转译 + 真列级映射：折回给得出列时**一定落在该源行内**（列口径与编辑器同源，宿主不必换算）', () => {
    const result = service.transpile(KOJO_SRC, { filePath: KOJO });
    const srcLines = KOJO_SRC.split('\n');
    const deps: KojoDefinitionDeps = {
      transpile: () => result,
      sourceOf: (r, g) => service.sourceOf(r, g),
      sourceColumnOf: (r, g, c) => service.sourceColumnOf(r, g, c),
      index: () => null,
    };
    const names = [...result.erb.matchAll(/^@([A-Za-z0-9_]+)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = `CALL ${name}(1)\n`;
      for (const loc of resolveKojoDefinition(requestAt(text, `CALL ${name}|(1)`), deps)) {
        const line = srcLines[loc.line - 1];
        expect(line).toBeDefined();
        if (loc.column === undefined) continue; // 纯生成头 ⇒ 行级折回，本就只给行
        // 「行长 + 1」= Monaco 的最大合法列（同一 UTF-16 码元口径；这里只验不出界，不做第二次映射）
        expect(loc.column).toBeGreaterThanOrEqual(1);
        expect(loc.column).toBeLessThanOrEqual(line!.length + 1);
      }
    }
  });
});

/* ============================================================================
 * K2-PRE-REUSE ⑤ · CJK / 全角拉丁函数头自证（2026-10-21）
 *
 * 改前的病（两条尺各只认 ASCII，断在同一环上）：
 * - **取词尺**：`symbolTokenAt` 缺省 ASCII 集 ⇒ 光标在中文 / 日文 / 全角拉丁函数名上
 *   取不出整串（`CALL 好感度检查` 量出 `undefined`）⇒ 请求直接空数组；
 * - **头名尺**：`^@([A-Za-z0-9_]+)` ⇒ 就算取得出，产物里的 `@好感度检查` 也匹配不上。
 * 两条都是"作者明明写对了，却被告知没有定义"。
 *
 * 改后：两把尺统一到 `identifier-chars` 单一真源派生的**名字字符集**（ASCII 字母
 * 数字下划线 + CJK + 全角拉丁字母；明确不收全角标点 / 全角数字 / `$`）。本块钉
 * 三面：红→绿自证用例、ASCII 逐字不变、全角标点 / 全角数字负断言。
 * ========================================================================== */

describe('resolveKojoDefinition · CJK / 全角拉丁函数头自证（K2-PRE-REUSE ⑤）', () => {
  const service = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

  /** 真转译依赖（自证腿不查索引：`index: () => null`——折不回就本该没有答案） */
  const realDeps = (result: SugarTranspileResult): KojoDefinitionDeps => ({
    transpile: () => result,
    sourceOf: (r, g) => service.sourceOf(r, g),
    sourceColumnOf: (r, g, c) => service.sourceColumnOf(r, g, c),
    index: () => null,
  });

  /**
   * 夹具：两个**原生直通块**（规范 §3.10，`@头` 整块透传）——头名即函数名，第二块
   * `CALL` 第一块的头名。期望：光标在 CALL 上，自证腿折回第一个 `@头` 的**源行 4**
   * （原生块所有行的源行都记在块首，`codegen` 的 `pushRaw` 既定口径）。
   */
  const nativeFixture = (name: string): string[] => [
    '角色: 101',
    '口上色: 0x88AACC',
    '',
    `@${name}`,
    '#FUNCTION',
    'RETURN 1',
    '#FUNCTIONEND',
    '',
    '@主流程',
    '#FUNCTION',
    `CALL ${name}`,
    '#FUNCTIONEND',
  ];

  /** 在全文第 `line` 行名字首字符处插光标标记（`requestAt` 的 `marked` 契约） */
  const markedAt = (text: string, line: number, name: string): string => {
    const lines = text.split('\n');
    const at = lines[line - 1]!.indexOf(name);
    expect(at, `第 ${line} 行应含 「${name}」`).toBeGreaterThanOrEqual(0);
    lines[line - 1] = `${lines[line - 1]!.slice(0, at)}|${lines[line - 1]!.slice(at)}`;
    return lines.join('\n');
  };

  const CASES = [
    ['好感度检查', '汉字'],
    ['パラメータ検査', '片假名 + 汉字（日文）'],
    ['Ｃ絶頂', '全角拉丁 + 汉字'],
    ['SHOW_上半身内衣', 'ASCII + 汉字混排'],
  ] as const;

  for (const [name, label] of CASES) {
    it(`${label}：\`CALL ${name}\` 自证折回 \`@${name}\` 的源行`, () => {
      const src = nativeFixture(name).join('\n');
      const result = service.transpile(src, { filePath: KOJO });
      expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(false);
      // 产物里确有这个 @ 头（原生块逐字透传）；找不到即本用例无的放矢
      expect(findGeneratedHeaderLine(result.erb, name)).toBeGreaterThan(0);
      const locs = resolveKojoDefinition(requestAt(src, markedAt(src, 11, name)), realDeps(result));
      expect(locs).toHaveLength(1);
      const [loc] = locs;
      expect(loc!.filePath).toBe(KOJO);
      expect(loc!.line).toBe(4);
      if (loc!.column !== undefined) {
        expect(loc!.column).toBeGreaterThanOrEqual(1);
        expect(loc!.column).toBeLessThanOrEqual(nativeFixture(name)[3]!.length + 1);
      }
    });
  }

  it('全角小写引用折叠成全角大写键：`CALL ｃ絶頂` 命中产物头 `@Ｃ絶頂`（大小写不敏感扩到全角）', () => {
    const result = stubResult(['@Ｃ絶頂', '\tRETURN 1'], [[1, 3], [2, 4]]);
    const text = 'CALL ｃ絶頂\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL |ｃ絶頂'), depsOf(result, null));
    expect(locs).toEqual([{ filePath: KOJO, line: 3 }]);
  });

  it('索引腿：汉字库函数名（本文件不产出）→ byName 命中定义行', () => {
    const result = stubResult(['@M_KOJO_K101_X', '\tRETURN 1'], [[1, null], [2, 3]]);
    const index = indexOf({ LIB_充填率: [{ filePath: LIB, startLine: 42 }] });
    const text = 'CALL LIB_充填率(1)\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL LIB_|充填率(1)'), depsOf(result, index));
    expect(locs).toEqual([{ filePath: LIB, line: 42 }]);
  });

  it('索引腿：日文函数名多处定义 → 全部返回（与 ASCII 重名行为同形）', () => {
    const result = stubResult(['@OTHER', '\tRETURN 1'], [[1, null], [2, 2]]);
    const index = indexOf({
      パラメータ検査: [
        { filePath: LIB, startLine: 17 },
        { filePath: 'C:\\game\\lib2.ERB', startLine: 3 },
      ],
    });
    const text = 'CALL パラメータ検査(1)\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL |パラメータ検査(1)'), depsOf(result, index));
    expect(locs.map((l) => l.line)).toEqual([17, 3]);
  });
});

describe('resolveKojoDefinition · 全角标点 / 全角数字负断言（K2-PRE-REUSE ⑤）', () => {
  const result = stubResult(['@OTHER', '\tRETURN 1'], [[1, null], [2, 2]]);

  it('全角标点混入的名字取不出整串：索引里躺着 `充填，率` 也查不到（token 止步于 `，`）', () => {
    const index = indexOf({ '充填，率': [{ filePath: LIB, startLine: 5 }] });
    const text = 'CALL 充填，率(1)\n';
    const locs = resolveKojoDefinition(requestAt(text, 'CALL |充填，率(1)'), depsOf(result, index));
    expect(locs).toEqual([]);
  });

  it('全角数字混入的名字取不出整串：`指令３１０` 只取得出 `指令`（３＝U+FF13 不在名字集）', () => {
    const index = indexOf({
      指令３１０: [{ filePath: LIB, startLine: 5 }],
      指令: [{ filePath: 'C:\\game\\lib2.ERB', startLine: 9 }],
    });
    const text = 'CALL 指令３１０()\n';
    // 光标在 `指` 上：token = `指令` ⇒ 命中 lib2 的 `指令`，**不是** `指令３１０`
    const locs = resolveKojoDefinition(requestAt(text, 'CALL |指令３１０()'), depsOf(result, index));
    expect(locs).toEqual([{ filePath: 'C:\\game\\lib2.ERB', line: 9 }]);
  });

  it('头名侧同口径：含全角标点 / 全角数字的名字匹配不上 `@` 头（宁可不给答案）', () => {
    expect(findGeneratedHeaderLine('@充填，率\n\tRETURN 1\n', '充填，率')).toBeNull();
    expect(findGeneratedHeaderLine('@指令３１０\n\tRETURN 1\n', '指令３１０')).toBeNull();
    // 干净名对干净头照旧命中（负断言只针对"混入"的那一侧）
    expect(findGeneratedHeaderLine('@充填率\n\tRETURN 1\n', '充填率')).toBe(1);
  });
});

describe('findGeneratedHeaderLine · 名字字符集面（K2-PRE-REUSE ⑤）', () => {
  it('ASCII 口径逐字不变：裸名 / 带参数声明 / 停在不收录字符 / 整串相等才命中', () => {
    expect(findGeneratedHeaderLine('@FOO\n', 'FOO')).toBe(1);
    expect(findGeneratedHeaderLine('@FOO(ARG,ARG:1)\n', 'FOO')).toBe(1); // 参数声明段不碍事
    expect(findGeneratedHeaderLine('@FOO BAR\n', 'FOO')).toBe(1); // 空白截断（旧口径）
    expect(findGeneratedHeaderLine('@FOO_BAR\n', 'FOO')).toBeNull(); // 前缀不等于整串
    expect(findGeneratedHeaderLine('@FOO\n', 'FO')).toBeNull();
    expect(findGeneratedHeaderLine('\t@INDENTED\n', 'INDENTED')).toBeNull(); // 带缩进不是函数头
    expect(findGeneratedHeaderLine('@FOO$BAR\n', 'FOO')).toBe(1); // `$` 仍不收：截在 `$`（旧口径）
    expect(findGeneratedHeaderLine('@FOO$BAR\n', 'FOO$BAR')).toBeNull();
  });

  it('CJK / 全角拉丁整串命中（汉字 / 假名 / 全角字母 / 混排，带参数声明亦可）', () => {
    expect(findGeneratedHeaderLine('@好感度检查\n', '好感度检查')).toBe(1);
    expect(findGeneratedHeaderLine('@パラメータ\n', 'パラメータ')).toBe(1);
    expect(findGeneratedHeaderLine('@Ｃ絶頂\n', 'Ｃ絶頂')).toBe(1);
    expect(findGeneratedHeaderLine('@SHOW_上半身内衣(ARG)\n', 'SHOW_上半身内衣')).toBe(1);
    expect(findGeneratedHeaderLine('@漢々柿\n', '漢々柿')).toBeNull(); // 々＝U+3005（叠字符号）不在名字集：与 `identifier-chars` 口径逐字一致
  });
});
