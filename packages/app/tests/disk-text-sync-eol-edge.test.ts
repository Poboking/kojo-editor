// @vitest-environment happy-dom
/**
 * DISK-SYNC-EOL-EDGE · 两条换行边角的对拍（applyDiskText vs model.setValue）
 *
 * 判据（与 `disk-text-sync-eol.test.ts` 同口径、更严）：同一初值、同一份**盘上字节**，
 * 新通道（`applyDiskText`）与旧通道（`model.setValue()`）落定后四项读数**逐字同果**——
 * `getValue()` / `getEOL()` / `getLineCount()` / `getValueLength()`。
 * 只比文本不算数：幽灵空行这类缺陷只有行数与档位抓得到（PITFALLS 163）。
 *
 * ## 边角一 · 整篇无行尾（单行 / 空文件）的档位选择 —— 实测**不等价**
 * 改前（win32，LF 档 model + 盘 `甲改`）：新 `[甲改,档 \n,行1,长2]` vs 旧 `[甲改,档 \r\n,行1,长2]`，
 * 差在档位。成因：`setValue` 走 `PieceTreeTextBufferBuilder._getEOL(defaultEOL)` 的 `total === 0`
 * 分支 ⇒ 取**创建时的 defaultEOL**，而这一档是**平台相关**的（monaco 0.57.0
 * `editor/common/services/modelService.js:46`：`DEFAULT_EOL = (isLinux || isMacintosh) ? LF : CRLF`）——
 * 所以既不能硬编 LF 也不能硬编 CRLF，必须读 `model.getOptions().defaultEOL`（公开面、正是
 * `_getEOL` 的那个入参；桩 model 没这个方法时回退保持现档 ⇒ 零调用方改动）。
 *
 * ## 边角二 · 孤 `\r`（老式 Mac 行尾）的分段口径 —— 实测**不等价**，两处
 * 1. **判档漏计孤 CR**：`_getEOL` 用 `total = cr+lf+crlf`、CR 侧 `cr+crlf`；原实现只数 `\n` 结尾
 *    ⇒ 纯 CR 盘文被当"无行尾"、保持现档。改前实测：LF model + 盘 `甲\r乙改\r丙` ⇒
 *    新 `[甲\n乙改\n丙,档 \n,行3,长6]` vs 旧 `[甲\r\n乙改\r\n丙,档 \r\n,行3,长8]`；
 *    盘 `a\rb\r\nc\n`（cr1+crlf1+lf1）⇒ 改前 新 行4长6 vs 旧 行4长9。
 *    ⇒ `detectMajorityEol` 改成 `_getEOL` 的逐字镜像。`cr === 0` 时与原式**完全同值**
 *    ⇒ 那五条既有对拍零影响（已复跑）。
 * 2. **盘尾孤 CR 被吞**：`setValue` 把 EOF 的 `\r` 当一个行尾（末尾多一个空行），差量通道里
 *    `textModel.js:959` 的 `removeTrailingCR`（CRLF 档 + 段末孤 `\r` + 区间末落在该行末列）把它丢了。
 *    改前实测：CRLF model + 盘 `a\r\nb改\r\nc\r` ⇒ 新 `[a\r\nb改\r\nc,行3,长8]`
 *    vs 旧 `[a\r\nb改\r\nc\r\n,行4,长10]`——**行数与长度都差**。
 *    ⇒ 落差量前把这一个 `\r` 写成已对齐的档位（`trailingLoneCrAsEol`）。
 *
 * 下方"口径回退自证"把三处改因各拆一次、分段口径退回一次 ⇒ 四项读数立刻不同果（证明上面的绿不是假绿）。
 * 手工回退实测：把 `disk-text-sync.ts` 还原到 dev 尖端版本 ⇒ 本文件 **9/23 红**。
 * 零改动面：撤销栈前后停点、`forceMoveMarkers`、重载不落盘、写域闸门（本文件只碰内存 model）。
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
    monaco.Uri.parse(`inmemory://disk-sync-eol-edge/${++seq}`),
  );
  models.push(model);
  return model;
}

type Readings = readonly [value: string, eol: string, lines: number, len: number];
function readings(m: monaco.editor.ITextModel): Readings {
  return [m.getValue(), m.getEOL(), m.getLineCount(), m.getValueLength()];
}

/** 创建档 = `setValue` 在整篇无行尾时落的那一档（平台相关，见头注）；探针 model 由 afterEach 收 */
let creationCache: string | undefined;
function CREATION_EOL(): string {
  if (!creationCache) {
    const probe = makeModel('probe');
    creationCache = probe.getOptions().defaultEOL === 1 ? '\n' : '\r\n';
  }
  return creationCache;
}
/** 现档与创建档**相反**的初值：跨平台都真正构成"档位要变"的那条边角 */
function opposingInitial(): string {
  return CREATION_EOL() === '\r\n' ? '甲\n乙\n丙' : '甲\r\n乙\r\n丙';
}

