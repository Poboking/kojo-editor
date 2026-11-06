// @vitest-environment happy-dom
/**
 * B3 批（LaneO，2026-11-06）`editor.*` 五枚编辑器写 / 光标腿的行为回归。
 *
 * 口径：测的是**接线后的腿表**（`createRunSupplemental` 的 `ioTools`，即生产同一张表），
 * 不是孤立工厂函数——名字拼错 / 漏进表 / seam 没透传，都会在这里红。
 * 真源 = `debug/install-debug.ts` 的实现腿（applySetValue / applyTypedEdit /
 * normalizeCursorTarget / editorReadOnly），pane 反查经 `getEditorPane` seam 注入。
 *
 * 钉死的判据（交付判据 C 逐条）：
 * ① paneId 不存在 ⇒ 显式 `NOT_WIRED` + `[E_EDITOR_PANE_GONE]`，**绝不回 applied:true 冒充**；
 * ② 只读编辑器 ⇒ 内容写两枚显式 `PERMISSION_DENIED` + `[E_EDITOR_READ_ONLY]` 且**正文一字节没变**
 *    （既有真源 `editorReadOnly(ed)` 口径；绝不"成功但值没变"那记假绿）；
 *    光标 / 选区 / 视口三枚只读态照常可执行（不动正文，与 Monaco 自身语义一致）；
 * ③ setValue / type 成功必须**回读核对**：值真变了才算成功，与原文逐字相同 ⇒ 显式
 *    `[E_EDITOR_APPLY_UNVERIFIED]`；
 * ④ 脏值入参（非整数 / 0 / 负 / 越界 / 字符串）⇒ 显式 `INVALID_ARGS`，且 **setPosition /
 *    setSelection / revealLine 零调用**（不许喂进真源）；
 * ⑤ 成功回报必带 `dirty:true` + `saved:false` + `persisted:false`（磁盘没动必须写明），
 *    且 kernel.io 写原语 / invoke / bus.emit **零触达**（铁律 5/6/7：本批零新增写盘通道）；
 * ⑥ 内容类腿 undo：`editor.type` 一次 Ctrl+Z 退得掉（一次 executeEdits = 一个撤销步）；
 * ⑦ 跨会话不串味：两个 pane 各拿各的模型，写 A 不动 B；糖投影（派生视图）显式拒；
 * ⑧ WebView registry 档位：read 会话调五枚即 PERMISSION_DENIED（腿零触达）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { createMcpCapabilityRegistry, type McpReaderFn, type McpSessionScope } from '@kojo/mcp-host';
import { createRunSupplemental, type McpIoDeps } from '../src/mcp/real-sources-io';
import { createEditorWriteLegs, type EditorWritePaneHandle } from '../src/mcp/editor-write-legs';

const EDITOR_TOOLS = [
  'editor.setValue',
  'editor.type',
  'editor.setCursor',
  'editor.setSelection',
  'editor.revealLine',
] as const;

const editScope: McpSessionScope = {
  sessionId: 'sess-a',
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: [],
  approvedTools: [],
};
const readScope: McpSessionScope = { ...editScope, tier: 'read' };
const otherScope: McpSessionScope = { ...editScope, sessionId: 'sess-b' };

/* =============================== 假 pane / 真 model rig =============================== */

interface Rig {
  readonly paneId: string;
  readonly model: monaco.editor.ITextModel;
  readonly editor: FakeEditor;
  readonly handle: EditorWritePaneHandle;
  /** 把脏基线推到当前版本（= 「刚保存过」），readDirty 随即如实回 false。 */
  markSaved(): void;
}

interface FakeEditor {
  getModel(): unknown;
  getPosition(): { lineNumber: number; column: number };
  setPosition(p: { lineNumber: number; column: number }): void;
  getSelection(): Record<string, number>;
  setSelection(r: Record<string, number>): void;
  executeEdits(source: string, ops: readonly unknown[]): boolean;
  revealLine(l: number): void;
  revealLineInCenter(l: number): void;
  revealLineNearTop(l: number): void;
  getRawOptions(): { readOnly?: boolean };
  readonly calls: {
    setPosition: number;
    setSelection: number;
    reveal: string[];
    executeEdits: number;
  };
  readonly caret: { line: number; column: number };
}

