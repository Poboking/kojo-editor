/**
 * 口上 XML 面板的**投影判据**单测（纯函数面：`panel-tree.ts`）。
 *
 * 为什么不测渲染：渲染层只剩"把节点数组摆成 DOM"，判据全在投影里；而 `react` 在本包
 * 是 peer/dev 依赖（装依赖前不可解析），把测试绑到渲染等于让判据无法单独复跑。
 * 面板的三态（服务缺席 / 索引未就绪 / 有索引）由组件分支保证，这里钉的是它消费的那份数据。
 *
 * 夹具全部手写：不 import 任何适配器（解耦铁律——游戏事实只准住 adapter）。
 */

import { describe, expect, it } from 'vitest';
import type {
  KojoXmlCommand,
  KojoXmlDiagnostic,
  KojoXmlFile,
  KojoXmlIndex,
  KojoXmlSeverity,
} from '@kojo/plugin-api';
import {
  buildPanelTree,
  commandLabel,
  commandSubtitle,
  compareCom,
  conditionLabel,
  diagnosticRows,
  diagnosticSummary,
  filterPanelTree,
  panelStatsLine,
  DIAGNOSTIC_ROW_LIMIT,
} from '../src/panel-tree';

/* ------------------------------ 测试基建 ------------------------------ */

function cmd(
  attrs: Record<string, string>,
  text: string,
  line: number,
  index: number,
): KojoXmlCommand {
  return {
    index,
    span: { start: { line, column: 3 }, end: { line: line + 2, column: 12 } },
    contentSpan: null,
    attrs,
    text,
  };
}

function diag(
  path: string,
  line: number,
  severity: KojoXmlSeverity,
  message: string,
  code = 'kojo-xml.test.case',
): KojoXmlDiagnostic {
  return {
    path,
    severity,
    code,
    message,
    span: { start: { line, column: 5 }, end: { line, column: 9 } },
  };
}

function file(
  path: string,
  charaNo: number | null,
  commands: KojoXmlCommand[],
  diagnostics: KojoXmlDiagnostic[] = [],
): KojoXmlFile {
  return { path, format: 'data', encoding: 'utf-8', eol: 'crlf', charaNo, commands, diagnostics };
}

/** 按契约形状折索引（排序口径与提供方一致：文件按路径、角色号升序） */
function makeIndex(files: KojoXmlFile[]): KojoXmlIndex {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byChara = new Map<number, KojoXmlFile[]>();
  const byCom = new Map<string, number>();
  const diagnostics: KojoXmlDiagnostic[] = [];
  let commandCount = 0;
  for (const f of sorted) {
    if (f.charaNo !== null) {
      const bucket = byChara.get(f.charaNo);
      if (bucket) bucket.push(f);
      else byChara.set(f.charaNo, [f]);
    }
    for (const c of f.commands) {
      commandCount++;
      const key = c.attrs['com'] ?? '';
      byCom.set(key, (byCom.get(key) ?? 0) + 1);
    }
    diagnostics.push(...f.diagnostics);
  }
  return {
    files: sorted,
    commandCount,
    byChara: new Map([...byChara.entries()].sort((a, b) => a[0] - b[0])),
    byCom,
    diagnostics,
    scannedAt: 1,
  };
}

/** 主夹具：2 个有编号角色（3 份文件）+ 1 份未归属文件，共 6 条条目 */
function mainFixture(): KojoXmlIndex {
  return makeIndex([
    file('root/1001_a/KOJO_K1001_COM.xml', 1001, [
      cmd({ com: '1000', name: '挨拶', kojoPlace: 'TOP', priority: '1' }, '「早上好」', 3, 0),
      cmd({ com: '300', name: '会話', kojoPlace: 'TOP', priority: '1' }, '「有什么事吗」', 8, 1),
      cmd({ name: '独白', priority: '9' }, '「……」（无 com）', 13, 2),
    ]),
    file('root/1001_a/KOJO_K1001_EVENT.xml', 1001, [
      cmd({ com: '30', name: '短', kojoPlace: 'BOTTOM' }, '「嗯」', 2, 0),
    ]),
    file('root/1002_b/KOJO_K1002_COM.xml', 1002, [
      cmd({ com: '300', name: '会話', kojoPlace: 'TOP', priority: '2' }, '「台词片段」', 4, 0),
    ]),
    file('root/loose/KOJO_UNKNOWN.xml', null, [
      cmd({ com: '300', name: '会話', kojoPlace: 'TOP' }, '「孤儿文件」', 6, 0),
    ]),
  ]);
}

const NAMES = new Map<number, string>([
  [1001, '阿莉丝'],
  [1002, '贝拉'],
]);

/* ------------------------------ 用例 ------------------------------ */