/**
 * 对拍主函数：四项读数逐字等 + 新通道绝对读数钉死（防"两条一起错"，同果不等于同对）。
 * `pinnedEol` 由调用方给：有行尾的样本 = 字面档位；整篇无行尾的样本 = `CREATION_EOL()`。
 */
function parity4(initial: string, disk: string, value: string, eol: string, lines: number, len: number): void {
  const a = makeModel(initial);
  const b = makeModel(initial);
  expect(readings(a), '两 model 初态必须一致，否则对拍基准歪').toEqual(readings(b));
  expect(applyDiskText(a, disk), '盘文与初值应确有差量').toBeGreaterThanOrEqual(1);
  b.setValue(disk);
  const pinned: Readings = [value, eol, lines, len];
  expect(readings(a), '新通道绝对读数').toEqual(pinned);
  expect(readings(b), '旧通道绝对读数（对拍基准）').toEqual(pinned);
}

describe('边角一 · 整篇无行尾（单行 / 空文件）：档位落创建档，与 setValue 同果', () => {
  it('⓪创建档自证：无行尾初值的 model 档位 == getOptions().defaultEOL（平台相关，不许硬编）', () => {
    const m = makeModel('probe');
    expect(m.getEOL()).toBe(CREATION_EOL());
    expect(makeModel(opposingInitial()).getEOL()).not.toBe(CREATION_EOL()); // 反档初值确实存在
  });

  it('①现档与创建档相反 + 无行尾盘 ⇒ 档位跟着创建档走（改前保持现档 ⇒ 不同果）', () => {
    parity4(opposingInitial(), '甲改', '甲改', CREATION_EOL(), 1, 2);
  });

  it('②LF 档 model + 无行尾盘：同果', () => {
    parity4('甲\n乙\n丙', '甲改', '甲改', CREATION_EOL(), 1, 2);
  });

  it('③CRLF 档 model + 无行尾盘：同果', () => {
    parity4('甲\r\n乙\r\n丙', '甲改', '甲改', CREATION_EOL(), 1, 2);
  });

  it('④空盘（清零）+ CRLF 档：同果', () => {
    parity4('甲\r\n乙\r\n丙', '', '', CREATION_EOL(), 1, 0);
  });

  it('⑤空盘（清零）+ LF 档：同果（改前这里也差档位）', () => {
    parity4('甲\n乙\n丙', '', '', CREATION_EOL(), 1, 0);
  });

  it('⑥初值本就是无行尾单行 + 盘换字：同果', () => {
    parity4('甲', '乙', '乙', CREATION_EOL(), 1, 1);
  });

  it('⑦两行压成无行尾单行：同果', () => {
    parity4('甲\r\n乙', '乙', '乙', CREATION_EOL(), 1, 1);
  });
});

