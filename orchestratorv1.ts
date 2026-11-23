// orchestrator.ts — Assembles and repairs FunctionGraph AST blocks via Structured Output
// Zero syntax generation allowed: the model only emits typed AST block JSON.
import { GoogleGenAI } from "@google/genai";
import type { FunctionGraph, PrimitiveType } from "./ast.ts";
import { validateGraph } from "./validate.ts";
import { compileGraph, type RuntimeValue } from "./runtime.ts";

export interface TestCase {
  label: string;
  args: RuntimeValue[];
  expected: RuntimeValue;
}

export interface ProgramSpec {
  name: string;
  description: string;
  params: Array<{ name: string; paramType: PrimitiveType }>;
  returnType: PrimitiveType;
  tests: TestCase[];
}

// Strict JSON Schema restricting the AI strictly to Orkast AST blocks (supports recursive expressions/statements)
const BLOCK_GRAPH_SCHEMA = {
  type: "object",
  properties: {
    body: {
      type: "array",
      items: { $ref: "#/$defs/stmt" },
    },
  },
  required: ["body"],
  $defs: {
    expr: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["LITERAL", "VAR_REF", "BINARY_OP", "UNARY_OP"] },
        valueType: { type: "string", enum: ["number", "boolean", "string"] },
        value: { type: "string", description: "Value serialized as string; runtime parser casts via valueType" },
        name: { type: "string" },
        op: {
          type: "string",
          enum: ["+", "-", "*", "/", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "!"],
        },
        left: { $ref: "#/$defs/expr" },
        right: { $ref: "#/$defs/expr" },
        operand: { $ref: "#/$defs/expr" },
      },
      required: ["kind"],
    },
    stmt: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["DECLARE", "ASSIGN", "IF_ELSE", "WHILE", "RETURN"] },
        name: { type: "string" },
        varType: { type: "string", enum: ["number", "boolean", "string"] },
        init: { $ref: "#/$defs/expr" },
        value: { $ref: "#/$defs/expr" },
        condition: { $ref: "#/$defs/expr" },
        thenBranch: { type: "array", items: { $ref: "#/$defs/stmt" } },
        elseBranch: { type: "array", items: { $ref: "#/$defs/stmt" } },
        body: { type: "array", items: { $ref: "#/$defs/stmt" } },
      },
      required: ["kind"],
    },
  },
};

// Normalizes LITERAL values from schema transport strings into exact JS primitives
function hydrateLiterals(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(hydrateLiterals);
  if (node && typeof node === "object") {
    const obj = { ...(node as Record<string, unknown>) };
    if (obj.kind === "LITERAL" && typeof obj.value === "string") {
      if (obj.valueType === "number") obj.value = Number(obj.value);
      else if (obj.valueType === "boolean") obj.value = obj.value === "true";
    }
    for (const key of Object.keys(obj)) {
      obj[key] = hydrateLiterals(obj[key]);
    }
    return obj;
  }
  return node;
}

async function requestBlockProposal(
  ai: GoogleGenAI,
  spec: ProgramSpec,
  feedbackHistory: string[],
  model = "models/gemini-flash-lite-latest"
): Promise<FunctionGraph> {
  const prompt = [
    "You are an AST Block Orchestrator. You CANNOT write source code text.",
    "Assemble a valid sequence of typed AST blocks (`body`) that satisfies the specification and every test case.",
    "Rules: Every BINARY_OP must include `op`, `left`, and `right`. Every IF_ELSE must include `condition` and `thenBranch`.",
    `Function Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
    `Intent: ${spec.description}`,
    `Edge-Case Tests:\n${spec.tests.map((t) => `- [${t.label}] args=${JSON.stringify(t.args)} => expected=${JSON.stringify(t.expected)}`).join("\n")}`,
    feedbackHistory.length > 0
      ? `\nPrevious attempts failed. Fix these exact structural/logic counterexamples:\n${feedbackHistory.join("\n")}`
      : "",
  ].join("\n");

  const interaction = await ai.interactions.create({
    model,
    input: prompt,
    response_format: BLOCK_GRAPH_SCHEMA,
    response_mime_type: "application/json",
    generation_config: {
      temperature: 0.1,
      thinking_level: "low",
    },
  });

  const lastStep = interaction.steps?.at(-1) as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const rawJson = lastStep?.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;

  if (!rawJson) {
    throw new Error(`Empty block response in final step: ${JSON.stringify(lastStep)}`);
  }

  const hydrated = hydrateLiterals(JSON.parse(rawJson)) as { body: FunctionGraph["body"] };
  return {
    name: spec.name,
    params: spec.params,
    returnType: spec.returnType,
    body: hydrated.body,
  };
}
export async function orchestrateProgram(
  specOrKey: ProgramSpec | string,
  apiKeyOrSpec: string | ProgramSpec,
  maxAttempts = 4
): Promise<{ graph: FunctionGraph; tsCode: string }> {
  // Handles both orchestrateProgram(spec, apiKey) and orchestrateProgram(apiKey, spec)
  const spec = typeof specOrKey === "string" ? (apiKeyOrSpec as ProgramSpec) : specOrKey;
  const apiKey = typeof specOrKey === "string" ? specOrKey : (apiKeyOrSpec as string);

  if (!spec || !Array.isArray(spec.params)) {
    throw new Error(`Invalid ProgramSpec passed to orchestrateProgram: ${JSON.stringify(spec)}`);
  }

  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const feedback: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n🔄 Attempt ${attempt}/${maxAttempts}: Requesting AST block arrangement...`);
    const graph = await requestBlockProposal(ai, spec, feedback);

    // Gate 1: Deterministic Static Scope & Type Check
    const staticErrors = validateGraph(graph);
    if (staticErrors.length > 0) {
      const msg = `Attempt ${attempt} failed static AST validation:\n- ${staticErrors.join("\n- ")}`;
      console.log(`⚠️  ${msg}`);
      feedback.push(msg);
      continue;
    }

    // Gate 2: Deterministic Lowering + Edge-Case Execution
    const compiled = compileGraph(graph);
    const failures: string[] = [];

    for (const t of spec.tests) {
      const actual = compiled.run(...t.args);
      const passed = Number.isNaN(t.expected) ? Number.isNaN(actual) : actual === t.expected;
      if (!passed) {
        failures.push(
          `Test [${t.label}] failed: input=${JSON.stringify(t.args)}, expected=${JSON.stringify(t.expected)}, got=${JSON.stringify(actual)}`
        );
      }
    }

    if (failures.length === 0) {
      console.log(`✅ All ${spec.tests.length} edge-case tests passed on attempt ${attempt}!`);
      return { graph, tsCode: compiled.tsCode };
    }

    const failMsg = `Attempt ${attempt} compiled cleanly, but failed edge-case tests:\n- ${failures.join("\n- ")}`;
    console.log(`❌ ${failMsg}`);
    feedback.push(failMsg);
  }

  throw new Error(`Failed to synthesize verified block graph within ${maxAttempts} attempts.`);
}