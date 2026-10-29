/**
 * K2-PROJECT-HOST · 2.0 项目级分析（`kojo2-project-analysis`）+ 扫描器接线 的判据闸。
 *
 * 全部走**真 core**（`lex` / `parse` / `analyzeProject` / `analyzeWeaveLayers` /
 * `planStorageSlots`），不 mock 判定：
 * - 跨文件重名 / LayerPolicy 分桶（shared-hook / overlay）/ 文件命名空间；
 * - `@织` 接管冲突、被压监听、未知事件 / 不可监听 / 优先级模型不支持的映射；
 * - 存储期同名（项目级 vs 单元级）、换盘指纹；
 * - 空项目 / 单文件 / 坏文件 / 重复注入 / 输入顺序无关；
 * - 采集器的 IO 边界（只读 2.0 源 `.kojo` / `.kojo2`、`.kojo1` 不读、允许根、
 *   开关关零动作、读炸只跳一份、上限截断）；
 * - 扫描器同一轮里"不二次读盘 + 一文件一次 publish + v1 与 2.0 合并 + 计时读数"；
 * - 万级 `@函` 的判定耗时上界（口径见该用例内注释）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { LineDecoration } from '@kojo/plugin-api';
import { lex, parse } from '@kojo/kojo-core';
import type {
  KojoDecl,
  KojoFile,
  KojoSpan,
  SlotRegistrySnapshot,
  WeaveLayerEventFact,
  WeaveLayerLayerPolicyFacts,
} from '@kojo/kojo-core';
import {
  KOJO2_PROJECT_FAILURE_CODE,
  KOJO2_PROJECT_PROBLEM_PATH,
  KOJO2_PROJECT_SOURCE,
  analyzeKojo2Project,
  collectKojo2ProjectDocuments,
  kojo2ProjectPassEnabled,
  toEditorProblem,
  type Kojo2ProjectAdapterFacts,
  type Kojo2ProjectDocument,
  type Kojo2ProjectPassOptions,
  type Kojo2ProjectTiming,
} from '../src/ui/kojo2-project-analysis';
import {
  createProjectScanner,
  type ProjectScannerDeps,
  type ScanContributor,
} from '../src/ui/project-diagnostics';
import type { EditorProblem } from '../src/ui/problem-store';

/* ============================== 夹具 ============================== */

const ROOT = 'D:/proj';
const A = `${ROOT}/a.kojo2`;
const B = `${ROOT}/b.kojo2`;
/** 封存层的 v1 文件（LAU-3b-FLIP 后它才是"非 2.0 的 kojo 源"） */
const C = `${ROOT}/c.kojo1`;
const OUTSIDE = 'D:/elsewhere/x.kojo2';

const doc = (path: string, lines: readonly string[], layerId?: string): Kojo2ProjectDocument => ({
  path,
  text: lines.join('\n'),
  ...(layerId === undefined ? {} : { layerId }),
});

/** 跨文件同名 `@函` + 同名存档变量（两份文件逐行对齐，便于断言"第二条"的落点） */
const DUP_A = doc(A, [
  '# 机 开场',
  '# 视角 我',
  '# 设 好感 整数 = 0 存档',
  '',
  '@函 共同()',
  '    @返 1',
  '',
  '# 幕 早上',
  '> 早上好。',
]);
const DUP_B = doc(B, [
  '# 机 开场',
  '# 视角 我',
  '# 设 好感 整数 = 0 存档',
  '',
  '@函 共同()',
  '    @返 2',
  '',
  '# 幕 夜里',
  '> 晚上好。',
]);

const FUNC_A = doc(A, ['@函 共同()', '    @返 1']);
const FUNC_B = doc(B, ['@函 共同()', '    @返 2']);

const TAKEOVER_A = doc(A, ['@织 回合末 接管', '    > 甲。']);
const TAKEOVER_B = doc(B, ['@织 回合末 接管', '    > 乙。']);
const LISTENER_A = doc(A, ['@织 回合末', '    > 普通监听。']);

const SHADOWED_A = doc(A, ['@织 回合末', '    > 普通监听。']);
const SHADOWED_B = doc(B, ['@织 回合末 接管', '    > 接管。']);

