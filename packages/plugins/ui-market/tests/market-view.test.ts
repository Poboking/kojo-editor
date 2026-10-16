import { describe, expect, it } from 'vitest';
import {
  MarketError,
  packUpdateCheck,
  type InstalledPack,
  type MarketIndex,
  type MarketIndexEntry,
  type MarketIndexState,
  type MarketRejectCode,
  type PackKind,
} from '@kojo/plugin-api';
import {
  ACTION_LABEL,
  appVersionRequirement,
  buildGroups,
  buildInstalledRows,
  CAPABILITY_HINT,
  CLEAR_LABEL,
  droppedNotice,
  filterEmptyPhrase,
  formatBytes,
  groupCountPhrase,
  IMPORT_LABEL,
  importFailNote,
  importNote,
  indexRowKey,
  installBusyNote,
  installNote,
  installedCountPhrase,
  KIND_LABEL,
  matchesQuery,
  pendingKey,
  REJECT_TEXT,
  refreshNote,
  rejectNote,
  resolveStatus,
  rowAction,
  STATUS_TEXT,
  statusText,
  updatePhrase,
  type PackRow,
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
    // 能力面说明说清三件事：能浏览列表、**能直接从注册表装**、装不上时该看哪行话
    // （**作者面口径，不用「本批」这类开发黑话**）
    expect(CAPABILITY_HINT).toContain('浏览注册表列表');
    expect(CAPABILITY_HINT).toContain('把注册表上的包装进本机');
    expect(CAPABILITY_HINT).toContain('不是你的包');
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
    const gs = buildGroups(packs, '0.4.0-beta.1', '', []);
    expect(kindsOf(gs)).toEqual(['kojo-pack', 'dict-pack', 'template-pack']);
    expect(gs[0]!.rows.map((r) => r.entry.name)).toEqual(['乙包', '甲包'].sort((a, b) => a.localeCompare(b)));
    expect(gs[0]!.label).toBe('口上包');
  });

  it('过滤命中名称或作者（大小写不敏感），全不中 ⇒ 零组', () => {
    expect(kindsOf(buildGroups(packs, '0.4.0-beta.1', '某人', []))).toEqual([]);
    expect(buildGroups(packs, '0.4.0-beta.1', '演示', []).flatMap((g) => g.rows).map((r) => r.entry.id)).toEqual([
      'demo.dict',
    ]);
    expect(buildGroups(packs, '0.4.0-beta.1', '甲', []).flatMap((g) => g.rows)[0]!.entry.id).toBe('b.pack');
    expect(buildGroups(packs, '0.4.0-beta.1', '作者z', [])).toEqual([]);
    expect(matchesQuery(entry({ author: 'Someone' }), 'SOMEONE')).toBe(true);
  });

  it('minAppVersion 高于本机 ⇒ appOk=false（主行给一句人话），够装 ⇒ true；预发布按核心三段算', () => {
    const gs = buildGroups(packs, '0.4.0-beta.1', '', []);
    const templ = gs.find((g) => g.kind === 'template-pack')!.rows[0]!;
    expect(templ.appOk).toBe(false);
    expect(gs.find((g) => g.kind === 'kojo-pack')!.rows.every((r) => r.appOk)).toBe(true);
  });

  it('已装的那一条打上标记（三态由契约的 packUpdateCheck 从**已装清单**算，面板不再收键集）', () => {
    const gs = buildGroups(packs, '0.4.0', '', [rec({ kind: 'kojo-pack', id: 'b.pack' })]);
    const marked = gs.flatMap((g) => g.rows).filter((r) => r.installed);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.entry.id).toBe('b.pack');
    expect(marked[0]!.update?.state).toBe('latest');
    // 没装过的那几条 ⇒ `update` 为 null（"没装"不是一个态，是「安装」这个动作）
    expect(gs.find((g) => g.kind === 'dict-pack')!.rows[0]!.update).toBeNull();
  });

  it('本机装着同一包的多个版本 ⇒ 行上的标记与动作一律看最高那一版', () => {
    const rows = buildGroups([entry({ id: 'b.pack', version: '1.2.0' })], '0.4.0', '', [
      rec({ id: 'b.pack', version: '1.0.0' }),
      rec({ id: 'b.pack', version: '1.1.0' }),
    ]).flatMap((g) => g.rows);
    expect(rows[0]!.update?.state).toBe('updatable');
    expect(rows[0]!.update?.local.version).toBe('1.1.0');
    // 低版本那条与条目同版也不算"已装最新"：`installed` 认的是最高版本
    expect(rows[0]!.installed).toBe(false);
    expect(buildGroups([entry({ id: 'b.pack', version: '1.0.0' })], '0.4.0', '', [
      rec({ id: 'b.pack', version: '1.0.0' }),
      rec({ id: 'b.pack', version: '1.1.0' }),
    ]).flatMap((g) => g.rows)[0]!.installed).toBe(false);
  });
});

