/**
 * Kojo 2.0 项目级 Application Service 单测（`kojo2-project-service.ts`）。
 *
 * 用**真 eraTW 编译事实**（adapter / registry / backend / selectors / capability /
 * sourceMapPolicy）跑真 core 编译，只把「快照端口」（load / compileLegacy / 导出）换成
 * 内存假件——钉的是 Service 自己的语义：
 * 1. 编译成功 → phase/result/plan/assembly/stats/可发布性与 bundle 文本；
 * 2. 单条快照缓存（cacheHit / compile 次数）与文档变化失效；
 * 3. 世代：换项目时旧 load 的迟到结果被丢弃；
 * 4. 失败保留 lastGood、诊断可见（不静默）；
 * 5. markStale 只标脏、不重编译；
 * 6. 四类 core 诊断 → `Kojo2ProjectProblem` 的 channel/code/path 映射
 *    （duplicate / ambiguous / legacy 跳过 / assembly legacy-missing）；
 * 7. legacy `# 机` 字节必须由 Host 端口补：补上 = complete，补不上 = 可见缺失；
 * 8. publish 门禁、导出取消、runtime preview、reset/dispose。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  compileProject,
  type ProjectCompileInput,
  type ProjectCompileResult,
  type RuntimeSelectionRequest,
} from '@kojo/kojo-core';
import type { GameProject } from '@kojo/plugin-api';
import {
  createEratwEmitBackend,
  ERATW_CAPABILITY,
  ERATW_DISPATCH_SELECTORS,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '@kojo/plugin-eratw-adapter';
import { createKojo2ProjectService } from '../src/ui/kojo2-project-service';
import type {
  Kojo2CompileBundle,
  Kojo2ProjectService,
  Kojo2ProjectServiceDeps,
  Kojo2ProjectSnapshot,
} from '../src/ui/kojo2-project-service-contract';

/* ============================== 夹具 ============================== */

const PROJECT: GameProject = {
  rootDir: 'D:/p',
  adapterId: 'eratw',
  kojoPaths: ['D:/p/kojo'],
  writablePaths: [],
  charaIndex: new Map([[12, { no: 12, name: '角色', kojoDir: 'D:/p/kojo/12' }]]),
};

/** 组合根登记面同款的 eraTW 2.0 编译事实。 */
const COMPILE_BUNDLE: Kojo2CompileBundle = {
  adapterId: ERATW_GAME_ADAPTER.id,
  adapter: ERATW_GAME_ADAPTER,
  registry: ERATW_TARGET_REGISTRY,
  gameFingerprint: ERATW_GAME_ADAPTER.gameFingerprint,
  createBackend: (deps) =>
    createEratwEmitBackend({
      compileExpression: deps.compileExpression,
      ...(deps.charNo === undefined ? {} : { charNo: deps.charNo }),
      ...(deps.familySegment === undefined ? {} : { familySegment: deps.familySegment }),
    }),
  dispatchSelectors: ERATW_DISPATCH_SELECTORS,
  capability: ERATW_CAPABILITY,
  sourceMapPolicy: ERATW_SOURCE_MAP,
};

interface TestDocument {
  readonly path: string;
  readonly text: string;
  readonly layerId?: string;
}

const SHRINE_DOC: TestDocument = {
  path: 'D:/p/kojo/12/a.kojo2',
  text: '【剧场：初见｜神社】\n# 视角 灵梦\n> 甲\n',
};
const SCHOOL_DOC: TestDocument = {
  path: 'D:/p/kojo/12/b.kojo2',
  text: '【剧场：初见｜学校】\n# 视角 灵梦\n> 乙\n',
};
const SCHOOL_NIGHT_DOC: TestDocument = {
  path: 'D:/p/kojo/12/c.kojo2',
  text: '【剧场：初见｜学校｜夜】\n# 视角 灵梦\n> 丙\n',
};
const SINGLE_DOC: TestDocument = {
  path: 'D:/p/kojo/12/single.kojo2',
  text: '【剧场：初见】\n# 视角 灵梦\n> 单文件\n',
};
const LEGACY_DOC: TestDocument = {
  path: 'D:/p/kojo/12/legacy.kojo2',
  text: '# 机 指令 310\n# 视角 灵梦\n> 旧正文\n',
};
const LEGACY_ERB = '@M_KOJO_K12_指令_310\nMACHINE 指令 310\n';
const DEFAULT_LEGACY_ERB = (): string => LEGACY_ERB;

