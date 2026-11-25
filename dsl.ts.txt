// dsl.ts — Indented Scratch-Pseudocode DSL Compiler & Instrumented CEGIS Runner
import * as acorn from "acorn";
import { walk } from "estree-walker";
import { generate } from "astring";
import type * as ESTree from "estree";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import {
  compileBodyToESTree,
  type CompileResult,
  type ProgramMeta,
  type RuntimeValue,
} from "./runtime.ts";
import type { ProgramSpec } from "./orchestrator.ts";

export interface RunMetrics {
  mode: "raw-js" | "orkast-dsl";
  specName: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inOutRatio: string;
  weightedTokens: number;
  tasksPer10Usd: number;
  latencyMs: number;
  tsCode: string;
}

const DSL_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    pseudocode: {
      type: Type.STRING,
      description:
        "Indented Orkast pseudocode blocks using ONLY: `set x = expr`, `if cond:`, `elif cond:`, `else:`, `while cond:`, `return expr`. No braces, no semicolons, no function header.",
    },
  },
  required: ["pseudocode"],
};

function parseExpr(raw: string): ESTree.Expression {
  // Normalize standard equality operators to strict JS equality
  const normalized = raw
    .replace(/([^=!<>])={2}([^=])/g, "$1===$2")
    .replace(/!={1}([^=])/g, "!==$1");
  return acorn.parseExpressionAt(normalized, 0, {
    ecmaVersion: 2022,
  }) as unknown as ESTree.Expression;
}

/**
 * Compiles indented Scratch-like pseudocode directly into an ESTree Program,
 * then validates and binds it through runtime.ts's exact compiler & step-guard pipeline.
 */
export function compileDslToRuntime(meta: ProgramMeta, dslSource: string): CompileResult {
  const rawLines = dslSource
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, "  "))
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));

  const declared = new Set<string>(meta.params.map((p) => p.name));
  let idx = 0;

  function parseBlock(expectedIndent: number): ESTree.Statement[] {
    const stmts: ESTree.Statement[] = [];

    while (idx < rawLines.length) {
      const line = rawLines[idx];
      const indent = line.search(/\S/);
      if (indent < expectedIndent) break;
      if (indent > expectedIndent) {
        throw new Error(`Unexpected indentation on line ${idx + 1}: "${line.trim()}"`);
      }

      const text = line.trim();
      idx++;

      // 1. `set <ident> = <expr>`
      const setMatch = text.match(/^set\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(.+)$/);
      if (setMatch) {
        const [, varName, exprText] = setMatch;
        const initExpr = parseExpr(exprText);
        if (!declared.has(varName)) {
          declared.add(varName);
          stmts.push({
            type: "VariableDeclaration",
            kind: "let",
            declarations: [
              {
                type: "VariableDeclarator",
                id: { type: "Identifier", name: varName },
                init: initExpr,
              },
            ],
          });
        } else {
          stmts.push({
            type: "ExpressionStatement",
            expression: {
              type: "AssignmentExpression",
              operator: "=",
              left: { type: "Identifier", name: varName },
              right: initExpr,
            },
          });
        }
        continue;
      }

      // 2. `return <expr>`
      const retMatch = text.match(/^return\s+(.+)$/);
      if (retMatch) {
        stmts.push({
          type: "ReturnStatement",
          argument: parseExpr(retMatch[1]),
        });
        continue;
      }

      // 3. `while <cond>:`
      const whileMatch = text.match(/^while\s+(.+):$/);
      if (whileMatch) {
        const test = parseExpr(whileMatch[1]);
        const nextIndent = idx < rawLines.length ? rawLines[idx].search(/\S/) : -1;
        if (nextIndent <= expectedIndent) {
          throw new Error(`Expected indented block after "${text}"`);
        }
        const bodyStmts = parseBlock(nextIndent);
        stmts.push({
          type: "WhileStatement",
          test,
          body: { type: "BlockStatement", body: bodyStmts },
        });
        continue;
      }

      // 4. `if <cond>:` with chained `elif <cond>:` and `else:`
      const ifMatch = text.match(/^if\s+(.+):$/);
      if (ifMatch) {
        const buildIfChain = (condText: string): ESTree.IfStatement => {
          const test = parseExpr(condText);
          const nextIndent = idx < rawLines.length ? rawLines[idx].search(/\S/) : -1;
          if (nextIndent <= expectedIndent) {
            throw new Error(`Expected indented block after "if/elif ${condText}:"`);
          }
          const consequent: ESTree.BlockStatement = {
            type: "BlockStatement",
            body: parseBlock(nextIndent),
          };

          let alternate: ESTree.Statement | null = null;
          if (idx < rawLines.length && rawLines[idx].search(/\S/) === expectedIndent) {
            const peek = rawLines[idx].trim();
            const elifMatch = peek.match(/^elif\s+(.+):$/);
            if (elifMatch) {
              idx++;
              alternate = buildIfChain(elifMatch[1]);
            } else if (peek === "else:") {
              idx++;
              const elseIndent = idx < rawLines.length ? rawLines[idx].search(/\S/) : -1;
              if (elseIndent <= expectedIndent) {
                throw new Error(`Expected indented block after "else:"`);
              }
              alternate = {
                type: "BlockStatement",
                body: parseBlock(elseIndent),
              };
            }
          }

          return { type: "IfStatement", test, consequent, alternate };
        };

        stmts.push(buildIfChain(ifMatch[1]));
        continue;
      }

      throw new Error(`Unknown Orkast block syntax on line ${idx}: "${text}"`);
    }

    return stmts;
  }

  let bodyStmts: ESTree.Statement[];
  try {
    const startIndent = rawLines.length > 0 ? rawLines[0].search(/\S/) : 0;
    bodyStmts = parseBlock(startIndent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { diagnostics: [`DSL parse error: ${msg}`] };
  }

  const program: ESTree.Program = {
    type: "Program",
    sourceType: "script",
    body: [
      {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: meta.name },
        params: meta.params.map((p) => ({ type: "Identifier", name: p.name })),
        body: { type: "BlockStatement", body: bodyStmts },
      },
    ],
  };

  // Lower ESTree back to canonical JS body and reuse runtime.ts's exact sandbox + tsc + loop-guard pipeline
  const fnNode = program.body[0] as ESTree.FunctionDeclaration;
  const loweredBody = fnNode.body.body.map((s) => generate(s)).join("\n");
  return compileBodyToESTree(meta, loweredBody);
}