describe('索引行的动作（安装 / 更新 / 不给动作）', () => {
  const rowsOf = (installed: InstalledPack[], entryOver: Partial<MarketIndexEntry> = {}): PackRow =>
    buildGroups([entry(entryOver)], '0.4.0', '', installed).flatMap((g) => g.rows)[0]!;

  it('本机没装过 ⇒ 「安装」', () => {
    const row = rowsOf([]);
    expect(row.action).toBe('install');
    expect(ACTION_LABEL[row.action]).toBe('安装');
    expect(updatePhrase(row)).toBe('');
  });

  it('索引比本机新 ⇒ `updatable` 行给「更新」，并且行上说清要更到哪一版', () => {
    const row = rowsOf([rec({ version: '1.0.0' })], { version: '1.0.1' });
    expect(row.update?.state).toBe('updatable');
    expect(row.action).toBe('update');
    expect(ACTION_LABEL[row.action]).toBe('更新');
    expect(updatePhrase(row)).toBe('可更新到 1.0.1');
  });

  it('本机反而更高 ⇒ `ahead` 行**不给按钮**，只如实说本机是哪一版', () => {
    const row = rowsOf([rec({ version: '2.0.0' })], { version: '1.0.1' });
    expect(row.update?.state).toBe('ahead');
    expect(row.action).toBe('none');
    expect(ACTION_LABEL[row.action]).toBe('');
    expect(updatePhrase(row)).toBe('本机已是 2.0.0（比注册表那条新）');
  });

  it('同版 ⇒ 不给按钮（面板不自动覆盖本机那一份）；容器锚不同也只说事实', () => {
    expect(rowsOf([rec()]).action).toBe('none');
    expect(updatePhrase(rowsOf([rec()]))).toBe('已安装');
    const sameVersionOtherContainer = rowsOf([rec({ containerSha256: hex('c') })]);
    expect(sameVersionOtherContainer.update?.sameContainer).toBe(false);
    expect(sameVersionOtherContainer.action).toBe('none');
    expect(updatePhrase(sameVersionOtherContainer)).toContain('重装会覆盖');
  });

  it('版本要求不够 ⇒ 不给按钮（行上另有那句人话，不重复催）', () => {
    const row = rowsOf([], { minAppVersion: '9.9.9' });
    expect(row.appOk).toBe(false);
    expect(row.action).toBe('none');
    expect(appVersionRequirement('9.9.9')).toBe('这个包要求编辑器不低于 9.9.9');
  });

  it('rowAction 只认两件事：版本要求够不够 + 三态是不是可更新（按钮该不该有不由面板自己比版本）', () => {
    const u = packUpdateCheck(entry({ version: '1.0.1' }), [rec({ version: '1.0.0' })]);
    const l = packUpdateCheck(entry(), [rec()]);
    const a = packUpdateCheck(entry({ version: '1.0.1' }), [rec({ version: '2.0.0' })]);
    expect(u?.state).toBe('updatable');
    expect(rowAction(true, null)).toBe('install');
    expect(rowAction(true, u)).toBe('update');
    expect(rowAction(true, l)).toBe('none');
    expect(rowAction(true, a)).toBe('none');
    for (const c of [null, u, l, a]) expect(rowAction(false, c)).toBe('none');
  });

  it('indexRowKey 与 pendingKey 同形（同一三元组 = 同一行；它只是行身份，不承担已装判定）', () => {
    const e = entry({ kind: 'dict-pack', id: 'd.pack', version: '1.2.3' });
    expect(indexRowKey(e)).toBe('dict-pack/d.pack@1.2.3');
    expect(pendingKey(rec({ kind: 'dict-pack', id: 'd.pack', version: '1.2.3' }))).toBe(indexRowKey(e));
  });

  it('行上的动作与状态短语都不含机器词（作者面口径；机器面在展开层与日志）', () => {
    const banned = ['kind', 'manifest', 'index.json', 'sha256', 'schema', 'minAppVersion', 'zip'];
    for (const row of [
      rowsOf([]),
      rowsOf([rec({ version: '1.0.0' })], { version: '1.0.1' }),
      rowsOf([rec({ version: '2.0.0' })], { version: '1.0.1' }),
      rowsOf([rec({ containerSha256: hex('c') })]),
      rowsOf([], { minAppVersion: '9.9.9' }),
    ]) {
      const line = `${ACTION_LABEL[row.action]}｜${updatePhrase(row)}`;
      for (const w of banned) expect(line, w).not.toContain(w);
    }
  });
});

