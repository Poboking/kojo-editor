/**
 * 编辑器 model 池（SPLIT-1 分屏批）。
 *
 * 分屏后同一文件可以同时出现在多个组里——Monaco 的 model 按 URI 全局注册，
 * `createModel` 撞上同 URI 直接抛异常，而任一组把 model `dispose` 掉会把
 * 另一组正在显示的内容连根拔走。⇒ model 的所有权从「每个 EditorPane 一份
 * Map」上移到**进程级池**：引用计数归零才 dispose，同文件多组共享同一份
 * model（一处编辑、两栏同显——本来就是同一份内存）。
 *
 * 「已保存基线」版本号（BUG-4 的 O(1) 脏判定）也随池走：它属于**文件**而不
 * 属于某一组——A 组保存之后 B 组必须立刻显示干净，反之亦然。同一份生命周期上
 * 还挂一份**磁盘文本快照**（`savedBase`，ZH-F3 三方合并的 base）：版本号判得了
 * "有没有变"，判不了"变在哪一行"，所以做三方必须另存文本。
 *
 * **PS-5 给这份正文加了常驻预算**（`SAVED_BASE_MAX_UNITS` 单份 +
 * `SAVED_BASE_POOL_BUDGET_UNITS` 全池，越界就不留）。留不住不影响脏判定——
 * 脏只认 `baseline`（版本号），`savedBase` 只服务三方合并；留不住的那一份
 * 如实退回两方语义（`decideExternalChange` 既有分支，冲突照弹、绝不自动合）。
 *
 * 工厂形态（`createEditorModelPool`）把 monaco / 内核 io 全部注入，纯逻辑
 * 闭环可单测；`editorModelPool` 是 EditorPane 用的真身单例。
 *
 * **PS-12：关标签不再立即 dispose，先进有界冷档**（对标 VSCode 的 model 生命周期——
 * 真正的驻留大户是开着的标签，关掉的这一侧能给的只有"重开零读盘秒回"）。冷档只收
 * **干净**件（版本号与基线对齐），预算内保住 Monarch tokenization 行缓存；对外
 * `release()` 返回 0 的语义**一行不变**——调用方照做终局清理，池内部转冷档。
 * 三道安全闸（缺一即整体退回改前"归零即死"）：
 *  ① 保守缺省链：`modelUnits` / `modelVersion` / `writeText` 三注入任一缺席 ⇒ 冷档禁用；
 *  ② 冷档件被**程序性改写**（替换执行器家族命中注册表 model：只改 model 不写盘——
 *     见 `search-replace-exec.ts` 的 `replaceInModel`）⇒ 池补写盘，还原"关着 ⇒ io
 *     读改写"的既有语义；写盘失败 ⇒ 钉住不驱逐（内存是唯一真相，复活即脏标）；
 *  ③ `file.changed` 命中冷档路径 ⇒ 立即弃档（盘面真相变了，重开必读盘 = 改前行为）。
 *
 * **PS-12 顺带立起观测面**（铁律 4：不静默）：`stats()` 暴露活动/冷档/基线三本账，
 * 活动正文合计跨过 `ACTIVE_POOL_WARN_UNITS` 时 warn 一次（状态翻转去抖）。
 */

import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import { pathKey } from '@kojo/plugin-api';
import { languageForPath } from '../monaco/languages';

/**
 * 按扩展名选语言（**兼容出口**：真源自 LANG-REGISTRY 起住在 `monaco/languages.ts`
 * 的 descriptor 表；本函数只转发，免去十几处调用点与既有测试跟着改名）。
 *
 * 判据与收口前逐字同序：`.kojo` → ERB 方言族（`.erb` / `.erm` / `.erh`）→ `.json`
 * → `plaintext` 兜底。大小写不敏感、按最后一段扩展名判（`x.kojo.bak` 不误挂）。
 */
export function languageFor(filePath: string): string {
  return languageForPath(filePath);
}

export interface PooledModelEntry {
  readonly model: Monaco.editor.ITextModel;
  readonly encoding: string;
  readonly eol: string;
  /** 这份 model 的初稿来自恢复快照（而非读盘）——调用方据此决定**提交后**才消费快照 */
  readonly fromRecovery: boolean;
}

/* ───────────────── PS-5：磁盘基线文本的常驻预算（不再"每标签一份正文"） ───────────────── */

