// test-calc.ts — Regression & generalization check on the frozen Orkast pipeline
// Run with: node --env-file=.env test-calc.ts
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { orchestrateProgram, type ProgramSpec } from "./orchestrator.ts";
import { compileGraph } from "./runtime.ts";

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
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

  const { graph, tsCode } = await orchestrateProgram(calcSpec, apiKey);
  const program = compileGraph(graph);

  console.log("\n--- Synthesized & Verified TypeScript ---\n" + tsCode);
  console.log("--- Raw AST Block Count ---", graph.body.length, "\n");

  const rl = readline.createInterface({ input, output });
  console.log("Interactive Calculator Ready (type 'exit' to quit).\n");

  while (true) {
    const rawA = (await rl.question("First number (a): ")).trim();
    if (rawA.toLowerCase() === "exit") break;

    const op = (await rl.question("Operator (+, -, *, /, %): ")).trim();
    if (op.toLowerCase() === "exit") break;

    const rawB = (await rl.question("Second number (b): ")).trim();
    if (rawB.toLowerCase() === "exit") break;

    const a = Number(rawA);
    const b = Number(rawB);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      console.log("⚠️  Enter valid numbers.\n");
      continue;
    }

    const res = program.run(a, op, b);
    if (typeof res === "number" && Number.isNaN(res)) {
      console.log("❌ Invalid operation (unknown operator or zero divisor).\n");
    } else {
      console.log(`✅ Result: ${a} ${op} ${b} = ${res}\n`);
    }
  }

  rl.close();
}

main();