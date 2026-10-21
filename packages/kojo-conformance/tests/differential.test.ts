/**
 * differential 归一化与逐行 diff：BOM / EOL / 整行注释不构成行为；
 * 失败摘要必须能指到产物行，并（有 source map 时）指回源行。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '@kojo/kojo-core';
import {
  compareArtifacts,
  diffArtifactLines,
  normalizeArtifact,
  runAdapterConformance,
  summarizeLineDiff,
} from '../src/index.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const BASIC = read('basic.kojo2');
const BASIC_GOLDEN = read('basic.golden.erb');

describe('normalizeArtifact · 去 BOM / EOL / 整行注释', () => {
  it('CRLF + BOM + `;`/`//` 注释 + 空行 → 行为行', () => {
    const baseline = '\uFEFFMACHINE 开场\r\n;SLOT __x\r\nTELL: 甲 /WAIT\r\n\r\n// note\r\nMACHINE.END\r\n';

    const normalized = normalizeArtifact(baseline);

    expect(normalized.hadBom).toBe(true);
    expect(normalized.eol).toBe('crlf');
    expect(normalized.lines).toEqual(['MACHINE 开场', 'TELL: 甲 /WAIT', 'MACHINE.END']);
    expect(normalized.removedComments).toBe(2);
    expect(normalized.removedBlankLines).toBe(1);
    expect(normalized.originalLineCount).toBe(6);
  });

  it('stripComments=false 时 `;` 行参与比较；dropBlankLines=false 时空行保留', () => {
    const normalized = normalizeArtifact('; note\n\nA\n', {
      stripComments: false,
      dropBlankLines: false,
    });

    expect(normalized.lines).toEqual(['; note', '', 'A']);
    expect(normalized.removedComments).toBe(0);
    expect(normalized.removedBlankLines).toBe(0);
  });

  it('只有注释/空行的旧产物归一化为空序列', () => {
    const result = compareArtifacts('; only comments\n\n// still comments\n', '');

    expect(result.equal).toBe(true);
    expect(result.baseline.lines).toEqual([]);
    expect(result.candidate.lines).toEqual([]);
    expect(result.summary).toEqual({ same: 0, removed: 0, added: 0 });
  });
});

describe('diffArtifactLines · 逐行摘要', () => {
  it('中间一行变化 → same/removed/added/same，摘要计数与首个差异可定位', () => {
    const diff = diffArtifactLines(['A', 'B', 'C'], ['A', 'B2', 'C']);
    const summary = summarizeLineDiff(diff);

    expect(diff.map((item) => item.kind)).toEqual(['same', 'removed', 'added', 'same']);
    expect(summary).toEqual({ same: 2, removed: 1, added: 1 });
    expect(diff[1]).toMatchObject({ kind: 'removed', baselineLine: 2, artifactLine: null });
    expect(diff[2]).toMatchObject({ kind: 'added', baselineLine: null, artifactLine: 2 });
  });

  it('空 baseline / 空 candidate 都退化为纯新增 / 纯删除', () => {
    expect(diffArtifactLines([], ['A', 'B']).map((item) => item.kind)).toEqual(['added', 'added']);
    expect(diffArtifactLines(['A', 'B'], []).map((item) => item.kind)).toEqual(['removed', 'removed']);
  });
});

describe('kit differential · 旧产物行为序列 vs 2.0 产物', () => {
  it('旧产物带 BOM/CRLF/注释，行为序列与 2.0 一致 → 通过', () => {
    const legacy = `\uFEFF${BASIC_GOLDEN.replace(/\n/g, '\r\n').replace('TELL:', '; 旧版注释\r\nTELL:')}`;

    const report = runAdapterConformance({
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
      cases: [
        {
          kind: 'differential',
          name: 'legacy basic',
          source: BASIC,
          baseline: legacy,
        },
      ],
    });

    expect(report.ok).toBe(true);
    const reading = report.cases[0]?.observations.differential;
    expect(reading?.equal).toBe(true);
    expect(reading?.baselineLines).toBe(7);
    expect(reading?.candidateLines).toBe(7);
    expect(reading?.summary).toEqual({ same: 7, removed: 0, added: 0 });
    expect(reading?.firstDifferenceLine).toBeNull();
  });

  it('行为序列漂移 → conformance/differential；摘要 + 产物行 + 源行定位', () => {
    const report = runAdapterConformance({
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
      cases: [
        {
          kind: 'differential',
          name: 'legacy mismatch',
          source: BASIC,
          baseline: BASIC_GOLDEN.replace('/WAIT', '/CONT'),
        },
      ],
    });

    expect(report.ok).toBe(false);
    const failure = report.failures.find((item) => item.code === 'conformance/differential');
    expect(failure).toBeDefined();
    expect(failure?.location.case).toBe('legacy mismatch');
    expect(failure?.location.field).toBe('baseline');
    expect(failure?.location.artifactLine).toBe(2);
    expect(failure?.location.sourceLine).toBe(4);
    expect(failure?.message).toContain('同 6 / 缺 1 / 多 1');
    expect(failure?.diff.some((item) => item.kind === 'removed')).toBe(true);
    expect(failure?.diff.some((item) => item.kind === 'added')).toBe(true);
    expect(report.cases[0]?.observations.differential?.firstDifferenceLine).toBe(2);
  });
});