/**
 * 单份基线文本的长度上限（UTF-16 码元，即 `model.getValue().length` 的口径）。
 *
 * 尺子来自真实盘账：最大单文件 52,601 行 / 2.35 MB（UTF-8 字节），CJK 语料折成码元
 * 约 0.8–1.3 M ⇒ 1.5 M 码元把**语料里每一份文件都留在预算内**，只挡住"比最大真实文件
 * 还大一截"那种盘（99 万行级）。
 *
 * 越界时**不存正文**（`savedBase()` 给 `undefined`）。这不是静默降级：调用方
 * `decideExternalChange` 对"没有 base"早有既定语义 ⇒ 退回**两方**判定（磁盘变了而我脏
 * ⇒ 弹通知、给「重新加载」动作，绝不自动合并），比"合并到一个不存在的共同祖先上"更保守。
 */
export const SAVED_BASE_MAX_UNITS = 1_500_000;

/**
 * 全池基线的常驻预算（码元总数；V8 里 CJK 字符串按 2 字节/码元 ⇒ 上限约 12 MB）。
 *
 * 超预算按"最久未读写的那一份"开始丢（丢一份 = 那一份退回两方语义，同上，不是静默）。
 * 改前这里是**无上限**的：N 个标签就是 N 份整篇正文，与 model 里那一份重复存两遍。
 */
export const SAVED_BASE_POOL_BUDGET_UNITS = 6_000_000;

/**
 * 这一份正文值不值得留作三方合并的 base（纯函数；两条判据任一不过即不留）。
 *
 * **不受影响的不变式**：脏判定走 `baseline`（model 版本号 O(1) 比较），**从不**读
 * `savedBase`。所以丢基线既不会把脏的报成"已保存"，也不会把干净的报成"未保存"——
 * 这条是本次改动唯一的正确性红线，逐条钉在 `tests/ps5-model-memory.test.ts`。
 */
export function savedBaseWorthKeeping(units: number, poolUsedUnits: number): boolean {
  return units <= SAVED_BASE_MAX_UNITS && poolUsedUnits + units <= SAVED_BASE_POOL_BUDGET_UNITS;
}

/* ───────────────── PS-12：model 冷档（关标签的有界驻留）+ 内存观测 ───────────────── */

/**
 * 冷档最多同时驻留的 model 数。尺子是使用面而非内存面：冷档的全部价值在
 * "误关立刻重开"与"几个文件来回切"——8 份足够覆盖这两种习惯，再多就是把
 * 作者**明确关掉**的文件硬留在内存里（VSCode `workbench.editor.limit` 同思路）。
 */
export const COLD_CACHE_MAX_MODELS = 8;

/**
 * 单份冷档 model 的码元上限（`model.getValueLength()` 口径）。与
 * `SAVED_BASE_MAX_UNITS` 同尺：真实语料最大单文件（52,601 行 ≈ 0.8–1.3 M 码元）
 * 留得住，"比最大真实文件还大一截"的盘不驻留（超界照旧立即 dispose）。
 */
export const COLD_CACHE_MAX_UNITS = 1_500_000;

/**
 * 全冷档的驻留预算（码元总数）。刻意比 `SAVED_BASE_POOL_BUDGET_UNITS`（6 M）紧：
 * model 比 savedBase 贵——Monarch tokenization 行缓存 + 行结构 +（干净件的）撤销栈
 * 都随 model 驻留。超预算从**最旧冷却端**驱逐（正在补写盘 / 写盘失败的钉住件除外）。
 */
export const COLD_CACHE_BUDGET_UNITS = 4_000_000;

/**
 * 活动正文合计的告警阈（码元）。开着的标签是真正的驻留大户且**不属于池能驱逐的面**
 * （作者正在编辑）——池能做的是把账亮出来：跨阈 warn 一次（回落再上行会再报），
 * 状态面板 / 探针读 `stats()` 拿同一本账。
 */
export const ACTIVE_POOL_WARN_UNITS = 30_000_000;

/** 池的内存读数（观测面；码元口径，`stats()` 单源） */
export interface ModelPoolStats {
  /** refs ≥ 1 的记录数（= 开着的标签去重后的文件数，多组共享算一份） */
  activeModels: number;
  /** 活动件 acquire 时点正文长度合计（编辑漂移不追——观测口径，精确账看内存水位） */
  activeUnits: number;
  /** 冷档件数（refs = 0 但 model 仍在注册表驻留） */
  coldModels: number;
  /** 冷档件转档时点码元合计 */
  coldUnits: number;
  /** PS-5 基线文本预算的当前占用量 */
  savedBaseUnits: number;
}

