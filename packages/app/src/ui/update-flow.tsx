import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../bridge/invoke';
import {
  reduceUpdatePhase,
  type UpdateAction,
  type UpdateDialogPhase,
  type UpdatePhase,
} from './update-check';
import { UpdateDialog } from './UpdateDialog';
import { UpdateNoticeCard, useUpdateNotice } from './UpdateNoticeCard';

/**
 * 更新流程的**触发入口**（批次十一 L05 · 任务 3）：把「3 秒静默 check + 资源管理 +
 * 下载安装」从 `ShellLayout` 焊死的形态解耦成可复用 hook/组件。
 *
 * 修的是实测缺陷①：欢迎页不挂 ShellLayout ⇒ 不开项目的作者永远收不到更新。
 * 组长接线只需一行：在 `WelcomeView`（或任何常驻界面）挂 `<UpdateFlowHost />`；
 * `ShellLayout` 想收敛内联那套同款逻辑，换成本 hook 也是同一接口
 * （phase/notice/dialog/install 全在这里，呈现零改动）。
 *
 * 逻辑口径逐字对齐 ShellLayout 现实现（别改语义）：
 * - 非 Tauri 环境（浏览器 dev / node 测试）整个自动检查不启动；
 * - `updater_env_proxy` 取到就透传 `check({ proxy })`，取不到当无参；
 * - 并发检查以后发起者为准（seq），落败的那次连同 `Update` 宿主资源一起作废；
 * - 卸载/换查时释放没在安装的 `Update` 资源；下载中不打断；
 * - 检查失败（私仓端点 404 是常态）只落状态，绝不弹窗。
 */

export const AUTO_UPDATE_CHECK_DELAY_MS = 3000;

export interface UseUpdateFlowOptions {
  /** 静默检查延迟（默认 3s，与 ShellLayout 现值同源）；<=0 = 不跑自动检查 */
  readonly autoCheckDelayMs?: number;
  /** 关闭自动检查（只想手动 checkNow 的宿主用） */
  readonly enableAutoCheck?: boolean;
  /**
   * 安装完成后的「立即重启」通道（宿主有 relaunch 命令时传入）。
   * 当前仓没有对应 Rust 命令 ⇒ 缺省不画按钮，登记在批次报告的待接线里。
   */
  readonly onRestart?: () => void;
}

export interface UpdateFlow {
  /** 全量状态机读数（设置页那类常驻状态行要就用） */
  phase: UpdatePhase;
  /** 详情模态该画的 phase（null 不画） */
  dialog: UpdateDialogPhase | null;
  /** 右下卡该画的那一版（null 不画） */
  notice: ReturnType<typeof useUpdateNotice>['notice'];
  /** 破坏性更新（打开即模态）——hook 已自动开，读数供宿主加戏 */
  forced: boolean;
  /** 作者点「查看」/ 手动检查想直接开模态 */
  openDialog: () => void;
  /** 卡「稍后」：跨会话免打扰 */
  dismissNotice: () => void;
  /** 模态出口 */
  closeDialog: () => void;
  /** 下载并安装（与设置页同一个入口） */
  install: () => Promise<void>;
  /** 手动检查（设置页按钮 / 欢迎页刷新位）；manual 发现新版本会直接开详情模态 */
  checkNow: () => Promise<void>;
}

