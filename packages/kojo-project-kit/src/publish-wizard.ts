/**
 * 「发布口上」引导向导（用户反馈 4 批；`ui.overlay` 贡献）。
 *
 * ## 链路
 *
 * 市场面板点「发布口上」→ 发内核语义事件 `market.publishRequested`（契约：
 * 「作者要发布」这一个意图，不带项目/包/许可）→ 本插件监听并打开本 overlay
 * （overlay id 由各 adapter 定义）→ 作者按步骤走：
 *
 * ① 选项目（工作区里的口上项目，显示包数量）
 * ② 选包（该项目里的制品；默认第一个）
 * ③ 包信息（名称 / 包 id / 版本 / 作者 / 简介；默认值从项目与包的元数据提取）
 * ④ 许可与分发（`LICENSE_CHOICES` 下拉 + 二次分发复选框）
 * ⑤ 内容与发布（打包说明 → 进度 → 终局：PR 链接 / 中文拒因，可改字段重试）
 *
 * 次要入口保留旧流程：「已有 zip？」→「选择市场格式 zip（高级）」→ `io.chooseFile`
 * （系统对话框即授权）+ `market.publish`；取消不报错。入口语义必须是**市场格式容器**
 * （根 `pack.json` + `files/**`）而非普通作品包 zip——后者选进来只会被预校验拒。
 *
 * ## 为什么打包也在这里（而不是让面板去拼）
 *
 * 包内容住在**作者工作区**（`kernel.workspaces` 的 project/artifact 模型），
 * `.kojo` → 成品的转译由编译服务提供、制品计划（`planArtifacts`）fail-closed 收口。
 * 于是"从哪个目录读、转译成什么、哪些字节进包"全在本层；市场只收泛型草案
 * （`MarketPackDraft`），补 `pack.json` / 算 sha256 / 打 zip / 上传都是它的活。
 *
 * ## 不弹 alert、不静默
 *
 * 无市场 / 旧版服务没有 `publishPack` / 平台没有桌面壳——三种都在界面上给中文说明；
 * 抛错保留窗口与已填字段，作者改完可以直接重试。
 */

import { createElement as h, useEffect, useMemo, useState } from 'react';
import {
  join,
  type FileIO,
  type MarketPublishOutcome,
  type MarketPublishProgress,
  type MarketService,
  type MarketZipFile,
  type WorkspaceProject,
  type WorkspaceService,
} from '@kojo/plugin-api';
import { planArtifacts, readPackageSources, type IgnoredDerivedArtifact, type KojoCompiler } from './artifact';
import {
  authorCandidateNotice,
  readPackageAttributionFromFiles,
  type PackageAttribution,
} from './attribution';
import type { LicenseKind } from './licenses';
import {
  buildPublishDraft,
  draftDefaults,
  draftFilesOf,
  formatBytes,
  licenseHintOf,
  licenseOptions,
  packIdProblem,
  progressLabel,
  publishCapabilityNote,
  publishCapabilityOf,
  versionProblem,
  zipPublishDefaults,
} from './publish-pack';

/**
 * zip 入口的三句文案（按钮 / 系统对话框标题 / 说明）。
 *
 * 2026-10-18 起同时收两类：
 * - **市场容器**（根 `pack.json` + `files/**`）→ 原样走 `publish(zipPath)`；
 * - **普通作品包**（老作者的 `.ERB` 包，根目录没有 `pack.json`）→ 解出内容、补包信息，
 *   现打市场容器后用同一条上传链发布。
 * 测试直接钉这三句字面（组件在 node 里没有渲染器）。
 */
export const ZIP_ENTRY_COPY = {
  button: '选择 zip 文件…',
  dialogTitle: '选择口上包 zip（市场容器或普通作品包）',
  hint: '市场容器直接上传；普通作品包（老作者的 .ERB 包）会先解出内容，再让你补包信息。',
} as const;

