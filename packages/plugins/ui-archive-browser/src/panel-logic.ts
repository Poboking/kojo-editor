/**
 * 归档浏览器纯逻辑（零 React；可单测）。
 *
 * - `buildArchiveList`：把 `snapshot.source` 的扫描结果规约为可渲染行 + **显式降级原因**
 *   （无项目 / 无归档目录 / 未发现归档 / 扫描失败——一律不静默）；
 * - `summarizeCharacters`：角色区摘要（前 N 个角色名 + 总数；**绝不全量渲染**）；
 * - `formatBytes` / `formatTimestamp` / `summarizeText`：展示格式化。
 *
 * 术语：archive（归档）统称；本模块不出现任何游戏名词。
 */

import type {
  ArchiveCharacterBlock,
  CharaInfo,
  GameProject,
  SnapshotArchiveEntry,
  SnapshotScanResult,
} from '@kojo/plugin-api';

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

/** 字节数人类可读（B / KB / MB / GB；非法输入 → '—'） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]!}`;
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