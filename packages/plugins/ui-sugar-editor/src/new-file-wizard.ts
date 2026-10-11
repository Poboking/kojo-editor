/**
 * 新建口上文件向导（2026-10-11 UI 重设计批 P2；定稿 §6.1）。
 *
 * 链路：命令 `kojo.newKojoFile`（Ctrl+N / 命令面板 / 工具栏）→ 发内核事件
 * `ui.overlay.open` → 宿主打开本 overlay → 选角色 → 选家族/时机 → 文件名实时预览
 * → 落盘到 writablePaths 内（内核 io 第一道闸）→ `editor.revealLocation` 打开定位
 * → `ui.overlay.close` 自关。
 *
 * 知识分层（零游戏知识自查）：
 * - 角色表 / 可写路径：`kernel.project` 的 GameProject（适配器填充，本插件透传）；
 * - 时机分野选项：`game.adapter` 槽的 `kojoFaceTemplates.faces` 键（只消费不解释）；
 * - 文件名前缀：分野表 `registration.declare` 模板代入角色号推导（如
 *   `M_KOJO_K{n}` → `M_KOJO_K12`）——命名知识留在 adapter，本插件不做字符串拼写；
 *   适配器未提供 declare 模板时向导显式不可用（fail-closed），不猜命名。
 *
 * 写权限前置（定稿 §6.1）：打开即按目标路径 `io.isWritable` 预检，未批准首屏
 * 提示并禁用创建——不等到落盘才炸。
 */

import { createElement as h, useMemo, useState } from 'react';
import type {
  FileIO,
  GameAdapter,
  GameProject,
  KojoFaceTable,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';

/** overlay 贡献 id（命令 run 发 `ui.overlay.open` 时引用；同 id 复用） */
export const NEW_KOJO_OVERLAY_ID = 'sugar.newKojoFile';

export interface WizardDeps {
  io: FileIO;
  project: ProjectService;
  slots: SlotRegistry;
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
    const project = deps.project.current();
    const faceTable = project ? faceTableOf(deps.slots, project) : undefined;
    const declareTemplate = faceTable?.registration?.declare;

    // 可选角色：按编号升序（有口上目录者优先——新文件落在既有角色目录内）
    const charas = useMemo(() => {
      if (!project) return [];
      return [...project.charaIndex.values()].sort((a, b) => {
        const dirA = a.kojoDir ? 0 : 1;
        const dirB = b.kojoDir ? 0 : 1;
        return dirA - dirB || a.no - b.no;
      });
    }, [project]);

    const faces = useMemo(() => (faceTable ? Object.keys(faceTable.faces) : []), [faceTable]);

    const [charNo, setCharNo] = useState<number | null>(charas[0]?.no ?? null);
    const [family, setFamily] = useState('');
    const [face, setFace] = useState<string | null>(null);
    const [faceIndex, setFaceIndex] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /* ---------- 无项目 / 适配器知识缺省：显式降级（不静默） ---------- */
    if (!project) {
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
    // 目标目录：角色既有口上目录；无目录的角色暂不支持（建目录涉及游戏目录约定，属 adapter 知识）
    const targetDir = chara?.kojoDir ?? null;
    const fileName = chara ? previewFileName(declareTemplate, chara.no, family) : '';
    const targetPath = targetDir && fileName ? join(targetDir, fileName) : null;
    // 写权限预检（定稿 §6.1：首屏即提示，不等到落盘才炸）
    const writable = targetPath ? deps.io.isWritable(targetPath) : false;
    // 选中分野的模板含 {i} 时才消费编号（与转译器同口径）
    const needsIndex = face !== null && (faceTable.faces[face]?.template.includes('{i}') ?? false);

    const canCreate =
      !busy && chara !== null && targetPath !== null && writable &&
      (face === null || !needsIndex || /^\d+$/.test(faceIndex.trim()));

    const create = async (): Promise<void> => {
      if (!chara || !targetPath) return;
      setBusy(true);
      setError(null);
      try {
        const text = buildTemplate({
          charNo: chara.no,
          charName: chara.name,
          family,
          face,
          faceIndex,
        });
        await deps.io.writeText(targetPath, text);
        deps.reveal(targetPath);
        deps.close();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      } finally {
        setBusy(false);
      }
    };

    return h('div', { className: 'wizard' },
      h('h3', null, '新建口上文件'),

      // 角色
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '角色'),
        h('select', {
          value: charNo === null ? '' : String(charNo),
          onChange: (e: { target: { value: string } }) =>
            setCharNo(e.target.value ? Number(e.target.value) : null),
        },
          charas.map((c) =>
            h('option', { key: c.no, value: String(c.no) },
              `#${c.no} ${c.name}${c.kojoDir ? '' : '（无口上目录）'}`)))),

      // 家族（可选；同时是文件名片段与 `口上:` 头）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '家族名（可选）'),
        h('input', {
          value: family,
          placeholder: '如：セクハラコマンド；留空 = 初始家族',
          onChange: (e: { target: { value: string } }) => setFamily(e.target.value),
        })),

      // 时机分野（可选；选项来自适配器分野表，本插件不解释键名含义）
      h('label', { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '起始时机（可选）'),
        h('select', {
          value: face ?? '',
          onChange: (e: { target: { value: string } }) => setFace(e.target.value || null),
        },
          h('option', { value: '' }, '（不预置时机块）'),
          faces.map((f) => h('option', { key: f, value: f }, f)))),

      // 时机编号（仅含 {i} 的模板显示）
      needsIndex
        ? h('label', { className: 'wizard-field' },
            h('span', { className: 'wizard-label' }, '时机编号'),
            h('input', {
              value: faceIndex,
              placeholder: '数字，如 310',
              onChange: (e: { target: { value: string } }) => setFaceIndex(e.target.value),
            }))
        : null,

      // 文件名 / 落点实时预览
      h('div', { className: 'wizard-preview' },
        h('div', null, h('span', { className: 'wizard-label' }, '文件名'), h('code', null, fileName || '—')),
        h('div', { className: 'dim' }, targetPath ?? '（该角色暂无口上目录，无法落盘）')),

      // 写权限前置提示
      targetPath && !writable
        ? h('div', { className: 'wizard-warn' },
            '写权限未批准：目标路径不在可写白名单内。请先在状态栏点击「只读」徽章完成授权。')
        : null,
      !chara?.kojoDir && chara
        ? h('div', { className: 'wizard-warn' }, '该角色尚未有个人口上目录，请先在游戏目录中创建。')
        : null,
      error ? h('div', { className: 'wizard-error' }, error) : null,

      // 动作
      h('div', { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: deps.close, disabled: busy }, '取消'),
        h('button', {
          className: 'small primary',
          disabled: !canCreate,
          onClick: () => void create(),
        }, busy ? '创建中…' : '创建并打开')));
  };
}