const models: monaco.editor.ITextModel[] = [];
let uriSeq = 0;

/**
 * 一个「开着文档的编辑器实例」：model 用真 Monaco（脏态 / 行数 / 列上界 / 撤销栈
 * 都是真读数，不靠假件自报），editor 是转发桩（光标 / 选区 / 视口状态自己记）。
 */
function makeRig(text: string, opts: { readOnly?: boolean; sugar?: boolean } = {}): Rig {
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(`file:///D:/proj/doc${++uriSeq}.kojo`),
  );
  models.push(model);
  const calls = { setPosition: 0, setSelection: 0, reveal: [] as string[], executeEdits: 0 };
  const caret = { line: 1, column: 1 };
  let sel: Record<string, number> = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  // 脏态基线：与 `EditorPane.computeDirty` 同一表达式（alternativeVersionId !== baseline）。
  let baseline = model.getAlternativeVersionId();

  const editor: FakeEditor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: caret.line, column: caret.column }),
    setPosition: (p) => {
      calls.setPosition += 1;
      caret.line = p.lineNumber;
      caret.column = p.column;
    },
    getSelection: () => sel,
    setSelection: (r) => {
      calls.setSelection += 1;
      sel = { ...r };
    },
    executeEdits: (_source, ops) => {
      calls.executeEdits += 1;
      const operations = (ops as { range: monaco.IRange; text: string | null; forceMoveMarkers?: boolean }[]).map(
        (op) => ({
          range: new monaco.Range(
            op.range.startLineNumber,
            op.range.startColumn,
            op.range.endLineNumber,
            op.range.endColumn,
          ),
          text: op.text,
          forceMoveMarkers: op.forceMoveMarkers ?? true,
        }),
      );
      const last = operations[operations.length - 1];
      // 真 Monaco 的 `editor.executeEdits` 返回「这次编辑到底落了没有」：假件同判据
      // （值变了 ⇒ true；被拒 / 空操作 ⇒ false），腿里还叠一层回读核对，两层都在测。
      const before = model.getValue();
      model.pushEditOperations(null, operations, () => null);
      const ok = model.getValue() !== before;
      if (ok && last && last.text) {
        // Monaco 会把光标带到插入文本末尾：假件同样如实前移。
        const lines = last.text.split('\n');
        caret.line = lines.length > 1 ? last.range.endLineNumber + lines.length - 1 : last.range.endLineNumber;
        caret.column =
          lines.length > 1 ? (lines[lines.length - 1] ?? '').length + 1 : last.range.startColumn + (last.text ?? '').length;
      }
      return ok;
    },
    revealLine: (l) => {
      calls.reveal.push(`revealLine:${l}`);
    },
    revealLineInCenter: (l) => {
      calls.reveal.push(`revealLineInCenter:${l}`);
    },
    revealLineNearTop: (l) => {
      calls.reveal.push(`revealLineNearTop:${l}`);
    },
    getRawOptions: () => ({ readOnly: opts.readOnly === true }),
    calls,
    caret,
  };

  const handle: EditorWritePaneHandle = {
    editor,
    // 派生视图闸：sugarModel === 当前 model ⇒ 「显示的是糖投影」，内容写必须显式拒。
    sugarModel: opts.sugar ? model : null,
    path: `D:\\proj\\doc${uriSeq}.kojo`,
    // 生产同形态的写后脏态反查（EditorPane.computeDirty 同一个表达式）。
    readDirty: () => model.getAlternativeVersionId() !== baseline,
  };
  return { paneId: `pane-${uriSeq}`, model, editor, handle, markSaved: () => { baseline = model.getAlternativeVersionId(); } };
}

const rigs: Rig[] = [];

