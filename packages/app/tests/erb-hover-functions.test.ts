/**
 * T2 · ERB 函数 docComment 悬停（`resolveHoverName` 第四/五路 · `erbIndex` 通道）纯逻辑单测。
 *
 * 假表驱动，不依赖 Monaco / 内核：`ErbIndex` 桩只含 `byName`（归一化大写名 → 定义引用）
 * 与 `files`（全量定义 → 形参）。覆盖：调用点与定义行同命中、docComment 多行正文、
 * 形参签名、定义位置、同名多处定义、大小写归一；以及 fail-visible 负例
 * （通道缺席 / 索引未建 / 求值抛错 / 词不在索引 ⇒ 一律不显示，**绝不猜**）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbFunction, ErbFunctionRef, ErbIndex, KojoLibraryTable } from '@kojo/plugin-api';
import { symbolTokenAt, unicodeTokenAt } from '@kojo/plugin-api';
import { type HoverTables, installHover, resolveHoverName } from '../src/monaco/kojo-hover';

const DOC = ['===================================================', '660,読書', 'TFLAG:193(選択肢文学…)'].join('\n');

function fn(name: string, startLine: number, docComment?: string): ErbFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    params: [
      { name: 'ARG:0', hasDefault: false },
      { name: 'OVERRIDE_TARGET', hasDefault: true },
    ],
    startLine,
    endLine: startLine + 10,
    filePath: 'C:/proj/ERB/BOOK.ERB',
    ...(docComment !== undefined ? { docComment } : {}),
  };
}

function ref(fnDef: ErbFunction): ErbFunctionRef {
  return {
    name: fnDef.name,
    normalizedName: fnDef.normalizedName,
    filePath: fnDef.filePath,
    startLine: fnDef.startLine,
    endLine: fnDef.endLine,
    ...(fnDef.docComment !== undefined ? { docComment: fnDef.docComment } : {}),
  };
}

/** 索引桩：`M_KOJO_EVENT` 带 docComment 与形参；`NO_DOC_FUNC` 无注释无形参；`TWINS` 同名两处 */
function fakeIndex(): ErbIndex {
  const book = fn('M_KOJO_EVENT', 10, DOC);
  const noDoc = fn('NO_DOC_FUNC', 3);
  const twin1 = fn('TWINS', 20);
  const twin2 = { ...fn('TWINS', 40), filePath: 'C:/proj/ERB/OTHER.ERB' };
  const files = new Map<string, { functions: ErbFunction[] }>([
    ['C:/proj/ERB/BOOK.ERB', { functions: [book] }],
    ['C:/proj/ERB/OTHER.ERB', { functions: [twin1, twin2] }],
  ]);
  const byName = new Map<string, ErbFunctionRef[]>([
    ['M_KOJO_EVENT', [ref(book)]],
    ['NO_DOC_FUNC', [ref(noDoc)]],
    ['TWINS', [ref(twin1), ref(twin2)]],
  ]);
  return { files, byName } as unknown as ErbIndex;
}

const tables: HoverTables = { erbIndex: () => fakeIndex() };

/** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1），返回解析结果 */
const at = (marked: string, t: HoverTables = tables) =>
  resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, t);

