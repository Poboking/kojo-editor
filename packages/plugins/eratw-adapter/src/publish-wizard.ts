/**
 * 「发布口上」引导向导（用户反馈 4 批；`ui.overlay` 贡献）。
 *
 * ## 链路
 *
 * 市场面板点「发布口上」→ 发内核语义事件 `market.publishRequested`（契约：
 * 「作者要发布」这一个意图，不带项目/包/许可）→ 本插件监听并打开本 overlay
 * （`eratw.publishKojo`）→ 作者按步骤走：
 *
 * ① 选项目（工作区里的口上项目，显示包数量）
 * ② 选包（该项目里的制品；默认第一个）
 * ③ 包信息（名称 / 包 id / 版本 / 作者 / 简介；默认值从项目与包的元数据提取）
 * ④ 许可与分发（`LICENSE_CHOICES` 下拉 + 二次分发复选框）
 * ⑤ 内容与发布（打包说明 → 进度 → 终局：PR 链接 / 中文拒因，可改字段重试）
 *
 * 次要入口保留旧流程：「已有 zip？直接选择 zip 发布」→ `io.chooseFile`
 * （系统对话框即授权）+ `market.publish`；取消不报错。
 *
 * ## 为什么打包也在这里（而不是让面板去拼）
 *
 * 包内容住在**作者工作区**（`kernel.workspaces` 的 project/artifact 模型），
 * `.kojo` → `.ERB` 的转译又只有适配器认识（`planArtifacts`，fail-closed）。
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
  type WorkspaceProject,
  type WorkspaceService,
} from '@kojo/plugin-api';
import { planArtifacts, readPackageSources, type KojoCompiler } from './artifact';
import type { LicenseKind } from './licenses';
import {
  buildPublishDraft,
  draftDefaults,
  draftFilesOf,
  licenseHintOf,
  licenseOptions,
  packIdProblem,
  progressLabel,
  publishCapabilityNote,
  publishCapabilityOf,
  versionProblem,
} from './publish-pack';

/** overlay 贡献 id（插件监听 `market.publishRequested` 后发 `ui.overlay.open` 引用） */
export const PUBLISH_KOJO_OVERLAY_ID = 'eratw.publishKojo';

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
      if (project === null || artifact === null) return;
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectKey, artifactKey]);

    const market = deps.market();
    const capability = publishCapabilityOf(market);
    const marketReady = capability === 'ready';

    /* ---------- 读失败 / 还没读到 / 一个项目都没有：显式降级（不静默） ---------- */

    if (loadError !== null) {
      return h('div', { className: 'wizard' },
        h('h3', null, '发布口上'),
        h('div', { className: 'wizard-error' }, `读取你的口上项目没有成功：${loadError}`),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    if (projects === null) {
      return h('div', { className: 'wizard' },
        h('h3', null, '发布口上'),
        h('p', { className: 'dim' }, '正在读取你的口上项目…'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    if (projects.length === 0 || project === null) {
      return h('div', { className: 'wizard' },
        h('h3', null, '发布口上'),
        h('p', { className: 'dim' }, '你还没有口上项目。先在「我的口上项目」里新建或导入一个，再回来发布。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    /* ---------- 表单判定（纯函数全部住 publish-pack.ts） ---------- */

    const projectDir = deps.workspaces.projectDir(project.id);
    const noArtifacts = artifact === null;
    const idProblem = packIdProblem(packId);
    const verProblem = versionProblem(version);
    const canPublish =
      !busy &&
      !noArtifacts &&
      marketReady &&
      redistribute &&
      idProblem === null &&
      verProblem === null &&
      name.trim().length > 0 &&
      author.trim().length > 0;
    const capabilityNote = publishCapabilityNote(capability);
    const licenseHint = licenseHintOf(licenseKind);

    const applyOutcome = (outcome: MarketPublishOutcome): void => {
      if (outcome.ok) setPrUrl(outcome.prUrl);
      else setError(outcomeError(outcome));
    };

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
      try {
        // 只打选中的这一个包：不读 workspace.json、不碰项目根别的文件
        const absDir = join(deps.workspaces.projectDir(project.id), artifact.dirName);
        const sources = await readPackageSources(deps.io, absDir);
        const plan = planArtifacts(sources, deps.compileKojo);
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
     * 次要入口（旧流程）：已有 zip → 系统对话框选定（对话框即授权）→ 既有 `publish`。
     * 取消 = 作者自己的动作，安静返回；它既不是结果也不是错误。
     */
    const publishFromZip = async (): Promise<void> => {
      const current = deps.market();
      if (current === null) return;
      const choose = deps.io.chooseFile;
      if (choose === undefined) {
        setError('这个平台没有文件选择能力（发布需要桌面壳），本机没有改动。');
        return;
      }
      setBusy(true);
      setError(null);
      setPrUrl(null);
      setProgress(null);
      try {
        const picked = await choose.call(deps.io, {
          title: '选择要发布的口上包（zip）',
          filters: [{ name: '口上包容器', extensions: ['zip'] }],
        });
        if (picked === null) return;
        applyOutcome(await current.publish(picked, { onProgress: setProgress }));
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

      // ① 项目（名字 + 包数量）
      h('label', { className: 'wizard-field' },
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
      h('div', { className: 'wizard-hint dim' }, `项目目录：${projectDir}`),

      // ② 包（默认第一个；没有包时给一句人话，并把下一步留出来）
      noArtifacts
        ? h('div', { className: 'wizard-warn' },
            '这个项目里还没有口上包：先在「我的口上项目」里新建或导入一个包，再回来发布。')
        : h('label', { className: 'wizard-field' },
            h('span', { className: 'wizard-label' }, '② 选择包'),
            h('select', {
              value: artifact.id,
              disabled: busy,
              onChange: (e: { target: { value: string } }) => setArtifactId(e.target.value),
            },
              project.artifacts.map((a) => h('option', { key: a.id, value: a.id }, a.name)))),

      // ③ 包信息
      noArtifacts ? null : h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '③ 包信息 · 名称'),
        h('input', {
          value: name,
          disabled: busy,
          placeholder: '市场里显示的名字',
          onChange: (e: { target: { value: string } }) => setName(e.target.value),
        })),

      noArtifacts ? null : h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '包 id'),
        h('input', {
          value: packId,
          disabled: busy,
          onChange: (e: { target: { value: string } }) => setPackId(e.target.value),
        }),
        h('div', { className: 'wizard-hint dim' },
          '小写字母 / 数字 / . / _ / -，首字符须为字母或数字；默认按项目和包序号生成，可改'),
        idProblem !== null ? h('div', { className: 'wizard-warn' }, idProblem) : null),

      noArtifacts ? null : h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '版本'),
        h('input', {
          value: version,
          disabled: busy,
          placeholder: '1.0.0',
          onChange: (e: { target: { value: string } }) => setVersion(e.target.value),
        }),
        h('div', { className: 'wizard-hint dim' }, '三段数字（x.y.z）；写 1.0 或 1 会自动补成三段'),
        verProblem !== null ? h('div', { className: 'wizard-warn' }, verProblem) : null),

      noArtifacts ? null : h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '作者'),
        h('input', {
          value: author,
          disabled: busy,
          placeholder: '你的署名（市场里显示，必填）',
          onChange: (e: { target: { value: string } }) => setAuthor(e.target.value),
        }),
        h('div', { className: 'wizard-hint dim' },
          '默认取项目创建时填的作者名；取不到就留空，需要你自己填。')),

      noArtifacts ? null : h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '简介（可选）'),
        h('input', {
          value: summary,
          disabled: busy,
          placeholder: '一两句话说明这个包写了什么',
          onChange: (e: { target: { value: string } }) => setSummary(e.target.value),
        })),

      // ④ 许可与分发
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '④ 许可与分发 · 许可'),
        h('select', {
          value: licenseKind,
          disabled: busy,
          onChange: (e: { target: { value: string } }) => setLicenseKind(e.target.value as LicenseKind),
        },
          licenseOptions().map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        licenseHint.length > 0 ? h('div', { className: 'wizard-hint dim' }, licenseHint) : null),

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
          h('span', null, noArtifacts ? '（还没有可发布的包）' : `${project.name} / ${artifact.name}`)),
        noArtifacts ? null : h('div', { className: 'dim' },
          '发布时会把包内的 .kojo 转译成 .ERB（任一失败整包不产），逐文件算出核对码后上传到口上市场；' +
          '成功后得到一个供审核的 PR。'),
        noArtifacts ? null : h('div', { className: 'wizard-hint dim' }, `包目录：${join(projectDir, artifact.dirName)}`)),

      // 进度（只有真的在上传时出现；不在读包/预校验阶段造假进度）
      busy && progress !== null ? h('div', { className: 'wizard-hint' }, progressLabel(progress)) : null,

      // 终局 ok：PR 链接 + 在浏览器打开（外链意图走总线，宿主落地）
      prUrl !== null
        ? h('div', { className: 'wizard-preview' },
            h('div', null, h('span', { className: 'wizard-label' }, '已提交'), h('code', null, prUrl)),
            h('div', { className: 'dim' }, '市场维护者会在 PR 里复核；合并后作者们就能在市场里看到这个包。'),
            h('div', null,
              h('button', {
                className: 'ghost small',
                onClick: () => deps.openExternal(prUrl),
              }, '在浏览器打开')))
        : null,

      error !== null ? h('div', { className: 'wizard-error' }, error) : null,

      // 次要入口：旧流程（已有 zip）
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '已有 zip？'),
        h('div', null,
          h('button', {
            className: 'ghost small',
            disabled: busy || market === null,
            onClick: () => void publishFromZip(),
          }, '直接选择 zip 发布')),
        h('div', { className: 'wizard-hint dim' },
          '系统对话框选定 zip 即授权读取；这条保留给已经按市场格式打好包的旧流程。')),

      // 动作
      h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          disabled: !canPublish,
          onClick: () => void publishFromWorkspace(),
        }, busy ? '发布中…' : '发布')));
  };
}
