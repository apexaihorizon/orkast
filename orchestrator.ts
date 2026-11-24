// orchestrator.ts — Thin API Orchestrator (Flat-IR -> ESTree -> astring + tsc)
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type * as ESTree from "estree";
import { buildESTreeFromIR, type FlatProgramIR, type PrimitiveType } from "./ir-bridge.ts";
import { compileESTree, type RuntimeValue } from "./runtime.ts";

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

function formatVal(v: RuntimeValue): string {
  return typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v);
}

export async function orchestrateProgram(
  spec: ProgramSpec,
  apiKey: string,
  maxAttempts = 4
): Promise<{ estree: ESTree.Program; tsCode: string }> {
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const feedback: string[] = [];
  const models = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", ]
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n🔄 Attempt ${attempt}/${maxAttempts}: Requesting Flat-IR...`);

    const prompt = [
      "Assemble a deterministic FlatProgramIR (`exprs` DAG + ordered `stmts`). Never emit code.",
      "- `exprs`: NUM (`num`), STR (`str`), BOOL (`bool`), VAR (`name`), BIN_OP (`op`, `left`, `right`).",
      "- `stmts`: LET (`name`, `varType`, `expr`), SET (`name`, `expr`), IF_RET (`cond`, `expr`), RET (`expr`).",
      "- Order `IF_RET` checks from lowest/strictest boundary up, and ALWAYS end `stmts` with a final `RET`.",
      `Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests:\n${spec.tests.map((t) => `- [${t.label}] args=${JSON.stringify(t.args)} => expected=${formatVal(t.expected)}`).join("\n")}`,
      feedback.length > 0 ? `\nFix these exact counterexamples:\n${feedback.join("\n")}` : "",
    ].join("\n");

    const response = await ai.models.generateContent({
      model: models[0],
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", responseSchema: IR_SCHEMA, temperature: 0.1 },
    });

    if (!response.text) throw new Error("Empty model response.");
    const ir = JSON.parse(response.text) as FlatProgramIR;

    // 1. Flat-IR -> Standard ESTree
    const { estree, errors: bridgeErrors } = buildESTreeFromIR(spec, ir);
    if (!estree || bridgeErrors.length > 0) {
      const msg = `Attempt ${attempt} failed IR bridge:\n- ${bridgeErrors.join("\n- ")}`;
      console.log(`⚠️  ${msg}`);
      feedback.push(msg);
      continue;
    }

    // 2. astring codegen + TypeScript Compiler API static check + V8 bind
    const compiled = compileESTree(spec, estree);
    if (compiled.diagnostics.length > 0 || !compiled.run || !compiled.tsCode) {
      const msg = `Attempt ${attempt} failed TypeScript diagnostics:\n- ${compiled.diagnostics.join("\n- ")}`;
      console.log(`⚠️  ${msg}`);
      feedback.push(msg);
      continue;
    }

    // 3. Edge-case runtime verification
    const failures: string[] = [];
    for (const t of spec.tests) {
      const actual = compiled.run(...t.args);
      const passed = Number.isNaN(t.expected) ? Number.isNaN(actual) : actual === t.expected;
      if (!passed) {
        failures.push(
          `Test [${t.label}] failed: input=${JSON.stringify(t.args)}, expected=${formatVal(t.expected)}, got=${formatVal(actual)}`
        );
      }
    }

    if (failures.length === 0) {
      console.log(`✅ All ${spec.tests.length} tests passed on attempt ${attempt}!`);
      return { estree, tsCode: compiled.tsCode };
    }

    const failMsg = `Attempt ${attempt} failed runtime tests:\n- ${failures.join("\n- ")}`;
    console.log(`❌ ${failMsg}`);
    feedback.push(failMsg);
  }

  throw new Error(`Failed to synthesize verified ESTree graph within ${maxAttempts} attempts.`);
}