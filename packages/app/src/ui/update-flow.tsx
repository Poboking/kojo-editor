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
  createProgressFlusher,
  raceWithTimeout,
  reasonFromUpdateError,
  reduceUpdatePhase,
  shouldSkipAutoCheck,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TIMEOUT_REASON,
  type AutoCheckOutcome,
  type AutoCheckRecord,
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
 *
 * ## 本批（UPD-A · 2026-11-05）改的是什么
 *
 * 四件健壮性/性能，纯判据都在 `update-check.ts` 那一节（测试各就各位）：
 * 1. **检查看门狗**：黑洞代理会把 `check()` 挂死 ⇒ 设置页永远「正在检查更新…」且 busy
 *    禁两颗按钮。现在 20s（`UPDATE_CHECK_TIMEOUT_MS`）没回就按 checkFailed 落态、病因固定
 *    「检查超时」；看门狗赢下竞速后，真 check() 无论何时落定都只能**作废并归还资源**
 *    （`checkPromise` 的尾巴），晚到的真值再也进不了状态机；卸载清理把还没响的看门狗
 *    定时器一并清掉；
 * 2. **会话级自动检查去重**：欢迎页与 ShellLayout 两处挂载各查一次 ⇒ 一次会话至少两次
 *    网络检查。模块级 `lastAutoCheck` 入账 latest / failed(check)（**found 绝不入账**——
 *    编辑器侧还要举卡），5 分钟内后续挂载的自动检查直接跳过；手动 checkNow 永不跳过；
 * 3. **下载进度节流**：Progress 分片改为**累计 + 定时冲刷**（`createProgressFlusher`，
 *    150ms 一批），Started 的 total 仍立即上屏；Finished / 正常返回 / 失败前都做**最终
 *    冲刷**，`received` 终值精确；每次 install 新建一枚，重试路径不带上一轮欠账；
 * 4. **失败病因透传**：`performCheck` / `install` 的 catch 过去把错误吞成哑巴态，现在
 *    `reasonFromUpdateError` 读得出 Error.message 就带给 checkFailed / installFailed，
 *    读不出仍回落那句常态话术；
 * 5. **装完也还资源**：install 成功过去只把 foundRef 置 null、`Update` 宿主资源没还——
 *    现在成功也走一次 `releaseFound()`（Windows 上进程通常已被安装器带走，这步给
 *    "装完进程还在"的平台兜底；失败路径有意保留资源供重试复用）。
 */

export const AUTO_UPDATE_CHECK_DELAY_MS = 3000;

/**
 * 会话级自动检查去重的**入账记录**（UPD-A；模块级 ⇒ 欢迎页与 ShellLayout 两次挂载共享
 * 同一份，这正是去重的意义所在）。判据在 `update-check.ts` 的 `shouldSkipAutoCheck`。
 */
let lastAutoCheck: AutoCheckRecord | null = null;

/**
 * 自动检查落 latest / failed(check) 时入账。参数类型挡住 `'found'`：**found 绝不入账**——
 * 编辑器侧还要举卡，「上一处查到过」不能让下一处挂载跳过真查。
 */
