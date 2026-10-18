/**
 * 新建口上项目向导（eraAkumaMaid 的接线薄层）。
 *
 * 窗口实现在共享层 `@kojo/kojo-project-kit`；本文件只接**本游戏的供数**：
 * - 脚手架：`ERB/EVENT_K/<n>/*.kojo` + `CSV/CHARA/CHARA<n>.csv`（游戏根相对路径）；
 * - **没有「剧本号」**（本游戏无多剧本编号）⇒ `extraFields` 不给，
 *   共享向导因此连那一行都不渲染；
 * - 核心面数取自本游戏的文件规格表，不写死数字。
 */

import type { ScaffoldFileSet } from '@kojo/plugin-api';
import type { KojoScaffoldDraft, NewKojoProjectWizardDeps } from '@kojo/kojo-project-kit';
import { AM_SCAFFOLD_FILES, scaffoldErakumamaidProject } from './scaffold';
import { NEW_KOJO_PROJECT_OVERLAY_ID } from './overlay-ids';

export {
  buildCreateInput,
  buildTemplateImportInput,
  charaOptionLabel,
  createNewKojoProjectWizard,
  defaultWorkspaceRoot,
  listMarketTemplates,
  locationLabel,
  noKojoDirWarning,
  readRequestToken,
  templateKey,
  templatePreviewLine,
  templateSourceChoices,
} from '@kojo/kojo-project-kit';
export type {
  KojoProjectCreateInput,
  KojoScaffoldDraft,
  KojoTemplateEntry,
  NewKojoProjectWizardDeps,
  TemplateSourceChoice,
  WizardSelectField,
} from '@kojo/kojo-project-kit';
export { NEW_KOJO_PROJECT_OVERLAY_ID } from './overlay-ids';

/** 共享向导需要的游戏侧供数 */
export const AM_SCAFFOLD_DEPS = {
  scaffold(draft: KojoScaffoldDraft): ScaffoldFileSet {
    return scaffoldErakumamaidProject({
      workName: draft.workName,
      authorName: draft.authorName,
      version: draft.version,
      charaNo: draft.charaNo,
      charaName: draft.charaName,
    });
  },
  coreFaceCount: AM_SCAFFOLD_FILES.length,
  /**
   * 本游戏**没有**「剧本号」这类附加字段 ⇒ 这个键不出现。
   * （显式写成 `[]` 也行，但那会让「本游戏没有」和「本游戏有但为空」看起来一样。）
   */
} as const;

/** 供 `plugin.ts` 组装配件用：把本 adapter 的供数并进共享向导的 deps */
export function withAmScaffold(
  deps: Omit<NewKojoProjectWizardDeps, 'scaffold' | 'coreFaceCount' | 'extraFields' | 'previewNote'>,
): NewKojoProjectWizardDeps {
  return { ...deps, ...AM_SCAFFOLD_DEPS };
}
