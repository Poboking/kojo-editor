/**
 * 函数树构建逻辑单测。
 *
 * 注意解耦铁律：这里用**测试专用**的 FamilyIndexRule（手写 mini 规则），
 * 不 import eratw-adapter——真实规则的覆盖验证在 kernel 集成冒烟里。
 */

import { describe, expect, it } from 'vitest';
import type { CharaInfo, ErbIndex, ErbFile, ErbFunction, FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';
import { buildNavigatorTree, functionTooltip, searchFunctions, shouldRebuildIndex } from '../src/tree';

/* ------------------------------ 测试基建 ------------------------------ */

function mk(
  kind: FamilyParseKind,
  family: string,
  no: number | null,
  face: string,
  slot: string,
): FamilyMatch {
  return {
    kind,
    prefix: 'M_KOJO',
    family,
    characterNo: no,
    selector: 0,
    face,
    sub: '',
    isMessageCheck: false,
    slot,
    isPlaceholder: kind === 'placeholder',
  };
}

/** mini 家族规则：覆盖 declare / 初始家族 / 具名家族 / KX 占位符 / 不匹配（结构与真实 parseKojoFamily 同构：前缀剥离 → K 锚点 → 头部分解） */
const fakeFamilyIndex: FamilyIndexRule = {
  name: 'fake',
  match(fnName: string): FamilyMatch | null {
    // declare：M_KOJO_K{n}[_{selector}]
    let m = /^M_KOJO_K(\d+)(?:_(\d+))?$/.exec(fnName);
    if (m) return mk('declare', '', Number(m[1]!), 'declare', '');
    // KX 占位符（编号未替换）
    if (/_KX(?:_|$)/.test(fnName)) return mk('placeholder', '', null, 'MESSAGE_COM', '30');
    // K 锚点：M_KOJO{head}_K{n}[_{slot}]
    m = /^(M_KOJO.*)_(K\d+)(?:_(.+))?$/.exec(fnName);
    if (!m) return null;
    const head = m[1]!.slice('M_KOJO'.length); // '' 或 '_xxx'
    const segs = head.split('_').filter(Boolean);
    // 面名 = 头部尾部的连续全大写段；其余为家族
    let start = segs.length;
    while (start > 0 && /^[A-Z0-9]+$/.test(segs[start - 1]!)) start--;
    const face = segs.slice(start).join('_');
    const family = segs.slice(0, start).join('_');
    return mk('ok', family, Number(m[2]!.slice(1)), face, m[3] ?? '');
  },
};

function makeIndex(files: Record<string, string[]>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map();
  for (const [path, fns] of Object.entries(files)) {
    const functions: ErbFunction[] = fns.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      params: [],
      startLine: i * 10 + 2,
      endLine: i * 10 + 9,
      filePath: path,
    }));
    map.set(path, { path, functions, dims: [], hasFunctionDirective: false, lineCount: fns.length * 10 + 5 });
  }
  return { files: map, byName };
}

const NO_CHARA = new Map<number, CharaInfo>();

/* ------------------------------ 用例 ------------------------------ */

describe('buildNavigatorTree', () => {
  it('三维聚合：角色 → 家族（初始家族用空串）→ 面', () => {
    const index = makeIndex({
      '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_30', 'M_KOJO_少女之梦_COLOR_K1'],
    });
    const tree = buildNavigatorTree(index, fakeFamilyIndex, NO_CHARA);
    expect(tree.charas).toHaveLength(1);
    const k1 = tree.charas[0]!;
    expect(k1.no).toBe(1);
    expect(k1.families.map((f) => f.family)).toEqual(['', '少女之梦']);
    expect(k1.families[0]!.faces[0]!.face).toBe('MESSAGE_COM');
    expect(k1.families[1]!.faces[0]!.face).toBe('COLOR');
    expect(k1.functionCount).toBe(2);
  });

  it('declare 形态单独成「declare」面', () => {
    const index = makeIndex({ '/p/a.ERB': ['M_KOJO_K1', 'M_KOJO_K1_2'] });
    const tree = buildNavigatorTree(index, fakeFamilyIndex, NO_CHARA);
    const faces = tree.charas[0]!.families[0]!.faces;
    expect(faces).toHaveLength(1);
    expect(faces[0]!.face).toBe('declare');
    expect(faces[0]!.functions.map((f) => f.name)).toEqual(['M_KOJO_K1', 'M_KOJO_K1_2']);
  });

  it('slot 按数值排序（2 < 30，字符串序会得出反结果）', () => {
    const index = makeIndex({
      '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_30', 'M_KOJO_MESSAGE_COM_K1_2'],
    });
    const tree = buildNavigatorTree(index, fakeFamilyIndex, NO_CHARA);
    const fns = tree.charas[0]!.families[0]!.faces[0]!.functions;
    expect(fns.map((f) => f.match!.slot)).toEqual(['2', '30']);
  });

  it('面按语义排序：FLAGSETTING 早于 MESSAGE_COM 早于未列表面', () => {
    const index = makeIndex({
      '/p/a.ERB': [
        'M_KOJO_ZZZ_CUSTOM_K1_1',
        'M_KOJO_MESSAGE_COM_K1_1',
        'M_KOJO_FLAGSETTING_K1',
      ],
    });
    const tree = buildNavigatorTree(index, fakeFamilyIndex, NO_CHARA);
    expect(tree.charas[0]!.families[0]!.faces.map((f) => f.face)).toEqual([
      'FLAGSETTING',
      'MESSAGE_COM',
      'ZZZ_CUSTOM',
    ]);
  });

  it('无法归属（KX 占位 / 非口上函数）只计数不进树', () => {
    const index = makeIndex({
      '/p/a.ERB': [
        'M_KOJO_MESSAGE_COM_K1_30',
        'M_KOJO_KX_MESSAGE_COM_KX_30',
        'SOME_GENERIC_UTILITY_FUNC',
      ],
    });
    const tree = buildNavigatorTree(index, fakeFamilyIndex, NO_CHARA);
    expect(tree.charas).toHaveLength(1);
    expect(tree.charas[0]!.functionCount).toBe(1);
    expect(tree.orphanCount).toBe(2);
    expect(tree.totalFunctions).toBe(3);
  });

  it('charaIndex 提供角色显示名', () => {
    const index = makeIndex({ '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_30'] });
    const charaIndex = new Map<number, CharaInfo>([[1, { no: 1, name: '霊夢' }]]);
    const tree = buildNavigatorTree(index, fakeFamilyIndex, charaIndex);
    expect(tree.charas[0]!.label).toBe('K1 霊夢');
    expect(tree.charas[0]!.name).toBe('霊夢');
  });

  it('无家族规则时树为空、全部计数为 orphan', () => {
    const index = makeIndex({ '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_30', 'FOO'] });
    const tree = buildNavigatorTree(index, null, NO_CHARA);
    expect(tree.charas).toHaveLength(0);
    expect(tree.orphanCount).toBe(2);
    expect(tree.hasFamilyIndex).toBe(false);
  });
});