describe('ERB 函数悬停 · 命中', () => {
  it('调用点：`CALL M_KOJO_EVENT` 光标落在名字上 → 命中 + docComment 逐行 + 签名 + 定义位置', () => {
    const hit = at('CALL M_KOJO_|EVENT, 1');
    expect(hit?.name).toBe('M_KOJO_EVENT');
    expect(hit?.kind).toContain('ERB 函数');
    expect(hit?.lines).toContain('660,読書');
    expect(hit?.lines?.some((l) => l.includes('TFLAG:193'))).toBe(true);
    expect(hit?.lines?.some((l) => l.includes('ARG:0, OVERRIDE_TARGET'))).toBe(true);
    expect(hit?.lines?.some((l) => l.includes('C:/proj/ERB/BOOK.ERB:10'))).toBe(true);
  });

  it('定义行：`@M_KOJO_EVENT` 光标落在名字上 → 同样命中（查表只认词，不认语法位）', () => {
    const hit = at('@M_KOJO_EV|ENT');
    expect(hit?.name).toBe('M_KOJO_EVENT');
    expect(hit?.startColumn).toBe(2);
    expect(hit?.endColumn).toBe('@M_KOJO_EVENT'.length + 1);
  });

  it('大小写归一：源码里小写写法同样命中（Emuera 函数名大小写不敏感）', () => {
    const hit = at('CALL |m_kojo_event');
    expect(hit?.name).toBe('M_KOJO_EVENT');
  });

  it('无注释无形参：只剩定义位置一行（不猜、不造假正文）', () => {
    const hit = at('CALL |NO_DOC_FUNC');
    expect(hit?.lines).toEqual(['定义于 `C:/proj/ERB/BOOK.ERB:3`']);
  });

  it('同名多处定义：显示首条位置 + 一行注明剩余处数（重名事实不藏）', () => {
    const hit = at('CALL |TWINS');
    expect(hit?.lines?.some((l) => l.includes('BOOK.ERB:20'))).toBe(true);
    expect(hit?.lines?.some((l) => l.includes('OTHER.ERB'))).toBe(false);
    expect(hit?.lines?.some((l) => l.includes('另有 1 处同名定义'))).toBe(true);
  });

  it('命中的列区间覆盖整个光标词（1 基）', () => {
    const hit = at('CALL |NO_DOC_FUNC');
    expect(hit?.startColumn).toBe('CALL '.length + 1);
    expect(hit?.endColumn).toBe('CALL NO_DOC_FUNC'.length + 1);
  });
});

/**
 * DRIFT-APP 2（2026-10-19）：**函数索引那一路的取词尺改接契约层的 Unicode 那把**。
 *
 * 改前这一路自己写着 ASCII 记号集，中文函数名量不出记号 ⇒ `byName` 查不到 ⇒ 悬停整路
 * 静默（真实语料里约两成函数名含 CJK，不是边角料）。F2 改名、引用面板、结构化着色用的
 * 都是契约 `unicodeTokenAt` / `MODEL_TOKEN_CLASS` 那一把，现在悬停与它们同源。
 *
 * 写法是**对拍契约**而不是断言我新写的正则：把 `resolveErbFunctionHover` 里的尺子换回
 * ASCII（或直接抄一份新字符集），下面的命中例与区间对拍例立刻红。
 */