describe('buildPanelTree：角色分组', () => {
  it('把 4 份文件归成 3 组（2 个角色 + 1 个未归属），条目数 6', () => {
    const tree = buildPanelTree(mainFixture(), NAMES);
    expect(tree.charas.length).toBe(3);
    expect(tree.fileCount).toBe(4);
    expect(tree.commandCount).toBe(6);
    // 「未归属」不算一个角色：角色数是 2
    expect(tree.charaCount).toBe(2);
  });

  it('角色名取自角色表，取不到的显示 #编号', () => {
    const tree = buildPanelTree(mainFixture(), new Map([[1001, '阿莉丝']]));
    expect(tree.charas[0]?.label).toBe('阿莉丝');
    expect(tree.charas[1]?.label).toBe('#1002');
  });

  it('角色号解析不到的文件进「未归属」，且恒排在最后一组', () => {
    const tree = buildPanelTree(mainFixture(), NAMES);
    const last = tree.charas[tree.charas.length - 1];
    expect(last?.label).toBe('未归属');
    expect(last?.charaNo).toBe(null);
    expect(last?.fileCount).toBe(1);
  });

  it('同一角色的多份文件按路径升序（b 排在 a 之后不受枚举顺序影响）', () => {
    const tree = buildPanelTree(mainFixture(), NAMES);
    const paths = tree.charas[0]?.files.map((f) => f.path) ?? [];
    expect(paths.length).toBe(2);
    expect(paths[0]).toBe('root/1001_a/KOJO_K1001_COM.xml');
    expect(paths[1]).toBe('root/1001_a/KOJO_K1001_EVENT.xml');
  });
});

describe('buildPanelTree：条目排序与行文案', () => {
  it('同一文件内按 com 数值升序（300 < 1000），com 缺席排最后', () => {
    const tree = buildPanelTree(mainFixture(), NAMES);
    const coms = tree.charas[0]?.files[0]?.commands.map((c) => c.com) ?? [];
    expect(coms.length).toBe(3);
    expect(coms).toEqual(['300', '1000', '']);
  });

  it('com 为数字串时按数值比，不按字典序（300 在 1000 之前）', () => {
    expect(compareCom('300', '1000')).toBeLessThan(0);
    expect(compareCom('1000', '300')).toBeGreaterThan(0);
    // 字典序会把 1000 排在 300 前——这正是要避开的错序
    expect('1000' < '300').toBe(true);
  });

  it('条目行标题：com + name 拼「com · name」，缺项只显示剩下那项', () => {
    expect(commandLabel('300', '会話', 0)).toBe('300 · 会話');
    expect(commandLabel('', '会話', 0)).toBe('会話');
    expect(commandLabel('300', '', 0)).toBe('300');
  });

  it('com 与 name 都缺时回退「条目 #序号」（序号 1 基）', () => {
    expect(commandLabel('', '', 1)).toBe('条目 #2');
  });

  it('副标题拼「kojoPlace / priority」，缺一段少一段，全缺为空串', () => {
    expect(commandSubtitle({ kojoPlace: 'TOP', priority: '1' })).toBe('TOP / 1');
    expect(commandSubtitle({ priority: '9' })).toBe('9');
    expect(commandSubtitle({})).toBe('');
  });

  it('跳转坐标取 command.span.start（1 基行列，原样透传）', () => {
    const tree = buildPanelTree(mainFixture(), NAMES);
    const command = tree.charas[0]?.files[0]?.commands[0];
    expect(command?.line).toBe(8);
    expect(command?.column).toBe(3);
    expect(command?.filePath).toBe('root/1001_a/KOJO_K1001_COM.xml');
  });

  it('节点带上条目原文（引用同一枚，不复制）：预览要把它交给服务的 preview()', () => {
    const index = mainFixture();
    const origin = index.files[0]!.commands[1]!;
    const tree = buildPanelTree(index, NAMES);
    const projected = tree.charas[0]?.files[0]?.commands.find((c) => c.com === '300');
    expect(projected?.source).toBe(origin);
  });
});

describe('conditionLabel：条件文案', () => {
  it('取值匹配拼「属性 = 取值」，取反拼「属性 ≠ 取值」', () => {
    expect(conditionLabel({ source: 'isFall', kind: 'value', expression: 'LOVER', negated: false })).toBe(
      'isFall = LOVER',
    );
    expect(conditionLabel({ source: 'isFall', kind: 'value', expression: 'LOVER', negated: true })).toBe(
      'isFall ≠ LOVER',
    );
  });

  it('表达式条件拼「属性: 表达式」，表达式原文照抄（面板不重排、不加括号）', () => {
    expect(
      conditionLabel({ source: 'eval', kind: 'expr', expression: 'TSTR:X == "Y"', negated: false }),
    ).toBe('eval: TSTR:X == "Y"');
  });

  it('expr 的 negated 不参与拼装（契约里 expr 的取反留在表达式内）', () => {
    expect(conditionLabel({ source: 'eval', kind: 'expr', expression: 'A', negated: true })).toBe(
      'eval: A',
    );
  });
});