const codesOf = (result: ReturnType<typeof analyzeKojo2Project>): string[] =>
  result.problems.map((problem) => problem.code ?? '');

const problemsAt = (result: ReturnType<typeof analyzeKojo2Project>, path: string): EditorProblem[] =>
  result.problems.filter((problem) => problem.path === path);

const adapterOf = (
  events: readonly WeaveLayerEventFact[],
  policy: Partial<WeaveLayerLayerPolicyFacts> = {},
): Kojo2ProjectAdapterFacts => ({
  eventCatalog: { events },
  layerPolicy: {
    defaultMode: policy.defaultMode ?? 'unique',
    rules: policy.rules ?? [{ target: 'function', mode: 'unique' }],
  },
});

const BUCKET_EVENTS: readonly WeaveLayerEventFact[] = [{ event: '回合末', priority: 'emuera-buckets' }];

/* ============================== 1. 映射（toEditorProblem） ============================== */

describe('toEditorProblem · 与既有问题面板逐字段同款', () => {
  const span = (startLine: number, startColumn: number, endLine: number, endColumn: number): KojoSpan => ({
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  });

  it('码原样、source 是稳定来源标签、同行给出列区间', () => {
    expect(
      toEditorProblem(A, {
        code: 'core/decl/duplicate-name',
        severity: 'error',
        message: '重复定义',
        span: span(4, 3, 4, 9),
      }),
    ).toEqual({
      path: A,
      line: 4,
      span: { columnStart: 3, columnEnd: 9 },
      severity: 'error',
      message: '重复定义',
      code: 'core/decl/duplicate-name',
      source: KOJO2_PROJECT_SOURCE,
    });
  });

  it('warning 映射；跨行只保留行号；无 span 退到第 1 行', () => {
    const warning = toEditorProblem(A, {
      code: 'core/weave/shadowed-listener',
      severity: 'warning',
      message: '被压',
      span: span(7, 1, 7, 6),
    });
    expect(warning.severity).toBe('warning');
    expect(toEditorProblem(A, {
      code: 'core/lex/anchor',
      severity: 'error',
      message: '锚点缺失',
      span: span(2, 1, 5, 4),
    }).span).toBeUndefined();
    const noSpan = toEditorProblem(A, {
      code: 'core/storage/fingerprint-mismatch',
      severity: 'error',
      message: '换盘',
      span: null,
    });
    expect(noSpan.line).toBe(1);
    expect(noSpan.span).toBeUndefined();
  });

  it('意外 severity 按 error（fail-visible，不悄悄降成提示）', () => {
    const weird = { code: 'x/y', severity: 'info', message: 'm', span: null } as unknown as Parameters<
      typeof toEditorProblem
    >[1];
    expect(toEditorProblem(A, weird).severity).toBe('error');
  });
});

/* ============================== 2. 跨文件重名 / Layer ============================== */

describe('跨文件重名 · LayerPolicy 分桶', () => {
  it('同名 @函 在 unique 模式：一条 error，落在稳定排序后的第二处定义', () => {
    const result = analyzeKojo2Project({ documents: [DUP_A, DUP_B] });
    const duplicates = result.problems.filter((problem) => problem.code === 'core/decl/duplicate-name');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ path: B, line: 5, severity: 'error' });
    expect(duplicates[0]!.message).toContain('共同');
    expect(result.stats.documents).toBe(2);
    expect(result.stats.functions).toBe(2);
  });

  it('shared-hook：多定义合法（layerPolicy 数据驱动，不写死模式）', () => {
    const result = analyzeKojo2Project({
      documents: [FUNC_A, FUNC_B],
      adapter: adapterOf([], { rules: [{ target: 'function', mode: 'shared-hook' }] }),
    });
    expect(codesOf(result)).not.toContain('core/decl/duplicate-name');
    expect(result.stats.projectDiagnostics).toBe(0);
  });

  it('overlay：不同覆盖层各定义一次合法；同一层重复仍是 error', () => {
    const legal = analyzeKojo2Project({
      documents: [doc(A, ['@函 共同()', '    @返 1'], 'ja'), doc(B, ['@函 共同()', '    @返 2'], 'zh')],
      adapter: adapterOf([], { rules: [{ target: 'function', mode: 'overlay' }] }),
    });
    expect(codesOf(legal)).not.toContain('core/decl/duplicate-name');

    const conflict = analyzeKojo2Project({
      documents: [doc(A, ['@函 共同()', '    @返 1'], 'zh'), doc(B, ['@函 共同()', '    @返 2'], 'zh')],
      adapter: adapterOf([], { rules: [{ target: 'function', mode: 'overlay' }] }),
    });
    expect(codesOf(conflict)).toContain('core/decl/duplicate-name');
  });

  it('文件命名空间：同文件里变量与常量共用一套名字 ⇒ error', () => {
    const result = analyzeKojo2Project({
      documents: [doc(A, ['# 设 甲 整数 = 0', '# 设 甲 整数 = 1'])],
    });
    expect(codesOf(result)).toContain('core/decl/duplicate-name');
    expect(problemsAt(result, A)).toHaveLength(1);
  });
});

