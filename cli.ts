// cli.ts — Interactive I/O Calculator synthesized by Orkast AST Orchestrator
// Run with: node --env-file=.env cli.ts
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { orchestrateProgram, type ProgramSpec } from "./orchestrator.ts";
import { compileGraph } from "./runtime.ts";

const calcSpec: ProgramSpec = {
  name: "calculate",
  description: "Perform +, -, *, or / on a and b. Return NaN on division by zero or unknown operator.",
  params: [
    { name: "a", paramType: "number" },
    { name: "op", paramType: "string" },
    { name: "b", paramType: "number" },
  ],
  returnType: "number",
  tests: [
    { label: "Addition", args: [10, "+", 5], expected: 15 },
    { label: "Subtraction", args: [10, "-", 5], expected: 5 },
    { label: "Multiplication", args: [4, "*", 3], expected: 12 },
    { label: "Division", args: [20, "/", 4], expected: 5 },
    { label: "Divide by zero guard", args: [10, "/", 0], expected: Number.NaN },
    { label: "Unknown operator guard", args: [10, "^", 2], expected: Number.NaN },
  ],
};

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in environment or .env file.");
  }

  // 1. AI arranges AST blocks ONLY (zero syntax generation)
  const { graph, tsCode } = await orchestrateProgram(calcSpec, apiKey);

  // 2. Deterministic compiler turns verified blocks into executable TypeScript
  const program = compileGraph(graph);
  console.log("\n--- Compiled TypeScript from AST Blocks ---\n" + tsCode + "\n-------------------------------------------");

  // 3. Interactive I/O loop using the compiled program
  const rl = readline.createInterface({ input, output });
  console.log("Enter calculations (type 'exit' to quit).\n");

  while (true) {
    const rawA = (await rl.question("First number (a): ")).trim();
    if (rawA.toLowerCase() === "exit") break;

    const op = (await rl.question("Operator (+, -, *, /): ")).trim();
    if (op.toLowerCase() === "exit") break;

    const rawB = (await rl.question("Second number (b): ")).trim();
    if (rawB.toLowerCase() === "exit") break;

    const a = Number(rawA);
    const b = Number(rawB);

    if (Number.isNaN(a) || Number.isNaN(b)) {
      console.log("⚠️  Please enter valid numbers.\n");
      continue;
    }

    const result = program.run(a, op, b);
    if (typeof result === "number" && Number.isNaN(result)) {
      console.log("❌ Invalid operation (unknown operator or division by zero).\n");
    } else {
      console.log(`✅ Result: ${a} ${op} ${b} = ${result}\n`);
    }
  }

  rl.close();
}

main();