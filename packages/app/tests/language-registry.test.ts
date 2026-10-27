/**
 * LANG-REGISTRY（2026-10-20）的判据钉子：
 * ① ERB / Kojo 走**同一张** descriptor 表，且都是 `languageServices: true` 的一等语言；
 *    JSON 是只读保留面，不挂通用语言服务；
 * ② 认路判据与收口前 `languageFor` 逐字对拍（大小写、最后一段扩展名、plaintext 兜底）；
 * ③ 每条路径至多命中一门语言（判据不重叠，注册顺序不影响结果）；
 * ④ 同 id 重复注册直接抛错——注册表是只增表，不静默覆盖。
 * ⑤ LAU-3 的**可用性门**：缺省谓词把 `legacy` 档（kojo1）按切流阶段封存；门只管"能不能被
 *    认领"，注册面不动；门关上时**已认领的 model 不回头改语言**（`keepClaimedLanguageWhenGated`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { JSON_LANGUAGE_ID } from '../src/monaco/json-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import { languageForPath } from '../src/monaco/languages';
import {
  availableLanguageDescriptors,
  descriptorForLanguageId,
  FALLBACK_LANGUAGE_ID,
  installAvailabilityGate,
  isLanguageIdAvailable,
  keepClaimedLanguageWhenGated,
  languageDescriptors,
  languageLabelForId,
  registerLanguage,
  unavailableLanguageDescriptors,
  unavailableReason,
} from '../src/monaco/language-registry';

describe('内置语言 descriptor', () => {
  // 这一组测的是**注册表机制**，不是本产品此刻的封存策略：装一枚恒真谓词，
  // 让认路判据与收口前 `languageFor` 逐字对拍（缺省谓词的行为在下一组单独钉）。
  beforeEach(() => installAvailabilityGate(() => true));
  afterEach(() => installAvailabilityGate(null));

  it('ERB / Kojo 同级登记，且都参与通用语言服务；JSON 不参与', () => {
    expect(descriptorForLanguageId(ERB_LANGUAGE_ID)?.languageServices).toBe(true);
    expect(descriptorForLanguageId(KOJO_LANGUAGE_ID)?.languageServices).toBe(true);
    expect(descriptorForLanguageId(JSON_LANGUAGE_ID)?.languageServices).toBeUndefined();
  });

  it('ERB 与 Kojo 都声明结构层（同级一等）；装载由 descriptor 按需触发', () => {
    expect(typeof descriptorForLanguageId(ERB_LANGUAGE_ID)?.structure?.load).toBe('function');
    expect(typeof descriptorForLanguageId(KOJO_LANGUAGE_ID)?.structure?.load).toBe('function');
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

  it('登记纪律：opt-in / legacy 不给 settingKey 直接抛错（否则这门语言永远打不开）', () => {
    for (const availability of ['opt-in', 'legacy'] as const) {
      expect(() =>
        registerLanguage({
          id: `probe-${availability}`,
          label: availability,
          availability,
          matchesPath: () => false,
          register: () => {},
        }),
      ).toThrow(/settingKey/);
    }
  });
});

/* ============================== 可用性门（LAU-3 / §4.4） ============================== */

/**
 * 门的三条纪律（设计稿 §4.4）在本文件逐条取证：
 * 1. **门开关不重注册**：descriptor 永远在表里、永远能被批量挂面；
 * 2. **认不出 = `plaintext` 兜底**（与"今天认不出的文件"同一条路），选择器只列可用的；
 * 3. **已打开的 model 不回头改语言**：`keepClaimedLanguageWhenGated` 那一枚。
 */
