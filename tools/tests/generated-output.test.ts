/**
 * ALS-R3 验收工具产物卫生护栏（纯逻辑，不依赖引擎、不依赖真语料）。
 *
 * 锁两件事：
 *   ① 派生规则：`.generated.ERB` 与 `.generated.map.json` 必须成对同目录同基名（scene-run 的回映按
 *      「产物同名兄弟」找 map，拆开就断），落点在仓库外固定沙盒，且不同目录的同名夹具互不覆盖；
 *   ② 语料/游戏根写入门禁：目标落在受保护根之下必须**抛错**（负自证），而不是静默换路径。
 *
 * 路径一律用假路径 + `caseInsensitive: true` 显式指定，跨 host 平台结果一致。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 被测对象是仓库 node 工具（CJS 模块，非任何包）——只此一处，正向 src 层零引用。
import gen from '../generated-output.cjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '');
const GAME = 'C:/game/era-fake-corpus';
const CI = { caseInsensitive: true } as const;
const fwd = (p: string) => p.replace(/\\/g, '/');
const dirOf = (p: string) => fwd(p).slice(0, fwd(p).lastIndexOf('/'));

const toolSources: Record<string, string> = {
  'tools/clidbg-run.cjs': readFileSync(new URL('../clidbg-run.cjs', import.meta.url), 'utf8'),
  'tools/engine-loadtest.mjs': readFileSync(new URL('../engine-loadtest.mjs', import.meta.url), 'utf8'),
};

describe('generated-output · 产物落点派生', () => {
  it('默认落点 = 仓库外的固定沙盒（不用 os.tmpdir 的随机路径）', () => {
    expect(gen.DEFAULT_OUT_ROOT).toBe('C:/tmp/kojo-generated-erb');
    expect(fwd(gen.resolveOutRoot({}))).toBe('C:/tmp/kojo-generated-erb');
  });

  it('KOJO_GENERATED_DIR 覆盖落点根（QA 机换盘的出口）', () => {
    const env = { KOJO_GENERATED_DIR: 'D:/sandbox/gen' };
    expect(fwd(gen.resolveOutRoot(env))).toBe('D:/sandbox/gen');
    const d = gen.deriveGeneratedPaths('C:/repo/a.kojo', { env });
    expect(fwd(d.erbPath)).toMatch(/^D:\/sandbox\/gen\/a\.[0-9a-f]{10}\.generated\.ERB$/);
  });

  it('产物成对：同目录同基名，满足 scene-run 的「产物同名兄弟 map」约定', () => {
    const d = gen.deriveGeneratedPaths('C:/repo/tests/goldens/spec-6.1-lumia-310.kojo');
    expect(d.erbPath.endsWith('.generated.ERB')).toBe(true);
    expect(d.mapPath.endsWith('.generated.map.json')).toBe(true);
    expect(d.erbPath.replace(/\.generated\.ERB$/, '.generated.map.json')).toBe(d.mapPath);
    expect(dirOf(d.erbPath)).toBe(dirOf(d.mapPath));
  });

  it('确定性：同一输入两次派生完全一致', () => {
    const a = gen.deriveGeneratedPaths('C:/repo/x/spec-3.3-narration-default.kojo');
    const b = gen.deriveGeneratedPaths('C:/repo/x/spec-3.3-narration-default.kojo');
    expect(fwd(a.erbPath)).toBe(fwd(b.erbPath));
    expect(fwd(a.mapPath)).toBe(fwd(b.mapPath));
  });

  it('不撞名：不同目录的同名夹具各得一条路径（后跑的盖不掉先跑的）', () => {
    const one = gen.deriveGeneratedPaths('C:/repo/a/same.kojo');
    const two = gen.deriveGeneratedPaths('C:/repo/b/same.kojo');
    expect(one.erbPath).not.toBe(two.erbPath);
    expect(one.key).not.toBe(two.key);
  });

  it('落点在仓库外、也在输入旁边之外（仓库夹具与语料夹具都不例外）', () => {
    for (const input of [
      `${repoRoot}/packages/plugins/kojo-sugar/tests/goldens/spec-6.1-lumia-310.kojo`,
      `${GAME}/ERB/chara/00/90-kojo.kojo`,
    ]) {
      const d = gen.deriveGeneratedPaths(input);
      expect(gen.isWithin(d.erbPath, repoRoot, CI)).toBe(false);
      expect(gen.isWithin(d.mapPath, repoRoot, CI)).toBe(false);
      expect(gen.isWithin(d.erbPath, GAME, CI)).toBe(false);
      expect(gen.isWithin(d.erbPath, dirOf(d.input), CI)).toBe(false); // 不再落回「输入文件旁边」
    }
  });
});

describe('generated-output · 语料/游戏根写入门禁', () => {
  it('负自证：目标在语料根之内 / 就是语料根 → 抛错（绝不静默改路径）', () => {
    expect(() => gen.assertOutsideRoots(`${GAME}/ERB/00-generated.ERB`, [GAME], CI)).toThrow();
    expect(() => gen.assertOutsideRoots(`${GAME}/ERB/chara/00/x.generated.map.json`, [GAME], CI)).toThrow();
    expect(() => gen.assertOutsideRoots(GAME, [GAME], CI)).toThrow();
    try {
      gen.assertOutsideRoots(`${GAME}/ERB/x.generated.ERB`, [GAME], { ...CI, label: 'clidbg-run 产物' });
      throw new Error('不该走到这里（门禁没拦住）');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('clidbg-run 产物拒绝写盘');
      expect(msg).toContain(GAME);
      expect(msg).toContain('不做静默改写');
    }
  });

  it('大小写 / 反斜杠混写照样拦得住（Windows 语义）', () => {
    expect(() => gen.assertOutsideRoots('c:\\GAME\\ERA-fake-corpus\\erb\\x.generated.ERB', [GAME], CI)).toThrow();
  });

  it('不误伤同前缀兄弟目录（字符串前缀 bug 的回归位）', () => {
    expect(() => gen.assertOutsideRoots('C:/game/era-fake-corpusX/ERB/x.generated.ERB', [GAME], CI)).not.toThrow();
    expect(() => gen.assertOutsideRoots('C:/tmp/kojo-generated-erb/x.generated.ERB', [GAME, repoRoot], CI)).not.toThrow();
  });

  it('空受保护清单 = 无门禁对象，放行（本机没语料时工具照常可跑）', () => {
    expect(() => gen.assertOutsideRoots('C:/tmp/kojo-generated-erb/x.generated.ERB', [], CI)).not.toThrow();
  });

  it('多目标一并检查，任一命中即拒绝', () => {
    expect(() => gen.assertOutsideRoots(['C:/tmp/ok.generated.ERB', `${GAME}/bad.generated.map.json`], [GAME], CI)).toThrow();
  });
});

describe('generated-output · 两个工具已接上共享落点', () => {
  for (const [file, src] of Object.entries(toolSources)) {
    it(`${file}：走 deriveGeneratedPaths + assertOutsideRoots，不再往输入旁边写`, () => {
      expect(src).toContain('deriveGeneratedPaths');
      expect(src).toContain('assertOutsideRoots');
      expect(src).not.toMatch(/\+\s*'\.generated/);
      expect(src).not.toMatch(/\.generated\.map\.json'\s*\)/);
    });
  }
});