export interface PoolDeps {
  /** 读盘（恢复件由调用方先取好，经 `text` 注入，池不认识 recovery-store） */
  readText: (kernel: Kernel, path: string) => Promise<{ text: string; encoding: string; eol: string }>;
  /** 建 model（真身 = monaco.editor.createModel(text, languageFor(path), Uri.file(path)) */
  createModel: (path: string, text: string) => Monaco.editor.ITextModel;
  /**
   * model 的码元数（`getValueLength()` 同口径；冷档预算的记账尺）。
   * PS-12 保守缺省链：`modelUnits` / `modelVersion` / `writeText` 任一缺席 ⇒ 冷档整体
   * 禁用（`release` 归零即 dispose，改前行为）——冷档的安全闸是全有或全无的组合，不做
   * 部分降级的中间态。
   */
  modelUnits?: (model: Monaco.editor.ITextModel) => number;
  /** model 当前版本号（脏判定同口径 `getAlternativeVersionId()`）；缺省 ⇒ 冷档禁用 */
  modelVersion?: (model: Monaco.editor.ITextModel) => number;
  /** 冷档件被程序性改写后的补写盘通道（真身 = kernel.io.writeText，写域强制由内核把关） */
  writeText?: (kernel: Kernel, path: string, text: string) => Promise<void>;
  /**
   * 重挂 model 语言（真身 = `monaco.editor.setModelLanguage`）。缺省 ⇒
   * {@link EditorModelPool.retargetLanguage} 返回 0（纯逻辑测试 / 无 Monaco 环境不假装改过）。
   */
  setModelLanguage?: (model: Monaco.editor.ITextModel, languageId: string) => void;
  /** 可见性出口（驱逐 / 钉住 / 超阈告警）；缺省 console.warn（铁律 4：不静默） */
  warn?: (message: string) => void;
}


interface PoolRecord {
  entry?: PooledModelEntry;
  refs: number;
  /**
   * 正在等待 `loading` 落地的 acquire 数（含**尚未把自身引用挂上**的）。
   * refs 归零但 pending>0 ⇒ 记录不许 dispose/回收：等待者的引用会在其 settle
   * 续体里挂上，提前拆记录会把那份 model 变成"已 dispose 却仍被返回"的孤儿。
   */
  pending: number;
  loading?: Promise<{ entry: PooledModelEntry; diskText?: string; units: number }>;
  /** 已保存基线版本号（BUG-4）；随文件存续，最后一份引用释放时一并清掉 */
  baseline?: number;
  /**
   * 最后一次与磁盘对齐的**文本**快照（ZH-F3 三方合并的 base）。
   * 版本号那份（`baseline`）只能判脏，判不了"改在哪"，所以这里另存文本；
   * 生命周期与 `baseline` 完全一致（随记录回收一起释放，不留悬空副本）。
   * 缺省 = 没有 base（恢复件首开：盘上真相此刻未知）⇒ 调用方必须退回两方语义。
   */
  savedBase?: string;
  /** PS-12：活动记账用的正文长度（建档/转冷档时点定值；观测口径，编辑漂移不追） */
  units: number;
  /** PS-12：最近一次 acquire 带来的 kernel（冷档补写盘要用；与池同生的 app 级单例） */
  kernel?: Kernel;
  /** PS-12：冷档驻留标记（= 该 path 在 coldLru 里；销档时同步出列） */
  cold?: boolean;
  /** PS-12：补写盘失败钉住（内存是唯一真相 ⇒ 驱逐豁免，复活即脏标交用户处置） */
  coldPinned?: boolean;
  /** PS-12：补写盘在途（驱逐豁免：写盘竞败时 model 已 dispose 就真丢了） */
  coldWriteInflight?: boolean;
  /** PS-12：冷档期的程序性改写监听（复活后保留空转——回调里判 refs===0 才接管） */
  coldListener?: { dispose(): void };
}