function formatVal(v: RuntimeValue): string {
  return typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v);
}

export function computeEconomics(inputTokens: number, outputTokens: number) {
  // Based on $0.75 / 1M input and $3.75 / 1M output (5:1 output-to-input weight)
  const weightedTokens = inputTokens + 5 * outputTokens;
  const costUsd = (inputTokens * 0.75 + outputTokens * 3.75) / 1_000_000;
  const tasksPer10Usd = costUsd > 0 ? Math.floor(10 / costUsd) : 0;
  const inOutRatio = outputTokens > 0 ? `${(inputTokens / outputTokens).toFixed(2)}:1` : "N/A";
  return { inOutRatio, weightedTokens, tasksPer10Usd };
}

export async function synthesizeWithDsl(
  spec: ProgramSpec,
  apiKey: string,
  maxAttempts = 4
): Promise<RunMetrics> {
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const t0 = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let lastFeedback = "";

  const systemInstruction = [
    "You assemble programs using ONLY Orkast indented pseudocode blocks (2-space indent). Never write JS/TS syntax (`{`, `}`, `;`, `let`, `const`, `function`, or method calls).",
    "Allowed blocks:",
    "- `set x = <expr>`",
    "- `if <cond>:` / `elif <cond>:` / `else:`",
    "- `while <cond>:`",
    "- `return <expr>`",
  ].join("\n");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = [
      `Task: ${spec.name}(${spec.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${spec.returnType}`,
      `Intent: ${spec.description}`,
      `Tests:\n${spec.tests.map((t) => `- ${JSON.stringify(t.args)} => ${formatVal(t.expected)}`).join("\n")}`,
      lastFeedback ? `\nFix:\n${lastFeedback}` : "",
    ].join("\n");

    const res = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: DSL_SCHEMA,
        temperature: 0.1,
      },
    });

    inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;
    totalTokens += res.usageMetadata?.totalTokenCount ?? 0;

    const parsed = JSON.parse(res.text ?? "{}") as { pseudocode?: string };
    const compiled = compileDslToRuntime(spec, parsed.pseudocode ?? "");

    if (compiled.diagnostics.length > 0 || !compiled.run || !compiled.tsCode) {
      lastFeedback = `[STATIC_ERROR] ${compiled.diagnostics.join(" | ")}`;
      continue;
    }

    const failures: string[] = [];
    for (const t of spec.tests) {
      try {
        const actual = compiled.run(...t.args);
        const passed = Number.isNaN(t.expected) ? Number.isNaN(actual) : actual === t.expected;
        if (!passed) {
          failures.push(
            `[WRONG_OUTPUT] args=${JSON.stringify(t.args)} expected=${formatVal(t.expected)} got=${formatVal(actual)}`
          );
        }
      } catch (err: unknown) {
        failures.push(
          `[RUNTIME_EXCEPTION] args=${JSON.stringify(t.args)} error="${err instanceof Error ? err.message : String(err)}"`
        );
      }
    }

    if (failures.length === 0) {
        const econ = computeEconomics(inputTokens, outputTokens);
      return {
        mode: "orkast-dsl",
        specName: spec.name,
        attempts: attempt,
        inputTokens,
        outputTokens,
        totalTokens,
        ...econ,
        latencyMs: Math.round(performance.now() - t0),
        tsCode: compiled.tsCode,
      };
    }

    lastFeedback = failures.join("\n");
  }

  throw new Error(`DSL synthesis failed for ${spec.name} after ${maxAttempts} attempts`);
}