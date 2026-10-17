/**
 * 导入口上项目向导（2026-10-12 口上项目批 P-F；`ui.overlay` 贡献）。
 *
 * 链路：文件树右键作者包「导入为我的口上项目」→ 壳层发内核事件
 * `workspace.importRequested`（只带源目录与建议名，零游戏知识）
 * → 本插件监听并把请求存入闭包（**overlay 组件无 props，payload 不经组件**）
 * → 发 `ui.overlay.open` 打开本向导 → 选目标项目（已有 / 新建）+ **强制新包名**
 * → `kernel.workspaces.importDirectory`（字节级复制）→ 面板刷新 → 自关。
 *
 * 强制新包名（讨论纪要定调）：导入的包必须改名，不得与原目录名相同——
 * 不覆盖他人署名（原作者的包名是署名的一部分）。
 */

import { createElement as h, useEffect, useMemo, useState } from 'react';
import type { WorkspaceProject, WorkspaceService } from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';
import { sanitizeSegment } from './scaffold';
import { glossName } from './name-glossary';
import {
  attributionMeta,
  attributionSummary,
  type AttributionField,
  type PackageAttribution,
} from './attribution';

/** overlay 贡献 id（插件监听 importRequested 后发 `ui.overlay.open` 引用） */
export const IMPORT_KOJO_OVERLAY_ID = 'eratw.importKojoProject';

/** 待导入请求（插件闭包持有；组件经 deps 读取） */
export interface PendingImport {
  sourceDir: string;
  suggestedName?: string;
  /**
   * 导入来源标记（KM-13；冻结约定：市场行发字面量 `'market'`，其余缺省）。
   * 只影响署名读取：市场来源的包正文通常没有 README，署名在上一级 `pack.json` 里。
   */
  source?: string;
}

export interface ImportKojoWizardDeps {
  workspaces: WorkspaceService;
  /** 读取待导入请求（null = 无——向导显式降级） */
  pending(): PendingImport | null;
  /** 清除待导入请求（完成 / 取消时） */
  clearPending(): void;
  close(): void;
  /** 导入成功后回调（面板刷新：目录缓存失效 + 项目列表重拉） */
  onImported(): void;
  /**
   * 「选新建项目」那条分支真的建出项目时广播（反馈 3：`workspace.projectCreated`
   * 要说的是事实——凡创建必广播，不管哪个入口）。导入进**已有**项目时不调用。
   * 导入路径从不带关联号（没有人在等它），事件里的 `requestToken` 自然为空。
   */
  projectCreated?(projectId: string): void;
  /**
   * 读取源包的署名 / 授权（T2）。导入时**原样带进制品 meta**——
   * 二次创作最容易丢的就是原作者，而语料里署名写在 README 正文、不在目录名上。
   * `source`（KM-13）透传来源标记：市场来源据此先补读上一级 `pack.json` 兜底署名。
   */
  loadAttribution(absDir: string, source?: string): Promise<PackageAttribution>;
}

/** 目标项目选择的「新建」哨兵值 */
const NEW_PROJECT = '__new__';

/**
 * 导入制品 meta 的署名拼装（纯函数，组件与测试共用）。
 *
 * 候选署名**只有用户勾了采用**、且包里没有高置信 author 时才生效；生效方式是把候选
 * 当作 `author` 交给 `attributionMeta`（下游只认 `originalAuthor` 这个既有键），
 * `authorCandidate` 本身**不进 meta**——未确认的猜测不落档案。
 * 高置信 author 永远优先：勾选状态过时也覆盖不了它。
 */
export function buildImportMeta(
  sourceDir: string,
  attribution: PackageAttribution | null,
  adoptCandidate: boolean,
): Record<string, unknown> {
  const effective =
    adoptCandidate && attribution !== null && attribution.author === null && attribution.authorCandidate
      ? { ...attribution, author: attribution.authorCandidate }
      : attribution;
  return { importedFrom: sourceDir, ...attributionMeta(effective) };
}

/** 候选署名的一行提示：值 + 出处（文件 + 1 基行号），请用户核原文后自己决定 */
export function authorCandidateNotice(field: AttributionField): string {
  return `可能作者：${field.value}（${field.file} 第 ${field.line} 行，请确认）`;
}

