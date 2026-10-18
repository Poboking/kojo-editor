/**
 * 部署向导（本 adapter 的接线薄层）。
 *
 * 窗口实现在共享层 `@kojo/kojo-project-kit`（游戏无关）；这里只钉住本 adapter
 * 的 overlay 命名空间，并把组件与类型原样转出——既有 `./deploy-wizard`
 * 导入路径因此零改动。
 */

export { createDeployKojoWizard } from '@kojo/kojo-project-kit';
export type { DeployKojoWizardDeps, DeployTarget, DeployTargetOk, PendingDeploy } from '@kojo/kojo-project-kit';
export { DEPLOY_KOJO_OVERLAY_ID } from './overlay-ids';
