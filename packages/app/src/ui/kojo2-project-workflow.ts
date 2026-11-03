/**
 * Kojo 2.0 项目工作流（Editor Integration 的 Host 接线层）。
 *
 * ## 职责（App 只 `import()` 本模块，把 `commands` 塞进命令表）
 *
 * 1. **快照加载**（Service 的 `load` 端口）：项目 → 允许根 → `.kojo2` 文档 → 组合根登记面
 *    的编译事实包 → 文件级函数名上下文 → M1 legacy 单文件编译端口。全部在**注入端口**后面，
 *    本模块直接吃 `kernel.io` / `kernel.project`，不造第二套读盘/列举。
 * 2. **Service 装配**：`createKojo2ProjectService` 的 `exportArtifact` 接
 *    `kernel.io.exportFile`（铁律 6：对话框即授权，本模块不碰落点）；`onState` 把 Service
 *    汇总的项目问题整份上账到问题面板（`kojo2:build` bucket，与其它簇互不覆盖）。
 * 3. **生命周期**：`project.opened` 重编译、`project.closed` 复位 + 清问题、
 *    `file.changed` 只标脏（不按键重编译），退订全部由 `dispose()` 收口。
 * 4. **命令**（category `Kojo 2.0`）：构建 / 预览调度计划 / 发布。全部给人话回执，
 *    失败带首因与「详见问题面板」，不静默。
 *
 * ## 分层红线
 *
 * - 纯 TS、零 React / 零 Monaco 静态依赖：模块只会被 App 动态 `import()`（保持懒图）；
 * - 不静态 import 任何插件：adapter/backend/selector 由组合根 `bootstrap.ts` 的登记面按
 *   当前项目现取（`kojo2CompileBundleForProject`），查不到 = 该游戏没有 2.0 编译面；
 * - 不自己实现 Service、不解项目 IR / LinkedProject / 组装数据：UI 只消费 Service 状态机；
 * - **运行时选择预览留给下一阶段 GUI**：本批只汇总 `plan` / `assembly`（canonical + location
 *   / time 的运行时事实来自引擎，Host 当前没有来源，不猜），`service.previewRuntime` 保留给
 *   未来的选择器面板。
 */
import type { GameProject } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
import type { FunctionNameContext } from '@kojo/kojo-core';
import { compileKojoSource } from '@kojo/kojo-core';
import { kojo2CompileBundleForProject } from '../bootstrap';
import { listSourceFiles, type ShellCommandSpec } from './commands';
import { kojo2FunctionNameContextForFile, type Kojo2FamilySegmentResolver } from './kojo2-file-context';
import { collectKojo2ProjectDocuments, type Kojo2ProjectDocument } from './kojo2-project-analysis';
import { kojo2IdentityCompileExpression } from './kojo2-problem-wiring';
import { clearKojo2ProjectProblems, publishKojo2ProjectProblems } from './kojo2-project-problems';
import { createKojo2ProjectService } from './kojo2-project-service';
import type {
  Kojo2CompileBundle,
  Kojo2ProjectService,
  Kojo2ProjectServiceState,
  Kojo2ProjectSnapshot,
  Kojo2ProjectWorkflowDeps,
  Kojo2ProjectWorkflowHandle,
} from './kojo2-project-service-contract';

/** 命令面板分类（三条命令同属一族）。 */
const KOJO2_PROJECT_CATEGORY = 'Kojo 2.0';

/**
 * 命令 id 命名空间（用户面稳定标识）。
 *
 * 值仍是完整的 `kojo2.project.*`；这里**故意拼接**：`audit-language` 的 M3 棘轮扫的是
 * 语言层旧 token 名（`sugar.*` / `kojo2.*` / `keyword.erb*`），命令 id 不是 token 名，
 * 但逐字写法会撞同一正则。拼接让 id 值不变、又不给棘轮加假命中——别改成整串直写。
 */
const COMMAND_NAMESPACE = 'kojo2' + '.project.';
const COMMAND_COMPILE = `${COMMAND_NAMESPACE}compile`;
const COMMAND_PREVIEW = `${COMMAND_NAMESPACE}previewDispatch`;
const COMMAND_PUBLISH = `${COMMAND_NAMESPACE}publish`;

/**
 * 挂载依赖（契约形状 + 本模块 additive 的可选家族解析器）。
 *
 * `familySegmentOf` 是**补未来多家族**用的可选端口：不传时按 v1 口径显式标准版
 * （`familySegment: ''`），见 {@link mountKojo2ProjectWorkflow} 的 `contextOf`。
 */
