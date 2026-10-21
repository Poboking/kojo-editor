// @vitest-environment happy-dom
/**
 * EOL-OVERRIDE-SAVE 批：**保存面闭环**（宿主接线）。
 *
 * 与 `status-eol-switch.test.ts`（W7：UI + model 切换，保存面遗留）拼成全程取证：
 * 本批交付「显式切换 ⇒ `ModelEntry.eolOverride` 置位 ⇒ 保存时 `resolveSaveEolOverride`
 * 复核并随 `writeText` / `EditorSaveRequest` 递上 `{ eol }` ⇒ 落盘成功清位；
 * 重载 / 合并收场 / 外部冲突挂起复位；autosave 走同一条保存链（清位语义自然一致）」。
 *
 * 与 W7 那份同款理由：真 Monaco 的模块图在 happy-dom 里会挂 WebKit 剪贴板
 * workaround ⇒ 不渲染组件；用「纯函数单测 + 静态源断言」两半钉死接线。
 * （内核 `{ eol }` 落盘行为在 `kernel/tests/io-eol-override.test.ts`；`.kojo`
 * 接管透传在 `ui-sugar-editor/tests/save-handler-eol.test.ts`。）
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSaveEolOverride } from '../src/ui/editor-pane/pane-helpers';

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'),
  'utf8',
);
const HELPERS = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'editor-pane-registry.ts'),
  'utf8',
);

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string, source = SOURCE): string {
  const from = source.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

const SAVE_DETAILED = sliceBetween(
  'const savePathDetailed = useCallback(',
  'const reloadFromDiskRef',
);
const APPLY_RELOAD = sliceBetween(
  'const applyReload = (): void => {',
  "if (decision === 'reload' || forced)",
);
const CONFLICT_PENDING = sliceBetween(
  'externalConflictRef.current.add(path);',
  'if (!conflictPending) {',
);

/* ---------------- ① 纯函数：覆盖档 → 内核 eol 档（含"切了又撤销"复核） ---------------- */

describe('resolveSaveEolOverride：保存时点复核覆盖位', () => {
  it('缺席 = 无覆盖 ⇒ undefined（缺省 preserve，旧形状逐字不变）', () => {
    expect(resolveSaveEolOverride(undefined, '\r\n')).toBeUndefined();
    expect(resolveSaveEolOverride(undefined, '\n')).toBeUndefined();
  });

  it('覆盖位与 model 当前行尾一致 ⇒ 递上内核档（CRLF→crlf / LF→lf）', () => {
    expect(resolveSaveEolOverride('CRLF', '\r\n')).toBe('crlf');
    expect(resolveSaveEolOverride('LF', '\n')).toBe('lf');
  });

  it('覆盖位与 model 行尾不一致（Ctrl+Z 撤回切换）⇒ 位作废返回 undefined，退回缺省保存', () => {
    expect(resolveSaveEolOverride('CRLF', '\n')).toBeUndefined();
    expect(resolveSaveEolOverride('LF', '\r\n')).toBeUndefined();
  });
});

/* ---------------- ② 置位：只有显式切换才置位 ---------------- */

describe('switchEol 置位：显式切换即记覆盖位（savePathDetailed 之外唯一写位点）', () => {
  it('switchEol 在 entry.eol（UI 读数）之外同时记 entry.eolOverride = eol', () => {
    const switchEol = sliceBetween('const switchEol = useCallback(', '/**\n   * 以磁盘最新内容重载');
    expect(switchEol).toContain('entry.eol = eol');
    expect(switchEol).toContain('entry.eolOverride = eol');
  });

  it('ModelEntry 有覆盖位字段（editor-pane-registry）', () => {
    expect(HELPERS).toMatch(/eolOverride\?\s*:\s*'LF' \| 'CRLF'/);
  });
});

/* ---------------- ③ 保存接线：覆盖档随请求递上、成功清位 ---------------- */

