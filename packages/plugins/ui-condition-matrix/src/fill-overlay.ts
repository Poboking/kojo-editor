/**
 * 「填格子」浮层（`ui.overlay` 贡献；React + 结构化事件类型）。
 *
 * 面板把一次填格请求整理成 `FillDraft`（目标包 / 作用域矩阵 / 选中的空格 /
 * 工作区匹配 / IO 与工作区服务），本浮层只做三件事：
 *   1. 选模板语言（.kojo / ERB）与落点（工作区源 / 游戏目录）；
 *   2. 选「新文件」或「追加到既有文件」；
 *   3. 预览生成结果 → 写入 → 打开到追加/新文件的首行。
 *
 * 生成逻辑全在 `matrix-fill.ts`（纯函数），落盘判定全在 `fill-target.ts`
 * （写前四道检查）；本文件不复制任何判据，只编排状态与呈现。
 */

import {
  createElement as h,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  FileIO,
  KojoFaceTable,
  UIPanelProps,
  WorkspaceService,
} from '@kojo/plugin-api';
import type { ConditionMatrix } from './matrix-logic';
import {
  buildFillPlan,
  type FillCellRef,
  type FillChara,
  type FillLanguage,
  type FillPack,
} from './matrix-fill';
import type { WorkspacePackRef } from './matrix-scope';
import {
  fillExtension,
  listFillFiles,
  sanitizeFillFileName,
  suggestFillFileName,
  writeFill,
  type FillFileItem,
  type FillPlace,
  type FillTargetMode,
} from './fill-target';

/** overlay 贡献 id（面板发 `ui.overlay.open` 时引用） */
export const CONDITION_MATRIX_FILL_OVERLAY_ID = 'condition-matrix.fill';

/** 面板交给浮层的一次填格请求（闭包持有；overlay 组件无 props 参数通道） */
export interface FillDraft {
  readonly chara: FillChara;
  readonly pack: FillPack;
  /** 目标包作用域矩阵（已被建表缓存；生成时据此判断「并入 vs 新建」） */
  readonly matrix: ConditionMatrix;
  /** 面板里勾选的空格（可能含目标包已填的格——生成时会跳过并计数） */
  readonly cells: readonly FillCellRef[];
  readonly faceTable?: KojoFaceTable;
  readonly workspace?: WorkspacePackRef;
  readonly io: FileIO;
  readonly workspaces?: WorkspaceService;
  /** 写入成功后打开到 path:line（面板发 editor.revealLocation） */
  readonly reveal: (path: string, line: number) => void;
  /** 写入成功后的面板侧收尾（清空草稿 / 给回执）——在关闭前调用 */
  readonly onWritten: () => void;
  /** 关闭浮层（面板发 ui.overlay.close） */
  readonly close: () => void;
}

const EMPTY_FILES: readonly FillFileItem[] = [];