/* ============================== 3. @织：接管 / 被压 / 能力 ============================== */

describe('@织 · 接管与被压（adapter 缺席时退回 analyzeProject）', () => {
  const MIXED_NO_ADAPTER = doc(A, [
    '@织 回合末 接管',
    '    > 接管。',
    '@织 回合末',
    '    > 普通。',
  ]);

  it('同事件同层两枚「接管」⇒ multiple-only error，锚在第二处', () => {
    const result = analyzeKojo2Project({ documents: [TAKEOVER_A, TAKEOVER_B] });
    const conflicts = result.problems.filter((problem) => problem.code === 'core/weave/multiple-only');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: B, line: 1, severity: 'error' });
  });

  it('普通监听被同层接管压掉 ⇒ shadowed-listener warning，锚在被压的那条上', () => {
    const result = analyzeKojo2Project({ documents: [SHADOWED_A, SHADOWED_B] });
    const shadowed = result.problems.filter((problem) => problem.code === 'core/weave/shadowed-listener');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toMatchObject({ path: A, line: 1, severity: 'warning' });
    expect(shadowed[0]!.message).toContain(B);
    expect(shadowed[0]!.source).toBe(KOJO2_PROJECT_SOURCE);
  });

  it('没有 adapter 时逐块判定表为空（能力检查未跑，不猜）', () => {
    const result = analyzeKojo2Project({ documents: [MIXED_NO_ADAPTER] });
    expect(result.weaveUnits).toEqual([]);
    expect(result.stats.weaveLayers).toBe(false);
    expect(result.stats.weaveUnits).toBe(0);
  });
});

