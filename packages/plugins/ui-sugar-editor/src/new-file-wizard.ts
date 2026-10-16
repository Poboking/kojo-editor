/**
 * 新建口上文件向导（2026-10-11 UI 重设计批 P2；定稿 §6.1；
 * 2026-10-13 用户反馈 3 改落点——本文件的「落盘位置逻辑」全部让给 `new-file-flow.ts`）。
 *
 * 链路：命令 `kojo.newKojoFile`（Ctrl+N / 命令面板 / 工具栏）→ 发内核事件
 * `ui.overlay.open` → 宿主打开本 overlay → 选角色 → 选家族/时机 → 文件名实时预览
 * → **落口上项目里的作者包**（工作区恒可写）→ `editor.revealLocation` 打开定位
 * → `ui.overlay.close` 自关。
 *
 * 还没有口上项目时（反馈 3），这里不再是死路，而是一个岔口：
 * 「新建口上项目并创建」（主选，把作者正在填的这份内容交给新建项目向导，建好自动落盘）
 * 或「选择文件夹另存…」（自选位置建单文件，走系统保存对话框）。
 * 两条路的时序与后果都住在 `new-file-flow.ts`，本组件只管把选择问清楚。
 *
 * 落点为什么不再是游戏目录：面板顶部常驻的口径是「工作区为权威 · 游戏目录仅部署
 * 目标」，而旧版 Ctrl+N 把新文件直接写进角色的个人口上目录（还要先批准游戏目录写
 * 权限）——同一屏上两条相反的规矩。现在新文件只有一个家：口上项目；进游戏目录
 * 请走「部署」（顺带自动把 `.kojo` 转译成游戏认得的 `.ERB`）。
 *
 * 知识分层（零游戏知识自查）：
 * - 角色表：`kernel.project` 的 GameProject（适配器填充，本插件透传）；
 * - 时机分野选项：`game.adapter` 槽的 `kojoFaceTemplates.faces` 键（只消费不解释）；
 * - 文件名前缀：分野表 `registration.declare` 模板代入角色号推导（如
 *   `M_KOJO_K{n}` → `M_KOJO_K12`）——命名知识留在 adapter，本插件不做字符串拼写；
 *   适配器未提供 declare 模板时向导显式不可用（fail-closed），不猜命名；
 * - 口上项目 / 作者包：`kernel.workspaces` 的通用 project/artifact 模型，
 *   本组件看到的是「项目名 + 包名 + 目录」，不解释包是什么。
 */

import { createElement as h, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  GameAdapter,
  GameProject,
  KojoFaceTable,
  ProjectService,
  SlotRegistry,
  WorkspaceArtifact,
  WorkspaceProject,
} from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import {
  latestArtifact,
  type KojoFileDraft,
  type NewFileFlow,
} from './new-file-flow';

/** overlay 贡献 id（命令 run 发 `ui.overlay.open` 时引用；同 id 复用） */
export const NEW_KOJO_OVERLAY_ID = 'sugar.newKojoFile';

export interface WizardDeps {
  project: ProjectService;
  slots: SlotRegistry;
  /** 落盘编排（工作区列表 / 三条写路径 / 新建项目交接） */
  flow: NewFileFlow;
  /** 关闭自身（经内核事件，向导不持有宿主引用） */
  close(): void;
  /** 打开并定位到新文件 */
  reveal(path: string): void;
}

/** 当前适配器的分野表（与 kojo-sugar 同源：按 adapterId 精确匹配槽位） */
function faceTableOf(slots: SlotRegistry, project: GameProject): KojoFaceTable | undefined {
  for (const c of slots.query('game.adapter')) {
    const adapter: GameAdapter = c.adapter;
    if (adapter.gameId !== project.adapterId) continue;
    if (adapter.kojoFaceTemplates) return adapter.kojoFaceTemplates;
  }
  return undefined;
}

