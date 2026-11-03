import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileProject,
  createProjectFileIdentity,
  parseSource,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import { createEratwEmitBackend } from '../../src/kojo2/backend.js';
import { ERATW_CAPABILITY, ERATW_SOURCE_MAP } from '../../src/kojo2/capabilities.js';
import { ERATW_GAME_ADAPTER } from '../../src/kojo2/index.js';
import { ERATW_TARGET_REGISTRY } from '../../src/kojo2/target-registry.js';

const ROOT = fileURLToPath(new URL('../../../../../examples/m2-project/', import.meta.url));

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  adapterFactsVersion: '1',
  gameFingerprint: 'example',
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function inputOf(name: string, charNo: string): ProjectCompileFileInput {
  const path = `${ROOT}${name}`;
  const text = readFileSync(path, 'utf8');
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(text)),
    file: parseSource(text),
    sourceText: text,
    functionNameContext: { charNo, familySegment: '' },
  };
}

describe('M2 example project', () => {
  it('多文件：同 target 不同地点形成候选组，并各自产出 ERB', () => {
    const result = compileProject({
      projectId: 'm2-example',
      provenance: PROVENANCE,
      files: [inputOf('01-shrine.kojo2', '12'), inputOf('02-school.kojo2', '13')],
      registry: ERATW_TARGET_REGISTRY,
      adapter: ERATW_GAME_ADAPTER,
      backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.complete).toBe(true);
    expect(result.theaterErb).toHaveLength(2);
    expect(result.build.projectIR.files).toHaveLength(2);
    expect(result.build.projectIR.theaters).toHaveLength(2);
    expect(result.build.linkedProject?.groups).toHaveLength(1);
    expect(result.build.linkedProject?.groups[0]?.theaters).toHaveLength(2);
    expect(result.build.linkedProject?.groups[0]?.duplicate).toBe(false);
    expect(result.theaterErb[0]?.erb).toContain('M_KOJO_ENCOUNTER_K12');
    expect(result.theaterErb[1]?.erb).toContain('M_KOJO_ENCOUNTER_K13');
  });
});