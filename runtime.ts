// runtime.ts — Compiles a FunctionGraph into an executable JS function + test runner
import type { FunctionGraph } from "./ast.ts";
import { validateGraph } from "./validate.ts";
import { lowerToTypeScript } from "./lower-ts.ts";

export type RuntimeValue = number | boolean | string;

export interface CompiledProgram {
  tsCode: string;
  run: (...args: RuntimeValue[]) => RuntimeValue;
}

export function compileGraph(graph: FunctionGraph): CompiledProgram {
  const errors = validateGraph(graph);
  if (errors.length > 0) {
    throw new Error(`AST Validation Failed:\n- ${errors.join("\n- ")}`);
  }

  const tsCode = lowerToTypeScript(graph);
  const jsBody = tsCode
    .replace(/:\s*(number|boolean|string)/g, "")
    .replace(/^function\s+\w+\([^)]*\)\s*\{/, "")
    .replace(/\}$/, "");

  const fn = new Function(...graph.params.map((p) => p.name), jsBody) as (...args: RuntimeValue[]) => RuntimeValue;

  return { tsCode, run: fn };
}