describe('searchFunctions', () => {
  const index = makeIndex({
    '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_30', 'M_KOJO_KX_MESSAGE_COM_KX_30'],
    '/p/b.ERB': ['SOME_GENERIC_UTILITY_FUNC'],
  });

  it('大小写不敏感的子串匹配；未归属函数（KX）同样可搜', () => {
    const hits = searchFunctions(index, 'message_com_k1', fakeFamilyIndex);
    expect(hits.map((h) => h.node.name)).toEqual(['M_KOJO_MESSAGE_COM_K1_30']);
    expect(hits[0]!.charaNo).toBe(1);
    const kxHits = searchFunctions(index, 'kx_message', fakeFamilyIndex);
    expect(kxHits.map((h) => h.node.name)).toEqual(['M_KOJO_KX_MESSAGE_COM_KX_30']);
    expect(kxHits[0]!.charaNo).toBeNull();
  });

  it('短查询返回空；未匹配函数也能被搜到', () => {
    expect(searchFunctions(index, 's', fakeFamilyIndex)).toEqual([]);
    const hits = searchFunctions(index, 'generic_utility', fakeFamilyIndex);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.node.name).toBe('SOME_GENERIC_UTILITY_FUNC');
    expect(hits[0]!.charaNo).toBeNull();
  });

  it('尊重 limit 上限', () => {
    const big = makeIndex({
      '/p/a.ERB': Array.from({ length: 50 }, (_, i) => `M_KOJO_MESSAGE_COM_K1_${i + 1}`),
    });
    expect(searchFunctions(big, 'message_com', fakeFamilyIndex, 10)).toHaveLength(10);
  });
});

/* ==================== 建树去重（2026-10-12 内核优化批） ==================== */

describe('shouldRebuildIndex（project.opened 与 kojo.functionChanged 双触发的去重）', () => {
  it('同一索引实例 → 不重建（消掉开项目时白跑的第二遍建树）', () => {
    const idx = makeIndex({ '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_1'] });
    expect(shouldRebuildIndex(idx, idx)).toBe(false);
  });

  it('新索引实例 → 重建（索引真正变化后树必须刷新）', () => {
    const a = makeIndex({ '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_1'] });
    const b = makeIndex({ '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_1'] });
    expect(shouldRebuildIndex(a, b)).toBe(true);
  });

  it('与 null 的相互迁移：实例↔null 必重建；null↔null 不重建', () => {
    const idx = makeIndex({ '/p/a.ERB': ['M_KOJO_MESSAGE_COM_K1_1'] });
    expect(shouldRebuildIndex(null, idx)).toBe(true);
    expect(shouldRebuildIndex(idx, null)).toBe(true);
    expect(shouldRebuildIndex(null, null)).toBe(false);
  });
});

describe('functionTooltip · 悬停给注释不给行号（用户反馈 9）', () => {
  const shortPath = (p: string): string => p.replace(/^\/p\//, '');
  const base = { filePath: '/p/ERB/個人口上/001/a.ERB', startLine: 12, endLine: 40 };

  it('有注释时注释在最前——全大写长前缀的函数名，作者说明才是人要读的', () => {
    const t = functionTooltip(
      { ...base, docComment: '660,読書\nTFLAG:193(選択肢文学)' },
      shortPath,
    );
    expect(t).toBe('660,読書\nTFLAG:193(選択肢文学)\n\nERB/個人口上/001/a.ERB:12-40');
    expect(t.startsWith('660')).toBe(true);
  });

  it('无注释时退回原形态（路径:起-止），不硬凑空行', () => {
    expect(functionTooltip(base, shortPath)).toBe('ERB/個人口上/001/a.ERB:12-40');
  });

  it('定位信息始终保留在末尾——注释不能取代"这函数在哪个文件哪几行"', () => {
    const t = functionTooltip({ ...base, docComment: 'X' }, shortPath);
    expect(t).toContain('a.ERB:12-40');
  });
});
