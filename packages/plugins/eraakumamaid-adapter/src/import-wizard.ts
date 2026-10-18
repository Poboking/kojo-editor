/**
 * 导入向导（eraAkumaMaid 的接线薄层）：窗口在共享层，id 归本 adapter。
 */

export { buildImportMeta, createImportKojoWizard } from '@kojo/kojo-project-kit';
export type { ImportKojoWizardDeps, PendingImport } from '@kojo/kojo-project-kit';
export { IMPORT_KOJO_OVERLAY_ID } from './overlay-ids';