function makeSnapshot(
  options: {
    readonly projectId?: string;
    readonly documents?: readonly TestDocument[];
    readonly compileLegacy?: (document: TestDocument) => string | null;
  } = {},
): Kojo2ProjectSnapshot {
  return {
    projectId: options.projectId ?? 'p1',
    project: PROJECT,
    documents: options.documents ?? [],
    bundle: COMPILE_BUNDLE,
    contextOf: () => ({ charNo: '12', familySegment: '' }),
    compileLegacy: options.compileLegacy ?? DEFAULT_LEGACY_ERB,
  };
}

function makeService(
  load: () => Promise<Kojo2ProjectSnapshot | null>,
  overrides: Partial<Kojo2ProjectServiceDeps> = {},
): Kojo2ProjectService {
  return createKojo2ProjectService({
    load,
    exportArtifact: async () => 'D:/out/kojo2-project.ERB',
    ...overrides,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

/* ============================== 编译成功 ============================== */

describe('refresh · 编译成功', () => {
  it('多文件：phase ready、result/plan/assembly 齐、stats 与 bundle 读数对', async () => {
    const service = makeService(async () =>
      makeSnapshot({ documents: [SHRINE_DOC, SCHOOL_DOC, SCHOOL_NIGHT_DOC] }),
    );

    const state = await service.refresh('open');
    expect(state.phase).toBe('ready');
    expect(state.projectId).toBe('p1');
    expect(state.result?.build.buildStatus).toBe('succeeded');
    expect(state.result?.dispatchErb).toHaveLength(1);
    expect(state.plan?.status).toBe('ready');
    expect(state.plan?.legacyFiles).toEqual([]);
    expect(state.assembly?.status).toBe('complete');
    expect(state.stats).toEqual({
      documentCount: 3,
      theaterCount: 3,
      groupCount: 1,
      compileMs: expect.any(Number),
      assemblyMs: expect.any(Number),
      cacheHit: false,
    });
    expect(state.stats.compileMs).toBeGreaterThanOrEqual(0);
    expect(state.stats.assemblyMs).toBeGreaterThanOrEqual(0);
    // 无诊断 ⇒ 可发布；状态对象不可变。
    expect(state.problems).toEqual([]);
    expect(state.publishable).toBe(true);
    expect(state.publishBlockReason).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);

    const bundle = service.publishBundle();
    expect(bundle).not.toBeNull();
    expect(bundle?.fileName).toBe('kojo2-project.ERB');
    expect(bundle?.unitCount).toBe(1);
    expect(bundle?.text).toContain('M_KOJO_ENCOUNTER_K12');
    expect(bundle?.text.endsWith('\n')).toBe(true);
  });

  it('单文件：无 legacy 时 assembly complete、可发布', async () => {
    const service = makeService(async () => makeSnapshot({ documents: [SINGLE_DOC] }));

    const state = await service.refresh('open');
    expect(state.phase).toBe('ready');
    expect(state.plan?.previewOnlyTheaterCount).toBe(1);
    expect(state.assembly?.status).toBe('complete');
    expect(service.publishBundle()?.unitCount).toBe(1);
    expect(state.publishable).toBe(true);
  });

  it('编译输入接线：requireDispatch=true、emitDiagnosticArtifacts=true、provenance 从 bundle 派生', async () => {
    const compile = vi.fn(
      (input: ProjectCompileInput): ProjectCompileResult => compileProject(input),
    );
    const service = makeService(async () => makeSnapshot({ documents: [SINGLE_DOC] }), {
      compile,
    });

    await service.refresh('open');
    expect(compile).toHaveBeenCalledTimes(1);
    const input = compile.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    expect(input?.requireDispatch).toBe(true);
    expect(input?.emitDiagnosticArtifacts).toBe(true);
    expect(input?.dispatchSelectors).toBe(ERATW_DISPATCH_SELECTORS);
    expect(input?.provenance.adapterId).toBe(ERATW_GAME_ADAPTER.id);
    expect(input?.provenance.adapterVersion).toBe(ERATW_GAME_ADAPTER.version);
    expect(input?.provenance.targetRegistryId).toBe(ERATW_TARGET_REGISTRY.registryId);
    expect(input?.provenance.backendId).toBe('eratw');
    expect(input?.provenance.backendVersion).toBe('1');
    expect(input?.files).toHaveLength(1);
    expect(input?.files[0]?.functionNameContext).toEqual({ charNo: '12', familySegment: '' });
  });
});

/* ============================== 缓存 / 世代 ============================== */

describe('refresh · 快照缓存与世代', () => {
  it('同快照第二次 refresh：cacheHit=true、compile 不重跑、复用 result/plan/assembly', async () => {
    const compile = vi.fn(
      (input: ProjectCompileInput): ProjectCompileResult => compileProject(input),
    );
    const snapshot = makeSnapshot({ documents: [SHRINE_DOC, SCHOOL_DOC, SCHOOL_NIGHT_DOC] });
    const service = makeService(async () => snapshot, { compile });

    const first = await service.refresh('open');
    expect(first.stats.cacheHit).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);

    const second = await service.refresh('manual');
    expect(second.stats.cacheHit).toBe(true);
    expect(second.stats.compileMs).toBe(0);
    expect(compile).toHaveBeenCalledTimes(1);
    // 缓存命中复用同一份结果 / 计划 / 组装对象，而不是重编译出等价副本。
    expect(second.result).toBe(first.result);
    expect(second.plan).toBe(first.plan);
    expect(second.assembly).toBe(first.assembly);
    expect(second.phase).toBe('ready');
  });

  it('文档内容或顺序变化 ⇒ 缓存失效、重新编译', async () => {
    const compile = vi.fn(
      (input: ProjectCompileInput): ProjectCompileResult => compileProject(input),
    );
    let current = makeSnapshot({ documents: [SINGLE_DOC, SHRINE_DOC] });
    const service = makeService(async () => current, { compile });

    const first = await service.refresh('open');
    expect(first.stats.cacheHit).toBe(false);

    // 内容变化
    current = makeSnapshot({
      documents: [SINGLE_DOC, { ...SHRINE_DOC, text: '【剧场：初见｜神社】\n# 视角 灵梦\n> 改\n' }],
    });
    const changed = await service.refresh('manual');
    expect(changed.stats.cacheHit).toBe(false);
    expect(compile).toHaveBeenCalledTimes(2);

    // 顺序变化（同一批文档换注入顺序）也必须失效：身份列表是有序的。
    current = makeSnapshot({
      documents: [
        { ...SHRINE_DOC, text: '【剧场：初见｜神社】\n# 视角 灵梦\n> 改\n' },
        SINGLE_DOC,
      ],
    });
    const reordered = await service.refresh('manual');
    expect(reordered.stats.cacheHit).toBe(false);
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it('世代：旧 load 的迟到结果被丢弃，不覆盖新项目', async () => {
    const firstLoad = deferred<Kojo2ProjectSnapshot>();
    let loadCount = 0;
    const service = makeService(() => {
      loadCount += 1;
      if (loadCount === 1) return firstLoad.promise;
      return Promise.resolve(makeSnapshot({ projectId: 'p2', documents: [SINGLE_DOC] }));
    });

    const staleRefresh = service.refresh('open');
    const fresh = await service.refresh('manual');
    expect(fresh.projectId).toBe('p2');
    expect(fresh.phase).toBe('ready');

    // 迟到的旧快照（另一个项目）到达：必须按世代丢弃。
    firstLoad.resolve(makeSnapshot({ projectId: 'p1', documents: [SHRINE_DOC] }));
    const afterStale = await staleRefresh;
    expect(afterStale.projectId).toBe('p2');
    expect(afterStale.generation).toBe(2);
    expect(afterStale.phase).toBe('ready');
    expect(afterStale.result?.build.projectIR.projectId).toBe('p2');
    expect(afterStale.stats.documentCount).toBe(1);
  });
});

/* ============================== 失败 / lastGood ============================== */

describe('refresh · 失败与 lastGood', () => {
  it('编译抛错：phase failed、lastGood 保留、publishable=false、错误可见', async () => {
    const compile = vi.fn(
      (input: ProjectCompileInput): ProjectCompileResult => compileProject(input),
    );
    let current = makeSnapshot({ documents: [SINGLE_DOC] });
    const service = makeService(async () => current, { compile });

    const first = await service.refresh('open');
    expect(first.lastGood).not.toBeNull();
    expect(first.publishable).toBe(true);

    // 换一份文档让缓存失效，再让编译抛错。
    current = makeSnapshot({ documents: [SINGLE_DOC, SHRINE_DOC] });
    compile.mockImplementationOnce(() => {
      throw new Error('core 爆炸了');
    });
    const failed = await service.refresh('manual');

    expect(failed.phase).toBe('failed');
    expect(failed.result).toBeNull();
    expect(failed.plan).toBeNull();
    expect(failed.assembly).toBeNull();
    expect(failed.lastGood).toBe(first.lastGood);
    expect(failed.publishable).toBe(false);
    expect(failed.publishBlockReason).not.toBeNull();
    expect(failed.error).toContain('core 爆炸了');
    const failure = failed.problems.find((problem) => problem.code === 'service/compile-failed');
    expect(failure?.channel).toBe('build');
    expect(failure?.severity).toBe('error');
    expect(failure?.message).toContain('core 爆炸了');
    // 失败后 assemble() 不再产出产物。
    expect(service.assemble()).toBeNull();
  });

  it('构建失败（exact duplicate）：result 保留诊断视图、assembly 不组、dispatch 诊断可下钻', async () => {
    const service = makeService(async () =>
      makeSnapshot({
        documents: [
          {
            path: 'D:/p/kojo/12/a.kojo2',
            text: '【剧场：初见｜神社｜夜】\n# 视角 灵梦\n> 甲\n',
          },
          {
            path: 'D:/p/kojo/12/b.kojo2',
            text: '【剧场：初见｜神社｜夜】\n# 视角 灵梦\n> 乙\n',
          },
        ],
      }),
    );

    const state = await service.refresh('open');
    expect(state.phase).toBe('failed');
    expect(state.result?.build.buildStatus).toBe('failed');
    expect(state.assembly).toBeNull();
    expect(state.publishable).toBe(false);

    const buildProblem = state.problems.find(
      (problem) => problem.channel === 'build' && problem.code === 'core/target/duplicate-theater',
    );
    expect(buildProblem?.path).toBe('D:/p/kojo/12/a.kojo2');
    expect(buildProblem?.line).toBe(1);
    expect(buildProblem?.fileId).not.toBeNull();

    const dispatchProblem = state.problems.find(
      (problem) => problem.code === 'dispatch/duplicate-group',
    );
    expect(dispatchProblem?.channel).toBe('dispatch');
    expect(dispatchProblem?.severity).toBe('error');
    expect(dispatchProblem?.canonicalId).toBe('eratw.event.初见');
    expect(dispatchProblem?.functionName).toContain('M_KOJO_ENCOUNTER_K12');
    expect(dispatchProblem?.candidateTheaterIds).toHaveLength(2);
    // candidateTheaterIds → projectIR.theaters → files[].path 反查成功。
    expect(dispatchProblem?.path).not.toBeNull();
    expect(dispatchProblem?.fileId).not.toBeNull();
  });

  it('成功后再构建失败：旧 assembly 立即清空，失败首帧即给 assembly/build-failed', async () => {
    let documents: readonly TestDocument[] = [SINGLE_DOC];
    const service = makeService(async () => makeSnapshot({ documents }));

    const ready = await service.refresh('open');
    expect(ready.phase).toBe('ready');
    expect(ready.assembly?.status).toBe('complete');

    // 换成一份目标未知的坏文件：新编译失败。
    documents = [{ path: 'D:/p/kojo/12/broken.kojo2', text: '【剧场：不存在的目标｜神社】\n# 视角 灵梦\n> 坏\n' }];
    const failed = await service.refresh('manual');
    expect(failed.phase).toBe('failed');
    // 失败首帧不许残留上一次成功组装（发布门禁虽看 phase，诊断视图不能撒谎）。
    expect(failed.assembly).toBeNull();
    // 上一次成功仍作只读 lastGood 展示，但不可发布。
    expect(failed.lastGood?.assembly.status).toBe('complete');
    expect(failed.publishable).toBe(false);
    expect(
      failed.problems.some((problem) => problem.code === 'assembly/build-failed'),
    ).toBe(true);
  });
});

/* ============================== stale ============================== */

describe('markStale', () => {
  it('只标脏：phase stale、result 不动、publishable=false；refresh 后回 ready', async () => {
    const snapshot = makeSnapshot({ documents: [SINGLE_DOC] });
    const compile = vi.fn(
      (input: ProjectCompileInput): ProjectCompileResult => compileProject(input),
    );
    const service = makeService(async () => snapshot, { compile });
    const listener = vi.fn();
    service.subscribe(listener);

    const ready = await service.refresh('open');
    expect(listener).toHaveBeenCalled();

    service.markStale([SINGLE_DOC.path]);
    const stale = service.state();
    expect(stale.phase).toBe('stale');
    expect(stale.result).toBe(ready.result);
    expect(stale.publishable).toBe(false);
    expect(stale.publishBlockReason).toContain('重新构建');
    // 标脏不触发编译。
    expect(compile).toHaveBeenCalledTimes(1);

    const refreshed = await service.refresh('scan');
    expect(refreshed.phase).toBe('ready');
    expect(refreshed.stats.cacheHit).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});

/* ============================== 诊断映射 ============================== */

describe('诊断映射', () => {
  it('同特异性歧义 → dispatch 通道 + canonicalId + 候选可下钻', async () => {
    const service = makeService(async () =>
      makeSnapshot({
        documents: [
          { path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见｜学校｜昼】\n# 视角 灵梦\n> 甲\n' },
          { path: 'D:/p/kojo/12/b.kojo2', text: '【剧场：初见｜学校｜白天】\n# 视角 灵梦\n> 乙\n' },
        ],
      }),
    );

    const state = await service.refresh('open');
    expect(state.phase).toBe('failed');
    const ambiguous = state.problems.find(
      (problem) => problem.code === 'dispatch/ambiguous-branches',
    );
    expect(ambiguous?.channel).toBe('dispatch');
    expect(ambiguous?.severity).toBe('error');
    expect(ambiguous?.canonicalId).toBe('eratw.event.初见');
    expect(ambiguous?.candidateTheaterIds).toHaveLength(2);
    expect(ambiguous?.path).not.toBeNull();
  });

  it('legacy 跳过 → dispatch 通道 warning，落点反查到 legacy 文件', async () => {
    const service = makeService(async () =>
      makeSnapshot({ documents: [SHRINE_DOC, LEGACY_DOC] }),
    );

    const state = await service.refresh('open');
    expect(state.phase).toBe('ready');
    expect(state.plan?.legacyFiles).toHaveLength(1);
    expect(state.plan?.legacyFiles[0]?.path).toBe(LEGACY_DOC.path);

    const skipped = state.problems.find(
      (problem) => problem.code === 'dispatch/legacy-machine-skipped',
    );
    expect(skipped?.channel).toBe('dispatch');
    expect(skipped?.severity).toBe('warning');
    expect(skipped?.path).toBe(LEGACY_DOC.path);
    expect(skipped?.candidateTheaterIds.length).toBeGreaterThan(0);
  });

  it('assembly legacy 缺失 → assembly 通道 error、路径可下钻、publish 被拒且不动导出端口', async () => {
    const exportArtifact = vi.fn(async () => 'D:/out/x.ERB');
    const service = makeService(
      async () =>
        makeSnapshot({
          documents: [SHRINE_DOC, LEGACY_DOC],
          compileLegacy: () => null,
        }),
      { exportArtifact },
    );

    const state = await service.refresh('open');
    // 构建本身成功，但 legacy 字节没补上 ⇒ assembly incomplete（不是 build 失败）。
    expect(state.phase).toBe('ready');
    expect(state.assembly?.status).toBe('incomplete');
    expect(state.publishable).toBe(false);

    const missing = state.problems.find((problem) => problem.code === 'assembly/legacy-missing');
    expect(missing?.channel).toBe('assembly');
    expect(missing?.severity).toBe('error');
    expect(missing?.path).toBe(LEGACY_DOC.path);
    expect(missing?.fileId).not.toBeNull();

    const published = await service.publish();
    expect(published.ok).toBe(false);
    expect(published.unitCount).toBe(0);
    expect(published.reason).toContain('legacy');
    expect(exportArtifact).not.toHaveBeenCalled();
  });
});

/* ============================== legacy 组装 ============================== */

describe('assemble · M1 legacy 字节', () => {
  it('compileLegacy 返回字节 ⇒ assembly complete、units = dispatch + legacy', async () => {
    const compileLegacy = vi.fn((_document: TestDocument) => LEGACY_ERB);
    const service = makeService(async () =>
      makeSnapshot({ documents: [SHRINE_DOC, LEGACY_DOC], compileLegacy }),
    );

    const state = await service.refresh('open');
    expect(state.phase).toBe('ready');
    expect(compileLegacy).toHaveBeenCalledTimes(1);
    expect(compileLegacy.mock.calls[0]?.[0]?.path).toBe(LEGACY_DOC.path);
    expect(state.assembly?.status).toBe('complete');
    expect(state.assembly?.units.map((unit) => unit.kind)).toEqual(['dispatch', 'legacy-m1']);
    expect(state.plan?.previewOnlyTheaterCount).toBe(1);
    expect(service.assemble()).toBe(state.assembly);
    expect(service.publishBundle()?.unitCount).toBe(2);
  });
});

/* ============================== 发布 ============================== */

describe('publish', () => {
  it('complete ⇒ exportArtifact 调用一次，文本含 dispatch 函数、unitCount 对、回执带落点', async () => {
    const exportArtifact = vi.fn(async (_fileName: string, _bytes: Uint8Array) => 'D:/out/x.ERB');
    const service = makeService(
      async () => makeSnapshot({ documents: [SHRINE_DOC, LEGACY_DOC] }),
      { exportArtifact },
    );

    await service.refresh('open');
    expect(service.state().publishable).toBe(true);
    const published = await service.publish();

    expect(exportArtifact).toHaveBeenCalledTimes(1);
    const call = exportArtifact.mock.calls[0];
    expect(call?.[0]).toBe('kojo2-project.ERB');
    const bytes = call?.[1];
    expect(bytes).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('M_KOJO_ENCOUNTER_K12');
    expect(text).toContain('MACHINE 指令 310');

    expect(published.ok).toBe(true);
    expect(published.path).toBe('D:/out/x.ERB');
    expect(published.reason).toBeNull();
    expect(published.unitCount).toBe(2);
  });

  it('用户取消（exportArtifact 返回 null）⇒ ok=false + 已取消导出', async () => {
    const exportArtifact = vi.fn(async () => null);
    const service = makeService(async () => makeSnapshot({ documents: [SINGLE_DOC] }), {
      exportArtifact,
    });

    await service.refresh('open');
    const published = await service.publish();
    expect(exportArtifact).toHaveBeenCalledTimes(1);
    expect(published.ok).toBe(false);
    expect(published.path).toBeNull();
    expect(published.reason).toBe('已取消导出');
    expect(published.unitCount).toBe(0);
  });

  it('没有导出端口 ⇒ 不可发布（publishable=false、publish 拒绝写盘）', async () => {
    const service = makeService(async () => makeSnapshot({ documents: [SINGLE_DOC] }), {
      exportArtifact: undefined,
    });

    const state = await service.refresh('open');
    expect(state.assembly?.status).toBe('complete');
    expect(state.publishable).toBe(false);
    expect(state.publishBlockReason).toContain('导出通道');

    const published = await service.publish();
    expect(published.ok).toBe(false);
    expect(published.unitCount).toBe(0);
  });
});

/* ============================== 运行时预览 ============================== */

describe('previewRuntime', () => {
  it('canonical 命中 → selected；未链接 → runtime/not-linked 问题', async () => {
    const service = makeService(async () =>
      makeSnapshot({ documents: [SHRINE_DOC, SCHOOL_DOC, SCHOOL_NIGHT_DOC] }),
    );
    const state = await service.refresh('open');
    const linkedProject = state.result?.build.linkedProject;
    expect(linkedProject).not.toBeNull();
    const linked = linkedProject ?? null;
    if (linked === null) throw new Error('linkedProject 缺失');

    const preview = service.previewRuntime({
      linkedProject: linked,
      canonicalId: 'eratw.event.初见',
      location: '神社',
      time: null,
    });
    expect(preview?.selection.status).toBe('selected');
    expect(preview?.problems).toEqual([]);

    const notLinked = service.previewRuntime({
      linkedProject: linked,
      canonicalId: 'eratw.event.不存在',
      location: null,
      time: null,
    });
    expect(notLinked?.selection.status).toBe('not-linked');
    expect(notLinked?.problems).toHaveLength(1);
    expect(notLinked?.problems[0]?.channel).toBe('runtime');
    expect(notLinked?.problems[0]?.code).toBe('runtime/not-linked');
    expect(notLinked?.problems[0]?.canonicalId).toBe('eratw.event.不存在');
  });

  it('没有编译结果（未 refresh / 编译失败）⇒ null', async () => {
    const service = makeService(async () => makeSnapshot({ documents: [SINGLE_DOC] }));
    const request = {
      canonicalId: 'eratw.event.初见',
      location: null,
      time: null,
      linkedProject: null as unknown as RuntimeSelectionRequest['linkedProject'],
    };
    expect(service.previewRuntime(request)).toBeNull();
  });
});

/* ============================== 生命周期 ============================== */

describe('reset / dispose', () => {
  it('reset：回 idle、清 lastGood、世代递增、通知订阅者；退订后不再收到', async () => {
    const service = makeService(async () => makeSnapshot({ documents: [SINGLE_DOC] }));
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    const ready = await service.refresh('open');
    expect(ready.lastGood).not.toBeNull();
    const callsBeforeReset = listener.mock.calls.length;

    service.reset();
    const state = service.state();
    expect(state.phase).toBe('idle');
    expect(state.projectId).toBeNull();
    expect(state.result).toBeNull();
    expect(state.plan).toBeNull();
    expect(state.assembly).toBeNull();
    expect(state.lastGood).toBeNull();
    expect(state.generation).toBe(ready.generation + 1);
    expect(state.publishable).toBe(false);
    expect(listener.mock.calls.length).toBeGreaterThan(callsBeforeReset);

    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    await service.refresh('open');
    expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
  });

  it('dispose：退订、状态回 idle、此后 refresh 是 no-op（不再取快照）', async () => {
    let loads = 0;
    const service = makeService(async () => {
      loads += 1;
      return makeSnapshot({ documents: [SINGLE_DOC] });
    });
    const listener = vi.fn();
    service.subscribe(listener);

    await service.refresh('open');
    expect(loads).toBe(1);
    service.dispose();
    expect(service.state().phase).toBe('idle');

    const afterDispose = await service.refresh('manual');
    expect(loads).toBe(1);
    expect(afterDispose.phase).toBe('idle');
  });
});
