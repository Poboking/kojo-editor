/**
 * 项目文件 / Theater 身份（M2-P1）。
 *
 * 口径（Contracts D10）：
 * - 文件身份用平台感知的 `pathKey`：Windows 折叠大小写，POSIX 保留大小写；
 * - 同一 layer 内 `pathKey` 唯一；layerId 非 null 时 `ProjectFileId` 必须把 layer 带进身份；
 * - `contentHash` 只用于变化检测/缓存，不参与身份比较；
 * - `TheaterId` = `ProjectFileId` + 源文件内 ordinal，ordinal 不是运行时排序。
 *
 * 分层：
 * - 本模块只做**身份组合**（pathKey + layerId → fileId；fileId + ordinal → theaterId）；
 * - raw path → pathKey 与 text → contentHash 在宿主/项目入口完成（复用
 *   `@kojo/plugin-api` 的 `pathKey` / `stableHash`），core 不另抄平台归一化或哈希实现。
 */

export type ProjectFileId = string;
export type TheaterId = string;

/** percent-encoding 让 layerId / pathKey 里的分隔符不能制造身份碰撞 */
function encodeIdentityPart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * `ProjectFileId`：layerId 为 null 时只由 `pathKey` 决定；有 layer 时把 layer 也带进身份。
 * 格式是稳定的实现细节，不对 UI 暴露为显示路径。
 */
export function projectFileId(pathKey: string, layerId: string | null): ProjectFileId {
  if (layerId === null) return `file:${encodeIdentityPart(pathKey)}`;
  return `file:${encodeIdentityPart(layerId)}:${encodeIdentityPart(pathKey)}`;
}

/** `TheaterId`：文件身份 + 源文件内 ordinal（ordinal 从 0 起，只做稳定指认） */
export function projectTheaterId(fileId: ProjectFileId, ordinal: number): TheaterId {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`[project-identity] Theater ordinal 必须是非负整数（收到 ${String(ordinal)}）`);
  }
  return `theater:${encodeIdentityPart(fileId)}:${ordinal}`;
}

/**
 * 一份文件在项目内的完整身份事实。
 *
 * `path` 保留宿主给的显示/原始路径；身份判等只看 `pathKey` + `layerId`。
 * `contentHash` 是变化检测事实，不参与 `fileId` / `theaterId`。
 */
export interface ProjectFileIdentity {
  readonly path: string;
  readonly pathKey: string;
  readonly layerId: string | null;
  readonly fileId: ProjectFileId;
  readonly contentHash: string;
}

/**
 * 组合宿主已算好的身份事实。
 *
 * 不在 core 内接收 raw path 或 text：`pathKey` 与 `contentHash` 必须由项目入口用
 * `@kojo/plugin-api` 的同一实现产出，避免 core 出现第二套平台路径/哈希口径。
 */
export function createProjectFileIdentity(
  path: string,
  pathKey: string,
  layerId: string | null,
  contentHash: string,
): ProjectFileIdentity {
  return {
    path,
    pathKey,
    layerId,
    fileId: projectFileId(pathKey, layerId),
    contentHash,
  };
}