/** 向导里一次普通作品包 zip 的会话（选新 zip / 退出 zip 模式即作废） */
interface ZipSourceState {
  readonly path: string;
  readonly files: readonly MarketZipFile[];
  readonly skipped: readonly string[];
  readonly strippedRoot?: string;
  readonly bytes: number;
  readonly attribution: PackageAttribution | null;
}

export interface PublishKojoWizardDeps {
  /** 工作区（项目 / 包 / 项目目录） */
  workspaces: WorkspaceService;
  /** 内核 IO：只用 `chooseFile`（旧流程的 zip 选择）与读包字节（`readPackageSources`） */
  io: FileIO;
  /** `.kojo` → `.ERB` 产物字节（语法糖服务缺席时抛错 ⇒ 整包不产，绝不少转） */
  compileKojo: KojoCompiler;
  /**
   * 市场服务（**惰性取**：`kojo-market` 可能比本插件晚激活，且可能被停用）。
   * 每次渲染现取，缺席按"没有市场"降级（`publish-pack.ts` 的能力三态）。
   */
  market(): MarketService | null;
  /** 关闭自身（经内核事件，向导不持有宿主引用） */
  close(): void;
  /** 外链打开（`ui.openExternal`）——宿主落地，向导不直接开窗 */
  openExternal(url: string): void;
}

/** 一次发布的终局呈现（ok ⇒ PR 链接；rejected ⇒ 后端那句人话） */
function outcomeError(outcome: Extract<MarketPublishOutcome, { ok: false }>): string {
  const code = outcome.rejected.code.trim();
  return `市场拒绝了这次发布：${outcome.rejected.message}${code.length > 0 ? `（${code}）` : ''}`;
}

/**
 * 「已忽略派生产物」的一行人话（空数组 ⇒ `''`，界面不渲染空行）。
 *
 * 包目录里由编辑器保存 `.kojo` 时生成的同名 `.ERB` 不会进制品（以 `.kojo` 当前
 * 编译结果为准）；跳过是**有意**的，但必须说出来——作者否则会以为文件被丢了。
 */
export function ignoredDerivedNote(ignored: readonly IgnoredDerivedArtifact[]): string {
  if (ignored.length === 0) return '';
  const names = ignored.map((item) => item.relPath).join('、');
  return `已忽略 ${ignored.length} 个由 .kojo 生成的同名产物：${names}（以 .kojo 当前编译结果为准）`;
}