describe('拒因只出自一张表（REJECT_TEXT）', () => {
  it('每个拒码都是一句人话，且一个机器词都不上主行', () => {
    const banned = ['kind', 'id', 'manifest', 'index.json', 'sha256', 'schema', 'minAppVersion', 'MarketError'];
    for (const [code, text] of Object.entries(REJECT_TEXT)) {
      expect(text, code).not.toBe('');
      expect(text.length, code).toBeGreaterThan(8);
      // 判的是**作者看到的那一句**（码本身是机器面，不进这一句）
      for (const w of banned) expect(text, `${code} → ${w}`).not.toContain(w);
    }
  });

  it('`MarketError` ⇒ 查表给那句（不是把原始消息甩给作者）', () => {
    const err = new MarketError('container-sha256', '容器整包摘要与注册表不符：期望 a…，实算 b…', 'demo.pack-1.0.0');
    expect(rejectNote('演示口上包', err)).toBe(`「演示口上包」没装成：${REJECT_TEXT['container-sha256']}`);
    // 每一个码都走表（穷尽映射 ⇒ 漏一个码编译期就红）
    for (const code of Object.keys(REJECT_TEXT) as MarketRejectCode[]) {
      expect(rejectNote('演示口上包', new MarketError(code, '机器话', 'd')), code).toContain(REJECT_TEXT[code]);
    }
  });

  it('非 `MarketError` 的异常不静默：原话给出，仍带那一句前缀', () => {
    expect(rejectNote('演示口上包', new Error('磁盘满了'))).toBe('「演示口上包」没装成：磁盘满了');
    expect(rejectNote('演示口上包', '字符串异常')).toBe('「演示口上包」没装成：字符串异常');
  });

  it('装成/进行中那两句也是人话（与拒因同一个内联状态行）', () => {
    expect(installNote('install', '演示口上包', '1.0.0')).toContain('已装上「演示口上包」');
    expect(installNote('update', '演示口上包', '1.0.1')).toContain('更新到版本 1.0.1');
    expect(installBusyNote('install', '演示口上包')).toBe('正在安装「演示口上包」…');
    expect(installBusyNote('update', '演示口上包')).toBe('正在更新「演示口上包」…');
    for (const s of [installNote('install', 'x', '1.0.0'), installBusyNote('update', 'x')]) {
      for (const w of ['kind', 'id', 'sha256', 'manifest', 'index.json', 'schema']) expect(s, w).not.toContain(w);
    }
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

  it('只有口上包那一行可导入（其余种类行没这个动作；判定在行标记上，渲染层照它画）', () => {
    const rows = buildInstalledRows([
      rec({ kind: 'dict-pack', id: 'd.pack', name: '字典' }),
      rec({ kind: 'kojo-pack', id: 'k.pack', name: '口上' }),
      rec({ kind: 'template-pack', id: 't.pack', name: '模板' }),
    ]);
    // 已装列表按契约种类顺序排：口上包 → 字典包 → 模板包
    expect(rows.map((r) => [r.rec.kind, r.canImport])).toEqual([
      ['kojo-pack', true],
      ['dict-pack', false],
      ['template-pack', false],
    ]);
    expect(IMPORT_LABEL).toBe('导入为我的口上项目');
  });

  it('导入那两句都是人话，且"已请求"不冒充结果（机器词不上行）', () => {
    expect(importNote('演示口上包')).toContain('已请求导入「演示口上包」');
    expect(importNote('演示口上包')).not.toContain('已导入');
    // 取目录失败也只丢一句人话（原话给出，不静默）：走同一条内联状态行
    expect(importFailNote('演示口上包', new Error('目录读不动'))).toBe(
      '「演示口上包」没能开始导入：目录读不动',
    );
    for (const s of [importNote('演示口上包'), importFailNote('演示口上包', new Error('x')), IMPORT_LABEL]) {
      for (const w of ['kind', 'sha256', 'manifest', 'index.json', 'schema', 'importRequested']) {
        expect(s, w).not.toContain(w);
      }
    }
  });
});

describe('组标题的计数与过滤短语（结构层的纯逻辑）', () => {
  it('索引组计数 = 屏上条数；已装组 = 条数 + 占用，一条没装就整句不给（不写"占用 0 B"）', () => {
    expect(groupCountPhrase(1)).toBe('1 个');
    expect(groupCountPhrase(12)).toBe('12 个');
    expect(installedCountPhrase(0, 0)).toBe('');
    expect(installedCountPhrase(0, 9_999)).toBe('');
    expect(installedCountPhrase(3, 1024)).toBe('3 个 · 占用 1.0 KB');
    // 占用一律走 `formatBytes` 那一条口径（面板不自己加总 files，也不自己拼单位）
    expect(installedCountPhrase(1, 0)).toBe('1 个 · 占用 0 B');
    expect(installedCountPhrase(2, 5 * 1024 * 1024)).toContain('5.0 MB');
  });

  it('过滤空态那一句带上作者刚输入的词，清除路径就是工具条那枚「清除」（纯字符串标签）', () => {
    expect(filterEmptyPhrase('某人')).toBe('没有名字或作者里含「某人」的包');
    expect(CLEAR_LABEL).toBe('清除');
  });

  it('这几句都是作者面口径：机器词一个都不上（计数与占用住在组标题上）', () => {
    const banned = ['kind', 'id', 'manifest', 'index.json', 'sha256', 'schema', 'minAppVersion', 'zip'];
    for (const s of [groupCountPhrase(4), installedCountPhrase(4, 2048), filterEmptyPhrase('甲'), CLEAR_LABEL]) {
      for (const w of banned) expect(s, w).not.toContain(w);
    }
  });
});
