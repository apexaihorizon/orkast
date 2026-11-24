// test-loop.ts — Stresses iterative loops, step-counter guard, and CEGIS edge-case repair
import { orchestrateProgram, type ProgramSpec } from "./orchestrator.ts";


const isPrimeSpec: ProgramSpec = {
  name: "isPrime",
  description:
    "Return true if integer n is a prime number, otherwise false. Numbers <= 1 and non-integers are not prime. Use pure arithmetic loops only (no Math.* calls).",
  params: [{ name: "n", paramType: "number" }],
  returnType: "boolean",
  tests: [
    { label: "negative", args: [-7], expected: false },
    { label: "zero", args: [0], expected: false },
    { label: "one", args: [1], expected: false },
    { label: "two (smallest prime)", args: [2], expected: true },
    { label: "three", args: [3], expected: true },
    { label: "four (even composite)", args: [4], expected: false },
    { label: "nine (odd square)", args: [9], expected: false },
    { label: "large prime", args: [97], expected: true },
    { label: "non-integer", args: [3.5], expected: false },
  ],
};

const gcdSpec: ProgramSpec = {
  name: "gcd",
  description:
    "Compute the greatest common divisor (non-negative) of two integers a and b using the Euclidean algorithm. If both a and b are 0, return 0. Do not call Math.abs.",
  params: [
    { name: "a", paramType: "number" },
    { name: "b", paramType: "number" },
  ],
  returnType: "number",
  tests: [
    { label: "both zero", args: [0, 0], expected: 0 },
    { label: "left zero", args: [0, 15], expected: 15 },
    { label: "right zero negative", args: [-21, 0], expected: 21 },
    { label: "coprime", args: [17, 31], expected: 1 },
    { label: "standard", args: [48, 18], expected: 6 },
    { label: "negative inputs", args: [-48, -18], expected: 6 },
    { label: "mixed sign", args: [-54, 24], expected: 6 },
  ],
};

async function main() {
    const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
  for (const spec of [isPrimeSpec, gcdSpec]) {
    console.log(`\n==============================`);
    console.log(`🚀 Synthesizing: ${spec.name}`);
    console.log(`==============================`);
    const result = await orchestrateProgram(spec, apiKey);
    console.log("\n--- Synthesized & Verified TypeScript ---");
    console.log(result.tsCode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});