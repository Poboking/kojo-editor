/**
 * 发布到口上库向导（本 adapter 的接线薄层）。
 *
 * 窗口与发布纯函数都住在共享层 `@kojo/kojo-project-kit`（口上创作领域知识，
 * 不属任何单一游戏）；这里只钉住本 adapter 的 overlay 命名空间。
 */

export { createPublishKojoWizard, ignoredDerivedNote, ZIP_ENTRY_COPY } from '@kojo/kojo-project-kit';
export type { PublishKojoWizardDeps } from '@kojo/kojo-project-kit';
export { PUBLISH_KOJO_OVERLAY_ID } from './overlay-ids';
