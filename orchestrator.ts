// orchestrator.ts — Thin Gemini CEGIS Orchestrator (delegates all parsing, sandboxing & checking to runtime.ts)
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type * as ESTree from "estree";
import { compileBodyToESTree, type PrimitiveType, type RuntimeValue } from "./runtime.ts";

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

const BODY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    body: {
      type: Type.STRING,
      description: "Pure JavaScript statements inside the function body (no function wrapper, no external calls)",
    },
  },
  required: ["body"],
};

const MODEL_POOL = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest"
];

function formatVal(v: RuntimeValue): string {
  return typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v);
}

async function requestBodyProposal(ai: GoogleGenAI, prompt: string): Promise<string> {
  let lastErr: unknown;
  for (const model of MODEL_POOL) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseMimeType: "application/json", responseSchema: BODY_SCHEMA, temperature: 0.1 },
        });
        if (res.text) {
          const parsed = JSON.parse(res.text) as { body: string };
          return parsed.body;
        }
      } catch (err: unknown) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("429")) {
          console.log(`⏳ ${model} busy (503/429), rotating model...`);
          await new Promise((r) => setTimeout(r, 1500 * (retry + 1)));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastErr;
}

export async function orchestrateProgram(
  spec: ProgramSpec,
  apiKey: string,
  maxAttempts = 4
): Promise<{ estree: ESTree.Program; tsCode: string }> {
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const feedback: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n🔄 Attempt ${attempt}/${maxAttempts}: Synthesizing function body...`);

    const prompt = [
      "Return ONLY the statements inside the function body (`body` field, no `function` wrapper, no TypeScript annotations inside `body`).",
      "Rules: Use only pure local variables (`let`/`const`), arithmetic/comparison/logical operators, `if`/`else`/`switch`/`while`/`for`, and `return`. Do NOT call external functions or methods.",
      `Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests:\n${spec.tests.map((t) => `- [${t.label}] args=${JSON.stringify(t.args)} => expected=${formatVal(t.expected)}`).join("\n")}`,
      feedback.length > 0 ? `\nFix these exact counterexamples:\n${feedback.join("\n")}` : "",
    ].join("\n");

    const rawBody = await requestBodyProposal(ai, prompt);

    // 1. Acorn parse -> estree-walker sandbox -> astring print -> tsc type/return check -> V8 bind
    const compiled = compileBodyToESTree(spec, rawBody);
    if (compiled.diagnostics.length > 0 || !compiled.run || !compiled.tsCode || !compiled.estree) {
      const msg = `Attempt ${attempt} failed static/sandbox checks:\n- ${compiled.diagnostics.join("\n- ")}`;
      console.log(`⚠️  ${msg}`);
      feedback.push(msg);
      continue;
    }

    // 2. Edge-case runtime verification
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
      return { estree: compiled.estree, tsCode: compiled.tsCode };
    }

    const failMsg = `Attempt ${attempt} failed runtime tests:\n- ${failures.join("\n- ")}`;
    console.log(`❌ ${failMsg}`);
    feedback.push(failMsg);
  }

  throw new Error(`Failed to synthesize verified ESTree graph within ${maxAttempts} attempts.`);
}