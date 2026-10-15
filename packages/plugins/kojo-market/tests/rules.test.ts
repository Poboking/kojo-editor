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
  MarketError,
  type PackFileEntry,
  type PackManifest,
} from '@kojo/plugin-api';
import { parseManifest } from '../src/manifest';

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
