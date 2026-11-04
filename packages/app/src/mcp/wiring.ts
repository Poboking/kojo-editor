/**
 * MCP 装配层（路 A 端到端集成，ADR-0013）：把「已写好的零件」组装成真实 `McpHostDeps`。
 *
 * 纪律（ps10 开机图）：
 * - 本模块**只由 `host-bridge.ts` 的 `defaultRegistryFactory` 在首条 `mcp://request`
 *   到达时动态 `import('./wiring')` 装载**，绝不出现在 bootstrap 静态图里；
 * - 顶层除 `McpFailure`（与 `@kojo/mcp-host` 同一拍装载）外**只用 `import type`**：
 *   不静态 import Monaco / kernel / React / 调试宿主 / bridge 运行时，零常驻图边；
 * - 命令注册表没有生产级全局 accessor（`ShellLayout` 在 `useMemo` 里本地构建），
 *   故所有真源都经 `McpWiringSources` **注入**：宿主可 `registerMcpWiringSources(...)`
 *   登记（建议同样走动态 import，以免给 bootstrap 静态图加边），`createMcpHostDeps()`
 *   在首条请求时读取当前登记。未登记 ⇒ 全部缺席，绝不伪造。
 *
 * 铁律 4「不静默」：接不到真源的腿一律**缺席**，让 `@kojo/mcp-host` 的 registry 显式报
 * `NOT_WIRED` / `RESOURCE_UNAVAILABLE`；绝不编造读数、绝不用空串 / 空数组冒充成功。
 * 命令已给但缺 `EditorCommandContext` 时不伪造 ctx：命令仍列出，但 `run` 抛 `NOT_WIRED`。
 */
import { McpFailure } from '@kojo/mcp-host';
import type {
  McpHostDeps,
  McpCommandSource,
  McpSemanticReaders,
  McpReaderFn,
} from '@kojo/mcp-host';
import type { CommandEntry } from '../ui/commands';
import type { EditorCommandContext } from '@kojo/plugin-api';
import type { SemanticService, SemanticReadingName } from './semantic-service';

/** 宿主能提供的真源（逐项可选；给到才接，没给就缺席）。 */
export interface McpWiringSources {
  /** `buildCommandRegistry(...)` 的结果；由 `projectCommands` 投影成 `McpCommandSource[]`。 */
  readonly commands?: readonly CommandEntry[];
  /** `cmd.run(ctx, args)` 所需的编辑器上下文（命令投影闭包捕获）。 */
  readonly commandContext?: EditorCommandContext;
  /** 语义 8 条读腿；显式给则用，否则可由 `semanticService` 投影。 */
  readonly semantic?: McpHostDeps['semantic'];
  /** 已有 `createSemanticService(...)` 实例时，由它投影出 8 条读腿。 */
  readonly semanticService?: SemanticService;
  readonly kernelIo?: McpHostDeps['kernelIo'];
  readonly readResourceData?: McpHostDeps['readResourceData'];
  readonly resources?: McpHostDeps['resources'];
  readonly prompts?: McpHostDeps['prompts'];
  readonly runSupplemental?: McpHostDeps['runSupplemental'];
  readonly promptSlots?: McpHostDeps['promptSlots'];
}

/* --------------------------- 真源登记（注入 seam） --------------------------- */

let registeredSources: McpWiringSources | null = null;

/**
 * 登记 / 清空真源。宿主（握有命令注册表、语义服务、kernel IO 的那一侧）经**动态 import**
 * 调本函数即可把真源交给首条请求时装载的 wiring；传 `null` 恢复「全部缺席」。
 */
export function registerMcpWiringSources(sources: McpWiringSources | null): void {
  registeredSources = sources;
}

/** 当前登记的真源（未登记返回 `null`）。 */
export function getMcpWiringSources(): McpWiringSources | null {
  return registeredSources;
}

/* --------------------------- 投影（纯函数，可单测） --------------------------- */

/**
 * 命令注册表 → `McpCommandSource[]`（`id/title/description/argsSchema/tier` 原样透传，
 * `run(args, scope)` 调到 `cmd.run(ctx, args)`）。
 *
 * 缺 `EditorCommandContext` 时**不伪造上下文**：工具仍列出（能力可见），但一调用就抛
 * `NOT_WIRED` 结构化失败，由 registry 原样透出（不静默、不假装跑通）。
 */
