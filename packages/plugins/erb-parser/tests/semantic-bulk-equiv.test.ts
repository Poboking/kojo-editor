/**
 * R4b · 整项目扫描的语义诊断搬进计算池之后，**判据面必须一字不差**（2026-10-29）。
 *
 * 搬的是什么：`erb.semanticDiagnosticsBulk` 一批文件算一次，跨文件上下文（声明名 /
 * 实参目录 / 影子函数集）由 `buildSemanticBulkContext(index)` 序列化后随批带走。
 * 搬到 worker 的是**数据通路**，不是判据——判据本体仍是 `semantic-diagnostics.ts` 的
 * `collectErbSemanticDiagnostics` 一处，两条路径的差别只在"三处事实从哪来"。
 *
 * 本文件钉四件事：
 *
 * 1. **逐条等价**：同一索引 + 同一批文件，批量任务的 `perFile[i]` 与"活索引逐文件算"
 *    （也就是 `decorate({..., bulk: true})` 那一条回退路径）**深度相等**——含 message；
 * 2. **上下文真能过去**：`structuredClone` 往返之后结论不变（证明没有闭包/Map 混进去，
 *    也就是"它真的可以过 postMessage"）；
 * 3. **影子函数集不是装饰**：把 `shadowed` 清空，`GETTIME(1)` 那条内建诊断必须冒出来
 *    ——否则"过滤到内建同名"这件事就可能悄悄什么都没过滤；
 * 4. **条数自证 + 无项目态那一档**：上下文残缺要**抛错**（宿主据此回退逐文件，而不是
 *    拿一份残缺名录去扫）；`ctx === null` 与 `index === null` 逐条同义。
 */
import { describe, expect, it } from 'vitest';
import type { ErbIndex } from '@kojo/plugin-api';
import { aggregateIndex, buildSemanticBulkContext, semanticDiagnosticsBulk } from '../src/index';
import { parseErbText } from '../src/scanner';
import { collectErbSemanticDiagnostics } from '../src/offload';
import { agreedParamsOf, arityParamsOf } from '../src/arity';

/** 声明面 + 一个双参函数 + 一枚**与内建同名**的函数（影子函数让位的判据靠它） */
const DECLS = [
  '#DIM GLOBAL_A, 10',
  '#DIMS GLOBAL_S',
  '@FUNC_TWO(P, Q)',
  '    GLOBAL_A = P + Q',
  '    RETURN',
  '@GETTIME()',
  '    RETURN 0',
].join('\n');

/** 调用面：三条腿各来一条，再加一条"应该被影子函数压住"的内建调用 */
const CALLER = [
  '@CALLER()',
  '    CALL FUNC_TWO, 1, 2, 3',
  '    IF UNDECLARED_READ == 1',
  '        A = STRLENS("a", "b")',
  '    ENDIF',
  '    B = GETTIME(1)',
  '    C = GLOBAL_S',
  '    RETURN',
].join('\n');

const DECLS_PATH = 'C:/game/ERB/DIM.ERB';
const CALLER_PATH = 'C:/game/ERB/001/CALLER.ERB';

function indexOf(sources: { path: string; text: string }[]): ErbIndex {
  const parsed = sources.map((s) => parseErbText(s.text, s.path));
  const { files, byName } = aggregateIndex(parsed);
  return { files, byName, fingerprint: 'r4b-test', fileMtimes: new Map(), fileSizes: new Map() };
}

const INDEX = indexOf([
  { path: DECLS_PATH, text: DECLS },
  { path: CALLER_PATH, text: CALLER },
]);

const FILES = [
  { path: CALLER_PATH, text: CALLER },
  { path: DECLS_PATH, text: DECLS },
];

/**
 * 回退路径的产出（= `erb-semantics` 的 `decorate({..., bulk: true})` 干的事）。
 *
 * 这里刻意**照抄**贡献里的那几行而不是调用它：贡献是闭在 `activate` 里的，
 * 拿不到；而"抄的就是那几行"这件事由类型与同一份函数保证——参数名一改这里就红。
 */
function editorPathOf(index: ErbIndex, file: { path: string; text: string }) {
  return collectErbSemanticDiagnostics({ path: file.path, text: file.text }, index, {
    undefinedNames: { maxSuggestions: 0 },
  }).decorations;
}

/** 判据面：位置 + 严重度 + 码 + 文案（`message` 也算——两条路径连文案都不许分叉） */
const faceOf = (decos: readonly { line: number; startColumn?: number; endColumn?: number; severity: string; code?: string; message: string }[]) =>
  decos.map((d) => `${d.line}:${d.startColumn ?? ''}:${d.endColumn ?? ''}:${d.severity}:${d.code ?? ''}:${d.message}`);

