import type * as Monaco from '../entry';
// 与既有 `editor.worker` 同一条 `?worker` 路（vite 后缀），`worker.format` 仍是默认的 iife。
// 踩过的坑记在这里，别下一次再撞：`web-tree-sitter` 的 ESM 带两条 `ENVIRONMENT_IS_NODE`
// 才走到的动态 import（`fs/promises` / `module`），Rollup 只看语法 ⇒ worker 产物要多一枚
// chunk ⇒ iife 拒绝产出（`UMD and IIFE output formats are not supported for code-splitting
// builds`，实测 `pnpm --filter @kojo/app build` 当场失败）。解法在 `vite.config.ts` 的
// `stubNodeOnlyDynamicImports()`：把那两条动态 import 就地换成抛错的 promise——
// **不**抬全局 `worker.format`（那会连 Monaco 自己的 `editor.worker` 一起改成模块 worker，
// 一条实验特性不该动既有 worker 的加载方式），也**不**走 alias 钉桩（alias 生效但动态
// import 仍在，照样切 chunk）。
import TsWorker from './kojo-ts.worker?worker';
import { KOJO_STRUCTURE_ASSETS } from './assets';
import { applyEdit, commonEdit } from './edit';
import { reportStructureDegradation } from './fallback';
import {
  KOJO_STRUCTURE_PROTOCOL,
  isStructureReply,
  type KojoStructureFold,
  type KojoStructureIndentRules,
  type KojoStructureRequest,
  type KojoStructureToken,
} from './types';

/**
 * 主线程侧的 worker 代理（**主线程一次解析都不做**：这里只发文本、收数据）。
 *
 * ## 一份文档、一条线程
 *
 * worker 里只有一棵 `Tree`，所以代理只跟踪**当前被问到的那一份**文档：
 * 问到别的文档就换轨（旧文档退订、新文档整篇重解）。每份文档带一枚全局单调自增的
 * `seq`，worker 在内容回复里原样回显，对不上号的迟到回复一律丢弃——换轨瞬间旧文档
 * 的在途结果不许污染新文档（真实踩过：A 的 tokens 冒充 B 的结果被缓存上屏并滞留）。
 * 左右分屏同时开两份 `.kojo` 时会来回重解，代价是多解一次，这条边界写明而不是藏着。
 *
 * ## 装配期的门控
 *
 * `start()` 只发 `init`，**不发 parse**——worker 要 await 两枚 wasm 才算装配完成，
 * 装配前收到的解析请求会被它拒掉（曾经直接因此整档自杀）。故跟踪文档时若线程还没
 * `ready`，只记下 `pendingParse`，期间的内容变化也只更新本地快照；`ready` 一到就把
 * 暂存的 parse 带着最新全文补发出去。真失败类（协议形状不符 / wasm 载入失败 / 线程崩 /
 * 截断超限）的整档停用语义一个不动。
 *
 * ## 增量的口径
 *
 * `onDidChangeContent` 里可能有多段（多光标 / 粘贴）。这里不逐段翻译，而是拿
 * **代理自己留的上一版文本**与 `model.getValue()` 求一条保守编辑（`edit.ts`），
 * 缝完自检一次：缝出来的文本与模型现读的全文不等 ⇒ 立刻退回整篇重解（增量口径漂了
 * 最多贵一次，绝不能把错的树留在手上继续着色）。
 *
 * ## 回落的两档（都不碰保存，也不碰转译）
 *
 * - 整档（wasm / 解析 / 协议不符 / 线程崩 / 装配都没完成就超时）⇒ 终止 worker +
 *   `onFatal`，装配层据此拆掉全部 provider，作者回到只有词法层的状态；
 * - 单面（例如 folds 查询没写捕获）⇒ 那一面从此不再等（`dead`），另一面照旧。
 * 两档都经 `fallback.ts` **各说一次**，不随编辑重复。
 */

/** 一面最多等多久（线程卡住时不许把 provider 的 promise 挂到天荒地老） */
export const STRUCTURE_REQUEST_TIMEOUT_MS = 4_000;

export type StructureStatus = 'idle' | 'starting' | 'ready' | 'dead';

type FacetName = 'semantic' | 'folds';

interface FacetResult<T> {
  readonly version: number;
  readonly value: T;
}

interface TrackedDocument {
  readonly model: Monaco.editor.ITextModel;
  /** 跨文档隔离号（全局单调自增）：worker 内容回复原样回显，对不上号的回复整条丢 */
  readonly seq: number;
  /** 代理这一侧的文本快照（与 worker 那一侧逐字相等，靠同一条编辑维持） */
  text: string;
  version: number;
  /** 装配还没完成（status 非 ready）：不发 parse 也不发 change，等 ready 后补发最新全文 */
  pendingParse: boolean;
  readonly subscription: Monaco.IDisposable;
  semantic: FacetResult<readonly KojoStructureToken[]> | null;
  folds: FacetResult<readonly KojoStructureFold[]> | null;
  /** 已经停用的一面（等也等不来，别再白等；每次换轨重新计） */
  readonly dead: Record<FacetName, boolean>;
}

