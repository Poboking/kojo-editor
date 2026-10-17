/**
 * 归档浏览器纯逻辑单测（v0.2 第十三批；零 React）。
 *
 * 覆盖：列表规约全路径（正常 / 部分失败 / 全失败）+ 降级路径
 * （无项目 / 扫描失败 / 扫描中 / 无归档目录 / 未发现归档）+ 展示格式化
 * （字节 / 时间戳 / 摘要）+ 角色区摘要（上限 / 名字回落 / 空档）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ArchiveCharacterBlock,
  ArchiveMeta,
  CharaInfo,
  GameProject,
  SnapshotArchiveEntry,
  SnapshotScanResult,
} from '@kojo/plugin-api';
import { formatBytes } from '@kojo/plugin-api';
import {
  buildArchiveList,
  formatTimestamp,
  summarizeCharacters,
  summarizeText,
} from '../src/panel-logic';

const META: ArchiveMeta = {
  path: 'D:/Game/dir/save03.sav',
  fileName: 'save03.sav',
  size: 571_185,
  format: 'gzip',
  version: 1808,
  fileType: 'normal',
  uniqueCode: '1',
  gameVersion: '2',
  saveMes: '第 47日 古明地觉',
  charCount: 168,
  decompressedSize: 1_600_000,
};

function entry(fileName: string, over: Partial<SnapshotArchiveEntry> = {}): SnapshotArchiveEntry {
  return {
    path: `D:/Game/dir/${fileName}`,
    fileName,
    size: 571_185,
    mtimeMs: 1_700_000_000_000,
    meta: { ...META, path: `D:/Game/dir/${fileName}`, fileName },
    ...over,
  };
}

function scanOf(entries: SnapshotArchiveEntry[], dir = 'D:/Game/dir'): SnapshotScanResult {
  return { dir, entries, scannedAt: 0, durationMs: 12 };
}

const PROJECT: GameProject = {
  rootDir: 'D:/Game',
  adapterId: 'demo',
  kojoPaths: [],
  savDir: 'D:/Game/dir',
  writablePaths: [],
  charaIndex: new Map<number, CharaInfo>(),
};

describe('formatBytes', () => {
  it('B / KB / MB / GB 分级', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(571_185)).toBe('557.8 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
  it('非法输入 → 占位符', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatTimestamp', () => {
  it('null / 非法 → 占位符', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(Number.NaN)).toBe('—');
  });
  it('有效时间戳 → 本地 YYYY-MM-DD HH:mm', () => {
    expect(formatTimestamp(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('summarizeText', () => {
  it('折叠空白 + 截断', () => {
    expect(summarizeText('  第 47日\n 古明地觉 ', 40)).toBe('第 47日 古明地觉');
    expect(summarizeText('abcdefghij', 4)).toBe('abcd…');
    expect(summarizeText('', 40)).toBe('');
  });
  it('非正上限 → 仅省略号（空文本仍为空）', () => {
    expect(summarizeText('abc', 0)).toBe('…');
    expect(summarizeText('   ', 0)).toBe('');
  });
});

describe('buildArchiveList', () => {
  it('无项目 → no-project', () => {
    const r = buildArchiveList({ project: null, scanning: false, scan: null });
    expect(r.degrade).toBe('no-project');
    expect(r.rows).toEqual([]);
  });

  it('扫描失败 → scan-error（含原因）', () => {
    const r = buildArchiveList({ project: PROJECT, scanning: false, scan: null, scanError: 'EACCES' });
    expect(r).toMatchObject({ degrade: 'scan-error', detail: 'EACCES', rows: [] });
  });

  it('扫描中 / 无结果 → scanning', () => {
    expect(buildArchiveList({ project: PROJECT, scanning: true, scan: null }).degrade).toBe('scanning');
    expect(buildArchiveList({ project: PROJECT, scanning: false, scan: null }).degrade).toBe('scanning');
  });

  it('无归档目录（dir 为空串）→ no-dir', () => {
    const r = buildArchiveList({ project: PROJECT, scanning: false, scan: scanOf([], '') });
    expect(r).toMatchObject({ degrade: 'no-dir', rows: [], failed: [] });
  });

  it('有目录但无档位 → empty', () => {
    expect(buildArchiveList({ project: PROJECT, scanning: false, scan: scanOf([]) }).degrade).toBe('empty');
  });

  it('正常列表：行字段完整 + 按文件名排序 + 备注摘要', () => {
    const r = buildArchiveList({
      project: PROJECT,
      scanning: false,
      scan: scanOf([entry('save03.sav'), entry('global.sav', { meta: { ...META, fileName: 'global.sav', fileType: 'global', charCount: 0, saveMes: '' } })]),
    });
    expect(r.degrade).toBeNull();
    expect(r.rows.map((x) => x.fileName)).toEqual(['global.sav', 'save03.sav']);
    const s3 = r.rows[1]!;
    expect(s3).toMatchObject({
      charCount: 168,
      size: 571_185,
      sizeText: '557.8 KB',
      mtimeMs: 1_700_000_000_000,
      saveMes: '第 47日 古明地觉',
      saveMesSummary: '第 47日 古明地觉',
      failed: false,
    });
    expect(s3.mtimeText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(r.rows[0]!.charCount).toBe(0);
  });

  it('长备注折叠为摘要（保完整原文）', () => {
    const long = 'A'.repeat(60);
    const r = buildArchiveList({
      project: PROJECT,
      scanning: false,
      scan: scanOf([entry('save01.sav', { meta: { ...META, fileName: 'save01.sav', saveMes: long } })]),
    });
    expect(r.rows[0]!.saveMes).toBe(long);
    expect(r.rows[0]!.saveMesSummary).toBe(`${'A'.repeat(40)}…`);
  });

  it('单档失败 → 进 failed 不中断其余档（meta 为 null）', () => {
    const r = buildArchiveList({
      project: PROJECT,
      scanning: false,
      scan: scanOf([entry('good.sav'), entry('bad.sav', { meta: null, error: '不支持的二进制格式版本 999' })]),
    });
    expect(r.degrade).toBeNull();
    expect(r.rows.map((x) => x.fileName)).toEqual(['good.sav']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ fileName: 'bad.sav', failed: true, error: '不支持的二进制格式版本 999', saveMes: '', charCount: 0 });
  });

  it('全部失败 → rows 空但 degrade 为 null（失败档显式呈现）', () => {
    const r = buildArchiveList({
      project: PROJECT,
      scanning: false,
      scan: scanOf([entry('bad.sav', { meta: null, error: 'boom' })]),
    });
    expect(r.degrade).toBeNull();
    expect(r.rows).toEqual([]);
    expect(r.failed).toHaveLength(1);
  });

  it('mtime 缺失 → 占位符', () => {
    const r = buildArchiveList({ project: PROJECT, scanning: false, scan: scanOf([entry('a.sav', { mtimeMs: null })]) });
    expect(r.rows[0]!.mtimeText).toBe('—');
  });
});

describe('summarizeCharacters', () => {
  const block = (index: number, vars: ArchiveCharacterBlock['vars']): ArchiveCharacterBlock => ({ index, vars, dimSepIndex: null });
  const no = (v: number): ArchiveCharacterBlock['vars'][number] => ({ type: 'int', key: 'NO', value: v, offset: 0 });
  const name = (v: string): ArchiveCharacterBlock['vars'][number] => ({ type: 'str', key: 'NAME', value: v, offset: 0 });

  const charaIndex = new Map<number, CharaInfo>([
    [1, { no: 1, name: '博丽灵梦' }],
    [49, { no: 49, name: '古明地觉' }],
  ]);

  it('上限截断 + 总数准确（不全量渲染）', () => {
    const chars = Array.from({ length: 30 }, (_, i) => block(i, [no(i + 1), name(`角色${i + 1}`)]));
    const s = summarizeCharacters(chars, charaIndex, 12);
    expect(s.shown).toBe(12);
    expect(s.total).toBe(30);
    expect(s.names[0]).toBe('K1 角色1');
    expect(s.names[11]).toBe('K12 角色12');
  });

  it('块内 NAME 缺失 → 回落项目角色字典', () => {
    const s = summarizeCharacters([block(0, [no(49)]), block(1, [no(1), name('')])], charaIndex, 12);
    expect(s.names).toEqual(['K49 古明地觉', 'K1 博丽灵梦']);
  });

  it('无名无名 → NO 占位；无 NO → 块序号占位', () => {
    const s = summarizeCharacters([block(7, [no(99)]), block(9, [name('')])], charaIndex, 12);
    expect(s.names).toEqual(['K99', '#9']);
  });

  it('上限为 0 / 无角色区 → 不渲染名字', () => {
    expect(summarizeCharacters([block(0, [no(1), name('x')])], charaIndex, 0)).toEqual({ names: [], shown: 0, total: 1 });
    expect(summarizeCharacters(undefined, charaIndex, 12)).toEqual({ names: [], shown: 0, total: 0 });
  });
});