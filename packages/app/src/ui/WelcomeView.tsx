import { useEffect, useState, type ReactElement } from 'react';
import type { FileStat, RecentProject } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
import type { RecentFileRecord } from './recent-files';
// 版本号单一真源 = app 包清单（与 `src/bootstrap.ts` 的 `APP_VERSION` 同一条路）：
// 欢迎页那格不许再抄一份字面量，抬版本只改三处清单（闸见 `tests/app-version.test.ts`）。
import { version as APP_VERSION } from '../../package.json';
import type { AppPhase } from './App';
import { Icon } from './icons';
import { declareContextSurface } from './context-surfaces';
import './welcome.css';

/**
 * 欢迎页登记为**免右键面**（清单里 `welcome` 带 `suppressMenu: true`）。
 *
 * 声明在宿主模块顶层（"谁渲染谁声明"），但它**没有 `build`**——这一面永远不提供菜单。
 * 2026-10-26 之前这里有 `welcome` / `welcome-recent` 两个带菜单的面：弹窗态跑轻档样式，
 * 菜单拿不到定位几何 ⇒ 通栏裸块 + 0 高遮罩 ⇒ 点空白关不掉、整窗拖动被判据带死
 * （详见 `context-surfaces.ts` 的 `SUPPRESSED_SURFACE_IDS` 注释）。
 * 页面上的每件事都有实心入口（打开 / 继续上次会话 / 移除 / 教程），菜单在这里没有独占能力。
 */
declareContextSurface({ id: 'welcome', ariaLabel: '欢迎页', area: 'chrome' });

/** 教程卡片指向的语义 id（与内核事件 `ui.tutorial.open` 的载荷同一词表） */
export type WelcomeTutorialId = 'kojo' | 'sugar' | 'kojo2' | 'reference';

/** 无接线时的稳定空表（模块级常量：不给探测 effect 每次渲染造新引用） */
const NO_RECENT_FILES: readonly RecentFileRecord[] = [];

/** 教程卡片的静态半边：标题 / 一句说明 / 图标。打开动作由宿主接线成内核意图。 */
export interface WelcomeTutorialEntry {
  readonly id: WelcomeTutorialId;
  readonly title: string;
  readonly blurb: string;
  readonly icon: 'book' | 'wand' | 'code' | 'structure';
}

/**
 * 右侧「教程」四张卡片（顺序 = **阅读顺序**：先工作流、再 `.kojo` 老写法、再 2.0 新写法、最后查表）。
 * 纯数据、无副作用：卡片点击只把 `id` 交给 App → 内核事件，宿主不理解教程内容。
 *
 * 卡名逐字取各本教程自己的 title（`Kojo 2.0 语言教程` 就是正文那一本的标题，不许另抄）；
 * 本层只认语义 id，一句教程内容都不写。四张卡共用同一条开合判据（`tutorialsOpenable`）：
 * 内核没装配好 / 项目正在打开时按钮**disabled 且带 title 说明**，不靠"点了没反应"。
 *
 * 批次十一（视觉 L04）：四张卡不再常驻首屏——整组收进右栏那**一条**次级入口
 * 「教程 · 4 篇内置」的折叠里。折叠是 CSS/DOM 层面的收起，**卡片本身照常渲染**
 * （真壳与 `welcome-layout.test.ts` 都按 4 枚 `welcome-tutorial` 计数），
 * 于是「教程入口重复三处」里欢迎页这一处只剩一行文字，另外两处不归本 lane。
 */
export const WELCOME_TUTORIALS: readonly WelcomeTutorialEntry[] = [
  {
    id: 'kojo',
    title: '口上教程',
    blurb: '从新建、编辑到部署：作者工作流的全流程。',
    icon: 'book',
  },
  {
    id: 'sugar',
    title: '语法教程',
    blurb: '引号、条件、随机、插值……台词写法逐条对照。',
    icon: 'wand',
  },
  {
    id: 'kojo2',
    title: 'Kojo 2.0 语言教程',
    blurb: '默认档还是老写法；这一本教 2.0 的新写法。',
    icon: 'code',
  },
  {
    id: 'reference',
    title: '语法全表',
    blurb: '指令、函数与写法速查，写到一半也能回来查。',
    icon: 'structure',
  },
];

