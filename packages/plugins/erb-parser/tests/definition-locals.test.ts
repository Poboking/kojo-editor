/**
 * `erb-definition` 的**本地名字腿**（LAU-4 第二步归位批，2026-10-30）。
 *
 * 这一批把"标签作用域"（`labelScopeAt`）留在解析器插件、把 `#DIM` 纯判据下沉到零依赖库
 * `@kojo/erb-vocab` + 本插件 `symbols.ts` 的 `#DIM` 腿。本文件钉的是**合起来之后的
 * 行为**（原 `plugin-erb-lang/tests/definition.test.ts` 与 `erb-lang/tests/definition.test.ts`
 * 里的标签用例搬来这里，期望值逐条保留）：
 *
 * 1. **三态**：非 definition 请求 / 非 ERB 方言 ⇒ `undefined`（弃权）；认这门语言但此处
 *    没有可跳的名字 ⇒ `{ locations: [] }`（作答，不是弃权）；
 * 2. **`#DIM` 腿**：声明名 → 声明行 + **名字那一列**；注释 / 字符串 / 非方言不答；
 * 3. **`$` 标签腿**：定义名自跳、`GOTO` 系跳转目标（含 CJK）跳到定义行；`CALL` 不是标签入口；
 * 4. **顺序**：标签 → 声明 → 函数索引（原宿主 `mergeNavigationLegs` 的序）；同处去重保留带
 *    `span` 的那一枚；标签入口命中时函数腿让位（`GOTO ALPHA` 不是函数引用）；
 * 5. **索引缺席**：本地两腿照答（缓冲区事实），函数腿零贡献。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceRequest, ErbIndex } from '@kojo/plugin-api';
import { provideErbDefinition } from '../src/plugin';

const PATH = String.raw`c:\proj\erb\loco.erb`;

const TEXT = [
  '@MAIN',
  '  #DIM 好感度',
  '  好感度 = 1',
  '  IF 好感度 >= 50',
  '  PRINTL "好感度"',
  '  ; 好感度 只在注释里',
  '$開始',
  '  GOTO 開始',
  '  CALL 開始',
  '@OTHER',
  '$開始',
  '  GOTO 開始',
].join('\n');

const req = (line: number, column: number, text = TEXT, path = PATH): EditorLanguageServiceRequest =>
  ({ kind: 'definition', path, text, line, column, project: null }) as EditorLanguageServiceRequest;

describe('erb-definition · 本地名字腿 · 三态', () => {
  it('不是 definition 请求 / 不是 ERB 方言 ⇒ `undefined`（弃权）', () => {
    const notDef = { kind: 'documentSymbol', path: PATH, text: TEXT, line: 1, column: 1 } as never;
    expect(provideErbDefinition(notDef, null)).toBeUndefined();
    expect(provideErbDefinition(req(2, 9, TEXT, 'C:/proj/erb/loco.kojo'), null)).toBeUndefined();
    expect(provideErbDefinition(req(2, 9, TEXT, '/tmp/a.txt'), null)).toBeUndefined();
  });

  it('认这门语言但此处没有可跳的名字 ⇒ 空数组（作答，不是弃权）', () => {
    expect(provideErbDefinition(req(9, 9), null)).toEqual({ kind: 'definition', locations: [] });
    expect(provideErbDefinition(req(999, 3), null)).toEqual({ kind: 'definition', locations: [] });
  });
});

describe('erb-definition · `#DIM` 声明腿', () => {
  it('正文里的声明名 → 声明行 + 名字那一列（不是行首）', () => {
    expect(provideErbDefinition(req(3, 3), null)).toEqual({
      kind: 'definition',
      locations: [{ filePath: PATH, line: 2, column: 8, span: { columnStart: 8, columnEnd: 11 } }],
    });
  });

  it('字符串内 / 注释内 / 被注释掉的声明 ⇒ 空数组（不猜）', () => {
    expect(provideErbDefinition(req(5, 11), null)).toEqual({ kind: 'definition', locations: [] });
    expect(provideErbDefinition(req(6, 5), null)).toEqual({ kind: 'definition', locations: [] });
    const commented = ['  ; #DIM 幽灵', '  幽灵 = 1'].join('\n');
    expect(provideErbDefinition(req(2, 3, commented), null)).toEqual({ kind: 'definition', locations: [] });
  });
});

describe('erb-definition · `$` 标签腿', () => {
  it('跳转目标（CJK）→ 本函数内的定义行（含 span）', () => {
    expect(provideErbDefinition(req(8, 8), null)).toEqual({
      kind: 'definition',
      locations: [{ filePath: PATH, line: 7, column: 2, span: { columnStart: 2, columnEnd: 4 }, kind: 'definition' }],
    });
  });

  it('`$` 定义名自跳（重复定义全部保留；另一个函数里的同名标签不混进来）', () => {
    const hits = provideErbDefinition(req(7, 2), null);
    expect(hits!.locations.map((l) => l.line)).toEqual([7]);
  });

  it('`CALL 開始` 不是标签入口（函数调用与标签是两类名字）', () => {
    expect(provideErbDefinition(req(9, 9), null)).toEqual({ kind: 'definition', locations: [] });
  });
});

/* ------------------------------ 顺序：标签 → 声明 → 函数 ------------------------------ */

