// bench-blocks.ts — Side-by-side efficiency & accuracy benchmark for Scratch-Block IR vs Raw JS
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import * as acorn from "acorn";
import { generate } from "astring";
import type * as ESTree from "estree";
import { compileBodyToESTree, type ProgramMeta, type RuntimeValue } from "./runtime.ts";

interface BenchSpec extends ProgramSpec {
  name: string;
  description: string;
  params: Array<{ name: string; paramType: "number" | "boolean" | "string" }>;
  returnType: "number" | "boolean" | "string";
  tests: Array<{ label: string; args: RuntimeValue[]; expected: RuntimeValue }>;
}

type ProgramSpec = ProgramMeta & {
  description: string;
  tests: Array<{ label: string; args: RuntimeValue[]; expected: RuntimeValue }>;
};

// Compact Scratch-Block IR (no JS syntax, no braces, no let/const, no === boilerplate)
type LogicBlock =
  | { op: "set"; var: string; val: string }
  | { op: "if"; cond: string; then: LogicBlock[]; else?: LogicBlock[] }
  | { op: "while"; cond: string; do: LogicBlock[] }
  | { op: "ret"; val: string };

// Gemini JSON Schema for flat/recursive Scratch blocks (2 levels of nesting covers all standard control flow)
const LEAF_BLOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    op: { type: Type.STRING, enum: ["set", "ret"] },
    var: { type: Type.STRING },
    val: { type: Type.STRING },
  },
  required: ["op", "val"],
};

const INNER_BLOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    op: { type: Type.STRING, enum: ["set", "if", "while", "ret"] },
    var: { type: Type.STRING },
    val: { type: Type.STRING },
    cond: { type: Type.STRING },
    then: { type: Type.ARRAY, items: LEAF_BLOCK_SCHEMA },
    else: { type: Type.ARRAY, items: LEAF_BLOCK_SCHEMA },
    do: { type: Type.ARRAY, items: LEAF_BLOCK_SCHEMA },
  },
  required: ["op"],
};

const TOP_BLOCK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    blocks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          op: { type: Type.STRING, enum: ["set", "if", "while", "ret"] },
          var: { type: Type.STRING },
          val: { type: Type.STRING },
          cond: { type: Type.STRING },
          then: { type: Type.ARRAY, items: INNER_BLOCK_SCHEMA },
          else: { type: Type.ARRAY, items: INNER_BLOCK_SCHEMA },
          do: { type: Type.ARRAY, items: INNER_BLOCK_SCHEMA },
        },
        required: ["op"],
      },
    },
  },
  required: ["blocks"],
};

// Deterministic Lowerer: Scratch Blocks -> Clean JS Body (fed into existing runtime.ts verifier)
function lowerExpr(raw: string): string {
  // Normalize pseudocode equality (==, !=) to strict JS (===, !==)
  return raw.replace(/(?<![=!<>])==(?!=)/g, "===").replace(/!=(?!=)/g, "!==");
}

function lowerBlocks(blocks: LogicBlock[], declared: Set<string>): string[] {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.op === "set") {
      if (!b.var || b.val === undefined) throw new Error("Invalid 'set' block");
      const expr = lowerExpr(b.val);
      if (!declared.has(b.var)) {
        declared.add(b.var);
        lines.push(`let ${b.var} = ${expr};`);
      } else {
        lines.push(`${b.var} = ${expr};`);
      }
    } else if (b.op === "ret") {
      if (b.val === undefined) throw new Error("Invalid 'ret' block");
      lines.push(`return ${lowerExpr(b.val)};`);
    } else if (b.op === "if") {
      if (!b.cond || !b.then) throw new Error("Invalid 'if' block");
      lines.push(`if (${lowerExpr(b.cond)}) {`);
      lines.push(...lowerBlocks(b.then, new Set(declared)));
      if (b.else && b.else.length > 0) {
        lines.push(`} else {`);
        lines.push(...lowerBlocks(b.else, new Set(declared)));
      }
      lines.push(`}`);
    } else if (b.op === "while") {
      if (!b.cond || !b.do) throw new Error("Invalid 'while' block");
      lines.push(`while (${lowerExpr(b.cond)}) {`);
      lines.push(...lowerBlocks(b.do, new Set(declared)));
      lines.push(`}`);
    }
  }
  return lines;
}

