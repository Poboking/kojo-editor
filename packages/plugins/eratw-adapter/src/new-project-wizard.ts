/**
 * 新建口上项目向导（2026-10-12 口上项目批 P-C；`ui.overlay` 贡献）。
 *
 * 链路：面板「新建」按钮 → 内核事件 `ui.overlay.open` → 宿主打开本 overlay
 * → 填作品信息（作品名/作者名/版本/目标角色/剧本号/可选 LICENSE）
 * → 脚手架生成中文命名包（`scaffold.ts` 纯函数）
 * → 落工作区（`kernel.workspaces`：create 项目 + createArtifact 包）
 * → 通知面板刷新 → `ui.overlay.close` 自关。
 *
 * 知识分层：角色表来自 `kernel.project` 的 GameProject（适配器填充，本向导透传）；
 * 脚手架内容（中文命名 / 8 核心面空壳 / README 模板）是 eraTW 口上组织知识，
 * 住在 adapter 的 `scaffold.ts`（纯函数可单测）。**不生成四件套文件**——
 * 登记/配色/开关是函数级产物，属作者后续创作。
 */

import { createElement as h, useMemo, useState } from 'react';
import type { ProjectService, WorkspaceService } from '@kojo/plugin-api';
import { CORE_FACES, scaffoldDirName, scaffoldKojoProject, sanitizeSegment } from './scaffold';

/** overlay 贡献 id（面板按钮发 `ui.overlay.open` 时引用） */
export const NEW_KOJO_PROJECT_OVERLAY_ID = 'eratw.newKojoProject';

export interface NewKojoProjectWizardDeps {
  workspaces: WorkspaceService;
  /** 游戏项目（角色表来源；无打开项目时向导显式不可用） */
  project: ProjectService;
  /** 关闭自身（经内核事件，向导不持有宿主引用） */
  close(): void;
  /** 创建成功后回调（面板刷新：目录缓存失效 + 项目列表重拉） */
  onCreated(): void;
}

/** 剧本号取值域（1-10） */
const SCRIPT_NOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** 向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createNewKojoProjectWizard(deps: NewKojoProjectWizardDeps): () => unknown {
  return function NewKojoProjectWizard(): unknown {
    const gameProject = deps.project.current();

    const [workName, setWorkName] = useState('');
    const [authorName, setAuthorName] = useState('');
    const [version, setVersion] = useState('1.0');
    const [charaNo, setCharaNo] = useState<number | null>(null);
    const [scriptNo, setScriptNo] = useState<number>(1);
    const [includeLicense, setIncludeLicense] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 目标角色下拉：读游戏项目角色表（按编号升序）
    const charas = useMemo(() => {
      if (!gameProject) return [];
      return [...gameProject.charaIndex.values()].sort((a, b) => a.no - b.no);
    }, [gameProject]);

    /* ---------- 无游戏项目：显式降级（角色表无处可取，不猜） ---------- */
    if (!gameProject) {
      return h('div', { className: 'wizard' },
        h('h3', null, '新建口上项目'),
        h('p', { className: 'dim' }, '当前无打开的游戏项目。目标角色表来自游戏项目，请先打开项目再新建。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    const chara = charaNo === null ? null : (charas.find((c) => c.no === charaNo) ?? null);

    // 目录名实时预览（逐段消毒；任一段为空 → 预览空 → 禁用创建）
    const segmentsOk =
      sanitizeSegment(workName).length > 0 &&
      sanitizeSegment(version).length > 0 &&
      (chara ? sanitizeSegment(chara.name).length > 0 : false);
    const dirNamePreview = chara && segmentsOk
      ? scaffoldDirName({ workName, charaName: chara.name, version })
      : '';

    const canCreate =
      !busy &&
      workName.trim().length > 0 &&
      authorName.trim().length > 0 &&
      version.trim().length > 0 &&
      chara !== null &&
      dirNamePreview.length > 0;

    const create = async (): Promise<void> => {
      if (!chara) return;
      setBusy(true);
      setError(null);
      try {
        const result = scaffoldKojoProject({
          workName,
          authorName,
          version,
          charaNo: chara.no,
          charaName: chara.name,
          scriptNo,
          includeLicense,
        });
        const wsProject = await deps.workspaces.create({
          name: workName.trim(),
          meta: { author: authorName.trim(), version: version.trim() },
        });
        await deps.workspaces.createArtifact(wsProject.id, {
          name: result.dirName,
          dirName: result.dirName,
          files: result.files,
          meta: { charaNo: chara.no, charaName: chara.name, scriptNo },
        });
        deps.onCreated();
        deps.close();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    };

    const fileCount = 1 + (includeLicense ? 1 : 0) + CORE_FACES.length;

    return h('div', { className: 'wizard' },
      h('h3', null, '新建口上项目'),

      // 作品名
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '作品名'),
        h('input', {
          value: workName,
          placeholder: '如：东方口上合集',
          onChange: (e: { target: { value: string } }) => setWorkName(e.target.value),
        })),

      // 作者名
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '作者名'),
        h('input', {
          value: authorName,
          placeholder: '你的署名（导入他人包时不会被覆盖）',
          onChange: (e: { target: { value: string } }) => setAuthorName(e.target.value),
        })),

      // 版本
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '版本'),
        h('input', {
          value: version,
          placeholder: '如：1.0',
          onChange: (e: { target: { value: string } }) => setVersion(e.target.value),
        })),

      // 目标角色（游戏项目角色表）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '目标角色'),
        h('select', {
          value: charaNo === null ? '' : String(charaNo),
          onChange: (e: { target: { value: string } }) =>
            setCharaNo(e.target.value === '' ? null : Number(e.target.value)),
        },
          h('option', { value: '' }, charas.length > 0 ? '选择角色…' : '（游戏项目无角色表）'),
          charas.map((c) =>
            h('option', { key: c.no, value: String(c.no) }, `#${c.no} ${c.name}`)))),

      // 剧本号（1-10）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '剧本号'),
        h('select', {
          value: String(scriptNo),
          onChange: (e: { target: { value: string } }) => setScriptNo(Number(e.target.value)),
        },
          SCRIPT_NOS.map((n) => h('option', { key: n, value: String(n) }, `剧本${n}`)))),

      // 可选 LICENSE
      h('label', { className: 'wizard-field wizard-check' },
        h('input', {
          type: 'checkbox',
          checked: includeLicense,
          onChange: (e: { target: { checked: boolean } }) => setIncludeLicense(e.target.checked),
        }),
        h('span', { className: 'wizard-label' }, '附带 LICENSE 文件（占位模板，创建后自填条款）')),

      // 落点预览
      h('div', { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '包目录名'),
          h('code', null, dirNamePreview || '—')),
        h('div', { className: 'dim' },
          dirNamePreview
            ? `将生成 ${fileCount} 个文件：中文 README + ${CORE_FACES.length} 个核心面空壳${includeLicense ? ' + LICENSE' : ''}（不含四件套）`
            : '作品名 / 版本 / 角色名不得为空或仅含非法字符')),

      error ? h('div', { className: 'wizard-error' }, error) : null,

      // 动作
      h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          disabled: !canCreate,
          onClick: () => void create(),
        }, busy ? '创建中…' : '创建项目')));
  };
}
