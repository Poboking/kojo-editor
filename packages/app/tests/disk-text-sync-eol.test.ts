// @vitest-environment happy-dom
/**
 * RELOAD-EOL-PIN · 把「换行交给 monaco 自己归一」这句口头承诺钉成判据。
 *
 * f2738ad7 把磁盘重载从 `model.setValue(text)` 换成 `applyDiskText`（差量 + pushEditOperations），
 * 头注对 EOL 只有一句「EditData 按 model EOL 折行，与 setValue 同源，不改 EOL 语义」——零读数零用例。
 * 本文件做**对拍**：同一初值、同一盘上文本，新路径（applyDiskText）与旧路径（setValue）必须
 * **逐字同果**——`getValue()` 文本、`getEOL()` 档位、`getLineCount()` 三样都等。
 * 覆盖五条：①CRLF 盘→LF model；②LF 盘→CRLF model；③盘上混用 EOL；④作者光标落在差量区间内；
 * ⑤差量落在文件末尾且尾部换行变化。另附一条**反向自证**：在"归一被破坏"的桩 model 上，
 * 同一对拍口径必须报不等——证明五条不是假绿。
 *
 * 口径边界：光标屏上位的最终裁决在 EditorPane 的 saveViewState/restoreViewState 与真壳探针
 * （reload-undo-keep.test.ts ② 已钉住 applyDiskText 不替作者算新光标位）；本批钉的是
 * **model 内容面**的 EOL 归一等价，撤销栈停点顺带复钉（④）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { applyDiskText, diskSyncEdits } from '../src/ui/disk-text-sync';

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
/** 档位由初文行尾自动决定（monaco 0.57 `createModel` 多数派探测，同生产首开） */
function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(`inmemory://reload-eol-pin/${++seq}`),
  );
  models.push(model);
  return model;
}
function authorTyping(model: monaco.editor.ITextModel, line: number, column: number, typed: string): void {
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(line, column, line, column), text: typed }],
    () => null,
  );
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

/** 对拍主函数：新路径 vs 旧路径，同初值同盘文，三样逐字等。返回新路径结果供各案加显式期望。 */
function parity(initial: string, disk: string): string {
  const a = makeModel(initial);
  const b = makeModel(initial);
  expect(a.getEOL()).toBe(b.getEOL()); // 两 model 档位本身先对齐，防对拍基准歪
  const applied = applyDiskText(a, disk);
  b.setValue(disk);
  expect(applied, '盘文与初值应确有差量').toBeGreaterThanOrEqual(1);
  expect(a.getValue(), 'getValue 逐字同果').toBe(b.getValue());
  expect(a.getEOL(), 'EOL 档位同果（两路径按同一多数派口径重探）').toBe(b.getEOL());
  expect(a.getLineCount()).toBe(b.getLineCount());
  return a.getValue();
}

describe('RELOAD-EOL-PIN · 五条对拍（applyDiskText vs setValue）', () => {
  it('①CRLF 盘 → LF model：与 setValue 同果（多数派重探成 CRLF 档，非保持 LF）', () => {
    expect(parity('甲\n乙\n丙', '甲\r\n乙改\r\n丙')).toBe('甲\r\n乙改\r\n丙');
  });

  it('②LF 盘 → CRLF model：逐字同果（档位按 setValue 口径翻到 LF）', () => {
    // 初文 CRLF ⇒ model 自动 CRLF 档；盘是 LF ⇒ 旧路径 setValue 会重探成 LF 档（对拍须连档位一起等）
    expect(parity('甲\r\n乙\r\n丙', '甲\n乙改\n丙')).toBe('甲\n乙改\n丙');
  });

  it('③盘上混用 EOL（同文件既有 CRLF 又有 LF）：逐字同果', () => {
    const got = parity('甲\n乙\n丙\n丁', '甲X\r\n乙\n丙\r\n丁Y');
    // setValue 口径：CRLF 过半 ⇒ 整档 CRLF、混用行尾被归一（`乙\n` → `乙\r\n`）；差量路径必须同果
    expect(got).toBe('甲X\r\n乙\r\n丙\r\n丁Y');
  });

  it('④作者光标处在差量区间内：内容逐字同果 + 一次撤销仍回到作者改动', () => {
    const a = makeModel('aaa\nbbb\nccc');
    const b = makeModel('aaa\nbbb\nccc');
    authorTyping(a, 2, 2, 'ZZ');
    authorTyping(b, 2, 2, 'ZZ');
    const authorText = a.getValue();
    const disk = 'aaa\nCHANGED\nccc';
    // 前提核验：光标落点（打字后 (2,4)）确实被差量区间包住
    const cursorOffset = a.getOffsetAt({ lineNumber: 2, column: 4 });
    const edits = diskSyncEdits(a.getValue(), disk);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.start).toBeLessThan(cursorOffset);
    expect(edits[0]!.end).toBeGreaterThan(cursorOffset);
    // 对拍本体
    expect(applyDiskText(a, disk)).toBe(1);
    b.setValue(disk);
    expect(a.getValue()).toBe(b.getValue());
    expect(a.getEOL()).toBe(b.getEOL());
    // 顺带复钉：光标在差量里的这一下，撤销栈仍是一格、退得到作者改动
    a.undo();
    expect(a.getValue()).toBe(authorText);
  });

  it('⑤差量落在文件末尾且尾部换行变化：删尾行尾 / 加尾行尾（LF+CRLF 混档）逐字同果', () => {
    expect(parity('x\ny\n', 'x\ny')).toBe('x\ny');
    expect(parity('x\ny', 'x\r\ny\r\n')).toBe('x\r\ny\r\n');
    expect(parity('x\r\ny\r\n', 'x\r\ny')).toBe('x\r\ny');
  });
});

describe('RELOAD-EOL-PIN · 反向自证（对拍不是假绿）', () => {
  it('A：旧"按字符前后缀"差量（边界带孤立 CR）直接喂真 model ⇒ 凭空多空行，同口径必报不等', () => {
    const m = makeModel('甲\n乙\n丙');
    // 旧 diskSyncEdits 对 ① 的盘文给出 {start:1,end:3,text:'\r\n乙改\r'}——边界切开行尾对、残留孤立 CR
    m.pushEditOperations(
      null,
      [{ range: new monaco.Range(1, 2, 2, 2), text: '\r\n乙改\r' }],
      () => null,
    );
    const oracle = makeModel('甲\n乙\n丙');
    oracle.setValue('甲\r\n乙改\r\n丙');
    expect(m.getValue()).toBe('甲\n乙改\n\n丙'); // 改前实测：monaco 把孤立 CR 折成换行 => 多一行空行
    expect(m.getValue()).not.toBe(oracle.getValue());
  });

  it('B：不先按多数派 setEOL 就落差量 ⇒ 档位与 setValue 重探结果不同果', () => {
    const m = makeModel('甲\n乙\n丙');
    m.pushEditOperations(null, [{ range: new monaco.Range(2, 1, 2, 2), text: '乙改\r\n' }], () => null);
    const oracle = makeModel('甲\n乙\n丙');
    oracle.setValue('甲\r\n乙改\r\n丙');
    expect(m.getEOL()).toBe('\n'); // 纯差量路径不重探 => 档位留在 LF
    expect(oracle.getEOL()).toBe('\r\n'); // 旧路径 setValue => CRLF 过半 => 翻档
    expect(m.getValue()).not.toBe(oracle.getValue());
  });
});
