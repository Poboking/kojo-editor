import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type { EditorDocumentSymbol, ErbFile, ErbFunction, ErbIndex } from '@kojo/plugin-api';
import { functionAt } from '@kojo/plugin-erb-parser';
import { symbolChainAt } from '../src/ui/breadcrumb-path';
import { functionNameAt } from '../src/ui/jump-to-state';
import { resolveEnclosingFunction } from '@kojo/plugin-erb-parser';

/**
 * W7 NAV-SCOPE · P0 对拍（2026-10-18 接力批）。
 *
 * **同一行输入，四个消费方必须得到同一结论**——此前四份判据各给各的答案：
 *   ① `erb-parser/symbols.functionAt`（索引通道）
 *   ② `@kojo/plugin-erb-parser` 的 `resolveEnclosingFunction`（调用层级；`functionAt` 缺席时
 *      在索引 `files` 上自扫，兜底与真源不许给出两种答案）
 *   ③ `ui/breadcrumb-path.symbolChainAt`（面包屑链上最后一个 function 层）
 *   ④ `ui/jump-to-state.functionNameAt`（跳状态：链上取最内 function）
 * 对拍**不放宽成恒真**：每一行单独比五行出口（②走权威通道与走兜底各一次），
 * 并且负自证钉住那条真实坑——平铺大纲里 `#DIM` 单行声明不许把外层函数淘汰掉。
 *
 * 坐标系注记（`symbols.ts` 头注承认的"缓冲区与索引两份坐标系"）：①②吃**索引**那份
 * 平铺函数表，③④吃**缓冲区 documentSymbol** 那份（平铺但多了 `#DIM` 声明层）。
 * 归一口径 = 从同一份数据派生两棵树（`symbolsFrom` → 索引、`symbolsFrom` + 声明 → 大纲），
 * 这正是真实管线里 `erbDocumentSymbols` 与 scanner 的派生关系；两份坐标系下
 * "这行属于哪个函数"的**结论**必须逐行相等，声明层只允许改变链尾、不允许改变函数归属。
 */

const PATH = 'C:/game/kojo/chara12/MESSAGE.ERB';

interface Row {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** 函数区间（索引与大纲**同一份派生源**；scanner 收紧后区间互不重叠） */
const FUNCS: readonly Row[] = [
  { name: 'M_KOJO_K12_310', startLine: 10, endLine: 24 },
  { name: 'M_KOJO_K12_311', startLine: 25, endLine: 39 },
  { name: 'M_KOJO_K12_TAIL', startLine: 44, endLine: 50 },
];

/** `#DIM` 单行声明（只存在于大纲树——平铺、与函数区间重叠） */
const DECLS: readonly Row[] = [
  { name: 'CFLAG', startLine: 15, endLine: 15 },
  { name: 'BASEBALL_COUNT', startLine: 30, endLine: 30 },
];

const erbFunctions: ErbFunction[] = FUNCS.map((f) => ({
  name: f.name,
  normalizedName: f.name.toUpperCase(),
  filePath: PATH,
  startLine: f.startLine,
  endLine: f.endLine,
  params: [],
}));

const fakeIndex: ErbIndex = {
  files: new Map<string, ErbFile>([
    [
      PATH,
      {
        path: PATH,
        functions: erbFunctions,
        dims: [],
        hasFunctionDirective: false,
        lineCount: 60,
      },
    ],
  ]),
  byName: functionLookupOf(new Map()),
};

const outlineSymbols: EditorDocumentSymbol[] = [
  ...FUNCS.map((f): EditorDocumentSymbol => ({ name: f.name, kind: 'function', startLine: f.startLine, endLine: f.endLine })),
  ...DECLS.map((d): EditorDocumentSymbol => ({ name: d.name, kind: 'declaration', startLine: d.startLine, endLine: d.endLine })),
];

/** ③ 的结论：面包屑链上最后一个 function 层（面包屑消费者真正拿去用的那一枚） */
function crumbFunction(line: number): string | null {
  const chain = symbolChainAt(outlineSymbols, line);
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i]!;
    if (s.kind === 'function') return s.name;
  }
  return null;
}