export function projectCommands(
  commands: readonly CommandEntry[],
  context?: EditorCommandContext,
): readonly McpCommandSource[] {
  return commands.map((cmd) => ({
    id: cmd.id,
    title: cmd.title,
    ...(cmd.description !== undefined ? { description: cmd.description } : {}),
    ...(cmd.argsSchema !== undefined ? { argsSchema: cmd.argsSchema } : {}),
    ...(cmd.tier !== undefined ? { tier: cmd.tier } : {}),
    run: (args: Record<string, unknown>): void | Promise<void> => {
      if (!context) {
        throw new McpFailure(
          'NOT_WIRED',
          `命令 ${cmd.id} 未接线：宿主未提供 EditorCommandContext（不静默、不伪造上下文）`,
        );
      }
      return cmd.run(context, args);
    },
  }));
}

/**
 * `SemanticService` → 8 条 `McpSemanticReaders` 读腿。
 *
 * `semantic-service.ts` 的 `SemanticReader` 只收 `(args)`，而 `@kojo/mcp-host` 的
 * `McpReaderFn` 收 `(args, scope)`；这里做一层薄适配，`scope` 不参与读语义（只读能力
 * 与会话授权无关），`NOT_WIRED` 等结构化失败由 service 自身抛出、原样透出。
 */
export function semanticReadersFromService(service: SemanticService): Partial<McpSemanticReaders> {
  const at = (name: SemanticReadingName): McpReaderFn => (args) => service.read(name, args);
  return {
    definitionAt: at('definitionAt'),
    referencesAt: at('referencesAt'),
    diagnostics: at('diagnostics'),
    hoverAt: at('hoverAt'),
    suggestAt: at('suggestAt'),
    documentSymbols: at('documentSymbols'),
    tokens: at('tokens'),
    codeActionsAt: at('codeActionsAt'),
  };
}

/* --------------------------- 组装 --------------------------- */

/** 可写视图（`McpHostDeps` 字段皆 `readonly`，组装期先写成可变）。 */
type MutableDeps = { -readonly [K in keyof McpHostDeps]: McpHostDeps[K] };

/**
 * 组装真实 `McpHostDeps`。
 *
 * 缺省读取 `registerMcpWiringSources(...)` 登记的真源；显式传 `sources` 便于单测注入。
 * 每一项都**给到才接**：没给的字段不出现在返回值里 ⇒ `@kojo/mcp-host` 的 registry
 * 对缺席的语义 / kernel / resource 腿显式报 `NOT_WIRED` / `RESOURCE_UNAVAILABLE`。
 */
export function createMcpHostDeps(
  sources: McpWiringSources | null = getMcpWiringSources(),
): McpHostDeps {
  const s = sources ?? {};
  const out: MutableDeps = {};

  // ① 命令面板登记命令 → 工具（命令来源优先，同 name 覆盖内置规格）。
  if (s.commands !== undefined && s.commands.length > 0) {
    out.commands = projectCommands(s.commands, s.commandContext);
  }
  // ② 语义 8 条读腿：显式 readers 优先，其次由 SemanticService 投影；都没有就缺席。
  const semantic =
    s.semantic ?? (s.semanticService !== undefined ? semanticReadersFromService(s.semanticService) : undefined);
  if (semantic !== undefined) out.semantic = semantic;
  // ③ kernel IO / resource 数据源 / 追加 resource / prompt / 补齐执行钩子 / prompt 槽。
  if (s.kernelIo !== undefined) out.kernelIo = s.kernelIo;
  if (s.readResourceData !== undefined) out.readResourceData = s.readResourceData;
  if (s.resources !== undefined) out.resources = s.resources;
  if (s.prompts !== undefined) out.prompts = s.prompts;
  if (s.runSupplemental !== undefined) out.runSupplemental = s.runSupplemental;
  // `promptSlots` 提供（哪怕空数组）即把内置零游戏名词骨架并入 prompts；缺席则保持第一波行为。
  if (s.promptSlots !== undefined) out.promptSlots = s.promptSlots;

  return out;
}