function sup(
  rigsIn: readonly Rig[],
  extra: Partial<McpIoDeps> = {},
): ReturnType<typeof createRunSupplemental> {
  return createRunSupplemental({
    getKernel: () => null,
    getCommands: () => [],
    invoke: vi.fn(async () => {
      throw new Error('不该触达 invoke');
    }),
    searchInFiles: async () => {
      throw new Error('不该触达 searchInFiles');
    },
    getEditorPane: (paneId: string) => rigsIn.find((r) => r.paneId === paneId)?.handle ?? null,
    ...extra,
  } as unknown as McpIoDeps);
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
  rigs.splice(0);
});

/** 腿工厂的单参调用壳（McpReaderFn 第二参是会话档位，本文件不涉及，统一给 edit）。 */
function legsOf(deps: Parameters<typeof createEditorWriteLegs>[0]) {
  const legs = createEditorWriteLegs(deps);
  const wrap = (fn: McpReaderFn) => (args: Record<string, unknown>) => fn(args, editScope);
  return {
    editorSetValue: wrap(legs.editorSetValue),
    editorType: wrap(legs.editorType),
    editorSetCursor: wrap(legs.editorSetCursor),
    editorSetSelection: wrap(legs.editorSetSelection),
    editorRevealLine: wrap(legs.editorRevealLine),
  };
}

/** 每枚工具「必填齐全」的入参（缺必填会先撞 INVALID_ARGS，掩盖 pane 反查的判定）。 */
function fullArgs(paneId: string): [string, Record<string, unknown>][] {
  return [
    ['editor.setValue', { paneId, text: 'x' }],
    ['editor.type', { paneId, text: 'x' }],
    ['editor.setCursor', { paneId, line: 1 }],
    ['editor.setSelection', { paneId, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }],
    ['editor.revealLine', { paneId, line: 1 }],
  ];
}

/* ================================================================== *
 * ① pane 反查：缺席即显式拒，不冒充成功
 * ================================================================== */

describe('editor.* ① paneId 反查（缺席可见）', () => {
  it('paneId 不在册 ⇒ 五枚各自 NOT_WIRED + [E_EDITOR_PANE_GONE]，绝不回 applied:true', async () => {
    const run = sup([]);
    for (const [tool, args] of fullArgs('ghost-pane')) {
      await expect(run(tool, args, editScope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
      await expect(run(tool, args, editScope)).rejects.toMatchObject({
        message: expect.stringContaining('[E_EDITOR_PANE_GONE]'),
      });
    }
  });

  it('pane 在场但没有 model（未开文件 / 已关标签）⇒ 显式拒，不静默落别处', async () => {
    const rig = makeRig('hello');
    (rig.editor as unknown as { getModel: () => unknown }).getModel = () => null;
    const run = sup([rig]);
    await expect(run('editor.setValue', { paneId: rig.paneId, text: 'x' }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_EDITOR_PANE_GONE]'),
    });
    await expect(run('editor.setCursor', { paneId: rig.paneId, line: 1 }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
    });
    expect(rig.model.getValue()).toBe('hello');
  });

  it('缺 paneId / 空串 / 超长 ⇒ INVALID_ARGS（腿零触达）', async () => {
    const rig = makeRig('hello');
    const legs = legsOf({ getEditorPane: () => rig.handle });
    for (const args of [{}, { paneId: '' }, { paneId: '   ' }, { paneId: 'p'.repeat(129) }]) {
      await expect(legs.editorSetValue(args as Record<string, unknown>)).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('[E_EDITOR_INVALID_ARGS]'),
      });
    }
    expect(rig.model.getValue()).toBe('hello');
  });

  it('没有 getEditorPane seam 且 livePanes 查无此 id ⇒ 同样显式拒（生产缺省不兜底焦点）', async () => {
    const legs = legsOf({});
    await expect(legs.editorType({ paneId: 'no-such-pane', text: 'x' })).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_EDITOR_PANE_GONE]'),
    });
  });
});

/* ================================================================== *
 * ② 只读闸：内容写拒、光标类照常
 * ================================================================== */