export interface StructureClientOptions {
  /** 超时读数（注入以便测试） */
  timeoutMs?: number;
  /** 整档停用时的通知（装配层在这里拆 provider） */
  onFatal?: (message: string) => void;
}

export class StructureClient {
  private worker: Worker | null = null;
  private doc: TrackedDocument | null = null;
  private status: StructureStatus = 'idle';
  private latestIndent: FacetResult<KojoStructureIndentRules> | null = null;
  private readonly waiters = new Map<FacetName, Set<() => void>>();
  private readonly timeoutMs: number;
  private readonly onFatal: (message: string) => void;
  /** 文档隔离号的发生器（只增不减；worker 拿它回显，主线程拿它对号） */
  private docSeq = 0;

  constructor(options: StructureClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? STRUCTURE_REQUEST_TIMEOUT_MS;
    this.onFatal = options.onFatal ?? (() => undefined);
  }

  get state(): StructureStatus {
    return this.status;
  }

  /** 最近一次结构缩进规则（没收到 / 三条腿全空 ⇒ null = 宿主一个字都不改） */
  get indent(): KojoStructureIndentRules | null {
    const rules = this.latestIndent?.value ?? null;
    if (!rules) return null;
    return rules.increasePatterns.length + rules.decreasePatterns.length + rules.enterPatterns.length === 0
      ? null
      : rules;
  }

