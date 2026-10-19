/**
 * 口上项目工作流的共享实现（游戏无关）。
 *
 * 分层判据只有一条：**去掉游戏名词还成立吗**。
 * - 成立 ⇒ 住这里（署名识别、制品计划、许可条款、目录消毒、四个向导、项目面板）；
 * - 不成立 ⇒ 留在 adapter，经各向导的 `deps` 注入（面清单、分野表模板、角色名表、
 *   模板包来源、部署落点规则）。
 *
 * 这里**不得**出现任何具体游戏名（`tools/audit-decoupling.mjs` 的 A 项已把本目录
 * 收编进零游戏名词区）。
 */

/* ---- 署名 / 授权（读 README 与 pack.json，认「这是谁的作品」） ---- */
export {
  attributionMeta,
  attributionSummary,
  authorCandidateNotice,
  classifyAuxFile,
  licenseLabel,
  mergePackAuthorship,
  packManifestPathOf,
  parseAttributionText,
  parsePackAuthorship,
  readPackageAttribution,
  readPackageAttributionFromFiles,
  readPackAuthorship,
  readSourceAttribution,
} from './attribution';
export type {
  AttributionField,
  AttributionState,
  AuxFileKind,
  InMemoryAuxFile,
  LicenseSignal,
  PackageAttribution,
  PackAuthorship,
} from './attribution';

/* ---- 制品计划（`.kojo` 内存转译 + 派生物判等，永不改工作区） ---- */
export { isKojoSource, planArtifacts, readPackageSources, toRelPath } from './artifact';
export type {
  ArtifactEntry,
  ArtifactPlan,
  ArtifactSource,
  IgnoredDerivedArtifact,
  KojoCompiler,
} from './artifact';

/* ---- 许可条款（era 社区通行的几份；纯数据 + 渲染） ---- */
export { buildLicenseText, LICENSE_CHOICES, LICENSE_FILE_NAME, licenseProducesFile } from './licenses';
export type { LicenseFields, LicenseKind } from './licenses';

/* ---- 新建条目（面板右键菜单的命名与落点） ---- */
export { NEW_ITEM_MENU, newItemPreviewName, resolveNewItemPath } from './new-item';
export type { NewItemKind, NewItemResolution } from './new-item';

/* ---- 部署（落点解析 + 字节级落盘；只读 `GameProject` 契约） ---- */
export { deployPackage, resolveDeployTarget } from './deploy';
export type { DeployTarget, DeployTargetOk, PendingDeploy } from './deploy';

/* ---- 向导（`ui.overlay` 的组件半边；overlay id 归各 adapter） ---- */
export { createDeployKojoWizard } from './deploy-wizard';
export type { DeployKojoWizardDeps } from './deploy-wizard';
export { buildImportMeta, createImportKojoWizard } from './import-wizard';
export type { ImportKojoWizardDeps, PendingImport } from './import-wizard';

/* ---- 新建向导（脚手架本身由 adapter 经 `deps.scaffold` 注入） ---- */
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
} from './new-project-wizard';
export type {
  KojoProjectCreateInput,
  KojoScaffoldDraft,
  KojoTemplateEntry,
  NewKojoProjectWizardDeps,
  TemplateSourceChoice,
  WizardSelectField,
} from './new-project-wizard';

/* ---- 发布向导 + 发布纯函数（包 id / 版本 / 许可投影 / 进度文案） ---- */
export { createPublishKojoWizard, ignoredDerivedNote, ZIP_ENTRY_COPY } from './publish-wizard';
export type { PublishKojoWizardDeps } from './publish-wizard';
export {
  buildPublishDraft,
  defaultPackId,
  draftDefaults,
  draftFilesOf,
  formatBytes,
  licenseHintOf,
  licenseLabelOf,
  licenseNameOf,
  licenseOptions,
  normalizeVersion,
  packIdProblem,
  PACK_ID_PREFIX,
  progressLabel,
  progressPercent,
  publishCapabilityNote,
  publishCapabilityOf,
  readableLicenseKind,
  slugifyProjectId,
  versionProblem,
  zipBaseName,
  zipPublishDefaults,
} from './publish-pack';
export type {
  LicenseOption,
  PublishCapability,
  PublishDraftDefaults,
  PublishDraftInput,
  ZipPublishSource,
} from './publish-pack';

/* ---- 项目面板 + 包操作（工作区视角的唯一入口；全部 deps 注入） ---- */
export {
  artifactDir,
  clampTutorialHeight,
  createKojoProjectsPanel,
  factsFromMeta,
  looseProjectDirs,
  packageFacts,
  sortDirEntries,
  TUTORIALS_MIN_H,
} from './projects-panel';
export type { DirListState, FactsInput, KojoProjectsPanelDeps } from './projects-panel';
export { buildPackageZip, createPackageActions, STATUS_OK_DISMISS_MS } from './package-actions';
export type { PackageActions, PackageActionsDeps, PanelStatus, PanelStatusKind } from './package-actions';

/* ---- 脚手架落盘（`GameAdapter.scaffold?()` 的实现半边） ---- */
export { writeScaffoldFiles } from './scaffold-writer';
export type { WriteScaffoldInput } from './scaffold-writer';

/* ---- 教程语义 id（内容由各 adapter 提供） ---- */
export type { TutorialId } from './tutorial';

/* ---- 外部改动归属（`file.changed` → 该重列哪个目录；只认路径形状） ---- */
export { workspaceChangeOf } from './watch-scope';
export type { WorkspaceChange } from './watch-scope';

/* ---- 检索范围（`search.scope` 槽的候选投影；判据是契约字段 `kojoDir`） ---- */
export { charaSearchScopeOptions } from './search-scope';
