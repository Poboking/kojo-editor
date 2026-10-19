/**
 * CST 节点名 ↔ `classifyLine` 的 `LineClass.kind` 单一映射（语法层契约 / 冻结词表）。
 *
 * 为什么住这里：grammar 是「语法的第二份真源」。CST 的每行节点分类必须能与
 * `kojo-sugar` 的 `classifyLine` 逐行对照（`packages/kojo-syntax-tree/tests` 的语料一致率闸）。
 * 这张表把两侧钉在一起——改节点名要同时改 grammar.js 与此表，否则对照闸红。
 *
 * 命名纪律（铁律 1 / 审计 A）：节点名只用**语言词**（block / statement / string /
 * comment / native_line …），**禁止游戏名词**。宿主侧（worker / Monaco）只认这些节点名，
 * 不认任何 `classifyLine` 的内部字段。
 *
 * 值 = grammar.js 里的规则名（snake_case）。左键 = `LineClass['kind']`。
 */
export const KIND_TO_NODE = {
  blank: 'blank_line',
  comment: 'comment_line',
  rawLine: 'native_line',
  rawBlockStart: 'raw_block_start',
  headDecl: 'head_decl',
  aliasDecl: 'alias_decl',
  constDecl: 'const_decl',
  switchItem: 'switch_item',
  timingHead: 'timing_head',
  customCommandHead: 'custom_command_head',
  ifHead: 'if_head',
  whenHead: 'when_head',
  caseHead: 'case_head',
  randomHead: 'random_head',
  randomInline: 'random_inline',
  branchHead: 'branch_head',
  ruleTag: 'rule_tag',
  randomShapeDecl: 'random_shape_decl',
  groupHead: 'group_head',
  sectionHead: 'section_head',
  onceHead: 'once_head',
  choiceHead: 'choice_head',
  menuHead: 'menu_head',
  askMHead: 'ask_m_head',
  askYNHead: 'ask_yn_head',
  choiceItem: 'choice_item',
  colorHead: 'color_head',
  heartHead: 'heart_head',
  exprHead: 'expr_head',
  messageCheck: 'message_check',
  arrowCase: 'arrow_case',
  arrowElse: 'arrow_else',
  settle: 'settle',
  mutator: 'mutator',
  statementCall: 'statement_call',
  assign: 'assign',
  blankLine: 'blank_line_cmd',
  heartText: 'heart_text',
  text: 'text_line',
  functionHead: 'function_head',
  callStatement: 'call_statement',
  returnStatement: 'return_statement',
  singleIfHead: 'single_if_head',
  loopHead: 'loop_head',
  loopEnd: 'loop_end',
  catchHead: 'catch_head',
  catchEnd: 'catch_end',
  dataHead: 'data_head',
  dataEnd: 'data_end',
  dataEntry: 'data_entry',
  jumpStatement: 'jump_statement',
  functionJump: 'function_jump',
  labelDecl: 'label_decl',
  loopFlow: 'loop_flow',
  loopStep: 'loop_step',
  controlMalformed: 'control_malformed',
} as const satisfies Record<string, string>;

export type KojoKind = keyof typeof KIND_TO_NODE;
export type KojoNode = (typeof KIND_TO_NODE)[KojoKind];

/** 反向表：CST 节点名 → classifyLine kind（worker / 对照测试按节点名反查）。 */
export const NODE_TO_KIND: Record<KojoNode, KojoKind> = Object.fromEntries(
  (Object.entries(KIND_TO_NODE) as [KojoKind, KojoNode][]).map(([k, v]) => [v, k]),
) as Record<KojoNode, KojoKind>;

/** 非分类节点（词法 / 结构容器）——不参与逐行 kind 对照。 */
export const NON_LINE_NODES: ReadonlySet<string> = new Set([
  'source_file',
  'block',
  'block_body',
  'string',
  'native_string',
  'interpolation',
  'comment_inline',
  'number',
  'variable',
  'ERROR',
  'MISSING',
]);