describe('savePathDetailed 接线：覆盖档 → writeText / EditorSaveRequest，成功清位', () => {
  it('保存时点先复核：位在场但 model 行尾已不一致 ⇒ 位作废（退回缺省保存）', () => {
    expect(SAVE_DETAILED).toContain('resolveSaveEolOverride(entry.eolOverride, entry.model.getEOL())');
    expect(SAVE_DETAILED).toContain(
      'if (entry.eolOverride !== undefined && saveEol === undefined) entry.eolOverride = undefined;',
    );
  });

  it('缺省（非接管）分支：saveEol 在场才传第三参，且落盘成功清位', () => {
    expect(SAVE_DETAILED).toContain(
      'await kernel.io.writeText(path, text, saveEol ? { eol: saveEol } : undefined);',
    );
    expect(SAVE_DETAILED).toContain('entry.eolOverride = undefined;');
  });

  it('接管分支：EditorSaveRequest 随 saveEol 递上 eol（只约束源文件），成功清位', () => {
    expect(SAVE_DETAILED).toContain('...(saveEol ? { eol: saveEol } : {}),');
    expect(SAVE_DETAILED).toContain('entry.eolOverride = undefined;');
    // 清位先于 markSaved：位清干净后脏标记才翻转（顺序钉死）
    const clearIdx = SAVE_DETAILED.indexOf('entry.eolOverride = undefined;');
    const markIdx = SAVE_DETAILED.indexOf('markSaved(');
    expect(markIdx).toBeGreaterThan(clearIdx);
  });
});

/* ---------------- ④ 复位：重载 / 合并 / 外部冲突挂起 ---------------- */

describe('外部变更链复位：重载、合并收场、冲突挂起都清覆盖位', () => {
  it('reloadFromDisk 的 applyReload：位复位 + 状态栏 eol 跟盘上真相', () => {
    expect(APPLY_RELOAD).toContain('live.eolOverride = undefined;');
    expect(SOURCE).toContain("diskEol = tf.eol.toUpperCase() as 'CRLF' | 'LF';");
  });

  it('merge 收场：旧切换意图一并复位', () => {
    expect(SOURCE).toContain(
      'live.eolOverride = undefined; // 外部冲突以合并收场：旧切换意图一并复位（EOL-OVERRIDE-SAVE）',
    );
  });

  it('外部冲突挂起（conflict 窗口）：挂起即复位（后续无论怎么收场都不带旧档）', () => {
    expect(CONFLICT_PENDING).toContain('live.eolOverride = undefined;');
  });
});

/* ---------------- ⑤ autosave：同一条保存链，不单独清位 ---------------- */

describe('autosave 不清覆盖位：runAutosave 走 saveRef（同一条保存链），无独立复位点', () => {
  it('快照句柄（journal 快照，不落盘）不触碰覆盖位', () => {
    const snapshots = sliceBetween(
      'const snapshots = useCallback(',
      'const documentBroadcaster = useMemo(',
    );
    expect(snapshots).not.toContain('eolOverride');
    // 快照读数取**屏幕真相**（model 的档）：既不读覆盖位、也不清位。
    // 不用缓存 `entry.eol` —— 重载/混合行尾后它会与 model 分家（EOL-READOUT-TRUTH / PITFALLS 167）
    expect(snapshots).toContain('eol: modelEolOf(entry.model)');
    expect(snapshots, '崩溃恢复快照不许退回缓存档（会按错档重建 model）').not.toContain('eol: entry.eol');
  });

  it('savePathDetailed 之外不存在 autosave 专属的覆盖位复位（语义只归保存成功/重载链管）', () => {
    // 全文件复位点：savePathDetailed 3 处 + applyReload/merge/conflict 3 处 = 6；
    // 多出来的复位点 = autosave 私自清位（会丢掉"autosave 也带覆盖档落盘"的语义）
    expect(SOURCE.match(/eolOverride = undefined;/g)?.length).toBe(6);
  });
});
