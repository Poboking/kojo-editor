/**
 * ERB 指令 ISA 规约契约（`isa.yaml` 生成区间）。
 *
 * 钉三件事：快照 sha（EOL 归一化）、生产表 ↔ 真源逐条对拍、查表按别名可达且不猜。
 * ISA 里的 `argForm` / `semantics` / `errors` 是引擎原话（prose + 行锚），
 * 本闸**不**把它们转成可判定条件——那一步必须有 C# 锚，另案。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERB_ENGINE_ERROR_TEXTS, ERB_INSTRUCTION_SPECS, erbInstructionSpecOf } from '../src/erb';

const SNAPSHOT_URL = new URL('../../../tools/data/isa.yaml', import.meta.url);
const SNAPSHOT_SHA256 = '71817091585fcd7463f870e0a74cdf1c85da5f321bb1022a41b1019a4c5d1cc3';
const FIELDS = ['kind', 'arg_form', 'semantics', 'errors', 'display_effect', 'source', 'aliases', 'register', 'confidence', 'flag', 'flag_source'];

function scalar(v: string): string {
  const s = v.trim();
  if (s === "''" || s === '""') return '';
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function parseSnapshot() {
  const text = readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8').replace(/\r\n?/g, '\n');
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of text.split('\n')) {
    const start = /^- name: (.+)$/.exec(line);
    if (start) {
      if (cur) out.push(cur);
      cur = { name: scalar(start[1]!) };
      continue;
    }
    if (!cur) continue;
    const kv = /^  ([a-z_]+): (.*)$/.exec(line);
    if (kv && FIELDS.includes(kv[1]!)) cur[kv[1]!] = scalar(kv[2]!);
  }
  if (cur) out.push(cur);
  return { text, out };
}

describe('ERB 指令 ISA ↔ eratw specs/isa.yaml', () => {
  it('快照 sha 逐字钉住（EOL 归一化后算）', () => {
    const { text } = parseSnapshot();
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(SNAPSHOT_SHA256);
  });

  it('快照全量 177 / 266 / 64；生产表 = 悬停可达面 72 条，双向不漏不收', () => {
    const { out } = parseSnapshot();
    expect(out).toHaveLength(177);
    expect(out.reduce((n, e) => n + (e.aliases ? e.aliases.split(',').length : 0), 0)).toBe(266);
    expect(out.filter((e) => (e.errors ?? '') !== '').length).toBe(64);

    const dirSrc = readFileSync(
      fileURLToPath(new URL('../../plugins/erb-parser/src/instructions.ts', import.meta.url)), 'utf8',
    );
    const dFrom = dirSrc.indexOf('export const ERB_STATEMENT_DIRECTIVES');
    const directiveSet = new Set(
      (dirSrc.slice(dFrom, dirSrc.indexOf('];', dFrom)).match(/'[A-Z_0-9]+'/g) ?? []).map((s) => s.slice(1, -1)),
    );
    const reachable = out.filter((e) =>
      [e.name, ...(e.aliases ? e.aliases.split(',') : [])].some((n) => directiveSet.has((n ?? '').trim().toUpperCase())),
    );
    expect(reachable).toHaveLength(72);
    expect(ERB_INSTRUCTION_SPECS).toHaveLength(72);

    for (const src of reachable) {
      const got = ERB_INSTRUCTION_SPECS.find((s) => s.name === src.name);
      expect(got, src.name).toBeDefined();
      expect(got!.kind).toBe(src.kind);
      expect(got!.argForm).toBe(src.arg_form ?? '');
      expect(got!.semantics).toBe(src.semantics ?? '');
      expect(got!.errors).toBe(src.errors ?? '');
      expect(got!.source).toBe(src.source ?? '');
      expect(got!.aliases).toEqual(src.aliases ? src.aliases.split(',').map((a) => a.trim()) : []);
    }
    for (const got of ERB_INSTRUCTION_SPECS) {
      expect([got.name, ...got.aliases].some((n) => directiveSet.has(n.toUpperCase())), got.name).toBe(true);
    }
  });

  it('别名查表：SETBIT / CLEARBIT / INVERTBIT 同指一条，带 0-63 位域原话', () => {
    const spec = erbInstructionSpecOf('SETBIT');
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('variable');
    expect(spec!.argForm).toBe('BitArgument (BIT_ARG)');
    expect(spec!.errors).toContain('0-63');
    expect(spec!.aliases).toEqual(['SETBIT', 'CLEARBIT', 'INVERTBIT']);
    expect(erbInstructionSpecOf(' clearbit ')).toBe(spec);
    expect(erbInstructionSpecOf('invertbit')).toBe(spec);
    expect(erbInstructionSpecOf('NO_SUCH_INSTRUCTION')).toBeUndefined();
  });

  it('ISA errors 里点名的错误键确实在 error-texts 表里', () => {
    for (const key of ['NotEnoughArguments', 'IncorrectArg']) {
      expect(ERB_ENGINE_ERROR_TEXTS[key], key).toBeDefined();
    }
  });
});