describe('@织 · adapter 注入后逐块读数（analyzeWeaveLayers 唯一口径）', () => {
  it('四类结论各就各位：takeover / shadowed；层模式按 adapter 规则读', () => {
    const result = analyzeKojo2Project({
      documents: [
        doc(A, [
          '@织 回合末 接管',
          '    > 接管。',
          '@织 回合末',
          '    > 普通。',
          '@织 回合末 之前',
          '    > 之前。',
        ]),
      ],
      adapter: adapterOf(BUCKET_EVENTS),
    });
    expect(result.stats.weaveLayers).toBe(true);
    expect(result.weaveUnits.map((unit) => `${unit.bucket}:${unit.verdict}`)).toEqual([
      'only:takeover',
      'plain:shadowed',
      'pri:shadowed',
    ]);
    expect(result.weaveUnits.every((unit) => unit.layerMode === 'unique')).toBe(true);
    expect(result.weaveUnits.every((unit) => unit.priorityModel === 'emuera-buckets')).toBe(true);
    // 被压 warning 只有一条（织面口径单一，不因 analyzeProject 也开过火而翻倍）
    expect(result.problems.filter((problem) => problem.code === 'core/weave/shadowed-listener')).toHaveLength(2);
  });

  it('未知事件 ⇒ unsupported error + 该块 blocked', () => {
    const result = analyzeKojo2Project({
      documents: [doc(A, ['@织 不存在的事件', '    > 挂上了。'])],
      adapter: adapterOf(BUCKET_EVENTS),
    });
    expect(codesOf(result)).toEqual(['core/weave/unsupported']);
    expect(result.weaveUnits[0]).toMatchObject({ verdict: 'blocked', codes: ['core/weave/unsupported'] });
  });

  it('目录声明 weavable:false ⇒ 同样阻断（挂上去运行期不会执行）', () => {
    const result = analyzeKojo2Project({
      documents: [doc(A, ['@织 回合末', '    > 挂上了。'])],
      adapter: adapterOf([{ event: '回合末', priority: 'emuera-buckets', weavable: false }]),
    });
    expect(codesOf(result)).toEqual(['core/weave/not-weavable']);
    expect(result.weaveUnits[0]).toMatchObject({ verdict: 'blocked', codes: ['core/weave/not-weavable'] });
  });

  it('优先级模型不是 emuera-buckets 时写修饰词 ⇒ unsupported', () => {
    const result = analyzeKojo2Project({
      documents: [doc(A, ['@织 回合末 之前', '    > 挂上了。'])],
      adapter: adapterOf([{ event: '回合末', priority: 'load-order' }]),
    });
    expect(codesOf(result)).toEqual(['core/weave/unsupported']);
    expect(result.weaveUnits[0]).toMatchObject({ verdict: 'blocked', codes: ['core/weave/unsupported'] });
  });

  it('adapter 在时同一条被压结论只上账一次（织面不双报）', () => {
    const result = analyzeKojo2Project({
      documents: [LISTENER_A, SHADOWED_B],
      adapter: adapterOf(BUCKET_EVENTS),
    });
    const shadowed = result.problems.filter((problem) => problem.code === 'core/weave/shadowed-listener');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toMatchObject({ path: A, line: 1, severity: 'warning' });
    expect(result.stats.layerConflicts).toBe(0);
  });
});

/* ============================== 4. 存储期 ============================== */

describe('存储期 · 项目级同名与单元级隔离', () => {
  it('两文件同名「存档」变量 ⇒ core/storage/duplicate-name，锚在第二处', () => {
    const result = analyzeKojo2Project({ documents: [DUP_A, DUP_B] });
    const storage = result.problems.filter((problem) => problem.code === 'core/storage/duplicate-name');
    expect(storage).toHaveLength(1);
    expect(storage[0]).toMatchObject({ path: B, line: 3, severity: 'error' });
    expect(result.stats.storageDeclarations).toBe(2);
    expect(result.stats.storageDiagnostics).toBeGreaterThanOrEqual(1);
  });

  it('两文件同名「场景」变量不冲突（按单元分账，跨文件互不影响）', () => {
    const result = analyzeKojo2Project({
      documents: [
        doc(A, ['# 设 心情快照 字符串 场景']),
        doc(B, ['# 设 心情快照 字符串 场景']),
      ],
    });
    expect(codesOf(result).filter((code) => code.startsWith('core/storage/'))).toEqual([]);
  });

  it('同文件两个同名存档变量 ⇒ 存储期同名 1 条（声明名字空间的那条另算）', () => {
    const result = analyzeKojo2Project({
      documents: [doc(A, ['# 设 好感 整数 = 0 存档', '# 设 好感 整数 = 1 存档'])],
    });
    expect(result.problems.filter((problem) => problem.code === 'core/storage/duplicate-name')).toHaveLength(1);
    expect(result.problems.filter((problem) => problem.code === 'core/decl/duplicate-name')).toHaveLength(1);
  });

  it('注入旧账本后换盘 ⇒ fingerprint-mismatch 落在项目级虚拟落点（不冒充某个文件）', () => {
    const previous: SlotRegistrySnapshot = { version: 1, gameFingerprint: '旧盘指纹', classes: {} };
    const result = analyzeKojo2Project({
      documents: [doc(A, ['# 设 好感 整数 = 0 存档'])],
      storage: { previousSnapshot: previous },
    });
    const failure = result.problems.find((problem) => problem.code === 'core/storage/fingerprint-mismatch');
    expect(failure).toBeDefined();
    expect(failure!.path).toBe(KOJO2_PROJECT_PROBLEM_PATH);
    expect(failure!.line).toBe(1);
  });
});

