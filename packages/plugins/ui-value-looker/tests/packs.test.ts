/**
 * 作用域分组（口上包域）单测：Windows 路径折叠、作者树 / 基座库 / 索引外三档、
 * 包清单聚合（计数与首次出现序）。
 */
import { describe, expect, it } from 'vitest';
import {
  collectPacks,
  PACK_EXTERNAL,
  PACK_LIBRARY,
  PACK_ROOT,
  packKeyOfPath,
  packLabel,
  relativeSegments,
} from '../src/packs';

const KOJO = ['D:/Game/ERB/口上'];
const LIB = ['D:/Game/ERB/基座'];

describe('relativeSegments', () => {
  it('Windows 大小写折叠；保留原样分段', () => {
    expect(relativeSegments('D:/Game/ERB/口上/K1/A.ERB', 'd:/game/erb/口上')).toEqual(['K1', 'A.ERB']);
  });
  it('根不匹配 → null', () => {
    expect(relativeSegments('D:/Elsewhere/A.ERB', KOJO[0]!)).toBeNull();
  });
  it('根比路径长 → null', () => {
    expect(relativeSegments('D:/Game', KOJO[0]!)).toBeNull();
  });
});

describe('packKeyOfPath', () => {
  it('作者树第一层子目录 = 包键', () => {
    expect(packKeyOfPath('D:/Game/ERB/口上/K1/A.ERB', KOJO, LIB)).toBe('K1');
  });
  it('作者树根散文件 = PACK_ROOT', () => {
    expect(packKeyOfPath('D:/Game/ERB/口上/A.ERB', KOJO, LIB)).toBe(PACK_ROOT);
  });
  it('基座库整域一档', () => {
    expect(packKeyOfPath('D:/game/erb/基座/SUB/B.ERB', KOJO, LIB)).toBe(PACK_LIBRARY);
  });
  it('都匹配不上 = 索引外', () => {
    expect(packKeyOfPath('D:/Other/C.ERB', KOJO, LIB)).toBe(PACK_EXTERNAL);
  });
  it('反斜杠路径同样成立', () => {
    expect(packKeyOfPath('D:\\Game\\ERB\\口上\\K2\\C.ERB', KOJO, LIB)).toBe('K2');
  });
  it('库路径缺席时不误判', () => {
    expect(packKeyOfPath('D:/game/erb/基座/B.ERB', KOJO, [])).toBe(PACK_EXTERNAL);
  });
});

describe('collectPacks / packLabel', () => {
  it('聚合计数；顺序 = 首次出现序', () => {
    const packs = collectPacks(
      [
        'D:/Game/ERB/口上/K1/A.ERB',
        'D:/Game/ERB/口上/K1/A2.ERB',
        'D:/Game/ERB/口上/A.ERB',
        'D:/game/erb/基座/B.ERB',
        'D:/Other/C.ERB',
        'D:/Game/ERB/口上/K2/D.ERB',
      ],
      KOJO,
      LIB,
    );
    expect(packs.map((p) => p.key)).toEqual(['K1', PACK_ROOT, PACK_LIBRARY, PACK_EXTERNAL, 'K2']);
    expect(packs.map((p) => p.fileCount)).toEqual([2, 1, 1, 1, 1]);
    expect(packs.every((p) => p.functionCount === 0)).toBe(true);
  });

  it('显示名：特殊档有可读标签', () => {
    expect(packLabel(PACK_ROOT)).toBe('（口上根散文件）');
    expect(packLabel(PACK_LIBRARY)).toBe('（只读基座库）');
    expect(packLabel(PACK_EXTERNAL)).toBe('（索引外）');
    expect(packLabel('K1')).toBe('K1');
  });
});
