import { describe, expect, it } from 'vitest';
import { ERATW_NAME_GLOSSARY, glossName } from '../src/name-glossary';

/**
 * 日文名 → 中文名对照词典（展示用）单测。
 *
 * 口径：**导入既有包保持原样不强制改名**——只加显示对照，不改任何目录 / 文件名。
 * 测试锁死三条：最长命中、已含中文不重复、无命中 fail-visible 原样返回。
 */

describe('glossName · 日文（中文）对照', () => {
  it('含日文片段：拼 `日文（中文）`（讨论纪要 §6-2 原话例）', () => {
    expect(glossName('追加ファイル')).toBe('追加ファイル（附加文件）');
  });

  it('命中**最长**键：「ライセンステンプレ.txt」取「ライセンス」而非更短键', () => {
    expect(glossName('ライセンステンプレ.txt')).toBe('ライセンステンプレ.txt（授权信息）');
  });

  it('无日文片段的名字：原样返回（fail-visible，绝不猜）', () => {
    expect(glossName('my_pack')).toBe('my_pack');
    expect(glossName('readme.txt')).toBe('readme.txt');
  });

  it('名字自身已含对应中文：原样返回（不重复添加）', () => {
    expect(glossName('追加ファイル（附加文件）')).toBe('追加ファイル（附加文件）');
  });

  it('空名：原样返回空串', () => {
    expect(glossName('')).toBe('');
  });
});

describe('ERATW_NAME_GLOSSARY · 词典本身', () => {
  it('是冻结对象（防消费方就地改写）', () => {
    expect(Object.isFrozen(ERATW_NAME_GLOSSARY)).toBe(true);
  });
});
