/**
 * @kojo/plugin-ui-sugar-preview
 *
 * 糖预览面板（`ui.panel` 槽贡献；v0.3 批 S4-UI）。
 *
 * 把 S4 的糖预览能力第一次带上 UI：当前 `.kojo` 文件 → `sugar.preview`
 * （转译 + 源映射 + 诊断；有存档时附状态回放）→ 面板呈现
 * 「糖源码行 ↔ 生成产物行 ↔ 消息块可达性」。
 *
 * 分层（"一切皆插件"）：
 *   - 转译 / 源映射 / 回放折叠全在 kojo-sugar（`sugar.preview`，**只读**）；
 *     本插件只做**呈现**，绝不自建转译或模拟器；
 *   - 逐行映射 / 诊断 / 全角空格 / 可达性计数等纯逻辑在 `panel-logic.ts`
 *     （零 React，可单测）；
 *   - 当前文件来自宿主事件 `editor.activeFileChanged`；**文本真相**来自宿主事件
 *     `editor.documentChanged`（C2：编辑器缓冲 = 当前可编译真相，读盘只是没收到
 *     广播前的兜底）——两者都只是订阅，不持有宿主引用；
 *   - 跳转复用宿主既有通道 `editor.revealLocation`（与校验面板 / 函数树同款）。
 *
 * 事件纪律：本插件**只消费** `editor.activeFileChanged` / `editor.documentChanged`（C2 文本真相）
 * / `editor.cursorMoved`（C1 反向下行：光标动、面板跟——高亮同源行），
 * **只发**导航意图 `editor.revealLocation`（用户点击行 → 请宿主定位）。它**不写盘**
 * 之外——读盘（`kernel.io.readText`）只在缓冲真相还没广播到的窗口期兜底，绝不改盘，
 * 故不发 `file.changed`（谁改盘谁发）。`sugar.preview` 自身亦只读、不发事件。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type {
  FileIO,
  Plugin,
  SnapshotSourceService,
  SugarPreviewResult,
  SugarPreviewService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, pathKey } from '@kojo/plugin-api';
import {
  DIAG_WINDOW_INITIAL,
  ROW_WINDOW_INITIAL,
  archiveStatus,
  buildArchiveOptions,
  buildDiagnosticRows,
  buildPreviewRows,
  countLines,
  createLiveTextPool,
  degradeText,
  diagWindowSize,
  isKojoFile,
  nextDiagWindow,
  nextRowWindow,
  rowWindowSize,
  summarize,
  type ArchiveOption,
  type ArchiveStatus,
  type DiagnosticRow,
  type PreviewDegrade,
  type PreviewRow,
  type PreviewSummary,
} from './panel-logic';

/* ------------------------------ 渲染窗口哨兵 ------------------------------ */

/**
 * 「显示更多」哨兵（逐行映射 / 诊断两个列表共用）。
 *
 * 进入滚动视口即自动追加下一窗（IntersectionObserver——列表所在面板自带滚动裁剪，
 * 浏览器按可见矩形判相交，不必手动传 root）；观察器不可用（SSR / 测试 / 旧环境）
 * 时退化为**纯点击按钮**——功能不丢。类型口径：本包编译在无 DOM lib 下，
 * `IntersectionObserver` 与元素一律走最小结构化类型；ref 用稳定回调 ref 拿真实节点，
 * 避免每次渲染重挂 observer。
 */
type IntersectionObserverLike = new (
  cb: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void,
) => { observe(target: object): void; disconnect(): void };

/** 哨兵外观：既有的 hint 语言（虚线边 + 弱化文字）+ 主题令牌，整行宽、不抢内容 */
const MORE_BTN_STYLE = { width: '100%', textAlign: 'center', borderStyle: 'dashed' } as const;

