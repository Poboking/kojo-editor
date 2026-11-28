/**
 * MCP 写域多根：常驻可写根的**枚举标识**真源。
 *
 * 真源已上移到契约层 `@kojo/plugin-api` 的 `root-id.ts`（MCP-RELOAD-HOOK，
 * 2026-11-28）：内核 `project.evicted` 与 WebView 侧 `io.workspaceRoots` 现在必须
 * 用同一枚纯函数算 `rootId`，否则「同一根两个 id」会让同源证明永远为假。
 * 本文件保留旧导入路径（纯 re-export），旧消费方零改动、行为逐字不变。
 *
 * 安全边界（ADR-0013 additive）不变：`rootId` 只是枚举标识，不是目标路径；
 * 工具入参绝不收任意绝对路径，落盘仍过双写闸。
 */
export {
  ROOT_ID_SHAPE,
  findRootById,
  isRootIdShape,
  normalizeRootForId,
  rootIdOf,
} from '@kojo/plugin-api';
