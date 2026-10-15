import { describe, expect, it } from 'vitest';
import type { InstalledPack, MarketIndex, MarketIndexEntry, MarketIndexState, PackKind } from '@kojo/plugin-api';
import {
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_HINT,
  droppedNotice,
  formatBytes,
  KIND_LABEL,
  matchesQuery,
  refreshNote,
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
    // 能力面说明说清两件事：网络装包没开放 + 本机文件夹装一直在（**作者面口径，不用「本批」这类开发黑话**）
    expect(CAPABILITY_HINT).toContain('从网络直接装包还没有开放');
    expect(CAPABILITY_HINT).toContain('装本机文件夹里的包一直在');
    for (const jargon of ['本批', 'KM', 'endpoint', 'index']) expect(CAPABILITY_HINT, jargon).not.toContain(jargon);
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
  const ok = (packs: MarketIndexEntry[]): MarketIndexState => ({
    state: 'ok',
    index: idx(packs),
    dropped: [],
    fetchedAt: 1_700_000_000_000,
  });

  it('判别联三态各判一个状态，互不混用（三态之外的分支编译期就不存在）', () => {
    expect(resolveStatus({ state: 'absent' })).toBe('list-missing');
    expect(resolveStatus({ state: 'invalid', reason: 'JSON 坏了', detail: 'p' })).toBe('list-broken');
    expect(resolveStatus(ok([]))).toBe('no-packs');
    expect(resolveStatus(ok([entry()]))).toBe('ready');
    // `dropped` 非空但仍有可用条目 ⇒ 照样 ready（丢的那几条由 `droppedNotice` 单独出声）
    const withDropped: MarketIndexState = { state: 'ok', index: idx([entry()]), dropped: ['x: id 不合规'], fetchedAt: null };
    expect(resolveStatus(withDropped)).toBe('ready');
  });

  it('`list-unreadable` 不由判别联产生（它是"读这件事本身抛了"，归取数层的 catch）', () => {
    const all: MarketIndexState[] = [{ state: 'absent' }, { state: 'invalid', reason: 'r' }, ok([]), ok([entry()])];
    for (const s of all) {
      expect(resolveStatus(s)).not.toBe('list-unreadable');
    }
  });

  it('invalid 的人话与机器细节都进状态行（不许只剩一句"读不出"）', () => {
    expect(statusText(resolveStatus({ state: 'invalid', reason: 'schema 不受支持' }), 'schema 不受支持')).toContain(
      'schema 不受支持',
    );
  });

  it('refreshNote 覆盖刷新的三个态（cached 不许演成"刚拉过"）', () => {
    expect(refreshNote({ state: 'refreshed', index: ok([entry()]), fetchedAt: 1 })).toContain('1 个包');
    expect(refreshNote({ state: 'refreshed', index: { state: 'absent' }, fetchedAt: 1 })).toContain('读不出内容');
    expect(refreshNote({ state: 'cached', index: ok([]), fetchedAt: 1_700_000_000_000 })).toContain('没有回源');
    const failed = refreshNote({ state: 'failed', reason: '域名不在允许清单', index: ok([entry()]) });
    expect(failed).toContain('还是本机已有的那份');
    expect(refreshNote({ state: 'failed', reason: 'r', index: { state: 'absent' } })).toContain('还没有可用的列表');
  });

  it('dropped 非空必须出声，一条没丢不占行', () => {
    expect(droppedNotice([])).toBe('');
    const line = droppedNotice(['a.pack: id 不合规', 'b.pack: id-kind-conflict（同名挂在多个种类下）']);
    expect(line).toContain('2 条');
    expect(line).toContain('a.pack: id 不合规');
    expect(line).toContain('b.pack');
    // 只列前三条，其余以省略号收（长列表不许把面板顶出屏）
    expect(droppedNotice(['1', '2', '3', '4', '5'])).toContain('……');
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
