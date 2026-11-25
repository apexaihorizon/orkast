// test-structures.ts — End-to-end verification of Arrays, Objects, Strings, Loops & Nested Helpers
import { isDeepStrictEqual } from "node:util";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { parseOrkastDsl } from "./dsl-parser.ts";
import { compileESTree, type ProgramMeta, type RuntimeValue } from "./runtime.ts";
import { computeEconomics } from "./dsl.ts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

interface StructuredTestCase {
  label: string;
  args: RuntimeValue[];
  expected: RuntimeValue;
}

interface StructuredSpec extends ProgramMeta {
  description: string;
  tests: StructuredTestCase[];
}

const DSL_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    c: {
      type: Type.STRING,
      description:
        "2-space indented Orkast DSL blocks (`set x = expr`, `fn name(a):`, `if cond:`, `elif cond:`, `else:`, `while cond:`, `for x of arr:`, `for i from 0 to n:`, `return expr`). No braces or semicolons.",
    },
  },
  required: ["c"],
};

function formatVal(v: RuntimeValue): string {
  return typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v);
}

/**
 * 1. Offline smoke test: verifies `dsl-parser.ts` + `runtime.ts` directly on
 * nested helper functions (`fn`), objects, arrays, strings, and `for...of`.
 */
function runOfflineSmokeTest() {
  console.log("=== 1. Offline Parser + Runtime Smoke Test ===");
  const meta: ProgramMeta = {
    name: "analyzeWords",
    params: [{ name: "words", paramType: "string[]" }],
    returnType: "{ total: number; upper: string[]; longest: string }",
  };

  const sampleDsl = `
fn clean(w):
  return w.trim().toUpperCase()

set upper = []
set longest = ""
for word of words:
  set c = clean(word)
  if c.length > 0:
    upper.push(c)
    if c.length > longest.length:
      set longest = c

return { total: upper.length, upper: upper, longest: longest }
`;

  const parsed = parseOrkastDsl({ name: meta.name, params: ["words"] }, sampleDsl);
  if (parsed.diagnostics.length > 0 || !parsed.estree) {
    throw new Error(`Offline DSL parse failed:\n${parsed.diagnostics.join("\n")}`);
  }

  const compiled = compileESTree(meta, parsed.estree);
  if (compiled.diagnostics.length > 0 || !compiled.run) {
    throw new Error(`Offline runtime compile failed:\n${compiled.diagnostics.join("\n")}`);
  }

  const out = compiled.run(["  alpha ", "", "beta", "  gammaRay "]);
  const expected = { total: 3, upper: ["ALPHA", "BETA", "GAMMARAY"], longest: "GAMMARAY" };
  if (!isDeepStrictEqual(out, expected)) {
    throw new Error(`Smoke mismatch: got ${JSON.stringify(out)}, expected ${JSON.stringify(expected)}`);
  }

  console.log("✅ Offline smoke test passed! Emitted TypeScript:\n");
  console.log(compiled.tsCode);
}

/**
 * 2. Live CEGIS synthesis runner using compact `{ c }` schema + deep structural equality
 */
