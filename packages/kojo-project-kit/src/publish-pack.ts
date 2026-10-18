/**
 * 「发布口上」的**纯函数半边**（用户反馈 4 批；零 IO、零 React，可单测）。
 *
 * ## 为什么住共享层
 *
 * 「发布口上」= 把**作者工作区里的一个口上包**现打成市场容器。项目 / 包 / 许可这些
 * 概念是口上创作领域的知识（**不属任何单一游戏**），市场服务只收泛型的 `MarketPackDraft`；
 * 于是"从工作区取什么、默认填什么、许可写哪个字面量"全部收在这一层——组件只画界面，
 * 判据全在这里，node 里能直测。
 *
 * ## 与向导的分工
 *
 * - 本文件：版本补段、包 id 默认与校验、默认字段提取、许可投影、制品计划 → 草案文件、
 *   进度文案、能力判别。**全部纯函数**；
 * - `publish-wizard.ts`：hooks + 元素树 + 调服务，不放任何判定（它渲不出来，也测不了）。
 *
 * ## 版本口径
 *
 * 包版本走市场契约的**严格三段**（`PACK_VERSION_RE`）。作者的 `artifact.meta.version`
 * 常是 `1.0`（新建向导的默认值）或 `2`，于是默认值由 `normalizeVersion` 补成三段；
 * 补不出来的（如 `beta`）原样留空，让必填校验挡住——**不替作者猜一个版本号**。
 */

import {
  PACK_ID_RE,
  PACK_VERSION_RE,
  VERSION_SEG_RE,
  basename,
  coreVersion,
  type MarketPackDraft,
  type MarketPackDraftFile,
  type MarketPublishProgress,
  type MarketService,
  type MarketZipFile,
  type WorkspaceArtifact,
  type WorkspaceProject,
} from '@kojo/plugin-api';
import type { PackageAttribution } from './attribution';
import type { ArtifactPlan } from './artifact';
import { LICENSE_CHOICES, type LicenseKind } from './licenses';

/** 包 id 的前缀（默认 id = `kojo.<项目 id>.<包序号>`；`kojo` 是跨游戏共享术语） */
export const PACK_ID_PREFIX = 'kojo';

/** 市场契约的包 id 长度上限（`PACK_ID_RE` 的 `{0,63}` + 首字符 = 64） */
const PACK_ID_MAX_LENGTH = 64;

/**
 * 把作者写的版本补成市场要的三段（`1.0` → `1.0.0`，`1` → `1.0.0`）。
 *
 * 口径：
 * - 预发布后缀先剥掉（`1.2.3-beta.1` → `1.2.3`，与安装面 `coreVersion` 同一条）；
 * - 只接受 1–3 段纯数字；段数与数字形态任一不合格 ⇒ `''`（**不猜**，交给必填校验）；
 * - 每段沿用契约的 `VERSION_SEG_RE` 口径（≤ 9 位数字）。
 */
export function normalizeVersion(raw: string): string {
  const core = coreVersion(raw.trim());
  if (core.length === 0) return '';
  const parts = core.split('.');
  if (parts.length > 3) return '';
  const nums: string[] = [];
  for (const part of parts) {
    // 段形口径与契约同源（VERSION_SEG_RE：纯数字、≤ 9 位）；不在此另写一份正则
    if (!VERSION_SEG_RE.test(part)) return '';
    nums.push(part);
  }
  while (nums.length < 3) nums.push('0');
  return nums.join('.');
}

/**
 * 项目 id → 包 id 里可用的 slug（小写 + 只留 `[a-z0-9._-]`，首字符必须是字母数字）。
 *
 * 工作区项目 id 是内核生成的（`p<base36>-<rand>`），天然合规；这里仍做一次消毒，
 * 是因为**老版本工作区 / 手工改过的 manifest** 里可能躺着任意 id——默认值不能因为
 * 一个历史 id 就变成一个红着脸的非法值。消毒后为空 ⇒ `project`（保住默认值可用）。
 */
