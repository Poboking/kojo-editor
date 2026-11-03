/**
 * Host 侧 Kojo 2.0 项目编译编排（M2 P6）。
 *
 * 职责边界：
 * - 文档文本 → 一次 `parseSource`（不二次读盘、不重复解析）；
 * - 复用 `pathKey` + `stableHash` 生成 ProjectFileIdentity；
 * - 复用 `charNoForProjectPath` 与 Host 显式 familySegment 生成 FunctionNameContext；
 * - `contextOf` 注入时走与分析装配面同一个 Host 边界（不再二次猜 charNo / familySegment）；
 * - 把纯数据交给 core `compileProject`（TargetRegistry / Linker / Backend 都在那边）。
 *
 * 本文件不读盘、不造默认 familySegment、不从文件名猜家族。
 */
import {
  compileProject,
  parseSource,
  type KojoFile,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
  type ProjectCompileResult,
  type TargetRegistry,
  type GameAdapter,
  type KojoEmitBackend,
  type DispatchSelectors,
} from '@kojo/kojo-core';
import type { GameProject } from '@kojo/plugin-api';
import { kojo2FunctionNameContextForFile, type Kojo2FamilySegmentResolver } from './kojo2-file-context';
import { kojo2ProjectFileIdentity } from './kojo2-project-file-identity';
import {
  resolveKojo2FunctionNameContext,
  type Kojo2FunctionNameContextResolver,
  type Kojo2ProjectDocument,
} from './kojo2-project-analysis';

export interface Kojo2CompileProjectInput {
  readonly projectId: string;
  readonly provenance: ProjectBuildProvenance;
  readonly project: GameProject | null;
  readonly documents: readonly Kojo2ProjectDocument[];
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly registry: TargetRegistry;
  /** Host 文件级 familySegment 事实；缺席 = 没有事实（不是空串）。 */
  readonly familySegmentOf?: Kojo2FamilySegmentResolver;
  /**
   * Host 同步函数名上下文注入器（D3；与分析装配面同一条边界）。
   *
   * 给出时**取代** `project` + `familySegmentOf` 的旧推法（charNo / familySegment 都归
   * Host 注入）；缺席时旧 API 逐字不变。
   */
  readonly contextOf?: Kojo2FunctionNameContextResolver;
  /** M3 Host 注入的运行时 selector；缺省 = 没事实，adapter 必须 fail-closed。 */
  readonly dispatchSelectors?: DispatchSelectors;
  /** M3 是否要求最终 dispatch ERB 必须成功。 */
  readonly requireDispatch?: boolean;
  /** 测试 / 已解析复用口；缺省 core `parseSource`。 */
  readonly parse?: (text: string) => KojoFile;
}

export function compileKojo2Project(input: Kojo2CompileProjectInput): ProjectCompileResult {
  const parse = input.parse ?? parseSource;
  const files: ProjectCompileFileInput[] = input.documents.map((document) => {
    const layerId = document.layerId ?? null;
    const contextFile = { path: document.path, layerId };
    let file: KojoFile | null;
    try {
      file = parse(document.text);
    } catch {
      file = null;
    }
    return {
      identity: kojo2ProjectFileIdentity(document.path, document.text, layerId),
      file,
      sourceText: document.text,
      functionNameContext:
        input.contextOf === undefined
          ? kojo2FunctionNameContextForFile(input.project, contextFile, input.familySegmentOf)
          : resolveKojo2FunctionNameContext(input.contextOf, contextFile),
    };
  });

  return compileProject({
    projectId: input.projectId,
    provenance: input.provenance,
    files,
    registry: input.registry,
    adapter: input.adapter,
    backend: input.backend,
    ...(input.dispatchSelectors === undefined ? {} : { dispatchSelectors: input.dispatchSelectors }),
    ...(input.requireDispatch === undefined ? {} : { requireDispatch: input.requireDispatch }),
  });
}
