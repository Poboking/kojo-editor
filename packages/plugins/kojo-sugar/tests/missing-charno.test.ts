/**
 * 回归（HIGH）：文件头缺 `角色:` 时必须**报错并拦写盘**。
 *
 * 旧行为：`charNo = ''` 一路进 codegen → 拼出 `@M_KOJO_ENCOUNTER_K` / `…_K_1`
 * 这种残缺函数名，登记函数整段静默跳过，诊断为空、`planSave.blocked === false`，
 * `compileToFile` 会把残缺产物覆盖到既有 `.ERB`。同理，纯文件头（无正文）的
 * `.kojo1` 会写出一份只有 3 字节 BOM 的 `.ERB`。
 *
 * 本批判据：`missing-charno`（error）在 codegen 前发出；空产物在源非空时报
 * `block-empty`（error）——**产物只有注释也算空产物**（`;` 注释按"注释不能丢"
 * 逐字进产物，`trim()` 判空会被它穿透；判据按行剥空白与注释后看有无内容）；
 * 两者都让 `planSave` / `compileToBytes` / `compileToFile` 在**任何 IO 之前**拒绝。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, SugarDiagnostic } from '@kojo/plugin-api';
import { SugarCompileError } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

const errorsOf = (src: string): SugarDiagnostic[] =>
  svc()
    .transpile(src)
    .diagnostics.filter((d) => d.severity === 'error');

const codesOf = (src: string): string[] => errorsOf(src).map((d) => d.code);

/** 任何属性访问即记为"触碰了 IO"的探针：守卫必须先于一切副作用 */
function untouchableIO(): { io: FileIO; touched: () => boolean } {
  let touched = false;
  const io = new Proxy({} as Record<string, unknown>, {
    get: () => () => {
      touched = true;
      return Promise.resolve(undefined);
    },
  });
  return { io: io as unknown as FileIO, touched: () => touched };
}

describe('HIGH · 缺/空 `角色:` → missing-charno（error，拦写盘）', () => {
  const missing = '时机 初见：\n\t「呀。」\n';

  it('缺 `角色:`：诊断含 missing-charno（error）', () => {
    const diags = svc().transpile(missing).diagnostics;
    const hit = diags.find((d) => d.code === 'missing-charno');
    expect(hit, '缺角色号零诊断（旧缺陷）').toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(hit!.message).toContain('角色:');
  });

  it('`角色:` 值为空：同样报 missing-charno', () => {
    expect(codesOf('角色:\n时机 初见：\n\t「呀。」\n')).toContain('missing-charno');
  });

  it('planSave 阻断（transpile-error），不假装可保存', () => {
    const plan = svc().planSave({ source: missing, sourcePath: '/proj/a.kojo1' });
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReason).toBe('transpile-error');
  });

  it('compileToBytes 拒绝（SugarCompileError）', () => {
    expect(() => svc().compileToBytes(missing)).toThrow(SugarCompileError);
  });

  it('compileToFile 在触碰任何 IO 之前就拒绝（不建目录/不备份/不写盘）', async () => {
    const { io, touched } = untouchableIO();
    const s = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable(), io });
    await expect(s.compileToFile(missing, '/proj/a.ERB')).rejects.toBeInstanceOf(SugarCompileError);
    expect(touched(), '守卫失效：已触碰 IO').toBe(false);
  });

  it('有 `角色:` 时不再误报，且结果暴露 charNo（预览据此取号）', () => {
    const ok = '角色: 12\n时机 初见：\n\t「呀。」\n';
    expect(codesOf(ok)).not.toContain('missing-charno');
    expect(svc().transpile(ok).charNo).toBe('12');
  });
});

