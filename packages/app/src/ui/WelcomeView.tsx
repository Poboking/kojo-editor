import { useEffect, useState, type ReactElement } from 'react';
import type { FileStat, RecentProject } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
// 版本号单一真源 = app 包清单（与 `src/bootstrap.ts` 的 `APP_VERSION` 同一条路）：
// 欢迎页那格不许再抄一份字面量，抬版本只改三处清单（闸见 `tests/app-version.test.ts`）。
import { version as APP_VERSION } from '../../package.json';
import type { AppPhase } from './App';
import { Icon } from './icons';
import './welcome.css';

/** 教程卡片指向的语义 id（与内核事件 `ui.tutorial.open` 的载荷同一词表） */
export type WelcomeTutorialId = 'kojo' | 'sugar' | 'reference';

/** 教程卡片的静态半边：标题 / 一句说明 / 图标。打开动作由宿主接线成内核意图。 */
export interface WelcomeTutorialEntry {
  readonly id: WelcomeTutorialId;
  readonly title: string;
  readonly blurb: string;
  readonly icon: 'book' | 'wand' | 'structure';
}

/**
 * 右侧「教程」三张卡片（顺序 = 阅读顺序：先工作流、再写法、最后查表）。
 * 纯数据、无副作用：卡片点击只把 `id` 交给 App → 内核事件，宿主不理解教程内容。
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
    id: 'reference',
    title: '语法全表',
    blurb: '指令、函数与写法速查，写到一半也能回来查。',
    icon: 'structure',
  },
];

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
  /** 失效探测（A4）；resolve undefined = 探测不可用（浏览器壳等），行内不标记 */
  statPath: (path: string) => Promise<FileStat | null | undefined>;
  /** 最近一次打开的项目根（null = 无会话可继续）；退出/崩溃守护批 */
  resumeRoot: string | null;
  onResumeSession: () => void;
  /** 崩溃恢复待决（null = 无）；root 为空串时不给恢复入口（没有可回去的项目根） */
  crashRecovery: { root: string; files: number } | null;
  onRecoverCrash: () => void;
  onDiscardCrash: () => void;
  /** 欢迎页被「×」关掉（会话内）；App 据此显示空态而不是死白屏 */
  closed: boolean;
  onClose: () => void;
  onReopen: () => void;
  /** 教程卡片只发语义 id；映射与打开由教程提供方（适配器）解释 */
  onOpenTutorial: (tutorial: WelcomeTutorialId) => void;
}

/**
 * 产品定位文案（品牌位，非功能耦合）：功能性文案一律游戏无关（解耦审计 A 项
 * 覆盖 app UI 层）；此处游戏名属产品自我介绍，行级豁免（audit-allow）。
 */
const TAGLINE = 'eraTW 口上编辑器 · 结构感知 × 一切皆插件'; // audit-allow: 品牌位文案（产品定位，非功能耦合）

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

/** 乐观移除的纯函数半边：按 pathKey 摘条目，其余逐字保序（与内核 removeRecent 同口径） */
export function removeRecentOptimistic(list: RecentProject[], rootDir: string): RecentProject[] {
  const key = pathKey(rootDir);
  return list.filter((r) => pathKey(r.rootDir) !== key);
}

/** 关闭后的空态：不让作者对着一屏死白，主动作仍是「打开文件夹…」 */
function ClosedState({
  phase,
  error,
  recent,
  tauri,
  kernelReady,
  onOpenDirectory,
  onReopen,
}: Pick<
  Props,
  'phase' | 'error' | 'recent' | 'tauri' | 'kernelReady' | 'onOpenDirectory' | 'onReopen'
>): ReactElement {
  const opening = phase === 'opening';
  const canOpen = kernelReady && !opening;
  return (
    <div className="welcome welcome-screen welcome-closed">
      <main className="glass welcome-closed-card">
        <p className="welcome-closed-brand">kojo-editor</p>
        <p className="welcome-closed-lead">
          欢迎页已关闭。
          {recent.length > 0 ? '最近打开的项目还在，重新打开欢迎页即可继续。' : '随时可以重新打开，或直接选择一个项目文件夹。'}
        </p>

        {!tauri ? (
          <div className="notice warn welcome-notice">
            当前运行在浏览器环境：文件系统能力不可用。请通过桌面壳启动（<code>pnpm tauri dev</code>）。
          </div>
        ) : null}
        {!kernelReady ? (
          <div className="notice welcome-notice" role="status">
            内核装配中…
          </div>
        ) : null}
        {error ? (
          <div className="notice error welcome-notice" role="alert">
            {error}
          </div>
        ) : null}

        <div className="welcome-closed-actions">
          <button className="primary big welcome-open" onClick={onOpenDirectory} disabled={!canOpen}>
            <Icon name="files" size={16} />
            <span>{opening ? '正在打开…' : '打开文件夹…'}</span>
          </button>
          <button className="ghost" onClick={onReopen} disabled={opening}>
            重新打开欢迎页
          </button>
        </div>
      </main>
    </div>
  );
}

