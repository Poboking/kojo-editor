/**
 * 项目级分析（`project/analysis.ts`）单测——按任务契约逐条钉：
 *
 * 1) 重名函数三桶（unique / shared-hook / overlay）+ 真冲突 error；
 * 2) `@织` 同事件同层多接管 error、被压监听 warning 并列出接管者、跨层合法；
 * 3) 修饰词冲突 / 未知事件 / 缺优先级模型；
 * 4) 文件命名空间重名（声明×声明、声明×函数；函数×函数不双报）；
 * 5) 返回路径事实（混用 / 缺返回）；
 * 6) 输出确定性：打乱注入顺序结果逐字节相同。
 */
import { describe, expect, it } from 'vitest';

import type { KojoFile, KojoSpan, KojoWeaveModifier } from '../src/ast';
import {
  analyzeProject,
  collectFileFacts,
  type EventCatalogFacts,
  type FunctionReturnFact,
  type LayerPolicyFacts,
  type ProjectAnalysisInput,
  type ProjectDeclarationFact,
  type ProjectFunctionFact,
  type ProjectWeaveFact,
} from '../src/project/analysis';

/* ============================== 事实构造器 ============================== */

const sp = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 1 },
});

const fnFact = (name: string, filePath = 'a.kojo', line = 1, layerId?: string): ProjectFunctionFact => ({
  name,
  filePath,
  span: sp(line),
  ...(layerId !== undefined ? { layerId } : {}),
});

const weaveFact = (
  event: string,
  modifiers: readonly KojoWeaveModifier[],
  filePath = 'a.kojo',
  line = 1,
  layerId?: string,
): ProjectWeaveFact => ({
  event,
  modifiers,
  filePath,
  span: sp(line),
  ...(layerId !== undefined ? { layerId } : {}),
});

const declFact = (
  name: string,
  kind: ProjectDeclarationFact['kind'] = 'var',
  filePath = 'a.kojo',
  line = 1,
): ProjectDeclarationFact => ({ name, kind, filePath, span: sp(line) });

const returnFact = (
  name: string,
  opts: { value: boolean; bare: boolean; allPaths: boolean },
  filePath = 'a.kojo',
  line = 1,
): FunctionReturnFact => ({
  name,
  filePath,
  span: sp(line),
  hasValueReturn: opts.value,
  hasBareReturn: opts.bare,
  allPathsReturn: opts.allPaths,
});

const EVENTS: EventCatalogFacts = { names: ['回合末', '清晨'], priorityModel: 'emuera-buckets' };

const codes = (input: ProjectAnalysisInput): string[] => analyzeProject(input).diagnostics.map((d) => d.code);

/* ============================== 1. 重名函数三桶 ============================== */

