/**
 * 回归（HIGH）：文件头缺 `角色:` 时必须**报错并拦写盘**。
 *
 * 旧行为：`charNo = ''` 一路进 codegen → 拼出 `@M_KOJO_ENCOUNTER_K` / `…_K_1`
 * 这种残缺函数名，登记函数整段静默跳过，诊断为空、`planSave.blocked === false`，
 * `compileToFile` 会把残缺产物覆盖到既有 `.ERB`。同理，纯文件头（无正文）的
 * `.kojo` 会写出一份只有 3 字节 BOM 的 `.ERB`。
 *
 * 本批判据：`missing-charno`（error）在 codegen 前发出；空产物在源非空时报
 * `block-empty`（error）；两者都让 `planSave` / `compileToBytes` / `compileToFile`
 * 在**任何 IO 之前**拒绝。
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
    const plan = svc().planSave({ source: missing, sourcePath: '/proj/a.kojo' });
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
    expect(svc().planSave({ source: frontMatterOnly, sourcePath: '/proj/a.kojo' }).blocked).toBe(true);
    expect(() => svc().compileToBytes(frontMatterOnly)).toThrow(SugarCompileError);
  });

  it('空源/纯空白不算"零产物失败"（不误伤空文件）', () => {
    expect(codesOf('')).toEqual([]);
    expect(codesOf('  \n\t\n')).toEqual([]);
  });
});
