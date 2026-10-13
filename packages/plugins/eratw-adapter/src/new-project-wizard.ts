/**
 * 新建口上项目向导（2026-10-12 口上项目批 P-C；`ui.overlay` 贡献）。
 *
 * 链路：面板「新建」按钮 → 内核事件 `ui.overlay.open` → 宿主打开本 overlay
 * → 填作品信息（作品名/作者名/版本/目标角色/剧本号/可选 LICENSE）
 * → 脚手架生成中文命名包（`scaffold.ts` 纯函数）
 * → 落工作区（`kernel.workspaces`：create 项目 + createArtifact 包）
 * → 通知面板刷新 → 广播 `workspace.projectCreated` → `ui.overlay.close` 自关。
 *
 * 本向导有两个入口（反馈 3，2026-10-13）：面板的「＋ 新建」，以及
 * 「新建口上文件」在**还没有口上项目**时的引导分支。后者发语义意图
 * `workspace.newProjectRequested` 带一个关联号来（接线见 `plugin.ts`），创建成功时
 * 原样带进 `workspace.projectCreated`，由发起方把作者那份还没落盘的口上文件写进
 * 新项目——**向导本身不知道也不该知道这件事**，它只管把项目建出来。
 *
 * 知识分层：角色表来自 `kernel.project` 的 GameProject（适配器填充，本向导透传）；
 * 脚手架内容（中文命名 / 8 核心面空壳 / README 模板）是 eraTW 口上组织知识，
 * 住在 adapter 的 `scaffold.ts`（纯函数可单测）。**不生成四件套文件**——
 * 登记/配色/开关是函数级产物，属作者后续创作。
 */

import { createElement as h, useMemo, useState } from 'react';
import type { CharaInfo, ProjectService, WorkspaceService } from '@kojo/plugin-api';
import { CORE_FACES, scaffoldDirName, scaffoldKojoProject, sanitizeSegment } from './scaffold';
import { LICENSE_CHOICES, licenseProducesFile, type LicenseKind } from './licenses';

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
  /**
   * 广播「项目已创建」（反馈 3）。与 `onCreated` 分开是有意的：
   * `onCreated` 是本插件内部的缓存失效，`created` 是对外的**事实通知**——
   * 谁引来的这次创建（关联号）由接线侧决定带不带，组件不参与。
   */
  created(info: { projectId: string }): void;
}

/** 剧本号取值域（1-10） */
const SCRIPT_NOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * 「目标角色」下拉项文案（看板 HK-9）。
 *
 * eraTW 的 CHARA 表里 `Chara0.csv` 是 MASTER（名前=你），它**没有**个人口上目录，
 * 于是"选了它 → 建得出包 → 部署时被拒"这条链会在最后一步才炸。
 * 处置是**把代价说在选择的那一刻**，而不是把选项删掉：
 * 没有口上目录的角色照样能写、能导出（手工放置是合法路径），
 * 而且"某角色还没有目录"在新整合包里是常态（语料 168 张 CHARA 表 vs 155 个口上目录）。
 */
export function charaOptionLabel(c: CharaInfo): string {
  return `#${c.no} ${c.name}${c.kojoDir ? '' : ' · 游戏里无个人口上目录'}`;
}

/** 选了无口上目录的角色时的后果说明；有目录或还没选角色 → null（不制造噪音） */
export function noKojoDirWarning(c: CharaInfo | null): string | null {
  if (!c || c.kojoDir) return null;
  return `注意：#${c.no} ${c.name} 在游戏目录里没有个人口上目录。这个包照常书写、照常导出，`
    + '但「部署到游戏目录」会被拒绝——部署需要该角色有自己的口上目录。';
}

/**
 * 从 `workspace.newProjectRequested` 事件载荷里取关联号（反馈 3 的第一拍）。
 *
 * 形态不对一律归 null（= 这次开门没有请求方），**不做"尽力解析"**：
 * 误认一个号，等于把作者没要过的文件塞进一个刚建好的新项目里。
 */
export function readRequestToken(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { requestToken?: unknown }).requestToken;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** 选中协议的说明；表里查不到时返回空串（不显示，而不是显示"未知"） */
function licenseHint(kind: LicenseKind): string {
  return LICENSE_CHOICES.find((c) => c.kind === kind)?.hint ?? '';
}

/** 向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createNewKojoProjectWizard(deps: NewKojoProjectWizardDeps): () => unknown {
  return function NewKojoProjectWizard(): unknown {
    const gameProject = deps.project.current();

    const [workName, setWorkName] = useState('');
    const [authorName, setAuthorName] = useState('');
    const [version, setVersion] = useState('1.0');
    const [charaNo, setCharaNo] = useState<number | null>(null);
    const [scriptNo, setScriptNo] = useState<number>(1);
    // 反馈 4：从"勾不勾占位模板"升级成"选哪一种协议"。缺省 `none` ——
    // 工具不替作者选定许可，也不默认替他"开放"什么。
    const [license, setLicense] = useState<LicenseKind>('none');
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
    const kojoDirWarning = noKojoDirWarning(chara);

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
          license,
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
        deps.created({ projectId: wsProject.id });
        deps.close();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    };

    const fileCount = 1 + (licenseProducesFile(license) ? 1 : 0) + CORE_FACES.length;

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
          charas.map((c) => h('option', { key: c.no, value: String(c.no) }, charaOptionLabel(c)))),

      // 剧本号（1-10）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '剧本号'),
        h('select', {
          value: String(scriptNo),
          onChange: (e: { target: { value: string } }) => setScriptNo(Number(e.target.value)),
        },
          SCRIPT_NOS.map((n) => h('option', { key: n, value: String(n) }, `剧本${n}`)))),

      // 许可协议（反馈 4）：下拉选一种，选中项的一句话说明实时显示在下面。
      // 不用一堆单选按钮：7 个选项会把向导撑长，而作者真正需要的是"选完知道别人能干什么"。
      h('div', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '许可协议'),
        h('select', {
          value: license,
          onChange: (e: { target: { value: string } }) => setLicense(e.target.value as LicenseKind),
        },
          LICENSE_CHOICES.map((c) => h('option', { key: c.kind, value: c.kind }, c.label))),
        h('div', { className: 'wizard-hint dim' }, licenseHint(license))),

      // 落点预览
      h('div', { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '包目录名'),
          h('code', null, dirNamePreview || '—')),
        h('div', { className: 'dim' },
          dirNamePreview
            ? `将生成 ${fileCount} 个文件：中文 README + ${CORE_FACES.length} 个核心面空壳（.kojo，糖与原生 ERB 都能写）${licenseProducesFile(license) ? ' + LICENSE' : ''}；不含四件套，也不含活函数`
            : '作品名 / 版本 / 角色名不得为空或仅含非法字符')),
        // 后果提前说到选它的那一刻，而不是等作者点「部署」才吃一个拒绝（看板 HK-9）
        kojoDirWarning ? h('div', { className: 'wizard-hint dim' }, kojoDirWarning) : null),

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