describe('重名函数 · LayerPolicy 三桶', () => {
  it('unique（缺省）：跨文件同名 → unique 桶 + conflict + 一条 duplicate-name error（指向后一处）', () => {
    const result = analyzeProject({
      functions: [fnFact('问候', 'a.kojo', 3), fnFact('问候', 'b.kojo', 7)],
    });
    expect(result.functionBuckets.unique).toHaveLength(1);
    const group = result.functionBuckets.unique[0]!;
    expect(group.name).toBe('问候');
    expect(group.bucket).toBe('unique');
    expect(group.conflict).toBe(true);
    expect(group.definitions.map((d) => d.filePath)).toEqual(['a.kojo', 'b.kojo']);
    expect(result.diagnostics).toHaveLength(1);
    const diag = result.diagnostics[0]!;
    expect(diag.code).toBe('core/decl/duplicate-name');
    expect(diag.severity).toBe('error');
    expect(diag.span?.start.line).toBe(7); // 报在后一处，可点回源行
    expect(diag.message).toContain('b.kojo:7:1');
    expect(diag.message).toContain('a.kojo:3:1');
    expect(result.stats.functionConflicts).toBe(1);
    expect(result.stats.duplicateFunctionNames).toBe(1);
  });

  it('shared-hook：多定义合法（不报诊断、进 shared-hook 桶）', () => {
    const policy: LayerPolicyFacts = { mode: 'shared-hook' };
    const result = analyzeProject({
      functions: [fnFact('EVENTTRAIN', 'a.kojo', 1), fnFact('EVENTTRAIN', 'b.kojo', 2), fnFact('独有', 'a.kojo', 9)],
      policy,
    });
    expect(result.functionBuckets.sharedHook.map((g) => g.name)).toEqual(['EVENTTRAIN']);
    expect(result.functionBuckets.sharedHook[0]!.conflict).toBe(false);
    expect(result.functionBuckets.unique.map((g) => g.name)).toEqual(['独有']);
    expect(result.diagnostics).toEqual([]);
  });

  it('byName / sharedHooks 覆盖全局 mode（byName 优先）', () => {
    const policy: LayerPolicyFacts = {
      mode: 'unique',
      sharedHooks: new Set(['共享']),
      byName: new Map([['覆盖', 'shared-hook']]),
    };
    const result = analyzeProject({
      functions: [
        fnFact('共享', 'a.kojo', 1),
        fnFact('共享', 'b.kojo', 1),
        fnFact('覆盖', 'a.kojo', 2),
        fnFact('覆盖', 'b.kojo', 2),
        fnFact('冲突', 'a.kojo', 3),
        fnFact('冲突', 'b.kojo', 3),
      ],
      policy,
    });
    expect(result.functionBuckets.sharedHook.map((g) => g.name)).toEqual(['共享', '覆盖']);
    expect(result.functionBuckets.unique.find((g) => g.name === '冲突')!.conflict).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/decl/duplicate-name']);
  });

  it('overlay：不同覆盖层各定义一次合法（进 overlay 桶、无诊断）', () => {
    const policy: LayerPolicyFacts = { mode: 'overlay' };
    const result = analyzeProject({
      functions: [fnFact('问候', 'base.kojo', 1), fnFact('问候', 'zh.kojo', 4, 'zh')],
      policy,
    });
    expect(result.functionBuckets.overlay).toHaveLength(1);
    expect(result.functionBuckets.overlay[0]!.conflict).toBe(false);
    expect(result.functionBuckets.overlay[0]!.definitions).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });

  it('overlay：同一覆盖层重复定义 → 真冲突 error', () => {
    const policy: LayerPolicyFacts = { mode: 'overlay' };
    const result = analyzeProject({
      functions: [fnFact('问候', 'base.kojo', 1), fnFact('问候', 'zh1.kojo', 2, 'zh'), fnFact('问候', 'zh2.kojo', 3, 'zh')],
      policy,
    });
    expect(result.functionBuckets.overlay[0]!.conflict).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/decl/duplicate-name']);
    expect(result.diagnostics[0]!.message).toContain('覆盖层「zh」');
  });

  it('单定义恒进 unique 桶（与 policy 无关）', () => {
    for (const mode of ['unique', 'shared-hook', 'overlay'] as const) {
      const result = analyzeProject({ functions: [fnFact('独有')], policy: { mode } });
      expect(result.functionBuckets.unique.map((g) => g.name)).toEqual(['独有']);
      expect(result.functionBuckets.unique[0]!.conflict).toBe(false);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('组内定义稳定排序（按文件路径 → span），与注入顺序无关', () => {
    const result = analyzeProject({
      functions: [fnFact('X', 'z.kojo', 9), fnFact('X', 'a.kojo', 5), fnFact('X', 'a.kojo', 2)],
    });
    expect(result.functionBuckets.unique[0]!.definitions.map((d) => `${d.filePath}:${d.span!.start.line}`)).toEqual([
      'a.kojo:2',
      'a.kojo:5',
      'z.kojo:9',
    ]);
  });
});

/* ============================== 2. @织：接管 / 压盖 ============================== */

describe('@织 · 接管与压盖', () => {
  it('同事件同层多「接管」→ multiple-only error（指向后一个，列出全部接管者）', () => {
    const result = analyzeProject({
      weaves: [weaveFact('回合末', ['only'], 'a.kojo', 1), weaveFact('回合末', ['only'], 'a.kojo', 2)],
      events: EVENTS,
    });
    const multiple = result.diagnostics.filter((d) => d.code === 'core/weave/multiple-only');
    expect(multiple).toHaveLength(1);
    expect(multiple[0]!.severity).toBe('error');
    expect(multiple[0]!.span?.start.line).toBe(2);
    expect(multiple[0]!.message).toContain('a.kojo:1:1');
    expect(multiple[0]!.message).toContain('a.kojo:2:1');
  });

  it('单个「接管」压掉同层普通监听 → shadowed-listener warning 且列出接管者', () => {
    const result = analyzeProject({
      weaves: [weaveFact('回合末', ['only'], 'take.kojo', 5), weaveFact('回合末', [], 'listen.kojo', 9)],
      events: EVENTS,
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/weave/shadowed-listener']);
    const warning = result.diagnostics[0]!;
    expect(warning.severity).toBe('warning');
    expect(warning.span?.start.line).toBe(9);
    expect(warning.message).toContain('take.kojo:5:1');
    expect(result.shadowed).toHaveLength(1);
    expect(result.shadowed[0]!.takeovers.map((t) => t.filePath)).toEqual(['take.kojo']);
    expect(result.takeoverGroups).toHaveLength(1);
    expect(result.takeoverGroups[0]!.event).toBe('回合末');
    expect(result.takeoverGroups[0]!.layers).toEqual(['']);
  });

  it('不同 overlay 层的接管互不压盖，但全部接管者在 takeoverGroups 里可见', () => {
    const result = analyzeProject({
      weaves: [
        weaveFact('回合末', ['only'], 'base.kojo', 1),
        weaveFact('回合末', [], 'base-listen.kojo', 2),
        weaveFact('回合末', ['only'], 'zh.kojo', 3, 'zh'),
      ],
      events: EVENTS,
    });
    expect(result.takeoverGroups).toHaveLength(1);
    expect(result.takeoverGroups[0]!.takeovers).toHaveLength(2);
    expect(result.takeoverGroups[0]!.layers).toEqual(['', 'zh']);
    // 只有基座层的普通监听被压；覆盖层没有普通监听 ⇒ 1 条 warning
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/weave/shadowed-listener']);
    expect(result.shadowed[0]!.listener.filePath).toBe('base-listen.kojo');
  });

  it('修饰词冲突：并用 / 重复 → modifier-conflict，且不参与接管推理（不追加假 warning）', () => {
    const result = analyzeProject({
      weaves: [weaveFact('回合末', ['only', 'later'], 'a.kojo', 1), weaveFact('回合末', [], 'a.kojo', 2)],
      events: EVENTS,
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/weave/modifier-conflict']);
    expect(result.shadowed).toEqual([]);
    expect(result.takeoverGroups).toEqual([]);
  });

  it('未知事件 → weave/unsupported error（不做不猜的接管分析）', () => {
    const result = analyzeProject({
      weaves: [weaveFact('不存在的事件', ['only'], 'a.kojo', 1)],
      events: EVENTS,
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/weave/unsupported']);
    expect(result.takeoverGroups).toEqual([]);
  });

  it('adapter 未声明 emuera-buckets 时写修饰词 → weave/unsupported error', () => {
    const result = analyzeProject({
      weaves: [weaveFact('回合末', ['later'], 'a.kojo', 1)],
      events: { names: ['回合末'], priorityModel: 'none' },
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/weave/unsupported']);
    expect(result.diagnostics[0]!.message).toContain('emuera-buckets');
  });

  it('无事件目录事实（events 缺席）⇒ 不判未知事件、不判优先级模型（不猜）', () => {
    const result = analyzeProject({ weaves: [weaveFact('任意', ['only'], 'a.kojo', 1)] });
    expect(result.diagnostics).toEqual([]);
    expect(result.takeoverGroups).toHaveLength(1);
  });
});

/* ============================== 3. 文件命名空间 ============================== */

describe('声明 · 文件命名空间重名', () => {
  it('同一文件两条声明同名 → error（跨文件同名合法）', () => {
    const result = analyzeProject({
      declarations: [declFact('计数', 'var', 'a.kojo', 1), declFact('计数', 'const', 'a.kojo', 2), declFact('计数', 'var', 'b.kojo', 1)],
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/decl/duplicate-name']);
    expect(result.diagnostics[0]!.span?.start.line).toBe(2);
    expect(result.declarationDuplicates).toHaveLength(1);
    expect(result.declarationDuplicates[0]!.declarations).toHaveLength(2);
    expect(result.declarationDuplicates[0]!.functions).toHaveLength(0);
  });

  it('同文件「变量 × 函数」同名 → error（共用一套名字空间）', () => {
    const result = analyzeProject({
      declarations: [declFact('问候', 'var', 'a.kojo', 1)],
      functions: [fnFact('问候', 'a.kojo', 2)],
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/decl/duplicate-name']);
    expect(result.diagnostics[0]!.span?.start.line).toBe(2);
    expect(result.diagnostics[0]!.message).toContain('文件内命名空间重名');
  });

  it('同文件两条同名函数只由 Layer 判定报一次（不双报）', () => {
    const result = analyzeProject({
      functions: [fnFact('问候', 'a.kojo', 1), fnFact('问候', 'a.kojo', 2)],
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('core/decl/duplicate-name');
  });
});

/* ============================== 4. 返回路径（只吃事实） ============================== */

describe('@函 返回路径 · 保守检查', () => {
  it('带值 + 无值 @返 混用 → return-mixed error', () => {
    const result = analyzeProject({ returns: [returnFact('算', { value: true, bare: true, allPaths: true })] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/func/return-mixed']);
    expect(result.functionReturns[0]!.mixed).toBe(true);
  });

  it('非 void 但并非所有路径都以 @返 结束 → missing-return error', () => {
    const result = analyzeProject({ returns: [returnFact('算', { value: true, bare: false, allPaths: false })] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/func/missing-return']);
    expect(result.functionReturns[0]!.returnsValue).toBe(true);
    expect(result.functionReturns[0]!.missingReturn).toBe(true);
  });

  it('非 void 且已证明全路径返回 → 无诊断；void 不要求全路径返回', () => {
    const result = analyzeProject({
      returns: [
        returnFact('值', { value: true, bare: false, allPaths: true }),
        returnFact('过程', { value: false, bare: true, allPaths: false }),
        returnFact('空', { value: false, bare: false, allPaths: false }),
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.functionReturns.map((check) => check.name)).toEqual(['值', '过程', '空']);
  });

  it('同一函数重复注入 → 只判一次（不双报）', () => {
    const fact = returnFact('算', { value: true, bare: true, allPaths: true });
    const result = analyzeProject({ returns: [fact, fact] });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.functionReturns).toHaveLength(1);
  });
});

/* ============================== 5. 确定性 ============================== */

describe('输出确定性', () => {
  const base: ProjectAnalysisInput = {
    functions: [
      fnFact('B', 'b.kojo', 2),
      fnFact('B', 'a.kojo', 1),
      fnFact('A', 'a.kojo', 3),
      fnFact('问候', 'a.kojo', 4),
      fnFact('问候', 'a.kojo', 5),
    ],
    declarations: [declFact('X', 'var', 'a.kojo', 1), declFact('X', 'const', 'a.kojo', 2)],
    weaves: [
      weaveFact('回合末', ['only'], 'b.kojo', 1),
      weaveFact('回合末', [], 'a.kojo', 2),
      weaveFact('清晨', ['later'], 'a.kojo', 3),
    ],
    returns: [returnFact('R', { value: true, bare: true, allPaths: true }, 'a.kojo', 1)],
    events: EVENTS,
    policy: { mode: 'unique' },
  };

  const reverse = <T>(items: readonly T[]): T[] => [...items].reverse();

  it('打乱注入顺序 ⇒ 结果逐字节相同（分桶/诊断/顺序全稳定）', () => {
    const one = analyzeProject(base);
    const two = analyzeProject({
      ...base,
      functions: reverse(base.functions!),
      declarations: reverse(base.declarations!),
      weaves: reverse(base.weaves!),
      returns: reverse(base.returns!),
    });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});

/* ============================== 6. AST 事实采集 ============================== */

describe('collectFileFacts · 从 KojoFile 采集项目事实', () => {
  const file: KojoFile = {
    decls: [
      { kind: 'function', name: '问候', params: [], body: [], span: sp(10) },
      { kind: 'weave', event: '回合末', args: [], modifiers: ['only'], body: [], span: sp(20) },
      { kind: 'var', name: '计数', valueType: 'int', storage: 'save', span: sp(30) },
      { kind: 'const', name: '上限', valueType: 'int', value: 10, span: sp(31) },
      { kind: 'table', name: '档位', subject: { text: '恋慕', span: sp(32) }, rows: [], span: sp(32) },
      { kind: 'pool', name: '问候池', branches: [], span: sp(33) },
      { kind: 'template', name: '娇羞', params: [], body: [], slotIndex: null, span: sp(34) },
      { kind: 'view', target: '{我}', span: sp(35) },
      { kind: 'machine', event: '指令', args: ['310'], span: sp(36) },
    ],
    scenes: [],
    diagnostics: [],
  };

  it('函数 / @织 / 声明分别归位；view/machine 不进项目事实', () => {
    const facts = collectFileFacts(file, 'a.kojo', 'zh');
    expect(facts.functions).toEqual([{ name: '问候', filePath: 'a.kojo', span: sp(10), layerId: 'zh' }]);
    expect(facts.weaves).toEqual([
      { event: '回合末', modifiers: ['only'], filePath: 'a.kojo', span: sp(20), layerId: 'zh' },
    ]);
    expect(facts.declarations.map((decl) => `${decl.kind}:${decl.name}`)).toEqual([
      'var:计数',
      'const:上限',
      'table:档位',
      'pool:问候池',
      'template:娇羞',
    ]);
  });

  it('采集结果可直接喂 analyzeProject（无层覆盖时 layerId 不出现）', () => {
    const facts = collectFileFacts(file, 'a.kojo');
    expect(facts.functions[0]!.layerId).toBeUndefined();
    const result = analyzeProject({ ...facts, weaves: [], events: EVENTS });
    expect(result.stats.functionDefinitions).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });
});

/* ============================== 7. 统计口径 ============================== */

describe('stats', () => {
  it('计数与分桶一致', () => {
    const result = analyzeProject({
      functions: [fnFact('A'), fnFact('B', 'a.kojo', 1), fnFact('B', 'b.kojo', 1), fnFact('C', 'a.kojo', 1), fnFact('C', 'b.kojo', 1)],
      weaves: [weaveFact('回合末', ['only'], 'a.kojo', 1), weaveFact('回合末', [], 'a.kojo', 2)],
      events: EVENTS,
    });
    expect(result.stats.functionDefinitions).toBe(5);
    expect(result.stats.uniqueFunctionNames).toBe(1); // A
    expect(result.stats.duplicateFunctionNames).toBe(2); // B / C
    expect(result.stats.functionConflicts).toBe(2);
    expect(result.stats.weaves).toBe(2);
    expect(result.stats.takeoverGroups).toBe(1);
    expect(result.stats.shadowedListeners).toBe(1);
    expect(result.stats.diagnostics).toBe(result.diagnostics.length);
    expect(codes({ functions: [fnFact('A')] })).toEqual([]);
  });
});
