/**
 * `loadProject` 装载结果 + adapter 对象的语义位（`conventions`）。
 *
 * 真盘用例以 `D:/Game/erafl` 存在为守卫（断言的是本机实测读数：134 个角色编号）；
 * 合成用例用内存盘钉合并策略——**CSV 名优先、只有目录的补条目**，这条策略换个
 * 工程版本也不会变，故不依赖真盘。
 *
 * 约定规则这组钉的是"**接上了**"而不是"算得对不对"：规则本身的判据由
 * `conventions.test.ts` 钉，这里只证明它在 adapter 对象上。
 */

import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FileIO, GameProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERAFL_NAME_GLOSSARY } from '../src/name-glossary';
import { ERAFL_STATE_LINES } from '../src/state-lines';
import { activateAdapter, nodeIo } from './harness';

const GAME_ROOT = 'D:/Game/erafl';
const hasCorpus = existsSync(GAME_ROOT);

/** 内存盘：只实现 loadProject 用到的 listDir / readText */
function memIo(files: Record<string, string>, dirs: readonly string[]): FileIO {
  // 同 detect.test：`join()` 在 win32 盘符下给 `\`，用例表按 `/` 写 ⇒ 入参统一归一化
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    listDir: async (rawPath: string) => {
      const path = norm(rawPath);
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const found = new Map<string, boolean>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest.includes('/')) found.set(rest, false);
      }
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        if (rest.length > 0 && !rest.includes('/')) found.set(rest, true);
      }
      return [...found].map(([name, isDirectory]) => ({ name, path: `${prefix}${name}`, isDirectory }));
    },
    readText: async (rawPath: string) => {
      const path = norm(rawPath);
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: 0 };
    },
  } as unknown as FileIO;
}

describe('loadProject —— 合成工程（合并策略）', () => {
  const ROOT = 'D:/mem/erafl';
  const CSV = `${ROOT}/CSV/Chara`;
  const KOJO = `${ROOT}/ERB/口上`;
  let proj: GameProject;

  beforeAll(async () => {
    const io = memIo(
      {
        [`${CSV}/Chara7_测试.csv`]: '番号,7,\n名前,测试角色,\n呼び名,小测,\n',
        // 口上域根上的公共文件：不是目录，必须跳过
        [`${KOJO}/_KOJO_SYSTEM.ERB`]: '; 公共系统文件\n',
      },
      [CSV, KOJO, `${KOJO}/7_测试角色`, `${KOJO}/5192_主人公口上_汎用_流され人妻`],
    );
    proj = await activateAdapter(io).loadProject(ROOT);
  });

  it('CSV 有的角色用 CSV 名；只有目录的角色用目录名补条目（共 2 条）', () => {
    expect(proj.charaIndex.size).toBe(2);
    expect(proj.charaIndex.get(7)?.name).toBe('测试角色');
    expect(proj.charaIndex.get(7)?.callName).toBe('小测');
    expect(proj.charaIndex.get(5192)?.name).toBe('主人公口上_汎用_流され人妻');
  });

  it('目录命中已有编号时只补 kojoDir，不覆盖 CSV 名', () => {
    expect(proj.charaIndex.get(7)?.kojoDir?.endsWith('7_测试角色')).toBe(true);
    expect(proj.charaIndex.get(5192)?.kojoDir?.endsWith('5192_主人公口上_汎用_流され人妻')).toBe(true);
  });

  it('路径口径：索引吃整个 ERB、可写面只有口上域；inputDigest 为 14 位十六进制', () => {
    expect(proj.rootDir).toBe(ROOT);
    expect(proj.adapterId).toBe('erafl');
    expect(proj.kojoPaths).toEqual([join(ROOT, 'ERB')]);
    expect(proj.writablePaths).toEqual([join(ROOT, 'ERB', '口上')]);
    expect(proj.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe('loadProject —— 真盘实测（守卫：D:/Game/erafl 存在才跑）', () => {
  let proj: GameProject;

  beforeAll(async () => {
    if (!hasCorpus) return;
    proj = await activateAdapter(nodeIo()).loadProject(GAME_ROOT);
  });

  it.skipIf(!hasCorpus)('134 个角色编号（36 份 CSV ∪ 129 个口上目录去重）', () => {
    expect(proj.charaIndex.size).toBe(134);
    expect(proj.charaIndex.get(0)?.name).toBe('你');
  });

  it.skipIf(!hasCorpus)('CSV 名优先：10 号显示「蒂娅」（目录名同形也不覆盖 CSV 名）', () => {
    const info = proj.charaIndex.get(10);
    expect(info?.name).toBe('蒂娅');
    expect(info?.kojoDir?.endsWith('10_蒂娅')).toBe(true);
  });

  it.skipIf(!hasCorpus)('只有口上目录的 1099 号用目录名补条目', () => {
    const info = proj.charaIndex.get(1099);
    expect(info?.name).toBe('うふふお姉さん');
    expect(info?.kojoDir?.endsWith('1099_うふふお姉さん')).toBe(true);
  });

  it.skipIf(!hasCorpus)('5xxx 主角口上目录解析出 5192 号', () => {
    const info = proj.charaIndex.get(5192);
    expect(info?.name).toBe('主人公口上_汎用_流され人妻');
    expect(info?.kojoDir?.endsWith('5192_主人公口上_汎用_流され人妻')).toBe(true);
  });

  it.skipIf(!hasCorpus)('同一工程连读两次 inputDigest 一致（目录枚举顺序不影响判据）', async () => {
    const again = await activateAdapter(nodeIo()).loadProject(GAME_ROOT);
    expect(again.inputDigest).toBe(proj.inputDigest);
  });
});

/* ------------------------------ 语义位：conventions ------------------------------ */

describe('adapter 的约定规则位（conventions）', () => {
  it('五条规则都挂在 adapter 上，id 与 conventions.ts 的常量逐条一致', () => {
    const adapter = activateAdapter(nodeIo());
    // 规则是纯读盘能力装配的（io 的三个只读方法），不需要工程 ⇒ 未打开项目也在
    expect(adapter.conventions?.map((rule) => rule.id)).toEqual([
      'erafl.kojo-xml.unregistered',
      'erafl.kojo-xml.missing-file',
      'erafl.kojo-define.missing-name',
      'erafl.kojo-define.duplicate-number',
      'erafl.kojo-xml.encoding-mismatch',
    ]);
  });
});

/* --------------------- 展示位：nameGlossary / stateLinePresets --------------------- */

describe('adapter 的展示位（名字对照 / 剧情线）', () => {
  it('nameGlossary 挂在 adapter 上，且是同一份静态表（消费方：FileTree 的 gloss）', () => {
    const adapter = activateAdapter(nodeIo());
    // 静态表：不需要工程、不随 loadProject 重建
    expect(adapter.nameGlossary).toBe(ERAFL_NAME_GLOSSARY);
    expect(adapter.nameGlossary?.['ティア']).toBe('蒂娅');
  });

  it('stateLinePresets 挂在 adapter 上（消费方：条件矩阵的剧情线快选）', () => {
    const adapter = activateAdapter(nodeIo());
    expect(adapter.stateLinePresets).toBe(ERAFL_STATE_LINES);
    expect(adapter.stateLinePresets?.map((line) => line.id)).toEqual([
      'favor',
      'depend',
      'servile',
      'dominate',
      'acquaint',
    ]);
  });
});