/** 家族名 → 文件名片段（去路径分隔符与首尾空白；非法字符整体拒绝由 validate 负责） */
function familySegment(family: string): string {
  return family.trim().replace(/[\\/:*?"<>|]/g, '');
}

/** 目标文件名预览：`{declare模板代入角色号}[_{家族}].kojo` */
export function previewFileName(declareTemplate: string, charNo: number, family: string): string {
  const base = declareTemplate.replaceAll('{n}', String(charNo));
  const seg = familySegment(family);
  return seg ? `${base}_${seg}.kojo` : `${base}.kojo`;
}

/** 模板内容（v1.2 冻结规范形态：全角冒号、4 空格缩进） */
export function buildTemplate(opts: {
  charNo: number;
  charName: string;
  family: string;
  face: string | null;
  faceIndex: string;
}): string {
  const lines: string[] = [];
  const seg = familySegment(opts.family);
  lines.push(`; ${opts.charName}（${opts.charNo}）${seg ? ` · ${seg}` : ''}`);
  lines.push(`角色: ${opts.charNo}`);
  if (seg) lines.push(`口上: ${seg}`);
  lines.push('');
  if (opts.face) {
    const idx = opts.faceIndex.trim();
    lines.push(`时机 ${opts.face}${idx ? ` ${idx}` : ''}：`);
    lines.push('    「……」');
    lines.push('');
  }
  return lines.join('\n');
}

/** 向导 overlay 组件（createElement 风格，与本插件既有面板一致） */
export function createNewKojoWizard(deps: WizardDeps): () => unknown {
  return function NewKojoWizard(): unknown {
    const gameProject = deps.project.current();
    const faceTable = gameProject ? faceTableOf(deps.slots, gameProject) : undefined;
    const declareTemplate = faceTable?.registration?.declare;

    // 可选角色：按编号升序（角色号只用于文件名模板代入，落点已与游戏目录无关）
    const charas = useMemo(
      () => (gameProject ? [...gameProject.charaIndex.values()].sort((a, b) => a.no - b.no) : []),
      [gameProject],
    );

    const faces = useMemo(() => (faceTable ? Object.keys(faceTable.faces) : []), [faceTable]);

    // 口上项目列表：订阅 flow + 打开即重拉（别处刚建的项目不该要作者手动刷新）
    const [, force] = useState(0);
    useEffect(() => {
      const un = deps.flow.subscribe(() => force((n) => n + 1));
      deps.flow.reload();
      return un;
    }, [deps]);

    /** 自动落盘失败带回来的原因（一次性；能回到这个界面就说明它值得一读） */
    const [notice] = useState<string | null>(() => deps.flow.takeNotice());

    const [charNo, setCharNo] = useState<number | null>(charas[0]?.no ?? null);
    const [family, setFamily] = useState('');
    const [face, setFace] = useState<string | null>(null);
    const [faceIndex, setFaceIndex] = useState('');
    const [projectId, setProjectId] = useState<string | null>(null);
    const [artifactId, setArtifactId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ws = deps.flow.state();

    /* ---------- 无项目 / 适配器知识缺省：显式降级（不静默） ---------- */
    if (!gameProject) {
      return h('div', { className: 'wizard' },
        h('h3', null, '新建口上文件'),
        h('p', { className: 'dim' }, '当前无打开的项目。请先打开项目再新建。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }
    if (!faceTable || !declareTemplate) {
      return h('div', { className: 'wizard' },
        h('h3', null, '新建口上文件'),
        h('p', { className: 'dim' },
          '当前适配器未提供命名模板（kojoFaceTemplates.registration.declare），无法推导新文件名。'),
        h('div', { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭')));
    }

    const chara = charas.find((c) => c.no === charNo) ?? null;
    const fileName = chara ? previewFileName(declareTemplate, chara.no, family) : '';
    // 选中分野的模板含 {i} 时才消费编号（与转译器同口径）
    const needsIndex = face !== null && (faceTable.faces[face]?.template.includes('{i}') ?? false);
    const indexOk = face === null || !needsIndex || /^\d+$/.test(faceIndex.trim());
    const ready = chara !== null && fileName.length > 0 && indexOk && !busy;

    /* ---------- 落点（工作区）：项目 → 包 → 目录 ---------- */

    const project: WorkspaceProject | null =
      ws.projects.find((p) => p.id === projectId) ?? ws.projects[0] ?? null;
    const artifact: WorkspaceArtifact | null =
      project?.artifacts.find((a) => a.id === artifactId) ?? latestArtifact(project);
    const absDir = project ? deps.flow.landingDir(project.id, artifact) : null;
    const targetPath = absDir !== null && fileName.length > 0 ? join(absDir, fileName) : null;

    /** 作者正在填的这份内容（三条路径共用的落盘输入） */
    const draft = (): KojoFileDraft | null => {
      if (!chara) return null;
      return {
        fileName,
        text: buildTemplate({
          charNo: chara.no,
          charName: chara.name,
          family,
          face,
          faceIndex,
        }),
      };
    };

    const createInWorkspace = async (): Promise<void> => {
      const d = draft();
      if (!d || absDir === null) return;
      setBusy(true);
      setError(null);
      const r = await deps.flow.createIn(absDir, d);
      setBusy(false);
      if (r.ok) {
        deps.reveal(r.path);
        deps.close();
        return;
      }
      setError(r.reason);
    };

    /** 反馈 3 a2：自选位置建单文件（保存对话框即授权，落点由作者定） */
    const saveElsewhere = async (): Promise<void> => {
      const d = draft();
      if (!d) return;
      setBusy(true);
      setError(null);
      const r = await deps.flow.saveToPickedFolder(d);
      setBusy(false);
      if (r.ok) {
        deps.reveal(r.path);
        deps.close();
        return;
      }
      // 作者在对话框里反手取消：不是失败，别拿红字拦人
      if (!r.cancelled) setError(r.reason);
    };

    /** 反馈 3 a1 第一拍：把手上的内容交给新建项目向导，向导建完由 flow 落盘 */
    const handoffToNewProject = (): void => {
      const d = draft();
      if (!d) return;
      deps.flow.handoffToNewProject(d);
      deps.close();
    };

    /* ---------- 表单体（三种落点分支共用） ---------- */

    const fields = [
      // 角色（只为文件名里的角色号；落点已与游戏目录无关）
      h('label', { key: 'chara', className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '角色'),
        h('select', {
          value: charNo === null ? '' : String(charNo),
          onChange: (e: { target: { value: string } }) =>
            setCharNo(e.target.value ? Number(e.target.value) : null),
        },
          h('option', { value: '' }, charas.length > 0 ? '选择角色…' : '（游戏项目无角色表）'),
          charas.map((c) => h('option', { key: c.no, value: String(c.no) }, `#${c.no} ${c.name}`)))),

      // 家族（可选；同时是文件名片段与 `口上:` 头）
      h('label', { key: 'family', className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '家族名（可选）'),
        h('input', {
          value: family,
          // 示例取语料里真实存在、且语义即范例的版本名（M_KOJO_中文自制_*，语料 426 处）：
          // 家族段是「别人版」的版本标签，旧日语示例（某个内容分类词）会误导成"填分类"。
          placeholder: '如：中文自制；留空 = 初始家族',
          onChange: (e: { target: { value: string } }) => setFamily(e.target.value),
        })),

      // 起始时机分野（可选；选项来自适配器分野表，本插件不解释键名含义）
      h('label', { key: 'face', className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '起始时机（可选）'),
        h('select', {
          value: face ?? '',
          onChange: (e: { target: { value: string } }) => setFace(e.target.value || null),
        },
          h('option', { value: '' }, '（不预置时机块）'),
          faces.map((f) => h('option', { key: f, value: f }, f)))),

      // 时机编号（仅含 {i} 的模板显示）
      needsIndex
        ? h('label', { key: 'idx', className: 'wizard-field' },
            h('span', { className: 'wizard-label' }, '时机编号'),
            h('input', {
              value: faceIndex,
              placeholder: '数字，如 310',
              disabled: busy,
              onChange: (e: { target: { value: string } }) => setFaceIndex(e.target.value),
            }))
        : null,
    ];

    const fileNameRow = h('div', { key: 'name', className: 'wizard-preview' },
      h('div', null, h('span', { className: 'wizard-label' }, '文件名'),
        h('code', null, fileName || '—')));

    /* ---------- 落点区：读失败 / 读取中 / 还没有项目 / 有项目 ---------- */

    let landing: ReactNode;
    let actions: ReactNode;

    if (ws.error !== null) {
      landing = h('div', { className: 'wizard-error' }, `口上项目读取失败：${ws.error}`);
      actions = h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', { className: 'small primary', onClick: () => deps.flow.reload(), disabled: busy }, '重试'));
    } else if (ws.loading && ws.projects.length === 0) {
      landing = h('div', { className: 'wizard-preview' },
        h('div', { className: 'dim' }, '正在读取口上项目…'));
      actions = h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'));
    } else if (ws.projects.length === 0) {
      /* 反馈 3 的岔口：还没有口上项目 */
      landing = h('div', { className: 'wizard-warn' },
        '还没有口上项目。口上文件写进口上项目里最合适——工作区恒可写，游戏目录只作部署目标。',
        h('div', { className: 'wizard-hint dim' },
          '新建项目会一并生成中文 README 与 8 个核心面空壳；也可以把这份文件另存到你自己挑的文件夹（那样它不参与导出与部署）。'));
      actions = h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'ghost small',
          onClick: () => void saveElsewhere(),
          disabled: !ready,
        }, busy ? '处理中…' : '选择文件夹另存…'),
        h('button', {
          className: 'small primary',
          onClick: handoffToNewProject,
          disabled: !ready,
        }, '新建口上项目并创建'));
    } else {
      // 落点区不给新 class：子项（wizard-field / wizard-preview）自带间距，
      // 再包一层只是给 React 一个 key 位——多一个无样式的 class 名是负资产。
      landing = h('div', {},
        // 只有一项时不出下拉——落点预览那行已经把"写到哪儿"写明白了
        ws.projects.length > 1
          ? h('label', { className: 'wizard-field' },
              h('span', { className: 'wizard-label' }, '口上项目'),
              h('select', {
                value: project?.id ?? '',
                disabled: busy,
                onChange: (e: { target: { value: string } }) => {
                  setProjectId(e.target.value);
                  setArtifactId(null);
                },
              },
                ws.projects.map((p) =>
                  h('option', { key: p.id, value: p.id }, `${p.name}（${p.artifacts.length} 包）`))))
          : null,
        (project?.artifacts.length ?? 0) > 1
          ? h('label', { className: 'wizard-field' },
              h('span', { className: 'wizard-label' }, '作者包'),
              h('select', {
                value: artifact?.id ?? '',
                disabled: busy,
                onChange: (e: { target: { value: string } }) => setArtifactId(e.target.value),
              },
                (project?.artifacts ?? []).map((a) =>
                  h('option', { key: a.id, value: a.id }, a.name))))
          : null,
        h('div', { className: 'wizard-preview' },
          h('div', null, h('span', { className: 'wizard-label' }, '写入位置'),
            h('code', null, targetPath ?? '—')),
          h('div', { className: 'dim' },
            absDir !== null
              ? '工作区恒可写；要进游戏目录请用「部署」（自动把 .kojo 转成 .ERB）。'
              : '这个项目还没有作者包——换一个，或先用「＋ 新建」建一个作品包。')));
      actions = h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          onClick: () => void createInWorkspace(),
          disabled: !ready || absDir === null,
        }, busy ? '创建中…' : '创建并打开'));
    }

    return h('div', { className: 'wizard' },
      h('h3', null, '新建口上文件'),
      notice ? h('div', { className: 'wizard-error' }, notice) : null,
      ...fields,
      fileNameRow,
      landing,
      error ? h('div', { className: 'wizard-error' }, error) : null,
      actions);
  };
}