/** 「教程 · 4 篇内置」那一条次级入口的字数来源（不许再手抄一个 4） */
const TUTORIAL_COUNT = WELCOME_TUTORIALS.length;

interface Props {
  phase: AppPhase;
  error: string | null;
  recent: RecentProject[];
  tauri: boolean;
  kernelReady: boolean;
  onOpenDirectory: () => void;
  onOpenRecent: (dir: string) => void;
  /**
   * 最近列表的写操作走回调而非把 kernel 传进来：`recent` 状态的单源在 App
   * （bootstrap / 打开 / 关闭三处 setRecent），乐观更新的回滚也只能落在状态
   * 所有者那里——组件内再持一份必然分叉。WelcomeView 保持纯展示（无 Kernel
   * 类型耦合），kernel 能力经 App 的回调注入。
   */
  onRemoveRecent: (dir: string) => void;
  onClearRecent: () => void;
  /**
   * 最近文件（MM-7）：打开/跳转落地即记的跨项目文件列表。写操作同最近项目——
   * 单源在 App（记录点/摘除/落盘都在那里），组件只展示与发点击意图。
   * **可选**（additive 接线）：旧渲染方（welcome-layout 冒烟等）不传也能挂载，
   * 组件侧退化为「不显示最近文件区」而不是炸。
   */
  recentFiles?: readonly RecentFileRecord[];
  /** 最近文件点击：同项目直接开、换项目先开项目再开（接线与判据在 App） */
  onOpenRecentFile?: (path: string, rootDir: string) => void;
  /** 失效探测（A4）；resolve undefined = 探测不可用（浏览器壳等），行内不标记 */
  statPath: (path: string) => Promise<FileStat | null | undefined>;
  /** 最近一次打开的项目根（null = 无会话可继续）；退出/崩溃守护批 */
  resumeRoot: string | null;
  onResumeSession: () => void;
  /** 崩溃恢复待决（null = 无）；root 为空串时不给恢复入口（没有可回去的项目根） */
  crashRecovery: { root: string; files: number } | null;
  onRecoverCrash: () => void;
  onDiscardCrash: () => void;
  /** 教程卡片只发语义 id；映射与打开由教程提供方（适配器）解释 */
  onOpenTutorial: (tutorial: WelcomeTutorialId) => void;
}

/**
 * 产品定位文案（品牌位，非功能耦合）：功能性文案一律游戏无关（解耦审计 A 项
 * 覆盖 app UI 层）；此处游戏名属产品自我介绍，行级豁免（audit-allow）。
 *
 * 2026-10-18（AM-1 P4）从「eraTW 口上编辑器」改为「era 口上编辑器」：编辑器已是
 * **多游戏**（eraTW + eraAkumaMaid 两枚 adapter，detect 各异），品牌位不该钉在
 * 其中一个游戏名上——那会让另一个游戏的作者以为下错了软件。
 */
const TAGLINE = 'era 口上编辑器 · 结构感知 × 一切皆插件';

/** 最近行的渲染态：unknown = 尚未探测 / 探测失败（不标记）；missing = stat 为 null（目录不在了） */
export type RecentRowState = 'ok' | 'missing' | 'unknown';

/** 「recents + stat 结果 → 行渲染态」的纯函数半边（单测钉住三态语义） */
export function recentRowState(stat: FileStat | null | undefined): RecentRowState {
  if (stat === undefined) return 'unknown';
  return stat === null ? 'missing' : 'ok';
}

/**
 * 探测缓存键：pathKey 折叠大小写与分隔符（与内核 removeRecent 的判等口径一致），
 * lastOpenedAt 保证「重开过 ⇒ 时间戳变 ⇒ 重扫」——同一行不会被旧探测结果钉死。
 */
