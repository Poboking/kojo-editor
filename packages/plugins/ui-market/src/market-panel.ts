/**
 * 市场面板的**带状态组件**（从 `index.ts` 迁出）：React 状态、读数序号闸、
 * 「同一时刻只做一件事」的动作互斥，以及把动作接到 `actions.ts` 的那几条通道。
 *
 * 分层：`market-panel-view.ts` 只管画（零状态）· `actions.ts` 取数与装卸（零 React）·
 * `reconcile.ts` 单飞重取 · 本模块把三者接起来。
 *
 * 为什么是工厂而不是 props：`deps`（服务 / 总线 / 日志）与 `av`（装配层注入的 appVersion）
 * 都在 `activate` 那一刻定下来，面板既不该也不被允许自己去注入服务——
 * `ui.panel` 的贡献对象因此一个字都不用改。
 */

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  type InstalledPack,
  type MarketDownloadProgress,
  type UIPanelProps,
} from '@kojo/plugin-api';
import {
  loadMarketSnapshot,
  pullMarketOutcome,
  pullMarketSnapshot,
  requestPublish,
  runImport,
  runInstall,
  runUninstall,
  snapshotWithInstalled,
  snapshotWithoutInstalled,
  type MarketActionDeps,
  type MarketSnapshot,
} from './actions';
import {
  acceptReread,
  attachMarketInvalidation,
  type MarketInvalidationHandle,
} from './reconcile';
import {
  indexRowKey,
  installBusyNote,
  installProgressNote,
  pendingKey,
  type PackRow,
} from './market-view';
import { MarketPanelView } from './market-panel-view';

