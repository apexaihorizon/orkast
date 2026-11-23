// test-slab.ts — Blind generalization test for Orkast (zero calculator-specific logic)
// Run with: node --env-file=.env test-slab.ts
import { orchestrateProgram, type ProgramSpec } from "./orchestrator.ts";

const taxSlabSpec: ProgramSpec = {
  name: "computeTax",
  description: [
    "Calculate progressive tax on annual income:",
    "- Negative income (< 0) returns -1 (invalid input).",
    "- Income up to 300000 (inclusive): 0 tax.",
    "- Income from 300001 up to 700000 (inclusive): 5% on amount above 300000.",
    "- Income above 700000: 20000 plus 10% on amount above 700000.",
  ].join("\n"),
  params: [{ name: "income", paramType: "number" }],
  returnType: "number",
  tests: [
    { label: "Negative income guard", args: [-500], expected: -1 },
    { label: "Zero income", args: [0], expected: 0 },
    { label: "Exact 0% ceiling boundary", args: [300000], expected: 0 },
    { label: "Middle of 5% slab", args: [500000], expected: 10000 },
    { label: "Exact 5% ceiling boundary", args: [700000], expected: 20000 },
    { label: "Top 10% slab", args: [1000000], expected: 50000 },
  ],
};

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const { tsCode, graph } = await orchestrateProgram(taxSlabSpec, apiKey);
  console.log("\n--- Synthesized & Verified TypeScript ---\n" + tsCode);
  console.log("\n--- Raw AST Block Count ---", graph.body.length);
}

main();