export interface EditorModelPool {
  acquire: (kernel: Kernel, path: string, opts?: { text?: string; encoding?: string; eol?: string }) => Promise<PooledModelEntry>;
  /** 释放一份引用；返回**剩余**引用数（0 = model 已 dispose，调用方可做最后清理） */
  release: (path: string) => number;
  refCount: (path: string) => number;
  baseline: (path: string) => number | undefined;
  setBaseline: (path: string, version: number) => void;
  /** 三方合并用的磁盘文本快照；undefined = 无 base（不许拿空串冒充） */
  savedBase: (path: string) => string | undefined;
  /** 保存成功 / 自动合并落地后推进 base；路径不在池里则 no-op（同 `setBaseline` 口径） */
  setSavedBase: (path: string, text: string) => void;
  /** PS-12：内存读数（活动 / 冷档 / 基线三本账，观测面单源） */
  stats: () => ModelPoolStats;
  /**
   * **只答活面**（PS-12-C）：`refs > 0` 才返回 model——开着的标签去重后就是这份清单；
   * 冷档（已关标签的驻留 model）/ 不在池 ⇒ `undefined`。
   *
   * 为什么必须由池答、而不是让调用方查 Monaco 注册表（`monaco.editor.getModel`）：
   * PS-12 落地后注册表里有冷档件，**注册表 ≠ 活面**——全项目替换把冷档件当
   * 「打开的文件」走 in-model 路径，口径就错了（BOARD §W PS-12-C）。判等用全仓
   * 统一的 `pathKey`（池键与检索索引的写法不保证同盘符大小写/分隔符）。
   * 调用方拿到 `undefined` 自然走盘路径（io 读改写），**恰好**就是冷档该有的语义
   * （盘改了 ⇒ `file.changed` ⇒ 池弃档，见安全闸③）——不答冷档存在，语义已对。
   */
  liveModel: (path: string) => Monaco.editor.ITextModel | undefined;
  /**
   * 语言覆盖变更后的跟随（LANG-OVERRIDE-MODEL）：按 `pathKey` 找池里**所有**同路径
   * model（活动 + 冷档，含同一路径不同拼写的各一份）逐份按 `resolve` 的目标重挂。
   *
   * `resolve` 按 model 现状给目标语言——同一路径的多份 model 正文可以不同（2.0 路由按
   * 正文判）；同语言跳过（与 2.0 重挂控制器同一条幂等判据：重挂会重置 tokenization /
   * 装饰 / 折叠状态）。返回真正重挂的份数（观测面 / 测试读数）。
   */
  retargetLanguage: (path: string, resolve: (model: Monaco.editor.ITextModel) => string) => number;
  /**
   * 真另存为的 buffer 转档（2026-10-28 批）：把整条池记录（model / refs / baseline /
   * savedBase / 冷档账）**换键**到新路径并返回是否命中——同一份 model 原地续命，
   * 撤销栈与视图引用全部跟着走（这正是与"关标签重开"链路不同的地方）。
   * 判据：旧键不存在 ⇒ false；新键已站着**活着的**记录 ⇒ false（绝不吞掉别人的账）。
   * 新键上只剩冷档（refs=0）⇒ 那份是"已关标签的旧盘真相"，转档内容才是真相，弃档后换键。
   */
  retargetPath: (from: string, to: string) => boolean;
}