describe('P0 对拍 — 同一行输入，四个消费方同一结论', () => {
  const lines = [1, 9, 10, 15, 24, 25, 30, 39, 40, 43, 44, 50, 51, 60];
  it.each(lines)('第 %i 行：①=②(权威通道)=②(兜底)=③=④', (line) => {
    const viaParser = functionAt(fakeIndex, PATH, line)?.name;
    const viaCallgraphAuthoritative = resolveEnclosingFunction(
      fakeIndex,
      (p, l) => functionAt(fakeIndex, p, l) ?? undefined,
      PATH,
      line,
    )?.name;
    const viaCallgraphFallback = resolveEnclosingFunction(fakeIndex, null, PATH, line)?.name;
    const viaCrumb = crumbFunction(line) ?? undefined;
    const viaJump = functionNameAt(outlineSymbols, line) ?? undefined;
    // 五个出口两两相等（undefined 也参与——"不在任何函数里"也是结论，不许一边猜一个）
    expect(viaCallgraphAuthoritative, '调用层级·权威通道 vs 解析器').toBe(viaParser);
    expect(viaCallgraphFallback, '调用层级·兜底 vs 解析器（兜底与真源不许两种答案）').toBe(viaParser);
    expect(viaCrumb, '面包屑链 vs 解析器').toBe(viaParser);
    expect(viaJump, '跳状态 vs 解析器').toBe(viaParser);
  });

  it('逐行核对具体答案（不是"相等"就完事——结论本身钉死）', () => {
    expect(functionNameAt(outlineSymbols, 15)).toBe('M_KOJO_K12_310'); // `#DIM CFLAG` 行
    expect(functionNameAt(outlineSymbols, 30)).toBe('M_KOJO_K12_311'); // `#DIM BASEBALL_COUNT` 行
    expect(functionNameAt(outlineSymbols, 9)).toBeNull(); // 函数头之前
    expect(functionNameAt(outlineSymbols, 40)).toBeNull(); // 两段之间的缝
    expect(functionAt(fakeIndex, PATH, 15)?.name).toBe('M_KOJO_K12_310');
    expect(resolveEnclosingFunction(fakeIndex, null, PATH, 15)?.normalizedName).toBe('M_KOJO_K12_310');
  });

  it('负自证：`#DIM` 行上链尾是声明，但函数归属**不许**被同层淘汰掉', () => {
    const chain = symbolChainAt(outlineSymbols, 15);
    expect(chain.length).toBe(2);
    expect(chain[1]!.kind).toBe('declaration'); // 最内层（innermost）确实是那枚声明
    expect(chain[0]!.name).toBe('M_KOJO_K12_310'); // 外层函数活着——旧"每层留最小区间"判据在这里把它淘汰了
    // 模式参数把差异写在调用点上：要声明的消费者拿 innermost，要函数的拿链上 function 层
    expect(functionAt(fakeIndex, PATH, 15, 'outermost')?.name).toBe('M_KOJO_K12_310');
    expect(functionAt(fakeIndex, PATH, 15, 'innermost')?.name).toBe('M_KOJO_K12_310'); // 索引里没有更内层
  });

  it('非法行号五口齐否（不夹取是全体口径，不是某一家的事）', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(functionAt(fakeIndex, PATH, bad)).toBeUndefined();
      expect(resolveEnclosingFunction(fakeIndex, null, PATH, bad)).toBeUndefined();
      expect(symbolChainAt(outlineSymbols, bad)).toEqual([]);
      expect(functionNameAt(outlineSymbols, bad)).toBeNull();
    }
  });

  it('同宽双胞胎（索引缝里的畸形重名区间）两侧取同一枚：文档序第一枚', () => {
    const twinA: ErbFunction = { name: 'TWIN_A', normalizedName: 'TWIN_A', filePath: PATH, startLine: 5, endLine: 8, params: [] };
    const twinB: ErbFunction = { name: 'TWIN_B', normalizedName: 'TWIN_B', filePath: PATH, startLine: 5, endLine: 8, params: [] };
    const idx: ErbIndex = { files: new Map([[PATH, { ...fakeIndex.files.get(PATH)!, functions: [twinA, twinB] }]]), byName: functionLookupOf(new Map()) };
    expect(functionAt(idx, PATH, 6)?.name).toBe('TWIN_A');
    expect(resolveEnclosingFunction(idx, null, PATH, 6)?.name).toBe('TWIN_A');
    const syms: EditorDocumentSymbol[] = [
      { name: 'TWIN_A', kind: 'function', startLine: 5, endLine: 8 },
      { name: 'TWIN_B', kind: 'function', startLine: 5, endLine: 8 },
    ];
    expect(functionNameAt(syms, 6)).toBe('TWIN_A');
    expect(symbolChainAt(syms, 6).map((s) => s.name)).toEqual(['TWIN_A']);
  });

  it('嵌套大纲（`.kojo` 时机块）：链上 function 层与跳状态同答', () => {
    const nested: EditorDocumentSymbol[] = [
      {
        name: 'M_SUGAR_FN',
        kind: 'function',
        startLine: 2,
        endLine: 40,
        children: [{ name: '段', kind: 'block', startLine: 5, endLine: 20 }],
      },
    ];
    expect(functionNameAt(nested, 10)).toBe('M_SUGAR_FN');
    expect(symbolChainAt(nested, 10).map((s) => s.name)).toEqual(['M_SUGAR_FN', '段']);
  });
});