/** 浮层组件工厂：`draft()` 每次渲染现读（面板在打开前写入） */
export function createConditionMatrixFillOverlay(draft: () => FillDraft | null): (props: UIPanelProps) => ReactNode {
  return function ConditionMatrixFillOverlay(props: UIPanelProps): ReactNode {
    const d = draft();
    const snap = d;
    const initialName = snap
      ? suggestFillFileName(
          snap.chara.no,
          snap.matrix.columns[0]?.label ?? '填空',
          'kojo',
        )
      : '';

    const [language, setLanguage] = useState<FillLanguage>('kojo');
    /** 落点只有工作区：填格子写入口上项目（游戏目录包只做浏览，不在本浮层的写入面） */
    const place: FillPlace = 'workspace';
    const [mode, setMode] = useState<FillTargetMode>('new');
    const [fileName, setFileName] = useState(initialName);
    const [nameTouched, setNameTouched] = useState(false);
    const [files, setFiles] = useState<readonly FillFileItem[]>(EMPTY_FILES);
    const [filesLoading, setFilesLoading] = useState(false);
    const [filesError, setFilesError] = useState<string | null>(null);
    const [fileRel, setFileRel] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const cells = snap?.cells ?? [];
    const plan = useMemo(() => {
      if (!snap) return null;
      return buildFillPlan({
        matrix: snap.matrix,
        cells,
        language,
        pack: snap.pack,
        chara: snap.chara,
        standalone: mode === 'new',
        ...(snap.faceTable ? { faceTable: snap.faceTable } : {}),
      });
    }, [snap, cells, language, mode]);

    // 语言一换，默认文件名跟着扩展名走（作者改过名字就不再覆盖）
    useEffect(() => {
      if (!snap || nameTouched) return;
      setFileName(
        suggestFillFileName(snap.chara.no, snap.matrix.columns[0]?.label ?? '填空', language),
      );
    }, [language, nameTouched, snap]);

    // 追加目标文件：按落点列包目录下的源文件（读失败要显式呈现，不当「没有文件」）
    useEffect(() => {
      if (!snap || mode !== 'append') {
        setFiles(EMPTY_FILES);
        setFilesError(null);
        return;
      }
      const root = snap.workspace?.rootPath;
      if (!root) {
        setFiles(EMPTY_FILES);
        setFilesError('这个口上包没有关联的工作区项目目录。');
        return;
      }
      let cancelled = false;
      setFilesLoading(true);
      setFilesError(null);
      void listFillFiles(snap.io, root)
        .then((items) => {
          if (cancelled) return;
          setFiles(items);
          setFileRel((prev) => (items.some((i) => i.relPath === prev) ? prev : items[0]?.relPath ?? ''));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setFiles(EMPTY_FILES);
          setFilesError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setFilesLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [snap, mode]);

    if (!snap) {
      return h('div', { className: 'cmfill' }, h('div', { className: 'cmfill-empty dim' }, '没有待生成的填格子请求。'));
    }

    const selectedFile = files.find((f) => f.relPath === fileRel) ?? null;
    const workspaceReady = Boolean(snap.workspace && snap.workspaces);
    const effectiveName = sanitizeFillFileName(fileName, language);
    const canWrite =
      !busy &&
      workspaceReady &&
      plan !== null &&
      plan.cellCount > 0 &&
      (mode === 'new' ? effectiveName.length > 0 : selectedFile !== null);

    const icon = (name: string, size: number, fallback: string): ReactNode =>
      (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

    const copy = (): void => {
      if (!plan || plan.code.length === 0) return;
      const clip = (globalThis as {
        navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
      }).navigator?.clipboard;
      if (!clip) {
        setNotice('当前环境没有剪贴板权限——请在预览区手动全选复制。');
        return;
      }
      void clip
        .writeText(plan.code)
        .then(() => setNotice('已复制模板到剪贴板。'))
        .catch((err: unknown) => setNotice(`复制失败：${err instanceof Error ? err.message : String(err)}`));
    };

    const remove = async (): Promise<void> => {
      if (!plan) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      const result = await writeFill({
        io: snap.io,
        ...(snap.workspaces ? { workspaces: snap.workspaces } : {}),
        place,
        mode,
        language,
        code: plan.code,
        pack: snap.pack,
        ...(snap.workspace ? { workspace: snap.workspace } : {}),
        fileName: effectiveName,
        ...(selectedFile ? { file: selectedFile } : {}),
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      snap.onWritten();
      snap.reveal(result.path, result.line);
      snap.close();
    };

    const segmented = <T extends string>(
      label: string,
      value: T,
      options: ReadonlyArray<{ value: T; label: string; title?: string; disabled?: boolean }>,
      onChange: (next: T) => void,
    ): ReactNode =>
      h(
        'div',
        { className: 'cmfill-field' },
        h('span', { className: 'cmfill-label' }, label),
        h(
          'div',
          { className: 'cmfill-seg', role: 'group', 'aria-label': label },
          ...options.map((opt) =>
            h(
              'button',
              {
                key: opt.value,
                type: 'button',
                className: 'cmfill-seg-btn' + (opt.value === value ? ' on' : ''),
                title: opt.title ?? opt.label,
                disabled: opt.disabled,
                'aria-pressed': opt.value === value,
                onClick: () => onChange(opt.value),
              },
              opt.label,
            ),
          ),
        ),
      );

    const appendSelector =
      mode === 'append'
        ? h(
            'div',
            { className: 'cmfill-field' },
            h('span', { className: 'cmfill-label' }, '追加到'),
            filesLoading
              ? h('div', { className: 'cmfill-note dim' }, '正在列出文件…')
              : filesError
                ? h('div', { className: 'cmfill-error' }, `读取文件列表失败：${filesError}`)
                : files.length === 0
                  ? h('div', { className: 'cmfill-note dim' }, '该包目录下没有可追加的 .kojo / .ERB 文件。')
                  : h(
                      'select',
                      {
                        className: 'cmfill-select',
                        value: fileRel,
                        onChange: (e: { target: { value: string } }) => setFileRel(e.target.value),
                      },
                      ...files.map((f) => h('option', { key: f.relPath, value: f.relPath }, f.relPath)),
                    ),
          )
        : h(
            'div',
            { className: 'cmfill-field' },
            h('span', { className: 'cmfill-label' }, '新文件名'),
            h('input', {
              className: 'cmfill-input',
              type: 'text',
              value: fileName,
              placeholder: '例如：条件矩阵填空-K1.kojo',
              onChange: (e: { target: { value: string } }) => {
                setFileName(e.target.value);
                setNameTouched(true);
              },
            }),
            h(
              'div',
              { className: 'cmfill-hint dim' },
              `实际写入：${effectiveName}（扩展名按语言统一为 ${fillExtension(language)}）`,
            ),
          );

    const targetHint = !workspaceReady
      ? h(
          'div',
          { className: 'cmfill-warn' },
          '这个口上包没有关联的工作区项目，或内核工作区服务不可用——填格子只写「我的口上项目」。',
        )
      : h(
          'div',
          { className: 'cmfill-hint dim' },
          `落点：我的口上项目 · ${snap.workspace?.projectName ?? ''} / ${snap.workspace?.artifactName ?? ''}（工作区是权威源；部署时再统一转译进游戏目录）`,
        );

    return h(
      'div',
      { className: 'cmfill' },
      h(
        'div',
        { className: 'cmfill-head' },
        h('h3', null, '填格子 · 生成口上模板'),
        h(
          'div',
          { className: 'cmfill-meta dim' },
          `${snap.chara.name}（K${snap.chara.no}） · ${snap.pack.label}` +
            (snap.workspace ? ` · 我的口上项目：${snap.workspace.artifactName}` : ''),
        ),
      ),
      h(
        'div',
        { className: 'cmfill-intro' },
        h('strong', null, '生成的是口上函数骨架'),
        '：时机与条件已按选中的空缺写好，台词处是等你填的示例注释。写入后会直接打开文件，在骨架里写台词即可。',
      ),
      h(
        'div',
        { className: 'cmfill-grid' },
        h(
          'div',
          { className: 'cmfill-settings' },
          h(
            'div',
            { className: 'cmfill-summary' },
            h('span', { className: 'cmfill-chip' }, `已选 ${cells.length} 格`),
            h('span', { className: 'cmfill-chip dim' }, `并入 ${plan?.mergeCount ?? 0} 个时机`),
            h('span', { className: 'cmfill-chip dim' }, `新建 ${plan?.newCount ?? 0} 个时机`),
            plan && plan.skipped > 0
              ? h(
                  'span',
                  {
                    className: 'cmfill-chip warn',
                    title: '目标包里这些格已经有响应 / 行列已不存在 / 新建文件装不下并入片段',
                  },
                  `跳过 ${plan.skipped} 格`,
                )
              : null,
          ),
          segmented('模板语言', language, [
            { value: 'kojo', label: '.kojo 语法糖', title: '可读性最好；新增时机由糖层生成完整函数' },
            { value: 'erb', label: '原生 ERB', title: '直接写游戏脚本；.kojo 与 .ERB 都可用' },
          ], (next) => setLanguage(next)),
          mergeHint(language, plan, mode === 'new'),
          plan && mode === 'new' && plan.skippedMerge > 0
            ? h(
                'div',
                { className: 'cmfill-warn' },
                `有 ${plan.skippedMerge} 格属于既有函数的「并入片段」，新文件装不下——请把「方式」改为「追加到文件」，或只保留整列缺席的时机。`,
              )
            : null,
          segmented('方式', mode, [
            { value: 'new', label: '新建文件' },
            { value: 'append', label: '追加到文件' },
          ], (next) => {
            setMode(next);
            setFileRel('');
          }),
          appendSelector,
          targetHint,
          error ? h('div', { className: 'cmfill-error' }, error) : null,
          notice ? h('div', { className: 'cmfill-notice' }, notice) : null,
        ),
        h(
          'div',
          { className: 'cmfill-preview' },
          h(
            'div',
            { className: 'cmfill-preview-head' },
            h('span', { className: 'cmfill-label' }, '预览'),
            h(
              'button',
              {
                className: 'cmfill-copy',
                type: 'button',
                disabled: !plan || plan.code.length === 0,
                onClick: copy,
              },
              icon('code', 13, '') as ReactNode,
              '复制',
            ),
          ),
          plan && plan.code.length > 0
            ? h('pre', { className: 'cmfill-code' }, plan.code)
            : h(
                'div',
                { className: 'cmfill-empty dim' },
                plan && plan.skippedMerge > 0 && plan.cellCount === 0
                  ? '所选格都属于本包已有函数的时机——请把「方式」改为「追加到文件」以并入这些分支。'
                  : plan && plan.skipped > 0 && plan.cellCount === 0
                    ? '所选格在目标口上包里都已有响应——换一个目标包或重新选空缺。'
                    : '先在矩阵的「填格子」模式里勾选空缺格。',
              ),
          language === 'kojo' && plan && plan.newCount > 0 && !snap.faceTable
            ? h(
                'div',
                { className: 'cmfill-hint dim' },
                '当前适配器没有提供时机分野表——新增时机已退回原生 ERB 写法（.kojo 允许直通）。',
              )
            : null,
        ),
      ),
      h(
        'div',
        { className: 'cmfill-actions' },
        h('button', { className: 'ghost small', type: 'button', onClick: snap.close, disabled: busy }, '取消'),
        h(
          'button',
          { className: 'small primary', type: 'button', onClick: () => void remove(), disabled: !canWrite },
          busy ? '写入中…' : '写入并打开',
        ),
      ),
    );
  };
}

/**
 * 语言切换时的即时提示（不占一个字段：与分段控件同排的一行小字）。
 * 独立成函数只为让上面的 JSX 结构（createElement）保持可读。
 */
function mergeHint(
  language: FillLanguage,
  plan: ReturnType<typeof buildFillPlan> | null,
  standalone: boolean,
): ReactNode {
  if (!plan) return null;
  if (language === 'kojo' && plan.mergeCount > 0) {
    return h(
      'div',
      { className: 'cmfill-hint dim' },
      '已有函数的时机只生成「并入片段」，不会重复定义同名函数——按注释里的 文件:行 并入即可。',
    );
  }
  if (standalone && plan.newCount > 0) {
    return h(
      'div',
      { className: 'cmfill-hint dim' },
      '新文件会自动补「角色:」文件头（.kojo 另有「口上:」家族段）；追加到既有文件时不重复声明文件头。',
    );
  }
  return null;
}
