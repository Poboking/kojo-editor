/**
 * 归档浏览器纯逻辑（零 React；可单测）。
 *
 * - `buildArchiveList`：把归档读取单源（`archive.reader`）的扫描结果规约为可渲染行 +
 *   **显式降级原因**（无项目 / 无归档目录 / 未发现归档 / 扫描失败——一律不静默）；
 * - `summarizeCharacters`：角色区摘要（前 N 个角色名 + 总数；**绝不全量渲染**）；
 * - `formatTimestamp` / `summarizeText`：展示格式化。
 *
 * **W13 收口**：字节格式化（`formatBytes`）与条目路径解析（`archiveEntryLabel` /
 * `archiveEntryFileName`）**不在本模块**——它们只住在契约 `plugin-api/archive.ts` 一处，
 * 本模块只是引用者（面板自写一份 = 与内核 paths 通道并存的第二判据）。
 *
 * 术语：archive（归档）统称；本模块不出现任何游戏名词。
 */

import type {
  ArchiveCharacterBlock,
  ArchiveExtractOutcome,
  ArchiveExtractRequest,
  CharaInfo,
  GameProject,
  SnapshotArchiveEntry,
  SnapshotScanResult,
} from '@kojo/plugin-api';
import { formatBytes } from '@kojo/plugin-api';

/** 备注摘要长度上限（档位列表一行内可读） */
export const SAVE_MES_MAX = 40;

/** 单档呈现行 */
export interface ArchiveRow {
  path: string;
  fileName: string;
  /** 原始备注（悬停显示完整内容） */
  saveMes: string;
  /** 备注摘要（折叠空白 + 截断） */
  saveMesSummary: string;
  charCount: number;
  size: number;
  sizeText: string;
  mtimeMs: number | null;
  mtimeText: string;
  /** 浅解析失败（原因见 error） */
  failed: boolean;
  error?: string;
}

/** 列表降级原因（显式呈现，不静默） */
export type ArchiveListDegrade = 'no-project' | 'scan-error' | 'scanning' | 'no-dir' | 'empty';

export interface ArchiveListResult {
  /** 浅解析成功的档位（按文件名排序） */
  rows: ArchiveRow[];
  /** 浅解析失败的档位（不中断其余档，不静默） */
  failed: ArchiveRow[];
  /** 降级原因；null = 正常呈现 */
  degrade: ArchiveListDegrade | null;
  detail?: string;
}

function byFileName(a: ArchiveRow, b: ArchiveRow): number {
  return a.fileName.localeCompare(b.fileName);
}

function toRow(entry: SnapshotArchiveEntry): ArchiveRow {
  const meta = entry.meta;
  const saveMes = meta?.saveMes ?? '';
  const row: ArchiveRow = {
    path: entry.path,
    fileName: entry.fileName,
    saveMes,
    saveMesSummary: summarizeText(saveMes, SAVE_MES_MAX),
    charCount: meta?.charCount ?? 0,
    size: entry.size,
    sizeText: formatBytes(entry.size),
    mtimeMs: entry.mtimeMs,
    mtimeText: formatTimestamp(entry.mtimeMs),
    failed: entry.error !== undefined,
  };
  if (entry.error !== undefined) row.error = entry.error;
  return row;
}

/**
 * 把扫描结果规约为渲染列表。
 *
 * 降级优先级：无项目 > 扫描失败 > 扫描中 > 无归档目录 > 未发现归档。
 */
export function buildArchiveList(opts: {
  project: GameProject | null;
  scanning: boolean;
  scan: SnapshotScanResult | null;
  scanError?: string | null;
}): ArchiveListResult {
  const { project, scanning, scan, scanError } = opts;
  if (!project) return { rows: [], failed: [], degrade: 'no-project' };
  if (scanError) return { rows: [], failed: [], degrade: 'scan-error', detail: scanError };
  if (scanning || !scan) return { rows: [], failed: [], degrade: 'scanning' };

  // 该项目的快照来源没有归档目录（适配器未提供 savDir）——显式呈现
  if (scan.dir === '') return { rows: [], failed: [], degrade: 'no-dir' };

  const rows: ArchiveRow[] = [];
  const failed: ArchiveRow[] = [];
  for (const entry of scan.entries) {
    const row = toRow(entry);
    if (row.failed) failed.push(row);
    else rows.push(row);
  }
  rows.sort(byFileName);
  failed.sort(byFileName);

  if (rows.length === 0 && failed.length === 0) return { rows, failed, degrade: 'empty' };
  return { rows, failed, degrade: null };
}

