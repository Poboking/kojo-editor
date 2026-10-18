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
import type { ErbFunction, ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
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
