/**
 * Kojo 2.0 项目文件身份（M2-P1 宿主入口）。
 *
 * core 的 Project IR 只接收已经算好的 `pathKey` / `contentHash` 事实；本模块负责把它们
 * **从现有宿主工具产出来**，确保不出现第二套口径：
 * - `pathKey` 复用 `@kojo/plugin-api`（平台感知：Windows 折叠大小写，POSIX 保留大小写）；
 * - `contentHash` 复用 `@kojo/plugin-api` 的 `stableHash(document.text)`；
 * - `fileId` / `theaterId` 的组合归 core 的 `project/identity`。
 */
import type { ProjectFileIdentity } from '@kojo/kojo-core';
import { createProjectFileIdentity } from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';

/** 从一 triples（路径、正文、layer）生成项目文件身份；layerId 缺省 = 基座层 */
export function kojo2ProjectFileIdentity(
  path: string,
  text: string,
  layerId?: string | null,
): ProjectFileIdentity {
  return createProjectFileIdentity(path, pathKey(path), layerId ?? null, stableHash(text));
}