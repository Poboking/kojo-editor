/**
 * kojo1 插件激活门（LAU-3b）——两条断言：
 *
 * 1. **判据**：切流阶段 `2.0-default` ⇒ 不装；`v1-only` / `dual` ⇒ 装（用户 2026-10-27 口径
 *    「kojo-sugar 插件不得激活，除非显式启用 kojo1」）。判据只读 `isKojoLegacySyntaxEnabled`，
 *    本文件不另写阶段解析。
 * 2. **装配根真的照它做**：`bootstrap.ts` 里那四枚插件必须走 `legacyImport(() => import(...))`
 *    的包法，且不许有"裸 import 漏网"；同时 `legacy-plugin-gate` 只能**动态**取（静态 import
 *    会把切流控制器拖进开机静态图）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getKojo2CutoverController,
  resetKojo2CutoverController,
  type Kojo2CutoverStorage,
} from '../src/ui/kojo2-cutover';
import { LEGACY_PLUGIN_IDS, legacyPluginFamilyEnabled } from '../src/ui/legacy-plugin-gate';

/** 只实现 `Kojo2CutoverStorage` 允许的三格（与 `kojo2-cutover.test.ts` 同形） */
class MemoryStorage implements Kojo2CutoverStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const BOOTSTRAP = readFileSync(new URL('../src/bootstrap.ts', import.meta.url), 'utf8');

afterEach(() => resetKojo2CutoverController());

describe('kojo1 插件激活门：显式启用 kojo1 才装那一家', () => {
  it('阶段判据：2.0-default 不装，v1-only / dual 装', () => {
    resetKojo2CutoverController();
    const controller = getKojo2CutoverController();
    controller.attachStorage(new MemoryStorage());

    controller.setStage('2.0-default');
    expect(legacyPluginFamilyEnabled()).toBe(false);

    controller.setStage('dual');
    expect(legacyPluginFamilyEnabled()).toBe(true);

    controller.setStage('v1-only');
    expect(legacyPluginFamilyEnabled()).toBe(true);

    controller.setStage('2.0-default');
    expect(legacyPluginFamilyEnabled()).toBe(false);
  });

  it('装配根：四枚插件全部走 legacyImport 包法，没有裸 import 漏网', () => {
    for (const id of LEGACY_PLUGIN_IDS) {
      expect(BOOTSTRAP).toContain(`legacyImport(() => import('@kojo/plugin-${id}'))`);
    }
    // 行首直接 `import('@kojo/plugin-<legacy>')` = 绕过了门（包法那一行以 `legacyImport(` 开头）
    const bare = new RegExp(
      `^\\s*import\\('@kojo\\/plugin-(?:${LEGACY_PLUGIN_IDS.join('|')})'\\)`,
      'm',
    );
    expect(BOOTSTRAP).not.toMatch(bare);
  });

  it('门的真源只许动态取：bootstrap 不许静态 import 切流控制器', () => {
    expect(BOOTSTRAP).not.toMatch(/^import\s[^;]*from\s+'\.\/ui\/kojo2-flag'/m);
    expect(BOOTSTRAP).toContain(`await import('./ui/legacy-plugin-gate')`);
  });
});