  /** 起线程并投递 `init`；起不来（无 Worker 支持 / 构造抛错）当场整档停用 */
  start(): boolean {
    if (this.status !== 'idle') return this.status === 'starting' || this.status === 'ready';
    const request: KojoStructureRequest = {
      type: 'init',
      protocol: KOJO_STRUCTURE_PROTOCOL,
      wasmUrl: KOJO_STRUCTURE_ASSETS.kojoWasmUrl,
      runtimeWasmUrl: KOJO_STRUCTURE_ASSETS.runtimeWasmUrl,
    };
    try {
      const worker = new TsWorker();
      worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
      worker.onerror = (event: ErrorEvent) =>
        this.fatal(`worker 线程报错：${event.message || '（无消息）'}`);
      this.worker = worker;
      this.status = 'starting';
      worker.postMessage(request);
      return true;
    } catch (error: unknown) {
      this.fatal(`worker 启动失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 这一份文档的结构着色段；`null` = 拿不到 ⇒ 调用方什么都不画（词法层本来就是底） */
  async tokens(model: Monaco.editor.ITextModel): Promise<readonly KojoStructureToken[] | null> {
    const doc = this.track(model);
    if (doc === null || doc.dead.semantic) return null;
    if (doc.semantic === null) await this.waitFor('semantic');
    if (this.doc !== doc || doc.dead.semantic) return null;
    return doc.semantic?.value ?? null;
  }

  async foldingRanges(model: Monaco.editor.ITextModel): Promise<readonly KojoStructureFold[] | null> {
    const doc = this.track(model);
    if (doc === null || doc.dead.folds) return null;
    if (doc.folds === null) await this.waitFor('folds');
    if (this.doc !== doc || doc.dead.folds) return null;
    return doc.folds?.value ?? null;
  }

  dispose(): void {
    this.releaseDoc();
    for (const name of ['semantic', 'folds'] as const) this.flush(name);
    const worker = this.worker;
    this.worker = null;
    this.status = 'idle';
    this.latestIndent = null;
    worker?.terminate();
  }

  /* -------------------------------- 内部 -------------------------------- */

  /** 换轨 / 保持跟踪当前文档；线程已死或模型已释放 ⇒ null（调用方什么都不画） */
  private track(model: Monaco.editor.ITextModel): TrackedDocument | null {
    if (this.status === 'dead' || model.isDisposed()) return null;
    if (this.doc !== null && this.doc.model === model && !model.isDisposed()) return this.doc;
    this.releaseDoc();
    if (!this.start()) return null;
    const text = model.getValue();
    const doc: TrackedDocument = {
      model,
      seq: ++this.docSeq,
      text,
      version: 1,
      // 装配没完成就先不发 parse（发了注定被 worker 拒）：等 ready 后补发，自然带上最新全文
      pendingParse: this.status !== 'ready',
      subscription: model.onDidChangeContent(() => this.onChanged()),
      semantic: null,
      folds: null,
      dead: { semantic: false, folds: false },
    };
    this.doc = doc;
    if (!doc.pendingParse) this.postParse(doc);
    return doc;
  }

  /** 整篇重解请求（doc 号 + 当前版本 + 当前快照全文） */
  private postParse(doc: TrackedDocument): void {
    this.post({ type: 'parse', doc: doc.seq, version: doc.version, text: doc.text });
  }

  private releaseDoc(): void {
    const doc = this.doc;
    if (doc === null) return;
    doc.subscription.dispose();
    this.doc = null;
  }

  /** 内容变化 → 一条保守编辑；缝不回去就整篇重解（口径漂了宁可贵一次） */
  private onChanged(): void {
    const doc = this.doc;
    if (doc === null || doc.model.isDisposed() || this.worker === null) return;
    const next = doc.model.getValue();
    if (next === doc.text) return;
    const version = doc.version + 1;
    doc.version = version;
    const previous = doc.text;
    doc.text = next;
    // 装配没完成：只留最新文本与版本，不发 change（worker 那侧的契约是 parse 必然先于
    // change）；ready 后补发的 parse 自带这份快照，中途的编辑自然并入
    if (doc.pendingParse) return;
    const edit = commonEdit(previous, next);
    if (applyEdit(previous, edit) !== next) {
      this.post({ type: 'parse', doc: doc.seq, version, text: next });
      return;
    }
    this.post({
      type: 'change',
      doc: doc.seq,
      version,
      start: edit.start,
      oldEnd: edit.oldEnd,
      newEnd: edit.newEnd,
      newText: edit.newText,
    });
  }

  private post(request: KojoStructureRequest): void {
    this.worker?.postMessage(request);
  }

  /** 等某一面出结果；超时 = 这一面停用（装配都没完成时升级为整档停用） */
  private waitFor(name: FacetName): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(handle);
        this.waiters.get(name)?.delete(finish);
        resolve();
      };
      const handle = window.setTimeout(() => {
        this.waiters.get(name)?.delete(finish);
        if (this.status !== 'ready') {
          this.fatal(`结构解析装配始终没有完成（${this.timeoutMs}ms 内无 ready/结果）⇒ 整档停用`);
        } else {
          reportStructureDegradation({
            capability: name,
            stage: 'parse',
            message: `结构解析 ${this.timeoutMs}ms 内没有回话 ⇒ 这一面这次不顶上（下一份文档再试）`,
          });
          const doc = this.doc;
          if (doc !== null) doc.dead[name] = true;
        }
        resolve();
      }, this.timeoutMs);
      let bucket = this.waiters.get(name);
      if (!bucket) {
        bucket = new Set();
        this.waiters.set(name, bucket);
      }
      bucket.add(finish);
    });
  }

  /** 放行某一面的全部等待者 */
  private flush(name: FacetName): void {
    const bucket = this.waiters.get(name);
    if (bucket === undefined || bucket.size === 0) return;
    const pending = [...bucket];
    bucket.clear();
    for (const finish of pending) finish();
  }

  private fatal(message: string): void {
    if (this.status === 'dead') return;
    this.status = 'dead';
    reportStructureDegradation({ capability: 'all', stage: 'worker', message });
    this.releaseDoc();
    this.flush('semantic');
    this.flush('folds');
    const worker = this.worker;
    this.worker = null;
    this.latestIndent = null;
    worker?.terminate();
    this.onFatal(message);
  }

  /** 装配完成那一刻：抬状态，并把暂存中的首解补发出去（此刻才带最新全文与版本） */
  private promoteToReady(): void {
    if (this.status !== 'starting') return;
    this.status = 'ready';
    const doc = this.doc;
    if (doc === null || !doc.pendingParse) return;
    doc.pendingParse = false;
    this.postParse(doc);
  }

  private receive(data: unknown): void {
    if (!isStructureReply(data)) {
      this.fatal('worker 回传的消息形状不符协议 ⇒ 整档停用（不是解析慢，是两侧版本对不上）');
      return;
    }
    if (data.type === 'ready') {
      this.promoteToReady();
      return;
    }
    if (data.type === 'error') {
      if (data.capability === 'all') {
        this.fatal(data.message);
        return;
      }
      reportStructureDegradation({ capability: data.capability, stage: data.stage, message: data.message });
      const doc = this.doc;
      if (doc !== null && (data.capability === 'semantic' || data.capability === 'folds')) {
        doc.dead[data.capability] = true;
        this.flush(data.capability);
      }
      return;
    }
    this.promoteToReady();
    const doc = this.doc;
    if (doc === null || data.doc !== doc.seq) {
      reportStructureDegradation({
        capability: data.type === 'folds' ? 'folds' : data.type === 'indent' ? 'indent' : 'semantic',
        stage: 'parse',
        message: `收到文档 ${data.doc} 的结果而当前跟踪的是文档 ${doc?.seq ?? '无'} ⇒ 这条丢掉（旧文档的结构着到新文档上比不着色危险）`,
      });
      return;
    }
    if (data.version < doc.version) {
      reportStructureDegradation({
        capability: data.type === 'folds' ? 'folds' : data.type === 'indent' ? 'indent' : 'semantic',
        stage: 'parse',
        message: `收到版本 ${data.version} 的结果而当前版本是 ${doc.version} ⇒ 这条丢掉（拿过期结构给新文本着色比不着色危险）`,
      });
      return;
    }
    if (data.type === 'semantic') doc.semantic = { version: data.version, value: data.tokens };
    else if (data.type === 'folds') doc.folds = { version: data.version, value: data.folds };
    else this.latestIndent = { version: data.version, value: data.rules };
    if (data.type === 'semantic') this.flush('semantic');
    else if (data.type === 'folds') this.flush('folds');
  }
}