export function createMarketPanel(
  deps: MarketActionDeps,
  av: string,
): (props: UIPanelProps) => ReactNode {
  function MarketPanel(props: UIPanelProps): ReactNode {
    // 首帧 busy=true ⇒ 状态行还不画（别把"还没读"演成"列表缺失"）；读失败也不会常驻"加载中"
    const [snapshot, setSnapshot] = useState<MarketSnapshot>({
      status: 'list-missing',
      packs: [],
      installed: [],
      installedBytes: 0,
      dropped: [],
      reason: '',
      fetchedAt: null,
      generatedAt: null,
      endpoint: '',
      pullNote: '',
    });
    const [busy, setBusy] = useState(true);
    const [note, setNote] = useState('');
    const [query, setQuery] = useState('');
    // 待确认的卸载（同一时刻只允许一条）+ 展开层（已装条目的机器面）
    const [pending, setPending] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    // 正在进行的那一次装/更新（同一时刻只允许一条：按钮全禁用，进度只写在状态行一处）
    const [installing, setInstalling] = useState<string | null>(null);
    // 装/更新进度读数（0–100 的整数；null = 此刻没有可画的进度。
    // 带字的进度句仍只写 note 一处，这根条只是同一事实的视觉面）
    const [progress, setProgress] = useState<number | null>(null);
    // 后台校对的单调序号：只认最新一次发起的读数——装/卸快速连击时，前一次的校对
    // 可能比后一次晚落，没有这道闸旧事实会倒灌（卸掉的行被"复活"且无后续纠正）
    const readSeq = useRef(0);

    /**
     * 装卸成功后的**即时重取**（MK-1 的"重取"那一半，触发点在服务的清单变更通知上）。
     *
     * 乐观只是显示先行，机器说了算的纪律不破——重读仍是唯一权威，若有漂移由它纠正
     * （判据：卸载确认后行消失 ≤ 目录消失 + 300ms；四路 IPC 全量重读同步等撑不住这个数字，
     * 所以才有"乐观立刻 + 通知驱动单飞重取兜底"这一对）。
     *
     * 单飞由 `attachMarketInvalidation` 保证：连点装卸 ⇒ 串行若干趟、任意时刻至多一趟在跑，
     * 每一次请求都由"它之后开始的那一趟"兑现（旧读数既不会并发插队，也不会倒灌）。
     * 订阅挂在 effect 上，退订挂在卸载上：关掉的面板不该继续替它重取。
     */
    const invalidationRef = useRef<MarketInvalidationHandle | null>(null);
    // 最近一次**开始**的重取令牌：`read` 负责抬它，`onSnapshot` 负责用它判落不落屏
    // （抬令牌与落屏分成两处，是 `attachMarketInvalidation` 的口径——落屏点只许有一个）
    const revalidateSeqRef = useRef(0);
    if (invalidationRef.current === null) {
      invalidationRef.current = attachMarketInvalidation({
        market: deps.market,
        read: (): Promise<MarketSnapshot> => {
          revalidateSeqRef.current = ++readSeq.current; // 这一趟比任何在途读数新 ⇒ 旧的一手一律作废
          return loadMarketSnapshot(deps);
        },
        onSnapshot: (snap: MarketSnapshot): void => {
          // 落不落屏只看这一条判据（`acceptReread`）：读失败不清屏上那份事实
          if (
            acceptReread({ stale: readSeq.current !== revalidateSeqRef.current, status: snap.status })
          ) {
            setSnapshot(snap);
          }
        },
        onError: (err: unknown): void => {
          deps.log.warn(`市场已装清单的重取没有成功：${err instanceof Error ? err.message : String(err)}`);
        },
      });
    }
    const revalidateInstalled = useCallback((): Promise<MarketSnapshot> => {
      return invalidationRef.current!.revalidate();
    }, []);
    useEffect(() => () => invalidationRef.current!.dispose(), []);

    /**
     * 打开面板：**stale-while-revalidate** 两段式——
     * 先零网络读本地立刻上屏（有列表秒出列表，没有就诚实说没有），再后台按 TTL 回源
     * （TTL 判定在服务里，`cached` = 无事发生）。busy 只罩本地读那一下：
     * 远程慢（超时最长 15s）不许把"打开面板"卡成"屏幕上像没有包"。
     */
    const reload = useCallback(async (): Promise<void> => {
      const local = ++readSeq.current; // 在途的后台读数（上一次回源/校对）一律作废
      setBusy(true);
      const localSnap = await loadMarketSnapshot(deps);
      // 本地读到手的这一刻 busy 就交还（背景段再慢也不占用它）；
      // 快照落不落地看序号：被更新的一手（pull / 下一次挂载）顶掉就整包丢弃
      setBusy(false);
      if (readSeq.current === local) setSnapshot(localSnap);
      const remote = ++readSeq.current;
      void pullMarketOutcome(deps, false).then((out) => {
        if (readSeq.current !== remote) return; // 序号被抬走 ⇒ 旧读数不倒灌
        // 服务整体炸了（list-unreadable）不清掉刚上屏的本地事实（与 `acceptReread` 同一条纪律），但要出声
        if (out.snap.status !== 'list-unreadable') setSnapshot(out.snap);
        // cached = 一切正常 ⇒ 静默（正常面板不该有废话）；refreshed / failed 才出声
        if (out.state !== 'cached') setNote(out.snap.pullNote);
      });
    }, []);

    /** 点「拉取列表」：无视 TTL 硬回源一次（作者刚改了注册表就是要立刻看到） */
    const pull = useCallback(async (): Promise<void> => {
      readSeq.current += 1; // 同上：硬回源的结果比任何在途校对新
      setBusy(true);
      const snap = await pullMarketSnapshot(deps, true);
      setSnapshot(snap);
      setNote(snap.pullNote);
      setBusy(false);
    }, []);

    // 挂载即两段式刷新（侧栏面板只在视图激活时挂载 ⇒ 作者点开才发数据，不开不占资源）
    useEffect(() => {
      void reload();
    }, [reload, props.refreshTick]);

    /**
     * 装 / 更新这一行。**按钮该不该存在不由这里判**（`row.action` 已由 `packUpdateCheck` 决定），
     * 这里只负责：把这一行交给服务 → 结果写成状态行那一句 → 成了就重读一遍本机事实（不回源）。
     */
    const doInstall = async (row: PackRow): Promise<void> => {
      // 先把动作提出局部常量：进度闭包捕获**属性**会丢缩窄（TS 对回调内的 `row.action` 不保留判别）
      const action = row.action;
      if (action === 'none' || installing !== null) return;
      const key = indexRowKey(row.entry);
      setInstalling(key);
      setNote(installBusyNote(action, row.entry.name));
      // 进度接进同一条状态行（Rust 侧已节流，这里不重复闸）。回调只在下载段发：
      // 解压/搬运阶段停在最后一条读数是**如实**的（那两段快，不发假进度）。
      // 总数未知（chunked 等）⇒ 进度条不给（不画假百分比），那一句"已收多少"照旧
      const onProgress = (p: MarketDownloadProgress): void => {
        setNote(installProgressNote(action, row.entry.name, p));
        setProgress(
          p.totalBytes !== null && p.totalBytes > 0
            ? Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100))
            : null,
        );
      };
      const out = await runInstall(deps, row.entry, action, onProgress);
      setInstalling(null);
      setProgress(null);
      setNote(out.note);
      if (out.kind === 'done') {
        // 乐观只是显示先行：行立刻出现（MK-1 判据），权威数字由通知驱动的那一趟重取修正。
        // **函数式**更新：拿闭包里那份 `snapshot` 拼会盖掉同窗口内已经落地的重读结果
        // （服务在 Promise 落回之前就已经广播了，那一趟可能比这里先落地）。
        setSnapshot((prev) => snapshotWithInstalled(prev, out.rec));
      } else {
        // 失败**不发通知**（服务只在清单真的变过时出声）⇒ 这里主动核一趟：
        // 搬进落点成功而记账失败那一类，屏上"没装"与盘上"有目录"就是两份真相，必须当场对齐。
        void revalidateInstalled();
      }
    };

    /**
     * 卸载这一条。与 `doInstall` 同一条单飞纪律，漏了它会把成功演成失败：
     * 「确认」按钮的 disabled 只看 `installing`，没有互斥时双击会并发调两次
     * `uninstall`，第二把抛 `installed-missing`，作者看到的却是"卸载没有成功"——实际早已卸干净。
     * 「取消」永远可点不动（正在装别的包也不该把作者锁在确认态里）。
     */
    const doUninstall = async (key: string): Promise<void> => {
      if (installing !== null) return;
      const rec = snapshot.installed.find((r) => pendingKey(r) === key);
      if (rec === undefined) return;
      setInstalling(pendingKey(rec));
      try {
        setNote(`正在卸掉「${rec.name}」…`);
        const out = await runUninstall(deps, rec, pending === key);
        setPending(null);
        setNote(out.note);
        if (out.kind === 'done') {
          setOpen(null);
          // 乐观只是显示先行：行立刻消失（MK-1 判据），权威数字由通知驱动的那一趟重取修正；
          // 函数式更新的理由同 `doInstall`——别拿闭包里那份旧快照去盖已经落地的新读数。
          setSnapshot((prev) => snapshotWithoutInstalled(prev, rec));
        } else {
          // 同 `doInstall`：失败不出声于服务（清单没变过），但"目录已删 / 记账还在"这类
          // 半趟只有重读能判 ⇒ 主动核一趟，屏上不留着一条作者点不动的僵尸行。
          void revalidateInstalled();
        }
      } finally {
        setInstalling(null);
      }
    };

    /**
     * 已装的口上包行「导入为我的口上项目」：只发意图（事件），不自己弹窗。
     * 不另设 busy 态——这一步只是取一个目录路径 + 发一条事件，没有可展示的进度；
     * 结果与失败照旧写内联状态行一处。装/更新进行中与其它按钮同样不响应（按钮已禁用）。
     */
    const doImport = async (rec: InstalledPack): Promise<void> => {
      if (installing !== null) return;
      const out = await runImport(deps, rec);
      setNote(out.note);
    };

    /**
     * 「发布口上…」：面板只做一件事——发意图（`market.publishRequested`）。
     * 选哪个口上项目、许可、打包与上传，全在拥有口上项目模型的适配器的发布向导里；
     * 本层不选文件、不持发布状态、不写状态行（向导自己开门，结果也由它呈现）。
     * 同一时刻只做一件事：装/更新进行中不响应（按钮此时已禁用）。
     */
    const doPublish = (): void => {
      if (installing !== null) return;
      requestPublish(deps);
    };

    // 状态与回调住这一层；怎么画、哪一行给不给按钮全在 `MarketPanelView`（可静态渲染判据）
    return createElement(MarketPanelView, {
      snapshot,
      appVersion: av,
      query,
      busy,
      note,
      progress,
      pending,
      open,
      installing,
      onQuery: setQuery,
      onClearQuery: () => setQuery(''),
      onPull: () => void pull(),
      onPublish: () => doPublish(),
      onInstall: (row: PackRow) => void doInstall(row),
      onImport: (rec: InstalledPack) => void doImport(rec),
      // 来源网址可点：只发意图（`ui.openExternal`），壳层调 Rust 原语落地——
      // 面板不持有任何"能不能开"的判定（闸在 Rust，第二份白名单必然漂）
      onOpenSource: (url: string) => deps.bus.emit('ui.openExternal', { url }),
      onRequestUninstall: setPending,
      onConfirmUninstall: (key: string) => void doUninstall(key),
      onCancelUninstall: () => setPending(null),
      onToggleDetail: (key: string) => setOpen(open === key ? null : key),
    });
  }

  return MarketPanel;
}
