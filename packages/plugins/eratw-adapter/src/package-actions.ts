/**
 * 包操作控制器（2026-10-12 口上项目批 P-D 导出 / P-E 部署）。
 *
 * 面板上的「导出 / 部署」都是**异步且必须向用户交代结果**的动作，共用底部一条状态条。
 * 把这套时序（忙碌 → 成功自动收起 / 失败常驻等用户读原因）从插件闭包抽到本模块：
 * 插件只接线，逻辑无需渲染面板即可单测。
 *
 * 导出的落点在写白名单**之外**是设计意图（导出即落到桌面 / 发布目录）：授权来自
 * 用户在系统对话框里的显式选择，对话框与复制绑定在同一平台命令内（JS 拿不到落点
 * 决定权）；工作区原件只读不动。
 *
 * 部署正相反——落点在游戏目录内，**写白名单这道闸必须过**（详见 `deploy.ts`）。
 */

import type { FileIO, Logger } from '@kojo/plugin-api';
import { deployPackage, type DeployTargetOk, type PendingDeploy } from './deploy';

/** 包操作反馈种类 */
export type PanelStatusKind = 'busy' | 'ok' | 'err';

/** 包操作反馈内容（面板底部状态条；null = 无消息，不渲染不占版面） */
export interface PanelStatus {
  kind: PanelStatusKind;
  text: string;
}

/** 成功态自动收起延时；失败态不自动收起（原因要留给用户读完） */
export const STATUS_OK_DISMISS_MS = 8000;

export interface PackageActionsDeps {
  io: FileIO;
  log: Logger;
  /** 状态变化后通知面板重渲染 */
  notify(): void;
}

export interface PackageActions {
  /** 当前反馈内容（null = 无） */
  status(): PanelStatus | null;
  /** 用户手动关闭反馈条 */
  dismiss(): void;
  /** 插件卸载时清理待触发的自动收起定时器 */
  dispose(): void;
  /** 导出包到用户选定的目录（平台对话框 + 整目录复制） */
  exportArtifact(absDir: string, displayName: string): void;
  /**
   * 部署包到游戏目录（P-E）。返回是否成功——向导据此决定自身是否关闭，
   * 失败时留着窗口让用户读状态条里的原因。
   */
  deployArtifact(pkg: PendingDeploy, target: DeployTargetOk): Promise<boolean>;
}

export function createPackageActions(deps: PackageActionsDeps): PackageActions {
  let current: PanelStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const set = (next: PanelStatus | null, autoDismissMs?: number): void => {
    clearTimer();
    current = next;
    if (next !== null && autoDismissMs !== undefined) {
      timer = setTimeout(() => {
        current = null;
        timer = null;
        deps.notify();
      }, autoDismissMs);
    }
    deps.notify();
  };

  return {
    status: () => current,
    dismiss: () => set(null),
    dispose: clearTimer,

    exportArtifact(absDir: string, displayName: string): void {
      set({ kind: 'busy', text: `正在导出「${displayName}」…` });
      void deps.io
        .exportDirectory(absDir, { title: `导出「${displayName}」到…` })
        .then((target) => {
          // 对话框里取消：既非结果也非错误，收起忙碌态即可（不打扰）
          if (target === null) set(null);
          else set({ kind: 'ok', text: `已导出「${displayName}」到 ${target}` }, STATUS_OK_DISMISS_MS);
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          deps.log.warn(`导出失败：${absDir} — ${reason}`);
          set({ kind: 'err', text: `导出失败：${reason}` });
        });
    },

    async deployArtifact(pkg: PendingDeploy, target: DeployTargetOk): Promise<boolean> {
      set({ kind: 'busy', text: `正在部署「${pkg.displayName}」…` });
      try {
        const written = await deployPackage({ io: deps.io, srcDir: pkg.absDir, targetDir: target.targetDir });
        set(
          {
            kind: 'ok',
            text: `已部署「${pkg.displayName}」${written} 个文件 → ${target.targetDir}`,
          },
          STATUS_OK_DISMISS_MS,
        );
        return true;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log.warn(`部署失败：${pkg.absDir} → ${target.targetDir} — ${reason}`);
        set({ kind: 'err', text: `部署失败：${reason}` });
        return false;
      }
    },
  };
}
