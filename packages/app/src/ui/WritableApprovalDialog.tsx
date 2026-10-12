import type { ReactElement } from 'react';
import type { GameProject } from '@kojo/plugin-api';
import { useModalEscape } from './modal-stack';

interface Props {
  project: GameProject;
  onDecide: (allow: boolean) => void;
}

/**
 * 可写路径批准对话框。
 *
 * 安全模型（架构文档 §5.7）：适配器**提议**可写路径，用户**显式批准**后才生效；
 * 内核 io 对白名单之外的写入一律拒绝。未批准时项目只读可用（浏览完全不受伤）。
 *
 * Esc = 只读浏览（HK-2）：授权是"给出去就收不回来"的动作，键盘不该替作者按下它。
 * 之后想给，状态栏那枚「只读」徽章就是重授权入口（§5.39）。
 */
export function WritableApprovalDialog({ project, onDecide }: Props): ReactElement {
  useModalEscape(() => onDecide(false));
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label="写权限确认">
        <h2>写权限确认</h2>
        <p>
          <code>{project.adapterId}</code> 适配器请求对以下目录的写权限（保存口上文件时使用）：
        </p>
        <ul className="paths">
          {project.writablePaths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
        <p className="dim">
          游戏目录的其余部分保持只读。写入前会自动备份到应用数据目录（保留最近 20 版），
          并采用原子写防止中断损坏。该批准按项目目录记忆，下次自动生效。
        </p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide(false)}>
            只读浏览
          </button>
          <button className="primary" onClick={() => onDecide(true)}>
            允许写入
          </button>
        </div>
      </div>
    </div>
  );
}
