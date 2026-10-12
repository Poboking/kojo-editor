import { describe, expect, it } from 'vitest';
import { projectFingerprintOf, type FileStamp } from '../src/fingerprint';

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
