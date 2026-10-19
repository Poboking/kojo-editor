/**
 * 新建口上项目向导（本 adapter 的接线薄层）。
 *
 * 窗口实现在共享层 `@kojo/kojo-project-kit`（游戏无关）；这里把它需要的
 * **游戏侧供数**接上本 adapter 的脚手架，并钉住本 adapter 的 overlay 命名空间。
 */

import type { ScaffoldFileSet } from '@kojo/plugin-api';
import type {
  KojoScaffoldDraft,
  NewKojoProjectWizardDeps,
  WizardSelectField,
} from '@kojo/kojo-project-kit';
import { KOJO_LANG_DOC_CHOICES, withKojoLangDocs } from '@kojo/kojo-project-kit';
import { CORE_FACES, scaffoldKojoProject } from './scaffold';
import { NEW_KOJO_PROJECT_OVERLAY_ID } from './overlay-ids';

export {
  buildCreateInput,
  buildTemplateImportInput,
  charaOptionLabel,
  composeScaffoldDraft,
  createNewKojoProjectWizard,
  defaultWorkspaceRoot,
  listMarketTemplates,
  locationLabel,
  noKojoDirWarning,
  readRequestToken,
  scaffoldPreviewLine,
  templateKey,
  templatePreviewLine,
  templateSourceChoices,
} from '@kojo/kojo-project-kit';
export type {
  KojoLangDoc,
  KojoLangDocChoice,
  KojoProjectCreateInput,
  KojoScaffoldDraft,
  KojoTemplateEntry,
  NewKojoProjectWizardDeps,
  TemplateSourceChoice,
  WizardSelectField,
} from '@kojo/kojo-project-kit';
export { NEW_KOJO_PROJECT_OVERLAY_ID } from './overlay-ids';

/**
 * 本游戏的「剧本号」下拉（eraTW 的多剧本编号，1-10）。
 *
 * 共享向导不认识这一栏——`extraFields` 说它有，它才出现；值原样进制品 meta
 * 与脚手架输入。
 */
export const ERATW_EXTRA_FIELDS: readonly WizardSelectField[] = [
  {
    key: 'scriptNo',
    label: '剧本号',
    options: Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `剧本${i + 1}` })),
    defaultValue: 1,
  },
];

/**
 * 本游戏的脚手架供数（面清单 / 案例 / 许可全在 `./scaffold`）。
 *
 * 语言档（NEW-ERB 2026-10-20）：**随这枚函数声明**，不新开 `deps` 字段——
 * "本游戏支持哪几种起手写法"本来就是脚手架自己的事，而各 adapter 的组装点
 * （`plugin.ts`）已经在转这枚函数，零接线改动就能让这一行出现；没有声明的游戏
 * 连控件都不出现，草稿里也不带 `langDoc` 键（老产物逐字节不变）。
 */
const eratwScaffold = (draft: KojoScaffoldDraft): ScaffoldFileSet =>
  scaffoldKojoProject({
    workName: draft.workName,
    authorName: draft.authorName,
    version: draft.version,
    charaNo: draft.charaNo,
    charaName: draft.charaName,
    // 表单已按 ERATW_EXTRA_FIELDS 收集；缺省回落 1（与脚手架自身的兜底一致）
    scriptNo: draft.extra.scriptNo ?? 1,
    license: draft.license,
    // 未声明语言档 ⇒ 草稿没有这个键 ⇒ 缺省糖档（与改前逐字相同的行为）
    langDoc: draft.langDoc,
  });

/** 共享向导需要的游戏侧供数（脚手架 + 面数 + 剧本号 + 预览补充说明） */
export const ERATW_SCAFFOLD_DEPS = {
  scaffold: withKojoLangDocs(eratwScaffold, KOJO_LANG_DOC_CHOICES),
  coreFaceCount: CORE_FACES.length,
  extraFields: ERATW_EXTRA_FIELDS,
  /** eraTW 的四件套（登记 / 配色 / 开关 / 立绘定义）是函数级产物，脚手架不生成 */
  previewNote: '不含四件套，也不含活函数',
} as const;

/** 供 `plugin.ts` 组装配件用：把本 adapter 的供数并进共享向导的 deps */
export function withEratwScaffold(
  deps: Omit<NewKojoProjectWizardDeps, 'scaffold' | 'coreFaceCount' | 'extraFields' | 'previewNote'>,
): NewKojoProjectWizardDeps {
  return { ...deps, ...ERATW_SCAFFOLD_DEPS };
}

// 目录名与消毒规则由契约层提供；此处转出只是为了让既有导入路径不断
export { buildScaffoldDirName, sanitizePathSegment } from '@kojo/plugin-api';
