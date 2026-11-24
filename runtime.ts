// runtime.ts — astring ESTree Printer + In-Memory TypeScript Compiler API Gatekeeper
import { createRequire } from "node:module";
import { generate } from "astring";
import type * as ESTree from "estree";
import type { ProgramMeta } from "./ir-bridge.ts";

const require = createRequire(import.meta.url);
// Resolves full TypeScript compiler API cleanly regardless of TS 5/6 ESM package exports
const ts = require("typescript") as typeof import("typescript");

export type RuntimeValue = number | boolean | string;

export interface CompileResult {
  tsCode?: string;
  diagnostics: string[];
  run?: (...args: RuntimeValue[]) => RuntimeValue;
}

export function compileESTree(meta: ProgramMeta, estree: ESTree.Program): CompileResult {
  // 1. astring prints clean JS from standard ESTree nodes
  const rawJs = generate(estree);

  // 2. Attach strict TypeScript signature so tsc enforces parameter, body, and return types
  const typedSig = `function ${meta.name}(${meta.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}): ${meta.returnType}`;
  const tsCode = rawJs.replace(new RegExp(`^function\\s+${meta.name}\\s*\\([^)]*\\)`), typedSig);

  // 3. In-memory TypeScript CompilerHost (zero disk writes)
  const fileName = "/orkast_virtual.ts";
  const options = {
    strict: true,
    noImplicitAny: true,
    noImplicitReturns: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    types: [], // Fast: skip scanning node_modules/@types
  };

  const defaultHost = ts.createCompilerHost(options);
  const customHost = {
    ...defaultHost,
    getSourceFile: (name: string, langVersion: number) =>
      name === fileName
        ? ts.createSourceFile(fileName, tsCode, langVersion)
        : defaultHost.getSourceFile(name, langVersion),
    fileExists: (name: string) => name === fileName || defaultHost.fileExists(name),
    readFile: (name: string) => (name === fileName ? tsCode : defaultHost.readFile(name)),
  };

  const program = ts.createProgram([fileName], options, customHost);
  const rawDiagnostics = ts.getPreEmitDiagnostics(program);

  if (rawDiagnostics.length > 0) {
    const diagnostics = rawDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n")
    );
    return { tsCode, diagnostics };
  }

  // 4. Transpile & bind executable V8 function
  const jsOutput = ts.transpileModule(tsCode, { compilerOptions: options }).outputText;
  const factory = new Function(`${jsOutput}\nreturn ${meta.name};`);
  const fn = factory() as (...args: RuntimeValue[]) => RuntimeValue;

  return { tsCode, diagnostics: [], run: fn };
}