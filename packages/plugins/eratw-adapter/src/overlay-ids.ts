/**
 * 本 adapter 的 overlay 贡献 id（`ui.overlay` 命名空间归各游戏自己）。
 *
 * 共享层（`@kojo/kojo-project-kit`）只提供窗口实现，不认任何游戏命名空间——
 * 两个 adapter 注册同名 id 会互相顶掉，所以 id 必须留在各 adapter 里。
 * **同一 id 只留一处真源**：面板按钮与 overlay 注册都从这里取。
 */

/** 新建口上项目 */
export const NEW_KOJO_PROJECT_OVERLAY_ID = 'eratw.newKojoProject';
/** 导入为我的口上项目 */
export const IMPORT_KOJO_OVERLAY_ID = 'eratw.importKojoProject';
/** 部署到游戏目录 */
export const DEPLOY_KOJO_OVERLAY_ID = 'eratw.deployKojoPackage';
/** 发布到口上库 */
export const PUBLISH_KOJO_OVERLAY_ID = 'eratw.publishKojo';