describe('R4b · 批量任务与逐文件就地逐条等价', () => {
  it('三腿都在出（这条用例不是"空对空"）', () => {
    const face = faceOf(editorPathOf(INDEX, FILES[0]!));
    expect(face.some((f) => f.includes('ERB_ARITY_MISMATCH'))).toBe(true);
    expect(face.some((f) => f.includes('ERB_UNDEFINED_NAME'))).toBe(true);
    expect(face.some((f) => f.includes('ERB_BUILTIN_ARGS'))).toBe(true);
    // 影子函数**让位**而不是消失：`@GETTIME()` 在项目里存在 ⇒ 这一条改按用户函数判
    // （0 个形参给了 1 个实参 = 实参多给），内建签名那一路整体不判
    expect(face.some((f) => f.includes('ERB_BUILTIN_ARGS') && f.includes('GETTIME'))).toBe(false);
    expect(face.some((f) => f.includes('ERB_ARITY_MISMATCH') && f.includes('GETTIME'))).toBe(true);
  });

  it('perFile[i] 与 execute 路径逐条相等，顺序也相同（不重排、不丢空）', () => {
    const bulk = semanticDiagnosticsBulk({ ctx: buildSemanticBulkContext(INDEX), files: FILES });
    expect(bulk.perFile).toHaveLength(FILES.length);
    for (let i = 0; i < FILES.length; i++) {
      expect(faceOf(bulk.perFile[i]!)).toEqual(faceOf(editorPathOf(INDEX, FILES[i]!)));
    }
  });

  it('上下文过得了 structuredClone：往返之后结论一字不变（它真能 postMessage）', () => {
    const ctx = buildSemanticBulkContext(INDEX);
    const cloned = structuredClone(ctx);
    expect(cloned).toEqual(ctx);
    const bulk = semanticDiagnosticsBulk({ ctx: cloned, files: FILES });
    for (let i = 0; i < FILES.length; i++) {
      expect(faceOf(bulk.perFile[i]!)).toEqual(faceOf(editorPathOf(INDEX, FILES[i]!)));
    }
  });

  it('影子函数集清空 ⇒ 内建那条立刻冒出来（证明这一格真的在起作用）', () => {
    const ctx = buildSemanticBulkContext(INDEX);
    expect(ctx.shadowed).toContain('GETTIME');
    const withoutShadow = semanticDiagnosticsBulk({ ctx: { ...ctx, shadowed: [] }, files: [FILES[0]!] });
    expect(
      faceOf(withoutShadow.perFile[0]!).some((f) => f.includes('ERB_BUILTIN_ARGS') && f.includes('GETTIME')),
    ).toBe(true);
  });

  it('`ctx === null` 与 `index === null` 逐条同义（未开项目那一档）', () => {
    const bulk = semanticDiagnosticsBulk({ ctx: null, files: FILES });
    for (let i = 0; i < FILES.length; i++) {
      const expected = collectErbSemanticDiagnostics({ path: FILES[i]!.path, text: FILES[i]!.text }, null, {
        undefinedNames: { maxSuggestions: 0 },
      }).decorations;
      expect(faceOf(bulk.perFile[i]!)).toEqual(faceOf(expected));
    }
  });
});

describe('R4b · 上下文的形状与自证', () => {
  it('畸形上下文直接抛错（宿主据此回退逐文件，绝不拿残缺名录去扫）', () => {
    const ctx = buildSemanticBulkContext(INDEX);
    expect(() => semanticDiagnosticsBulk({ ctx: { ...ctx, dimsCount: ctx.dimsCount + 1 }, files: [] })).toThrow(
      /dims/,
    );
    expect(() => semanticDiagnosticsBulk({ ctx: { ...ctx, arityCount: ctx.arityCount + 1 }, files: [] })).toThrow(
      /arity/,
    );
  });

  it('同一索引只成型一次、换索引换指纹（弱表缓存 + 发号器）', () => {
    const again = buildSemanticBulkContext(INDEX);
    expect(again).toBe(buildSemanticBulkContext(INDEX));
    const other = indexOf([{ path: DECLS_PATH, text: DECLS }]);
    const otherCtx = buildSemanticBulkContext(other);
    expect(otherCtx.fp).not.toBe(buildSemanticBulkContext(INDEX).fp);
    expect(otherCtx).toEqual(otherCtx);
  });

  it('实参目录与活索引逐名同判（一次成型的快路径不许比逐名 find 更宽松）', () => {
    const ctx = buildSemanticBulkContext(INDEX);
    // 只收"多处定义一致"的名字：FUNC_TWO 有唯一签名，CALLER 零参也是合法签名
    for (const name of ['FUNC_TWO', 'CALLER', 'GETTIME']) {
      const live = arityParamsOf(INDEX, name);
      expect(live).not.toBeNull();
      expect(ctx.arityJoined.split('\n').some((l) => l.startsWith(`${name}\t`))).toBe(true);
    }
    // 反向：不存在的名字两边都"证明不了"
    expect(arityParamsOf(INDEX, 'NOT_A_FUNC')).toBeNull();
    expect(agreedParamsOf([], () => [])).toBeNull();
  });

  it('重名函数签名分歧 ⇒ 两边都判 null（同一条判据，不是各判各的）', () => {
    const two = indexOf([
      { path: 'C:/game/ERB/1.ERB', text: '@DUP(P)\n    RETURN' },
      { path: 'C:/game/ERB/2.ERB', text: '@DUP(P, Q)\n    RETURN' },
    ]);
    expect(arityParamsOf(two, 'DUP')).toBeNull();
    const ctx = buildSemanticBulkContext(two);
    expect(ctx.arityJoined.split('\n').some((l) => l.startsWith('DUP\t'))).toBe(false);
  });
});