/* ============================== 5. 空 / 单文件 / 坏文件 / 顺序 ============================== */

describe('空项目 · 单文件 · 坏文件', () => {
  it('空文档集：零问题、零统计、不炸', () => {
    const result = analyzeKojo2Project({ documents: [] });
    expect(result.problems).toEqual([]);
    expect(result.weaveUnits).toEqual([]);
    expect(result.stats).toMatchObject({ documents: 0, functions: 0, problems: 0, failedDocuments: 0 });
  });

  it('单文件：只出文件内结论，没有跨文件冲突', () => {
    const result = analyzeKojo2Project({ documents: [doc(A, ['# 机 开场', '@函 独自()', '    @返 1'])] });
    expect(result.problems).toEqual([]);
    expect(result.stats.documents).toBe(1);
    expect(result.stats.functions).toBe(1);
  });

  it('解析抛错只跳该文件：其余文档照常出结论，失败本身可见', () => {
    const bad = doc(`${ROOT}/bad.kojo2`, ['炸了。']);
    const result = analyzeKojo2Project({
      documents: [bad, DUP_A, DUP_B],
      parse: (text) => {
        if (text.includes('炸')) throw new Error('解析器内部炸了');
        return parse(lex(text));
      },
    });
    expect(result.stats.failedDocuments).toBe(1);
    const failure = result.problems.find((problem) => problem.code === KOJO2_PROJECT_FAILURE_CODE);
    expect(failure).toMatchObject({ path: bad.path, severity: 'error', source: KOJO2_PROJECT_SOURCE });
    expect(failure!.message).toContain('解析器内部炸了');
    // 其余两份照常判出跨文件重名（失败的那份没有参与判定，但没把整趟带走）
    expect(result.problems.filter((problem) => problem.code === 'core/decl/duplicate-name')).toHaveLength(1);
  });

  it('语法写坏的文件不炸，且它自己的诊断被带上（未打开文件不能显示成"干净"）', () => {
    const result = analyzeKojo2Project({ documents: [doc(A, ['# 幕 晚上', '@函'])] });
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.every((problem) => (problem.code ?? '').startsWith('core/'))).toBe(true);
    expect(result.problems.every((problem) => problem.path === A)).toBe(true);
  });

  it('输入顺序无关：文档反序注入，问题序列逐条相同', () => {
    const forward = analyzeKojo2Project({ documents: [DUP_A, DUP_B] });
    const backward = analyzeKojo2Project({ documents: [DUP_B, DUP_A] });
    const key = (problem: EditorProblem) => `${problem.path}:${problem.line}:${problem.code}:${problem.severity}`;
    expect(backward.problems.map(key)).toEqual(forward.problems.map(key));
  });

  it('同一路径重复注入只算一次（身份唯一，不造出假重名）', () => {
    const once = analyzeKojo2Project({ documents: [DUP_A] });
    const twice = analyzeKojo2Project({ documents: [DUP_A, DUP_A] });
    expect(twice.stats.documents).toBe(1);
    expect(twice.stats.functions).toBe(once.stats.functions);
    expect(twice.problems).toEqual(once.problems);
  });
});

/* ============================== 6. 采集器（唯一 IO 面） ============================== */