const SPECS: BenchSpec[] = [
  {
    name: "computeTax",
    description: "Income < 0 returns -1; <= 300000 returns 0; <= 700000 returns 5% above 300000; > 700000 returns 20000 + 10% above 700000.",
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
    description: "Return true if integer n is prime, else false. Numbers <= 1 and non-integers are false. Pure arithmetic only.",
    params: [{ name: "n", paramType: "number" }],
    returnType: "boolean",
    tests: [
      { label: "neg", args: [-7], expected: false },
      { label: "one", args: [1], expected: false },
      { label: "two", args: [2], expected: true },
      { label: "nine", args: [9], expected: false },
      { label: "prime97", args: [97], expected: true },
      { label: "float", args: [3.5], expected: false },
    ],
  },
  {
    name: "gcd",
    description: "Non-negative greatest common divisor of integers a and b via Euclidean algorithm. gcd(0,0)=0. Pure arithmetic only.",
    params: [
      { name: "a", paramType: "number" },
      { name: "b", paramType: "number" },
    ],
    returnType: "number",
    tests: [
      { label: "zeros", args: [0, 0], expected: 0 },
      { label: "neg", args: [-48, -18], expected: 6 },
      { label: "mixed", args: [-54, 24], expected: 6 },
      { label: "coprime", args: [17, 31], expected: 1 },
    ],
  },
];

async function runBenchmark() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });

  let totalIn = 0;
  let totalOut = 0;
  let totalMs = 0;
  let passedSpecs = 0;

  console.log("| Function | Mode | Attempts | Input Tok | Output Tok | Latency | Status |");
  console.log("| :--- | :--- | :---: | :---: | :---: | :---: | :---: |");

  for (const spec of SPECS) {
    const prompt = [
      "Assemble the program using ONLY typed logic blocks (`set`, `if`, `while`, `ret`) with pure arithmetic/comparison expressions (`+ - * / % == != < <= > >= && || ! ? :`). No function calls.",
      `Signature: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests: ${spec.tests.map((t) => `${JSON.stringify(t.args)}=>${JSON.stringify(t.expected)}`).join(", ")}`,
    ].join("\n");

    const t0 = performance.now();
    const res = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: TOP_BLOCK_SCHEMA,
        temperature: 0.1,
      },
    });
    const elapsed = Math.round(performance.now() - t0);

    const inTok = res.usageMetadata?.promptTokenCount ?? 0;
    const outTok = res.usageMetadata?.candidatesTokenCount ?? 0;
    totalIn += inTok;
    totalOut += outTok;
    totalMs += elapsed;

    let status = "FAIL";
    try {
      const parsed = JSON.parse(res.text ?? "{}") as { blocks: LogicBlock[] };
      const declared = new Set(spec.params.map((p) => p.name));
      const loweredBody = lowerBlocks(parsed.blocks, declared).join("\n");
      const compiled = compileBodyToESTree(spec, loweredBody);

      if (compiled.diagnostics.length === 0 && compiled.run) {
        const allOk = spec.tests.every((t) => compiled.run!(...t.args) === t.expected);
        if (allOk) {
          status = "PASS (1st try)";
          passedSpecs++;
        } else {
          status = "WRONG_OUT";
        }
      } else {
        status = `STATIC_ERR: ${compiled.diagnostics[0]}`;
      }
    } catch (e) {
      status = `LOWER_ERR: ${e instanceof Error ? e.message : String(e)}`;
    }

    console.log(`| ${spec.name} | Scratch-Block IR | 1 | ${inTok} | ${outTok} | ${elapsed}ms | ${status} |`);
  }

  console.log(`\nSummary (${passedSpecs}/${SPECS.length} passed): Avg Input=${Math.round(totalIn / SPECS.length)} tok, Avg Output=${Math.round(totalOut / SPECS.length)} tok, Avg Latency=${Math.round(totalMs / SPECS.length)}ms`);
  console.log(`Baseline Raw-JS Reference (from dashboard): Avg Input=284 tok, Avg Output=62 tok`);
}

runBenchmark().catch(console.error);