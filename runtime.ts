// runtime.ts — 100% Standard Ecosystem Pipeline (acorn -> estree-walker -> astring -> TypeScript Compiler API)
import { createRequire } from "node:module";
import * as acorn from "acorn";
import { walk } from "estree-walker";
import { generate } from "astring";
import type * as ESTree from "estree";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

export type PrimitiveType = "number" | "boolean" | "string";
export type RuntimeValue = number | boolean | string;

export interface ProgramMeta {
  name: string;
  params: Array<{ name: string; paramType: PrimitiveType }>;
  returnType: PrimitiveType;
}

export interface CompileResult {
  estree?: ESTree.Program;
  tsCode?: string;
  diagnostics: string[];
  run?: (...args: RuntimeValue[]) => RuntimeValue;
}

// Strict ESTree node allowlist: pure deterministic logic & control flow only
const ALLOWED_ESTREE_NODES = new Set([
  "Program",
  "FunctionDeclaration",
  "BlockStatement",
  "VariableDeclaration",
  "VariableDeclarator",
  "ExpressionStatement",
  "AssignmentExpression",
  "UpdateExpression",
  "IfStatement",
  "SwitchStatement",
  "SwitchCase",
  "WhileStatement",
  "ForStatement",
  "BreakStatement",
  "ContinueStatement",
  "ReturnStatement",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "ConditionalExpression",
  "Identifier",
  "Literal",
]);

export function compileBodyToESTree(meta: ProgramMeta, rawBody: string): CompileResult {
  const paramNames = meta.params.map((p) => p.name).join(", ");
  const wrappedJs = `function ${meta.name}(${paramNames}) {\n${rawBody}\n}`;

  // 1. Parse into standard ESTree via Acorn
  let estree: ESTree.Program;
  try {
    estree = acorn.parse(wrappedJs, {
      ecmaVersion: 2022,
      sourceType: "script",
    }) as unknown as ESTree.Program;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { diagnostics: [`Acorn syntax error: ${msg}`] };
  }

  // 2. Deterministic AST Sandbox Gate via estree-walker
  const violations: string[] = [];
  walk(estree as unknown as Parameters<typeof walk>[0], {
    enter(node) {
      if (!ALLOWED_ESTREE_NODES.has(node.type)) {
        violations.push(`Disallowed AST construct '${node.type}' (only pure deterministic logic allowed).`);
      }
    },
  });

  if (violations.length > 0) {
    return { diagnostics: [...new Set(violations)] };
  }

  // 3. Canonical code printing via astring
  const cleanJs = generate(estree);
  const typedSig = `function ${meta.name}(${meta.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}): ${meta.returnType}`;
  const tsCode = cleanJs.replace(new RegExp(`^function\\s+${meta.name}\\s*\\([^)]*\\)`), typedSig);

  // 4. Industrial-grade static type & return-path check via TypeScript Compiler API
  const fileName = "/orkast_virtual.ts";
  const options = {
    strict: true,
    noImplicitAny: true,
    noImplicitReturns: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    types: [],
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
    return { estree, tsCode, diagnostics };
  }

  // 5. Transpile & bind executable V8 function
  const jsOutput = ts.transpileModule(tsCode, { compilerOptions: options }).outputText;
  const factory = new Function(`${jsOutput}\nreturn ${meta.name};`);
  const fn = factory() as (...args: RuntimeValue[]) => RuntimeValue;

  return { estree, tsCode, diagnostics: [], run: fn };
}