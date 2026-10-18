/**
 * 本 adapter 的 overlay 贡献 id（`ui.overlay` 命名空间归各游戏自己）。
 *
 * 共享层只提供窗口实现；两个 adapter 注册同名 id 会互相顶掉，所以 id 必须
 * 各自持有。命名空间前缀用本游戏的 gameId，一眼能看出是谁家的浮层。
 */

/** 新建口上项目 */
export const NEW_KOJO_PROJECT_OVERLAY_ID = 'eraakumamaid.newKojoProject';
/** 导入为我的口上项目 */
export const IMPORT_KOJO_OVERLAY_ID = 'eraakumamaid.importKojoProject';
/** 部署到游戏目录 */
export const DEPLOY_KOJO_OVERLAY_ID = 'eraakumamaid.deployKojoPackage';
/** 发布到口上库 */
export const PUBLISH_KOJO_OVERLAY_ID = 'eraakumamaid.publishKojo';