/** 向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createPublishKojoWizard(deps: PublishKojoWizardDeps): () => unknown {
  return function PublishKojoWizard(): unknown {
    /** 工作区项目列表；`null` = 还在读（不把"还没读到"演成"没有项目"） */
    const [projects, setProjects] = useState<readonly WorkspaceProject[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [projectId, setProjectId] = useState('');
    const [artifactId, setArtifactId] = useState('');

    // ③ 包信息
    const [name, setName] = useState('');
    const [packId, setPackId] = useState('');
    const [version, setVersion] = useState('');
    const [author, setAuthor] = useState('');
    const [summary, setSummary] = useState('');

    // ④ 许可与分发
    const [licenseKind, setLicenseKind] = useState<LicenseKind>('none');
    const [redistribute, setRedistribute] = useState(true);

    // ⑤ 发布过程与终局
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<MarketPublishProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [prUrl, setPrUrl] = useState<string | null>(null);
    /** 本次发布忽略的派生产物说明（`planArtifacts` 之后才有；null = 没有可说的） */
    const [derivedNote, setDerivedNote] = useState<string | null>(null);
    /** 普通作品包 zip 会话；null = 从工作区发布（原有主路径） */
    const [zipSource, setZipSource] = useState<ZipSourceState | null>(null);

    // 打开即现读工作区（overlay 载荷不带项目——契约：项目选择归拥有模型的这一方）
    useEffect(() => {
      let cancelled = false;
      deps.workspaces.list().then(
        (list) => {
          if (!cancelled) setProjects(list);
        },
        (err: unknown) => {
          if (cancelled) return;
          setProjects([]);
          setLoadError(err instanceof Error ? err.message : String(err));
        },
      );
      return () => {
        cancelled = true;
      };
    }, [deps]);

    // 选中项：state 里存的 id 优先，缺省 = 列表第一项（打开即有一个合理默认）
    const project = useMemo(() => {
      const list = projects ?? [];
      return list.find((p) => p.id === projectId) ?? list[0] ?? null;
    }, [projects, projectId]);

    const artifact = useMemo(() => {
      if (project === null) return null;
      return project.artifacts.find((a) => a.id === artifactId) ?? project.artifacts[0] ?? null;
    }, [project, artifactId]);

    /** 选包身份键：换包时整体重置表单（作者改过的字段不跨包残留） */
    const projectKey = project?.id ?? '';
    const artifactKey = artifact?.id ?? '';

    useEffect(() => {
      // zip 模式有自己的默认值（`selectZip` 里写）；退出 zip 模式（zipSource → null）时
      // 这个 effect 会重新跑一遍，把表单恢复成当前工作区包的默认值。
      if (project === null || artifact === null || zipSource !== null) return;
      const index = project.artifacts.indexOf(artifact);
      const defaults = draftDefaults(project, artifact, index);
      setName(defaults.name);
      setPackId(defaults.id);
      setVersion(defaults.version);
      setAuthor(defaults.author);
      setSummary(defaults.summary);
      setLicenseKind(defaults.licenseKind);
      setRedistribute(true);
      // 换包 = 换一个发布对象：上一次的终局（PR / 错误 / 进度）不再属于它
      setError(null);
      setPrUrl(null);
      setProgress(null);
      setDerivedNote(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectKey, artifactKey, zipSource]);

    const market = deps.market();
    const capability = publishCapabilityOf(market);
    const marketReady = capability === 'ready';
    const canInspectZip = typeof market?.inspectZip === 'function';

    const clearOutcome = (): void => {
      setError(null);
      setPrUrl(null);
      setProgress(null);
      setDerivedNote(null);
    };

    const applyOutcome = (outcome: MarketPublishOutcome): void => {
      if (outcome.ok) setPrUrl(outcome.prUrl);
      else setError(outcomeError(outcome));
    };

    /** 普通作品包 zip 的表单默认值（名字/id/版本/作者/许可；候选署名不自动采用） */
    const applyZipDefaults = (source: ZipSourceState): void => {
      const defaults = zipPublishDefaults(source.path, source, source.attribution);
      setName(defaults.name);
      setPackId(defaults.id);
      setVersion(defaults.version);
      setAuthor(defaults.author);
      setSummary(defaults.summary);
      setLicenseKind(defaults.licenseKind);
      setRedistribute(true);
    };

    const exitZipMode = (): void => {
      setZipSource(null);
      clearOutcome();
    };

    /**
     * 选一个 zip：
     * - 市场容器 ⇒ 直接走旧的 `publish(zipPath)`（预校验/上传一条链）；
     * - 普通作品包 ⇒ 解到内存、切到 zip 模式，作者补完包信息再点「发布」；
     * - 市场服务太旧（没有 `inspectZip`）⇒ 保持旧行为：直接交给 `publish` 判。
     * 取消对话框 = 作者自己的动作，安静返回。
     */
    const selectZip = async (): Promise<void> => {
      const current = deps.market();
      if (current === null) return;
      const choose = deps.io.chooseFile;
      if (choose === undefined) {
        setError('这个平台没有文件选择能力（发布需要桌面壳），本机没有改动。');
        return;
      }
      setBusy(true);
      clearOutcome();
      try {
        const picked = await choose.call(deps.io, {
          title: ZIP_ENTRY_COPY.dialogTitle,
          filters: [{ name: '口上包 zip', extensions: ['zip'] }],
        });
        if (picked === null) return;
        const inspect = current.inspectZip;
        if (inspect === undefined) {
          applyOutcome(await current.publish(picked, { onProgress: setProgress }));
          return;
        }
        const inspection = await inspect.call(current, picked);
        if (inspection.kind === 'market-container') {
          setZipSource(null);
          applyOutcome(await current.publish(picked, { onProgress: setProgress }));
          return;
        }
        const attribution = readPackageAttributionFromFiles(inspection.files);
        const source: ZipSourceState = {
          path: picked,
          files: inspection.files,
          skipped: inspection.skipped,
          bytes: inspection.bytes,
          attribution,
          ...(inspection.strippedRoot === undefined ? {} : { strippedRoot: inspection.strippedRoot }),
        };
        setZipSource(source);
        applyZipDefaults(source);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    /* ---------- 读失败 / 还没读到 / 一个项目都没有：显式降级（不静默） ---------- */

    if (loadError !== null) {
      return h('div', { className: 'wizard' },
        h('h3', null, '发布口上'),
        h('div', { className: 'wizard-error' }, `读取你的口上项目没有成功：${loadError}`),
        h('div', { className: 'wizard-hint dim' }, '工作区读不到不影响直接发布 zip：普通作品包会解出内容让你补包信息。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '关闭'),
          h('button', {
            className: 'small primary',
            disabled: busy || market === null,
            onClick: () => void selectZip(),
          }, busy ? '读取中…' : ZIP_ENTRY_COPY.button)));
    }

    if (projects === null) {
      return h('div', { className: 'wizard' },
        h('h3', null, '发布口上'),
        h('p', { className: 'dim' }, '正在读取你的口上项目…'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    if ((projects.length === 0 || project === null) && zipSource === null) {
      return h('div', { className: 'wizard' },
        h('h3', null, '发布口上'),
        h('p', { className: 'dim' },
          '你还没有口上项目。可以先在「我的口上项目」里新建或导入一个；也可以直接选择一个普通作品包 zip 发布。'),
        error !== null ? h('div', { className: 'wizard-error' }, error) : null,
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
          h('button', {
            className: 'small primary',
            disabled: busy || market === null,
            onClick: () => void selectZip(),
          }, busy ? '读取中…' : ZIP_ENTRY_COPY.button)));
    }

    /* ---------- 表单判定（纯函数全部住 publish-pack.ts） ---------- */

    const projectDir = project === null ? '' : deps.workspaces.projectDir(project.id);
    const noArtifacts = artifact === null;
    /** zip 模式与工作区包模式共用 ③④⑤ 表单：只要有一边可用就渲染字段 */
    const showFields = zipSource !== null || !noArtifacts;
    const hasSource = zipSource !== null || !noArtifacts;
    const idProblem = packIdProblem(packId);
    const verProblem = versionProblem(version);
    const canPublish =
      !busy &&
      hasSource &&
      marketReady &&
      redistribute &&
      idProblem === null &&
      verProblem === null &&
      name.trim().length > 0 &&
      author.trim().length > 0;
    const capabilityNote = publishCapabilityNote(capability);
    const licenseHint = licenseHintOf(licenseKind);
    /** 普通作品包 zip 的署名/许可证据（候选不自动采用） */
    const zipAttribution = zipSource?.attribution ?? null;
    const zipCandidate =
      zipAttribution !== null && zipAttribution.author === null
        ? (zipAttribution.authorCandidate ?? null)
        : null;
    const zipLicenseNote =
      zipAttribution?.license.kind === 'statement'
        ? `源包里有一份许可证文件：${zipAttribution.license.file}。请按原文选择下面的许可条款。`
        : zipAttribution?.license.kind === 'template-only'
          ? `源包里只有空白许可证模板：${zipAttribution.license.file}（不代表已授权）。`
          : '';
    const zipFileNames = zipSource === null ? '' : zipSource.files.slice(0, 6).map((f) => f.path).join('、');
    const zipMoreFiles = zipSource === null ? 0 : Math.max(0, zipSource.files.length - 6);

    /**
     * ⑤ 主路径：工作区包 → 制品计划（`.kojo` → `.ERB`，fail-closed）→ 草案 → 发布。
     * 打包与上传都在 try 里：任何一步失败都只落成一句人话，窗口与已填字段留着可重试。
     */
    const publishFromWorkspace = async (): Promise<void> => {
      const current = deps.market();
      const publishPack = current?.publishPack;
      if (current === null || publishPack === undefined || project === null || artifact === null) {
        return;
      }
      setBusy(true);
      setError(null);
      setPrUrl(null);
      setProgress(null);
      setDerivedNote(null);
      try {
        // 只打选中的这一个包：不读 workspace.json、不碰项目根别的文件
        const absDir = join(deps.workspaces.projectDir(project.id), artifact.dirName);
        const sources = await readPackageSources(deps.io, absDir);
        const plan = planArtifacts(sources, deps.compileKojo);
        // 被跳过的同名派生 .ERB 必须说出来（不静默：作者要知道那份文件没进包）
        setDerivedNote(ignoredDerivedNote(plan.ignoredDerived) || null);
        const draft = buildPublishDraft(
          { packId, version, name, author, licenseKind, redistribute, summary },
          draftFilesOf(plan),
        );
        // 进度经服务 `onProgress` 透传（预校验阶段没有进度是正常的，不造假百分比）
        const outcome = await publishPack.call(current, draft, { onProgress: setProgress });
        applyOutcome(outcome);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    /**
     * 普通作品包 zip 的发布：解出的文件表 → `planArtifacts`（`.kojo` 转译、同名派生判等）
     * → 草案 → `publishPack`（补 pack.json / 算 sha256 / 打 zip / 上传，与工作区发布同一条链）。
     */
    const publishFromZipSource = async (): Promise<void> => {
      const current = deps.market();
      const publishPack = current?.publishPack;
      if (current === null || publishPack === undefined || zipSource === null) return;
      setBusy(true);
      clearOutcome();
      try {
        const sources = zipSource.files.map((f) => ({ relPath: f.path, bytes: f.bytes }));
        const plan = planArtifacts(sources, deps.compileKojo);
        // zip 里同时有 .kojo 与同名 .ERB 时，派生物同样不进制品（与工作区发布同一口径）
        setDerivedNote(ignoredDerivedNote(plan.ignoredDerived) || null);
        const draft = buildPublishDraft(
          { packId, version, name, author, licenseKind, redistribute, summary },
          draftFilesOf(plan),
        );
        const outcome = await publishPack.call(current, draft, { onProgress: setProgress });
        applyOutcome(outcome);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    return h('div', { className: 'wizard' },
      h('h3', null, '发布口上'),

      // 能力三态：无市场 / 旧版服务缺 publishPack —— 说清楚，不静默
      capabilityNote.length > 0 ? h('div', { className: 'wizard-warn' }, capabilityNote) : null,

      // ① 源：普通作品包 zip（zip 模式）或工作区项目（原有主路径）
      zipSource !== null
        ? h('div', { className: 'wizard-preview' },
            h('div', null,
              h('span', { className: 'wizard-label' }, '① 源 zip'),
              h('code', null, zipSource.path)),
            h('div', { className: 'dim' },
              `读取到 ${zipSource.files.length} 个文件（${formatBytes(zipSource.bytes)}）` +
                (zipSource.strippedRoot === undefined
                  ? ''
                  : `；已去掉最外层文件夹「${zipSource.strippedRoot}」`)),
            h('div', { className: 'wizard-hint dim' },
              'zip 内容会作为市场包的 files/** 上传；包内 .kojo 会先转译成 .ERB，纯 .ERB 原样保留。'),
            zipSource.skipped.length > 0
              ? h('div', { className: 'wizard-hint dim' },
                  `已跳过 ${zipSource.skipped.length} 个目录/系统垃圾条目（不进包）`)
              : null,
            zipFileNames.length > 0
              ? h('div', { className: 'wizard-hint dim' },
                  `文件：${zipFileNames}${zipMoreFiles > 0 ? ` 等 ${zipSource.files.length} 个` : ''}`)
              : null,
            h('div', null,
              h('button', {
                className: 'ghost small',
                disabled: busy,
                onClick: exitZipMode,
              }, '改从工作区发布')))
        : project === null
          ? null
          : [
              h('label', { className: 'wizard-field', key: 'project' },
                h('span', { className: 'wizard-label' }, '① 选择项目'),
                h('select', {
                  value: project.id,
                  disabled: busy,
                  onChange: (e: { target: { value: string } }) => {
                    setProjectId(e.target.value);
                    setArtifactId('');
                  },
                },
                  projects.map((p) => h('option', { key: p.id, value: p.id }, `${p.name}（${p.artifacts.length} 包）`)))),
              h('div', { className: 'wizard-hint dim', key: 'project-dir' }, `项目目录：${projectDir}`),
            ],

      // ② 包（zip 模式没有这一步；工作区模式默认第一个，没有包时给一句人话）
      zipSource !== null
        ? null
        : noArtifacts
          ? h('div', { className: 'wizard-warn' },
              '这个项目里还没有口上包：先在「我的口上项目」里新建或导入一个包，再回来发布。')
          : h('label', { className: 'wizard-field' },
              h('span', { className: 'wizard-label' }, '② 选择包'),
              h('select', {
                value: artifact.id,
                disabled: busy,
                onChange: (e: { target: { value: string } }) => setArtifactId(e.target.value),
              },
                project?.artifacts.map((a) => h('option', { key: a.id, value: a.id }, a.name)))),

      // ③ 包信息
      showFields ? h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '③ 包信息 · 名称'),
        h('input', {
          value: name,
          disabled: busy,
          placeholder: '市场里显示的名字',
          onChange: (e: { target: { value: string } }) => setName(e.target.value),
        })) : null,

      showFields ? h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '包 id'),
        h('input', {
          value: packId,
          disabled: busy,
          onChange: (e: { target: { value: string } }) => setPackId(e.target.value),
        }),
        h('div', { className: 'wizard-hint dim' },
          '小写字母 / 数字 / . / _ / -，首字符须为字母或数字；默认按项目和包序号生成，可改'),
        idProblem !== null ? h('div', { className: 'wizard-warn' }, idProblem) : null) : null,

      showFields ? h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '版本'),
        h('input', {
          value: version,
          disabled: busy,
          placeholder: '1.0.0',
          onChange: (e: { target: { value: string } }) => setVersion(e.target.value),
        }),
        h('div', { className: 'wizard-hint dim' }, '三段数字（x.y.z）；写 1.0 或 1 会自动补成三段'),
        verProblem !== null ? h('div', { className: 'wizard-warn' }, verProblem) : null) : null,

      showFields ? h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '作者'),
        h('input', {
          value: author,
          disabled: busy,
          placeholder: '你的署名（市场里显示，必填）',
          onChange: (e: { target: { value: string } }) => setAuthor(e.target.value),
        }),
        zipSource === null
          ? h('div', { className: 'wizard-hint dim' },
              '默认取项目创建时填的作者名；取不到就留空，需要你自己填。')
          : [
              h('div', { className: 'wizard-hint dim', key: 'zip-author-hint' },
                zipAttribution?.author
                  ? `高置信署名取自 ${zipAttribution.author.file} 第 ${zipAttribution.author.line} 行，可改。`
                  : '没有从 readme 里识别到高置信署名，请自己填。'),
              zipCandidate === null
                ? null
                : h('div', { className: 'wizard-hint dim', key: 'zip-author-candidate' },
                    authorCandidateNotice(zipCandidate),
                    h('button', {
                      className: 'ghost small',
                      disabled: busy,
                      onClick: () => setAuthor(zipCandidate.value),
                    }, '采用此署名')),
            ]) : null,

      showFields ? h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '简介（可选）'),
        h('input', {
          value: summary,
          disabled: busy,
          placeholder: '一两句话说明这个包写了什么',
          onChange: (e: { target: { value: string } }) => setSummary(e.target.value),
        })) : null,

      // ④ 许可与分发
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '④ 许可与分发 · 许可'),
        h('select', {
          value: licenseKind,
          disabled: busy,
          onChange: (e: { target: { value: string } }) => setLicenseKind(e.target.value as LicenseKind),
        },
          licenseOptions().map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        licenseHint.length > 0 ? h('div', { className: 'wizard-hint dim' }, licenseHint) : null,
        zipLicenseNote.length > 0 ? h('div', { className: 'wizard-hint dim' }, zipLicenseNote) : null),

      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '二次分发'),
        h('span', null,
          h('input', {
            type: 'checkbox',
            checked: redistribute,
            disabled: busy,
            onChange: (e: { target: { checked: boolean } }) => setRedistribute(e.target.checked),
          }),
          ' 允许他人转发 / 再分发这个包'),
        h('div', { className: 'wizard-hint dim' },
          '市场收录要求允许二次分发；取消勾选将无法发布。')),

      // ⑤ 内容与发布
      h('div', { className: 'wizard-preview' },
        h('div', null,
          h('span', { className: 'wizard-label' }, '⑤ 内容与发布'),
          h('span', null,
            zipSource !== null
              ? `zip：${zipSource.files.length} 个文件`
              : noArtifacts
                ? '（还没有可发布的包）'
                : `${project?.name ?? ''} / ${artifact?.name ?? ''}`)),
        zipSource !== null
          ? h('div', { className: 'dim' },
              '将把 zip 里的文件作为包内容现打市场容器；包内 .kojo 会先转译成 .ERB，' +
              '逐文件算核对码后上传，成功后进入市场审核。')
          : noArtifacts
            ? null
            : h('div', { className: 'dim' },
                '发布时会把包内的 .kojo 转译成 .ERB（任一失败整包不产），逐文件算出核对码后上传到口上市场；' +
                '成功后进入市场审核（维护者合并后上架）。'),
        zipSource === null && artifact !== null
          ? h('div', { className: 'wizard-hint dim' }, `包目录：${join(projectDir, artifact.dirName)}`)
          : null),

      // 派生产物被有意跳过：一行说明，不让作者以为包里少了文件
      derivedNote !== null ? h('div', { className: 'wizard-hint dim' }, derivedNote) : null,

      // 进度（只有真的在上传时出现；不在读包/预校验阶段造假进度）
      busy && progress !== null ? h('div', { className: 'wizard-hint' }, progressLabel(progress)) : null,

      // 终局 ok：主文案是「已提交审核」，PR 只作为审核进度链接（PR ≠ 上架）
      prUrl !== null
        ? h('div', { className: 'wizard-preview' },
            h('div', null, h('span', { className: 'wizard-label' }, '已提交市场审核')),
            h('div', { className: 'dim' },
              '审核通过后才会出现在市场里。PR 是维护者的审核单，你不需要在 GitHub 上操作。'),
            h('div', null, h('code', null, prUrl)),
            h('div', null,
              h('button', {
                className: 'ghost small',
                onClick: () => deps.openExternal(prUrl),
              }, '查看审核进度')))
        : null,

      error !== null ? h('div', { className: 'wizard-error' }, error) : null,

      // zip 入口：市场容器直接上传；普通作品包解出内容后补信息再发布
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '已有 zip？'),
        h('div', null,
          h('button', {
            className: 'ghost small',
            disabled: busy || market === null,
            onClick: () => void selectZip(),
          }, zipSource !== null ? '重新选择 zip…' : ZIP_ENTRY_COPY.button)),
        h('div', { className: 'wizard-hint dim' },
          canInspectZip
            ? ZIP_ENTRY_COPY.hint
            : '当前「口上市场」版本较旧，只能直接上传市场格式 zip；更新后可导入普通作品包。')),

      // 动作
      h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          disabled: !canPublish,
          onClick: () => void (zipSource === null ? publishFromWorkspace() : publishFromZipSource()),
        }, busy ? '发布中…' : zipSource === null ? '发布' : '发布 zip 包')));
  };
}
