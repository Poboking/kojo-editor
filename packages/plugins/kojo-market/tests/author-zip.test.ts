import { describe, expect, it } from 'vitest';
import { buildZip, readZipContainer } from '@kojo/plugin-api';
import { decodeAuthorZipName, inspectAuthorZip } from '../src/author-zip';

/**
 * 普通作品包 zip 的宽松读取（ZIP-1）：
 * - 条目名 UTF-8 → CP932（Shift-JIS）解码；
 * - 目录条目 / 系统垃圾跳过；路径闸与限额仍走市场契约原语；
 * - 单层包裹目录剥离；空包 / 限额外 / 重名给市场错误码。
 *
 * 端到端（服务 + 真 zip 文件）的用例在 `publish-pack.test.ts` 的 `inspectZip` 组。
 */

const enc = new TextEncoder();
const bytes = (text: string): Uint8Array => enc.encode(text);

async function containerOf(entries: Array<{ name: string; data: Uint8Array }>) {
  return readZipContainer(await buildZip(entries, { contract: 'generic' }));
}

describe('decodeAuthorZipName · 老 zip 的条目名', () => {
  it('合法 UTF-8 原样返回', () => {
    expect(decodeAuthorZipName(bytes('主口上.ERB'))).toBe('主口上.ERB');
  });

  it('CP932（Shift-JIS）字节解成日文名', () => {
    // 主口上 = 0x8E 0xE5 / 0x8C 0xFB / 0x8F 0xE3（iconv-lite 'shift_jis' 实测）
    expect(decodeAuthorZipName(new Uint8Array([0x8e, 0xe5, 0x8c, 0xfb, 0x8f, 0xe3]))).toBe('主口上');
    // 作者 = 0x8D 0xEC / 0x8E 0xD2
    expect(decodeAuthorZipName(new Uint8Array([0x8d, 0xec, 0x8e, 0xd2]))).toBe('作者');
  });

  it('GBK（中文 Windows 的 7-Zip 默认）字节解成中文名', () => {
    // 主口上 = D6 F7 / BF DA / C9 CF（实测 plain-package.zip 的 raw name）
    expect(decodeAuthorZipName(new Uint8Array([0xd6, 0xf7, 0xbf, 0xda, 0xc9, 0xcf]))).toBe('主口上');
  });

  it('不是合法 UTF-8 也不像 Shift-JIS 时仍有兜底（不抛）', () => {
    expect(decodeAuthorZipName(new Uint8Array([0x81, 0x40])).length).toBeGreaterThan(0);
  });
});

describe('inspectAuthorZip · 宽松但守闸', () => {
  it('目录条目与系统垃圾跳过，文件按中央目录顺序解出', async () => {
    const container = await containerOf([
      { name: 'pkg/', data: new Uint8Array() },
      { name: 'pkg/readme.txt', data: bytes('readme') },
      { name: 'pkg/占位补充.ERB', data: bytes('PRINT 1\n') },
      { name: '__MACOSX/._readme.txt', data: bytes('junk') },
      { name: 'pkg/Thumbs.db', data: bytes('junk') },
    ]);
    const out = await inspectAuthorZip(container);
    expect(out.strippedRoot).toBe('pkg');
    expect(out.files.map((f) => f.path)).toEqual(['readme.txt', '占位补充.ERB']);
    expect(out.skipped).toEqual(['pkg/', '__MACOSX/._readme.txt', 'pkg/Thumbs.db']);
  });

  it('根目录有文件 + 子目录时不剥包裹（不猜哪一层是包根）', async () => {
    const container = await containerOf([
      { name: 'readme.txt', data: bytes('readme') },
      { name: 'sub/a.ERB', data: bytes('x') },
    ]);
    const out = await inspectAuthorZip(container);
    expect(out.strippedRoot).toBeUndefined();
    expect(out.files.map((f) => f.path)).toEqual(['readme.txt', 'sub/a.ERB']);
  });

  it('条目数超过入参限额 → entries-limit（与市场容器同一张码表）', async () => {
    const container = await containerOf([
      { name: 'a.ERB', data: bytes('a') },
      { name: 'b.ERB', data: bytes('b') },
    ]);
    await expect(
      inspectAuthorZip(container, { maxEntries: 1, maxDepth: 12, maxUnpackedBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'entries-limit' });
  });

  it('只有目录/垃圾 → content-missing', async () => {
    const container = await containerOf([
      { name: 'dir/', data: new Uint8Array() },
      { name: '.DS_Store', data: bytes('junk') },
    ]);
    await expect(inspectAuthorZip(container)).rejects.toMatchObject({ code: 'content-missing' });
  });

  it('重名按大小写折叠拒（Windows 落盘会互覆）', async () => {
    const container = await containerOf([
      { name: 'A.ERB', data: bytes('a') },
      { name: 'a.erb', data: bytes('b') },
    ]);
    await expect(inspectAuthorZip(container)).rejects.toMatchObject({ code: 'entry-duplicate' });
  });
});
