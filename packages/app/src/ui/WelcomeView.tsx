import { useEffect, useState, type ReactElement } from 'react';
import type { FileStat, RecentProject } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
// 版本号单一真源 = app 包清单（与 `src/bootstrap.ts` 的 `APP_VERSION` 同一条路）：
// 欢迎页那格不许再抄一份字面量，抬版本只改三处清单（闸见 `tests/app-version.test.ts`）。
import { version as APP_VERSION } from '../../package.json';
import type { AppPhase } from './App';

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

  return (
    <div className="welcome u-grain">
      <div className="welcome-card stagger">
        <h1>
          kojo-editor <span className="ver">v{APP_VERSION}</span>
        </h1>
        <p className="tagline">{TAGLINE}</p>

        {!tauri ? (
          <div className="notice warn">
            当前运行在浏览器环境：文件系统能力不可用。请通过桌面壳启动（<code>pnpm tauri dev</code>）。
          </div>
        ) : null}

        {!kernelReady ? (
          <div className="notice">内核装配中…</div>
        ) : (
          <>
            <button className="primary big u-sheen u-ripple" onClick={onOpenDirectory} disabled={phase === 'opening'}>
              {phase === 'opening' ? '正在打开…' : '打开文件夹…'}
            </button>

            {/* 崩溃恢复横幅（退出/崩溃守护批）：克制的一行事由 + 两个动作。 */}
            {/* 恢复永不自动写盘——内容只装回编辑器当未保存修改，存不存由用户决定 */}
            {crashRecovery && crashRecovery.root ? (
              <div className="notice crash-recovery" role="alert">
                <p>
                  上次异常退出，{crashRecovery.files} 个文件的未保存内容已自动保留。
                </p>
                <div className="crash-recovery-actions">
                  <button className="primary" onClick={onRecoverCrash} disabled={phase === 'opening'}>
                    恢复并打开
                  </button>
                  <button className="ghost" onClick={onDiscardCrash} disabled={phase === 'opening'}>
                    丢弃
                  </button>
                </div>
              </div>
            ) : null}

            {/* 继续上次会话：只在无崩溃横幅时出现（恢复本身就是回到那个会话） */}
            {!crashRecovery && resumeRoot ? (
              <button
                className="ghost big resume-session"
                onClick={onResumeSession}
                disabled={phase === 'opening'}
                title={resumeRoot}
              >
                继续上次会话
              </button>
            ) : null}

            {recent.length > 0 ? (
              <div className="recent">
                <div className="recent-head">
                  <h3>最近打开</h3>
                  <button
                    className="link recent-clear"
                    onClick={onClearRecent}
                    title="清空列表记录，不会删除磁盘上的项目文件"
                  >
                    清除全部
                  </button>
                </div>
                <ul>
                  {recent.map((r) => {
                    const missing = recentRowState(statCache.get(recentStatKey(r))) === 'missing';
                    return (
                      <li key={r.rootDir} className={missing ? 'missing' : undefined}>
                        <button
                          className="link"
                          onClick={() => onOpenRecent(r.rootDir)}
                          title={missing ? `${r.rootDir}（目录不存在，点击重试）` : r.rootDir}
                        >
                          <span className="recent-dir">{r.rootDir}</span>
                          <span className="recent-meta">
                            {missing ? <span className="recent-missing">目录不存在</span> : null}
                            <span className="recent-adapter">{r.adapterId}</span>
                          </span>
                        </button>
                        <button
                          className="recent-remove"
                          onClick={() => onRemoveRecent(r.rootDir)}
                          title={`从列表移除：${r.rootDir}`}
                        >
                          移除
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        )}

        {error ? <div className="notice error">{error}</div> : null}

        <div className="hint">
          选一个文件夹打开即可：编辑器会自动识别其中的游戏并选择对应的适配器。
          <br />
          打开后：CHARA 映射与口上域索引自动构建；侧栏可浏览全部角色与口上文件。
          <br />
          游戏目录默认只读——首次保存时会请求对游戏可写目录的写权限确认。
        </div>
      </div>
    </div>
  );
}