async function synthesizeStructured(spec: StructuredSpec, maxAttempts = 4) {
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const t0 = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFeedback = "";

  const systemInstruction = [
    "Synthesize function body using ONLY 2-space indented Orkast blocks (no braces `{ }`, no semicolons `;`, no function header).",
    "Grammar: `set x = expr`, `fn helper(a):`, `if cond:`, `elif cond:`, `else:`, `while cond:`, `for x of arr:`, `for i from 0 to n:`, `return expr`.",
  ].join("\n");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = [
      `Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests:\n${spec.tests.map((t) => `- [${t.label}] ${JSON.stringify(t.args)} => ${formatVal(t.expected)}`).join("\n")}`,
      lastFeedback ? `\nFix:\n${lastFeedback}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const res = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: DSL_SCHEMA,
        temperature: 0.1,
      },
    });

    inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

    const payload = JSON.parse(res.text ?? "{}") as { c?: string };
    const parsed = parseOrkastDsl(
      { name: spec.name, params: spec.params.map((p) => p.name) },
      payload.c ?? ""
    );

    if (parsed.diagnostics.length > 0 || !parsed.estree) {
      lastFeedback = `[PARSE_ERROR] ${parsed.diagnostics.join(" | ")}`;
      continue;
    }

    const compiled = compileESTree(spec, parsed.estree);
    if (compiled.diagnostics.length > 0 || !compiled.run || !compiled.tsCode) {
      lastFeedback = `[TYPE_ERROR] ${compiled.diagnostics.join(" | ")}`;
      continue;
    }

    const failures: string[] = [];
    for (const t of spec.tests) {
      try {
        // Clone input args so in-place mutations don't taint diagnostic reporting
        const clonedArgs = structuredClone(t.args);
        const actual = compiled.run(...clonedArgs);
        if (!isDeepStrictEqual(actual, t.expected)) {
          failures.push(
            `[WRONG_OUTPUT] test="${t.label}" args=${JSON.stringify(t.args)} expected=${formatVal(t.expected)} got=${formatVal(actual)}`
          );
        }
      } catch (err: unknown) {
        failures.push(
          `[RUNTIME_EXCEPTION] test="${t.label}" args=${JSON.stringify(t.args)} error="${err instanceof Error ? err.message : String(err)}"`
        );
      }
    }

    if (failures.length === 0) {
      const econ = computeEconomics(inputTokens, outputTokens);
      return {
        specName: spec.name,
        attempts: attempt,
        inputTokens,
        outputTokens,
        ...econ,
        latencyMs: Math.round(performance.now() - t0),
        tsCode: compiled.tsCode,
      };
    }

    lastFeedback = failures.join("\n");
  }

  throw new Error(`Failed to synthesize ${spec.name} after ${maxAttempts} attempts.\nLast error:\n${lastFeedback}`);
}

const SPECS: StructuredSpec[] = [
  {
    name: "groupAndSummarize",
    description:
      "Given an array of { category, amount } objects, return an object mapping each category to { count, total }. Empty array returns {}.",
    params: [{ name: "items", paramType: "Array<{ category: string; amount: number }>" }],
    returnType: "Record<string, { count: number; total: number }>",
    tests: [
      { label: "empty", args: [[]], expected: {} },
      {
        label: "single",
        args: [[{ category: "food", amount: 120 }]],
        expected: { food: { count: 1, total: 120 } },
      },
      {
        label: "multi-category",
        args: [
          [
            { category: "food", amount: 100 },
            { category: "travel", amount: 250 },
            { category: "food", amount: 50 },
          ],
        ],
        expected: {
          food: { count: 2, total: 150 },
          travel: { count: 1, total: 250 },
        },
      },
    ],
  },
  {
    name: "longestUniqueSubstring",
    description:
      "Find the first longest contiguous substring of s without repeating characters. Return { length, substring }.",
    params: [{ name: "s", paramType: "string" }],
    returnType: "{ length: number; substring: string }",
    tests: [
      { label: "empty", args: [""], expected: { length: 0, substring: "" } },
      { label: "all-same", args: ["bbbb"], expected: { length: 1, substring: "b" } },
      { label: "classic", args: ["abcabcbb"], expected: { length: 3, substring: "abc" } },
      { label: "middle", args: ["pwwkew"], expected: { length: 3, substring: "wke" } },
    ],
  },
];

async function main() {
  runOfflineSmokeTest();

  console.log("\n=== 2. Live Structured Synthesis Benchmark ===");
  const metrics = [];
  for (const spec of SPECS) {
    const res = await synthesizeStructured(spec);
    console.log(`\n✅ ${spec.name} (attempt ${res.attempts}):\n${res.tsCode}`);
    const { tsCode, ...row } = res;
    metrics.push(row);
  }

  console.log("\n--- Economic Summary ---");
  console.table(metrics);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});