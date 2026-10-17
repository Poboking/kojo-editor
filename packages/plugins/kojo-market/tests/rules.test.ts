import { describe, expect, it } from 'vitest';
import {
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_SCHEMA_VERSION,
  PACK_ID_RE,
  PACK_VERSION_RE,
  VERSION_SEG_RE,
  compareVersions,
  coreVersion,
  minAppVersionSatisfied,
  packEntryPathProblem,
  packFilesProblem,
  packIdKindConflicts,
  MarketError,
  type PackFileEntry,
  type PackManifest,
} from '@kojo/plugin-api';
import { parseManifest, packContainerProblem } from '../src/manifest';
import {
  packUpdateCheck,
  type InstalledPack,
  type MarketIndexEntry,
} from '@kojo/plugin-api';

/** 校验规则的"会拦住后来者"的那一份：每条规则一个拒例 + 一个放行例，纯函数、零 IO。 */

const HEX = '0'.repeat(63) + 'a';
const APP = '0.4.0-beta.1';

function entry(path: string, bytes = 1, sha = HEX): PackFileEntry {
  return { path, bytes, sha256: sha };
}

function manifest(over: Partial<PackManifest> = {}): PackManifest {
  return {
    schema: MARKET_SCHEMA_VERSION,
    kind: 'kojo-pack',
    id: 'demo.pack-1',
    version: '1.0.0',
    name: '示例包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    redistribute: true,
    minAppVersion: '0.4.0',
    files: [entry('files/a.erb')],
    ...over,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MarketError);
    return (err as MarketError).code;
  }
  throw new Error('本该抛出，结果没有');
}

describe('契约字面尺', () => {
  it('id：小写起头、可含 . _ -、总长 ≤ 64；大写/空格/中文/超长一律不匹配', () => {
    expect(PACK_ID_RE.test('demo.pack-1_x')).toBe(true);
    expect(PACK_ID_RE.test('a')).toBe(true);
    expect(PACK_ID_RE.test('Demo')).toBe(false);
    expect(PACK_ID_RE.test('-lead')).toBe(false);
    expect(PACK_ID_RE.test('有中文')).toBe(false);
    expect(PACK_ID_RE.test('a'.repeat(64))).toBe(true);
    expect(PACK_ID_RE.test('a'.repeat(65))).toBe(false);
  });

  it('version：严格三段数字；预发布/两段/四段/非数字一律不匹配', () => {
    expect(PACK_VERSION_RE.test('1.0.0')).toBe(true);
    expect(PACK_VERSION_RE.test('0.4.0-beta.1')).toBe(false);
    expect(PACK_VERSION_RE.test('1.0')).toBe(false);
    expect(PACK_VERSION_RE.test('1.0.0.1')).toBe(false);
  });

  it('VERSION_SEG_RE：纯数字且 ≤ 9 位（防畸形长段溢出）', () => {
    expect(VERSION_SEG_RE.test('0')).toBe(true);
    expect(VERSION_SEG_RE.test('999999999')).toBe(true);
    expect(VERSION_SEG_RE.test('9999999999')).toBe(false);
    expect(VERSION_SEG_RE.test('01a')).toBe(false);
  });
});