function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => {
    const el = anchor.current as object | null;
    const IO = (globalThis as { IntersectionObserver?: IntersectionObserverLike }).IntersectionObserver;
    if (!el || !IO) return;
    const io = new IO((entries) => {
      if (entries.some((e) => e.isIntersecting)) onMoreRef.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return createElement(
    'button',
    {
      ref: setAnchor,
      className: 'ghost small dim pv-more-btn',
      style: MORE_BTN_STYLE,
      title: '滚到此处会自动加载下一批；也可直接点击',
      onClick: () => onMore(),
    },
    `显示更多（还剩 ${remaining}）`,
  );
}

/** 高亮行的最小节点形状（插件 tsconfig 无 DOM lib ⇒ 自备；scrollIntoView 跟随用） */
type FollowNode = { scrollIntoView?(arg: { block: string }): void };

export function createUiSugarPreviewPlugin(): Plugin {
  return {
    id: 'ui-sugar-preview',
    version: '0.3.0',
    // 硬依赖：面板的语义就是"呈现 sugar.preview"，缺席则本插件无意义
    requires: [WellKnownServices.SugarPreview, KernelServices.IO],
    activate(ctx) {
      const previewSvc = ctx.inject<SugarPreviewService>(WellKnownServices.SugarPreview);
      const io = ctx.inject<FileIO>(KernelServices.IO);
      // 存档扫描是**软依赖**：缺席（存档能力未装）只该让面板退化为"两向映射"，
      // 不该让整个面板 inactive——能力缺席要"退化可见"，不能静默（DSH 解耦哲学）。
      let snapshots: SnapshotSourceService | undefined;
      try {
        snapshots = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      } catch {
        snapshots = undefined;
      }

      function PreviewPanel(): unknown {
        const [filePath, setFilePath] = useState<string | null>(null);
        const [archivePath, setArchivePath] = useState<string>('');
        const [source, setSource] = useState<string | null>(null);
        const [result, setResult] = useState<SugarPreviewResult | null>(null);
        const [degrade, setDegrade] = useState<PreviewDegrade>('no-project');
        const [error, setError] = useState<string | null>(null);
        const [nonce, setNonce] = useState(0);
        /** 编辑器缓冲真相（C2）：per-path 最新广播文本；读盘降级为"还没收到广播前"的兜底 */
        const liveRef = useRef(createLiveTextPool());
        /** 当前文件的真相更新序号（广播命中当前文件时 +1，驱动重算） */
        const [liveTick, setLiveTick] = useState(0);
        /**
         * C1 反向下行：光标行（只在「光标就在面板显示的这一份文件里、且不是派生视图」时非 null）。
         * 派生视图的行号不属于这份文件——宁可清高亮，也不指错行。
         */
        const [cursorLine, setCursorLine] = useState<number | null>(null);
        /** 当前高亮行的节点（scrollIntoView 跟随；无匹配 / 未渲染到 = null，静默跳过） */
        const cursorRowRef = useRef<FollowNode | null>(null);
        /** 渲染窗口（行数；undefined = 初始窗口——旧实现硬截 400 行 / 100 条且其余不可达） */
        const [rowWindow, setRowWindow] = useState<number | undefined>(undefined);
        const [diagWindow, setDiagWindow] = useState<number | undefined>(undefined);

        const growRows = useCallback((total: number): void => {
          setRowWindow((prev) => {
            const next = nextRowWindow(prev, total);
            if (next === (prev ?? ROW_WINDOW_INITIAL)) return prev; // 无变化不重渲
            return next;
          });
        }, []);
        const growDiag = useCallback((total: number): void => {
          setDiagWindow((prev) => {
            const next = nextDiagWindow(prev, total);
            if (next === (prev ?? DIAG_WINDOW_INITIAL)) return prev;
            return next;
          });
        }, []);

        // 当前文件（宿主广播）——换文件即重置全部状态
        useEffect(() => {
          const un = ctx.bus.on('editor.activeFileChanged', (p) => {
            setFilePath(p.filePath);
            setSource(null);
            setResult(null);
            setRowWindow(undefined);
            setDiagWindow(undefined);
            setError(null);
            setNonce(0);
            // 高亮随旧文件一起清掉：新文件的位点稍后才到（读盘 + 转译），
            // 中间这一拍若留着旧行号，就会在新文件里"指错行"
            setCursorLine(null);
            setDegrade(p.filePath ? (isKojoFile(p.filePath) ? 'reading' : 'not-kojo') : 'no-project');
          });
          return un;
        }, []);

        // 缓冲真相广播（C2）：记入 per-path 池；命中的是当前文件即触发重算——
        // 未保存的编辑同样进预览（与编辑器波浪线同源）。宿主已防抖/去重，收到即算，
        // 不叠加第二层；糖视图是派生文本、宿主不发，这里无需自备防御。
        useEffect(() => {
          const un = ctx.bus.on('editor.documentChanged', (ev) => {
            liveRef.current.apply(ev.filePath, ev.text);
            if (filePath !== null && pathKey(ev.filePath) === pathKey(filePath)) setLiveTick((n) => n + 1);
          });
          return un;
        }, [filePath]);

        // C1 反向下行：光标位点跟过来。文件判等走 pathKey（大小写 / 分隔符）；
        // 别的文件 / 派生视图 / 无打开文件 → 清高亮（"没有"，不是错误，静默）
        useEffect(() => {
          const un = ctx.bus.on('editor.cursorMoved', (p) => {
            const here =
              !p.derivedView &&
              filePath !== null &&
              p.filePath !== null &&
              pathKey(p.filePath) === pathKey(filePath);
            setCursorLine((prev) => {
              const next = here ? p.line : null;
              return prev === next ? prev : next; // 同一行上的列级移动不重渲
            });
          });
          return un;
        }, [filePath]);

        // 跟随：光标行换人时滚一次（nearest——已在视野内就不动）。行未渲染 / 行号无匹配 → 静默跳过。
        useEffect(() => {
          if (cursorLine === null) return;
          cursorRowRef.current?.scrollIntoView?.({ block: 'nearest' });
        }, [cursorLine]);

        // 归档浏览器选中档 → 预填（UI 插件间零直接依赖，走内核事件）
        useEffect(() => {
          const un = ctx.bus.on('kojo.snapshotSelected', (p) => setArchivePath(p.path));
          return un;
        }, []);

        // 取"当前真相"（C2）：编辑器缓冲广播优先（live），还没收到广播的窗口期退回读盘
        // （disk）；换文件 / 换档 / 手动刷新 / 缓冲更新都走这里——面板与波浪线不再分叉。
        useEffect(() => {
          const path = filePath;
          if (!path || !isKojoFile(path)) return;
          let cancelled = false;
          setError(null);
          // source 与 result 成对落地（逐行映射取两者的行号对齐，错位中间帧会画错标签）
          const previewFor = async (text: string): Promise<void> => {
            try {
              // 角色号由 `sugar.preview` 从产物骨架反推（`.kojo` 声明 `角色:` 即可），
              // 面板只需给出存档路径——不在 UI 层复制这条推导逻辑。
              const r = await previewSvc.preview({
                source: text,
                filePath: path,
                ...(archivePath ? { archivePath } : {}),
              });
              if (cancelled || !r) return;
              setSource(text);
              setResult(r);
              setDegrade('previewing');
            } catch (err: unknown) {
              if (cancelled) return;
              setError(err instanceof Error ? err.message : String(err));
              setDegrade('preview-error');
            }
          };
          const live = liveRef.current.textFor(path);
          if (live !== null) {
            // 有缓冲真相：直接预览，不等读盘（转译有共享缓存，收到即算）
            setDegrade('previewing');
            void previewFor(live);
            return () => {
              cancelled = true;
            };
          }
          setDegrade('reading');
          void io
            .readText(path)
            .then((tf) => {
              if (cancelled) return;
              // 读盘只是首开窗口期的兜底；文本到手后与 live 路径同一条预览链、同一档文案
              setRowWindow(undefined); // 新一批映射行 = 新窗口（刷新后从初始窗口看起）
              setDiagWindow(undefined);
              setDegrade('previewing');
              return previewFor(tf.text);
            })
            .catch((err: unknown) => {
              // 读盘失败（previewFor 自带 catch：预览失败报 'preview-error'，不会漏到这里）
              if (cancelled) return;
              setError(err instanceof Error ? err.message : String(err));
              setDegrade('read-error');
            });
          return () => {
            cancelled = true;
          };
        }, [filePath, nonce, archivePath, liveTick]);

        /* ---------------- 派生渲染数据（memo：只随 result / source / withReach 变） ---------------- */
        /**
         * 行表与概要是 `result + source + withReach` 的纯函数——**与光标行、渲染窗口都无关**。
         *
         * 旧形态每次 render 都重算：`summarize`（内部又 build 一遍全量行）+ `buildPreviewRows`
         * = 每帧两遍 O(源行数) 全量重建，而 `editor.cursorMoved` 每换一行就 setState 触发 render
         * ⇒ 大 `.kojo` 下光标一动就是几遍数万行重建，主线程被压死（编辑界面卡死、滚不动、
         * 着色排队）。memo 到输入身份上：真正重算只在预览结果/源文本变化那一拍发生；
         * 光标移动与「显示更多」增窗零重算。**输出逐字不变**（同样的入参、同样的纯函数）。
         *
         * 位置是硬约束：必须排在下面那串降级态**早返回之前**——React Hooks 不能条件调用。
         */
        const arch: ArchiveStatus = archiveStatus(result);
        const withReach = arch.connected;
        const rows: PreviewRow[] = useMemo(
          () => buildPreviewRows(result, source ?? '', withReach),
          [result, source, withReach],
        );
        const summary: PreviewSummary = useMemo(
          () => summarize(result, source ?? '', withReach),
          [result, source, withReach],
        );

        /** 点击定位：请求宿主打开并滚动到该行（同文件时仅滚动） */
        const reveal = (line: number): void => {
          if (!filePath) return;
          ctx.bus.emit('editor.revealLocation', { filePath, line });
        };

        /* ------------------------------ 头部 ------------------------------ */

        const archiveOpts: ArchiveOption[] = snapshots ? buildArchiveOptions(snapshots.current()) : [];

        const head = createElement(
          'div',
          { className: 'pv-toolbar' },
          createElement('span', { className: 'dim' }, '.kojo 转译检查（转译 + 源映射 + 诊断；只读）'),
          createElement(
            'select',
            {
              className: 'pv-select',
              value: archivePath,
              disabled: archiveOpts.length === 0,
              title: archiveOpts.length === 0 ? '无可用存档（存档能力未装 / 未扫描到档）' : '选择用于回放的存档',
              onChange: (e: { target: { value: string } }): void => setArchivePath(e.target.value),
            },
            createElement('option', { value: '' }, archiveOpts.length === 0 ? '无可用存档' : '（不接存档）'),
            ...archiveOpts.map((o) => createElement('option', { key: o.path, value: o.path }, o.label)),
          ),
          createElement(
            'button',
            {
              className: 'ghost small',
              onClick: () => setNonce((n) => n + 1),
              disabled: !isKojoFile(filePath),
              title: '按当前真相重算（未保存的编辑也算数——与编辑器波浪线同源）',
            },
            '刷新',
          ),
        );

        const shell = (children: ReactNode[]): ReactNode =>
          createElement('div', { className: 'panel-sugar-preview' }, head, ...children);

        /* ------------------------------ 降级态 ------------------------------ */

        if (!isKojoFile(filePath)) {
          return shell([createElement('div', { className: 'pv-empty dim' }, degradeText(degrade))]);
        }
        if (degrade === 'reading') {
          return shell([createElement('div', { className: 'pv-empty dim' }, degradeText(degrade))]);
        }
        if (error) {
          return shell([
            createElement('div', { className: 'pv-error' }, `${degradeText(degrade)}：${error}`),
            createElement(
              'div',
              { className: 'pv-actions' },
              createElement('button', { className: 'ghost small', onClick: () => setNonce((n) => n + 1) }, '重试'),
            ),
          ]);
        }
        if (source === null || result === null) {
          return shell([createElement('div', { className: 'pv-empty dim' }, degradeText('previewing'))]);
        }

        /* ------------------------------ 内容 ------------------------------ */

        // `arch` / `withReach` / `summary` / `rows` 全部取自上方 memo（早返回之前算的那一组）——
        // 走到这里 `source` / `result` 必非空（上面已拦），与 memo 的 `source ?? ''` 同值、结果逐字一致。
        const diagRows = buildDiagnosticRows(result.transpile.diagnostics);

        return shell([
          summaryBox(summary, arch),
          arch.hint ? createElement('div', { className: 'dim pv-hint' }, arch.hint) : null,
          createElement(DiagSection, { diags: diagRows, limit: diagWindow, onGrow: growDiag, onReveal: reveal }),
          createElement(RowsSection, {
            rows,
            limit: rowWindow,
            onGrow: growRows,
            onReveal: reveal,
            cursorLine,
            cursorRef: cursorRowRef,
          }),
        ]);
      }

      ctx.slots.register('ui.panel', {
        id: 'sugar-preview',
        title: '.kojo 转译检查',
        icon: 'preview',
        order: 74,
        // UI 重设计批 P1：写糖时的对照视图 → 副侧栏（VSCode Markdown 预览位，定稿 §四）
        location: 'aux',
        component: PreviewPanel,
      });
    },
  };
}

/* ============================== 渲染分区 ============================== */

/** 概要条 */
function summaryBox(s: PreviewSummary, arch: ArchiveStatus): ReactNode {
  return createElement(
    'div',
    { className: 'pv-summary' },
    chip('存档', arch.who, arch.connected ? undefined : 'warn'),
    chip('源行', String(s.sourceLines)),
    chip('产物行', String(s.generatedLines)),
    chip('已映射', `${s.mappedLines} 行`),
    chip('结构行', String(s.structuralLines)),
    chip('消息块', String(s.blocks)),
    s.unreachableBlocks > 0 ? chip('不可达块', String(s.unreachableBlocks), 'bad') : null,
    s.unknownBlocks > 0 ? chip('未知块', String(s.unknownBlocks), 'warn') : null,
    s.errors > 0 ? chip('错误', String(s.errors), 'bad') : null,
    s.warnings > 0 ? chip('警告', String(s.warnings), 'warn') : null,
    s.fullwidthLines > 0 ? chip('全角空格', `${s.fullwidthLines} 行`, 'warn') : null,
  );
}

function chip(label: string, value: string, cls?: 'bad' | 'warn'): ReactNode {
  return createElement(
    'span',
    { className: `pv-chip${cls ? ` ${cls}` : ''}` },
    createElement('span', { className: 'pv-chip-label' }, label),
    createElement('span', { className: 'pv-chip-value' }, value),
  );
}

/** 诊断区（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface DiagSectionProps {
  readonly diags: readonly DiagnosticRow[];
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 nextDiagWindow 计算） */
  readonly onGrow: (total: number) => void;
  /** 点击诊断行 = 定位源行意图（宿主消费） */
  readonly onReveal: (line: number) => void;
}

export function DiagSection(props: DiagSectionProps): ReactElement {
  const { diags } = props;
  if (diags.length === 0) {
    return createElement('div', { className: 'pv-section' },
      createElement('div', { className: 'pv-section-head' }, '诊断'),
      createElement('div', { className: 'dim pv-hint' }, '无诊断'),
    );
  }
  const win = diagWindowSize(diags.length, props.limit);
  return createElement(
    'div',
    { className: 'pv-section' },
    createElement('div', { className: 'pv-section-head' }, `诊断（${diags.length}）`),
    ...diags.slice(0, win).map((d) =>
      createElement(
        'div',
        {
          key: d.key,
          className: `pv-diag ${d.severity}`,
          onClick: d.line !== null ? () => props.onReveal(d.line as number) : undefined,
          title: d.line !== null ? '点击定位到源行' : '文件级诊断',
        },
        createElement('span', { className: 'pv-diag-sev' }, sevLabel(d.severity)),
        createElement('span', { className: 'pv-diag-loc dim' }, d.line === null ? '—' : `L${d.line}:${d.column ?? 1}`),
        createElement('span', { className: 'pv-diag-msg' }, d.message),
      ),
    ),
    diags.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: diags.length - win,
          onMore: () => props.onGrow(diags.length),
        })
      : null,
  );
}

