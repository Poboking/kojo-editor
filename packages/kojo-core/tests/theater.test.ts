/**
 * M1 剧场语法前端：词法精确前缀、剧场头字段、体边界、旧 # 机 隐式剧场与混用诊断。
 */
import { describe, expect, it } from "vitest";
import type { KojoConditionChain, KojoFile, KojoTextLine } from "../src/ast.js";
import { lex } from "../src/lexer.js";
import { parseSource } from "../src/parser.js";

function src(...lines: string[]): string {
  return lines.join("\n");
}

function errorCodesOf(file: KojoFile): string[] {
  return file.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function firstError(file: KojoFile, code: string) {
  return file.diagnostics.find((d) => d.code === code);
}

describe("theater：词法前缀与 hasTheaterSyntax", () => {
  it("只认行首精确前缀；全角/半角冒号都标 theater", () => {
    const full = lex("【剧场：初见｜神社｜夜】");
    const half = lex("【剧场:初见｜神社｜夜】");
    expect(full.hasTheaterSyntax).toBe(true);
    expect(half.hasTheaterSyntax).toBe(true);
    expect(full.lines[0]!.kind).toBe("theater");
    expect(half.lines[0]!.kind).toBe("theater");
    if (full.lines[0]!.kind === "theater") expect(full.lines[0]!.prefix).toBe("fullwidth");
    if (half.lines[0]!.kind === "theater") expect(half.lines[0]!.prefix).toBe("halfwidth");
  });

  it("普通【】不误判：旁白/台词/模板正文/原生块", () => {
    const narration = lex("> 【剧场：不是头】");
    expect(narration.lines[0]!.kind).toBe("narration");
    expect(narration.hasTheaterSyntax).toBe(false);

    const dialogue = lex("灵梦：「【剧场：不是头】」");
    expect(dialogue.lines[0]!.kind).toBe("dialogue");
    expect(dialogue.hasTheaterSyntax).toBe(false);

    const template = parseSource(src("# 模 礼物", "    【宝物】"));
    expect(template.hasTheaterSyntax).toBe(false);
    expect(template.theaters ?? []).toEqual([]);

    const native = parseSource(src("@原生", "    【剧场：不是头】"));
    expect(native.hasTheaterSyntax).toBe(false);
    expect(native.theaters ?? []).toEqual([]);
  });

  it("插值里的剧场字样只是正文片段", () => {
    const file = parseSource("> 你看：{【剧场：不是头】}");
    expect(file.hasTheaterSyntax).toBe(false);
    const line = file.scenes[0]!.items[0] as KojoTextLine;
    expect(line.kind).toBe("textLine");
    expect(line.parts.some((part) => part.kind === "interp")).toBe(true);
  });
});

describe("theater：头字段", () => {
  it("单剧场：目标/地点/时间进 AST，体不靠缩进", () => {
    const file = parseSource(src("【剧场：初见｜神社｜夜晚】", "> 第一行", "> 第二行"));
    expect(file.hasTheaterSyntax).toBe(true);
    expect(file.theaters).toHaveLength(1);
    const theater = file.theaters![0]!;
    expect(theater.origin).toBe("theater");
    expect(theater.target.raw).toBe("初见");
    expect(theater.location).toMatchObject({ kind: "exact", raw: "神社" });
    expect(theater.time).toMatchObject({ kind: "named", raw: "夜晚" });
    expect(theater.scenes).toHaveLength(1);
    expect(theater.scenes[0]!.items).toHaveLength(2);
    expect(theater.bodySpan).not.toBeNull();
    expect(errorCodesOf(file)).toEqual([]);
  });

  it("多剧场 + # 幕 只切场景不结束剧场", () => {
    const file = parseSource(src(
      "【剧场：初见】",
      "# 幕 相遇",
      "> 一",
      "# 幕 告别",
      "> 二",
      "【剧场：再见｜不限｜不限】",
      "> 三",
    ));
    expect(file.theaters).toHaveLength(2);
    expect(file.theaters![0]!.scenes.map((scene) => scene.title)).toEqual(["相遇", "告别"]);
    expect(file.theaters![1]!.scenes[0]!.items).toHaveLength(1);
    expect(file.scenes.map((scene) => scene.title)).toEqual(["相遇", "告别", null]);
    expect(errorCodesOf(file)).toEqual([]);
  });

  it("全角/半角分隔符等价；省略字段默认 unrestricted", () => {
    const file = parseSource("【剧场：初见|神社｜夜晚】");
    const theater = file.theaters![0]!;
    expect(theater.location).toMatchObject({ kind: "exact", raw: "神社" });
    expect(theater.time).toMatchObject({ kind: "named", raw: "夜晚" });
    const bare = parseSource("【剧场：初见】").theaters![0]!;
    expect(bare.location).toEqual({ kind: "unrestricted", raw: "", span: null });
    expect(bare.time).toEqual({ kind: "unrestricted", raw: "", span: null });
  });

  it("显式 不限 保留字段原文与 span", () => {
    const theater = parseSource("【剧场：初见｜不限｜不限】").theaters![0]!;
    expect(theater.location.kind).toBe("unrestricted");
    expect(theater.location.raw).toBe("不限");
    expect(theater.location.span).not.toBeNull();
    expect(theater.time.kind).toBe("unrestricted");
    expect(theater.time.raw).toBe("不限");
    expect(theater.time.span).not.toBeNull();
  });

  it("尾部空字段省略；中间空字段报错", () => {
    const ok = parseSource("【剧场：初见｜神社｜】");
    expect(errorCodesOf(ok)).toEqual([]);
    expect(ok.theaters![0]!.time).toEqual({ kind: "unrestricted", raw: "", span: null });

    const bad = parseSource("【剧场：初见｜｜夜晚】");
    expect(errorCodesOf(bad)).toContain("core/theater/syntax");
    expect(bad.theaters).toEqual([]);
  });

  it("缺目标 / 目标写 不限 / 超过 3 段 / 缺收口 / 收口后有内容都报 syntax", () => {
    for (const source of [
      "【剧场：】",
      "【剧场：不限】",
      "【剧场：初见｜神社｜夜晚｜多余】",
      "【剧场：初见",
      "【剧场：初见】尾随",
    ]) {
      const file = parseSource(source);
      expect(errorCodesOf(file), source).toContain("core/theater/syntax");
      expect(file.theaters).toEqual([]);
    }
  });

  it("半角前缀报 syntax，但仍进新路径", () => {
    const file = parseSource("【剧场:初见】");
    expect(file.hasTheaterSyntax).toBe(true);
    expect(errorCodesOf(file)).toContain("core/theater/syntax");
    expect(file.theaters).toEqual([]);
  });
});

describe("theater：体边界与声明", () => {
  it("条件链不跨剧场：下一剧场另起场景", () => {
    const file = parseSource(src(
      "【剧场：A】",
      "? 恋慕 >= 500",
      "    > 是",
      "【剧场：B】",
      "> B",
    ));
    expect(file.theaters).toHaveLength(2);
    const chain = file.theaters![0]!.scenes[0]!.items[0] as KojoConditionChain;
    expect(chain.kind).toBe("conditionChain");
    expect(chain.branches[0]!.body).toHaveLength(1);
    expect(file.theaters![1]!.scenes[0]!.items).toHaveLength(1);
  });

  it("@织 是文件级声明，不进任何剧场场景", () => {
    const file = parseSource(src(
      "【剧场：初见】",
      "> 前",
      "@织 回合末 之后",
      "    > 监听体",
      "> 后",
    ));
    expect(file.decls.map((decl) => decl.kind)).toContain("weave");
    expect(file.theaters).toHaveLength(1);
    expect(file.theaters![0]!.scenes[0]!.items).toHaveLength(2);
  });

  it("第一个剧场头之前的正文是 preamble，并报 body-before-header", () => {
    const file = parseSource(src("> 序", "【剧场：初见】", "> 正体"));
    const diag = firstError(file, "core/theater/body-before-header");
    expect(diag).toBeDefined();
    expect(diag!.span!.start.line).toBe(1);
    expect(file.scenes).toHaveLength(2);
    expect(file.theaters![0]!.scenes[0]!.items).toHaveLength(1);
  });

  it("畸形头吞掉后续正文，不挂到前一个剧场，也不入 theaters", () => {
    const file = parseSource(src(
      "【剧场：A】",
      "> a",
      "【剧场:B】",
      "> b",
    ));
    expect(file.theaters).toHaveLength(1);
    expect(file.theaters![0]!.scenes[0]!.items).toHaveLength(1);
    expect(errorCodesOf(file)).toContain("core/theater/syntax");
  });

  it("剧场头缩进进可执行块 → not-top-level（叙事区 + 调度区）", () => {
    const narrative = parseSource(src("@着色 0xFF8080", "    【剧场：A】", "        > x"));
    expect(errorCodesOf(narrative)).toContain("core/theater/not-top-level");
    expect(narrative.theaters).toEqual([]);

    const dispatch = parseSource(src("@算", "    【剧场：A】", "        x = 1"));
    expect(errorCodesOf(dispatch)).toContain("core/theater/not-top-level");
    expect(dispatch.theaters).toEqual([]);
  });
});

describe("theater：# 机 兼容与混用", () => {
  it("只有 # 机 的旧文件 synthesize legacy-machine 剧场", () => {
    const file = parseSource(src("# 机 指令 310", "> 旧正文"));
    expect(file.hasTheaterSyntax).toBe(false);
    expect(file.theaters).toHaveLength(1);
    const theater = file.theaters![0]!;
    expect(theater.origin).toBe("legacy-machine");
    expect(theater.legacyMachine?.event).toBe("指令");
    expect(theater.target.raw).toBe("指令");
    expect(theater.location).toEqual({ kind: "unrestricted", raw: "", span: null });
    expect(theater.time).toEqual({ kind: "unrestricted", raw: "", span: null });
    expect(theater.scenes).toHaveLength(1);
    expect(errorCodesOf(file)).toEqual([]);
  });

  it("# 机 在剧场头之前 → 在头处报 mixed-machine", () => {
    const file = parseSource(src("# 机 指令 310", "【剧场：初见】", "> x"));
    const diag = firstError(file, "core/theater/mixed-machine");
    expect(diag).toBeDefined();
    expect(diag!.span!.start.line).toBe(2);
    expect(file.decls.some((decl) => decl.kind === "machine")).toBe(true);
    expect(file.theaters).toHaveLength(1);
  });

  it("# 机 在剧场头之后 → 在机处报 mixed-machine，且不入 decls", () => {
    const file = parseSource(src("【剧场：初见】", "# 机 指令 310", "> x"));
    const diag = firstError(file, "core/theater/mixed-machine");
    expect(diag).toBeDefined();
    expect(diag!.span!.start.line).toBe(2);
    expect(file.decls.some((decl) => decl.kind === "machine")).toBe(false);
    expect(file.theaters).toHaveLength(1);
    expect(file.diagnostics.filter((d) => d.code === "core/theater/mixed-machine")).toHaveLength(1);
  });

  it("# 机 在正文之后：隐式剧场 span 仍覆盖正文与声明，不逆序", () => {
    const file = parseSource(src("> 旧正文", "# 机 指令 310"));
    const theater = file.theaters![0]!;
    expect(theater.origin).toBe("legacy-machine");
    expect(theater.span.start.line).toBe(1);
    expect(theater.span.end.line).toBe(2);
    expect(theater.span.start.line).toBeLessThanOrEqual(theater.span.end.line);
  });

  it("新剧场路径不再报 missing-machine", () => {
    const file = parseSource("【剧场：初见】\n> x");
    expect(errorCodesOf(file)).not.toContain("core/decl/missing-machine");
  });
});
