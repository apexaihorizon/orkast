// benchmark.ts — Head-to-head Economic Benchmark (Raw-JS vs Token-Optimized Orkast-DSL)
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { compileBodyToESTree, type RuntimeValue } from "./runtime.ts";
import type { ProgramSpec } from "./orchestrator.ts";
import { computeEconomics, synthesizeWithDsl, type RunMetrics } from "./dsl.ts";


const SPECS: ProgramSpec[] = [
  {
    name: "computeTax",
    description:
      "Compute progressive tax: negative income -> -1; <= 300000 -> 0; <= 700000 -> 5% above 300000; > 700000 -> 20000 + 10% above 700000.",
    params: [{ name: "income", paramType: "number" }],
    returnType: "number",
    tests: [
      { label: "neg", args: [-100], expected: -1 },
      { label: "zero", args: [0], expected: 0 },
      { label: "slab1", args: [300000], expected: 0 },
      { label: "slab2", args: [500000], expected: 10000 },
      { label: "slab3", args: [1000000], expected: 50000 },
    ],
  },
  {
    name: "isPrime",
    description:
      "Return true if integer n is prime, false otherwise. Numbers <= 1 and non-integers are false. Pure arithmetic only.",
    params: [{ name: "n", paramType: "number" }],
    returnType: "boolean",
    tests: [
      { label: "neg", args: [-7], expected: false },
      { label: "one", args: [1], expected: false },
      { label: "two", args: [2], expected: true },
      { label: "nine", args: [9], expected: false },
      { label: "prime", args: [97], expected: true },
      { label: "float", args: [3.5], expected: false },
    ],
  },
  {
    name: "gcd",
    description:
      "Greatest common divisor (non-negative) of integers a and b using Euclidean algorithm. Both 0 -> 0.",
    params: [
      { name: "a", paramType: "number" },
      { name: "b", paramType: "number" },
    ],
    returnType: "number",
    tests: [
      { label: "zeros", args: [0, 0], expected: 0 },
      { label: "neg", args: [-48, 18], expected: 6 },
      { label: "coprime", args: [17, 31], expected: 1 },
    ],
  },
];

const RAW_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: { body: { type: Type.STRING } },
  required: ["body"],
};

function formatVal(v: RuntimeValue): string {
  return typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v);
}

async function synthesizeRawJs(spec: ProgramSpec, key: string): Promise<RunMetrics> {
  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
  const t0 = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFeedback = "";

  for (let attempt = 1; attempt <= 4; attempt++) {
    const prompt = [
      "Return ONLY statements inside the JS function body. Pure local variables, operators, if/else/while/for, return. No external calls.",
      `Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests:\n${spec.tests.map((t) => `- ${JSON.stringify(t.args)} => ${formatVal(t.expected)}`).join("\n")}`,
      lastFeedback ? `\nFix:\n${lastFeedback}` : "",
    ].join("\n");

    const res = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", responseSchema: RAW_SCHEMA, temperature: 0.1 },
    });

    inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

    const parsed = JSON.parse(res.text ?? "{}") as { body?: string };
    const compiled = compileBodyToESTree(spec, parsed.body ?? "");
    if (compiled.diagnostics.length > 0 || !compiled.run || !compiled.tsCode) {
      lastFeedback = compiled.diagnostics.join(" | ");
      continue;
    }

    const failures: string[] = [];
    for (const t of spec.tests) {
      const actual = compiled.run(...t.args);
      if (!(Number.isNaN(t.expected) ? Number.isNaN(actual) : actual === t.expected)) {
        failures.push(`args=${JSON.stringify(t.args)} expected=${formatVal(t.expected)} got=${formatVal(actual)}`);
      }
    }

    if (failures.length === 0) {
      const econ = computeEconomics(inputTokens, outputTokens);
      return {
        mode: "raw-js",
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

  throw new Error(`Raw JS failed for ${spec.name}`);
}

async function main() {
    const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
  const results: RunMetrics[] = [];
  for (const spec of SPECS) {
    results.push(await synthesizeRawJs(spec, apiKey));
    results.push(await synthesizeWithDsl(spec, apiKey));
  }

  console.table(results.map(({ tsCode, ...metrics }) => metrics));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});