/** 时间戳（本地时区 YYYY-MM-DD HH:mm；缺省 → '—'） */
export function formatTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 折叠空白 + 截断（超长加省略号；非正上限 → 仅省略号） */
export function summarizeText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  if (max <= 0) return '…';
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 角色区摘要（渲染上限：前 N 个角色名 + 总数） */
export interface CharacterSummary {
  /** 前 `cap` 个角色显示名（`K{no} 名字` 形态） */
  names: string[];
  /** 实际列出数 */
  shown: number;
  /** 角色块总数 */
  total: number;
}

/**
 * 角色区摘要：仅取前 `cap` 个角色块的名字 + 总数（168 块全量渲染会拖垮 DOM）。
 * 名字优先取块内 `NAME` 标量，缺失时回落项目角色字典（按块内 `NO` 匹配）。
 */
export function summarizeCharacters(
  chars: readonly ArchiveCharacterBlock[] | undefined,
  charaIndex: ReadonlyMap<number, CharaInfo>,
  cap: number,
): CharacterSummary {
  const all = chars ?? [];
  const names: string[] = [];
  if (cap > 0) {
    for (const block of all) {
      if (names.length >= cap) break;
      const noVar = block.vars.find((v) => v.key === 'NO');
      const no = noVar && noVar.type === 'int' && typeof noVar.value === 'number' ? noVar.value : null;
      const nameVar = block.vars.find((v) => v.key === 'NAME');
      const blockName = nameVar && nameVar.type === 'str' && typeof nameVar.value === 'string' ? nameVar.value : '';
      const label = blockName.length > 0 ? blockName : (no !== null ? charaIndex.get(no)?.name : undefined) ?? '';
      if (no !== null) names.push(`K${no} ${label}`.trim());
      else names.push(label.length > 0 ? label : `#${block.index}`);
    }
  }
  return { names, shown: names.length, total: all.length };
}

/* --------------------------- 取出意图（落盘的唯一出口） --------------------------- */

/** 两种合法落点的按钮文案（一份口径，面板与测试同引这里） */
export const EXTRACT_LABELS: Record<'workspace' | 'dialog', string> = {
  workspace: '取出到工作区',
  dialog: '另存为…',
};

/**
 * 面板侧的取出意图 → 契约请求。
 *
 * **刻意只产出 `kind` + `entryPath` 两个字段**：这里没有、也不许有"目标目录"这一项
 * （架构铁律 6：新增"写到域外"的能力不得开放任意目标路径参数）。落点由
 * 归档读取单源（`archive.reader`）按契约规则决定——工作区固定子目录，或系统对话框。
 * 单独成函数就是为了这条形状可被零 React 单测钉死（面板是 `createElement`，
 * 本包 devDeps 只有 react 没有 react-dom，点不了按钮；先例见 ui-sugar-editor 的
 * `new-file-flow` 测试头注）。
 */
export function extractRequest(entryPath: string, kind: 'workspace' | 'dialog'): ArchiveExtractRequest {
  return kind === 'workspace' ? { kind: 'workspace', entryPath } : { kind: 'dialog', entryPath };
}

/**
 * 取出结果的一行人话（落点 / 字节 / 取消三种形态都在这里，别在组件里再拼一份）。
 * 字节格式化引用契约那份 `formatBytes`。
 */
export function extractOutcomeText(outcome: ArchiveExtractOutcome): string {
  if (outcome.cancelled) return '已取消（未写任何字节）';
  return `已取出 ${formatBytes(outcome.bytes)} → ${outcome.landing}`;
}