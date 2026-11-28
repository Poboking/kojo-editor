/**
 * 引擎分档数据契约（`erb-engine-profiles.ts` ⇄ `tools/data/engine-profiles.yaml` 快照）。
 *
 * 真源 eratw `specs/engine-profiles.yaml`：四档引擎（v24 / em_ee / snake / cs_reference）
 * 的函数/指令面、条件注册（VARI/VARS）、语句面推导（commands ∪ functions，METHOD fallback
 * 回填每个表达式函数），以及四个跨档行为开关（`dialect.*`）——其中
 * `string_compare_ge_le` 就是 1.824 系把字符串 `>=`/`<=` 都编成 `(c<0)` 的官方 bug
 * （v24/cs_reference = bug，em_ee/snake = fixed），每档带 C# 行锚与差分实验凭据。
 *
 * 本判据钉：sha 指纹、四档计数、条件注册条件串、语句面并集自证、开关逐档取值。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERB_ENGINE_DIALECT_SWITCHES,
  ERB_ENGINE_PROFILE_HONKE_1824_NOTE,
  ERB_ENGINE_PROFILES,
  ERB_ENGINE_PROFILES_SHA256,
  erbEngineStatementFace,
} from '../src/erb-engine-profiles';

const SNAPSHOT = new URL('../../../tools/data/engine-profiles.yaml', import.meta.url);
const sha256EolNormalized = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');

const byId = new Map(ERB_ENGINE_PROFILES.map((p) => [p.id, p]));
const SCOPED_SWITCH = 'JSONConfig.Data.UseScopedVariableInstruction';

describe('引擎分档数据契约（真源 eratw specs/engine-profiles.yaml）', () => {
  it('快照 sha（EOL 归一）与生成常量逐字相符', () => {
    expect(ERB_ENGINE_PROFILES_SHA256).toBe(sha256EolNormalized(readFileSync(SNAPSHOT, 'utf8')));
  });

  it('恰四档：v24 / em_ee / snake / cs_reference；honke_1824 无树只留注记', () => {
    expect([...byId.keys()].sort()).toEqual(['cs_reference', 'em_ee', 'snake', 'v24']);
    expect(ERB_ENGINE_PROFILE_HONKE_1824_NOTE).toContain('do not assume v24 == honke');
  });

  it('函数/指令计数与 meta.counts 相符', () => {
    const counts: Record<string, [number, number]> = {
      cs_reference: [271, 302],
      em_ee: [266, 303],
      snake: [349, 326],
      v24: [160, 265],
    };
    for (const [id, [fn, cmd]] of Object.entries(counts)) {
      expect(byId.get(id)!.functions, `${id}.functions`).toHaveLength(fn);
      expect(byId.get(id)!.commands, `${id}.commands`).toHaveLength(cmd);
    }
  });

  it('条件注册：v24 无条件；其余档 VARI/VARS ↔ UseScopedVariableInstruction', () => {
    expect(byId.get('v24')!.conditionalCommands).toEqual({});
    for (const id of ['cs_reference', 'em_ee', 'snake']) {
      expect(byId.get(id)!.conditionalCommands, id).toEqual({
        VARI: SCOPED_SWITCH,
        VARS: SCOPED_SWITCH,
      });
    }
  });

  it('语句面 = commands ∪ functions，与 registration.statements.count 自证相符', () => {
    const counts: Record<string, number> = { cs_reference: 567, em_ee: 563, snake: 669, v24: 419 };
    for (const [id, count] of Object.entries(counts)) {
      const p = byId.get(id)!;
      expect(p.statements.count, `${id}.statements.count`).toBe(count);
      expect(erbEngineStatementFace(id).length, `${id} 并集`).toBe(count);
      expect(p.statements.derivation).toContain('METHOD fallback');
      expect(p.statements.anchor).toContain('FunctionIdentifier.cs');
    }
  });

  it('四个行为开关（dialect.*）逐档取值与真源相符', () => {
    const sw = new Map(ERB_ENGINE_DIALECT_SWITCHES.map((s) => [s.id, s]));
    expect([...sw.keys()].sort()).toEqual([
      'getnum_nickname_mastername',
      'isnumeric_v24_fix',
      'relation_mastername',
      'string_compare_ge_le',
    ]);
    // 1.824 系官方 bug：字符串 >= / <= 都编成 (c<0)
    expect(sw.get('string_compare_ge_le')!.values).toEqual({
      cs_reference: 'bug',
      em_ee: 'fixed',
      snake: 'fixed',
      v24: 'bug',
    });
    expect(sw.get('getnum_nickname_mastername')!.values).toEqual({
      cs_reference: false,
      em_ee: false,
      snake: false,
      v24: true,
    });
    expect(sw.get('relation_mastername')!.values).toEqual({
      cs_reference: false,
      em_ee: true,
      snake: false,
      v24: true,
    });
    expect(sw.get('isnumeric_v24_fix')!.values).toEqual({
      cs_reference: 'fixed',
      em_ee: 'fixed',
      snake: 'fixed',
      v24: 'fixed',
    });
  });

  it('每个开关逐档带 C# 锚；差分实验的两支带 evidence 凭据', () => {
    for (const s of ERB_ENGINE_DIALECT_SWITCHES) {
      for (const id of ['cs_reference', 'em_ee', 'snake', 'v24']) {
        expect(s.anchors[id], `${s.id} @ ${id}`).toMatch(/\.cs:\d/);
      }
    }
    expect(
      ERB_ENGINE_DIALECT_SWITCHES.find((s) => s.id === 'string_compare_ge_le')!.evidence,
    ).toContain('Differential run');
    expect(
      ERB_ENGINE_DIALECT_SWITCHES.find((s) => s.id === 'getnum_nickname_mastername')!.evidence,
    ).toContain('Differential run');
  });

  it('snake 面探针：SETANIMETIMER / HTML_PRINTC 在档；v24 面无 HTML_PRINTC', () => {
    const snake = new Set(erbEngineStatementFace('snake'));
    const v24 = new Set(erbEngineStatementFace('v24'));
    expect(snake.has('SETANIMETIMER')).toBe(true);
    expect(snake.has('HTML_PRINTC')).toBe(true);
    expect(v24.has('HTML_PRINTC')).toBe(false);
  });
});