export function slugifyProjectId(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-');
  const trimmed = replaced.replace(/^[^a-z0-9]+/, '').replace(/[._-]+$/, '');
  return trimmed.length > 0 ? trimmed : 'project';
}

/**
 * 默认包 id：`kojo.<项目 id>.<包序号>`（序号 1 基）。
 *
 * 总长压进契约的 64 字符闸（超长项目 id 截断 slug）；序号随包在项目里的位置走，
 * 同一项目里不同包默认不撞名。作者可改，最终以 `PACK_ID_RE` 为准。
 */
export function defaultPackId(projectId: string, artifactIndex: number): string {
  const ordinal = Number.isFinite(artifactIndex) && artifactIndex >= 0 ? Math.floor(artifactIndex) + 1 : 1;
  const suffix = `.${ordinal}`;
  const room = Math.max(1, PACK_ID_MAX_LENGTH - PACK_ID_PREFIX.length - 1 - suffix.length);
  const slug = slugifyProjectId(projectId).slice(0, room);
  return `${PACK_ID_PREFIX}.${slug}${suffix}`;
}

/** 包 id 的**人话**提示（空 = 合法）；判据就是契约的 `PACK_ID_RE`，不另立一套 */
export function packIdProblem(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return '包 id 不能为空';
  if (!PACK_ID_RE.test(trimmed)) {
    return '包 id 只允许小写字母 / 数字 / . / _ / -，且首字符必须是字母或数字（总长 ≤ 64）';
  }
  return null;
}

/** 包版本的人话提示（空 = 合法）；判据就是契约的 `PACK_VERSION_RE` */
export function versionProblem(version: string): string | null {
  const trimmed = version.trim();
  if (trimmed.length === 0) return '版本不能为空（形如 1.0.0）';
  if (!PACK_VERSION_RE.test(trimmed)) {
    return '版本必须是三段数字，如 1.0.0（写 1.0 或 1 会被自动补成三段）';
  }
  return null;
}

/** 从 `meta` 里取一个非空字符串（类型不对 / 空白 ⇒ `''`，不猜） */
function metaString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 许可下拉的一项（`LICENSE_CHOICES` 的**唯一投影**；组件与测试都从这里取） */
export interface LicenseOption {
  value: LicenseKind;
  label: string;
  hint: string;
}

/** 许可选项（顺序 = `LICENSE_CHOICES` 的顺序，不在此重排） */
export function licenseOptions(): LicenseOption[] {
  return LICENSE_CHOICES.map((c) => ({ value: c.kind, label: c.label, hint: c.hint }));
}

/** 选中许可的一句话说明（查不到 ⇒ `''`，界面据此不显示空行） */
export function licenseHintOf(kind: LicenseKind): string {
  return LICENSE_CHOICES.find((c) => c.kind === kind)?.hint ?? '';
}

/** 选中许可在界面上的名字（下拉项 label 原样） */
export function licenseLabelOf(kind: LicenseKind): string {
  return LICENSE_CHOICES.find((c) => c.kind === kind)?.label ?? '';
}

/**
 * 写进 `pack.json.license` 的许可名。
 *
 * 不能直接拿下拉 label：`none` / `template` 的 label 是给作者的操作说明
 * （"不生成 LICENSE 文件" / "创建后自填条款"），不是一份许可的名字；原样写进
 * 清单会让市场把它当成条款名展示。其余选项的 label 本身就是协议名，沿用。
 */
export function licenseNameOf(kind: LicenseKind): string {
  switch (kind) {
    case 'none':
      return '保留所有权利（未生成 LICENSE 文件）';
    case 'template':
      return '自定义条款（见 LICENSE）';
    default:
      return licenseLabelOf(kind);
  }
}

/**
 * 制品 meta 里的 `licenseKind` 收窄（导入的包带着原作者选择的协议；非本表取值 ⇒ `null`，
 * 不拿一个陌生字符串冒充许可种类）。**只用于预选下拉**，不参与发布判定。
 */
export function readableLicenseKind(value: unknown): LicenseKind | null {
  if (typeof value !== 'string') return null;
  return LICENSE_CHOICES.find((c) => c.kind === value)?.kind ?? null;
}