describe('边角二 · 孤 CR（老式 Mac 行尾）：判档计 CR、盘尾孤 CR 补成档位行尾', () => {
  it('①纯孤 CR 全篇：档位按 monaco 口径翻 CRLF，与 setValue 同果', () => {
    parity4('甲\n乙\n丙', '甲\r乙改\r丙', '甲\r\n乙改\r\n丙', '\r\n', 3, 8);
  });

  it('②孤 CR 落在分段边界：同果', () => {
    parity4('a\nb\nc', 'a\rB\r\nc', 'a\r\nB\r\nc', '\r\n', 3, 7);
  });

  it('③孤 CR + CRLF + LF 混编（LF 侧过半）：同果、落 LF 档', () => {
    parity4('a\nb\nc\nd\n', 'a\r\nb\rc\nd\n', 'a\nb\nc\nd\n', '\n', 5, 8);
  });

  it('④cr1+crlf1+lf1 过半判档（旧口径三数全不同）：同果、落 CRLF 档', () => {
    parity4('x\ny\nz', 'a\rb\r\nc\n', 'a\r\nb\r\nc\r\n', '\r\n', 4, 9);
  });

  it('⑤孤 CR 夹在 LF 多数派里：同果（monaco 折成现档，本模块段内留 CR 亦同解）', () => {
    parity4('a\nb\nc', 'a\nbX\rc\nd', 'a\nbX\nc\nd', '\n', 4, 8);
  });

  it('⑥全篇孤 CR 且末段无行尾：改前差档位与长度，现同果', () => {
    parity4('a\nb\nc', 'a\rb\rc', 'a\r\nb\r\nc', '\r\n', 3, 7);
  });

  it('⑦CRLF 档 model + 纯孤 CR 盘：同果', () => {
    parity4('a\r\nb\r\nc', 'a\rb\rc', 'a\r\nb\r\nc', '\r\n', 3, 7);
  });

  it('⑧差量中间段以孤 CR 收尾（原幽灵空行形状）：同果', () => {
    parity4('甲\n乙\n丙', '甲\n乙改\r丙', '甲\n乙改\n丙', '\n', 3, 6);
  });

  it('⑨盘尾孤 CR + CRLF 档：同果（`removeTrailingCR` 的吞行被前置归一挡住）', () => {
    parity4('a\r\nb\r\nc', 'a\r\nb改\r\nc\r', 'a\r\nb改\r\nc\r\n', '\r\n', 4, 10);
  });

  it('⑩盘尾孤 CR + LF 档：同果', () => {
    parity4('x\ny\nz', 'x\ny\nz\r', 'x\ny\nz\n', '\n', 4, 6);
  });

  it('⑪单行盘 + 尾孤 CR：同果（多出的空行两条通道都得有）', () => {
    parity4('a\nb', 'a\r', 'a\r\n', '\r\n', 2, 3);
  });

  it('⑫连续双尾孤 CR：同果', () => {
    parity4('a\nb', 'a\r\r', 'a\r\n\r\n', '\r\n', 3, 5);
  });

  it('⑬纯孤 CR 全篇且盘尾孤 CR：改前差档位/行数/长度，现同果', () => {
    parity4('a\nb\nc', 'a\rb\rc\r', 'a\r\nb\r\nc\r\n', '\r\n', 4, 9);
  });
});

