import { describe, expect, it } from 'vitest';
import { combineDigests, foldDigest, projectFingerprintOf, stableHash, type FileStamp } from '../src/fingerprint';

const st = (path: string, mtimeMs: number | null, size: number | null): FileStamp => ({ path, mtimeMs, size });

describe('projectFingerprintOf（派生缓存的失效判据）', () => {
  it('同输入 ⇒ 同指纹，且与遍历顺序无关', () => {
    const a = [st('/x/b.ERB', 100, 10), st('/x/a.ERB', 200, 20), st('/x/c.ERB', 300, 30)];
    const b = [a[2]!, a[0]!, a[1]!];
    expect(projectFingerprintOf(a)).toBe(projectFingerprintOf(b));
  });

  it('mtime / size / 路径 任一变化 ⇒ 指纹变化', () => {
    const base = [st('/x/a.ERB', 200, 20)];
    const fp = projectFingerprintOf(base)!;
    expect(projectFingerprintOf([st('/x/a.ERB', 201, 20)])).not.toBe(fp);
    expect(projectFingerprintOf([st('/x/a.ERB', 200, 21)])).not.toBe(fp);
    expect(projectFingerprintOf([st('/x/A.ERB', 200, 20)])).not.toBe(fp);
  });

  it('数字边界不串味（mtime=12,size=3 与 mtime=1,size=23 必须不同）', () => {
    expect(projectFingerprintOf([st('/a.ERB', 12, 3)])).not.toBe(projectFingerprintOf([st('/a.ERB', 1, 23)]));
  });

  it('文件增删 ⇒ 指纹变化', () => {
    const one = projectFingerprintOf([st('/a.ERB', 1, 1)])!;
    expect(projectFingerprintOf([st('/a.ERB', 1, 1), st('/b.ERB', 2, 2)])).not.toBe(one);
  });

  it('保守失效：任一文件缺 mtime 或 size ⇒ 整个指纹为 null（宁可不缓存）', () => {
    expect(projectFingerprintOf([st('/a.ERB', null, 1)])).toBeNull();
    expect(projectFingerprintOf([st('/a.ERB', 1, null)])).toBeNull();
    expect(projectFingerprintOf([st('/a.ERB', 1, 1), st('/b.ERB', 2, null)])).toBeNull();
  });

  it('空项目也是确定指纹（区别于 null：零文件 ≠ 判据不可得）', () => {
    const fp = projectFingerprintOf([]);
    expect(fp).not.toBeNull();
    expect(fp).toBe(projectFingerprintOf([]));
  });

  it('指纹是 14 位十六进制', () => {
    expect(projectFingerprintOf([st('/a.ERB', 1, 1)])).toMatch(/^[0-9a-f]{14}$/);
  });

  it('同一份文件清单重复计算 ⇒ 稳定（跨进程可复现，缓存键才谈得上命中）', () => {
    const set = [st('/x/b.ERB', 5, 50), st('/x/a.ERB', 6, 60)];
    expect(projectFingerprintOf(set)).toBe(projectFingerprintOf([...set].reverse()));
  });
});

describe('combineDigests（多路输入判据的合成）', () => {
  it('任一路缺失 ⇒ null（判据不全就不许缓存）', () => {
    expect(combineDigests(['a', null])).toBeNull();
    expect(combineDigests(['a', undefined])).toBeNull();
    expect(combineDigests(['a', ''])).toBeNull();
    expect(combineDigests([])).toBeNull();
  });

  it('两路齐 ⇒ 出值；任一路变化 ⇒ 变化；与顺序有关（谁是谁要分清）', () => {
    const ab = combineDigests(['erb', 'csv'])!;
    expect(ab).toBe(combineDigests(['erb', 'csv']));
    expect(ab).not.toBe(combineDigests(['erb', 'csv2']));
    expect(ab).not.toBe(combineDigests(['erb2', 'csv']));
    expect(combineDigests(['csv', 'erb'])).not.toBe(ab);
  });
});

describe('foldDigest（顺序无关的素材折叠）', () => {
  it('素材顺序无关（目录遍历顺序不该换判据）', () => {
    expect(foldDigest(['a', 'b', 'c'])).toBe(foldDigest(['c', 'a', 'b']));
  });

  it('素材内容或数量变化 ⇒ 变化', () => {
    const base = foldDigest(['a', 'b']);
    expect(foldDigest(['a', 'c'])).not.toBe(base);
    expect(foldDigest(['a'])).not.toBe(base);
    expect(foldDigest(['a', 'b', ''])).not.toBe(base);
  });

  it('空集合是**确定值**（"确实一无所读" ≠ "没有判据"）', () => {
    expect(foldDigest([])).toBe(foldDigest([]));
    expect(foldDigest([])).not.toBe(foldDigest(['x']));
  });
});

describe('stableHash', () => {
  it('14 位十六进制、确定输入确定输出、区分近似输入', () => {
    expect(stableHash('kojo')).toMatch(/^[0-9a-f]{14}$/);
    expect(stableHash('kojo')).toBe(stableHash('kojo'));
    expect(stableHash('kojo')).not.toBe(stableHash('kojO'));
    expect(stableHash('')).not.toBe(stableHash('a'));
  });
});
