// test-calc.ts — Regression & generalization check on the frozen Orkast pipeline
// Run with: node --env-file=.env test-calc.ts
import { orchestrateProgram, type ProgramSpec } from "./orchestrator.ts";

const calcSpec: ProgramSpec = {
  name: "calculate",
  description: [
    "Perform arithmetic on a and b based on operator op (+, -, *, /, %).",
    "- For '/' or '%', if b === 0 return NaN.",
    "- For any operator other than '+', '-', '*', '/', '%', return NaN.",
  ].join("\n"),
  params: [
    { name: "a", paramType: "number" },
    { name: "op", paramType: "string" },
    { name: "b", paramType: "number" },
  ],
  returnType: "number",
  tests: [
    { label: "Addition", args: [10, "+", 5], expected: 15 },
    { label: "Add zero (must NOT trigger zero guard)", args: [10, "+", 0], expected: 10 },
    { label: "Subtraction", args: [10, "-", 5], expected: 5 },
    { label: "Multiplication", args: [4, "*", 3], expected: 12 },
    { label: "Division", args: [20, "/", 4], expected: 5 },
    { label: "Modulo", args: [10, "%", 3], expected: 1 },
    { label: "Divide by zero guard", args: [10, "/", 0], expected: Number.NaN },
    { label: "Modulo by zero guard", args: [10, "%", 0], expected: Number.NaN },
    { label: "Unknown operator guard", args: [10, "^", 2], expected: Number.NaN },
  ],
};

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const { tsCode, estree } = await orchestrateProgram(calcSpec, apiKey);
  console.log("\n--- Synthesized & Verified TypeScript ---\n" + tsCode);
  console.log("\n--- Raw AST Block Count ---", estree.body.length);
}

main();