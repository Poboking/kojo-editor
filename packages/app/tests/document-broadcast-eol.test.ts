// @vitest-environment happy-dom
/**
 * 状态回放批（2026-11-05）：宿主广播的 `text` 到底是不是**盘上那份文本**。
 *
 * 面板要拿 `text` 按行取行号（`textOverride` 的解析与取行都吃它），所以"换行是哪种"
 * 必须是可证的而不是猜的。宿主的读入口是 `entry.model.getValue()`（`EditorPane.tsx` 的
 * `readDocumentTruth`），而 model 是 `monaco.editor.createModel(text, …)` 建的
 * （`editor-model-pool.ts:144`）——换行由 Monaco 从原文**多数派**探测决定，此后
 * `getValue()` 一律按 model 的 EOL 拼行。⇒
 *
 * - 统一换行的文件：广播文本**逐字等于**盘上解码后的文本（CRLF 仍是 CRLF、LF 仍是 LF）；
 * - 混用换行的文件：广播文本是**归一后**的那一份（≠ 盘上字节）。
 *
 * 所以面板契约里那句"别拿广播文本与 `io.readText` 逐字比"是有出处的：混用换行的文件
 * 两边永远判不等，会把"结果已过期"永远点亮（假过期比过期更烦人）。
 *
 * 为什么另立一枚 happy-dom 文件（而不是并进 `document-broadcast-replay.test.ts`）：
 * 那边是 node 环境的纯逻辑 + 源码形状判据，真 model 只在 DOM 环境里建得出来
 * （先例：`disk-text-sync-eol.test.ts` / `code-action-undo-stack.test.ts`）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import type { DocumentBroadcastPayload } from '../src/ui/document-broadcast';
import { createDocumentBroadcaster } from '../src/ui/document-broadcast';

const models: monaco.editor.ITextModel[] = [];
let seq = 0;

function make(text: string): monaco.editor.ITextModel {
  const m = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(`inmemory://doc-broadcast/${++seq}`));
  models.push(m);
  return m;
}

function collect() {
  const sent: DocumentBroadcastPayload[] = [];
  return { sent, emit: (p: DocumentBroadcastPayload) => sent.push(p) };
}

afterEach(() => {
  for (const m of models.splice(0)) m.dispose();
});

describe('广播 text = model.getValue()（面板拿它取行号，必须与屏幕行一一对应）', () => {
  it('CRLF 文件：model 保留 CRLF，载荷与它逐字相等（宿主不做任何归一）', () => {
    const CRLF = '；角色：\r\n\t#DIM 名前, 0, 10\r\n「おはよう」\r\n';
    const m = make(CRLF);
    expect(m.getEOL()).toBe('\r\n');
    expect(m.getValue()).toBe(CRLF);
    const { sent, emit } = collect();
    createDocumentBroadcaster({ emit }).flush('C:\\p\\a.erb', () => ({ text: m.getValue(), dirty: true }));
    expect(sent[0]!.text).toBe(CRLF);
    expect(sent[0]!.text.length).toBe(CRLF.length);
  });

  it('LF 文件：同样逐字保留 LF（宿主不按平台 / 偏好改写换行）', () => {
    const LF = '；角色：\n\t#DIM 名前\n';
    const m = make(LF);
    expect(m.getEOL()).toBe('\n');
    expect(m.getValue()).toBe(LF);
    const { sent, emit } = collect();
    createDocumentBroadcaster({ emit }).flush('C:\\p\\b.erb', () => ({ text: m.getValue(), dirty: false }));
    expect(sent[0]!.text).toBe(LF);
  });

  it('混用换行：model 按多数派归一 ⇒ 广播文本 ≠ 盘上字节（面板不得逐字对比两处文本）', () => {
    const MIXED_CRLF = 'a\r\nb\nc\r\n'; // crlf 2 / lf 1 ⇒ 多数派 CRLF
    const m = make(MIXED_CRLF);
    expect(m.getEOL()).toBe('\r\n');
    expect(m.getValue()).toBe('a\r\nb\r\nc\r\n');
    expect(m.getValue()).not.toBe(MIXED_CRLF); // 就是这一条：盘上那份与广播那份不同字符串
    // 反过来也成立（不是"总是 CRLF"）：多数派 LF 时同样归一
    const m2 = make('a\nb\nc\r\n');
    expect(m2.getEOL()).toBe('\n');
    expect(m2.getValue()).toBe('a\nb\nc\n');
  });
});
