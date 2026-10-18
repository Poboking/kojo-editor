/**
 * 导入向导（本 adapter 的接线薄层）。
 *
 * 窗口实现在共享层 `@kojo/kojo-project-kit`（游戏无关）；这里只钉住本 adapter
 * 的 overlay 命名空间，并把组件与纯函数原样转出——既有 `./import-wizard`
 * 导入路径因此零改动。
 */

export { buildImportMeta, createImportKojoWizard } from '@kojo/kojo-project-kit';
export type { ImportKojoWizardDeps, PackageAttribution, PendingImport } from '@kojo/kojo-project-kit';
export { IMPORT_KOJO_OVERLAY_ID } from './overlay-ids';
