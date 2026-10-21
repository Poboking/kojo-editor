// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIND_SEED_DEFAULT,
  loadFindSeedPref,
  saveFindSeedPref,
  subscribeFindSeedPref,
} from '../src/ui/find-pref';
import {
  FIND_BASELINE,
  editorOptionsForLineCount,
  findPrefPatch,
} from '../src/ui/editor-options';

/**
 * FIND-STATE-PERSIST-B（设置页「查找词优先」三档）：偏好真源 + monaco 选项映射 +
 * 切换档位不污染其余 find 字段的**实测**快照 + 作者面文案守卫。
 *
 * 第 ④ 组为什么直接 import vendor 的 `editorOptionsRegistry`：那条「传 `{find:{一字}}`
 * 会不会把 `find.loop` 等打回内建默认」的判据，测的就是 monaco 运行时真的走的那两个
 * 函数（`EditorFind.applyUpdate` + `validate`，`EditorConfiguration.updateOptions` 逐选项
 * 调它们）——不是复刻、不是桩；照 `monaco-find-patch-behavior.test.ts` 的先例从安装产物
 * 路径装载，vendor 漂移时本组先红。
 */

const PREF_LS_KEY = 'kojo.ui.findSeedPref.v1';

afterEach(() => {
  localStorage.removeItem(PREF_LS_KEY);
});

/* ---------------- ① 默认档就是 selection ---------------- */

describe('查找词优先偏好 · 默认档', () => {
  it('缺省常量与"没存过键"的读数都是 selection（用户 2026-10-21 拍板）', () => {
    expect(FIND_SEED_DEFAULT).toBe('selection');
    localStorage.removeItem(PREF_LS_KEY);
    expect(loadFindSeedPref()).toBe('selection');
  });

  it('三档写读往返逐字一致；存 ' + "'selection'" + '（缺省档）也落键——口径同折行的 tier', () => {
    for (const v of ['always', 'selection', 'never'] as const) {
      saveFindSeedPref(v);
      expect(loadFindSeedPref()).toBe(v);
      expect(localStorage.getItem(PREF_LS_KEY)).toBe(v);
    }
  });

  it('save 通知订阅者，退订后不再收（EditorPane 的偏好订阅与设置页共用一张表）', () => {
    let hits = 0;
    const off = subscribeFindSeedPref(() => {
      hits += 1;
    });
    saveFindSeedPref('never');
    expect(hits).toBe(1);
    off();
    saveFindSeedPref('always');
    expect(hits).toBe(1);
  });
});

/* ---------------- ② 三档映射到 monaco 选项逐字正确 ---------------- */

describe('findPrefPatch · 三档映射', () => {
  it('三档各自落 seedSearchStringFromSelection 登记值，且恒带整组（loop 随基线在场）', () => {
    for (const v of ['always', 'selection', 'never'] as const) {
      expect(findPrefPatch(v).find).toEqual({
        seedSearchStringFromSelection: v,
        loop: true,
      });
    }
  });

  it('缺省参数现读偏好（不手抄）：localStorage 落 never ⇒ 补丁给 never', () => {
    saveFindSeedPref('never');
    expect(findPrefPatch().find).toEqual({ seedSearchStringFromSelection: 'never', loop: true });
  });

  it('叠层压在档位表之后：三档样本（含 large/huge）find 同值 = 偏好档 + loop', () => {
    saveFindSeedPref('always');
    for (const n of [10, 9_000, 100_000]) {
      expect(editorOptionsForLineCount(n).find, String(n)).toEqual({
        seedSearchStringFromSelection: 'always',
        loop: true,
      });
    }
  });
});

/* ---------------- ③ 非法值 / 缺键 ⇒ 落回默认且不抛 ---------------- */

describe('loadFindSeedPref · 损坏口径', () => {
  it('脏值 / 大小写变体 / 空串一律回落 selection，绝不抛', () => {
    for (const bad of ['bogus', 'SELECTION', '', '  selection  ', 'null', '2']) {
      localStorage.setItem(PREF_LS_KEY, bad);
      expect(loadFindSeedPref(), bad).toBe('selection');
    }
  });

  it('读抛错（getItem 里 throw）也不抛进渲染链，落默认', () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('模拟隐私模式');
    };
    try {
      expect(loadFindSeedPref()).toBe('selection');
    } finally {
      Storage.prototype.getItem = real;
    }
  });
});

/* ---------------- ④ 陷阱实测：切换档位不污染其余 find 字段 ---------------- */

const EDITOR_OPTIONS_JS = 'vs/editor/common/config/editorOptions.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) return dir;
    const parent = `${dir}/..`;
    if (dir === parent) break;
    dir = parent;
  }
  return process.cwd();
}

function vendorEditorOptionsPath(): string {
  for (const base of [`${repoRoot()}/packages/app/node_modules`, `${repoRoot()}/node_modules`]) {
    const p = `${base}/monaco-editor/esm/${EDITOR_OPTIONS_JS}`;
    if (existsSync(p)) return p;
  }
  throw new Error('monaco-editor 产物不可达：pnpm install 没跑？');
}