/** 导入向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createImportKojoWizard(deps: ImportKojoWizardDeps): () => unknown {
  return function ImportKojoWizard(): unknown {
    const pending = deps.pending();

    const [projects, setProjects] = useState<readonly WorkspaceProject[]>([]);
    const [target, setTarget] = useState<string>(NEW_PROJECT);
    const [newProjectName, setNewProjectName] = useState('');
    const [packageName, setPackageName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** 源包署名（T2；null = 尚未读到，不阻断导入） */
    const [sourceAttr, setSourceAttr] = useState<PackageAttribution | null>(null);
    /** 候选署名采用开关（默认关；只有用户亲手勾选才进制品 meta） */
    const [adoptCandidate, setAdoptCandidate] = useState(false);

    // 源包署名读取：失败不阻断导入（署名是"别丢了原作者"的提醒，不是导入前置条件）
    useEffect(() => {
      const src = pending?.sourceDir;
      if (!src) {
        setSourceAttr(null);
        return;
      }
      let cancelled = false;
      // 换了源包先清空：绝不把上一个包的署名（连同候选）挂在新包头上
      setSourceAttr(null);
      deps
        .loadAttribution(src, pending?.source)
        .then((a) => {
          if (!cancelled) setSourceAttr(a);
        })
        .catch(() => {
          if (!cancelled) setSourceAttr(null);
        });
      return () => {
        cancelled = true;
      };
    }, [deps, pending?.sourceDir, pending?.source]);

    // 已有项目列表（目标项目下拉）
    useEffect(() => {
      let cancelled = false;
      void deps.workspaces
        .list()
        .then((list) => {
          if (!cancelled) setProjects(list);
        })
        .catch(() => {
          /* 列表失败不阻断导入——仍可选择新建项目 */
        });
      return () => {
        cancelled = true;
      };
    }, [deps]);

    // 请求到达时预填字段（建议名 → 新包名默认加「（导入）」后缀，天然区别于原名）
    const sourceDirName = pending ? basename(pending.sourceDir) : '';
    useEffect(() => {
      if (!pending) return;
      const suggested = pending.suggestedName ?? basename(pending.sourceDir);
      setPackageName(`${suggested}（导入）`);
      setNewProjectName(suggested);
      setAdoptCandidate(false); // 换了一个源包：上一次的采用决定作废
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending?.sourceDir]);

    const pkgDirName = useMemo(() => sanitizeSegment(packageName), [packageName]);
    const nameClash = pkgDirName.length > 0 && pkgDirName === sourceDirName;

    const canImport =
      !busy &&
      pending !== null &&
      pkgDirName.length > 0 &&
      !nameClash &&
      (target !== NEW_PROJECT || newProjectName.trim().length > 0);

    /* ---------- 无待导入请求：显式降级（不静默） ---------- */
    if (!pending) {
      return h('div', { className: 'wizard' },
        h('h3', null, '导入为我的口上项目'),
        h('p', { className: 'dim' }, '当前没有待导入的目录。请在口上文件树中右键一个作者包选择导入。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    // 候选署名（数据层已保证 author 在 ⇒ 候选为 null；这里再收窄一次给渲染用）
    const authorCandidate =
      sourceAttr !== null && sourceAttr.author === null ? (sourceAttr.authorCandidate ?? null) : null;

    const doImport = async (): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        let projectId = target;
        if (target === NEW_PROJECT) {
          const created = await deps.workspaces.create({ name: newProjectName.trim() });
          projectId = created.id;
          deps.projectCreated?.(created.id);
        }
        await deps.workspaces.importDirectory(projectId, {
          name: pkgDirName,
          dirName: pkgDirName,
          sourceDir: pending.sourceDir,
          // T2：把抽到的原作者原样带进制品 meta——二次创作最容易丢的就是这个，
          // 而语料里署名写在 README 正文、不在目录名上，丢了就再也找不回来。
          // 候选署名只在用户勾选「采用此署名」后才合并进来（见 buildImportMeta）。
          meta: buildImportMeta(pending.sourceDir, sourceAttr, adoptCandidate),
        });
        deps.onImported();
        deps.clearPending();
        deps.close();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    };

    const cancel = (): void => {
      deps.clearPending();
      deps.close();
    };

    return h('div', { className: 'wizard' },
      h('h3', null, '导入为我的口上项目'),

      // 源目录（只读展示）
      h('div', { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '源目录'),
          h('code', null, pending.sourceDir)),
        // 源包名对照（日文名 → 中文名；**只加显示备注**，不改实际目录名，导入保持原样）
        h('div', null, h('span', { className: 'wizard-label' }, '源包名'),
          h('code', null, glossName(sourceDirName))),
        h('div', { className: 'dim' }, '导入 = 字节级复制到工作区；源目录保持原样，游戏目录只读不破。')),

      // 源包署名（T2）：导入前先把"这是谁的东西"摆在脸上，并随制品 meta 带走
      sourceAttr
        ? h('div', { className: 'wizard-preview' },
            h('div', null, h('span', { className: 'wizard-label' }, '源包署名'),
              h('span', null, attributionSummary(sourceAttr))),
            // 候选署名：读数只是猜测，默认不用；勾选后才并入制品 meta
            authorCandidate !== null
              ? h('label', { className: 'wizard-field' },
                  h('span', null,
                    h('input', {
                      type: 'checkbox',
                      checked: adoptCandidate,
                      onChange: (e: { target: { checked: boolean } }) => setAdoptCandidate(e.target.checked),
                    }),
                    ' 采用此署名'),
                  h('div', { className: 'dim' }, authorCandidateNotice(authorCandidate)))
              : null,
            h('div', { className: 'dim' },
              '导入后请以自己的署名命名；原作者信息随包保留，不要删。'))
        : null,

      // 目标项目（已有 / 新建）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '目标项目'),
        h('select', {
          value: target,
          onChange: (e: { target: { value: string } }) => setTarget(e.target.value),
        },
          h('option', { value: NEW_PROJECT }, '＋ 新建项目'),
          projects.map((p) =>
            h('option', { key: p.id, value: p.id }, `${p.name}（${p.artifacts.length} 包）`)))),

      // 新建项目名（仅新建时）
      target === NEW_PROJECT
        ? h('label', { className: 'wizard-field' },
            h('span', { className: 'wizard-label' }, '新项目名称'),
            h('input', {
              value: newProjectName,
              placeholder: '如：东方口上合集',
              onChange: (e: { target: { value: string } }) => setNewProjectName(e.target.value),
            }))
        : null,

      // 新包名（强制 ≠ 原目录名）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '新包名（不得与原目录名相同——不覆盖他人署名）'),
        h('input', {
          value: packageName,
          onChange: (e: { target: { value: string } }) => setPackageName(e.target.value),
        })),

      // 落点预览
      h('div', { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '包目录名'),
          h('code', null, pkgDirName || '—'))),

      nameClash
        ? h('div', { className: 'wizard-warn' },
            '新包名不得与原目录名相同：导入的是他人作品的副本，请保留自己的署名。')
        : null,
      error ? h('div', { className: 'wizard-error' }, error) : null,

      // 动作
      h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: cancel, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          disabled: !canImport,
          onClick: () => void doImport(),
        }, busy ? '导入中…' : '导入')));
  };
}