export function recentStatKey(r: Pick<RecentProject, 'rootDir' | 'lastOpenedAt'>): string {
  return `${pathKey(r.rootDir)}\u0000${r.lastOpenedAt}`;
}

/**
 * 最近文件的探测缓存键（MM-7）：同款口径——pathKey(path) + openedAt，
 * 重开过的文件时间戳变 ⇒ 重扫（删了又回来的文件不会被旧探测结果钉死）。
 */
export function recentFileStatKey(r: Pick<RecentFileRecord, 'path' | 'openedAt'>): string {
  return `${pathKey(r.path)}\u0000${r.openedAt}`;
}

/** 乐观移除的纯函数半边：按 pathKey 摘条目，其余逐字保序（与内核 removeRecent 同口径） */
export function removeRecentOptimistic(list: RecentProject[], rootDir: string): RecentProject[] {
  const key = pathKey(rootDir);
  return list.filter((r) => pathKey(r.rootDir) !== key);
}

/**
 * 取路径末段当卡片标题（盘符 / 共享名这类"整条路径当标题"读不出项目是谁）。
 * 分隔符两种都吃；末段为空（根目录）时原样退回整条路径——不猜、不空着。
 */
export function pathBaseName(p: string): string {
  const seg = p.split(/[\\/]/).filter((s) => s.length > 0).pop();
  return seg && seg.length > 0 ? seg : p;
}

const DAY_MS = 86_400_000;

/**
 * 「上次打开」的口语档：同一天 →「今天打开」，往前 昨天 / N 天前 / N 周前 / N 个月前，
 * 跨年整条退成 `YYYY-MM-DD`（"3 天前"跨过一年后就成了谎话，日期不会）。
 *
 * **只用日历整数差**（先归零到 UTC 同日再取天数）：靠毫秒差除 86400000 会在
 * 「昨天 23:59 → 今天 00:01」这种跨天上算出"0 天前"，正是本函数要避开的。
 * `now` 由调用方注入 ⇒ 一次渲染内所有行同一个"今天"，纯函数可测。
 */
