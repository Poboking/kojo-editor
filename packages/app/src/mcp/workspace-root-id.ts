/**
 * MCP 写域多根：常驻可写根的**枚举标识**真源（纯函数，零依赖、零副作用）。
 *
 * 为什么是 hash 而不是索引：`workspace_roots` 的返回顺序会随用户增删根目录变化，
 * 用 `ws:0` / `ws:1` 这种序号做第四张表授权会造成「批准 A 根、下次变成 B 根」的
 * 授权漂移。这里把根的**绝对路径**做成稳定标识，批准的是这个标识本身。
 *
 * 安全边界（ADR-0013 additive）：
 * - `rootId` 只是一个**枚举标识**，不是目标路径；工具入参绝不收任意绝对路径；
 * - WebView 侧只从 `workspace_roots` 这个只读真源枚举出根，再按 rootId 反查；
 * - 第四张表 `approvedRootIds` 默认空 ⇒ 任何 rootId 都不可用（默认拒绝不变）；
 * - 落盘仍过原有双闸：`approvedRoots` 相对前缀复核 + 内核 / Rust 写允许域；
 *   即便 WebView 被替换成把 rootId 映射到任意路径，第二闸照样拒绝（不新建写通道）。
 */
const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/** 统一分隔符 / 去尾斜杠，避免同一根因写法不同算出两个标识（不做大小写折叠）。 */
export function normalizeRootForId(rootAbs: string): string {
  const unified = rootAbs.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows 盘符保留原样；UNC 以 // 开头，去掉尾斜杠后仍是 //server/share。
  return unified;
}

/** 根绝对路径 → 稳定枚举标识（FNV-1a 32 位，UTF-8 字节流）。 */
export function rootIdOf(rootAbs: string): string {
  const bytes = new TextEncoder().encode(normalizeRootForId(rootAbs));
  let hash = FNV_OFFSET_32 >>> 0;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME_32) >>> 0;
  }
  return `ws:${hash.toString(16).padStart(8, '0')}`;
}

/** rootId 形状闸：Rust 端点与 TS 批准面同尺（只收 8 位小写十六进制）。 */
export const ROOT_ID_SHAPE = /^ws:[0-9a-f]{8}$/;

export function isRootIdShape(value: unknown): value is string {
  return typeof value === 'string' && ROOT_ID_SHAPE.test(value);
}

/** 从只读真源读数里按 rootId 反查根；找不到 ⇒ null（绝不猜测 / 绝不退回项目根）。 */
export function findRootById(
  roots: readonly unknown[],
  rootId: string,
): string | null {
  for (const raw of roots) {
    if (typeof raw !== 'string') continue;
    if (rootIdOf(raw) === rootId) return raw;
  }
  return null;
}