/** 表单默认值（选包切换时整体重置；作者改过的字段不跨包残留） */
export interface PublishDraftDefaults {
  name: string;
  id: string;
  version: string;
  author: string;
  summary: string;
  licenseKind: LicenseKind;
}

/**
 * 从项目 / 包元数据提取默认值：
 * - `name` = 包名（空白回落目录名）；
 * - `id` = `kojo.<项目 id>.<包序号>`；
 * - `version` = 包 meta 的 version → 项目 meta 的 version → `1.0.0`（补成三段）；
 *   包 meta **写了却补不出三段** ⇒ 留空（不拿项目版本冒充，否则声明与产物是两个数）；
 * - `author` = **项目** meta 的 author（取不到留空：必填项，由作者自己填——不拿
 *   原作者的署名冒充发布者）；
 * - `summary` = 空（可选，不硬塞）；
 * - `licenseKind` = 包 meta 里的许可种类（导入包的原作者选择），否则 `none`。
 */
export function draftDefaults(
  project: WorkspaceProject,
  artifact: WorkspaceArtifact,
  artifactIndex: number,
): PublishDraftDefaults {
  const artifactVersion = metaString(artifact.meta, 'version');
  // 包 meta **写了但写坏了**（如 `beta`）⇒ 留空让作者改；不拿项目版本冒充——
  // 那会让"包自己声明的版本"和"发出去的版本"变成两个数。
  const version =
    artifactVersion.length > 0
      ? normalizeVersion(artifactVersion)
      : normalizeVersion(metaString(project.meta, 'version')) || '1.0.0';
  const name = artifact.name.trim();
  return {
    name: name.length > 0 ? name : artifact.dirName,
    id: defaultPackId(project.id, artifactIndex),
    version,
    author: metaString(project.meta, 'author'),
    summary: '',
    licenseKind: readableLicenseKind(artifact.meta.licenseKind) ?? 'none',
  };
}

/** 普通作品包 zip 的来源（`inspectZip` 结果里与默认值相关的两部分） */
export interface ZipPublishSource {
  readonly files: readonly MarketZipFile[];
  readonly strippedRoot?: string;
}

/** zip 文件名去掉 `.zip`（大小写不敏感；只剩扩展名时回退 `zip`） */
export function zipBaseName(zipPath: string): string {
  const name = basename(zipPath);
  const base = name.replace(/\.zip$/i, '').trim();
  return base.length > 0 ? base : 'zip';
}

/**
 * 普通作品包 zip 的发布默认值：
 * - `name` = 自动剥掉的单层包裹目录名，否则 zip 文件名；
 * - `id` = `kojo.<slug>.1`（slug 由 `zip-<name>` 消毒；纯日文名会退化成 `zip`，仍合法可改）；
 * - `version` = `1.0.0`（老 zip 没有可靠版本字段，不猜）；
 * - `author` = README **高置信**署名（标题式候选不自动采用，留空让作者确认）；
 * - `licenseKind` = 只有空模板时预选 `template`，其余 `none`（不替作者猜协议）。
 */
export function zipPublishDefaults(
  zipPath: string,
  source: ZipPublishSource,
  attribution: PackageAttribution | null,
): PublishDraftDefaults {
  const base = source.strippedRoot ?? zipBaseName(zipPath);
  return {
    name: base,
    id: defaultPackId(`zip-${base}`, 0),
    version: '1.0.0',
    author: attribution?.author?.value ?? '',
    summary: '',
    licenseKind: attribution?.license.kind === 'template-only' ? 'template' : 'none',
  };
}

/**
 * 制品计划 → 草案文件（**只换形状，不读盘、不改字节**）。
 *
 * `planArtifacts` 已经完成 `.kojo` → `.ERB` 转译与 fail-closed（任一失败整包不产），
 * 这里只把 `relPath`（posix、相对包目录）与字节搬进 `MarketPackDraftFile`。
 * 空包直接抛：`packFilesProblem([])` 是合法的，但"发一个空包"没有任何意义，
 * 让作者在上传前就听到一句人话，而不是等服务端拒。
 */
