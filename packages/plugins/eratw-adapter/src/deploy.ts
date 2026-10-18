/**
 * 部署到游戏目录（本 adapter 的接线薄层）。
 *
 * `resolveDeployTarget` / `deployPackage` 只依赖 `GameProject` 契约（`charaIndex` +
 * `kojoDir`）与制品计划，与哪个 era 游戏无关 ⇒ 实现住共享层；这里转出，
 * 既有 `./deploy` 导入路径零改动。
 */

export { deployPackage, resolveDeployTarget } from '@kojo/kojo-project-kit';
export type {
  DeployTarget,
  DeployTargetOk,
  // 共享层从制品计划转出的编译器形状（转译器由 kernel 服务提供）
  KojoCompiler,
  PendingDeploy,
} from '@kojo/kojo-project-kit';
