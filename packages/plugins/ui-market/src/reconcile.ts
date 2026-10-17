/**
 * 已装清单的**单飞重取**（MK-1：即时失效之后的那半件事）。
 *
 * 为什么要有这一层：装/卸成功 → 服务广播"清单变了" → 消费者重读一遍全量事实
 * （`index()` + `installed()` + `endpoint()` + `installedBytes()`，四条 IPC）。
 * 作者连点两次就得有**两趟**，但两趟**不许并发**——并发重读会同时打两条批量 stat，
 * 而先出发的那趟可能后落地，旧读数把新事实盖回去（看板上那条"已经不存在却还挂着的行"
 * 的另一半成因）。
 *
 * 这里的纪律只有两条，而且都可判：
 * 1. **同一时刻至多一趟**（`inflight()` 只可能是 0 或 1）；
 * 2. **每一次请求都由"它之后开始的那一趟"兑现**（`started` 序号语义，见下）——
 *    所以它既不是"并发多趟"，也不是"把在途那趟的结果当成对本次改动的回答"（那会读到改动之前的一份）。
 *
 * 零定时器、零 `sleep`：全部判据靠序号与在途Promise，测试里用手动 resolve 的假读即可自证。
 */

// `MarketService` 直接从契约取（`actions.ts` 只是 import 它来用、并不转发出口——
// 在这一层再抄一份"转出口"就是第二份真相；插件只许依赖 `@kojo/plugin-api`，正是这条）。
import type { MarketService } from '@kojo/plugin-api';
import type { MarketSnapshot } from './actions';

/** 一次重取请求在等待队列里的位置：`want` = 至少要等到第几趟（按开始序号）才兑现 */
interface Waiter<T> {
  readonly want: number;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export interface Revalidator<T> {
  /**
   * 请求一次重取。返回的 Promise 由**本次请求之后开始**的那一趟兑现
   * （在途的那趟如果已经先开始，就排队等下一趟；同一时刻还没开始的请求合并进同一趟）。
   */
  revalidate(): Promise<T>;
  /** 当前在跑的重取趟数（0 / 1 ⇒ 单飞成立的直接读数） */
  inflight(): number;
  /** 已经**开始**的趟数（含在途那一趟）——测试用它证明"没有并发第二趟" */
  started(): number;
  /** 已经跑完的趟数 */
  completed(): number;
  /** 还在排队等兑现的请求数 */
  queued(): number;
}

/**
 * 造一把单飞重取器。
 *
 * @param read 真正的重读（一次 = 一趟）。它**自己**负责把结果落到消费者那里（面板那边是
 *   `setSnapshot` + 新鲜度令牌），本层只管"几趟、什么顺序、谁兑现谁"。
 */
export function createRevalidator<T>(read: () => Promise<T>): Revalidator<T> {
  let startedSeq = 0;
  let completedSeq = 0;
  let running = 0;
  const waiters: Waiter<T>[] = [];

  function release(upto: number, value: T): void {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.want <= upto) {
        const w = waiters.splice(i, 1)[0]!;
        w.resolve(value);
      }
    }
  }

  /** 失败的那一趟兑现不了任何等待它的请求 ⇒ 全部原样抛回去（**不重试、不装成功**） */
  function rejectAll(upto: number, err: unknown): void {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.want <= upto) {
        const w = waiters.splice(i, 1)[0]!;
        w.reject(err);
      }
    }
  }

  function pump(): void {
    if (running > 0 || waiters.length === 0) return;
    startedSeq += 1;
    const seq = startedSeq;
    running += 1;
    void (async (): Promise<void> => {
      try {
        const value = await read();
        completedSeq = seq;
        release(seq, value);
      } catch (err: unknown) {
        rejectAll(seq, err);
      } finally {
        running -= 1;
        // 在途期间排进来的请求要的是"下一趟"，这里立刻补一趟（仍然串行，永不并发）
        pump();
      }
    })();
  }

  return {
    revalidate(): Promise<T> {
      const want = startedSeq + 1;
      return new Promise<T>((resolve, reject) => {
        waiters.push({ want, resolve, reject });
        pump();
      });
    },
    inflight: (): number => running,
    started: (): number => startedSeq,
    completed: (): number => completedSeq,
    queued: (): number => waiters.length,
  };
}

/**
 * 重取结果能不能落屏（面板与后台校对共用的**唯一**判据）。
 *
 * 两条各拦一半：
 * - `stale` = 这次读数被更新的一手顶掉了（连点时旧读数倒灌，卸掉的行"复活"且再无纠正）；
 * - `status === 'list-unreadable'` = "读"这件事本身失败——它不是一份可显示的事实，
 *   拿它替换屏上那份就等于把列表抹成空白（与 `refreshIndex` 的「失败不清已有列表」同一条纪律）。
 */
export function acceptReread(o: {
  stale: boolean;
  status: string;
}): boolean {
  return !o.stale && o.status !== 'list-unreadable';
}

/**
 * 失效接线的把手（面板持有一个；测试拿 `started()` / `inflight()` 自证单飞，不靠 sleep）。
 */
export interface MarketInvalidationHandle {
  /** 主动请求一次重取（不等通知：装卸**失败**时也要核一次盘上到底成了什么样子） */
  revalidate(): Promise<MarketSnapshot>;
  /** 退订：关掉的面板不该继续替它重取 */
  dispose(): void;
  /** 已开始的趟数（判据用它证明"没有并发第二趟"） */
  started(): number;
  /** 当前在跑的趟数（只可能 0 / 1） */
  inflight(): number;
}

/**
 * 把「服务的清单变更通知」接到「单飞重取」上的**唯一**一处接线。
 *
 * 为什么单独成函数：这一段是 MK-1 的触发点，必须能被假桥直接打（拿到 listener 就能
 * 当场"fire"一次，判据不靠 sleep），而不是藏在 React effect 里只能靠真壳去看。
 * 面板与未来的其它消费者都调它 ⇒ 失效路径只有一条（各写一条 = 又要对拍两本账）。
 *
 * @param read 真读一遍全部事实（调用方负责抬自己的新鲜度令牌）
 * @param onSnapshot 落屏（调用方用 `acceptReread` 判要不要落地）
 * @param onError 重取本身炸了（理论上到不了：`loadMarketSnapshot` 把异常汇成快照）⇒ 必须出声，不静默
 */
export function attachMarketInvalidation(o: {
  market: Pick<MarketService, 'onInstalledChanged'>;
  read: () => Promise<MarketSnapshot>;
  onSnapshot: (snap: MarketSnapshot) => void;
  onError?: (err: unknown) => void;
}): MarketInvalidationHandle {
  const revalidator = createRevalidator(o.read);
  /**
   * 落屏的**唯一**出口：通知驱动的那一趟与调用方主动要的那一趟（装卸失败后"核一次盘上到底
   * 成了什么样子"）都从这里走。各落一次 = 两套口径；只在通知路径落 ⇒ 主动那一趟白读，
   * 屏上仍留着那条僵尸行。
   */
  function revalidateLanded(): Promise<MarketSnapshot> {
    return revalidator.revalidate().then((snap) => {
      o.onSnapshot(snap);
      return snap;
    });
  }
  const unsubscribe = o.market.onInstalledChanged((): void => {
    // 失败只在通知路径上需要兜住（调用方自己拿的那条 Promise 由它自己接）——不静默
    revalidateLanded().then(undefined, (err: unknown): void => {
      if (o.onError !== undefined) o.onError(err);
    });
  });
  return {
    revalidate: revalidateLanded,
    dispose: unsubscribe,
    started: revalidator.started,
    inflight: revalidator.inflight,
  };
}