describe('editor.* ② 只读编辑器如实拒绝', () => {
  it('只读 ⇒ setValue / type 显式 PERMISSION_DENIED + [E_EDITOR_READ_ONLY]，正文一字节没变', async () => {
    const rig = makeRig('readonly body\nsecond line', { readOnly: true });
    const run = sup([rig]);
    await expect(run('editor.setValue', { paneId: rig.paneId, text: 'EVIL' }, editScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('[E_EDITOR_READ_ONLY]'),
    });
    await expect(run('editor.type', { paneId: rig.paneId, text: 'EVIL' }, editScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(rig.model.getValue()).toBe('readonly body\nsecond line');
    expect(rig.editor.calls.executeEdits).toBe(0);
    expect(rig.handle.readDirty!()).toBe(false); // 正文没动 ⇒ 脏态没被点亮
  });

  it('只读不拦光标 / 选区 / 视口三枚（不动正文），回报带 readOnly:true 读数', async () => {
    const rig = makeRig('a\nb\nc', { readOnly: true });
    const run = sup([rig]);
    const cur = (await run('editor.setCursor', { paneId: rig.paneId, line: 2, column: 2 }, editScope)) as Record<string, unknown>;
    expect(cur['applied']).toBe(true);
    expect(cur['readOnly']).toBe(true);
    expect(cur['contentChanged']).toBe(false);
    expect(cur['saved']).toBe(false);
    const sel = (await run(
      'editor.setSelection',
      { paneId: rig.paneId, startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
      editScope,
    )) as Record<string, unknown>;
    expect(sel['applied']).toBe(true);
    const rev = (await run('editor.revealLine', { paneId: rig.paneId, line: 3 }, editScope)) as Record<string, unknown>;
    expect(rev['applied']).toBe(true);
    expect(rig.model.getValue()).toBe('a\nb\nc');
  });

  it('读不到 readOnly 读数 ⇒ 不编造只读（editorReadOnly 缺席口径）', async () => {
    const rig = makeRig('body');
    delete (rig.editor as unknown as { getRawOptions?: unknown }).getRawOptions;
    const run = sup([rig]);
    const r = (await run('editor.setValue', { paneId: rig.paneId, text: 'changed' }, editScope)) as Record<string, unknown>;
    expect(r['applied']).toBe(true);
    expect(r['readOnly']).toBe(false);
  });
});

/* ================================================================== *
 * ③ 回读核对：值真变了才算成功
 * ================================================================== */

describe('editor.* ③ 回读核对（不许"报成功但值没变"）', () => {
  it('setValue 成功：值真变 + 前后长度 / 版本读数', async () => {
    const rig = makeRig('old text');
    const run = sup([rig]);
    const r = (await run('editor.setValue', { paneId: rig.paneId, text: '新内容\n第二行' }, editScope)) as Record<string, unknown>;
    expect(r['applied']).toBe(true);
    expect(rig.model.getValue()).toBe('新内容\n第二行');
    expect(r['charLengthBefore']).toBe(8);
    expect(r['charLengthAfter']).toBe(7); // '新内容' 3 + '\n' 1 + '第二行' 3
    expect(r['lineCount']).toBe(2);
    expect(typeof r['versionBefore']).toBe('number');
  });

  it('setValue 给的文本与当前正文逐字相同 ⇒ 显式 [E_EDITOR_APPLY_UNVERIFIED]，不拿 true 冒充', async () => {
    const rig = makeRig('same');
    const run = sup([rig]);
    await expect(run('editor.setValue', { paneId: rig.paneId, text: 'same' }, editScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_EDITOR_APPLY_UNVERIFIED]'),
    });
  });

  it('type 成功：光标处插入 + 回读核对 + 插入位置读数', async () => {
    const rig = makeRig('ab');
    rig.editor.caret.line = 1;
    rig.editor.caret.column = 2;
    const run = sup([rig]);
    const r = (await run('editor.type', { paneId: rig.paneId, text: 'X' }, editScope)) as Record<string, unknown>;
    expect(r['applied']).toBe(true);
    expect(rig.model.getValue()).toBe('aXb');
    expect(r['insertedChars']).toBe(1);
    expect(r['typedAt']).toEqual({ line: 1, column: 2 });
  });

  it('type 空串（值没变）⇒ 显式 [E_EDITOR_APPLY_UNVERIFIED]', async () => {
    const rig = makeRig('ab');
    const run = sup([rig]);
    await expect(run('editor.type', { paneId: rig.paneId, text: '' }, editScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_EDITOR_APPLY_UNVERIFIED]'),
    });
    expect(rig.model.getValue()).toBe('ab');
  });

  it('executeEdits 被拒（返回 false）⇒ 同样显式报错，不冒充插入过', async () => {
    const rig = makeRig('ab');
    rig.editor.executeEdits = () => false;
    const run = sup([rig]);
    await expect(run('editor.type', { paneId: rig.paneId, text: 'Z' }, editScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_EDITOR_APPLY_UNVERIFIED]'),
    });
    expect(rig.model.getValue()).toBe('ab');
  });

  it('text 超长 ⇒ INVALID_ARGS（不夹带截断）', async () => {
    const rig = makeRig('ab');
    const legs = legsOf({ getEditorPane: () => rig.handle });
    await expect(legs.editorType({ paneId: rig.paneId, text: 'x'.repeat(200_001) })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    expect(rig.model.getValue()).toBe('ab');
  });
});

/* ================================================================== *
 * ④ 脏值入参：显式 INVALID_ARGS，且不喂进真源
 * ================================================================== */

describe('editor.* ④ 脏值入参闸（零触达真源 API）', () => {
  const dirty = [0, -1, 1.5, Number.NaN, '2', null, true, [2]] as const;

  it('setCursor 的 line / column 脏值 ⇒ INVALID_ARGS 且 setPosition 零调用', async () => {
    const rig = makeRig('l1\nl2\nl3');
    const legs = legsOf({ getEditorPane: () => rig.handle });
    for (const line of dirty) {
      await expect(legs.editorSetCursor({ paneId: rig.paneId, line })).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('[E_EDITOR_INVALID_ARGS]'),
      });
    }
    for (const column of dirty) {
      await expect(legs.editorSetCursor({ paneId: rig.paneId, line: 2, column })).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      });
    }
    expect(rig.editor.calls.setPosition).toBe(0);
    expect(rig.editor.caret).toEqual({ line: 1, column: 1 });
  });

  it('setCursor 行越界 ⇒ INVALID_ARGS（不夹取、不假装定位成功）', async () => {
    const rig = makeRig('l1\nl2\nl3');
    const run = sup([rig]);
    await expect(run('editor.setCursor', { paneId: rig.paneId, line: 99 }, editScope)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('越过文档行数'),
    });
    expect(rig.editor.calls.setPosition).toBe(0);
  });

  it('setCursor 成功：请求与回读都在，缺省 column 落行首 1', async () => {
    const rig = makeRig('l1\nl2\nl3');
    const run = sup([rig]);
    const r = (await run('editor.setCursor', { paneId: rig.paneId, line: 2 }, editScope)) as Record<string, unknown>;
    expect(r['requested']).toEqual({ line: 2, column: 1 });
    expect(r['cursor']).toEqual({ line: 2, column: 1 });
    expect(r['clamped']).toBe(false);
    expect(r['dirty']).toBe(false);
  });

  it('setSelection 脏值 / endLine<startLine ⇒ INVALID_ARGS 且 setSelection 零调用', async () => {
    const rig = makeRig('l1\nl2\nl3');
    const legs = legsOf({ getEditorPane: () => rig.handle });
    const base = { paneId: rig.paneId, startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 };
    for (const bad of dirty) {
      await expect(legs.editorSetSelection({ ...base, startColumn: bad })).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      });
    }
    await expect(
      legs.editorSetSelection({ ...base, startLine: 3, endLine: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('endLine') });
    await expect(
      legs.editorSetSelection({ ...base, endLine: 99 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('越过文档') });
    expect(rig.editor.calls.setSelection).toBe(0);
  });

  it('setSelection 列越界按 Monaco 语义夹到行末并如实标 clamped（不静默）', async () => {
    const rig = makeRig('abc\ndefg');
    const run = sup([rig]);
    const r = (await run(
      'editor.setSelection',
      { paneId: rig.paneId, startLine: 1, startColumn: 1, endLine: 1, endColumn: 999 },
      editScope,
    )) as Record<string, unknown>;
    expect(r['applied']).toBe(true);
    expect(r['clamped']).toBe(true);
    expect((r['selection'] as Record<string, number>)['endColumn']).toBe(4);
    expect(r['selectionLength']).toBe(3);
  });

  it('revealLine 的 reveal 只认 center/top/nearest；行越界夹到末行并如实标 clamped', async () => {
    const rig = makeRig('l1\nl2\nl3');
    const run = sup([rig]);
    await expect(
      run('editor.revealLine', { paneId: rig.paneId, line: 2, reveal: 'bottom' }, editScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('center') });
    const r = (await run('editor.revealLine', { paneId: rig.paneId, line: 99 }, editScope)) as Record<string, unknown>;
    expect(r['applied']).toBe(true);
    expect(r['requestedLine']).toBe(99);
    expect(r['revealedLine']).toBe(3);
    expect(r['clamped']).toBe(true);
    expect(rig.editor.calls.reveal).toEqual(['revealLine:3']);
    await run('editor.revealLine', { paneId: rig.paneId, line: 1, reveal: 'center' }, editScope);
    await run('editor.revealLine', { paneId: rig.paneId, line: 2, reveal: 'top' }, editScope);
    expect(rig.editor.calls.reveal).toEqual(['revealLine:3', 'revealLineInCenter:1', 'revealLineNearTop:2']);
  });

  it('视口方法缺席 ⇒ 显式 [E_EDITOR_APPLY_UNVERIFIED]，不假装滚过去了', async () => {
    const rig = makeRig('l1\nl2');
    delete (rig.editor as unknown as { revealLine?: unknown }).revealLine;
    const run = sup([rig]);
    await expect(run('editor.revealLine', { paneId: rig.paneId, line: 2 }, editScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_EDITOR_APPLY_UNVERIFIED]'),
    });
  });
});

