/**
 * MCP 能力面槽契约（冻结契约 v1 · 2026-11-04）。
 *
 * 本文件是**唯一**新增的契约面落点（零游戏名词）。`mcp.prompt` / `mcp.tool` 两枚槽让
 * adapter 才能提供的领域知识（提示词）与领域动作（工具）以「贡献」的形态进入面向模型的
 * 能力清单；宿主侧的 registry 装配见 `@kojo/mcp-host`。
 *
 * 注意：`EditorCommandContribution` 的三个 additive 字段与 `run(ctx, args?)` 单签名直接
 * 落在 `slots.ts`（命令契约的所属文件），`mcp.prompt` / `mcp.tool` 两枚槽名则用下面的
 * TypeScript 模块增强挂到 `SlotMap` 上——增强是纯类型操作、运行时无痕，不给开机图
 * 常驻契约面增加多余的 import 边。
 */
import type { ContributionBase } from './slots-types';

/** 能力分级（与 `@kojo/mcp-host` 的 `McpTier` 同形结构类型，互不 import）。 */
export type McpTier = 'read' | 'edit' | 'privileged';

export interface McpPromptArgument {
  readonly name: string;
  readonly required?: boolean;
}

export interface McpPromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: { readonly type: 'text'; readonly text: string };
}

export interface McpPromptRenderResult {
  readonly messages: readonly McpPromptMessage[];
}

/** `mcp.prompt` 槽贡献：领域提示词（adapter 才能写，宿主只当数据搬运）。 */
export interface McpPromptContribution extends ContributionBase {
  /** 面向模型的提示名（稳定 id，宿主按它登记 prompts/list）。 */
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly McpPromptArgument[];
  render(args: Record<string, unknown>): Promise<McpPromptRenderResult> | McpPromptRenderResult;
}

/** `mcp.tool` 槽贡献：领域工具（adapter 才能提供领域动作）。 */
export interface McpToolContribution extends ContributionBase {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tier?: McpTier;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

declare module './slots-types' {
  // 三个 additive 字段挂这里（纯类型增强、运行时无痕）：不给开机图常驻契约面
  // 多留字节；run 的 `args?` 单签名留在 `EditorCommandContribution` 本体，避免合并出重载。
  // 增强目标必须是 `./slots-types`（类型面已从 `slots.ts` 搬出；挂 `./slots` 会在
  // 那个模块上新造一份 `SlotMap`，真实的槽名联合收不到这两枚 ⇒ 静默丢槽）。
  interface EditorCommandContribution {
    readonly argsSchema?: Record<string, unknown>;
    readonly description?: string;
    readonly tier?: McpTier;
  }
  interface SlotMap {
    'mcp.prompt': McpPromptContribution;
    'mcp.tool': McpToolContribution;
  }
}