describe('ERB 函数悬停 · 含 CJK 的函数名（与 F2 / 引用面板同一把尺）', () => {
  const CJK_NAME = '好感度检查';
  const MIXED_NAME = '無個性_判定2';

  function cjkIndex(): ErbIndex {
    const a = fn(CJK_NAME, 7, '读心术：按好感度分支');
    const b = fn(MIXED_NAME, 21);
    const files = new Map<string, { functions: ErbFunction[] }>([
      ['C:/proj/ERB/BOOK.ERB', { functions: [a, b] }],
    ]);
    const byName = new Map<string, ErbFunctionRef[]>([[CJK_NAME.toUpperCase(), [ref(a)]], [MIXED_NAME.toUpperCase(), [ref(b)]]]);
    return { files, byName } as unknown as ErbIndex;
  }

  const cjkTables: HoverTables = { erbIndex: () => cjkIndex() };
  const atCjk = (marked: string) => resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, cjkTables);

  it('中文函数名调用点：此前整路查不到，此后命中 + 定义位置', () => {
    const hit = atCjk('CALL |好感度检查(1)');
    expect(hit?.name).toBe(CJK_NAME);
    expect(hit?.kind).toContain('ERB 函数');
    expect(hit?.lines?.some((l) => l.includes('C:/proj/ERB/BOOK.ERB:7'))).toBe(true);
    expect(hit?.lines?.some((l) => l.includes('读心术'))).toBe(true);
  });

  it('中文函数名定义行（`@` 开头）同样命中，且列区间 == 契约 `unicodeTokenAt` 给的区间', () => {
    const line = `@${CJK_NAME}`;
    const hit = resolveHoverName(line, 3, cjkTables);
    const contract = unicodeTokenAt(line, 3);
    expect(hit).toBeDefined();
    expect(contract).not.toBeNull();
    expect(hit!.startColumn).toBe(contract!.startColumn);
    expect(hit!.endColumn).toBe(contract!.endColumn);
    expect(hit!.name).toBe(CJK_NAME);
  });

  it('中英混排 / 全角字母的函数名也命中（记号集就是那张契约表，不是"CJK 白名单"）', () => {
    const hit = atCjk(`  ${MIXED_NAME}|(ARG:0)`);
    expect(hit?.name).toBe(MIXED_NAME);
  });

  it('负例：索引里没有的中文词 ⇒ 这一路不猜（Unicode 尺不等于"什么都给个答案"）', () => {
    expect(atCjk('IF |未知中文词 >= 1')).toBeUndefined();
  });

  it('反查表那一路**不跟着**放宽：查的是 ASCII 原生名，中文词不许从那里抢答', () => {
    // 实测库表 471 条里有 13 条"原生函数名本身就是中文"（如 `充填率`）。若把反查那把尺
    // 一起放宽，这些条目就会在第 2 路先命中，把函数索引那一路的正文（docComment / 定义位）
    // 顶掉——两把尺各自服务一条取词路，合成一把必有一侧判错。
    const lib = {
      lookupByFunction: (name: string) => (name === '充填率' ? '充填率（中文显示名）' : undefined),
      // 反查那一路（第 6 路，中文 → 原生形态）与本批无关：桩表对它如实给"查不到"，
      // 本例只钉"第 2 路不许从中文词面出 `函数 ·` 结果"。
      lookupByName: () => undefined,
      names: () => [],
      hasTable: true,
    } as unknown as KojoLibraryTable;
    const line = 'CALL 充填率(1)';
    const hit = resolveHoverName(line, 7, { libraryTable: lib });
    // 第 2 路的出货一律带 `函数 · <原生名>` 的 kind —— 出现即说明 ASCII 尺被放宽了
    expect(hit?.kind ?? '<无命中>').not.toMatch(/^函数 ·/);
    // 契约的 ASCII 尺照旧给得出原生名记号（这一路的判据没变，只是不再由本文件自己写）
    expect(symbolTokenAt('CALL GETBIT(1)', 7)!.text).toBe('GETBIT');
    expect(symbolTokenAt(line, 7)).toBeUndefined();
  });
});

/**
 * F12-TOKEN（2026-10-19）③：**同一个点位既是库表中文名又是函数名时谁先答**。
 *
 * 优先序不再挂在"哪条腿用哪把尺"上（那是巧合，不是裁决），而是挂在
 * `kojo-hover.ts::echoYieldsToIndex` 这一枚函数上：判据一条 ——
 * 库表那条**只是回显**（`中文名 === 原生名`）而项目函数索引认这个名字 ⇒ 库表让位。
 *
 * 语料依据（`eratw-adapter` 库表 471 条，实测）：原生名含非 ASCII 的正好 13 条，
 * 13/13 是恒等条目且 13 条全在函数索引里有 `@` 定义；原生名为 ASCII 且同时在库表与
 * 索引里的 458 条**全部**带真翻译。⇒ "索引一律优先"会打沉那 458 条（库表 97.2%），
 * "两把尺合成一把 Unicode"会抢掉那 13 条的正文；恒等/翻译这一条恰好把两半切开。
 *
 * 本组用例一律用 **ASCII 名字**跑：裁决必须与取词尺无关——把任何一把尺换掉，
 * 这几条断言都该照原样成立（这才是"判据"而不是"副作用"）。
 */
