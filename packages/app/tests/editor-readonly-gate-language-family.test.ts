/**
 * 编辑器只读门的**语言面**（ERB-PARITY G6）——门按 descriptor 声明铺开，不按语言 id 分支。
 *
 * 旧判据是 `isErbDialectPath(path) && …`：只有 ERB 方言进写保护，2.0 的 `.kojo` / `.kojo2`
 * 与封存档的 `.kojo1` 漏在门外——游戏目录里它们默认**可编辑**，可保存又必然被写允许域拒掉
 * （作者改了一屏、按保存才发现存不出去；ADR-0005 的"游戏目录默认只读"对它们不成立）。
 *
 * 现在：`LanguageDescriptor.gameDirReadOnly` 声明"这份语言的盘上文件是作者源文件"，
 * 唯一出口 `sourceReadOnlyGate`（`monaco/language-guard.ts`）。本文件钉三件：
 * 1. 声明面：ERB / kojo1 / kojo2 三枚声明了，JSON / 口上 XML 这类数据格式面**没**声明；
 * 2. 真值表：受保护源文件在游戏目录 ∧ 未解锁才锁，工作区 / 解锁 / 直连一律不锁；
 * 3. 判据是**声明**而不是名单：新注册一门声明了保护位的语言，门自动跟上（宿主零改动）。
 */

import { describe, expect, it } from 'vitest';
import { registerLanguage, languageDescriptors } from '../src/monaco/language-registry';
import { isGuardedGameSourcePath, sourceReadOnlyGate } from '../src/monaco/language-guard';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import '../src/monaco/languages';

const GAME = 'C:\\Game\\ERB';

describe('声明面：哪些语言声明了「游戏目录默认只读」', () => {
  it('ERB / kojo1 / kojo2 都声明了（作者源文件）', () => {
    const declared = languageDescriptors()
      .filter((d) => d.gameDirReadOnly === true)
      .map((d) => d.id)
      .sort();
    expect(declared).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID].sort());
  });

  it('JSON / 口上 XML 不声明（数据格式面不进写保护门）', () => {
    for (const id of ['json', 'kojo-xml']) {
      const d = languageDescriptors().find((x) => x.id === id);
      expect(d, id).toBeDefined();
      expect(d!.gameDirReadOnly, id).toBeUndefined();
      expect(isGuardedGameSourcePath(`${GAME}\\a.${id === 'json' ? 'json' : 'xml'}`), id).toBe(false);
    }
  });
});

describe('只读门真值表（ADR-0005 两轴 × 语言面）', () => {
  const paths = [
    'C:\\Game\\ERB\\口上.ERB',
    'C:\\Game\\ERB\\口上.erh',
    'C:\\Game\\kojo\\事件.kojo',
    'C:\\Game\\kojo\\事件.kojo2',
    'C:\\Game\\kojo\\事件.kojo1',
  ];

  it('游戏目录 + 未解锁 ⇒ 锁（kojo 家族不再漏判）', () => {
    for (const p of paths) expect(sourceReadOnlyGate(p, { inWorkspace: false, canEdit: false }), p).toBe(true);
  });

  it('作者工作区 / 会话内解锁 / 直连可编辑 ⇒ 不锁', () => {
    for (const p of paths) {
      expect(sourceReadOnlyGate(p, { inWorkspace: true, canEdit: false }), p).toBe(false);
      expect(sourceReadOnlyGate(p, { inWorkspace: false, canEdit: true }), p).toBe(false);
    }
  });

  it('非源文件（.md / .json / .xml / .erd 留位）⇒ 不锁', () => {
    for (const p of ['C:\\Game\\readme.md', 'C:\\Game\\cfg.json', 'C:\\Game\\口上.xml', 'C:\\Game\\x.ERD']) {
      expect(sourceReadOnlyGate(p, { inWorkspace: false, canEdit: false }), p).toBe(false);
    }
  });

  it('封存档不可用也照样保护 `.kojo1`（保护位跟路径走，不跟可用性）', () => {
    // 缺省档 `2.0-default` 下 kojo1 不可认领（认领落 plaintext），但盘上文件仍是作者源文件
    expect(isGuardedGameSourcePath('C:\\Game\\kojo\\legacy.KOJO1')).toBe(true);
  });
});

describe('判据是声明面而不是手写名单', () => {
  it('新注册一门声明了保护位的语言 ⇒ 门自动跟上（宿主零改动）', () => {
    expect(isGuardedGameSourcePath('C:\\Game\\a.tlang')).toBe(false);
    registerLanguage({
      id: 'parity-g6-probe',
      label: 'G6 探针语言',
      matchesPath: (p) => p.toLowerCase().endsWith('.tlang'),
      register: () => undefined,
      gameDirReadOnly: true,
    });
    expect(isGuardedGameSourcePath('C:\\Game\\a.tlang')).toBe(true);
    expect(sourceReadOnlyGate('C:\\Game\\a.tlang', { inWorkspace: false, canEdit: false })).toBe(true);
  });
});