describe('compareVersions（全仓唯一一份版本比较）', () => {
  it('逐段数值比，不是字典序', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('0.4.0', '0.4.1')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
  it('段形非法 → null（不猜）', () => {
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBeNull();
    expect(compareVersions('1.2', '1.3')).toBeNull();
    expect(compareVersions('1.2.3x', '1.2.3')).toBeNull();
  });
});

describe('coreVersion / minAppVersionSatisfied', () => {
  it('剥预发布后缀', () => {
    expect(coreVersion('0.4.0-beta.1')).toBe('0.4.0');
    expect(coreVersion('1.2.3')).toBe('1.2.3');
  });
  it('beta 壳满足自己那一期：minAppVersion 0.4.0 对 0.4.0-beta.1 放行', () => {
    expect(minAppVersionSatisfied(APP, '0.4.0')).toBe(true);
    expect(minAppVersionSatisfied(APP, '0.3.9')).toBe(true);
  });
  it('要求更高版本 ⇒ 不放行', () => {
    expect(minAppVersionSatisfied(APP, '0.5.0')).toBe(false);
    expect(minAppVersionSatisfied(APP, '1.0.0')).toBe(false);
  });
  it('两侧任一形状非法 ⇒ 不放行（宁可拒装）', () => {
    expect(minAppVersionSatisfied('乱写的', '0.4.0')).toBe(false);
    expect(minAppVersionSatisfied(APP, '0.4')).toBe(false);
  });
});

describe('packEntryPathProblem（清单路径硬闸）', () => {
  it('files/ 前缀的 posix 相对路径放行', () => {
    expect(packEntryPathProblem('files/a.erb')).toBeNull();
    expect(packEntryPathProblem('files/個/名/前/a.erb')).toBeNull();
    expect(packEntryPathProblem('files/口上.txt')).toBeNull();
  });
  it.each<[string, string, string]>([
    ['files/../evil.erb', 'path-dotdot', '穿越'],
    ['files/./a.erb', 'path-empty-segment', '点段'],
    ['/files/a.erb', 'path-absolute', '绝对'],
    ['C:/files/a.erb', 'path-drive', '盘符'],
    ['C:files/a.erb', 'path-drive', '相对盘符'],
    ['\\\\server\\a.erb', 'path-backslash', 'UNC/反斜杠'],
    ['files\\sub\\a.erb', 'path-backslash', 'Windows 分隔符'],
    ['other/a.erb', 'path-prefix', '缺 files/ 前缀'],
    ['files//a.erb', 'path-empty-segment', '空段'],
    ['files/', 'path-empty-segment', '尾斜杠'],
    ['files', 'path-prefix', '裸目录名'],
    ['', 'path-empty-segment', '空路径'],
    // 与 Rust `market.rs::entry_path_problem` 对齐的两族（2026-10-17 契约镜像批）
    ['files/a:b.erb', 'path-drive', '盘符位之外的冒号（NTFS ADS 注入面）'],
    ['files/個:名', 'path-drive', '非 ASCII 段名里的冒号同样拒'],
    ['files/a.txt.', 'path-windows-unsafe', '文件名尾随点（Windows 静默剥）'],
    ['files/a.txt ', 'path-windows-unsafe', '文件名尾随空格'],
    ['files/sub./a.erb', 'path-windows-unsafe', '目录段尾随点'],
    ['files/sub /a.erb', 'path-windows-unsafe', '目录段尾随空格'],
  ])('%s → %s（%s）', (path, code) => {
    expect(packEntryPathProblem(path)).toBe(code);
  });
  it(`深度 ≤ ${MARKET_MAX_PATH_DEPTH}（按段数算，含 files 本身）`, () => {
    const atLimit = ['files', ...Array.from({ length: MARKET_MAX_PATH_DEPTH - 1 }, (_, i) => `d${i}`)].join('/');
    expect(packEntryPathProblem(atLimit)).toBeNull();
    const over = `${atLimit}/x.erb`;
    expect(packEntryPathProblem(over)).toBe('path-depth');
  });
});

describe('packFilesProblem（条目数 / 总字节 / 重名 / 摘要形状）', () => {
  it('条目数超限即拒', () => {
    const files = Array.from({ length: MARKET_MAX_FILE_ENTRIES + 1 }, (_, i) =>
      entry(`files/f${i}.erb`),
    );
    expect(packFilesProblem(files)?.code).toBe('entries-limit');
    const atLimit = files.slice(0, MARKET_MAX_FILE_ENTRIES);
    expect(packFilesProblem(atLimit)).toBeNull();
  });
  it(`解压后总字节 > ${MARKET_MAX_UNPACKED_BYTES} 即拒`, () => {
    const one = entry('files/big.erb', MARKET_MAX_UNPACKED_BYTES + 1);
    expect(packFilesProblem([one])?.code).toBe('bytes-limit');
    const halves = [
      entry('files/a.erb', MARKET_MAX_UNPACKED_BYTES / 2),
      entry('files/b.erb', MARKET_MAX_UNPACKED_BYTES / 2),
      entry('files/c.erb', 1),
    ];
    expect(packFilesProblem(halves)?.code).toBe('bytes-limit');
    expect(packFilesProblem(halves.slice(0, 2))).toBeNull();
  });
  it('同一路径出现两次 ⇒ 拒（否则第二个会盖掉第一个，锚就对不上）', () => {
    expect(packFilesProblem([entry('files/a.erb'), entry('files/a.erb')])?.code).toBe('entry-duplicate');
  });
  it('bytes 负数/小数、sha256 非 64 位小写十六进制 ⇒ 拒', () => {
    expect(packFilesProblem([entry('files/a.erb', -1)])?.code).toBe('entry-bytes');
    expect(packFilesProblem([entry('files/a.erb', 1.5)])?.code).toBe('entry-bytes');
    expect(packFilesProblem([entry('files/a.erb', 1, 'zz')])?.code).toBe('entry-sha256');
    expect(packFilesProblem([entry('files/a.erb', 1, 'A'.repeat(64))])?.code).toBe('entry-sha256');
  });
});

describe('parseManifest（装前全量闸）', () => {
  it('合法清单原样通过（可选字段透传）', () => {
    const m = parseManifest(manifest({ summary: 's', sourceUrl: 'https://e/x', gameId: 'eratw' }), APP);
    expect(m.id).toBe('demo.pack-1');
    expect(m.summary).toBe('s');
    expect(m.gameId).toBe('eratw');
  });
  it('schema ≠ 1 ⇒ schema-version', () => {
    expect(codeOf(() => parseManifest({ ...manifest(), schema: 2 }, APP))).toBe('schema-version');
    expect(codeOf(() => parseManifest({ ...manifest(), schema: '1' }, APP))).toBe('schema-version');
  });
  it('kind 三值之外 ⇒ kind-unknown', () => {
    for (const k of ['dict-pack', 'template-pack', 'kojo-pack'] as const) {
      expect(parseManifest(manifest({ kind: k }), APP).kind).toBe(k);
    }
    expect(codeOf(() => parseManifest(manifest({ kind: 'sav-pack' as never }), APP))).toBe('kind-unknown');
  });
  it('id / version 不合尺 ⇒ 对应码', () => {
    expect(codeOf(() => parseManifest(manifest({ id: 'Bad ID' }), APP))).toBe('id-invalid');
    expect(codeOf(() => parseManifest(manifest({ version: '1.0' }), APP))).toBe('version-invalid');
  });
  it('必填字段缺失/空串 ⇒ manifest-shape', () => {
    for (const f of ['name', 'author', 'license'] as const) {
      expect(codeOf(() => parseManifest({ ...manifest(), [f]: '' }, APP))).toBe('manifest-shape');
    }
    expect(codeOf(() => parseManifest({ ...manifest(), redistribute: undefined }, APP))).toBe('manifest-shape');
    expect(codeOf(() => parseManifest({ ...manifest(), files: undefined }, APP))).toBe('manifest-shape');
    expect(codeOf(() => parseManifest([1, 2], APP))).toBe('manifest-shape');
  });
  it('redistribute:false ⇒ 拒装（唯一一条内容类硬闸，人话里要点名作者许可）', () => {
    const err = codeOf(() => parseManifest(manifest({ redistribute: false }), APP));
    expect(err).toBe('redistribute-denied');
    try {
      parseManifest(manifest({ redistribute: false }), APP);
    } catch (e) {
      expect((e as MarketError).message).toContain('二次分发');
    }
  });
  it('minAppVersion 高于当前 ⇒ app-version-too-low + 人话', () => {
    expect(codeOf(() => parseManifest(manifest({ minAppVersion: '9.9.9' }), APP))).toBe('app-version-too-low');
    expect(codeOf(() => parseManifest(manifest({ minAppVersion: 'x.y.z' }), APP))).toBe('min-app-version-invalid');
  });
  it('files 路径违规 ⇒ 原样进拒码', () => {
    expect(codeOf(() => parseManifest(manifest({ files: [entry('files/../a.erb')] }), APP))).toBe('path-dotdot');
    expect(codeOf(() => parseManifest(manifest({ files: [entry('/etc/passwd')] }), APP))).toBe('path-absolute');
  });
  it('sha256 大写会被折成小写后使用（比较口径只有一种）', () => {
    const m = parseManifest(manifest({ files: [entry('files/a.erb', 1, 'A'.repeat(64))] }), APP);
    expect(m.files[0]!.sha256).toBe('a'.repeat(64));
  });
});

describe('注册表不变量：一个 id 只能属于一个 kind（契约 A4）', () => {
  it('同 id 异 kind ⇒ 报出这个 id；同 id 同 kind 多版本不算冲突', () => {
    expect(packIdKindConflicts([])).toEqual([]);
    expect(
      packIdKindConflicts([
        { kind: 'kojo-pack', id: 'a' },
        { kind: 'kojo-pack', id: 'a' },
        { kind: 'dict-pack', id: 'b' },
      ]),
    ).toEqual([]);
    expect(
      packIdKindConflicts([
        { kind: 'kojo-pack', id: 'demo' },
        { kind: 'kojo-pack', id: 'other' },
        { kind: 'dict-pack', id: 'demo' },
      ]),
    ).toEqual(['demo']);
  });

  it('多个冲突 id 一次报全（去重 + 字典序，方便日志与 CI 对齐）', () => {
    expect(
      packIdKindConflicts([
        { kind: 'template-pack', id: 'zz' },
        { kind: 'kojo-pack', id: 'zz' },
        { kind: 'dict-pack', id: 'aa' },
        { kind: 'kojo-pack', id: 'aa' },
        { kind: 'kojo-pack', id: 'aa' },
      ]),
    ).toEqual(['aa', 'zz']);
  });
});

/* ------------------------- 容器双向对平（KM-10..12） ------------------------- */

describe('packContainerProblem：清单与容器的双向对平', () => {
  const file = entry('files/a.erb', 3, HEX);
  const mani = manifest({ files: [file] });
  const declared: MarketIndexEntry = {
    kind: 'kojo-pack',
    id: 'demo.pack-1',
    version: '1.0.0',
    name: '示例包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    minAppVersion: '0.4.0',
    zip: { url: 'https://github.com/p/p/releases/download/a/a.zip', sha256: HEX, bytes: 1 },
    fileCount: 1,
    unpackedBytes: 3,
  };
  const facts = (
    entries: Array<{ path: string; bytes: number }>,
    over: Partial<MarketIndexEntry> = {},
  ) => ({ sha256: HEX, entries, declared: { ...declared, ...over } });

  it('平：根 pack.json 是元数据（不算"清单外多出来的条目"），条目字节一致 ⇒ null', () => {
    expect(
      packContainerProblem(mani, facts([{ path: 'pack.json', bytes: 40 }, { path: 'files/a.erb', bytes: 3 }])),
    ).toBeNull();
  });

  it('清单声明了、容器没解出 ⇒ entry-missing', () => {
    expect(packContainerProblem(mani, facts([{ path: 'pack.json', bytes: 40 }]))?.code).toBe('entry-missing');
  });

  it('容器解出、清单没声明 ⇒ entry-extra（根 pack.json 以外都不许多）', () => {
    expect(
      packContainerProblem(mani, facts([
        { path: 'pack.json', bytes: 40 },
        { path: 'files/a.erb', bytes: 3 },
        { path: 'files/b.erb', bytes: 1 },
      ]))?.code,
    ).toBe('entry-extra');
    // 根级多出来的一个文件同样是"清单没声明"（它不会被搬进落点，所以只能靠这一闸发现）
    expect(
      packContainerProblem(mani, facts([
        { path: 'pack.json', bytes: 40 },
        { path: 'files/a.erb', bytes: 3 },
        { path: '悄悄塞进来的.erb', bytes: 1 },
      ]))?.code,
    ).toBe('entry-extra');
  });

  it('同一容器路径重复出现 ⇒ entry-duplicate', () => {
    expect(
      packContainerProblem(mani, facts([
        { path: 'pack.json', bytes: 40 },
        { path: 'files/a.erb', bytes: 3 },
        { path: 'files/a.erb', bytes: 3 },
      ]))?.code,
    ).toBe('entry-duplicate');
  });

  it('条目两边都有但字节数不同 ⇒ entry-bytes', () => {
    expect(
      packContainerProblem(mani, facts([{ path: 'pack.json', bytes: 40 }, { path: 'files/a.erb', bytes: 4 }]))?.code,
    ).toBe('entry-bytes');
  });

  it('容器里的身份与注册表那一行不符 ⇒ container-identity（kind / id / version 各一例）', () => {
    for (const over of [{ id: 'other.pack' }, { kind: 'dict-pack' as const }, { version: '1.0.1' }]) {
      const p = packContainerProblem(mani, facts([{ path: 'pack.json', bytes: 40 }, { path: 'files/a.erb', bytes: 3 }], over));
      expect(p?.code, JSON.stringify(over)).toBe('container-identity');
      expect(p?.detail, JSON.stringify(over)).toContain('container=');
    }
  });

  it('身份判的是逐字相等，不比"数值相等"（1.0.01 也算不符）', () => {
    expect(packContainerProblem(mani, facts([], { version: '1.0.00' }))?.code).toBe('container-identity');
  });

  it('对平顺序：身份先于条目（身份就不对时不必再报条目缺失）', () => {
    const p = packContainerProblem(mani, facts([], { id: 'other.pack' }));
    expect(p?.code).toBe('container-identity');
  });
});

/* ---------------------------- 更新检测三态（KM-10） ---------------------------- */

describe('packUpdateCheck：索引条目 vs 已装集', () => {
  const entryRow: MarketIndexEntry = {
    kind: 'kojo-pack',
    id: 'demo.pack-1',
    version: '1.0.1',
    name: '示例包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    minAppVersion: '0.4.0',
    zip: { url: 'https://github.com/p/p/releases/download/a/a.zip', sha256: HEX, bytes: 1 },
    fileCount: 1,
    unpackedBytes: 3,
  };
  const installed = (version: string, containerSha256?: string): InstalledPack => ({
    kind: 'kojo-pack',
    id: 'demo.pack-1',
    version,
    name: '示例包',
    author: 'someone',
    license: 'CC-BY-NC 4.0',
    contentDigest: HEX,
    ...(containerSha256 === undefined ? {} : { containerSha256 }),
    installedAt: 1,
    files: [entry('files/a.erb', 3, HEX)],
  });

  it('本机没装过 ⇒ null（"没装"不是一个态，是另一个动作：给「安装」）', () => {
    expect(packUpdateCheck(entryRow, [])).toBeNull();
    expect(packUpdateCheck(entryRow, [{ ...installed('1.0.0'), id: 'other.pack' }])).toBeNull();
  });

  it('索引更新 ⇒ updatable；索引更旧 ⇒ ahead；同版 ⇒ latest', () => {
    expect(packUpdateCheck(entryRow, [installed('1.0.0')])?.state).toBe('updatable');
    expect(packUpdateCheck(entryRow, [installed('2.0.0')])?.state).toBe('ahead');
    expect(packUpdateCheck(entryRow, [installed('1.0.1')])?.state).toBe('latest');
  });

  it('本机装着多个版本 ⇒ 一律与**最高**那条比（不与低版本比出"可更新"的假象）', () => {
    const c = packUpdateCheck(entryRow, [installed('2.0.0'), installed('1.0.0'), installed('1.9.9')]);
    expect(c?.state).toBe('ahead');
    expect(c?.local.version).toBe('2.0.0');
  });

  it('异 kind 的同 id 不参与比较（这种组合早就被 id/kind 查重拦在外层）', () => {
    expect(
      packUpdateCheck(entryRow, [{ ...installed('1.0.0'), kind: 'dict-pack' }]),
    ).toBeNull();
  });

  it('同版时容器锚比得出"是不是同一份东西"；目录源没有容器 ⇒ null（不拿 contentDigest 冒充）', () => {
    expect(packUpdateCheck(entryRow, [installed('1.0.1', HEX)])?.sameContainer).toBe(true);
    expect(packUpdateCheck(entryRow, [installed('1.0.1', 'b'.repeat(64))])?.sameContainer).toBe(false);
    expect(packUpdateCheck(entryRow, [installed('1.0.1')])?.sameContainer).toBeNull();
    // 只有 latest 这一态才谈"同一份"：可更新时容器锚不同是常态，给 null 而不是误导
    expect(packUpdateCheck(entryRow, [installed('1.0.0', 'b'.repeat(64))])?.sameContainer).toBeNull();
  });

  /**
   * MK-1 语义并一：版本形读不出**不再静默 `null`**（`null` 那个口径会把"比不了"演成
   * "本机没装过"，面板于是给一个「安装」按钮去覆盖一份谁也没核对过的东西）。
   * 现在是一条显式 `failed`，`stage` 与宿主自更新那条链路同一档、那一句也从同一张表来。
   */
  it('版本号形如非法 ⇒ 显式 `failed`（不猜大小，也不演成"没装过"）', () => {
    const c = packUpdateCheck({ ...entryRow, version: '1.0' as string }, [installed('1.0.0')]);
    expect(c?.state).toBe('failed');
    expect(c?.failure?.stage).toBe('check');
    expect(c?.failure?.reason).toContain('版本号');
    expect(c?.failure?.note).toContain('没有检查成功，可重试');
    expect(c?.sameContainer).toBeNull();
    // 三态里没有一条带 failure（"比出来了"就不该留着失败态的那句话）
    expect(packUpdateCheck(entryRow, [installed('1.0.0')])?.failure).toBeNull();
    expect(packUpdateCheck(entryRow, [installed('2.0.0')])?.failure).toBeNull();
    expect(packUpdateCheck(entryRow, [installed('1.0.1')])?.failure).toBeNull();
  });
});