interface VendorOption {
  name: string;
  defaultValue: Record<string, unknown>;
  applyUpdate(value: unknown, update: unknown): { newValue: unknown; didChange: boolean };
  validate(input: unknown): Record<string, unknown>;
}

async function vendorFindOption(): Promise<VendorOption> {
  const mod = (await import(pathToFileURL(vendorEditorOptionsPath()).href)) as {
    editorOptionsRegistry: VendorOption[];
  };
  const opt = mod.editorOptionsRegistry.find((o) => o.name === 'find');
  if (!opt) throw new Error('vendor registry 里没有 find 选项（升级漂移？）');
  return opt;
}

describe('updateOptions(find) 合并语义 · 真 vendor 函数实测', () => {
  it('只发一字：其余 find 字段逐字段零变化（applyUpdate 深合并 + validate 保留在场值）', async () => {
    const opt = await vendorFindOption();
    // 「改前」快照：create / applySizeTier 实际发给 monaco 的那份 find raw（findPrefPatch 全组）
    const rawBefore = structuredClone({ ...FIND_BASELINE.find, seedSearchStringFromSelection: 'selection' });
    const before = opt.validate(rawBefore);
    // 「改后」：运行中切档，补丁把整组再发一遍（实现走的就是这条路）
    const merged = opt.applyUpdate(structuredClone(rawBefore), {
      seedSearchStringFromSelection: 'never',
      loop: true,
    }).newValue as Record<string, unknown>;
    const after = opt.validate(merged);
    expect(after.seedSearchStringFromSelection).toBe('never');
    for (const key of Object.keys(before)) {
      if (key === 'seedSearchStringFromSelection') continue;
      expect(after[key], `切换档位把 find.${key} 打回了（前=${before[key]} 后=${after[key]}）`).toEqual(before[key]);
    }
  });

  it('对照组（陷阱本体）：validate 收到"缺字段的裸对象"时逐字段回落**内建默认**而非上一拍 ⇒ 补丁必须恒带整组', async () => {
    const opt = await vendorFindOption();
    // 模拟未来漂移：基线若加了非内建默认的值（这里拿 loop=false 当样本），
    // 而哪条路只发 `{seed}` 一字且 raw 里没有 find ⇒ validate 直接按内建默认补全。
    const bare = opt.validate({ seedSearchStringFromSelection: 'never' });
    expect(bare.loop).toBe(opt.defaultValue.loop); // 内建默认 true——不是谁的"上一拍"
    expect(bare.addExtraSpaceOnTop).toBe(opt.defaultValue.addExtraSpaceOnTop);
    // 内建默认与我们的基线今天恰好同值（loop: true），所以现状"看不出来"；
    // 这正是把整组携带写进 findPrefPatch 的理由：哪天基线改了值，裸发一字就会顶掉它。
    expect(opt.defaultValue.seedSearchStringFromSelection).toBe('always');
  });
});

/* ---------------- ⑤ 作者面文案守卫（静态读源码，照 key-yield-notice 先例） ---------------- */

describe('设置页「查找词优先」上屏文案 · 去黑话守卫', () => {
  // happy-dom 下 `import.meta.url` 不是 file: 协议（同 monaco-find-patch-behavior 的头注），
  // 源码一律从仓库根算路径读
  const panel = readFileSync(`${repoRoot()}/packages/app/src/ui/SettingsPanel.tsx`, 'utf8');
  const row = panel.slice(panel.indexOf('function FindPrefRow'), panel.indexOf('/** 右面板'));
  if (!row) throw new Error('FindPrefRow 锚点漂移——本守卫要跟着重写');
  const hint = row.slice(row.indexOf('settings-hint'), row.indexOf('</span>', row.indexOf('settings-hint')));

  it('三档措辞逐字在册，默认档在文案里看得出来', () => {
    expect(row).toContain('查找词优先');
    // 三档 label 住在 FIND_SEED_CHOICES（模块级常量），在整份源码里查
    expect(panel).toContain('仅用选中文字');
    expect(panel).toContain('总是用光标或选区');
    expect(panel).toContain('从不（用上次记住的）');
    expect(hint).toContain('默认「仅用选中文字」');
    // 默认档排分段第一位（顺序 = 认得出默认）
    expect(panel.indexOf("{ value: 'selection', label: '仅用选中文字' }")).toBeLessThan(
      panel.indexOf("{ value: 'always', label: '总是用光标或选区' }"),
    );
  });

  it('作者面零黑话：hint 里不许出现 seed / 焦点 / 选项键这类术语', () => {
    expect(hint.toLowerCase()).not.toContain('seed');
    expect(hint).not.toContain('焦点');
    expect(hint).not.toContain('选项键');
    expect(hint).not.toContain('光标所在词会覆盖');
  });

  it('接线在场：设置页订阅同一张偏好表（find-pref），编辑器订阅点在 use-editor-preferences', () => {
    expect(row).toContain('useFindSeedPref');
    const prefs = readFileSync(
      `${repoRoot()}/packages/app/src/ui/editor-pane/use-editor-preferences.ts`,
      'utf8',
    );
    expect(prefs).toContain('subscribeFindSeedPref');
    expect(prefs).toContain('ed.updateOptions(findPrefPatch())');
  });
});
