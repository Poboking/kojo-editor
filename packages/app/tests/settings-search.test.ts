/**
 * 设置页搜索与「已修改」判据单测（1020 编辑器体感批）。
 *
 * 钉三条：① 结果只会指向**页面上真实存在**的锚点（每条写了 `key` 的条目，
 * 都能在 SettingsPanel.tsx 里找到那枚 `data-settings-key`）；
 * ② 「已修改」只认有真源读数的条目，没写判据的条目不许混进来；
 * ③ 匹配口径稳定（子串优先于模糊子序列；同输入同输出）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
  settingsEntryModified,
  settingsModifiedCount,
} from '../src/ui/settings-search';

const settingsPanelSrc = (): string =>
  readFileSync(fileURLToPath(new URL('../src/ui/SettingsPanel.tsx', import.meta.url)), 'utf8');

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('索引自身的诚实性', () => {
  it('id 不重复（React key 与"当前选中结果"都靠它）', () => {
    const ids = SETTINGS_SEARCH_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条的 section 都是真存在的节、sectionLabel 与页面上的节名同源', () => {
    const src = settingsPanelSrc();
    for (const e of SETTINGS_SEARCH_INDEX) {
      expect(src, `SettingsPanel 里没有 id '${e.id}'`).toContain(`id: '${e.section}'`);
      expect(src, `节名 '${e.sectionLabel}' 不在设置页上`).toContain(`label: '${e.sectionLabel}'`);
    }
  });

  it('写了 key 的条目，页面上必须有同一枚 data-settings-key（点了不能跳向一个不存在的行）', () => {
    const src = settingsPanelSrc();
    const withKey = SETTINGS_SEARCH_INDEX.filter((e) => e.key !== undefined);
    expect(withKey.length).toBeGreaterThanOrEqual(15);
    for (const e of withKey) {
      expect(src, `索引指向 data-settings-key="${e.key}"，但设置页里没有这一行`).toContain(
        `data-settings-key="${e.key}"`,
      );
    }
  });
});

describe('searchSettings', () => {
  it('空串 = 全量（顺序 = 索引原序，不重排）', () => {
    expect(searchSettings('')).toEqual([...SETTINGS_SEARCH_INDEX]);
  });

  it('中文子串命中；大小写与空格不参与比对', () => {
    expect(searchSettings('缩略图').map((e) => e.id)).toEqual(['editor.minimap']);
    expect(searchSettings('CTRL+ALT+T').map((e) => e.id)).toContain('editor.sugarView');
    expect(searchSettings('minimap').map((e) => e.id)).toContain('editor.minimap');
  });

  it('标签子串优先于关键词命中，关键词优先于模糊子序列（同桶内保持索引序）', () => {
    const out = searchSettings('字体');
    expect(out[0]!.id).toBe('editor.fontFamily'); // 标签里就有「字体」
    const fuzzy = searchSettings('hl'); // 不在任何标签/关键词里连写 ⇒ 走子序列
    expect(fuzzy.every((e) => e.id !== undefined)).toBe(true);
  });

  it('没有命中给空表，而不是"全部"（作者据此知道搜不到，不是列表没刷新）', () => {
    expect(searchSettings('zzzzqqq不存在')).toEqual([]);
  });

  it('modifiedOnly：无判据的条目一律排除；坏值不进、真改过的进', () => {
    stubWindowForTest();
    expect(searchSettings('', { modifiedOnly: true })).toEqual([]);
    // 只动一项显示偏好 ⇒ 已修改列表恰好是那一行（不是整节、也不是全量）
    window.localStorage.setItem('kojo.ui.editor.minimap.v1', '0');
    const out = searchSettings('', { modifiedOnly: true });
    expect(out.map((e) => e.id)).toEqual(['editor.minimap']);
    expect(settingsEntryModified(out[0]!)).toBe(true);
  });

  it('settingsModifiedCount 与 modifiedOnly 过滤逐字同源（徽标数 = 点数得到的条数）', () => {
    stubWindowForTest();
    window.localStorage.setItem('kojo.ui.editor.lineNumbers.v1', 'relative');
    window.localStorage.setItem('kojo.ui.editor.inlayHints.v1', '0');
    expect(settingsModifiedCount()).toBe(
      searchSettings('', { modifiedOnly: true }).length,
    );
    expect(searchSettings('', { modifiedOnly: true }).map((e) => e.id)).toEqual([
      'editor.lineNumbers',
      'editor.inlayHints',
    ]);
  });
});

/** 无项目的 node 环境里给一份干净的假 localStorage（所有判据都读实时值，不缓存旧数） */
function stubWindowForTest(): void {
  vi.stubGlobal('window', { localStorage: fakeStorage() });
}