function noteAutoCheckOutcome(outcome: Exclude<AutoCheckOutcome, 'found'>): void {
  lastAutoCheck = { outcome, at: Date.now() };
}

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
  /** 当前检查的看门狗取消柄（raceWithTimeout 注入）：卸载清理里把还没响的定时器一并清掉 */
  const watchdogCancelRef = useRef<(() => void) | null>(null);
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
        // 看门狗（UPD-A）：黑洞代理会把 check() 挂死到永不返回 ⇒ 设置页永远「正在检查更新…」
        // 且 busy 禁两颗按钮。20s 没回就按 checkFailed 落态；真结果晚到的处置见 timeout 分支。
        const checkPromise = check(envProxy === null ? undefined : { proxy: envProxy });
        const found = await raceWithTimeout(checkPromise, UPDATE_CHECK_TIMEOUT_MS, (cancel) => {
          watchdogCancelRef.current = cancel;
        });
        watchdogCancelRef.current = null;
        if (found === 'timeout') {
          // 看门狗赢了：真 check() 无论何时落定都**只能作废并归还资源**（seq 守卫的看门狗
          // 延伸——超时已落态，作者得重查），晚到的真值绝不进状态机。尾巴先把处置挂上，
          // 再走 alive/seq 守卫：此刻已 stale / 已卸载的情形同样要还资源。
          void checkPromise
            .then((late) => {
              if (late !== null) void late.close().catch(() => {});
            })
            .catch(() => {});
          if (!aliveRef.current || seq !== checkSeqRef.current) return;
          if (origin === 'auto') noteAutoCheckOutcome('failed');
          setPhase((p) => reduceUpdatePhase(p, { type: 'checkFailed', reason: UPDATE_CHECK_TIMEOUT_REASON }));
          return;
        }
        if (!aliveRef.current || seq !== checkSeqRef.current) {
          if (found !== null) void found.close().catch(() => {});
          return;
        }
        if (found === null) {
          if (origin === 'auto') noteAutoCheckOutcome('latest');
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
        const probe = reduceUpdatePhase({ kind: 'checking' }, action);
        if (probe.kind !== 'found') {
          void found.close().catch(() => {});
          if (origin === 'auto') {
            // 落 latest（同版/更高版）或 failed(check)（版本读不出）都入账；
            // found 不入账——编辑器侧还要举卡（这个分支到不了 found）。
            noteAutoCheckOutcome(probe.kind === 'latest' ? 'latest' : 'failed');
          }
          setPhase((p) => reduceUpdatePhase(p, action));
          return;
        }
        foundRef.current = found;
        setPhase((p) => reduceUpdatePhase(p, action));
        // 手动检查是明确意图：发现就直接打开详情模态（免打扰只拦「卡」，拦不住作者自己）。
        // 自动检查只落状态——卡/模态的取舍全在 useUpdateNotice 的判据里。
        if (origin === 'manual') openDialog();
      } catch (e) {
        // 私仓未发布 release：端点 404 是常态路径——可见、可重试，绝不抛未捕获异常。
        // 病因透传（UPD-A）：读得出 Error.message 就带给状态机，读不出回落常态话术。
        if (!aliveRef.current || seq !== checkSeqRef.current) return;
        releaseFound();
        if (origin === 'auto') noteAutoCheckOutcome('failed');
        setPhase((p) => reduceUpdatePhase(p, { type: 'checkFailed', reason: reasonFromUpdateError(e) }));
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
      // 会话级去重（UPD-A）：本会话刚查过（latest/failed 且 < 5 分钟）就不再打网络——
      // 欢迎页与编辑器两处挂载各查一次的老毛病从这里收口。只拦自动检查：
      // 手动 checkNow 是明确意图，永不跳过。
      if (shouldSkipAutoCheck(lastAutoCheck, Date.now())) return;
      void performCheck('auto');
    }, autoCheckDelayMs);
    return () => window.clearTimeout(timer);
  }, [enableAutoCheck, autoCheckDelayMs, performCheck]);

  // 卸载时把没在安装的那条 Update 还给宿主；下载中不关，免得把安装打断
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 看门狗定时器一并清掉（UPD-A）：卸载后不再有 20s 后的假超时。
      // 真结果晚到由 alive/seq 守卫（与 timeout 分支的尾巴）处置，这里只管定时器。
      watchdogCancelRef.current?.();
      watchdogCancelRef.current = null;
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
    // 进度节流（UPD-A）：Progress 分片先累计、每 150ms 统一冲一次 setPhase（大文件下载
    // 时每分片一渲染太密）。每次安装新建一枚——重试路径不带上一轮的欠账。
    const flusher = createProgressFlusher((delta) => {
      setPhase((p) => reduceUpdatePhase(p, { type: 'installProgress', chunk: delta }));
    });
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          // 总量立即上屏（不节流）：进度条要有分母才算得准
          setPhase((p) =>
            reduceUpdatePhase(p, { type: 'installStart', total: event.data.contentLength ?? null }),
          );
        } else if (event.event === 'Progress') {
          flusher.add(event.data.chunkLength);
        } else if (event.event === 'Finished') {
          flusher.flush(); // 终态迁移前的最终冲刷：received 终值精确
          setPhase((p) => reduceUpdatePhase(p, { type: 'installDone' }));
        }
      });
      flusher.flush(); // 正常返回也补一次最终冲刷（Finished 事件缺席时进度不缺最后一截）
      setPhase((p) => reduceUpdatePhase(p, { type: 'installDone' }));
      // 成功也把 Update 宿主资源还掉（与 releaseFound 同语义，UPD-A）：Windows 上进程通常
      // 已被安装器带走，这一步给「装完进程还在」的平台兜底；失败路径有意保留资源供重试复用。
      releaseFound();
    } catch (e) {
      flusher.flush(); // 失败也是终态：先把欠账冲掉再落失败态，received 不缺最后一截
      // 下载/安装中断（断网、磁盘、取消）：失败态可见可重试；保留资源供重试复用。
      // 病因透传（UPD-A）：读得出就带，读不出回落那句常态话术。
      setPhase((p) => reduceUpdatePhase(p, { type: 'installFailed', reason: reasonFromUpdateError(e) }));
    } finally {
      installingRef.current = false;
    }
  }, [openDialog, releaseFound]);

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