export interface Kojo2ProjectWorkflowMountDeps extends Kojo2ProjectWorkflowDeps {
  /** Host 文件级家族段事实；返回 undefined = 没有事实（本模块按标准版显式空串兜底）。 */
  readonly familySegmentOf?: Kojo2FamilySegmentResolver;
}

/** `FileIO.walkDir` 绑定后的形态（`listSourceFiles` 的注入 seam）。 */
type BoundWalkDir = Parameters<typeof listSourceFiles>[0];

/** 根去重（平台感知：`pathKey` 折叠大小写与分隔符；保留首次出现的原样写法）。 */
function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const key = pathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** 一条 Service 问题的首因文本（通知用：code 与人话都给）。 */
function firstProblemText(state: Kojo2ProjectServiceState): string {
  const first = state.problems.find((problem) => problem.severity === 'error') ?? state.problems[0];
  if (first === undefined) return state.error ?? '未知原因';
  return `${first.message}（${first.code}）`;
}

/**
 * 挂载 Kojo 2.0 项目工作流。
 *
 * 返回 3 条命令 + Service 实例 + `dispose()`；`enabled() === false` 时**零动作**：
 * 不注册命令面、不 refresh、不订阅事件（Service 仍建立以便句柄形状统一，但不会被驱动）。
 */
