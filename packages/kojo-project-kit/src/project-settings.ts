/**
 * 项目删除 / 项目设置的纯函数半边（P0-7b）。
 *
 * 面板只负责摆位与调 deps；文案、表单初值、patch 组装与重名校验都住在这里，
 * 于是"确认层说了什么"、"空值会不会覆盖原值"这类口径不必借道渲染器就能单测。
 *
 * 硬口径：**空值不是清空**——本批不做「清空」动作，未改动 / 空串 / 纯空白一律不写进 patch。
 * 项目名重名校验不在这里另造：面板复用 `projectNameProblem` + `sameRootProjectNames`
 * （重命名 / 复制批的既有口径），内核 `update` 仍会再判一次。
 */

import type { WorkspaceProject } from '@kojo/plugin-api';

/** 删除确认层文案（面板按这份摆位，不另抄一句） */
export interface DeleteProjectConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * 删除确认文案。正文必须同时说清两件事：删的是**哪个**项目、**连目录内容一起删且不可恢复**。
 * 名字为空（理论上不该出现）时退回「这个项目」，不让句子断在引号里。
 */
export function deleteProjectConfirm(name: string): DeleteProjectConfirmCopy {
  const shown = name.trim().length > 0 ? name.trim() : '这个项目';
  return {
    title: '删除项目',
    body: `将删除项目「${shown}」，连同文件夹内全部内容一起删除，且不可恢复。`,
    confirmLabel: '删除',
    cancelLabel: '取消',
  };
}

/**
 * 设置表单的初值快照：表单三格 + 项目 meta 的浅拷贝。
 *
 * `meta` 一并带着，组装 patch 时才能"只动 author / version，其余键原样保留"。
 * author / version 只认字符串值（新建向导写的就是 trim 后的字符串）；类型不符按未填处理，
 * **不兜底成字符串**——那等于把一个坏值洗成看起来正常的新值。
 */
export interface ProjectSettingsSnapshot {
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly meta: Record<string, unknown>;
}

/** 表单可编辑的三格 */
export interface ProjectSettingsForm {
  name: string;
  author: string;
  version: string;
}

/** `workspaces.update` 的 patch 形状（与内核契约一致；键不出现 = 不写） */
export interface ProjectSettingsPatch {
  name?: string;
  meta?: Record<string, unknown>;
}

export function projectSettingsInitial(
  project: Pick<WorkspaceProject, 'name' | 'meta'>,
): ProjectSettingsSnapshot {
  const meta = { ...(project.meta ?? {}) };
  return {
    name: project.name,
    author: typeof meta.author === 'string' ? meta.author : '',
    version: typeof meta.version === 'string' ? meta.version : '',
    meta,
  };
}

/**
 * 组装 `workspaces.update` 的 patch：**没有实际改动 ⇒ null**（面板据此直接收窗、不发写请求）。
 *
 * 三条过滤：
 * 1. 项目名 —— trim 后与初值相同 / 为空 ⇒ 不写（空串不许把原名洗掉）；
 * 2. 作者 / 版本 —— trim 后与初值相同 / 为空 ⇒ 不写；
 * 3. meta —— 以初值浅拷贝为基础，只覆盖真正变了的 author / version，其余键原样不动。
 */
export function buildProjectSettingsPatch(
  initial: ProjectSettingsSnapshot,
  next: ProjectSettingsForm,
): ProjectSettingsPatch | null {
  const patch: ProjectSettingsPatch = {};

  const name = next.name.trim();
  if (name.length > 0 && name !== initial.name.trim()) patch.name = name;

  const meta = { ...initial.meta };
  const author = next.author.trim();
  const version = next.version.trim();
  if (author.length > 0 && author !== initial.author.trim()) meta.author = author;
  if (version.length > 0 && version !== initial.version.trim()) meta.version = version;
  if (meta.author !== initial.meta.author || meta.version !== initial.meta.version) patch.meta = meta;

  return patch.name === undefined && patch.meta === undefined ? null : patch;
}
