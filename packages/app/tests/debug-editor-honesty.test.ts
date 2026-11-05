/**
 * 调试面的编辑动作诚实性（ED-HONESTY 批，2026-11-06）。
 *
 * 现场（真机实拍，本批开场）：**只读项目**下 `__kojoDebug.editor.type('x')` 返回 `true`，
 * 而正文长度一点没变。根因不是猜的：Monaco 在 `readOnly` 时让 `executeEdits` 直接 `return false`
 * （编辑被静默丢弃），而 `install-debug.ts` 的旧实现**不看返回值**，执行完硬 `return true`。
 * 调试 API 是 agent 的"眼睛"：这个假绿让取证结论整体失效（本批真机烟测就被它误导过一次，
 * 当时的应对是在烟测里加长度对照来绕——那是绕，不是修）。
 *
 * 本文件钉四件事，全部**不依赖真 Monaco / 真浏览器**：
 * ① 判据纯函数 `editApplied(before, after)`：只有"值真的变了"才算成功（before===after ⇒ false；
 *   拿不到值 ⇒ false，不许把 null 当"变了"）；
 * ② 两条实现腿 `applyTypedEdit` / `applySetValue` 走**注入式**最小结构面，用假件就能把四条
 *   false 路径（只读吞编辑 / 报 true 但没落 / 抛错 / 无焦点编辑器）逐条跑出来；
 * ③ `editorReadOnly` 只认公开面 `getRawOptions().readOnly === true`，读不到 ⇒ false（不编造）；
 * ④ 源级闸：`info()` 必须交回 `readOnly`，两个编辑方法的实现体**只许**委托给核对过的腿
 *   （不许再出现裸 `executeEdits` / 裸 `model.setValue` / `return true` 的形态）。
 *
 * 为什么要在源级闸上再钉一刀（而不是只测纯函数）：真机那条假绿是**接线**造成的——纯函数再对，
 * 只要 `type()` 里还留着一句 `return true` 就照样撒谎。而真 editor 实例在 node 池里造不出来，
 * 所以"接线有没有绕过核对腿"只能用源码形状取证（与 `debug-set-cursor-shape.test.ts` 同一套口径）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applySetValue,
  applyTypedEdit,
  editApplied,
  editorReadOnly,
} from '../src/debug/install-debug';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const src = readFileSync(path.join(repoRoot, 'packages/app/src/debug/install-debug.ts'), 'utf8');

/** 按 signature 定位函数 / 方法体（花括号配对；本文件被测的函数体里没有会干扰配对的字符串）。 */
function bodyOf(signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `install-debug.ts 里应当有 ${JSON.stringify(signature)}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start + signature.length - 1);
  expect(open, `${signature} 后面应当有函数体`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`${signature} 的函数体没有收口`);
}

/* ------------------------------------------------------------------ *
 * ① editApplied：唯一判据 —— "值真的变了"
 * ------------------------------------------------------------------ */

describe('editApplied：只认「值真的变了」', () => {
  it('前后不同 ⇒ true（这是唯一的成功形态）', () => {
    expect(editApplied('甲', '甲乙')).toBe(true);
    expect(editApplied('', 'x')).toBe(true);
    expect(editApplied('x', '')).toBe(true);
  });

  it('before === after ⇒ false（只读吞编辑 / 空串插入 / 被别处弹回都落这一格）', () => {
    expect(editApplied('同文', '同文')).toBe(false);
    expect(editApplied('', '')).toBe(false);
  });

  it('逐字节比，不 trim 不做归一：只差一个空格 / 换行也算变了', () => {
    expect(editApplied('a', 'a ')).toBe(true);
    expect(editApplied('a', 'a\n')).toBe(true);
    expect(editApplied('a\n', 'a\r\n')).toBe(true);
    expect(editApplied('A', 'a')).toBe(true);
  });

  it('拿不到值（null / undefined / 数字 / 对象）⇒ false：不把「没读到」当成「变了」', () => {
    expect(editApplied(null, 'x')).toBe(false);
    expect(editApplied('x', null)).toBe(false);
    expect(editApplied(undefined, 'x')).toBe(false);
    expect(editApplied(null, null)).toBe(false);
    expect(editApplied(1, 2)).toBe(false);
    expect(editApplied({}, {})).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * ② applyTypedEdit：executeEdits 的布尔只是附加条件
 * ------------------------------------------------------------------ */

/** 一枚够用的假光标（1 基，与 Monaco `Position` 同形） */
const POS = { lineNumber: 2, column: 3 };

/**
 * 假编辑器工厂：
 * - `accepted`：`executeEdits` 自己回什么（只读项目实测回 false）；
 * - `apply`：编辑到底落不落进 model（红队用"回 true 但没落"来模拟别的失败通道）；
 * - `throws`：调用直接抛（版本差异的兜底路径）。
 */
function makeEditor(opts: {
  value?: string;
  position?: { lineNumber: number; column: number } | null;
  accepted?: boolean;
  apply?: boolean;
  throws?: boolean;
  noModel?: boolean;
}) {
  const state = { text: opts.value ?? '原文', calls: [] as { source: string; edits: unknown[] }[] };
  const model = {
    getValue: () => state.text,
    setValue: (next: string) => {
      state.text = next;
    },
  };
  const ed = {
    getModel: () => (opts.noModel ? null : model),
    getPosition: () => (opts.position === undefined ? POS : opts.position),
    executeEdits: (source: string, edits: unknown[]) => {
      state.calls.push({ source, edits });
      if (opts.throws) throw new Error('monaco rejected');
      if (opts.accepted === false) return false; // 只读：编辑被静默丢弃
      if (opts.apply !== false) state.text = `${state.text}!`; // 默认：真落进正文
      return true;
    },
  };
  return { ed, state };
}

describe('applyTypedEdit：执行后回读核对（false 的四条原因逐条可跑）', () => {
  it('只读：executeEdits 回 false、正文不动 ⇒ false（本批修的那条假绿）', () => {
    const { ed, state } = makeEditor({ accepted: false });
    expect(applyTypedEdit(ed, 'x')).toBe(false);
    expect(state.text).toBe('原文');
  });

  it('executeEdits 回 true 但正文没变 ⇒ 仍然 false（报 true 骗不过回读）', () => {
    const { ed } = makeEditor({ accepted: true, apply: false });
    expect(applyTypedEdit(ed, 'x')).toBe(false);
  });

  it('executeEdits 回 true 且正文真变了 ⇒ true', () => {
    const { ed, state } = makeEditor({ accepted: true });
    expect(applyTypedEdit(ed, '插入的文本')).toBe(true);
    expect(state.text.startsWith('原文')).toBe(true);
  });

  it('executeEdits 抛错 ⇒ false，且不把异常漏给调用方', () => {
    const { ed } = makeEditor({ throws: true });
    expect(() => applyTypedEdit(ed, 'x')).not.toThrow();
    expect(applyTypedEdit(ed, 'x')).toBe(false);
  });

  it('空串插入（回 true 也没有可核对的变化）⇒ false', () => {
    const { ed } = makeEditor({ accepted: true, apply: false });
    expect(applyTypedEdit(ed, '')).toBe(false);
  });

  it('无焦点编辑器 / 无 model / 无光标 ⇒ false（都不抛）', () => {
    expect(applyTypedEdit(null, 'x')).toBe(false);
    expect(applyTypedEdit(undefined, 'x')).toBe(false);
    const noModel = makeEditor({ noModel: true });
    expect(applyTypedEdit(noModel.ed, 'x')).toBe(false);
    const noPos = makeEditor({ position: null });
    expect(applyTypedEdit(noPos.ed, 'x')).toBe(false);
  });

  it('执行通道的形状：source=kojo-debug · 光标处零宽区间 · forceMoveMarkers · 文本原样', () => {
    const { ed, state } = makeEditor({ accepted: true });
    applyTypedEdit(ed, '  带空白\n的文本  ');
    expect(state.calls).toHaveLength(1);
    const [call] = state.calls;
    expect(call!.source).toBe('kojo-debug');
    expect(call!.edits).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 },
        text: '  带空白\n的文本  ',
        forceMoveMarkers: true,
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * ③ applySetValue：抛错 / 值没变都如实 false
 * ------------------------------------------------------------------ */

describe('applySetValue：整篇替换也走同一条核对判据', () => {
  it('写进去了 ⇒ true，且 model 收到原文（不 trim 不改写）', () => {
    const holder = { text: '旧' };
    const model = {
      getValue: () => holder.text,
      setValue: (next: string) => {
        holder.text = next;
      },
    };
    expect(applySetValue(model, '  新正文\n')).toBe(true);
    expect(holder.text).toBe('  新正文\n');
  });

  it('只读模型抛错 ⇒ false，且异常不外泄', () => {
    const model = {
      getValue: () => '旧',
      setValue: () => {
        throw new Error('read-only');
      },
    };
    expect(() => applySetValue(model, '新')).not.toThrow();
    expect(applySetValue(model, '新')).toBe(false);
  });

  it('setValue 静默不生效（值没变）⇒ false', () => {
    const model = { getValue: () => '旧', setValue: () => undefined };
    expect(applySetValue(model, '新')).toBe(false);
  });

  it('与当前值逐字相同 ⇒ false（没有可核对的变化，不冒充「我改了」）', () => {
    const holder = { text: '同一段' };
    const model = {
      getValue: () => holder.text,
      setValue: (next: string) => {
        holder.text = next;
      },
    };
    expect(applySetValue(model, '同一段')).toBe(false);
  });

  it('没有 model ⇒ false', () => {
    expect(applySetValue(null, 'x')).toBe(false);
    expect(applySetValue(undefined, 'x')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * ④ editorReadOnly：公开面读数，读不到不编造
 * ------------------------------------------------------------------ */

describe('editorReadOnly：只认公开面 getRawOptions().readOnly === true', () => {
  it('readOnly:true ⇒ true；false / 缺键 / 无方法 / 抛错 / 字符串 → 一律 false', () => {
    expect(editorReadOnly({ getRawOptions: () => ({ readOnly: true }) })).toBe(true);
    expect(editorReadOnly({ getRawOptions: () => ({ readOnly: false }) })).toBe(false);
    expect(editorReadOnly({ getRawOptions: () => ({}) })).toBe(false);
    expect(editorReadOnly({})).toBe(false);
    expect(editorReadOnly(null)).toBe(false);
    expect(editorReadOnly(undefined)).toBe(false);
    expect(
      editorReadOnly({
        getRawOptions: () => {
          throw new Error('boom');
        },
      }),
    ).toBe(false);
    // 读数是给脚本断言的：不猜真值，只有字面量 true 才算只读
    expect(editorReadOnly({ getRawOptions: () => ({ readOnly: 'true' as unknown as boolean }) })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 源级闸：接线不许绕过核对腿
 * ------------------------------------------------------------------ */

describe('源级闸：编辑族只剩「执行后核对」这一条路', () => {
  const infoBody = bodyOf('info() ');
  const typeBody = bodyOf('type(text) ');
  const setValueBody = bodyOf('setValue(text) ');
  const typedBody = bodyOf('export function applyTypedEdit(');
  const setValueLegBody = bodyOf('export function applySetValue(');

  it('type / setValue 的实现体只委托给核对腿，不再有裸编辑或硬 return true', () => {
    expect(typeBody).toContain('applyTypedEdit(');
    expect(setValueBody).toContain('applySetValue(');
    for (const body of [typeBody, setValueBody]) {
      // 只认**调用**形状（注释里提 executeEdits 是说明假绿起因，不算绕路）
      expect(body).not.toMatch(/\.executeEdits\(/);
      expect(body).not.toMatch(/\.setValue\(/);
      expect(body).not.toMatch(/return\s+true/);
    }
  });

  it('info() 交回 readOnly（只读事实与编辑返回值同屏可对账）', () => {
    expect(infoBody).toContain('readOnly: editorReadOnly(');
  });

  it('核对腿的顺序：先读 before，再执行，最后用 editApplied 判', () => {
    for (const body of [typedBody, setValueLegBody]) {
      const beforeAt = body.indexOf('const before = model.getValue()');
      expect(beforeAt, '必须先取 before').toBeGreaterThan(-1);
      expect(body.indexOf('editApplied(before, model.getValue())')).toBeGreaterThan(beforeAt);
    }
    // type 那条腿还要求：executeEdits 夹在 before 与判据之间，且它的返回值必须参与判据
    expect(typedBody.indexOf('executeEdits(')).toBeGreaterThan(typedBody.indexOf('const before = model.getValue()'));
    expect(typedBody).toContain('accepted && editApplied(');
  });

  it('editor 分面里没有任何一处绕开核对腿直接改正文', () => {
    const apiStart = src.indexOf('    editor: {');
    const apiEnd = src.indexOf('    invoke(cmd, args) {');
    expect(apiStart, '应当找得到 editor 分面').toBeGreaterThan(-1);
    expect(apiEnd, 'editor 分面后面应当是 invoke').toBeGreaterThan(apiStart);
    const apiBlock = src.slice(apiStart, apiEnd);
    expect(apiBlock).not.toMatch(/\.executeEdits\(/);
    expect(apiBlock).not.toMatch(/\.setValue\(/);
  });

  it('EditorInfo 契约带 readonly readOnly: boolean（additive，旧字段原样）', () => {
    const infoStart = src.indexOf('export interface EditorInfo {');
    const infoEnd = src.indexOf('\n}', infoStart);
    expect(infoStart).toBeGreaterThan(-1);
    expect(infoEnd).toBeGreaterThan(infoStart);
    const block = src.slice(infoStart, infoEnd);
    expect(block).toContain('readonly readOnly: boolean');
    for (const kept of ['readonly path: string', 'readonly languageId: string', 'readonly value: string']) {
      expect(block).toContain(kept);
    }
  });

  it('对外契约的 false 语义写在注释里（只读 / 无焦点编辑器 / Monaco 拒绝编辑）', () => {
    const apiStart = src.indexOf('    type(text: string): boolean;');
    expect(apiStart).toBeGreaterThan(-1);
    const doc = src.slice(Math.max(0, apiStart - 600), apiStart);
    expect(doc).toContain('只读');
    expect(doc).toContain('没有焦点编辑器');
    expect(doc).toContain('Monaco 拒绝编辑');
  });
});
