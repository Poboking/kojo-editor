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
 * 更新流程的**唯一触发入口**（批次十一 L05 造 · 2026-11-02 UI 打磨批接线落地）。
 *
 * 修的是实测缺陷①：欢迎页不挂 ShellLayout ⇒ 不开项目的作者永远收不到更新。
 * 今天两处消费方（`update-wiring.test.ts` 钉着，防"组件有测试、生产没人挂"的静默失效）：
 * - `App.tsx` 的无项目分支挂 `<LazyUpdateFlowHost />`（动态边：一层只在"真有新版本"时
 *   才用得上的浮层，不许压进开机图——实测静态挂会把 updater 插件族 +82 KB 拽上首屏）；
 * - `ShellLayout` 用 `useUpdateFlow()`，把读数喂给设置页、把卡与模态挂在 overlays 末尾。
 * 两处各查一次（换界面 = 重新挂载），跨会话的"别再举卡"由 `update-dismiss-pref.ts` 拦。
 *
 * 逻辑口径（与改前 ShellLayout 内联那套逐字同源，本批把内联那份删了、这里成了真源）：
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

/**
 * 一行式接线点：挂进任何常驻界面（今天的落点＝ `App` 的无项目分支），
 * 自动检查 + 右下卡 + 详情模态三层全部就位。破坏性严重度由说明文本自判
 * （`normalizeUpdateNotes` 后仍含红线词 ⇒ 打开即模态，其余只举卡）。
 *
 * 编辑器那一侧不用这颗壳：`ShellLayout` 直接吃 `useUpdateFlow()`，
 * 因为它还要把同一份 phase 喂给设置页的状态行（`onPhase` 那类外流口子零消费方，已删）。
 */
export function UpdateFlowHost(props: UseUpdateFlowOptions): ReactElement | null {
  const flow = useUpdateFlow(props);
  return (
    <>
      {/* 卡的四态里只有 failed 需要动作腿（「重试」）——与模态、设置页同一个 install */}
      <UpdateNoticeCard
        state={flow.notice}
        onOpen={flow.openDialog}
        onDismiss={flow.dismissNotice}
        onInstall={flow.install}
      />
      {flow.dialog !== null ? (
        <UpdateDialog
          phase={flow.dialog}
          onClose={flow.closeDialog}
          onInstall={flow.install}
          forced={flow.forced}
          {...(props.onRestart === undefined ? {} : { onRestart: props.onRestart })}
        />
      ) : null}
    </>
  );
}