export function formatLastOpened(lastOpenedAt: number, now: number): string {
  if (!Number.isFinite(lastOpenedAt) || !Number.isFinite(now)) return '上次打开时间未知';
  const dayIndex = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const diffDays = Math.round((dayIndex(now) - dayIndex(lastOpenedAt)) / DAY_MS);
  if (diffDays <= 0) return '今天打开';
  if (diffDays === 1) return '昨天打开';
  if (diffDays < 7) return `${diffDays} 天前打开`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前打开`;
  const opened = new Date(lastOpenedAt);
  const sameYear = opened.getFullYear() === new Date(now).getFullYear();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const md = `${pad(opened.getMonth() + 1)}-${pad(opened.getDate())}`;
  return sameYear ? `${md} 打开` : `${opened.getFullYear()}-${md} 打开`;
}

/**
 * 最近文件按所属项目根归堆（pathKey 折大小写/分隔符，与内核判等口径一致）。
 * 卡片上的「N 个最近文件」由此而来——**只用已经传进来的 props**，不为呈现去问内核。
 */
export function countFilesByRoot(files: readonly RecentFileRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const key = pathKey(f.rootDir);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * 通知条家族（`.notice` 底色由 styles.css 供给；本批只加"图标 + 文案"这层呈现）：
 * 浏览器环境 = warn 档、内核装配 = 状态档（转圈）、失败 = error 档、崩溃恢复 = 行动档。
 * 色值不在这里写：`.notice.warn/.error` 目前把 rgba 写死在 styles.css，属 L01 地盘。
 * // ui-kit-candidate: .notice 家族的行内语义图标位（图标 + 一句人话 + 可选动作）
 */
function NoticeIcon({ kind }: { kind: 'warn' | 'error' | 'info' }): ReactElement {
  const name = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info';
  return (
    <span className="welcome-notice-icon" aria-hidden="true">
      <Icon name={name} size="md" />
    </span>
  );
}

/**
 * 欢迎页（批次十一 · 视觉 L04「两态重构」）：无项目时的整页视图。
 *
 * **首屏态**只有三件事：品牌头 → 一个主 CTA（打开文件夹…）→ 最近项目大卡。
 * **展开态**是次级层：右栏一条「教程 · 4 篇内置」的折叠（内含四张卡 + 默认收起的
 * 编译样例）、左栏一条「最近文件」折叠。折叠一律用原生 `<details>`：收起时内容
 * 仍在 DOM 里（SSR 与真壳探针都数得到），只是不占首屏注意力。
 *
 * 卡面给的是**可决策信息**（项目名 / 适配器 / 上次打开 / 该项目下的最近文件数 /
 * 完整路径 / 目录是否还在），不是只有一行路径。脏文件数与包数不在 `RecentProject`
 * 载荷里，要等接线（见批次回执「待组长接线」）。
 *
 * 数据流保持原样：最近列表的读取/写回全部走 App 注入的回调（组件不持有 kernel）；
 * 教程卡片也只把语义 id 交给 App，由 `ui.tutorial.open` 内核事件送进教程提供方。
 * 结构性类名（`.welcome` / `.welcome-card` / `.welcome-recent` / `.welcome-recent-open`
 * / `.welcome-recent-path` / `.welcome-resume`）是冒烟 page-object 与 PS-10 意图闸的
 * 依赖面，**一个字都不动**——改一个就有 tools/tests 的两条源形状守卫红。
 *
 * overlay 的宿主在 `WelcomeOverlayHost`（App 的无项目分支并列渲染），本组件只管
 * 欢迎页自己的排版与关闭态。
 */
export function WelcomeView({
  phase,
  error,
  recent,
  tauri,
  kernelReady,
  onOpenDirectory,
  onOpenRecent,
  onRemoveRecent,
  onClearRecent,
  recentFiles,
  onOpenRecentFile,
  statPath,
  resumeRoot,
  onResumeSession,
  crashRecovery,
  onRecoverCrash,
  onDiscardCrash,
  onOpenTutorial,
}: Props): ReactElement {
  // 最近文件（MM-7）：未接线（可选 prop 缺席）时退化为稳定空表——区不显示，不炸
  const files = recentFiles ?? NO_RECENT_FILES;
  const opening = phase === 'opening';
  // 失效标记（A4）：逐条异步 stat，null = 目录不存在 → 行内灰态标记（仍可点、仍可移除）。
  // 结果按 pathKey+lastOpenedAt 缓存，recent 变化只补扫缓存缺失的键——不每帧重扫。
  const [statCache, setStatCache] = useState<Map<string, FileStat | null>>(new Map());
  useEffect(() => {
    if (!kernelReady) return;
    const pending = recent.filter((r) => !statCache.has(recentStatKey(r)));
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pending.map(async (r): Promise<readonly [string, FileStat | null | undefined]> => {
        try {
          return [recentStatKey(r), await statPath(r.rootDir)] as const;
        } catch {
          return [recentStatKey(r), undefined] as const; // 探测不可用：不标记，不缓存
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setStatCache((prev) => {
        const next = new Map(prev);
        for (const [k, v] of entries) if (v !== undefined) next.set(k, v);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // statCache 在依赖里：补扫完自然转 idle（pending 为空即早退），不会成环
  }, [kernelReady, recent, statPath, statCache]);

  // 失效探测（MM-7 最近文件区）：同款机制、探测 r.path 而不是 r.rootDir——
  // null = 文件不存在 ⇒ 行内灰标「文件不存在」（仍可点，点了让 App 的重试逻辑说话）。
  const [fileStatCache, setFileStatCache] = useState<Map<string, FileStat | null>>(new Map());
  useEffect(() => {
    if (!kernelReady) return;
    const pending = files.filter((r) => !fileStatCache.has(recentFileStatKey(r)));
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pending.map(async (r): Promise<readonly [string, FileStat | null | undefined]> => {
        try {
          return [recentFileStatKey(r), await statPath(r.path)] as const;
        } catch {
          return [recentFileStatKey(r), undefined] as const; // 探测不可用：不标记，不缓存
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setFileStatCache((prev) => {
        const next = new Map(prev);
        for (const [k, v] of entries) if (v !== undefined) next.set(k, v);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // fileStatCache 在依赖里：补扫完自然转 idle（pending 为空即早退），不会成环
  }, [kernelReady, files, statPath, fileStatCache]);

  /* ---------------------- 右键菜单：本页是免右键面 ---------------------- */
  // 根元素挂 `data-context-surface="welcome"`，清单里这一面标了 `suppressMenu` ⇒ 整片不出菜单
  // （判据在 `context-surfaces.ts` 的第零级）。原先这里还有 welcome-recent 行级面与一枚接线桥，
  // 2026-10-26 一并撤掉：弹窗态跑在轻档样式下，菜单没有定位几何 ⇒ 通栏裸块 + 0 高遮罩，
  // 关不掉且连整窗拖动一起废掉（详见 `SUPPRESSED_SURFACE_IDS` 的注释）。

  const canOpen = kernelReady && !opening;
  const tutorialsOpenable = canOpen;
  // 一次渲染同一个"今天"：卡片之间的"3 天前 / 昨天"必须互相可比
  const now = Date.now();
  const filesByRoot = countFilesByRoot(files);
  const rowState = (r: RecentProject): RecentRowState => recentRowState(statCache.get(recentStatKey(r)));
  const missingDirs = recent.reduce((n, r) => n + (rowState(r) === 'missing' ? 1 : 0), 0);

  return (
    // 面根 = 免右键白名单面（清单里 `welcome` 标了 `suppressMenu`）：本页整片不出右键菜单。
    <div className="welcome welcome-screen" data-context-surface="welcome">
      <div className="welcome-scroll">
        <div className="welcome-stage">
          <div className="welcome-card" role="region" aria-label="欢迎">
            <main className="welcome-main">
              {/* ── 首屏第 1 件：品牌头（字号档 = display，页内唯一） ── */}
              {/* 弹窗拖动由 App 的整窗 mousedown 接管（除控件/滚动条/模态外任意位置可拖），
                  这里不再挂 data-tauri-drag-region，免得同一次按下触发两遍原生拖动。 */}
              <header className="welcome-brand">
                <h1>
                  kojo-editor <span className="ver">v{APP_VERSION}</span>
                </h1>
                <p className="welcome-tagline">{TAGLINE}</p>
              </header>

              {/* 通知条家族：有事要说才出现，平时零占位。色温沿用 .notice 家族，
                  本批补语义图标位（原先纯文字，读不出是"提示"还是"出错"）。 */}
              {!tauri ? (
                <div className="notice warn welcome-notice">
                  <NoticeIcon kind="warn" />
                  <span className="welcome-notice-copy">
                    当前运行在浏览器环境：文件系统能力不可用。请通过桌面壳启动（<code>pnpm tauri dev</code>）。
                  </span>
                </div>
              ) : null}

              {/* 「内核装配中…」这一条必须保持 `className="notice welcome-notice" role="status"`
                  （无修饰类）——DOM 冒烟按 `.notice:not(.crash-recovery)` 判"页面还没挂好"，
                  形状由 tools/tests/welcome-crash-notice-selector.test.ts 钉死。 */}
              {!kernelReady ? (
                <div className="notice welcome-notice" role="status">
                  {/* 转圈复用全局 `.spinner`（动画名 styles.css 单源，时长吃 tokens 的 --anim-spin）；
                      这里只管占位不重画动画 */}
                  <span className="spinner welcome-notice-icon" aria-hidden="true" />
                  <span className="welcome-notice-copy">内核装配中…</span>
                </div>
              ) : null}

              {error ? (
                <div className="notice error welcome-notice" role="alert">
                  <NoticeIcon kind="error" />
                  <span className="welcome-notice-copy">{error}</span>
                </div>
              ) : null}

              {/* ── 首屏第 2 件：唯一的主 CTA（不再挂"启动"这类小灰标签；次级动作是"继续上次会话"） ── */}
              <section className="welcome-section welcome-start" aria-label="打开项目">
                <div className="welcome-actions">
                  <button
                    className="primary big welcome-open u-sheen u-ripple"
                    onClick={onOpenDirectory}
                    disabled={!canOpen}
                  >
                    <Icon name="files" size="md" />
                    <span>{opening ? '正在打开…' : '打开文件夹…'}</span>
                  </button>
                  {!crashRecovery && resumeRoot ? (
                    <button
                      className="ghost welcome-resume"
                      onClick={onResumeSession}
                      disabled={!canOpen}
                      title={resumeRoot}
                    >
                      <Icon name="history" size="md" />
                      <span className="welcome-resume-label">继续上次会话</span>
                      <span className="welcome-resume-path">{resumeRoot}</span>
                    </button>
                  ) : null}
                </div>
                <p className="welcome-start-hint">
                  {!kernelReady
                    ? '内核装配完成后即可打开文件夹；打开过的项目会出现在下方。'
                    : recent.length > 0
                      ? '也可以直接点下方最近项目，或把项目文件夹拖进窗口。'
                      : '选一个放口上文件的文件夹——打开过的会出现在这里，下次一键回来。'}
                </p>
              </section>

              {/* 崩溃恢复横幅（退出/崩溃守护批）：一行事由 + 两个动作。
                  `notice crash-recovery` 两个 token 必须留在同一行——冒烟判据 `.notice:not(.crash-recovery)`
                  靠它把"有事待处理"从"页面没挂好"里摘出去（源形状守卫钉死）。 */}
              {/* 恢复永不自动写盘——内容只装回编辑器当未保存修改，存不存由用户决定 */}
              {crashRecovery && crashRecovery.root ? (
                <div className="notice crash-recovery welcome-notice" role="alert">
                  <NoticeIcon kind="warn" />
                  <p className="welcome-notice-copy">
                    上次异常退出，{crashRecovery.files} 个文件的未保存内容已自动保留。
                  </p>
                  <div className="crash-recovery-actions">
                    <button className="primary" onClick={onRecoverCrash} disabled={opening}>
                      恢复并打开
                    </button>
                    <button className="ghost" onClick={onDiscardCrash} disabled={opening}>
                      丢弃
                    </button>
                  </div>
                </div>
              ) : null}

              {/* ── 首屏第 3 件：最近项目大卡（次级层里"最近文件"另开一条折叠） ── */}
              <section className="welcome-section welcome-recent" aria-labelledby="welcome-recent-title">
                <div className="welcome-section-head">
                  <h2 className="welcome-section-title" id="welcome-recent-title">
                    最近项目
                    {recent.length > 0 ? <span className="welcome-section-count">{recent.length}</span> : null}
                  </h2>
                  {recent.length > 0 ? (
                    <div className="welcome-section-tools">
                      {missingDirs > 0 ? (
                        <span className="welcome-section-warn">{missingDirs} 个目录已不在</span>
                      ) : null}
                      <button
                        className="welcome-clear"
                        onClick={onClearRecent}
                        title="清空列表记录，不会删除磁盘上的项目文件"
                      >
                        清除全部
                      </button>
                    </div>
                  ) : null}
                </div>

                {recent.length === 0 ? (
                  <p className="welcome-empty">
                    {kernelReady
                      ? '还没有打开过项目。打开一个文件夹后，它会出现在这里。'
                      : '内核装配完成后，这里会列出最近项目。'}
                  </p>
                ) : (
                  <ul className="welcome-recent-list welcome-project-grid">
                    {recent.map((r) => {
                      const missing = rowState(r) === 'missing';
                      const fileCount = filesByRoot.get(pathKey(r.rootDir)) ?? 0;
                      return (
                        <li
                          key={r.rootDir}
                          className={`welcome-recent-row welcome-project-card${missing ? ' is-missing' : ''}`}
                        >
                          {/* 整张卡是可点开的按钮；`.welcome-recent-path` 的文本必须逐字 = rootDir
                              （真壳 page-object 按它找行，见 tools/smoke-lib.mjs） */}
                          <button
                            className="welcome-recent-open"
                            onClick={() => onOpenRecent(r.rootDir)}
                            title={missing ? `${r.rootDir}（目录不存在，点击重试）` : r.rootDir}
                          >
                            <span className="welcome-project-head">
                              <span className="welcome-project-name">{pathBaseName(r.rootDir)}</span>
                              <span className="welcome-recent-badge">{r.adapterId}</span>
                            </span>
                            <span className="welcome-project-meta">
                              <span className="welcome-project-when">{formatLastOpened(r.lastOpenedAt, now)}</span>
                              {/* 卡面第三条可决策信息：该项目下记到了几个最近文件（0 个就不占位） */}
                              {fileCount > 0 ? <span className="welcome-project-files">{fileCount} 个最近文件</span> : null}
                            </span>
                            <span className="welcome-recent-path">{r.rootDir}</span>
                            {missing ? (
                              <span className="welcome-recent-badge is-missing">目录不存在</span>
                            ) : null}
                          </button>
                          <button
                            className="welcome-recent-remove"
                            onClick={() => onRemoveRecent(r.rootDir)}
                            title={`从列表移除：${r.rootDir}`}
                            aria-label={`从列表移除：${r.rootDir}`}
                          >
                            移除
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* 最近文件（MM-7）：跨项目的打开记录——次级，默认折叠。
                  区类名 welcome-recent-files 必须留在列表/空态的**祖先**上（用例按后代关系查），
                  且不能并进 .welcome-recent（那是 PS-10 的开项目意图面，混了会改预取时机）。 */}
              <section className="welcome-fold welcome-recent-files" aria-labelledby="welcome-recent-files-title">
                <details className="welcome-fold-box">
                  <summary className="welcome-fold-summary">
                    <Icon name="chevron-right" size="sm" className="welcome-fold-caret" />
                    <h2 className="welcome-section-title" id="welcome-recent-files-title">
                      最近文件
                    </h2>
                    <span className="welcome-section-count">{files.length}</span>
                  </summary>
                  {files.length === 0 ? (
                    <p className="welcome-empty">还没有最近文件——打开过的文件会出现在这里。</p>
                  ) : (
                    <ul className="welcome-recent-list">
                      {files.map((r) => {
                        const missing = recentRowState(fileStatCache.get(recentFileStatKey(r))) === 'missing';
                        const name = pathBaseName(r.path);
                        const projectName = pathBaseName(r.rootDir);
                        return (
                          <li key={r.path} className={`welcome-recent-row${missing ? ' is-missing' : ''}`}>
                            <button
                              className="welcome-recent-open"
                              onClick={() => onOpenRecentFile?.(r.path, r.rootDir)}
                              title={
                                missing
                                  ? `${r.path}（文件不存在，点击重试打开）`
                                  : `${r.path}（属于项目 ${r.rootDir}）`
                              }
                            >
                              <span className="welcome-recent-file">
                                <span className="welcome-recent-path">{name}</span>
                                <span className="welcome-recent-sub">{r.path}</span>
                              </span>
                              <span className="welcome-recent-meta">
                                {missing ? (
                                  <span className="welcome-recent-badge is-missing">文件不存在</span>
                                ) : null}
                                <span className="welcome-recent-badge" title={r.rootDir}>
                                  {projectName}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </details>
              </section>

              {/* 一句话讲清"打开即识别 / 默认只读 / 首次保存才申请权限"——黑话（CHARA 映射、
                  口上域索引）全删：这些是打开后自动发生的事，不需要作者在选目录前理解。 */}
              <p className="welcome-hint">
                打开目录即自动识别游戏；游戏目录默认<strong>只读</strong>，第一次保存才申请写入权限。
              </p>
            </main>

            <aside className="welcome-side" aria-labelledby="welcome-tutorials-title">
              {/* 教程收成**一条**次级入口：收起时只占一行字，展开才见四张卡与样例。
                  四张卡照旧渲染（`welcome-layout.test.ts` 数得到 4 枚）。 */}
              <section className="welcome-fold welcome-tutorials-fold">
                <details className="welcome-fold-box">
                  <summary className="welcome-fold-summary">
                    <Icon name="chevron-right" size="sm" className="welcome-fold-caret" />
                    <h2 className="welcome-side-title" id="welcome-tutorials-title">
                      <Icon name="book" size="md" />
                      教程
                    </h2>
                    <span className="welcome-fold-count">{TUTORIAL_COUNT} 篇内置 · 随时可看</span>
                  </summary>

                  <div className="welcome-tutorials">
                    {WELCOME_TUTORIALS.map((t) => (
                      <button
                        type="button"
                        key={t.id}
                        className="welcome-tutorial"
                        onClick={() => onOpenTutorial(t.id)}
                        disabled={!tutorialsOpenable}
                        title={!kernelReady ? '内核装配中…' : opening ? '正在打开项目…' : `打开「${t.title}」`}
                      >
                        <span className="welcome-tutorial-icon">
                          <Icon name={t.icon} size="md" />
                        </span>
                        <span className="welcome-tutorial-copy">
                          <span className="welcome-tutorial-title">{t.title}</span>
                          <span className="welcome-tutorial-desc">{t.blurb}</span>
                        </span>
                        <span className="welcome-tutorial-arrow">
                          <Icon name="chevron-right" size="sm" />
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* 身份感样例（静态展示，不依赖项目/内核）：一页讲清「作者写中文口上、
                      工具翻成游戏 ERB」——这就是「结构感知」的日常收益。用词（kojo / 口上 /
                      ERB 指令名）属跨游戏通用术语与引擎级词汇，解耦口径同 TAGLINE。
                      批次十一：整块默认收起——它讲得清"为什么用这个编辑器"，但不该和首屏抢注意力。 */}
                  <details className="welcome-sample-fold">
                    <summary className="welcome-fold-summary is-sub">
                      <Icon name="chevron-right" size="xs" className="welcome-fold-caret" />
                      <span className="welcome-sample-caption">看看中文口上怎么变成游戏指令</span>
                    </summary>
                    <figure className="welcome-sample">
                      <figcaption className="welcome-sample-caption">你写中文口上，工具自动翻成游戏读的指令：</figcaption>
                      <div className="welcome-sample-pane">
                        <span className="welcome-sample-tag">你写的 .kojo</span>
                        <pre className="welcome-sample-code">
                          <span className="welcome-sample-kw">如果</span>
                          {' 她的好感度 >= 50：\n    '}
                          <span className="welcome-sample-said">「欢迎回来。」</span>
                        </pre>
                      </div>
                      <div className="welcome-sample-flow" aria-hidden="true">
                        {/* 图标位用 SVG（chevron-down），不用文本 `↓`：文本箭头跟字体走，
                            换字号/换字面就歪，且屏幕阅读器会念成"向下箭头"混进正文。 */}
                        <Icon name="chevron-down" size="sm" className="welcome-sample-flow-arrow" />
                        <span>自动编译</span>
                      </div>
                      <div className="welcome-sample-pane">
                        <span className="welcome-sample-tag">游戏读的 ERB</span>
                        <pre className="welcome-sample-code">
                          <span className="welcome-sample-erb">IF</span>
                          {' CFLAG:TARGET:好感度 >= 50\n  '}
                          <span className="welcome-sample-erb">PRINTFORMW</span>
                          {' 欢迎回来。\n'}
                          <span className="welcome-sample-erb">ENDIF</span>
                        </pre>
                      </div>
                    </figure>
                  </details>
                </details>
              </section>

              {/* 尾注（原两段长文）收成一行：Esc 关浮层这件事留着，"另一组入口常驻项目面板"删掉
                  ——入口重复三处正是本批要减的东西。 */}
              <p className="welcome-side-foot">
                教程浮层不依赖已打开的项目，按 <kbd>Esc</kbd> 或点遮罩即可关闭。
              </p>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