describe('HIGH · 纯文件头（零产物）→ block-empty（error，拒绝写空 ERB）', () => {
  const frontMatterOnly = '角色: 12\n旁白色: 作者色\n';

  it('源非空却零产物：block-empty（error）', () => {
    const r = svc().transpile(frontMatterOnly);
    expect(r.erb.trim()).toBe('');
    const hit = r.diagnostics.find((d) => d.code === 'block-empty' && d.severity === 'error');
    expect(hit, '空产物零诊断（旧缺陷：写出只有 BOM 的 .ERB）').toBeDefined();
    expect(hit!.message).toContain('空产物');
  });

  it('planSave 阻断；compileToBytes 拒绝', () => {
    expect(svc().planSave({ source: frontMatterOnly, sourcePath: '/proj/a.kojo1' }).blocked).toBe(true);
    expect(() => svc().compileToBytes(frontMatterOnly)).toThrow(SugarCompileError);
  });

  it('空源/纯空白不算"零产物失败"（不误伤空文件）', () => {
    expect(codesOf('')).toEqual([]);
    expect(codesOf('  \n\t\n')).toEqual([]);
  });
});

describe('HIGH · 注释-only 源穿透空产物守门 → block-empty（error，拒绝写只有注释的 .ERB）', () => {
  // 取证（2026-10-21）：`;` 注释按"注释不能丢"逐字进产物 ⇒ `erb.trim()` 非空，
  // 旧守门（`erb.trim().length === 0`）把"只有注释的产物"判成非空 ⇒ 注释-only 的
  // `.kojo1` 零诊断穿过，`compileToFile` 会把只有注释的 `.ERB` 覆盖到目标位置——
  // 与空产物同害（零函数、零正文，覆盖既有产物）。修法：判空改成按行剥空白行与
  // ERB 注释行后看有没有剩余内容（`service.ts` 的 `erbHasContent`），产物不动。
  const commentOnly: Array<[string, string]> = [
    ['单行注释', '; 这只是注释\n'],
    ['多行注释', '; 注释一\n; 注释二\n'],
    ['注释+文件头角色号', '角色: 12\n; 注释\n'],
    ['注释+别名声明', '角色: 12\n别名 甲 = 1\n; 注释\n'],
  ];

  it.each(commentOnly)('%s：源非空、产物只有注释 ⇒ block-empty（error）', (_name, src) => {
    const r = svc().transpile(src);
    const hit = r.diagnostics.find((d) => d.code === 'block-empty' && d.severity === 'error');
    expect(hit, '注释-only 源零诊断穿过守门（旧缺陷）').toBeDefined();
    // 修法只动守门判据、不动产物：注释仍逐字在产物里（"注释不能丢"不被放宽）
    expect(r.erb).toContain(';');
    expect(
      r.erb.split('\n').some((l) => l.trim().length > 0 && !l.trim().startsWith(';')),
      '产物除了注释还有别的内容（判据剥过头了）',
    ).toBe(false);
  });

  it('planSave 阻断；compileToBytes 拒绝', () => {
    expect(svc().planSave({ source: '; 只有注释\n', sourcePath: '/proj/a.kojo1' }).blocked).toBe(true);
    expect(() => svc().compileToBytes('; 只有注释\n')).toThrow(SugarCompileError);
  });

  it('compileToFile 在触碰任何 IO 之前就拒绝（不建目录/不备份/不写盘）', async () => {
    const { io, touched } = untouchableIO();
    const s = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable(), io });
    await expect(s.compileToFile('; 只有注释\n', '/proj/a.ERB')).rejects.toBeInstanceOf(SugarCompileError);
    expect(touched(), '守卫失效：已触碰 IO').toBe(false);
  });

  it('不误伤：注释占满但确有正文 ⇒ 有明确产物，零 block-empty', () => {
    const src = '角色: 12\n; 文件说明\n时机 绝顶：\n\t「正文」\n; 行尾注释\n';
    const r = svc().transpile(src);
    expect(r.diagnostics.filter((d) => d.code === 'block-empty')).toEqual([]);
    expect(r.erb, '真函数头不在产物里').toContain('@');
    expect(r.erb, '注释被修法弄丢了（"注释不能丢"）').toContain('; 文件说明');
  });
});
