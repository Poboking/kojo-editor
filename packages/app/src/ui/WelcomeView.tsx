import type { ReactElement } from 'react';
import type { RecentProject } from '@kojo/plugin-api';
import type { AppPhase } from './App';

interface Props {
  phase: AppPhase;
  error: string | null;
  recent: RecentProject[];
  tauri: boolean;
  kernelReady: boolean;
  onOpenDirectory: () => void;
  onOpenRecent: (dir: string) => void;
}

/**
 * 产品定位文案（品牌位，非功能耦合）：功能性文案一律游戏无关（解耦审计 A 项
 * 覆盖 app UI 层）；此处游戏名属产品自我介绍，行级豁免（audit-allow）。
 */
const TAGLINE = 'eraTW 口上编辑器 · 结构感知 × 一切皆插件'; // audit-allow: 品牌位文案（产品定位，非功能耦合）

export function WelcomeView({ phase, error, recent, tauri, kernelReady, onOpenDirectory, onOpenRecent }: Props): ReactElement {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>
          kojo-editor <span className="ver">v0.1</span>
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
            <button className="primary big" onClick={onOpenDirectory} disabled={phase === 'opening'}>
              {phase === 'opening' ? '正在打开…' : '选择游戏目录'}
            </button>

            {recent.length > 0 ? (
              <div className="recent">
                <h3>最近打开</h3>
                <ul>
                  {recent.map((r) => (
                    <li key={r.rootDir}>
                      <button className="link" onClick={() => onOpenRecent(r.rootDir)} title={r.rootDir}>
                        <span className="recent-dir">{r.rootDir}</span>
                        <span className="recent-adapter">{r.adapterId}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}

        {error ? <div className="notice error">{error}</div> : null}

        <div className="hint">
          打开后：CHARA 映射与口上域索引自动构建；侧栏可浏览全部角色与口上文件。
          <br />
          游戏目录默认只读——首次保存时会请求对游戏可写目录的写权限确认。
        </div>
      </div>
    </div>
  );
}
