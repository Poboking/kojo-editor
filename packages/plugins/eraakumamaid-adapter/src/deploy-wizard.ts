/**
 * 部署向导（eraAkumaMaid 的接线薄层）：窗口与落点解析都在共享层（只读
 * `GameProject.charaIndex` / `kojoDir`，与本游戏的名字体系无关）。
 */

export { createDeployKojoWizard } from '@kojo/kojo-project-kit';
export type {
  DeployKojoWizardDeps,
  DeployTarget,
  DeployTargetOk,
  PendingDeploy,
} from '@kojo/kojo-project-kit';
export { DEPLOY_KOJO_OVERLAY_ID } from './overlay-ids';
