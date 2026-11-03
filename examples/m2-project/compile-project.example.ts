/**
 * Kojo 2.0 M2：最小多文件项目编译示例。
 *
 * 这个文件只使用公共入口：
 * - `@kojo/kojo-core`：parseSource / createProjectFileIdentity / compileProject；
 * - `@kojo/plugin-api`：pathKey / stableHash（宿主身份事实）；
 * - `@kojo/plugin-eratw-adapter`：eraTW adapter / TargetRegistry / Backend。
 *
 * 运行说明见同目录 README.md。示例读取 01-shrine.kojo2 与 02-school.kojo2：
 * 两份文件同属「初见」canonical target，但地点不同，因此形成一个候选组而不是
 * exact duplicate；M2 为每个 Theater 生成单 Theater ERB，不生成最终 dispatch。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compileProject,
  createProjectFileIdentity,
  parseSource,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import {
  createEratwEmitBackend,
  ERATW_CAPABILITY,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '@kojo/plugin-eratw-adapter';

const ROOT = fileURLToPath(new URL('./', import.meta.url));

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: ERATW_GAME_ADAPTER.id,
  adapterVersion: ERATW_GAME_ADAPTER.version,
  adapterFactsVersion: '1',
  gameFingerprint: ERATW_GAME_ADAPTER.gameFingerprint.digest,
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function fileInput(name: string, charNo: string): ProjectCompileFileInput {
  const path = ROOT + name;
  const text = readFileSync(path, 'utf8');
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(text)),
    file: parseSource(text),
    sourceText: text,
    // 标准版显式空串；没有 family 事实时不要伪造 ''
    functionNameContext: { charNo, familySegment: '' },
  };
}

const result = compileProject({
  projectId: 'm2-example',
  provenance: PROVENANCE,
  files: [fileInput('01-shrine.kojo2', '12'), fileInput('02-school.kojo2', '13')],
  registry: ERATW_TARGET_REGISTRY,
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
});

if (result.build.buildStatus !== 'succeeded' || !result.complete) {
  console.error('M2 example failed:');
  for (const diagnostic of result.build.diagnostics) {
    console.error('- ' + diagnostic.kind + ': ' + diagnostic.message);
  }
  for (const diagnostic of result.backendDiagnostics) {
    console.error('- backend ' + diagnostic.code + ': ' + diagnostic.message);
  }
  process.exitCode = 1;
} else {
  const groups = result.build.linkedProject?.groups ?? [];
  console.log(
    'files=' +
      result.build.projectIR.files.length +
      ' theaters=' +
      result.build.projectIR.theaters.length +
      ' groups=' +
      groups.length,
  );
  for (const unit of result.theaterErb) {
    const firstLine = unit.erb.split('\n', 1)[0] ?? '';
    console.log(unit.theaterId + ': ' + firstLine);
  }
}