describe('库表反查 × 函数索引 · 同点位优先序（一条判据一枚函数）', () => {
  const ECHO = 'ECHO_FUNC'; // 库里只有回显（cn === 原生名）
  const TRANSLATED = 'TRANSLATED_FUNC'; // 库里有真翻译
  const indexWithBoth = (): ErbIndex => {
    const a = fn(ECHO, 11, '回显函数的注释');
    const b = fn(TRANSLATED, 22);
    const files = new Map<string, { functions: ErbFunction[] }>([['C:/proj/ERB/BOOK.ERB', { functions: [a, b] }]]);
    const byName = new Map<string, ErbFunctionRef[]>([[ECHO, [ref(a)]], [TRANSLATED, [ref(b)]]]);
    return { files, byName } as unknown as ErbIndex;
  };
  const lib = {
    lookupByFunction: (name: string) => (name === ECHO ? ECHO : name === TRANSLATED ? '中文显示名' : undefined),
    lookupByName: () => undefined,
    names: () => [],
    hasTable: true,
  } as unknown as KojoLibraryTable;

  it('回显条目 + 索引认这个名字 ⇒ 函数索引先答（docComment / 定义位一条不丢）', () => {
    const hit = resolveHoverName(`CALL ${ECHO}(1)`, 6, { libraryTable: lib, erbIndex: () => indexWithBoth() });
    expect(hit?.kind).toContain('ERB 函数');
    expect(hit?.lines?.some((l) => l.includes('回显函数的注释'))).toBe(true);
    expect(hit?.lines?.some((l) => l.includes('C:/proj/ERB/BOOK.ERB:11'))).toBe(true);
  });

  it('真翻译条目 + 索引也认这个名字 ⇒ 库表先答（那个中文名是索引里不存在的信息）', () => {
    const hit = resolveHoverName(`CALL ${TRANSLATED}(1)`, 6, { libraryTable: lib, erbIndex: () => indexWithBoth() });
    expect(hit?.kind).toBe(`函数 · ${TRANSLATED}`);
    expect(hit?.name).toBe('中文显示名');
  });

  it('回显条目但索引缺席（未开项目 / 通道抛错）⇒ 库表照旧答（fail-open，裁决不把另一条腿搞死）', () => {
    for (const erbIndex of [undefined, () => null, () => undefined] as const) {
      const hit = resolveHoverName(`CALL ${ECHO}(1)`, 6, { libraryTable: lib, ...(erbIndex ? { erbIndex } : {}) });
      expect(hit?.kind).toBe(`函数 · ${ECHO}`);
      expect(hit?.name).toBe(ECHO);
    }
    const thrown = resolveHoverName(`CALL ${ECHO}(1)`, 6, {
      libraryTable: lib,
      erbIndex: () => {
        throw new Error('parser absent');
      },
    });
    expect(thrown?.kind).toBe(`函数 · ${ECHO}`);
  });

  it('回显条目但索引里**没有**这个名字 ⇒ 库表答（回显让位的唯一条件是索引真的认领）', () => {
    const hit = resolveHoverName(`CALL ${ECHO}(1)`, 6, { libraryTable: lib, erbIndex: () => fakeIndex() });
    expect(hit?.kind).toBe(`函数 · ${ECHO}`);
  });
});

describe('ERB 函数悬停 · fail-visible 负例（绝不猜）', () => {
  it('通道缺席（erbIndex 未注入）⇒ 不产结果', () => {
    expect(at('CALL |M_KOJO_EVENT', {})).toBeUndefined();
  });

  it('索引未建（currentIndex() = null / undefined）⇒ 不产结果', () => {
    expect(at('CALL |M_KOJO_EVENT', { erbIndex: () => null })).toBeUndefined();
    expect(at('CALL |M_KOJO_EVENT', { erbIndex: () => undefined })).toBeUndefined();
  });

  it('通道求值抛错（解析器缺席）⇒ 不产结果、不抛进悬停 seam', () => {
    expect(
      at('CALL |M_KOJO_EVENT', {
        erbIndex: () => {
          throw new Error('parser absent');
        },
      }),
    ).toBeUndefined();
  });

  it('词不在 byName（索引里没有的函数）⇒ 不产结果', () => {
    expect(at('CALL |UNKNOWN_FUNC')).toBeUndefined();
  });

  it('光标落在空白处 / 空行 ⇒ 不产结果', () => {
    expect(at('CALL | M_KOJO_EVENT')).toBeUndefined();
    expect(at('|')).toBeUndefined();
  });
});

