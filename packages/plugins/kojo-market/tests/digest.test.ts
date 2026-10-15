import { describe, expect, it } from 'vitest';
import { contentDigestOf, sha256Hex, utf8Bytes } from '../src/digest';
import { SHA256_HEX_RE } from '@kojo/plugin-api';

/**
 * 校验锚必须是**真** SHA-256：用公开测试向量钉死（不是"和上次一致"这种自证）。
 * 谁想换成非密码学哈希，先过这一关。
 */
describe('sha256Hex（真 SHA-256 向量）', () => {
  it('空输入 = e3b0c442…b855', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('"abc" = ba7816bf…15ad', async () => {
    expect(await sha256Hex(utf8Bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('非 ASCII 走 UTF-8 字节，不是码点直塞', async () => {
    // 独立算出的公开口径值（node:crypto 同法核对），不是"和上次一致"的自证
    expect(await sha256Hex(utf8Bytes('口上'))).toBe(
      '6e61d783de51102156ac887c4d1770cfc1627d88809a006218408471e5046c24',
    );
  });
  it('输出恒为 64 位小写十六进制', async () => {
    expect(SHA256_HEX_RE.test(await sha256Hex(utf8Bytes('任何内容')))).toBe(true);
  });
});

describe('utf8Bytes', () => {
  it('与 TextEncoder 逐字节一致（含 2/3/4 字节段与代理对）', () => {
    for (const s of ['', 'a', 'ab©', '口上・メッセージ', '\u{1f600}x']) {
      expect([...utf8Bytes(s)]).toEqual([...new TextEncoder().encode(s)]);
    }
  });
});

describe('contentDigestOf（逐文件锚的折叠摘要）', () => {
  const files = [
    { path: 'files/b.erb', bytes: 1, sha256: 'b'.repeat(64) },
    { path: 'files/a.erb', bytes: 1, sha256: 'a'.repeat(64) },
  ];
  it('与条目顺序无关（先按 path 排序再折）', async () => {
    expect(await contentDigestOf(files)).toBe(await contentDigestOf([...files].reverse()));
  });
  it('锚变了摘要必变', async () => {
    const other = files.map((f, i) => ({ ...f, sha256: i === 0 ? 'c'.repeat(64) : f.sha256 }));
    expect(await contentDigestOf(other)).not.toBe(await contentDigestOf(files));
  });
});