/**
 * 欢迎页（用户反馈 8 批重做）：无项目时的整页视图，版式对标 VSCode 欢迎页——
 * 顶部一枚可关闭的「欢迎」标签，主体两栏：左侧品牌头 +「启动」+「最近」，
 * 右侧「教程」三张卡片。
 *
 * 数据流保持原样：最近列表的读取/写回全部走 App 注入的回调（组件不持有 kernel）；
 * 教程卡片也只把语义 id 交给 App，由 `ui.tutorial.open` 内核事件送进教程提供方。
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
  statPath,
  resumeRoot,
  onResumeSession,
  crashRecovery,
  onRecoverCrash,
  onDiscardCrash,
  closed,
  onClose,
  onReopen,
  onOpenTutorial,
}: Props): ReactElement {
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

  if (closed) {
    return (
      <ClosedState
        phase={phase}
        error={error}
        recent={recent}
        tauri={tauri}
        kernelReady={kernelReady}
        onOpenDirectory={onOpenDirectory}
        onReopen={onReopen}
      />
    );
  }

  const opening = phase === 'opening';
  const canOpen = kernelReady && !opening;
  const tutorialsOpenable = canOpen;

  return (
    <div className="welcome welcome-screen">
      <header className="welcome-tabbar" role="tablist" aria-label="欢迎页标签">
        <div className="welcome-tab-group">
          <div
            className="welcome-tab"
            role="tab"
            id="welcome-tab"
            aria-selected="true"
            aria-controls="welcome-body"
            tabIndex={-1}
          >
            <Icon name="home" size={14} className="welcome-tab-icon" />
            <span className="welcome-tab-label">欢迎</span>
          </div>
          <button
            type="button"
            className="welcome-tab-close"
            aria-label="关闭欢迎页"
            title="关闭欢迎页"
            onClick={onClose}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </header>

      <div className="welcome-scroll">
        <div className="welcome-card" role="tabpanel" id="welcome-body" aria-labelledby="welcome-tab">
          <main className="welcome-main">
            <header className="welcome-brand">
              <h1>
                kojo-editor <span className="ver">v{APP_VERSION}</span>
              </h1>
              <p className="welcome-tagline">{TAGLINE}</p>
            </header>

            {!tauri ? (
              <div className="notice warn welcome-notice">
                当前运行在浏览器环境：文件系统能力不可用。请通过桌面壳启动（<code>pnpm tauri dev</code>）。
              </div>
            ) : null}

            {!kernelReady ? (
              <div className="notice welcome-notice" role="status">
                内核装配中…
              </div>
            ) : null}

            {error ? (
              <div className="notice error welcome-notice" role="alert">
                {error}
              </div>
            ) : null}

            <section className="welcome-section welcome-start" aria-labelledby="welcome-start-title">
              <h2 className="welcome-section-title" id="welcome-start-title">
                启动
              </h2>
              <div className="welcome-actions">
                <button
                  className="primary big welcome-open u-sheen u-ripple"
                  onClick={onOpenDirectory}
                  disabled={!canOpen}
                >
                  <Icon name="files" size={16} />
                  <span>{opening ? '正在打开…' : '打开文件夹…'}</span>
                </button>
                {!crashRecovery && resumeRoot ? (
                  <button
                    className="ghost welcome-resume"
                    onClick={onResumeSession}
                    disabled={!canOpen}
                    title={resumeRoot}
                  >
                    <Icon name="history" size={16} />
                    <span className="welcome-resume-label">继续上次会话</span>
                    <span className="welcome-resume-path">{resumeRoot}</span>
                  </button>
                ) : null}
              </div>
              <p className="welcome-start-hint">
                {!kernelReady
                  ? '内核装配完成后即可打开文件夹；打开过的项目会出现在下方「最近」。'
                  : recent.length > 0
                    ? '也可以从下方「最近」选择，或把项目文件夹直接拖进窗口。'
                    : '还没有最近项目——打开过的文件夹会出现在这里，下次一键回来。'}
              </p>
            </section>

            {/* 崩溃恢复横幅（退出/崩溃守护批）：克制的一行事由 + 两个动作。 */}
            {/* 恢复永不自动写盘——内容只装回编辑器当未保存修改，存不存由用户决定 */}
            {crashRecovery && crashRecovery.root ? (
              <div className="notice crash-recovery welcome-notice" role="alert">
                <p>上次异常退出，{crashRecovery.files} 个文件的未保存内容已自动保留。</p>
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

            <section className="welcome-section welcome-recent" aria-labelledby="welcome-recent-title">
              <div className="welcome-section-head">
                <h2 className="welcome-section-title" id="welcome-recent-title">
                  最近
                </h2>
                {recent.length > 0 ? (
                  <button
                    className="welcome-clear"
                    onClick={onClearRecent}
                    title="清空列表记录，不会删除磁盘上的项目文件"
                  >
                    清除全部
                  </button>
                ) : null}
              </div>

              {recent.length === 0 ? (
                <p className="welcome-empty">
                  {kernelReady
                    ? '还没有打开过项目。打开一个文件夹后，它会出现在这里。'
                    : '内核装配完成后，这里会列出最近项目。'}
                </p>
              ) : (
                <ul className="welcome-recent-list">
                  {recent.map((r) => {
                    const missing = recentRowState(statCache.get(recentStatKey(r))) === 'missing';
                    return (
                      <li key={r.rootDir} className={`welcome-recent-row${missing ? ' is-missing' : ''}`}>
                        <button
                          className="welcome-recent-open"
                          onClick={() => onOpenRecent(r.rootDir)}
                          title={missing ? `${r.rootDir}（目录不存在，点击重试）` : r.rootDir}
                        >
                          <span className="welcome-recent-path">{r.rootDir}</span>
                          <span className="welcome-recent-meta">
                            {missing ? (
                              <span className="welcome-recent-badge is-missing">目录不存在</span>
                            ) : null}
                            <span className="welcome-recent-badge">{r.adapterId}</span>
                          </span>
                        </button>
                        <button
                          className="welcome-recent-remove"
                          onClick={() => onRemoveRecent(r.rootDir)}
                          title={`从列表移除：${r.rootDir}`}
                        >
                          移除
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <p className="welcome-hint">
              选一个文件夹打开即可：编辑器会自动识别其中的游戏并选择对应的适配器。打开后 CHARA
              映射与口上域索引自动构建；游戏目录默认只读，首次保存时才请求对可写目录的权限。
            </p>
          </main>

          <aside className="welcome-side" aria-labelledby="welcome-tutorials-title">
            <div className="welcome-side-head">
              <h2 className="welcome-side-title" id="welcome-tutorials-title">
                <Icon name="book" size={16} />
                教程
              </h2>
              <span className="welcome-side-note">内置 · 随时可看</span>
            </div>

            <div className="welcome-tutorials">
              {WELCOME_TUTORIALS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="welcome-tutorial"
                  onClick={() => onOpenTutorial(t.id)}
                  disabled={!tutorialsOpenable}
                  title={!kernelReady ? '内核装配中…' : opening ? '正在打开项目…' : `打开「${t.title}」`}
                >
                  <span className="welcome-tutorial-icon">
                    <Icon name={t.icon} size={18} />
                  </span>
                  <span className="welcome-tutorial-copy">
                    <span className="welcome-tutorial-title">{t.title}</span>
                    <span className="welcome-tutorial-desc">{t.blurb}</span>
                  </span>
                  <span className="welcome-tutorial-arrow">
                    <Icon name="chevron-right" size={14} />
                  </span>
                </button>
              ))}
            </div>

            <p className="welcome-side-foot">
              教程浮层不依赖已打开的项目：按 <kbd>Esc</kbd> 或点遮罩即可关闭。同一组入口也常驻在「我的口上项目」面板底部。
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
