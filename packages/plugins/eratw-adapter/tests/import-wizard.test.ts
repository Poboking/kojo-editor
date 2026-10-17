import { describe, expect, it } from 'vitest';
import { authorCandidateNotice, type PackageAttribution } from '../src/attribution';
import { buildImportMeta } from '../src/import-wizard';

/**
 * 导入向导的**候选署名确认**（1018 反馈批）。
 *
 * 组件本体是 hooks + `createElement`，本仓没有 react-dom（不为一条断言背渲染器），
 * 所以这里直测组件与测试共用的两个纯函数：
 * 1. `buildImportMeta`：未勾选不带候选 / 勾选才带 / 高置信 author 永远优先；
 * 2. `authorCandidateNotice`：提示文案带值 + 文件 + 1 基行号（给证据不给结论）。
 */

const CANDIDATE = { value: '舩 弦五郎', file: 'readme.txt', line: 36 };

/** 一个"只有候选、没有高置信作者"的源包画像 */
function attr(over: Partial<PackageAttribution> = {}): PackageAttribution {
  return {
    author: null,
    authorCandidate: CANDIDATE,
    updated: null,
    license: { kind: 'none' },
    readmeFiles: ['readme.txt'],
    ...over,
  };
}

describe('导入向导 · 候选署名默认不采用', () => {
  it('未勾选 → meta 只有 importedFrom，原作者与候选都不落盘', () => {
    expect(buildImportMeta('/packs/キャノボ風レティ', attr(), false)).toEqual({
      importedFrom: '/packs/キャノボ風レティ',
    });
  });

  it('勾选 → 候选以既有 originalAuthor 键落 meta；authorCandidate 键本身不外泄', () => {
    const meta = buildImportMeta('/packs/x', attr(), true);
    expect(meta).toEqual({ importedFrom: '/packs/x', originalAuthor: '舩 弦五郎' });
    expect('authorCandidate' in meta).toBe(false);
  });

  it('高置信 author 在 → 即便勾选（过时状态）也绝不被候选覆盖', () => {
    const meta = buildImportMeta(
      '/packs/x',
      attr({ author: { value: 'holy', file: 'readme.txt', line: 1 }, authorCandidate: null }),
      true,
    );
    expect(meta.originalAuthor).toBe('holy');
  });

  it('没有候选 / 没有画像 → 勾选也不写 originalAuthor', () => {
    expect(buildImportMeta('/packs/x', attr({ authorCandidate: null }), true)).toEqual({
      importedFrom: '/packs/x',
    });
    expect(buildImportMeta('/packs/x', null, true)).toEqual({ importedFrom: '/packs/x' });
  });

  it('勾选采用不会挤掉既有更新 / 许可 meta 字段', () => {
    const meta = buildImportMeta(
      '/packs/x',
      attr({
        updated: { value: '2023-10-07', file: 'readme.txt', line: 3 },
        license: { kind: 'template-only', file: 'ライセンステンプレ.txt' },
      }),
      true,
    );
    expect(meta).toEqual({
      importedFrom: '/packs/x',
      originalAuthor: '舩 弦五郎',
      originalUpdated: '2023-10-07',
      licenseKind: 'template-only',
      licenseFile: 'ライセンステンプレ.txt',
    });
  });
});

describe('导入向导 · 候选提示文案', () => {
  it('带值 + 文件 + 1 基行号（用户按行号核原文）', () => {
    expect(authorCandidateNotice(CANDIDATE)).toBe('可能作者：舩 弦五郎（readme.txt 第 36 行，请确认）');
  });
});