/** 只带 `byName` 的函数索引（`definitionTargetsAt` 的函数腿只读这一格） */
function indexWith(name: string, startLine: number, column?: number): ErbIndex {
  return {
    byName: new Map([
      [
        name.toUpperCase(),
        [
          {
            name,
            normalizedName: name.toUpperCase(),
            filePath: PATH,
            startLine,
            endLine: startLine,
            ...(column === undefined ? {} : { nameColumn: column }),
          },
        ],
      ],
    ]),
  } as unknown as ErbIndex;
}

describe('erb-definition · 返回顺序 = 标签 → 声明 → 函数索引', () => {
  /** 同一函数里标签与声明同名：`GOTO 同銘` 上两条本地腿都答得出 */
  const BOTH = ['@F', '$同銘', '  #DIM 同銘', '  GOTO 同銘', '  PRINTL 同銘'].join('\n');

  it('标签与声明同名 ⇒ 标签在前、声明在后（槽里的函数索引救不了序）', () => {
    const out = provideErbDefinition({ kind: 'definition', path: PATH, text: BOTH, line: 4, column: 9 } as never, indexWith('同銘', 9));
    expect(out!.locations.map((l) => l.line)).toEqual([2, 3]);
  });

  it('声明与函数同名（不在标签入口上）⇒ 声明在前、函数索引在后', () => {
    const out = provideErbDefinition(req(3, 3), indexWith('好感度', 9, 1));
    expect(out!.locations.map((l) => l.line)).toEqual([2, 9]);
    // 函数腿带列就给区间（`column + name.length`，与索引同一条算式）
    expect(out!.locations[1]).toMatchObject({ column: 1, span: { columnStart: 1, columnEnd: 4 } });
  });

  it('标签入口命中时函数腿让位：`GOTO ALPHA` 不落同名函数（哪怕它真在索引里）', () => {
    const text = ['@F', '$ALPHA', '  GOTO ALPHA'].join('\n');
    const out = provideErbDefinition({ kind: 'definition', path: PATH, text, line: 3, column: 8 } as never, indexWith('ALPHA', 9));
    expect(out!.locations.map((l) => l.line)).toEqual([2]);
  });
});

describe('erb-definition · 索引缺席', () => {
  it('本地两腿照答（缓冲区事实），函数腿零贡献但仍是"作答"', () => {
    expect(provideErbDefinition(req(3, 3), null)!.locations.map((l) => l.line)).toEqual([2]);
    expect(provideErbDefinition(req(2, 2), null)).toEqual({ kind: 'definition', locations: [] });
  });
});