/**
 * LAU-3b：`.kojo1` 作为封存层显式扩展名的跨面钉子。
 *
 * 一条约定要在四个面上同时成立才算落地：
 * ① 路由：`.kojo1` 与阶段 / 正文无关，恒按 v1（`extension-kojo1`）；
 * ② 语言面：可用性门开 ⇒ `kojo-legacy`，门关 ⇒ `plaintext`（与 `.kojo` 同一条门）；
 * ③ 产物 / 台账：`resolveSugarTarget` 与引用台账都认这一枚；
 * ④ 迁移入口：`.kojo1` 仍可进 v1 → 2.0 迁移（它只是封存标记，不是另一种语法）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { resolveSugarTarget } from '@kojo/plugin-api';
import { installAvailabilityGate } from '../src/monaco/language-registry';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { languageFor } from '../src/ui/editor-model-pool';
import {
  decideKojo2Route,
  KOJO_V1_LEGACY_FILE_EXTENSION,
  KOJO2_FILE_EXTENSION,
} from '../src/ui/kojo2-cutover';
import { kojo2StageBlockedReason } from '../src/ui/kojo2-open-paths';
import { isMigrateCandidate } from '../src/ui/kojo2-migrate-entry';
import { isKojoSourcePath } from '../src/ui/reference-utils';
import { isQuickOpenSourcePath } from '../src/ui/commands';

const V1_TEXT = '角色: 灵梦\n时机 指令 310：\n「你好。」\n';
const KOJO2_TEXT = '# 机 指令 310\n灵梦：「你好。」\n';

afterEach(() => installAvailabilityGate(null));

describe('① 路由：`.kojo1` 恒按 v1，不给正文嗅探留翻面机会', () => {
  it.each(['v1-only', 'dual', '2.0-default'] as const)('阶段 %s', (stage) => {
    for (const source of [V1_TEXT, KOJO2_TEXT]) {
      const decision = decideKojo2Route({ stage, filePath: 'D:/p/a.kojo1', source });
      expect(decision).toEqual({
        kind: 'resolved',
        filePath: 'D:/p/a.kojo1',
        parser: 'kojo-v1',
        reason: 'extension-kojo1',
        fingerprint: null,
      });
    }
  });

  it('`.kojo1` 大写形态同样命中；`.kojo2` 仍归 2.0', () => {
    const legacy = decideKojo2Route({ stage: '2.0-default', filePath: 'D:/p/A.KOJO1' });
    expect(legacy).toMatchObject({ kind: 'resolved', parser: 'kojo-v1', reason: 'extension-kojo1' });
    const modern = decideKojo2Route({ stage: 'v1-only', filePath: 'D:/p/a.kojo2' });
    expect(modern).toMatchObject({ kind: 'resolved', parser: 'kojo2', reason: 'extension-kojo2' });
    expect(KOJO2_FILE_EXTENSION).toBe('.kojo2');
  });

  it('打开闸不拦 `.kojo1`（阶段闸只拦 v1-only 下显式钉成 2.0 的 override）', () => {
    expect(kojo2StageBlockedReason('D:/p/a.kojo1', { enabled: true, stage: 'v1-only' })).toBeNull();
  });

  it('封存扩展名常量只有一份（契约层）', () => {
    expect(KOJO_V1_LEGACY_FILE_EXTENSION).toBe('.kojo1');
  });
});

describe('② 语言面：同一道可用性门', () => {
  it('门开（v1 可用）⇒ `.kojo1` 认成 kojo-legacy', () => {
    installAvailabilityGate(() => true);
    expect(languageFor('D:/p/a.kojo1')).toBe(KOJO_LANGUAGE_ID);
    expect(languageFor('D:/p/A.KOJO1')).toBe(KOJO_LANGUAGE_ID);
    expect(languageFor('D:/p/a.kojo')).toBe(KOJO_LANGUAGE_ID);
  });

  it('门关（缺省档封印）⇒ 两枚都落 plaintext', () => {
    installAvailabilityGate((d) => d.availability !== 'legacy');
    expect(languageFor('D:/p/a.kojo1')).toBe('plaintext');
    expect(languageFor('D:/p/a.kojo')).toBe('plaintext');
  });
});

describe('③ 产物 / 台账 / 清单：`.kojo1` 与 `.kojo` 同级', () => {
  it('产物目标同目录同基名（`.kojo1` → `.ERB`）', () => {
    expect(resolveSugarTarget('D:/p/a.kojo1')).toBe('D:/p/a.ERB');
    expect(resolveSugarTarget('D:/p/A.KOJO1')).toBe('D:/p/A.ERB');
    expect(resolveSugarTarget('D:/p/a.kojo')).toBe('D:/p/a.ERB');
    expect(resolveSugarTarget('D:/p/a.kojo2')).toBeNull();
  });

  it('引用台账 / 快速打开 / 项目扫描都把 `.kojo1` 当源文件', () => {
    expect(isKojoSourcePath('D:/p/a.kojo1')).toBe(true);
    expect(isKojoSourcePath('D:/p/a.KOJO1')).toBe(true);
    expect(isQuickOpenSourcePath('D:/p/a.kojo1')).toBe(true);
    expect(isQuickOpenSourcePath('D:/p/A.KOJO1')).toBe(true);
  });
});

describe('④ 迁移入口：`extension-kojo1` 仍可迁到 2.0', () => {
  it('`isMigrateCandidate` 收 `.kojo1`，不收 `.kojo2` / `.erb`', () => {
    expect(isMigrateCandidate('D:/p/a.kojo1')).toBe(true);
    expect(isMigrateCandidate('D:/p/A.KOJO1')).toBe(true);
    expect(isMigrateCandidate('D:/p/a.kojo')).toBe(true);
    expect(isMigrateCandidate('D:/p/a.kojo2')).toBe(false);
    expect(isMigrateCandidate('D:/p/a.erb')).toBe(false);
  });
});