/* ================================================================== *
 * ⑤ 不落盘安全钉：成功回报必带 saved:false，且写通道零触达
 * ================================================================== */

describe('editor.* ⑤ 磁盘一个字节都没动', () => {
  it('五枚成功回报一律 saved:false + persisted:false + 明文落盘指引', async () => {
    const rig = makeRig('l1\nl2\nl3');
    rig.markSaved();
    const invoke = vi.fn(async () => null);
    const run = sup([rig], { invoke });
    for (const [tool, args] of fullArgs(rig.paneId)) {
      const r = (await run(tool, args, editScope)) as Record<string, unknown>;
      expect(r['applied'], tool).toBe(true);
      expect(r['saved'], `${tool} 必须写明磁盘没动`).toBe(false);
      expect(r['persisted'], tool).toBe(false);
      expect(String(r['persistNote']), tool).toMatch(/fileTree\.update/);
      expect(String(r['persistNote']), tool).toMatch(/approvedRoots|writablePaths/);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(rig.model.getValue()).not.toBe('l1\nl2\nl3'); // 唯一落点 = 模型
  });

  it('dirty 是真读数：内容写两枚 ⇒ true；只动光标 ⇒ 保持 false；保存后归 false', async () => {
    const rig = makeRig('keep\nkeep');
    rig.markSaved();
    const run = sup([rig]);
    const cur = (await run('editor.setCursor', { paneId: rig.paneId, line: 2 }, editScope)) as Record<string, unknown>;
    expect(cur['dirty']).toBe(false); // 光标不是编辑，不该把文档标脏
    const typed = (await run('editor.type', { paneId: rig.paneId, text: '!' }, editScope)) as Record<string, unknown>;
    expect(typed['dirty']).toBe(true); // 真改了正文 ⇒ 脏位如实点亮
    expect(typed['saved']).toBe(false); // 但磁盘一个字节没动
    rig.markSaved(); // 宿主保存（基线推进）后再读 ⇒ 干净
    const after = (await run('editor.revealLine', { paneId: rig.paneId, line: 1 }, editScope)) as Record<string, unknown>;
    expect(after['dirty']).toBe(false);
  });

  it('脏态两条路都读不到 ⇒ dirty:null + dirtyReason，不编造 false', async () => {
    const rig = makeRig('body');
    delete (rig.model as unknown as { isDirty?: unknown }).isDirty;
    const blindHandle: EditorWritePaneHandle = { ...rig.handle, readDirty: undefined };
    const legs = legsOf({ getEditorPane: () => blindHandle });
    const r = (await legs.editorSetValue({ paneId: rig.paneId, text: 'other' })) as Record<string, unknown>;
    expect(r['dirty']).toBeNull();
    expect(String(r['dirtyReason'])).toMatch(/isDirty|基线/);
  });

  it('脏态反查无从判定（池里没有这条路径 ⇒ readDirty 回 null）⇒ 如实 null，不猜干净', async () => {
    const rig = makeRig('body');
    const nullHandle: EditorWritePaneHandle = { ...rig.handle, readDirty: () => null };
    const legs = legsOf({ getEditorPane: () => nullHandle });
    const r = (await legs.editorSetValue({ paneId: rig.paneId, text: 'other' })) as Record<string, unknown>;
    expect(r['applied']).toBe(true);
    expect(r['dirty']).toBeNull();
    expect(String(r['dirtyReason'])).toMatch(/不编造脏态/);
  });
});

/* ================================================================== *
 * ⑥ undo 一步可退（内容类腿）
 * ================================================================== */

describe('editor.* ⑥ 撤销语义', () => {
  it('editor.type 一次 executeEdits ⇒ 一次 undo 退得掉', async () => {
    const rig = makeRig('hello');
    rig.editor.caret.line = 1; // 光标停文末：type 的落点就是光标，不是文档首
    rig.editor.caret.column = 6;
    const run = sup([rig]);
    await run('editor.type', { paneId: rig.paneId, text: ' WORLD' }, editScope);
    expect(rig.model.getValue()).toBe('hello WORLD');
    await rig.model.undo();
    expect(rig.model.getValue()).toBe('hello');
  });

  it('editor.setValue 明写「不进撤销栈」（与调试面同判据，不谎称可一步退）', async () => {
    const rig = makeRig('hello');
    const run = sup([rig]);
    const r = (await run('editor.setValue', { paneId: rig.paneId, text: 'replaced' }, editScope)) as Record<string, unknown>;
    expect(String(r['undo'])).toMatch(/不进撤销栈/);
    const t = (await run('editor.type', { paneId: rig.paneId, text: 'x' }, editScope)) as Record<string, unknown>;
    expect(String(t['undo'])).toMatch(/一个撤销步/);
  });

  it('光标 / 选区 / 视口三枚不改正文（contentChanged:false）', async () => {
    const rig = makeRig('a\nb\nc');
    const run = sup([rig]);
    for (const [tool, args] of [
      ['editor.setCursor', { paneId: rig.paneId, line: 2 }],
      ['editor.setSelection', { paneId: rig.paneId, startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }],
      ['editor.revealLine', { paneId: rig.paneId, line: 2 }],
    ] as [string, Record<string, unknown>][]) {
      const r = (await run(tool, args, editScope)) as Record<string, unknown>;
      expect(r['contentChanged'], tool).toBe(false);
    }
    expect(rig.model.getValue()).toBe('a\nb\nc');
  });
});

/* ================================================================== *
 * ⑦ 跨会话不串味 + 派生视图闸
 * ================================================================== */

describe('editor.* ⑦ 跨会话不串味 / 派生视图', () => {
  it('两个 pane 各拿各的模型：写 A 不动 B（无「当前聚焦」兜底）', async () => {
    const a = makeRig('AAA');
    const b = makeRig('BBB');
    const run = sup([a, b]);
    await run('editor.setValue', { paneId: b.paneId, text: 'B-changed' }, otherScope);
    expect(b.model.getValue()).toBe('B-changed');
    expect(a.model.getValue()).toBe('AAA');
    a.editor.caret.line = 1; // A 的光标停在文末：type 落点显式，不靠默认值
    a.editor.caret.column = 4;
    await run('editor.type', { paneId: a.paneId, text: '!' }, editScope);
    expect(a.model.getValue()).toBe('AAA!');
    expect(b.model.getValue()).toBe('B-changed');
  });

  it('seam 只能按 paneId 命中：请求别的 id ⇒ 显式拒，不落到手里这一个', async () => {
    const a = makeRig('AAA');
    const legs = legsOf({ getEditorPane: (id) => (id === a.paneId ? a.handle : null) });
    await expect(legs.editorSetValue({ paneId: 'someone-elses-pane', text: 'x' })).rejects.toMatchObject({
      code: 'NOT_WIRED',
    });
    expect(a.model.getValue()).toBe('AAA');
  });

  it('糖投影（派生视图）⇒ 显式 [E_EDITOR_DERIVED_VIEW]，内容写两枚都不开放', async () => {
    const rig = makeRig('derived view body', { sugar: true });
    const run = sup([rig]);
    for (const tool of ['editor.setValue', 'editor.type']) {
      await expect(run(tool, { paneId: rig.paneId, text: 'x' }, editScope)).rejects.toMatchObject({
        code: 'NOT_WIRED',
        message: expect.stringContaining('[E_EDITOR_DERIVED_VIEW]'),
      });
    }
    expect(rig.model.getValue()).toBe('derived view body');
  });
});

/* ================================================================== *
 * ⑧ 档位：read 会话在 WebView registry 即拒（腿零触达）
 * ================================================================== */

describe('editor.* ⑧ registry 档位', () => {
  it('read 会话调五枚 ⇒ PERMISSION_DENIED，且腿与 model 零改动', async () => {
    const rig = makeRig('untouched');
    const run = sup([rig]);
    const registry = createMcpCapabilityRegistry({ runSupplemental: run } as never);
    for (const [tool, args] of fullArgs(rig.paneId)) {
      await expect(registry.callTool(tool, args, readScope)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    }
    expect(rig.model.getValue()).toBe('untouched');
    expect(rig.editor.calls.setPosition).toBe(0);
  });

  it('五枚契约登记齐全：tier=edit + 带参 schema 一律 additionalProperties:false', async () => {
    const { SUPPLEMENTAL_TOOL_SPECS } = await import('@kojo/mcp-host');
    for (const tool of EDITOR_TOOLS) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === tool);
      expect(spec, `${tool} 未登记`).toBeTruthy();
      expect(spec!.tier, tool).toBe('edit');
      const schema = spec!.inputSchema as Record<string, unknown>;
      expect(schema['additionalProperties'], `${tool} 的 schema 必须收紧`)
        .toBe(false);
      expect((schema['required'] as string[]), tool).toContain('paneId');
    }
  });

  it('腿表名字与契约表逐字对齐（少一枚 / 拼错即红）', async () => {
    const legs = legsOf({});
    expect(Object.keys(legs).sort()).toEqual([
      'editorRevealLine',
      'editorSetCursor',
      'editorSetSelection',
      'editorSetValue',
      'editorType',
    ]);
    const run = sup([]);
    for (const [tool, args] of fullArgs('ghost')) {
      await expect(run(tool, args, editScope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    }
    // 未登记的第六枚（editor.format 本批刻意不做）不得被悄悄接上：仍走 default 显式 NOT_WIRED。
    await expect(run('editor.format', { paneId: 'ghost' }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
    });
  });
});
