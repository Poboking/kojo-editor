import { describe, expect, it } from 'vitest';
import type { InstalledPack, MarketIndex, MarketIndexEntry, PackKind } from '@kojo/plugin-api';
import {
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_HINT,
  formatBytes,
  KIND_LABEL,
  matchesQuery,
  resolveStatus,
  STATUS_TEXT,
  statusText,
} from '../src/market-view';

const hex = (c: string): string => c.repeat(64);

const entry = (over: Partial<MarketIndexEntry> = {}): MarketIndexEntry => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version: '1.0.0',
  name: '演示口上包',
  author: '某人',
  license: 'CC-BY-NC 4.0',
  minAppVersion: '0.4.0',
  zip: { url: 'https://example.test/demo.zip', sha256: hex('a'), bytes: 1004 },
  fileCount: 3,
  unpackedBytes: 2048,
  ...over,
});

const rec = (over: Partial<InstalledPack> = {}): InstalledPack => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version: '1.0.0',
  name: '演示口上包',
  author: '某人',
  license: 'CC-BY-NC 4.0',
  contentDigest: hex('b'),
  installedAt: 1_700_000_000_000,
  files: [],
  ...over,
});

describe('种类与文案', () => {
  it('三值都有人读名（主行只准出现这些词）', () => {
    expect(KIND_LABEL).toMatchObject({ 'kojo-pack': '口上包', 'dict-pack': '字典包', 'template-pack': '模板包' });
  });

  it('每条显式态都是一句人话，且不含机器词', () => {
    const banned = ['kind', 'id', 'manifest', 'index.json', 'sha256', 'schema', 'minAppVersion'];
    for (const [status, text] of Object.entries(STATUS_TEXT)) {
      expect(text, status).not.toBe('');
      expect(text.length, status).toBeGreaterThan(8);
      for (const w of banned) expect(`${status}:${text}`, w).not.toContain(w);
    }
    expect(statusText('ready')).toBe('');
    expect(CAPABILITY_HINT).toContain('本批');
  });

  it('版本要求说成「这个包要求编辑器不低于 x.y.z」', () => {
    expect(appVersionRequirement('0.4.0')).toBe('这个包要求编辑器不低于 0.4.0');
  });

  it('体积格式化（B / KB / MB），坏值给破折号而不是 NaN', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(709)).toBe('709 B');
    expect(formatBytes(1051)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('显式态判定', () => {
  const idx = (packs: MarketIndexEntry[]): MarketIndex => ({
    schema: 1,
    generatedAt: '2026-10-15T00:00:00Z',
    packs,
  });

  it('四条各判一个状态，互不混用', () => {
    expect(resolveStatus({ probe: 'absent', index: null })).toBe('list-missing');
    expect(resolveStatus({ probe: 'unreadable', index: null })).toBe('list-unreadable');
    expect(resolveStatus({ probe: 'present', index: null })).toBe('list-broken');
    expect(resolveStatus({ probe: 'present', index: idx([]) })).toBe('no-packs');
    expect(resolveStatus({ probe: 'present', index: idx([entry()]) })).toBe('ready');
  });
});

describe('索引分组与过滤', () => {
  const packs = [
    entry({ kind: 'dict-pack', id: 'demo.dict', name: '演示字典', author: 'B' }),
    entry({ kind: 'kojo-pack', id: 'a.pack', name: '乙包', author: 'X' }),
    entry({ kind: 'kojo-pack', id: 'b.pack', name: '甲包', author: 'Y' }),
    entry({ kind: 'template-pack', id: 't.pack', name: '模板', author: 'Z', minAppVersion: '9.9.9' }),
  ];
  const kindsOf = (gs: ReturnType<typeof buildGroups>): PackKind[] => gs.map((g) => g.kind);

  it('按契约的种类顺序分组，组内按包名排；空组不占位', () => {
    const gs = buildGroups(packs, '0.4.0-beta.1', '', new Set());
    expect(kindsOf(gs)).toEqual(['kojo-pack', 'dict-pack', 'template-pack']);
    expect(gs[0]!.rows.map((r) => r.entry.name)).toEqual(['乙包', '甲包'].sort((a, b) => a.localeCompare(b)));
    expect(gs[0]!.label).toBe('口上包');
  });

  it('过滤命中名称或作者（大小写不敏感），全不中 ⇒ 零组', () => {
    expect(kindsOf(buildGroups(packs, '0.4.0-beta.1', '某人', new Set()))).toEqual([]);
    expect(buildGroups(packs, '0.4.0-beta.1', '演示', new Set()).flatMap((g) => g.rows).map((r) => r.entry.id)).toEqual([
      'demo.dict',
    ]);
    expect(buildGroups(packs, '0.4.0-beta.1', '甲', new Set()).flatMap((g) => g.rows)[0]!.entry.id).toBe('b.pack');
    expect(buildGroups(packs, '0.4.0-beta.1', '作者z', new Set())).toEqual([]);
    expect(matchesQuery(entry({ author: 'Someone' }), 'SOMEONE')).toBe(true);
  });

  it('minAppVersion 高于本机 ⇒ appOk=false（主行给一句人话），够装 ⇒ true；预发布按核心三段算', () => {
    const gs = buildGroups(packs, '0.4.0-beta.1', '', new Set());
    const templ = gs.find((g) => g.kind === 'template-pack')!.rows[0]!;
    expect(templ.appOk).toBe(false);
    expect(gs.find((g) => g.kind === 'kojo-pack')!.rows.every((r) => r.appOk)).toBe(true);
  });

  it('已装的那一条打上标记（按 kind/id/version 三元组，不看目录）', () => {
    const key = 'kojo-pack/b.pack@1.0.0';
    const gs = buildGroups(packs, '0.4.0', '', new Set([key]));
    const marked = gs.flatMap((g) => g.rows).filter((r) => r.installed);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.entry.id).toBe('b.pack');
  });
});

describe('已装列表', () => {
  it('核对码取 contentDigest 前 8 位（只在展开层用），来源按有无容器摘要说人话', () => {
    const rows = buildInstalledRows([rec(), rec({ kind: 'dict-pack', id: 'd', name: '字典', containerSha256: hex('c') })]);
    expect(rows[0]!.digestPrefix).toBe('b'.repeat(8));
    expect(rows[0]!.digestPrefix).toHaveLength(8);
    expect(rows[0]!.sourceLabel).toBe('本机文件夹');
    expect(rows[1]!.sourceLabel).toBe('压缩包');
    expect(rows.map((r) => r.kindLabel)).toEqual(['口上包', '字典包']);
  });

  it('空列表 ⇒ 空数组（由面板给一句"本机还没有装好的包"）', () => {
    expect(buildInstalledRows([])).toEqual([]);
  });
});