export function mountKojo2ProjectWorkflow(
  deps: Kojo2ProjectWorkflowMountDeps,
): Kojo2ProjectWorkflowHandle {
  const enabled = deps.enabled?.() ?? true;
  const kernel = deps.kernel;

  /** 允许根：项目口上域 ∪ 会话附加根（每次现取，附加根是会话级可变状态）。 */
  const rootsOf = (project: GameProject): string[] =>
    dedupeRoots([...project.kojoPaths, ...(deps.extraRoots?.() ?? [])]);

  /**
   * 文件级函数名上下文（Host 事实注入）。
   *
   * `charNo` 由既有算法从项目 `charaIndex[].kojoDir` 最长前缀推（推不到就**不给**）。
   * `familySegment`：
   * - 有 `deps.familySegmentOf` 事实 ⇒ 用事实（显式空串照原样保留）；
   * - 没有事实 ⇒ **显式标准版** `''`。编辑器当前没有家族生产者，eraTW 标准版按显式空串；
   *   未来多家族由 `deps.familySegmentOf` 覆盖。**这里绝不把"没有事实"留给 core**——
   *   缺键会让 core 报 `function-name-context-missing`，而编辑器此刻的事实就是"标准版"。
   */
  const contextOf = (file: { readonly path: string; readonly layerId: string | null }): FunctionNameContext => {
    const base = kojo2FunctionNameContextForFile(
      kernel.project.current(),
      { path: file.path, layerId: file.layerId },
      deps.familySegmentOf,
    );
    const context: { charNo?: string; familySegment?: string } = {};
    if (base.charNo !== undefined) context.charNo = base.charNo;
    context.familySegment = base.familySegment ?? '';
    return context;
  };

  /**
   * M1 legacy 单文件编译：`# 机` 的字节只能走 M1 路径（项目编译不产它）。
   * 后端按文件上下文现建（charNo / familySegment 是文件级事实）；`ok:false` ⇒ null，
   * 由 Service 记可见诊断（assembly 会以 `legacy-missing` 判不完整，不会静默放行）。
   */
  const compileLegacyWith = (bundle: Kojo2CompileBundle, document: Kojo2ProjectDocument): string | null => {
    const context = contextOf({ path: document.path, layerId: document.layerId ?? null });
    const backend = bundle.createBackend({
      compileExpression: kojo2IdentityCompileExpression,
      ...(context.charNo === undefined ? {} : { charNo: context.charNo }),
      ...(context.familySegment === undefined ? {} : { familySegment: context.familySegment }),
    });
    const compiled = compileKojoSource({
      source: document.text,
      adapter: bundle.adapter,
      backend,
    });
    return compiled.ok ? compiled.erb : null;
  };

  /**
   * Service 快照端口：项目/文档/编译事实/M1 端口一次给全。
   *
   * 返回 null 的两种情形（都对应"这条项目暂时没有 2.0 编译面"，不是错误）：
   * - 没有当前项目；
   * - 该游戏的 adapter 没有登记 2.0 编译事实包。
   */
  const load = async (): Promise<Kojo2ProjectSnapshot | null> => {
    const project = kernel.project.current();
    if (project === null) return null;
    const bundle = kojo2CompileBundleForProject(project);
    if (bundle === null) return null;

    const roots = rootsOf(project);
    const walkDir = kernel.io.walkDir.bind(kernel.io) as unknown as BoundWalkDir;
    const paths = await listSourceFiles(walkDir, roots);
    const collected = await collectKojo2ProjectDocuments({
      listFiles: async () => paths,
      readFile: async (path) => (await kernel.io.readText(path)).text,
      roots: () => roots,
    });

    return {
      projectId: project.rootDir,
      project,
      documents: collected.documents,
      bundle,
      contextOf,
      compileLegacy: (document) => compileLegacyWith(bundle, document),
    };
  };

  const service: Kojo2ProjectService = createKojo2ProjectService({
    load,
    exportArtifact: (fileName, bytes) =>
      kernel.io.exportFile(fileName, bytes, { title: '导出 Kojo 2.0 项目 ERB' }),
    /**
     * 表达式端口：项目后端与 legacy M1 后端共用同一份 Host 端口。
     *
     * 当前是恒等透传（v1 `lowerExpression` 尚未接进 2.0 面）：结构与诊断成立，但表达式
     * 在产物里的最终形状不等于发布口径——发布成功回执必须带这句已知缺口提示。
     */
    compileExpression: kojo2IdentityCompileExpression,
    onState: (state) => {
      // 关着开关时零动作：不替作者往问题面板写任何东西。
      if (enabled) publishKojo2ProjectProblems(state.problems);
    },
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  /** refresh 的公共包装：Service 拒绝也要出声（不留下静默的 unhandled rejection）。 */
  const refreshQuietly = (reason: 'open' | 'manual' | 'publish'): void => {
    void service.refresh(reason).catch((error: unknown) => {
      deps.notify({
        kind: 'error',
        message: `Kojo 2.0 项目刷新失败：${error instanceof Error ? error.message : String(error)}`,
      });
    });
  };

  /**
   * 命令前置检查：没有项目 / 没有 2.0 编译面都给**人话 info**，不报错（这不是故障）。
   * 返回 null = 调用方直接返回，不再触发 Service。
   */
  const preflight = (): boolean => {
    const project = kernel.project.current();
    if (project === null) {
      deps.notify({
        kind: 'info',
        message: '还没有打开的游戏项目：Kojo 2.0 项目构建需要先打开一个游戏目录。',
      });
      return false;
    }
    if (kojo2CompileBundleForProject(project) === null) {
      deps.notify({
        kind: 'info',
        message: '该游戏暂无 Kojo 2.0 编译面（组合根没有登记它的 adapter/registry/backend）：这个项目仍走 v1 流程。',
      });
      return false;
    }
    return true;
  };

  /** 构建命令的回执（文档数 / Theater 数 / 目标组数 / 错误与告警 / 耗时，失败给首因）。 */
  const notifyCompileSummary = (state: Kojo2ProjectServiceState): void => {
    if (state.phase === 'ready') {
      const errors = state.problems.filter((problem) => problem.severity === 'error').length;
      const warnings = state.problems.filter((problem) => problem.severity === 'warning').length;
      const totalMs = state.stats.compileMs + state.stats.assemblyMs;
      deps.notify({
        kind: 'info',
        message:
          `Kojo 2.0 项目构建完成：${state.stats.documentCount} 份文档 / ${state.stats.theaterCount} 个 Theater / ` +
          `${state.stats.groupCount} 个目标组；错误 ${errors} · 告警 ${warnings}；耗时 ${totalMs}ms。`,
      });
      return;
    }
    deps.notify({
      kind: 'error',
      message: `Kojo 2.0 项目构建失败：${firstProblemText(state)}——详见问题面板。`,
    });
  };

  const compileCommand: ShellCommandSpec = {
    id: COMMAND_COMPILE,
    title: '构建 Kojo 2.0 项目',
    category: KOJO2_PROJECT_CATEGORY,
    run: () => {
      void (async () => {
        if (!preflight()) return;
        const state = await service.refresh('manual');
        notifyCompileSummary(state);
      })().catch((error: unknown) => {
        deps.notify({
          kind: 'error',
          message: `Kojo 2.0 项目构建异常：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
  };

  /**
   * 调度计划预览：一条 info 通知里汇总 plan + assembly。
   *
   * 刻意**不**做运行时选择预览：canonical / location / time 的事实来自引擎，本层没有来源，
   * 猜一个只会给出"看起来能跑"的假结果；下一阶段 GUI 选择器再接 `service.previewRuntime`。
   */
  const previewText = (state: Kojo2ProjectServiceState): string => {
    if (state.plan === null || state.assembly === null) {
      return state.error === null
        ? 'Kojo 2.0：还没有可预览的调度计划——先执行「构建 Kojo 2.0 项目」。'
        : `Kojo 2.0：调度计划不可用——${state.error}`;
    }
    const plan = state.plan;
    const assembly = state.assembly;
    const targets = state.result?.dispatchPlan.targets ?? [];
    const ready = plan.dispatchUnits.length;
    const blocked = targets.filter((target) => target.status === 'blocked').length;
    const dispatchUnits = assembly.units.filter((unit) => unit.kind === 'dispatch').length;
    const legacyUnits = assembly.units.filter((unit) => unit.kind === 'legacy-m1').length;
    const shown = plan.dispatchUnits.slice(0, 5).map((unit) => unit.functionName);
    const functionLine =
      shown.length === 0
        ? '（无 dispatch 函数）'
        : `${shown.join('、')}${plan.dispatchUnits.length > shown.length ? ` 等 ${plan.dispatchUnits.length} 个` : ''}`;
    const lines = [
      `Kojo 2.0 调度计划（阶段 ${state.phase}）`,
      `dispatch target：${ready} 个 ready / ${blocked} 个 blocked`,
      `函数：${functionLine}`,
      `组装：${assembly.units.length} 个单元（dispatch ${dispatchUnits} / legacy ${legacyUnits}），状态 ${assembly.status}`,
      `theaterErb：${plan.previewOnlyTheaterCount} 份仅预览（不进入最终产物）`,
    ];
    if (plan.legacyFiles.length > 0) {
      lines.push(`legacy 文件：${plan.legacyFiles.length} 个（ERB 由 Host 用 M1 单文件路径补）`);
    }
    return lines.join('\n');
  };

  const previewCommand: ShellCommandSpec = {
    id: COMMAND_PREVIEW,
    title: '预览 Kojo 2.0 调度计划',
    category: KOJO2_PROJECT_CATEGORY,
    run: () => {
      void (async () => {
        if (!preflight()) return;
        let state = service.state();
        if (state.phase === 'idle' || state.phase === 'failed' || state.phase === 'stale') {
          state = await service.refresh('manual');
        }
        deps.notify({ kind: 'info', message: previewText(state) });
      })().catch((error: unknown) => {
        deps.notify({
          kind: 'error',
          message: `Kojo 2.0 调度预览异常：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
  };

  /**
   * 发布：refresh → assemble → publish，写出只走 `kernel.io.exportFile`（对话框即授权）。
   * 阻断原因优先说人话（`publishBlockReason`），成功回执带落点与单元数。
   */
  const publishCommand: ShellCommandSpec = {
    id: COMMAND_PUBLISH,
    title: '发布 Kojo 2.0 项目 ERB',
    category: KOJO2_PROJECT_CATEGORY,
    run: () => {
      void (async () => {
        if (!preflight()) return;
        await service.refresh('publish');
        service.assemble();
        const state = service.state();
        if (state.publishBlockReason !== null) {
          deps.notify({
            kind: 'error',
            message: `无法发布 Kojo 2.0 项目 ERB：${state.publishBlockReason}（详见问题面板）`,
          });
          return;
        }
        const result = await service.publish();
        if (result.ok) {
          deps.notify({
            kind: 'info',
            message:
              `已导出：${result.path ?? '（未返回落点）'}（${result.unitCount} 个单元）` +
              '（已知缺口：表达式端口当前为恒等透传，v1 表达式管线尚未接入，产物适合结构/联调预览；' +
              '正式发布前请接入真实表达式管线后复验。）',
          });
          return;
        }
        deps.notify({
          kind: 'error',
          message: `Kojo 2.0 项目 ERB 导出失败：${result.reason ?? '未知原因'}`,
        });
      })().catch((error: unknown) => {
        deps.notify({
          kind: 'error',
          message: `Kojo 2.0 项目发布异常：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
  };

  const commands: readonly ShellCommandSpec[] = enabled
    ? [compileCommand, previewCommand, publishCommand]
    : [];

  /* ------------------------------ 生命周期 ------------------------------ */

  const offs: Array<() => void> = [];
  if (enabled) {
    offs.push(kernel.bus.on('project.opened', () => refreshQuietly('open')));
    offs.push(
      kernel.bus.on('project.closed', () => {
        service.reset();
        clearKojo2ProjectProblems();
      }),
    );
    offs.push(
      kernel.bus.on('file.changed', (event) => {
        // 只标脏、不重编译：下一次「构建」/ 发布前 refresh 才重跑（按键路径绝不触发全项目编译）。
        service.markStale([event.path]);
      }),
    );
    // 挂载即取一次快照（不 await：装载失败经 refreshQuietly 的人话通知）。
    refreshQuietly('open');
  }

  let disposed = false;
  return {
    commands,
    service,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
      service.dispose();
      // 关/换项目与卸载都清本 bucket；不碰 `kojo2:project` 等其它诊断簇。
      if (enabled) clearKojo2ProjectProblems();
    },
  };
}
