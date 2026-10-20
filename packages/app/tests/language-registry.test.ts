/**
 * LANG-REGISTRY（2026-10-20）的判据钉子：
 * ① ERB / Kojo 走**同一张** descriptor 表，且都是 `languageServices: true` 的一等语言；
 *    JSON 是只读保留面，不挂通用语言服务；
 * ② 认路判据与收口前 `languageFor` 逐字对拍（大小写、最后一段扩展名、plaintext 兜底）；
 * ③ 每条路径至多命中一门语言（判据不重叠，注册顺序不影响结果）；
 * ④ 同 id 重复注册直接抛错——注册表是只增表，不静默覆盖。
 */
import { describe, expect, it } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { JSON_LANGUAGE_ID } from '../src/monaco/json-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { languageForPath } from '../src/monaco/languages';
import {
  descriptorForLanguageId,
  FALLBACK_LANGUAGE_ID,
  languageDescriptors,
  registerLanguage,
} from '../src/monaco/language-registry';

describe('内置语言 descriptor', () => {
  it('ERB / Kojo 同级登记，且都参与通用语言服务；JSON 不参与', () => {
    expect(descriptorForLanguageId(ERB_LANGUAGE_ID)?.languageServices).toBe(true);
    expect(descriptorForLanguageId(KOJO_LANGUAGE_ID)?.languageServices).toBe(true);
    expect(descriptorForLanguageId(JSON_LANGUAGE_ID)?.languageServices).toBeUndefined();
  });

  it('认路判据与收口前 languageFor 逐字对拍', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['D:\\作品\\事件.kojo', KOJO_LANGUAGE_ID],
      ['D:/x/A.KOJO', KOJO_LANGUAGE_ID],
      ['D:\\x\\note.ERB', ERB_LANGUAGE_ID],
      ['D:\\x\\K36.erm', ERB_LANGUAGE_ID],
      ['D:\\x\\M_KOJO_K11_TR.ERH', ERB_LANGUAGE_ID],
      ['D:\\x\\settings.json', JSON_LANGUAGE_ID],
      ['D:\\x\\SETTINGS.JSON', JSON_LANGUAGE_ID],
      ['D:\\x\\x.kojo.bak', FALLBACK_LANGUAGE_ID],
      ['D:\\x\\K36.ERH.bak', FALLBACK_LANGUAGE_ID],
      ['D:\\x\\note.txt', FALLBACK_LANGUAGE_ID],
      ['D:\\x\\noext', FALLBACK_LANGUAGE_ID],
      ['C:\\x\\.erb', FALLBACK_LANGUAGE_ID],
    ];
    for (const [path, expected] of cases) {
      expect(languageForPath(path), path).toBe(expected);
    }
  });

  it('每条路径至多命中一门语言（判据不重叠）', () => {
    const paths = [
      'D:\\作品\\事件.kojo',
      'D:\\x\\note.ERB',
      'D:\\x\\K36.erm',
      'D:\\x\\M_KOJO_K11_TR.ERH',
      'D:\\x\\settings.json',
    ];
    for (const path of paths) {
      const hits = languageDescriptors().filter((descriptor) => descriptor.matchesPath(path));
      expect(hits.length, path).toBeLessThanOrEqual(1);
    }
  });

  it('同 id 重复注册直接抛错（不静默覆盖）', () => {
    registerLanguage({
      id: 'probe-language',
      label: 'probe',
      matchesPath: () => false,
      register: () => {},
    });
    expect(() =>
      registerLanguage({
        id: 'probe-language',
        label: 'probe-again',
        matchesPath: () => false,
        register: () => {},
      }),
    ).toThrow(/重复注册/);
  });
});