export function useUpdateFlow(options?: UseUpdateFlowOptions): UpdateFlow {
  const autoCheckDelayMs = options?.autoCheckDelayMs ?? AUTO_UPDATE_CHECK_DELAY_MS;
  const enableAutoCheck = options?.enableAutoCheck ?? true;
  const [phase, setPhase] = useState<UpdatePhase>({ kind: 'idle' });
  const foundRef = useRef<Update | null>(null);
  /** 并发检查的序号：后发起的那次说了算，先前的结果连 Update 资源一起作废 */
  const checkSeqRef = useRef(0);
  /** 下载安装进行中：卸载清理别把正在安装的 Update 资源关掉 */
  const installingRef = useRef(false);
  /** 自动检查只跑一次（timer 真触发后才置位；StrictMode 的 cleanup 重排不会把它吞掉） */
  const autoFiredRef = useRef(false);
  /** 组件还活着：关页面时仍在路上的 check() 回来要还资源，而不是往已卸载的树里塞状态 */
  const aliveRef = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const notice = useUpdateNotice(phase);
  const { openDialog } = notice;

  /** 释放手上那条 Update 的宿主资源（updater 的 `Update` 是 Rust Resource） */
  const releaseFound = useCallback(() => {
    const found = foundRef.current;
    foundRef.current = null;
    if (found !== null) {
      void found.close().catch(() => {
        /* 释放失败不影响用户：宿主进程退出时也会回收 */
      });
    }
  }, []);

  const performCheck = useCallback(
    async (origin: 'auto' | 'manual'): Promise<void> => {
      const seq = checkSeqRef.current + 1;
      checkSeqRef.current = seq;
      releaseFound();
      setPhase((p) => reduceUpdatePhase(p, { type: 'checkStart' }));
      try {
        // 更新检查跟随环境代理：Rust 侧读标准环境变量，取不到（含非 Tauri）= 不传参。
        const envProxy = await invoke<string | null>('updater_env_proxy').catch(() => null);
        const found = await check(envProxy === null ? undefined : { proxy: envProxy });
        if (!aliveRef.current || seq !== checkSeqRef.current) {
          if (found !== null) void found.close().catch(() => {});
          return;
        }
        if (found === null) {
          setPhase((p) => reduceUpdatePhase(p, { type: 'checkLatest' }));
          return;
        }
        const currentVersion = found.currentVersion.trim() === '' ? undefined : found.currentVersion;
        const action: UpdateAction = {
          type: 'checkFound',
          version: found.version,
          ...(currentVersion === undefined ? {} : { currentVersion }),
          ...(found.body === undefined ? {} : { notes: found.body }),
          ...(found.date === undefined ? {} : { date: found.date }),
        };
        // 先用「检查中」试算：只有真落到 found 才保留 Update 资源；latest/读不出都当场还掉。
        if (reduceUpdatePhase({ kind: 'checking' }, action).kind !== 'found') {
          void found.close().catch(() => {});
          setPhase((p) => reduceUpdatePhase(p, action));
          return;
        }
        foundRef.current = found;
        setPhase((p) => reduceUpdatePhase(p, action));
        // 手动检查是明确意图：发现就直接打开详情模态（免打扰只拦「卡」，拦不住作者自己）。
        // 自动检查只落状态——卡/模态的取舍全在 useUpdateNotice 的判据里。
        if (origin === 'manual') openDialog();
      } catch {
        // 私仓未发布 release：端点 404 是常态路径——可见、可重试，绝不抛未捕获异常
        if (!aliveRef.current || seq !== checkSeqRef.current) return;
        releaseFound();
        setPhase((p) => reduceUpdatePhase(p, { type: 'checkFailed' }));
      }
    },
    [releaseFound, openDialog],
  );

  /** 进入界面若干秒后静默检查一次——只在 Tauri 壳里跑；已手动动过状态机就让位 */
  useEffect(() => {
    if (!enableAutoCheck || !isTauri() || autoFiredRef.current) return;
    if (autoCheckDelayMs <= 0) return;
    const timer = window.setTimeout(() => {
      autoFiredRef.current = true;
      if (phaseRef.current.kind !== 'idle') return;
      void performCheck('auto');
    }, autoCheckDelayMs);
    return () => window.clearTimeout(timer);
  }, [enableAutoCheck, autoCheckDelayMs, performCheck]);

  // 卸载时把没在安装的那条 Update 还给宿主；下载中不关，免得把安装打断
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const found = foundRef.current;
      foundRef.current = null;
      if (found !== null && !installingRef.current) {
        void found.close().catch(() => {});
      }
    };
  }, []);

  const install = useCallback(async (): Promise<void> => {
    const found = foundRef.current;
    if (found === null || installingRef.current) return;
    openDialog(); // 从设置页/卡片点安装，也把进度抬进模态
    installingRef.current = true;
    setPhase((p) => reduceUpdatePhase(p, { type: 'installStart', total: null }));
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setPhase((p) =>
            reduceUpdatePhase(p, { type: 'installStart', total: event.data.contentLength ?? null }),
          );
        } else if (event.event === 'Progress') {
          setPhase((p) => reduceUpdatePhase(p, { type: 'installProgress', chunk: event.data.chunkLength }));
        } else if (event.event === 'Finished') {
          setPhase((p) => reduceUpdatePhase(p, { type: 'installDone' }));
        }
      });
      setPhase((p) => reduceUpdatePhase(p, { type: 'installDone' }));
      foundRef.current = null;
    } catch {
      // 下载/安装中断（断网、磁盘、取消）：失败态可见可重试；保留资源供重试复用
      setPhase((p) => reduceUpdatePhase(p, { type: 'installFailed' }));
    } finally {
      installingRef.current = false;
    }
  }, [openDialog]);

  const checkNow = useCallback(() => performCheck('manual'), [performCheck]);

  return {
    phase,
    dialog: notice.dialog,
    notice: notice.notice,
    forced: notice.forced,
    openDialog: notice.openDialog,
    dismissNotice: notice.dismissNotice,
    closeDialog: notice.closeDialog,
    install,
    checkNow,
  };
}

export interface UpdateFlowHostProps extends UseUpdateFlowOptions {
  /** 宿主另有状态行消费 phase 时，用它把读数送出去（渲染仍归本组件） */
  readonly onPhase?: (phase: UpdatePhase) => void;
}

/**
 * 一行式接线点：`<UpdateFlowHost />` 挂进任何常驻界面（WelcomeView / ShellLayout），
 * 自动检查 + 右下卡 + 详情模态三层全部就位。破坏性严重度由说明文本自判
 * （`normalizeUpdateNotes` 后仍含红线词 ⇒ 打开即模态，其余只举卡）。
 */
export function UpdateFlowHost({ onPhase, ...flowOptions }: UpdateFlowHostProps): ReactElement | null {
  const flow = useUpdateFlow(flowOptions);
  // 状态镜像外流（设置页状态行等）；同值不通知，免得父组件 setState 空转
  const lastReportedRef = useRef<UpdatePhase | null>(null);
  useEffect(() => {
    if (onPhase === undefined || lastReportedRef.current === flow.phase) return;
    lastReportedRef.current = flow.phase;
    onPhase(flow.phase);
  }, [onPhase, flow.phase]);
  return (
    <>
      <UpdateNoticeCard state={flow.notice} onOpen={flow.openDialog} onDismiss={flow.dismissNotice} />
      {flow.dialog !== null ? (
        <UpdateDialog
          phase={flow.dialog}
          onClose={flow.closeDialog}
          onInstall={flow.install}
          forced={flow.forced}
          {...(flowOptions.onRestart === undefined ? {} : { onRestart: flowOptions.onRestart })}
        />
      ) : null}
    </>
  );
}
