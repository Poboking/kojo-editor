/**
 * 封存层首开说明（LAU-3b）的纯判据。
 *
 * 只钉两件事：什么时候该弹（kojo1 源 + 已封存 + 这份 model 真是 plaintext + 本窗口没说过），
 * 以及无 window 的 node / 测试环境**绝不弹**。文案本身由作者面评审，不在这里钉逐字。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGACY_KOJO_V1_CONTENT_NOTICE_MESSAGE,
  LEGACY_KOJO_V1_CONTENT_NOTICE_TITLE,
  LEGACY_SEALED_NOTICE_MESSAGE,
  LEGACY_SEALED_NOTICE_TITLE,
  loadLegacyKojoV1ContentNoticePrompted,
  loadLegacySealedNoticePrompted,
  shouldExplainLegacyKojoV1Content,
  shouldExplainLegacySealedOpen,
} from '../src/ui/legacy-sealed-notice';

describe('shouldExplainLegacySealedOpen', () => {
  const base = { path: 'D:/p/a.kojo1', languageId: 'plaintext', legacyOn: false, prompted: false };

  it('kojo1 源（`.kojo1`，大小写不敏感）+ 已封存 + plaintext + 没说过 ⇒ 弹', () => {
    expect(shouldExplainLegacySealedOpen(base)).toBe(true);
    expect(shouldExplainLegacySealedOpen({ ...base, path: 'D:/P/A.KOJO1' })).toBe(true);
  });

  it('任一条件不成立 ⇒ 不弹（四条件缺一不可）；`.kojo` 归 2.0，不再触发', () => {
    expect(shouldExplainLegacySealedOpen({ ...base, legacyOn: true })).toBe(false);
    expect(shouldExplainLegacySealedOpen({ ...base, prompted: true })).toBe(false);
    expect(shouldExplainLegacySealedOpen({ ...base, languageId: 'kojo2' })).toBe(false);
    expect(shouldExplainLegacySealedOpen({ ...base, languageId: 'kojo-legacy' })).toBe(false);
    expect(shouldExplainLegacySealedOpen({ ...base, path: 'D:/p/a.erb' })).toBe(false);
    expect(shouldExplainLegacySealedOpen({ ...base, path: 'D:/p/a.kojo2' })).toBe(false);
    expect(shouldExplainLegacySealedOpen({ ...base, path: 'D:/p/a.kojo' })).toBe(false);
  });

  it('无 window（node / 测试）⇒ 台账读作"已说过"，绝不弹', () => {
    expect(loadLegacySealedNoticePrompted()).toBe(true);
  });

  it('文案：标题与正文都不是空串，且正文说清"没有改动文件"与"去哪里开启"', () => {
    expect(LEGACY_SEALED_NOTICE_TITLE.length).toBeGreaterThan(0);
    expect(LEGACY_SEALED_NOTICE_MESSAGE).toContain('没有被改动');
    expect(LEGACY_SEALED_NOTICE_MESSAGE).toContain('Kojo 2.0 档位');
  });
});

describe('shouldExplainLegacyKojoV1Content', () => {
  const base = {
    path: 'D:/p/a.kojo',
    flavor: 'v1' as const,
    prompted: false,
  };

  it('`.kojo` + 指纹判 v1 + 没说过 ⇒ 弹', () => {
    expect(shouldExplainLegacyKojoV1Content(base)).toBe(true);
    expect(shouldExplainLegacyKojoV1Content({ ...base, path: 'D:/P/A.KOJO' })).toBe(true);
  });

  it('任一条件不成立 ⇒ 不弹（`.kojo2` / `.kojo1` / 别的扩展名 / 拿不准的指纹 / 已说过）', () => {
    expect(shouldExplainLegacyKojoV1Content({ ...base, prompted: true })).toBe(false);
    expect(shouldExplainLegacyKojoV1Content({ ...base, path: 'D:/p/a.kojo2' })).toBe(false);
    expect(shouldExplainLegacyKojoV1Content({ ...base, path: 'D:/p/a.kojo1' })).toBe(false);
    expect(shouldExplainLegacyKojoV1Content({ ...base, path: 'D:/p/a.erb' })).toBe(false);
    expect(shouldExplainLegacyKojoV1Content({ ...base, flavor: 'kojo2' })).toBe(false);
    expect(shouldExplainLegacyKojoV1Content({ ...base, flavor: 'ambiguous' })).toBe(false);
    expect(shouldExplainLegacyKojoV1Content({ ...base, flavor: 'empty' })).toBe(false);
  });

  it('无 window（node / 测试）⇒ 台账读作"已说过"，绝不弹', () => {
    expect(loadLegacyKojoV1ContentNoticePrompted()).toBe(true);
  });

  it('文案：说清文件没被改动，并给迁移向导与改名两条出路', () => {
    expect(LEGACY_KOJO_V1_CONTENT_NOTICE_TITLE.length).toBeGreaterThan(0);
    expect(LEGACY_KOJO_V1_CONTENT_NOTICE_MESSAGE).toContain('没有被改动');
    expect(LEGACY_KOJO_V1_CONTENT_NOTICE_MESSAGE).toContain('迁移向导');
    expect(LEGACY_KOJO_V1_CONTENT_NOTICE_MESSAGE).toContain('.kojo1');
  });
});