/** 逐行映射区（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface RowsSectionProps {
  readonly rows: readonly PreviewRow[];
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 nextRowWindow 计算） */
  readonly onGrow: (total: number) => void;
  /** 点击行 = 定位到该源行意图（宿主消费） */
  readonly onReveal: (line: number) => void;
  /** C1 反向下行：光标所在源行（null = 无位点 / 派生视图，不高亮） */
  readonly cursorLine?: number | null;
  /** 高亮行节点回执（面板侧 scrollIntoView 跟随用；缺省 = 不跟随） */
  readonly cursorRef?: { current: FollowNode | null };
}

export function RowsSection(props: RowsSectionProps): ReactElement {
  const { rows } = props;
  const win = rowWindowSize(rows.length, props.limit);
  return createElement(
    'div',
    { className: 'pv-section' },
    createElement('div', { className: 'pv-section-head' }, `逐行映射（${rows.length} 行）`),
    createElement(
      'div',
      { className: 'pv-rows' },
      ...rows.slice(0, win).map((r) => {
        // C1 反向下行：光标所在源行高亮（+ nearest 跟随）
        const isCur = props.cursorLine != null && r.sourceLine === props.cursorLine;
        return createElement(
          'div',
          {
            key: r.key,
            className: `pv-row${r.blank ? ' blank' : ''}${isCur ? ' cur' : ''}`,
            ref: isCur ? props.cursorRef : undefined,
            onClick: () => props.onReveal(r.sourceLine),
            title: '点击定位到该源行',
          },
          createElement('span', { className: 'pv-line-no dim' }, String(r.sourceLine)),
          createElement('span', { className: 'pv-src' }, r.sourceText.length === 0 ? ' ' : r.sourceText),
          r.hasFullwidthSpace
            ? createElement('span', { className: 'pv-fw', title: '含全角空格（保存时告警）' }, '␣全')
            : null,
          createElement('span', { className: 'pv-gen dim' }, `→ ${r.generatedLabel}`),
          r.reachClass !== 'none'
            ? createElement('span', { className: `pv-reach ${r.reachClass}` }, r.reachLabel)
            : null,
        );
      }),
      rows.length > win
        ? createElement(MoreRow, {
            key: 'more',
            remaining: rows.length - win,
            onMore: () => props.onGrow(rows.length),
          })
        : null,
    ),
  );
}

function sevLabel(s: DiagnosticRow['severity']): string {
  if (s === 'error') return '错误';
  if (s === 'warning') return '警告';
  return '提示';
}