describe('collectKojo2ProjectDocuments · IO 边界', () => {
  const textOf = `${'# 机 开场'}`;

  it('只读允许根内的 2.0 源（.kojo / .kojo2）：.kojo1 不读、根外拒读（并说出拒了几份）', async () => {
    const MODERN = `${ROOT}/d.kojo`;
    const files: Record<string, string> = {
      [A]: textOf,
      [B]: textOf,
      [MODERN]: textOf,
      [C]: textOf,
      [OUTSIDE]: textOf,
    };
    const reads: string[] = [];
    const collected = await collectKojo2ProjectDocuments({
      listFiles: () => [OUTSIDE, C, MODERN, B, A],
      roots: () => [ROOT],
      readFile: async (path) => {
        reads.push(path);
        return files[path]!;
      },
    });
    expect(collected.enabled).toBe(true);
    // `.kojo` 是 2.0 的主扩展名 ⇒ 一起读；`.kojo1` 是封存层 ⇒ 不碰。
    expect(collected.documents.map((document) => document.path)).toEqual([A, B, MODERN]);
    expect(reads).toEqual([A, B, MODERN]);
    expect(collected.stats).toMatchObject({ listed: 5, considered: 3, read: 3, outOfRoots: 1 });
  });

  it('开关关：连 listFiles 都不调（零动作）', async () => {
    const listFiles = vi.fn(() => [A]);
    const readFile = vi.fn(async () => textOf);
    const collected = await collectKojo2ProjectDocuments({
      listFiles,
      readFile,
      enabled: () => false,
      roots: () => [ROOT],
    });
    expect(collected).toEqual({
      enabled: false,
      documents: [],
      stats: { listed: 0, considered: 0, read: 0, skipped: 0, outOfRoots: 0, capped: false },
    });
    expect(listFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('读盘炸只跳该文件，点名后继续（不把整趟吞掉）', async () => {
    const skipped: string[] = [];
    const collected = await collectKojo2ProjectDocuments({
      listFiles: () => [A, B],
      roots: () => [ROOT],
      readFile: async (path) => {
        if (path === B) throw new Error('EBUSY');
        return textOf;
      },
      onSkipped: (info) => skipped.push(`${info.path}|${info.reason}`),
    });
    expect(collected.documents.map((document) => document.path)).toEqual([A]);
    expect(collected.stats).toMatchObject({ read: 1, skipped: 1 });
    expect(skipped).toEqual([`${B}|EBUSY`]);
  });

  it('上限截断发生在排序之后：清单反序也取到同一段', async () => {
    const all = [`${ROOT}/1.kojo2`, `${ROOT}/2.kojo2`, `${ROOT}/3.kojo2`, `${ROOT}/4.kojo2`];
    const run = (list: readonly string[]) =>
      collectKojo2ProjectDocuments({
        listFiles: () => list,
        roots: () => [ROOT],
        readFile: async () => textOf,
        maxFiles: 2,
      });
    const forward = await run(all);
    const backward = await run([...all].reverse());
    expect(forward.stats.capped).toBe(true);
    expect(backward.documents.map((document) => document.path)).toEqual(
      forward.documents.map((document) => document.path),
    );
  });

  it('允许根为空 ⇒ 一份都不读（fail-closed，与扫描器同一把尺子）', async () => {
    const readFile = vi.fn(async () => textOf);
    const collected = await collectKojo2ProjectDocuments({
      listFiles: () => [A],
      roots: () => [],
      readFile,
    });
    expect(collected.documents).toEqual([]);
    expect(collected.stats.outOfRoots).toBe(1);
    expect(readFile).not.toHaveBeenCalled();
  });
});

/* ============================== 7. 扫描器接线 ============================== */

const deco = (over: { line: number; message?: string }): LineDecoration => ({
  line: over.line,
  severity: 'error',
  message: over.message ?? '结构不闭合',
});

const structuralContributor: ScanContributor = {
  id: 'structure',
  decorate: ({ text }) => (text.includes('BAD') ? [deco({ line: 1 })] : []),
};

interface Harness {
  readonly scanner: ReturnType<typeof createProjectScanner>;
  readonly published: Map<string, readonly EditorProblem[]>;
  readonly reads: string[];
  readonly timings: Kojo2ProjectTiming[];
}

function harness(opts: {
  files: Record<string, string>;
  roots?: readonly string[];
  contributors?: readonly ScanContributor[];
  kojo2Project?: Kojo2ProjectPassOptions;
  maxFiles?: number;
}): Harness {
  const published = new Map<string, readonly EditorProblem[]>();
  const reads: string[] = [];
  const timings: Kojo2ProjectTiming[] = [];
  const deps: ProjectScannerDeps = {
    listFiles: () => Object.keys(opts.files),
    roots: () => opts.roots ?? [ROOT],
    project: () => null,
    contributors: () => opts.contributors ?? [structuralContributor],
    readFile: async (path) => {
      reads.push(path);
      const text = opts.files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    publish: (path, problems) => {
      published.set(path, problems);
    },
    perBatch: 8,
    maxFiles: opts.maxFiles ?? 0,
    ...(opts.kojo2Project === undefined ? {} : { kojo2Project: opts.kojo2Project }),
  };
  return { scanner: createProjectScanner(deps), published, reads, timings };
}

describe('扫描器 · .kojo2 项目级结论并进既有上账通道', () => {
  const FILES: Record<string, string> = {
    [A]: ['# 机 开场', '@函 共同()', '    @返 1', '> BAD 文本'].join('\n'),
    [B]: ['# 机 开场', '@函 共同()', '    @返 2', '> BAD 文本'].join('\n'),
    [C]: 'BAD',
  };

  it('一文件一次 publish：v1 诊断 + 落在它头上的项目级结论；`.kojo1` 维持原路', async () => {
    const h = harness({ files: FILES, kojo2Project: {} });
    const out = await h.scanner.run();
    expect(out.status).toBe('complete');
    expect(out).toMatchObject({ scanned: 3, published: 3, skipped: 0 });
    // .kojo 只有 v1 那一条；.kojo2 的文件 A 只有 v1；文件 B 多出跨文件重名
    expect(h.published.get(C)).toHaveLength(1);
    expect(h.published.get(A)).toHaveLength(1);
    expect(h.published.get(B)?.map((problem) => problem.code)).toEqual([
      undefined,
      'core/decl/duplicate-name',
    ]);
    // 同一轮只读一次盘（分析复用这份文本，不二次读）
    expect(h.reads.slice().sort()).toEqual([A, B, C].sort());
    expect(out.kojo2).not.toBeNull();
    expect(out.kojo2!.documents).toBe(2);
    expect(out.kojo2!.functions).toBe(2);
    expect(out.kojo2!.problems).toBe(1);
  });

  it('onTiming 收到读数；来源标签是项目级（与实时那一簇区分）', async () => {
    const timings: Kojo2ProjectTiming[] = [];
    const h = harness({ files: FILES, kojo2Project: { onTiming: (timing) => timings.push(timing) } });
    const out = await h.scanner.run();
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ parseMs: expect.any(Number), analyzeMs: expect.any(Number) });
    const projectProblem = (h.published.get(B) ?? []).find(
      (problem) => problem.code === 'core/decl/duplicate-name',
    );
    expect(projectProblem?.source).toBe(KOJO2_PROJECT_SOURCE);
    expect(out.kojo2!.timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('开关关：`.kojo2` 走 v1 原路（publish 立即发生一次、判据点一次都不调）', async () => {
    const isKojo2 = vi.fn(() => true);
    const timings: Kojo2ProjectTiming[] = [];
    const h = harness({
      files: FILES,
      kojo2Project: { enabled: () => false, isKojo2, onTiming: (timing) => timings.push(timing) },
    });
    const out = await h.scanner.run();
    expect(isKojo2).not.toHaveBeenCalled();
    expect(timings).toEqual([]);
    expect(out.kojo2).toBeNull();
    expect(h.published.get(B)).toHaveLength(1);
    expect(h.published.get(B)![0]!.code).toBeUndefined();
  });

  it('本轮没有 2.0 文件 ⇒ 分析不跑、读数保持 null（"没这一步"不等于"跑了没结论"）', async () => {
    const timings: Kojo2ProjectTiming[] = [];
    const h = harness({ files: { [C]: 'BAD' }, kojo2Project: { onTiming: (timing) => timings.push(timing) } });
    const out = await h.scanner.run();
    expect(out.kojo2).toBeNull();
    expect(timings).toEqual([]);
    expect(h.published.get(C)).toHaveLength(1);
  });

  it('分析炸了整轮不崩：v1 结果照旧上账，但"少了一路"要点名', async () => {
    const files: Record<string, string> = {
      [A]: ['# 机 开场', '# 设 好感 整数 = 0 存档', '> BAD'].join('\n'),
      [B]: ['# 机 开场', '# 设 好感 整数 = 0 存档', '> BAD'].join('\n'),
    };
    const h = harness({
      files,
      kojo2Project: {
        storage: {
          declarationKey: () => {
            throw new Error('键账本炸了');
          },
        },
      },
    });
    const out = await h.scanner.run();
    expect(out.status).toBe('complete');
    expect(out.kojo2).toBeNull();
    expect(out.degraded).toBe(2);
    expect(out.errors[0]!.path).toBe('(kojo2 项目级分析)');
    expect(out.errors[0]!.reason).toContain('键账本炸了');
    expect(h.published.get(A)).toHaveLength(1);
    expect(h.published.get(B)).toHaveLength(1);
  });
});

/* ============================== 8. 装配判据 ============================== */

describe('kojo2ProjectPassEnabled', () => {
  it('未装配 = false；给了对象 = true；enabled() 是否决权（不是缺席权的替代）', () => {
    expect(kojo2ProjectPassEnabled(undefined)).toBe(false);
    expect(kojo2ProjectPassEnabled({})).toBe(true);
    expect(kojo2ProjectPassEnabled({ enabled: () => true })).toBe(true);
    expect(kojo2ProjectPassEnabled({ enabled: () => false })).toBe(false);
  });
});

/* ============================== 9. 性能上界 ============================== */

describe('万级 @函 的判定耗时', () => {
  const DOC_COUNT = 200;
  const FUNCS_PER_DOC = 50;
  const TOTAL = DOC_COUNT * FUNCS_PER_DOC; // 10,000
  const UNIQUE = 8_000;

  const spanOf = (line: number): KojoSpan => ({
    start: { line, column: 1 },
    end: { line, column: 2 },
  });

  const files: KojoFile[] = Array.from({ length: DOC_COUNT }, (_, docIndex) => {
    const decls: KojoDecl[] = [];
    for (let i = 0; i < FUNCS_PER_DOC; i++) {
      const global = docIndex * FUNCS_PER_DOC + i;
      // 8,000 个唯一名 + 1,000 组重名对（每组两条）⇒ 恰好 10,000 条定义，冲突路径真被走到
      const name = global < UNIQUE ? `唯一_${global}` : `重名_${Math.floor((global - UNIQUE) / 2)}`;
      decls.push({
        kind: 'function',
        name,
        params: [],
        body: [],
        span: spanOf(i + 1),
      });
    }
    return { decls, scenes: [], diagnostics: [] };
  });

  const documents: Kojo2ProjectDocument[] = Array.from({ length: DOC_COUNT }, (_, docIndex) => ({
    path: `${ROOT}/perf-${docIndex}.kojo2`,
    text: String(docIndex),
  }));

  /** 解析走恒等桩：本节量的是**判定 + 映射**（口径见断言消息），词法/解析不计入 */
  const stubParse = (text: string): KojoFile => files[Number(text)]!;

  it(`${TOTAL} 个 @函（解析桩）判定中位数 ≤ 100ms（打印读数）`, () => {
    const input = { documents, parse: stubParse };
    analyzeKojo2Project(input);
    analyzeKojo2Project(input); // 预热（JIT / Map 分配），不计入读数

    const samples: number[] = [];
    let diagnostics = 0;
    for (let i = 0; i < 5; i++) {
      const result = analyzeKojo2Project(input);
      samples.push(result.stats.timing.analyzeMs);
      diagnostics = result.stats.problems;
    }
    samples.sort((a, b) => a - b);
    const min = samples[0]!;
    const median = samples[2]!;
    const max = samples[samples.length - 1]!;
    // eslint-disable-next-line no-console
    console.log(
      `[bench] kojo2-project-analysis ${TOTAL} @函 / ${DOC_COUNT} 文件：` +
        `min ${min.toFixed(2)}ms · median ${median.toFixed(2)}ms · max ${max.toFixed(2)}ms` +
        `（上界 100ms；问题 ${diagnostics} 条；口径：AST 已解析（parse 注入恒等桩），只计判定 + 映射）`,
    );
    expect(diagnostics).toBeGreaterThan(0);
    expect(median).toBeLessThanOrEqual(100);
  });
});
