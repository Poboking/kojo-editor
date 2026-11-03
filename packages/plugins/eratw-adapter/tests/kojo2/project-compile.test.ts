import { describe, expect, it } from 'vitest';
import {
  compileKojoSource,
  compileProject,
  createProjectFileIdentity,
  parseSource,
  type EmitFailure,
  type KojoEmitBackend,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import { ERATW_GAME_ADAPTER } from '../../src/kojo2/index.js';
import { createEratwEmitBackend } from '../../src/kojo2/backend.js';
import { ERATW_CAPABILITY, ERATW_SOURCE_MAP } from '../../src/kojo2/capabilities.js';
import { ERATW_TARGET_REGISTRY } from '../../src/kojo2/target-registry.js';

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  adapterFactsVersion: '1',
  gameFingerprint: 'fixture',
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function fileInput(path: string, source: string): ProjectCompileFileInput {
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(source)),
    file: parseSource(source),
    sourceText: source,
    functionNameContext: { charNo: '12', familySegment: '' },
  };
}

describe('M2 compileProject / Backend integration', () => {
  it('显式初见经 TargetRegistry 解析后用 backend 产出单 Theater ERB', () => {
    const backend = createEratwEmitBackend({
      compileExpression: (expr) => expr.text,
    });
    const source = '【剧场：初见】\n# 视角 灵梦\n> 你好\n';
    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [fileInput('/p/a.kojo2', source)],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.complete).toBe(true);
    expect(result.theaterErb).toHaveLength(1);
    const erb = result.theaterErb[0]?.erb ?? '';
    expect(erb).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(erb).toContain('CALL M_KOJO_ENCOUNTER_K12_1');
    expect(erb).toContain('RETURN RESULT');
    expect(erb).toContain('你好');
    expect(result.backendDiagnostics).toEqual([]);
  });

  it('项目构建失败时不发布 theaterErb 部分产物', () => {
    const backend = createEratwEmitBackend({
      compileExpression: (expr) => expr.text,
    });
    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [
        fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 甲\n'),
        fileInput('/p/b.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 乙\n'),
      ],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.complete).toBe(false);
    expect(result.theaterErb).toEqual([]);
    expect(result.build.diagnostics.map((diagnostic) => diagnostic.kind)).toContain('duplicate-theater');
  });

  it('缺少 familySegment 时不补空串，构建 failed 且无 ERB', () => {
    const backend = createEratwEmitBackend({
      compileExpression: (expr) => expr.text,
    });
    const input = fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 你好\n');
    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [{ ...input, functionNameContext: { charNo: '12' } }],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    expect(result.build.diagnostics.map((diagnostic) => diagnostic.kind)).toContain(
      'function-name-context-missing',
    );
  });

  it('backend.wrapMachine 失败 → buildStatus failed、theaterErb 空、backendDiagnostics 非空', () => {
    const failingBackend: KojoEmitBackend = {
      ...createEratwEmitBackend({
        compileExpression: (expr) => expr.text,
      }),
      wrapMachine: (): EmitFailure => ({
        diagnostics: [
          {
            code: 'unit/backend-incomplete',
            severity: 'error',
            message: 'fixture backend 拒绝生成 Theater ERB',
            span: null,
          },
        ],
      }),
    };
    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 你好\n')],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend: failingBackend,
    });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    expect(result.backendDiagnostics.length).toBeGreaterThan(0);
    expect(result.backendDiagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    // backend 自己的 EmitFailure 诊断是失败原因真源：不能被吞成泛化消息。
    expect(result.backendDiagnostics.map((diagnostic) => diagnostic.message)).toContain(
      'fixture backend 拒绝生成 Theater ERB',
    );
    expect(result.complete).toBe(false);
  });

  it('显式剧场「指令」没有 i → needs-context，不产 ERB（不拆 raw、不猜编号）', () => {
    const backend = createEratwEmitBackend({
      compileExpression: (expr) => expr.text,
    });
    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [fileInput('/p/a.kojo2', '【剧场：指令】\n# 视角 灵梦\n> 问候\n')],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });

    const theater = result.build.projectIR.theaters[0];
    expect(theater?.targetResolution?.status).toBe('needs-context');
    expect(theater?.targetResolution?.functionName.requiredContext).toContain('index');
    expect(result.build.diagnostics.map((diagnostic) => diagnostic.kind)).toContain(
      'function-name-context-missing',
    );
    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
  });

  it('legacy # 机 指令 310：M1 路径字节不变，项目侧只解析 sourceArgs、不产 theaterErb', () => {
    const source = '# 机 指令 310\n# 视角 灵梦\n> 你好\n';
    const eratwBackend = createEratwEmitBackend({
      compileExpression: (expr) => expr.text,
      charNo: '12',
      familySegment: '',
    });
    let wrapCalls = 0;
    const backend: KojoEmitBackend = {
      ...eratwBackend,
      wrapMachine: (request) => {
        wrapCalls++;
        return eratwBackend.wrapMachine?.(request) ?? null;
      },
    };

    // M1 单文件路径保持原样：legacy face-templates 渲染仍发生，字节序列不变。
    const m1 = compileKojoSource({
      source,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });
    expect(m1.ok).toBe(true);
    expect(m1.erb).toContain('@M_KOJO_MESSAGE_COM_K12_310(ARG)');
    expect(m1.erb).toContain('CALL M_KOJO_MESSAGE_COM_K12_310_1(ARG)');
    expect(wrapCalls).toBe(1);

    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [fileInput('/p/a.kojo2', source)],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });

    // 项目层不重跑 M1 包装：legacy 字节只由单文件路径负责。
    expect(wrapCalls).toBe(1);

    const [legacy] = result.build.linkedProject?.theaters ?? [];
    expect(legacy?.origin).toBe('legacy-machine');
    expect(legacy?.sourceArgs.index).toBe('310');
    expect(legacy?.sourceArgs.indexOrigin).toBe('machine-args');
    expect(legacy?.engineFunctionName.kind).toBe('resolved');
    expect(legacy?.engineFunctionName.name).toBe('M_KOJO_MESSAGE_COM_K12_310');
    expect(result.build.buildStatus).toBe('succeeded');
    // legacy 的 M1 字节由单文件路径负责；项目编译不得把它重写成 theaterErb。
    expect(result.theaterErb).toEqual([]);
  });

  it('显式「初见」带 resolvedFunctionName：backend 不再走 free-text 渲染（缺 charNo 也能成功）', () => {
    // 故意不给 backend 注入 charNo/familySegment：若 backend 回落到 M1 free-text
    // renderMachineName，{n} 缺省会 fail-closed，项目构建必然失败。
    const backend = createEratwEmitBackend({
      compileExpression: (expr) => expr.text,
    });
    const result = compileProject({
      projectId: 'p1',
      provenance: PROVENANCE,
      files: [fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 你好\n')],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend,
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.backendDiagnostics).toEqual([]);
    expect(result.theaterErb).toHaveLength(1);
    const erb = result.theaterErb[0]?.erb ?? '';
    expect(erb).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(erb).toContain('CALL M_KOJO_ENCOUNTER_K12_1');
  });
});