# M2 多文件项目示例

本目录是一份可运行的最小多文件 Kojo 2.0 项目，也是 M2 项目级编译的开发者示例。

## 文件

- `01-shrine.kojo2`：`初见` + 地点 `神社`；
- `02-school.kojo2`：`初见` + 地点 `学校`；
- `compile-project.example.ts`：自包含 TS 示例，使用 `@kojo/kojo-core`、`@kojo/plugin-api` 与 `@kojo/plugin-eratw-adapter` 编译本目录两份源文件。

两份 `.kojo2` 使用不同地点，因此属于同一 canonical target（`eratw.event.初见`）的候选组，而不是 exact duplicate。M2 会为每个 Theater 生成单 Theater ERB，但**不会**生成最终 dispatch ERB。

## 运行

仓库根目录执行：

```powershell
node node_modules/vitest/vitest.mjs run packages/plugins/eratw-adapter/tests/kojo2/example-project.test.ts --reporter=dot
```

该用例会读取本目录两份 `.kojo2`，并断言：

- `compileProject` 构建成功、`complete === true`；
- Project IR 有 2 个文件 / 2 个 Theater；
- `linkedProject.groups` 只有 1 个「初见」候选组，且 `duplicate === false`；
- `theaterErb` 有 2 份，函数名分别包含 `M_KOJO_ENCOUNTER_K12` / `M_KOJO_ENCOUNTER_K13`。

## Core 用法

`compile-project.example.ts` 是完整版本。核心调用形状：

```ts
const result = compileProject({
  projectId: 'm2-example',
  provenance,
  files: [
    {
      identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(text)),
      file: parseSource(text),
      sourceText: text,
      functionNameContext: { charNo: '12', familySegment: '' },
    },
  ],
  registry: ERATW_TARGET_REGISTRY,
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
});
```

注意：

- `compileProject` 不读盘；`sourceText` 与已解析的 `file` 由宿主提供。
- `familySegment` 是 Host 事实。标准版显式给 `''`；没有事实时不要伪造空串。
- 构建失败时 `theaterErb` 为空数组；`LinkedProject` 只作为诊断视图存在。

## Host 用法

宿主入口 `compileKojo2Project` 复用同一套边界，并支持统一的 `contextOf` 注入：

```ts
const result = compileKojo2Project({
  projectId: 'm2-example',
  provenance,
  project,
  documents,
  adapter: ERATW_GAME_ADAPTER,
  backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
  registry: ERATW_TARGET_REGISTRY,
  contextOf: ({ path }) => ({
    charNo: charNoForProjectPath(project, path),
    // 有标准版事实时显式空串；没有事实时不要写这个键
    familySegment: '',
  }),
});
```

`contextOf` 缺席（或返回 `undefined`）等价于 `{}`，不会补默认 `familySegment`；显式 `familySegment: ''` 会作为 own property 保留。

## 已知边界

- 当前没有 familySegment producer；Host 必须显式提供。
- 显式 Theater 的 `指令` 缺少 `i` 时为 `needs-context`，M2 不从 raw target 猜参数。
- M2 不生成最终 dispatch ERB；M3 才做 location/time matcher、specificity 与唯一选择。
- 更完整的契约与失败语义见 `docs/KOJO-2.0-M2-IMPLEMENTATION.md`。