describe('口径回退自证 · 改因各拆一次、分段口径退回一次 ⇒ 立刻不同果（绿不是假绿）', () => {
  /** 只落差量、不碰档位（= 改前调用序），分段口径与 `applyDiskText` 一致 */
  function applyWithoutEolAlign(model: monaco.editor.ITextModel, disk: string): void {
    const edits = diskSyncEdits(model.getValue(), disk);
    const ops = edits.map((edit) => ({
      range: new monaco.Range(
        model.getPositionAt(edit.start).lineNumber,
        model.getPositionAt(edit.start).column,
        model.getPositionAt(edit.end).lineNumber,
        model.getPositionAt(edit.end).column,
      ),
      text: edit.text,
      forceMoveMarkers: true,
    }));
    model.pushEditOperations(null, ops, () => null);
  }

  it('A：判档不计孤 CR ⇒ 档位/文本/长度全与 setValue 不同果（复现改前读数）', () => {
    const m = makeModel('甲\n乙\n丙');
    const oracle = makeModel('甲\n乙\n丙');
    applyWithoutEolAlign(m, '甲\r乙改\r丙');
    oracle.setValue('甲\r乙改\r丙');
    expect(readings(m)).toEqual(['甲\n乙改\n丙', '\n', 3, 6]); // 改前实测
    expect(readings(oracle)).toEqual(['甲\r\n乙改\r\n丙', '\r\n', 3, 8]);
    expect(readings(m)).not.toEqual(readings(oracle));
  });

  it('B：无行尾盘保持现档（不读创建档）⇒ 档位与 setValue 不同果（复现改前读数）', () => {
    const initial = opposingInitial(); // 现档故意与创建档相反，跨平台都差
    const m = makeModel(initial);
    const oracle = makeModel(initial);
    const currentBefore = m.getEOL();
    applyWithoutEolAlign(m, '甲改');
    oracle.setValue('甲改');
    expect(currentBefore).not.toBe(CREATION_EOL());
    expect(m.getEOL()).toBe(currentBefore); // 保持现档 = 改前行为
    expect(oracle.getEOL()).toBe(CREATION_EOL()); // 旧通道落创建档
    expect(m.getEOL()).not.toBe(oracle.getEOL());
  });

  it('C：盘尾孤 CR 不做前置归一 ⇒ 被 `removeTrailingCR` 吞掉一行（行数与长度都差）', () => {
    const m = makeModel('a\r\nb\r\nc');
    const oracle = makeModel('a\r\nb\r\nc');
    applyWithoutEolAlign(m, 'a\r\nb改\r\nc\r'); // 档位本已 CRLF，只差"末一个 CR 写成档位"这一步
    oracle.setValue('a\r\nb改\r\nc\r');
    expect(readings(m)).toEqual(['a\r\nb改\r\nc', '\r\n', 3, 8]); // 改前实测：少一行
    expect(readings(oracle)).toEqual(['a\r\nb改\r\nc\r\n', '\r\n', 4, 10]);
    expect(m.getLineCount()).not.toBe(oracle.getLineCount());
  });

  it('D：分段口径退回按字符前后缀 ⇒ 边界劈开行尾、行被并掉（少一行）', () => {
    const charPrefixSuffix = (oldText: string, newText: string): { start: number; end: number; text: string } => {
      let start = 0;
      while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start += 1;
      let endOld = oldText.length;
      let endNew = newText.length;
      while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
        endOld -= 1;
        endNew -= 1;
      }
      return { start, end: endOld, text: newText.slice(start, endNew) };
    };
    const disk = 'a\rb\rc';
    const m = makeModel('a\nb\nc');
    m.setEOL(monaco.editor.EndOfLineSequence.CRLF); // 档位按新口径先对齐，只把分段退回按字符
    const edit = charPrefixSuffix(m.getValue(), disk);
    m.pushEditOperations(
      null,
      [
        {
          range: new monaco.Range(
            m.getPositionAt(edit.start).lineNumber,
            m.getPositionAt(edit.start).column,
            m.getPositionAt(edit.end).lineNumber,
            m.getPositionAt(edit.end).column,
          ),
          text: edit.text,
        },
      ],
      () => null,
    );
    const oracle = makeModel('a\nb\nc');
    oracle.setValue(disk);
    expect(edit).toEqual({ start: 2, end: 6, text: 'b\r' }); // 字符边界正好劈开一行的 `\r\n`
    expect(readings(oracle)).toEqual(['a\r\nb\r\nc', '\r\n', 3, 7]); // 按行分段的新通道同此读数（边角二 ⑦）
    expect(readings(m)).toEqual(['ab\r\nc', '\r\n', 2, 5]);
    expect(m.getLineCount()).not.toBe(oracle.getLineCount());
  });
});

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});