export function draftFilesOf(plan: Pick<ArtifactPlan, 'entries'>): MarketPackDraftFile[] {
  if (plan.entries.length === 0) {
    throw new Error('这个包里没有可发布的文件（先把口上文件写进包里，再发布）。');
  }
  return plan.entries.map((entry) => ({ path: entry.relPath, bytes: entry.bytes }));
}

/** 表单里参与装配的字段（组件状态机与纯函数的分界；`licenseKind` 在这一步转 label） */
export interface PublishDraftInput {
  packId: string;
  version: string;
  name: string;
  author: string;
  licenseKind: LicenseKind;
  redistribute: boolean;
  summary?: string;
}

/**
 * 组装 `MarketPackDraft`（市场服务唯一的输入形状）。
 *
 * - 所有字符串去首尾空白；
 * - `license` = 许可名（`licenseNameOf`；契约口径：作者面许可名字面量，不是操作说明）；
 * - `summary` 只在非空时出现（空串 = 作者没填，不是"填了一个空"）；
 * - `minAppVersion` **不写**：缺省由服务注入的 appVersion 派生（版本号真源只在应用清单）。
 */
export function buildPublishDraft(
  input: PublishDraftInput,
  files: readonly MarketPackDraftFile[],
): MarketPackDraft {
  const summary = input.summary?.trim() ?? '';
  return {
    kind: 'kojo-pack',
    id: input.packId.trim(),
    version: input.version.trim(),
    name: input.name.trim(),
    author: input.author.trim(),
    license: licenseNameOf(input.licenseKind),
    redistribute: input.redistribute,
    ...(summary.length > 0 ? { summary } : {}),
    files,
  };
}

/** 上传进度百分比（0–100 整数；总字节未知/非正 ⇒ 0，不除零） */
export function progressPercent(p: MarketPublishProgress): number {
  if (!Number.isFinite(p.totalBytes) || p.totalBytes <= 0) return 0;
  const pct = Math.floor((p.sentBytes / p.totalBytes) * 100);
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

/** 字节数的人话（口上包多在几百 KB 量级，纯 MB 会全显示成 0.00） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 进度行文案（百分比 + 已发/总量）；`totalBytes` 为 0 时只报已发，不画假百分比 */
export function progressLabel(p: MarketPublishProgress): string {
  const sent = formatBytes(p.sentBytes);
  return p.totalBytes > 0
    ? `正在上传：${progressPercent(p)}%（${sent} / ${formatBytes(p.totalBytes)}）`
    : `正在上传：已发送 ${sent}`;
}

/**
 * 发布能力的**静态**三态（不含"平台没有桌面壳"——那只有调用时才知道，由服务抛的
 * 人话呈现）：
 * - `ready`：市场服务在位且实现了 `publishPack`；
 * - `no-market`：市场插件未启用 / 取不到服务；
 * - `no-direct`：市场在位但没有 `publishPack`（旧版本服务）——此时"选 zip 发布"
 *   那条旧路径仍然可用，界面必须把它留着。
 */
export type PublishCapability = 'ready' | 'no-market' | 'no-direct';

export function publishCapabilityOf(market: MarketService | null): PublishCapability {
  if (market === null) return 'no-market';
  return typeof market.publishPack === 'function' ? 'ready' : 'no-direct';
}

/** 能力三态的人话说明（`ready` ⇒ `''`，界面不渲染空行） */
export function publishCapabilityNote(capability: PublishCapability): string {
  switch (capability) {
    case 'no-market':
      return '没有检测到「口上市场」插件：现在无法发布。请先启用「口上市场」，再回到这里重试。';
    case 'no-direct':
      return '当前「口上市场」版本较旧，还不支持从编辑器直接发布。请更新「口上市场」插件后再试；已经按市场格式打好的 zip（根 pack.json + files/**）仍可走下面的「选择 zip 文件…」。';
    case 'ready':
      return '';
  }
}