describe('语言可用性门（LAU-3）：封存层只影响认领，不动注册面', () => {
  afterEach(() => installAvailabilityGate(null));

  it('缺省谓词：kojo1（legacy）看切流阶段——node 里控制器缺省 = 2.0-default ⇒ 封存', () => {
    // 没有 window ⇒ 控制器缺省档；LAU-3 起那一档是 `2.0-default` ⇒ kojo1 不可认领
    expect(languageForPath('D:/x/a.kojo')).toBe(FALLBACK_LANGUAGE_ID);
    // 注册面不动：表里仍有这一枚，仍可批量挂面（Monarch / 语言配置照旧）
    expect(descriptorForLanguageId(KOJO_LANGUAGE_ID)).not.toBeNull();
    expect(languageDescriptors().some((d) => d.id === KOJO_LANGUAGE_ID)).toBe(true);
    // 选择器（语言菜单）只列可认领的那一批
    expect(availableLanguageDescriptors().some((d) => d.id === KOJO_LANGUAGE_ID)).toBe(false);
    expect(unavailableLanguageDescriptors().map((d) => d.id)).toContain(KOJO_LANGUAGE_ID);
  });

  it('非 legacy 档不受影响：ERB / JSON / 2.0 在缺省谓词下照常认领', () => {
    expect(languageForPath('D:/x/note.ERB')).toBe(ERB_LANGUAGE_ID);
    expect(languageForPath('D:/x/settings.json')).toBe(JSON_LANGUAGE_ID);
    expect(languageForPath('D:/x/a.kojo2')).toBe('kojo2');
  });

  it('装一枚恒真谓词 ⇒ kojo1 立刻能认领（门是纯谓词，不增删注册项）', () => {
    installAvailabilityGate(() => true);
    expect(languageForPath('D:/x/a.kojo')).toBe(KOJO_LANGUAGE_ID);
    expect(availableLanguageDescriptors().some((d) => d.id === KOJO_LANGUAGE_ID)).toBe(true);
    expect(unavailableLanguageDescriptors()).toEqual([]);
  });

  it('谓词抛错 ⇒ 按不可用处理（落 plaintext 兜底），并把原因 warn 出来', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installAvailabilityGate(() => {
      throw new Error('boom');
    });
    expect(languageForPath('D:/x/a.kojo')).toBe(FALLBACK_LANGUAGE_ID);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('抛错'))).toBe(true);
    warn.mockRestore();
  });

  it('isLanguageIdAvailable：注册过的看门，没注册的不管（存量偏好里外部塞的 id 原样放行）', () => {
    expect(isLanguageIdAvailable(KOJO_LANGUAGE_ID)).toBe(false);
    expect(isLanguageIdAvailable(ERB_LANGUAGE_ID)).toBe(true);
    expect(isLanguageIdAvailable('some-unknown-id')).toBe(true);
    installAvailabilityGate(() => true);
    expect(isLanguageIdAvailable(KOJO_LANGUAGE_ID)).toBe(true);
  });

  it('§4.4 守门：门关上时已认领的 model 保持原语言，新开的落兜底', () => {
    // 已认领 kojo1 + 门关着 ⇒ 保持（不把在编文件刷成纯文本）
    expect(keepClaimedLanguageWhenGated(KOJO_LANGUAGE_ID, FALLBACK_LANGUAGE_ID)).toBe(KOJO_LANGUAGE_ID);
    // 建 model 那一刻（没有当前语言）⇒ 落兜底
    expect(keepClaimedLanguageWhenGated(undefined, FALLBACK_LANGUAGE_ID)).toBe(FALLBACK_LANGUAGE_ID);
    // 当前本来就是兜底 ⇒ 无变化
    expect(keepClaimedLanguageWhenGated(FALLBACK_LANGUAGE_ID, FALLBACK_LANGUAGE_ID)).toBe(FALLBACK_LANGUAGE_ID);
    // 目标不是兜底（例如内容指纹判成 2.0）⇒ 照常重挂，门不插手
    expect(keepClaimedLanguageWhenGated(KOJO_LANGUAGE_ID, 'kojo2')).toBe('kojo2');
    // 认不出的当前 id（外部塞的 / 已退役）⇒ 不参与守门
    expect(keepClaimedLanguageWhenGated('mystery-id', FALLBACK_LANGUAGE_ID)).toBe(FALLBACK_LANGUAGE_ID);
    // 门开着 ⇒ 照常落兜底（守门只管"目标被门拿掉"这一格）
    installAvailabilityGate(() => true);
    expect(keepClaimedLanguageWhenGated(KOJO_LANGUAGE_ID, FALLBACK_LANGUAGE_ID)).toBe(FALLBACK_LANGUAGE_ID);
  });

  it('id → 人读名：查得到给 label（作者面不再看见 `kojo-legacy` / `kojo-erb`），查不到原样交回', () => {
    expect(languageLabelForId(KOJO_LANGUAGE_ID)).toBe('kojo1（封存）');
    expect(languageLabelForId(ERB_LANGUAGE_ID)).toBe('ERB');
    expect(languageLabelForId(KOJO2_LANGUAGE_ID)).toBe('kojo');
    // 兜底 id 也有人话名（它不是 descriptor，但作者在状态栏读到的词要与设置页一致）
    expect(languageLabelForId(FALLBACK_LANGUAGE_ID)).toBe('纯文本');
    expect(languageLabelForId('mystery-id')).toBe('mystery-id');
  });

  it('不可用原因给两段人话（短句上屏 / 长句进 title），可用的返回 null', () => {
    const legacy = descriptorForLanguageId(KOJO_LANGUAGE_ID);
    expect(legacy).not.toBeNull();
    const reason = unavailableReason(legacy!);
    expect(reason?.short).toBe('已封存');
    expect(reason?.full).toContain('设置');
    expect(reason?.full).toContain('ui.legacy-kojo-syntax');
    installAvailabilityGate(() => true);
    expect(unavailableReason(legacy!)).toBeNull();
  });
});
