import type { EolStyle } from './io';
import type { FileEncoding } from './platform';

/**
 * 批操作 journal 契约（内核 `kernel.ops`；2026-10-16 undo 批，additive）。
 *
 * 定位：磁盘侧批操作（脚手架多文件落盘 / `.kojo` 保存的双文件批 / 快照注入）此前
 * 只有"写前单文件备份"事后救，中途失败留半批态。本契约提供 `begin / record /
 * commit / abort` 的**操作级**记录与回滚：
 * - `record` 在**写之前**调用，由实现抓取该文件当前盘上字节快照（保真零转码）；
 * - `abort` 逆序回滚全部已记录条目（恢复 before / 删除操作内新建的文件）；
 * - `commit` 之后该操作进入历史（`list`/`entriesOf`/`undo`），撤销本身也进历史
 *   （`undo:<原kind>`），对已撤销的操作再撤销即重做。
 *
 * 落点 `{appData}/ops/`（内容快照可能很大，不走 KV storage）；
 * 快照与元数据都是内核 io 自有管理域，**不受写允许域约束**（与写前备份同先例）；
 * 但 `undo` 写回用户文件**必过**内核 io 写闸（`writeBytes`/`removeFile`）。
 *
 * 旧内核没有本服务键：消费方一律 `tryInject` / `optionalRequires`，缺席时降级为
 * 各自的原有行为（半批态用调用方自有快照兜底），零硬依赖。
 */
export interface OpJournal {
  /** 开始一个批操作，返回 opId（后续 record/commit/abort 用） */
  begin(kind: string, label: string): Promise<string>;
  /**
   * 记录"将要覆盖 path"：实现在此刻抓取盘上字节快照（文件不存在 = 操作内新建，before=null）。
   * **必须在写入之前调用**；同一 op 内同一路径（大小写/分隔符折叠后）重复 record 以第一次为准
   * （undo 恢复的是"操作开始前"的状态，不是中间态）。
   */
  record(opId: string, path: string): Promise<void>;
  /** 批操作成功收尾；此后该操作进入历史、可被 undo */
  commit(opId: string): Promise<void>;
  /**
   * 批操作失败收尾：**逆序回滚**全部已记录条目，然后该操作不留痕。
   * 回滚自身失败不吞（上抛合并进调用方的错误呈现）——半批态宁可吵不可静默。
   */
  abort(opId: string): Promise<void>;
  /** 已提交的操作历史（新在前）。进行中 / 崩溃残留的 open 态不列（entries 可能不完整） */
  list(): Promise<OpRecord[]>;
  /** 某操作涉及的文件清单（UI 展开行用；opId 必须是历史里的操作） */
  entriesOf(opId: string): Promise<OpEntryView[]>;
  /**
   * 撤销一个历史操作：恢复 before 字节 / 删除操作内新建的文件；返回撤销操作的 opId
   * （kind=`undo:<原kind>`，对它再 undo 即重做）。回滚不做三方合并——journal 是
   * "操作时刻"的字节快照，磁盘侧回滚整段回、不猜测性合并。
   */
  undo(opId: string): Promise<string>;
}

/** 历史列表条目（展示面） */
export interface OpRecord {
  id: string;
  /** 操作类别（'scaffold' / 'sugar-save' / 'snapshot-inject' / 'undo:<kind>' …；提供方自定义） */
  kind: string;
  /** 人读标签（UI 直接呈现） */
  label: string;
  startedAt: number;
  finishedAt: number | null;
  /** committed = 可撤销；undone = 已被撤销（其 undo op 可再撤销 = 重做） */
  status: 'committed' | 'undone';
  /** 涉及文件数 */
  fileCount: number;
}

/** 操作内的单文件视图（字节快照住 ops 目录，不跨契约） */
export interface OpEntryView {
  path: string;
  /** false = 该操作新建的文件（撤销时删除而非恢复） */
  hasBefore: boolean;
  /** 快照时刻探测出的编码 / 换行（展示面；回滚按字节恢复，不依赖这两项） */
  encoding: FileEncoding | null;
  eol: EolStyle | null;
}