describe('filterPanelTree：纯前端搜索', () => {
  it('角色名命中时整组保留（6 条里命中 4 条，不按命令名再筛）', () => {
    const tree = filterPanelTree(buildPanelTree(mainFixture(), NAMES), '阿莉丝');
    expect(tree.charas.length).toBe(1);
    expect(tree.commandCount).toBe(4);
  });

  it('命令名命中只留命中条目，空文件被折叠（4 份文件收敛到 3 份）', () => {
    const tree = filterPanelTree(buildPanelTree(mainFixture(), NAMES), '会話');
    expect(tree.commandCount).toBe(3);
    expect(tree.fileCount).toBe(3);
  });

  it('台词片段可搜，且忽略首尾空格与大小写', () => {
    const tree = filterPanelTree(buildPanelTree(mainFixture(), NAMES), '  台词片段  ');
    expect(tree.commandCount).toBe(1);
    expect(tree.charas[0]?.label).toBe('贝拉');
  });

  it('无命中时树为空，但诊断计数原样保留', () => {
    const index = makeIndex([
      file('root/a.xml', 1001, [cmd({ com: '1', name: '会話' }, '「x」', 2, 0)], [
        diag('root/a.xml', 2, 'error', '坏属性'),
      ]),
    ]);
    const tree = filterPanelTree(buildPanelTree(index, NAMES), '不存在的词');
    expect(tree.charas.length).toBe(0);
    expect(tree.commandCount).toBe(0);
    expect(tree.diagnostics.total).toBe(1);
  });

  it('空查询串不过滤（原样返回同一棵树）', () => {
    const built = buildPanelTree(mainFixture(), NAMES);
    expect(filterPanelTree(built, '   ')).toBe(built);
  });
});

describe('诊断计数与展开列表', () => {
  const withDiagnostics = (): KojoXmlIndex =>
    makeIndex([
      file('root/a.xml', 1001, [cmd({ com: '1', name: '会話' }, '「x」', 2, 0)], [
        diag('root/a.xml', 2, 'error', '属性值越界'),
        diag('root/a.xml', 5, 'warning', 'com 缺失'),
        diag('root/a.xml', 9, 'info', '可忽略'),
      ]),
    ]);

  it('按严重级分档计数：3 条里 error 1 / warning 1 / info 1', () => {
    const tree = buildPanelTree(withDiagnostics(), NAMES);
    expect(tree.diagnostics.total).toBe(3);
    expect(tree.diagnostics.error).toBe(1);
    expect(tree.diagnostics.warning).toBe(1);
    expect(tree.diagnostics.info).toBe(1);
  });

  it('摘要文案为「诊断 3 条（error 1 / warning 1）」（info 不计入括号）', () => {
    expect(diagnosticSummary(buildPanelTree(withDiagnostics(), NAMES))).toBe(
      '诊断 3 条（error 1 / warning 1）',
    );
  });

  it('展开列表默认截断到 50 条，首行带 path 与行号', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      diag('root/a.xml', i + 1, 'warning', `第 ${i + 1} 条`),
    );
    const index = makeIndex([file('root/a.xml', 1001, [], many)]);
    const rows = diagnosticRows(index);
    expect(DIAGNOSTIC_ROW_LIMIT).toBe(50);
    expect(rows.length).toBe(50);
    expect(rows[0]?.path).toBe('root/a.xml');
    expect(rows[0]?.line).toBe(1);
    expect(diagnosticRows(index, 2).length).toBe(2);
  });
});

describe('空索引与缺席服务', () => {
  it('空索引（0 份文件）投影出 0 组 / 0 条 / 0 角色', () => {
    const tree = buildPanelTree(makeIndex([]), NAMES);
    expect(tree.charas.length).toBe(0);
    expect(tree.fileCount).toBe(0);
    expect(tree.commandCount).toBe(0);
    expect(tree.charaCount).toBe(0);
    expect(panelStatsLine(tree)).toBe('0 份 / 0 条 / 0 个角色');
  });

  it('索引为 null（服务未扫完 / 缺席）投影出同一份空树，不抛错', () => {
    const tree = buildPanelTree(null, NAMES);
    expect(tree.charas.length).toBe(0);
    expect(tree.commandCount).toBe(0);
    expect(tree.diagnostics.total).toBe(0);
    expect(diagnosticRows(null).length).toBe(0);
  });

  it('统计行写「4 份 / 6 条 / 2 个角色」', () => {
    expect(panelStatsLine(buildPanelTree(mainFixture(), NAMES))).toBe('4 份 / 6 条 / 2 个角色');
  });
});
