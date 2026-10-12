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
import { attributionMeta, attributionSummary, type PackageAttribution } from './attribution';

/** overlay 贡献 id（插件监听 importRequested 后发 `ui.overlay.open` 引用） */
export const IMPORT_KOJO_OVERLAY_ID = 'eratw.importKojoProject';

/** 待导入请求（插件闭包持有；组件经 deps 读取） */
export interface PendingImport {
  sourceDir: string;
  suggestedName?: string;
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
   * 读取源包的署名 / 授权（T2）。导入时**原样带进制品 meta**——
   * 二次创作最容易丢的就是原作者，而语料里署名写在 README 正文、不在目录名上。
   */
  loadAttribution(absDir: string): Promise<PackageAttribution>;
}

/** 目标项目选择的「新建」哨兵值 */
const NEW_PROJECT = '__new__';

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

    // 源包署名读取：失败不阻断导入（署名是"别丢了原作者"的提醒，不是导入前置条件）
    useEffect(() => {
      const src = pending?.sourceDir;
      if (!src) {
        setSourceAttr(null);
        return;
      }
      let cancelled = false;
      deps
        .loadAttribution(src)
        .then((a) => {
          if (!cancelled) setSourceAttr(a);
        })
        .catch(() => {
          if (!cancelled) setSourceAttr(null);
        });
      return () => {
        cancelled = true;
      };
    }, [deps, pending?.sourceDir]);

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

    const doImport = async (): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        let projectId = target;
        if (target === NEW_PROJECT) {
          const created = await deps.workspaces.create({ name: newProjectName.trim() });
          projectId = created.id;
        }
        await deps.workspaces.importDirectory(projectId, {
          name: pkgDirName,
          dirName: pkgDirName,
          sourceDir: pending.sourceDir,
          // T2：把抽到的原作者原样带进制品 meta——二次创作最容易丢的就是这个，
          // 而语料里署名写在 README 正文、不在目录名上，丢了就再也找不回来。
          meta: { importedFrom: pending.sourceDir, ...attributionMeta(sourceAttr) },
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
        h('div', { className: 'dim' }, '导入 = 字节级复制到工作区；源目录保持原样，游戏目录只读不破。')),

      // 源包署名（T2）：导入前先把"这是谁的东西"摆在脸上，并随制品 meta 带走
      sourceAttr
        ? h('div', { className: 'wizard-preview' },
            h('div', null, h('span', { className: 'wizard-label' }, '源包署名'),
              h('span', null, attributionSummary(sourceAttr))),
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