/**
 * installHover 渲染面：`lines` 逐行成为独立 markdown 块（假 Monaco 捕获出货，不引真运行时）。
 */
describe('ERB 函数悬停 · installHover 渲染', () => {
  const noopToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as Monaco.CancellationToken;

  it('名字行 + 附加正文行逐块出货', () => {
    const regs: { provider: Monaco.languages.HoverProvider }[] = [];
    const monaco = {
      languages: {
        registerHoverProvider: (_langId: string, provider: Monaco.languages.HoverProvider) => {
          regs.push({ provider });
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installHover(monaco, () => tables);
    const line = 'CALL M_KOJO_EVENT';
    const model = { getLineContent: () => line } as unknown as Monaco.editor.ITextModel;
    const hover = regs[0]!.provider.provideHover(
      model,
      { lineNumber: 1, column: 'CALL '.length + 1 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover | undefined;
    const values = (hover?.contents ?? []).map((c) => c.value);
    expect(values[0]).toContain('M_KOJO_EVENT');
    expect(values[0]).toContain('ERB 函数');
    expect(values.some((v) => v.includes('660,読書'))).toBe(true);
    expect(values.some((v) => v.includes('BOOK.ERB:10'))).toBe(true);
  });
});

/**
 * `#DIM` 声明名悬停（2026-10-19）：与函数路共用 `ErbIndex.files`，按**路径归一**找本文件。
 * 判据：中文声明名可命中、Windows 分隔符 / 大小写不敏感、非本文件 / 未给路径 ⇒ 不猜。
 */
describe('ERB `#DIM` 声明悬停', () => {
  const dimFile = {
    path: 'C:/proj/ERB/DIM.ERB',
    functions: [],
    dims: [{ name: '好感度', directive: 'DIM', line: 12 }],
    lineCount: 30,
    hasFunctionDirective: false,
  };
  const dimIndex = {
    files: new Map([['C:/proj/ERB/DIM.ERB', dimFile]]),
    byName: new Map(),
  } as unknown as ErbIndex;
  const dimTables: HoverTables = { erbIndex: () => dimIndex };
  const atDim = (marked: string, path: string | null) =>
    resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, dimTables, {}, path);

  it('中文声明名命中：显示声明指令与定义行', () => {
    const hit = atDim('IF 好感|度 >= 50', 'C:/proj/ERB/DIM.ERB');
    expect(hit?.name).toBe('好感度');
    expect(hit?.kind).toBe('#DIM 声明');
    expect(hit?.lines?.some((l) => l.includes('DIM.ERB:12'))).toBe(true);
  });

  it('路径归一：反斜杠 + 大小写不同也命中（索引键与 model.uri 来自不同腿）', () => {
    const hit = atDim('好感|度 = 1', String.raw`c:\proj\erb\dim.erb`);
    expect(hit?.name).toBe('好感度');
  });

  it('负例：未给路径 / 文件不在索引 / 词不是声明名 ⇒ 一律不显示（不猜）', () => {
    expect(atDim('好感|度 = 1', null)).toBeUndefined();
    expect(atDim('好感|度 = 1', 'C:/proj/ERB/OTHER.ERB')).toBeUndefined();
    expect(atDim('未知|词 = 1', 'C:/proj/ERB/DIM.ERB')).toBeUndefined();
  });
});