export function createEditorModelPool(deps: PoolDeps): EditorModelPool {
  const pool = new Map<string, PoolRecord>();
  /**
   * 基线文本的常驻账（PS-5）：`baseUnits` = 池里现存基线的码元总数；`baseLru` 的插入序
   * 就是使用序（写入/读到都 touch 到最新端），超预算从最旧端丢。两者与 `pool` 同步：
   * 记录被回收 ⇒ 两处一起销账（漏一处就是"预算只涨不跌"的假泄漏）。
   */
  let baseUnits = 0;
  const baseLru = new Map<string, true>();

  /* ───────── PS-12：冷档账 + 活动记账 + 可见性出口 ───────── */

  const warn = deps.warn ?? ((m: string) => console.warn(`[editor-model-pool] ${m}`));
  /** 保守缺省链：三注入缺一 ⇒ 冷档禁用（release 归零即 dispose，改前行为） */
  const coldCapable = deps.modelUnits !== undefined && deps.modelVersion !== undefined && deps.writeText !== undefined;
  /** 冷档驻留账：插入序 = 冷却序（转档进最新端），预算/数量超界从最旧端驱逐 */
  let coldUnits = 0;
  const coldLru = new Map<string, true>();
  /** 活动正文账（acquire/release 时点记账，编辑漂移不追——观测口径） */
  let activeUnits = 0;
  /** 活动告警去抖（跨阈翻转才报，回落静默复位） */
  let warnAboveActive = false;
  /** `file.changed` 订阅是否已挂（首个带 bus 的 acquire 幂等挂一次，池与 bus 同生） */
  let fileChangesBound = false;

  const dropBase = (path: string): void => {
    const rec = pool.get(path);
    if (rec?.savedBase !== undefined) baseUnits -= rec.savedBase.length;
    if (rec) rec.savedBase = undefined;
    baseLru.delete(path);
  };

  /** 立一份新基线（单份越界 ⇒ 直接不留；池预算不够 ⇒ 从最旧端淘汰到放得下，**新写入的那份永远优先保住**） */
  const storeBase = (path: string, text: string): void => {
    const rec = pool.get(path);
    if (!rec) return; // 同 `setSavedBase` 既有口径：不在池里的路径 no-op，绝不复活已回收的记录
    const replacing = rec.savedBase === undefined ? 0 : rec.savedBase.length;
    if (replacing > 0) dropBase(path);
    // 单份越界：这一份就是留不住（它对应"整篇正文比预算还大"），退回两方语义
    if (text.length > SAVED_BASE_MAX_UNITS) return;
    // 预算装不下就让最久未读写的那一份先走——正在被写的那一份对应的就是作者此刻的文件
    while (baseUnits + text.length > SAVED_BASE_POOL_BUDGET_UNITS && baseLru.size > 0) {
      const oldest = baseLru.keys().next();
      if (oldest.done) break;
      dropBase(oldest.value);
    }
    if (!savedBaseWorthKeeping(text.length, baseUnits)) return; // 判据不成立就不写（兜底闸门）
    rec.savedBase = text;
    baseUnits += text.length;
    baseLru.set(path, true);
  };

  const recordOf = (path: string): PoolRecord => {
    let rec = pool.get(path);
    if (!rec) {
      rec = { refs: 0, pending: 0, units: 0 };
      pool.set(path, rec);
    }
    return rec!;
  };

  /** 记录的终局销毁（改前的"归零即死" / PS-12 的驱逐与弃档共用一个出口，单次性由 pool.delete 先行保证） */
  const destroyRecord = (path: string, rec: PoolRecord): void => {
    if (!pool.delete(path)) return; // 已被销过（防御：listener 续体与弃档竞态下记录身份判）
    rec.coldListener?.dispose();
    rec.coldListener = undefined;
    if (rec.entry) rec.entry.model.dispose();
    if (rec.cold) {
      coldLru.delete(path);
      coldUnits -= rec.units;
      rec.cold = false;
    }
    dropBase(path); // 基线随文件走：记录回收 ⇒ 常驻预算同批归还（漏还就是"越开越多"的假预算）
  };

  /**
   * 冷档期的程序性改写接管（PS-12 安全闸②）：替换执行器家族命中注册表 model 时
   * **只改 model 不写盘**（`replaceInModel` 的既有契约——开着 ⇒ 脏标等用户保存）。
   * 冷档件没有编辑器挂着、没有 EditorPane 监听，没人报脏也没人落盘 ⇒ 池必须自己
   * 补写盘，把语义还原成"关着 ⇒ io 读改写"（改前对关闭文件的替换就是直接写盘的）。
   * 回调里 refs===0 才接管：复活后交还 EditorPane 契约（脏标 + 用户保存），池不越权。
   */
  const attachColdListener = (path: string, rec: PoolRecord): void => {
    if (rec.coldListener || !rec.entry) return; // 复活期保留的空转 listener 复用，不重复挂
    const model = rec.entry.model;
    rec.coldListener = model.onDidChangeContent(() => {
      if (pool.get(path) !== rec || rec.refs !== 0 || !rec.cold) return;
      const text = model.getValue();
      const kernel = rec.kernel;
      if (!kernel || deps.writeText === undefined || deps.modelVersion === undefined) return;
      rec.coldWriteInflight = true;
      void deps.writeText(kernel, path, text).then(
        () => {
          rec.coldWriteInflight = false;
          if (pool.get(path) !== rec) return; // 写盘期间被弃档/驱逐：盘上已有真相，记录没了就不动
          if (rec.refs !== 0) return; // 复活了：baseline 真源交还 EditorPane（用户保存自会推）
          rec.baseline = deps.modelVersion!(model); // 改写已落盘 ⇒ 新版本就是新的"与磁盘对齐"
          storeBase(path, text);
        },
        (err: unknown) => {
          rec.coldWriteInflight = false;
          rec.coldPinned = true; // 驱逐豁免：此刻内存是这份改写的唯一载体
          const reason = err instanceof Error ? err.message : String(err);
          warn(`冷档文件「${path}」被程序改写后写盘失败，已钉住等重开处置（重开将显示未保存）：${reason}`);
        },
      );
    });
  };

  /**
   * refs 归零的处置（PS-12 核心）：干净件进有界冷档（复活零读盘），否则走终局销毁。
   * 干净 = 版本号与基线对齐（EditorPane 脏判定同口径）——脏件 / 恢复件（baseline 钉 0、
   * 版本从 1 起数恒不等）/ 无基线件一律照旧立即 dispose，用户"关掉未保存标签 = 放弃"
   * 的既有预期零变化。
   */
  const maybeColdOrDispose = (path: string, rec: PoolRecord): void => {
    const model = rec.entry?.model;
    const clean = model !== undefined
      && rec.baseline !== undefined
      && deps.modelVersion !== undefined
      && deps.modelVersion(model) === rec.baseline;
    // 四环不全（注入 / 订阅 / kernel）或不够干净 ⇒ 改前行为：归零即死
    if (!coldCapable || !fileChangesBound || rec.kernel === undefined || !clean) {
      destroyRecord(path, rec);
      return;
    }
    const units = deps.modelUnits!(model);
    if (units > COLD_CACHE_MAX_UNITS) {
      destroyRecord(path, rec); // 单份越界不驻留（照 PS-5 单份上限口径）
      return;
    }
    // 腾位：预算/数量超界从最旧冷却端驱逐（钉住件与写盘在途件豁免——数据未落盘不许丢）
    let budgetGap = coldUnits + units - COLD_CACHE_BUDGET_UNITS;
    let countGap = coldLru.size + 1 - COLD_CACHE_MAX_MODELS;
    if (budgetGap > 0 || countGap > 0) {
      for (const victimPath of [...coldLru.keys()]) {
        if (budgetGap <= 0 && countGap <= 0) break;
        const victim = pool.get(victimPath);
        if (!victim || victim.coldPinned || victim.coldWriteInflight) continue;
        destroyRecord(victimPath, victim);
        budgetGap -= victim.units;
        countGap -= 1;
      }
    }
    if (budgetGap > 0 || countGap > 0) {
      // 可驱逐的都赶完了还放不下（钉住件占满）：缓存收益让位数据安全，新件不进
      destroyRecord(path, rec);
      return;
    }
    rec.units = units; // 转档时点以现值入账（编辑漂移后的准确码元数）
    coldLru.delete(path);
    coldLru.set(path, true);
    coldUnits += units;
    rec.cold = true;
    attachColdListener(path, rec);
  };

  /** 活动正文合计的跨阈可见性（上行报一次，回落静默复位——铁律 4：不静默，也不刷屏） */
  const checkActiveWarn = (): void => {
    const above = activeUnits > ACTIVE_POOL_WARN_UNITS;
    if (above === warnAboveActive) return;
    warnAboveActive = above;
    if (above) {
      warn(`开着的标签正文合计 ${activeUnits.toLocaleString('en-US')} 码元（告警阈 ${ACTIVE_POOL_WARN_UNITS.toLocaleString('en-US')}）——内存随开着的标签单调上涨，考虑关闭暂不编辑的大文件（读数面：editorModelPool.stats()）`);
    }
  };

  /**
   * `file.changed` ⇒ 冷档同路文件立即弃档（PS-12 安全闸③）：盘面真相变了，缓存里的
   * 那份就是旧的——弃档让重开必读盘，与改前"关着的文件重开读盘"逐字同语义。
   * 订阅挂在**首个带 bus 的 acquire** 上（幂等一次）：冷档的"盘变可弃"是正确性前提，
   * 没挂上订阅（纯逻辑测试 / 无 bus 环境）就不开冷档。
   */
  const bindFileChanges = (kernel: Kernel): void => {
    if (fileChangesBound || !kernel.bus) return;
    fileChangesBound = true;
    kernel.bus.on('file.changed', (ev) => {
      if (coldLru.size === 0) return;
      const want = pathKey(ev.path);
      for (const coldPath of [...coldLru.keys()]) {
        if (pathKey(coldPath) !== want) continue;
        const rec = pool.get(coldPath);
        if (rec) destroyRecord(coldPath, rec);
      }
    });
  };

  return {
    async acquire(kernel, path, opts) {
      const rec = recordOf(path);
      rec.kernel = kernel; // PS-12：最近一次 acquire 的 kernel（冷档补写盘用；app 级单例随会话存续）
      bindFileChanges(kernel);
      // 恢复件特例优先于一切：只要调用方带了恢复内容且 model 还没建，就以恢复内容建
      // （model 已在池里 = 已在别处打开，恢复注入不再适用——快照语义本就是"重启后第一次"）。
      // **基线钉 0 落在建 model 的这一刻、落在池记录上**：恢复件的"未保存脏"不许依赖调用方
      // 局部变量撑过 await——切换 effect 的提交闸（cancelled 判）在 await 之后，重跑时局部
      // `recovered` 可能已是 null，届时若基线仍待调用方后补，恢复内容就会被当"干净"吞掉。
      if (!rec.entry && !rec.loading && opts?.text !== undefined) {
        const model = deps.createModel(path, opts.text);
        const entry: PooledModelEntry = {
          model,
          encoding: opts.encoding ?? 'utf-8',
          eol: (opts.eol ?? 'LF').toUpperCase(),
          fromRecovery: true,
        };
        rec.entry = entry;
        rec.baseline = 0;
        rec.refs += 1;
        rec.units = opts.text.length;
        activeUnits += rec.units;
        checkActiveWarn();
        return entry;
      }
      if (rec.entry) {
        rec.refs += 1;
        if (rec.cold) {
          // PS-12 冷档复活：refs>0 自动出档（冷档定义 = refs===0 的驻留件），重开零读盘
          coldLru.delete(path);
          coldUnits -= rec.units;
          rec.cold = false;
        }
        activeUnits += rec.units;
        checkActiveWarn();
        return rec.entry;
      }
      if (!rec.loading) {
        rec.loading = (async () => {
          const fromRecovery = opts?.text !== undefined;
          const tf = opts?.text !== undefined
            ? { text: opts.text, encoding: opts.encoding ?? 'utf-8', eol: opts.eol ?? 'LF' }
            : await deps.readText(kernel, path);
          const model = deps.createModel(path, tf.text);
          // 读盘得来的那份文本就是"与磁盘对齐的 base"；恢复件不是（它是未保存的初稿）
          return {
            entry: { model, encoding: tf.encoding, eol: tf.eol.toUpperCase(), fromRecovery } satisfies PooledModelEntry,
            diskText: fromRecovery ? undefined : tf.text,
            units: tf.text.length,
          };
        })();
      }
      const loading = rec.loading;
      rec.pending += 1;
      // settle 走 then-配对而非 try/await：让"等待者销账（pending −1）+ 引用挂账（refs +1）"
      // 在**同一个续体**内完成，先于任何调用方续体（cancelled ⇒ release）执行 ⇒
      // release 永远拆不掉"还有等待者正在 attach"的记录。
      const settled = await loading.then(
        (value) => ({ ok: true as const, value }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const cur = pool.get(path);
      if (cur) cur.pending -= 1;
      if (!settled.ok) {
        // 失败不悬挂：清掉本次 loading；引用与等待者都归零则整条回收（下次 acquire 重来）
        if (cur && cur.loading === loading) cur.loading = undefined;
        if (!cur || (cur.refs === 0 && cur.pending === 0)) {
          if (cur) destroyRecord(path, cur);
          else pool.delete(path);
        }
        throw settled.err;
      }
      // 等待期间 pending 计数钉住记录不被回收 ⇒ cur 必在；共担同一 loading 的
      // 等待者写入的是同一个 entry（幂等）。
      const target = cur ?? recordOf(path);
      if (!target.entry) {
        target.entry = settled.value.entry;
        target.units = settled.value.units;
      }
      if (target.savedBase === undefined && settled.value.diskText !== undefined) {
        storeBase(path, settled.value.diskText);
      }
      target.refs += 1;
      activeUnits += target.units;
      checkActiveWarn();
      return target.entry;
    },

    release(path) {
      const rec = pool.get(path);
      if (!rec || rec.refs === 0) return 0;
      rec.refs -= 1;
      if (rec.refs === 0 && rec.pending > 0) {
        // model 还没真正 dispose（有等待中的 acquire 即将 attach）⇒ 对外视同仍有引用，
        // 调用方别做"最后一份引用"的终局清理（清 problems / 报不脏）。
        return 1;
      }
      if (rec.refs === 0) {
        activeUnits -= rec.units; // 活动销账（观测面；冷档/终局面在 maybeColdOrDispose 里各自记账）
        checkActiveWarn();
        maybeColdOrDispose(path, rec); // PS-12：干净件转有界冷档，其余走终局销毁（对外语义零变化）
      }
      return rec.refs;
    },

    refCount(path) {
      return pool.get(path)?.refs ?? 0;
    },

    baseline(path) {
      return pool.get(path)?.baseline;
    },

    setBaseline(path, version) {
      const rec = pool.get(path);
      if (rec) rec.baseline = version;
    },

    savedBase(path) {
      const text = pool.get(path)?.savedBase;
      // 读到即 touch：正在用的文件不该被预算先淘汰（淘汰的代价是那一份退回两方判定）
      if (text !== undefined) {
        baseLru.delete(path);
        baseLru.set(path, true);
      }
      return text;
    },

    setSavedBase(path, text) {
      storeBase(path, text);
    },

    stats() {
      let activeModels = 0;
      for (const rec of pool.values()) if (rec.refs > 0) activeModels += 1;
      return {
        activeModels,
        activeUnits,
        coldModels: coldLru.size,
        coldUnits,
        savedBaseUnits: baseUnits,
      };
    },

    liveModel(path) {
      // 池量级 = 活动标签 + 冷档（个位到几十），线性扫可忽略；判等口径与
      // `pickModelByPathKey`（替换执行器）同一条 `pathKey`，两处不会各写一把尺子
      const want = pathKey(path);
      for (const [p, rec] of pool) {
        if (rec.refs > 0 && rec.entry && pathKey(p) === want) return rec.entry.model;
      }
      return undefined;
    },

    retargetLanguage(path, resolve) {
      if (deps.setModelLanguage === undefined) return 0;
      const want = pathKey(path);
      let changed = 0;
      for (const [recordPath, rec] of pool) {
        // 池里每个记录至多一份 model（冷档件也在 rec.entry 上）；同一路径的不同拼写
        // 会各成一条记录——覆盖要落到**全部**份上，否则另一组显示的还是旧语言面
        if (rec.entry === undefined || pathKey(recordPath) !== want) continue;
        const model = rec.entry.model;
        const desired = resolve(model);
        if (desired === model.getLanguageId()) continue; // 幂等：同语言不重挂
        deps.setModelLanguage(model, desired);
        changed += 1;
      }
      return changed;
    },

    retargetPath(from, to) {
      if (from === to) return false;
      const rec = pool.get(from);
      if (rec === undefined) return false; // 池里没有这一格 ⇒ 没东西可搬
      // 落点已站着**活着的**记录（有引用）⇒ 拒绝换键：绝不把别人正编辑的账吞掉
      const occupant = pool.get(to);
      if (occupant !== undefined && occupant.refs > 0) return false;
      // 落点只剩冷档（refs===0 的已关标签旧盘真相）⇒ 先弃档（转档内容才是当下真相）
      if (occupant !== undefined) destroyRecord(to, occupant);
      // 三本账逐条换键：pool 记录本体 + baseLru（基线文本）+ coldLru（冷档驻留）。
      // rec 本体整份搬走（model / refs / baseline / savedBase / units 全跟着走），
      // 撤销栈因此原地续命——这正是"转档"区别于"关标签重开"的地方。
      pool.delete(from);
      pool.set(to, rec);
      if (baseLru.delete(from)) baseLru.set(to, true);
      if (coldLru.delete(from)) {
        coldLru.set(to, true);
        // 冷档补写盘 listener 闭包里钉着旧路径（attachColdListener(path)），换键必须重挂，
        // 否则程序性改写会往**旧路径**补写盘（数据事故）。refs>0 时 cold 恒 false，走不到这里。
        if (rec.cold) {
          rec.coldListener?.dispose();
          rec.coldListener = undefined;
          attachColdListener(to, rec);
        }
      }
      return true;
    },
  };
}
