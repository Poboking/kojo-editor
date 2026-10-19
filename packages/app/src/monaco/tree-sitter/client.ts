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
 * 问到别的文档就换轨（旧文档退订、新文档整篇重解）。左右分屏同时开两份 `.kojo` 时
 * 会来回重解——正确性不受影响，代价是多解一次，这条边界写明而不是藏着。
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
  /** 代理这一侧的文本快照（与 worker 那一侧逐字相等，靠同一条编辑维持） */
  text: string;
  version: number;
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
      text,
      version: 1,
      subscription: model.onDidChangeContent(() => this.onChanged()),
      semantic: null,
      folds: null,
      dead: { semantic: false, folds: false },
    };
    this.doc = doc;
    this.post({ type: 'parse', version: doc.version, text });
    return doc;
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
    const edit = commonEdit(doc.text, next);
    const previous = doc.text;
    doc.text = next;
    if (applyEdit(previous, edit) !== next) {
      this.post({ type: 'parse', version, text: next });
      return;
    }
    this.post({
      type: 'change',
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

  private receive(data: unknown): void {
    if (!isStructureReply(data)) {
      this.fatal('worker 回传的消息形状不符协议 ⇒ 整档停用（不是解析慢，是两侧版本对不上）');
      return;
    }
    if (data.type === 'ready') {
      if (this.status === 'starting') this.status = 'ready';
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
    if (this.status === 'starting') this.status = 'ready';
    const doc = this.doc;
    if (doc === null || data.version < doc.version) {
      reportStructureDegradation({
        capability: data.type === 'folds' ? 'folds' : 'semantic',
        stage: 'parse',
        message: `收到版本 ${data.version} 的结果而当前版本是 ${doc?.version ?? 0} ⇒ 这条丢掉（拿过期结构给新文本着色比不着色危险）`,
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
