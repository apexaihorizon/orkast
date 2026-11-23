// orchestrator.ts — Thin API Orchestrator (delegates all IR/AST logic to ir-bridge & runtime)
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type { FunctionGraph, PrimitiveType } from "./ast.ts";
import { buildASTFromIR, type FlatProgramIR } from "./ir-bridge.ts";
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

const IR_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    exprs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          kind: { type: Type.STRING, enum: ["NUM", "STR", "BOOL", "VAR", "BIN_OP"] },
          num: { type: Type.NUMBER },
          str: { type: Type.STRING },
          bool: { type: Type.BOOLEAN },
          name: { type: Type.STRING },
          op: { type: Type.STRING, enum: ["+", "-", "*", "/", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||"] },
          left: { type: Type.STRING },
          right: { type: Type.STRING },
        },
        required: ["id", "kind"],
      },
    },
    stmts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: ["LET", "SET", "IF_RET", "RET"] },
          name: { type: Type.STRING },
          varType: { type: Type.STRING, enum: ["number", "boolean", "string"] },
          cond: { type: Type.STRING },
          expr: { type: Type.STRING },
        },
        required: ["kind", "expr"],
      },
    },
  },
  required: ["exprs", "stmts"],
};

export async function orchestrateProgram(
  spec: ProgramSpec,
  apiKey: string,
  maxAttempts = 4
): Promise<{ graph: FunctionGraph; tsCode: string }> {
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const feedback: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n🔄 Attempt ${attempt}/${maxAttempts}: Requesting Flat-IR...`);

    const prompt = [
      "Assemble a deterministic FlatProgramIR (`exprs` DAG + ordered `stmts`). Never emit code.",
      "- `exprs`: NUM (`num`), STR (`str`), BOOL (`bool`), VAR (`name`), BIN_OP (`op`, `left`, `right`).",
      "- `stmts`: LET (`name`, `varType`, `expr`), SET (`name`, `expr`), IF_RET (`cond`, `expr`), RET (`expr`).",
      "- Order `IF_RET` checks from lowest/strictest boundary up, and ALWAYS end `stmts` with a final `RET`.",
      `Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests:\n${spec.tests.map((t) => `- [${t.label}] args=${JSON.stringify(t.args)} => expected=${JSON.stringify(t.expected)}`).join("\n")}`,
      feedback.length > 0 ? `\nFix these exact counterexamples:\n${feedback.join("\n")}` : "",
    ].join("\n");

    const response = await ai.models.generateContent({
      model: "gemini-flash-lite-latest",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", responseSchema: IR_SCHEMA, temperature: 0.1 },
    });

    if (!response.text) throw new Error("Empty model response.");
    const ir = JSON.parse(response.text) as FlatProgramIR;

    // 1. Deterministic IR -> AST Bridge
    const { graph, errors: bridgeErrors } = buildASTFromIR(spec, ir);
    if (!graph || bridgeErrors.length > 0) {
      const msg = `Attempt ${attempt} failed IR bridge:\n- ${bridgeErrors.join("\n- ")}`;
      console.log(`⚠️  ${msg}`);
      feedback.push(msg);
      continue;
    }

    // 2. Deterministic Static Validation
    const staticErrors = validateGraph(graph);
    if (staticErrors.length > 0) {
      const msg = `Attempt ${attempt} failed static validation:\n- ${staticErrors.join("\n- ")}`;
      console.log(`⚠️  ${msg}`);
      feedback.push(msg);
      continue;
    }

    // 3. Deterministic Compile + Test Execution
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
      console.log(`✅ All ${spec.tests.length} tests passed on attempt ${attempt}!`);
      return { graph, tsCode: compiled.tsCode };
    }

    const failMsg = `Attempt ${attempt} failed runtime tests:\n- ${failures.join("\n- ")}`;
    console.log(`❌ ${failMsg}`);
    feedback.push(failMsg);
  }

  throw new Error(`Failed to synthesize verified graph within ${maxAttempts} attempts.`);
}