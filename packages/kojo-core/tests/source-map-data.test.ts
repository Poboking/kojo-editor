/**
 * M2-P1 SourceMapData 纯数据投影测试（只读生产代码）：
 * - 真编译一个 Theater，经 Project IR 投影 unit.sourceMap；
 * - 版本 / lineCount / JSON roundtrip / 逐行与运行时 lineAt 对齐；
 * - 投影结果里没有任何函数值（可序列化事实，不是运行时对象）；
 * - 空 map 的稳定投影。
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectIR,
  compileKojoSource,
  createProjectFileIdentity,
  createSourceMapBuilder,
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  SOURCE_MAP_DATA_VERSION,
  toSourceMapData,
  type ProjectBuildProvenance,
  type SourceMapData,
} from '../src/index.js';

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: FIXTURE_ADAPTER.id,
  adapterVersion: FIXTURE_ADAPTER.version,
  adapterFactsVersion: 'fixture-facts-1',
  gameFingerprint: FIXTURE_ADAPTER.gameFingerprint.digest,
  targetRegistryId: 'fixture-registry',
  targetRegistryVersion: '1',
  backendId: FIXTURE_BACKEND.id,
  backendVersion: null,
  coreVersion: 'test',
  sourceMapPolicy: FIXTURE_ADAPTER.sourceMap,
  capability: FIXTURE_ADAPTER.capability,
};

/** 递归列出所有函数值路径；投影必须是纯数据，函数路径应为空。 */
function functionPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'function') return [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => functionPaths(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => functionPaths(item, `${path}.${key}`));
  }
  return [];
}

describe('SourceMapData · 真 Theater 投影', () => {
  it('版本/行数/JSON roundtrip/逐行等于 lineAt，且投影不含函数', () => {
    const source = ['【剧场：初见】', '> 甲正文', '> 乙正文', ''].join('\n');
    const compiled = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });
    const units = compiled.theaterUnits;
    const status = compiled.theaterUnitsStatus;
    if (units === undefined || status === undefined) {
      throw new Error('fixture 编译未产出 theaterUnits');
    }
    const unit = units[0];
    if (unit === undefined) {
      throw new Error('fixture 编译未产出预期的 Theater unit');
    }

    const identity = createProjectFileIdentity(
      '/project/theater.kojo2',
      '/project/theater.kojo2',
      null,
      'theater-hash',
    );
    const project = buildProjectIR({
      projectId: 'project-source-map',
      provenance: PROVENANCE,
      files: [
        {
          identity,
          file: compiled.file,
          lowering: { units, status },
        },
      ],
    });
    const theater = project.theaters[0];
    if (theater === undefined) {
      throw new Error('Project IR 未产出预期的 Theater');
    }
    const data = theater.sourceMapData;
    if (data === null) {
      throw new Error('Theater 有 unit 但 sourceMapData 为 null');
    }

    expect(data.version).toBe(SOURCE_MAP_DATA_VERSION);
    expect(data.lineCount).toBe(unit.sourceMap.lineCount);
    expect(data.lines).toHaveLength(unit.sourceMap.lineCount);
    expect(data).toEqual(toSourceMapData(unit.sourceMap));

    const roundtrip: unknown = JSON.parse(JSON.stringify(data));
    expect(roundtrip).toEqual(data);
    expect(functionPaths(data)).toEqual([]);

    for (let index = 0; index < data.lines.length; index++) {
      const projected = data.lines[index];
      const runtime = unit.sourceMap.lineAt(index + 1);
      if (projected === undefined || runtime === null) {
        throw new Error(`第 ${index + 1} 行缺少投影或运行时事实`);
      }
      expect(projected.generatedLine).toBe(runtime.generatedLine);
      expect(projected.kind).toBe(runtime.kind);
      expect(projected.source).toEqual(runtime.source);
      expect(projected.origins).toEqual(runtime.origins);
      expect(projected.segments).toEqual(runtime.segments ?? []);
    }
  });

  it('空 map 投影为版本化空 lines，可 JSON roundtrip 且不含函数', () => {
    const data = toSourceMapData(createSourceMapBuilder().build());

    const expected: SourceMapData = {
      version: SOURCE_MAP_DATA_VERSION,
      lineCount: 0,
      lines: [],
    };
    expect(data).toEqual(expected);
    expect(JSON.parse(JSON.stringify(data))).toEqual(expected);
    expect(functionPaths(data)).toEqual([]);
  });
});