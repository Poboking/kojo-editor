/**
 * 结构解析 worker 的**通用消息环**（每门语言一条线程，资源由入口注入）。
 *
 * 线程本体只做三件事：收消息 → 调 `engine.ts` 的 `StructureEngine`（装载 wasm、增量重解、
 * 跑查询都在那边）→ 把引擎的回话原样 `postMessage` 出去（引擎只产 plain 数据，Node 对象绝不跨线程）。
 * 语言差异全部收在入口的 `StructureEngineAssets`（哪两枚 wasm、哪几份查询），这里不认语言名。
 *
 * 为什么拆成 bootstrap：`kojo-ts.worker.ts` 与 `erb-ts.worker.ts` 是同一条消息环的两个实例，
 * 复制一遍就多一处会漂的时序（暂存 parse / 协议闸 / 装配前不自杀）。增量口径与查询执行是
 * **要被真语法真 wasm 量过**的东西，留在 `engine.ts` 之后两者与测试打的是同一条
 * `tree.edit()` + `parse(stringer, oldTree)` 路。
 *
 * 三条纪律（1、3 属于线程本体，2 属于引擎）：
 * 1. **不 import Monaco、不 import 宿主 UI**：worker 的依赖面只有 `./engine` + `./types` + 入口资源；
 * 2. **增量优先**：`change` 走 `tree.edit()` + 有界取字符回调重解，
 *    整篇重解只发生在 `parse`（首份 / 切文档 / 没有可用旧树时的重新对齐）；
 * 3. **出错就报出去，不硬撑**：任何一步抛错都回一条 `error`（带 `stage` 与 `capability`），
 *    由宿主决定是"整档回落"还是"这一面回落"。worker 自己绝不回落到半吊子状态继续答。
 *
 * 另两条时序口径（都不属于引擎，属于线程本体这层）：
 * - **装配没完成不该自杀**：`await` 两枚 wasm 才 `ready`，装配期间收到的 `parse` 只暂存最新
 *   一条（其后的 `change` 并进那条暂存文本），`ready` 一到补解——绝不再回一条 `all` 把
 *   整档打死（曾经每次必现：主线程的 parse 注定先于 ready 到达）；
 * - **`doc` 号原样过手**：请求带哪枚跨文档隔离号，四条内容回复就带回哪枚；worker 不解释它，
 *   对号与丢弃都在 `client.ts`（旧文档的在途结果不许冒充新文档的结果上屏）。
 */
import { StructureEngine, type StructureEngineAssets } from './engine';
import {
  KOJO_STRUCTURE_PROTOCOL,
  type KojoStructureReply,
  type KojoStructureRequest,
} from './types';

/** worker 全局的窄投影（app 的 tsconfig 只挂 DOM lib，不挂 WebWorker lib，故在此声明用到的三件） */
interface WorkerScope {
  postMessage(message: KojoStructureReply): void;
  onmessage: ((event: MessageEvent<KojoStructureRequest>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export function startStructureWorker(assets: StructureEngineAssets): void {
  const scope = self as unknown as WorkerScope;
  const engine = new StructureEngine({
    assets,
    emit: (message) => scope.postMessage(message),
  });

  /**
   * 装配完成前收到的首解请求（只留最新一条；见 `onmessage` 里的纵深说明）。
   * 引擎只留一棵树，所以暂存也只需要一份"最新全文 + 它的版本与 doc 号"。
   */
  let stagedParse: Extract<KojoStructureRequest, { type: 'parse' }> | null = null;

  scope.onmessage = (event: MessageEvent<KojoStructureRequest>) => {
    const request = event.data;
    if (!request || typeof request.type !== 'string') return;
    if (request.type === 'init') {
      if (engine.initialized) return;
      if (request.protocol !== KOJO_STRUCTURE_PROTOCOL) {
        scope.postMessage({
          type: 'error',
          version: 0,
          stage: 'worker',
          capability: 'all',
          message: `协议版本不符（worker 认 ${KOJO_STRUCTURE_PROTOCOL}，宿主发 ${request.protocol}）⇒ 结构解析整档停用`,
        });
        return;
      }
      void engine.init().then((ok) => {
        if (!ok) return;
        // 装配期间暂存过的首解在这里补上（纵深：正常流里主线程门控会等 ready 才发 parse，
        // 这条只接住"没等 ready 就发"的调用方，别让它白等）
        const staged = stagedParse;
        stagedParse = null;
        if (staged) engine.parse(staged.doc, staged.version, staged.text);
      });
      return;
    }
    if (!engine.initialized) {
      // 装配没完成**不再自杀**（主线程那侧已门控：init → ready → parse 次序由它保证，
      // 这里只是纵深）。parse 存最新一条（后来者覆盖），装配完成后补解；`change` 只在
      // 已经暂存了同一份文档的首解时**并进那条暂存文本**（缝合口径与引擎逐字相同），
      // 没解过就来的 change 缝不出有意义的树 ⇒ 丢。回应的 doc 号一律来自暂存的那条 parse，
      // 补解后的四条内容回复都带着它（跨文档隔离由主线程 `client.ts` 对号）。
      if (request.type === 'parse') stagedParse = request;
      else if (request.type === 'change' && stagedParse !== null && stagedParse.doc === request.doc) {
        stagedParse = {
          type: 'parse',
          doc: stagedParse.doc,
          version: request.version,
          text:
            stagedParse.text.slice(0, request.start.offset) +
            request.newText +
            stagedParse.text.slice(request.oldEnd.offset),
        };
      }
      return;
    }
    if (request.type === 'parse') engine.parse(request.doc, request.version, request.text);
    else if (request.type === 'change') engine.change(request);
  };

  scope.onerror = (event: ErrorEvent) => {
    // 线程级未捕获异常：能说话就说，说不出去由宿主的超时/崩溃判据兜住
    scope.postMessage({
      type: 'error',
      version: 0,
      stage: 'worker',
      capability: 'all',
      message: `worker 线程异常：${event.message}`,
    });
  };
}
