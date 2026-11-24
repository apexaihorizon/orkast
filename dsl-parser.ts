// dsl-parser.ts — Standardized Indentation-to-ESTree Compiler for Orkast Scratch-DSL
// Supports full objects, arrays, strings, template literals, nested functions, loops, destructuring & expressions via Acorn.
import * as acorn from "acorn";
import { walk } from "estree-walker";
import type * as ESTree from "estree";

export interface DslParseResult {
  estree?: ESTree.Program;
  diagnostics: string[];
}

export interface DslSignature {
  name: string;
  params: string[];
}

interface TokenLine {
  lineNo: number;
  indent: number;
  text: string;
}

/**
 * Normalizes Pythonic logical/equality operators outside of string literals
 * so strings like "a == b and c" remain untouched.
 */
function normalizeOperators(expr: string): string {
  let out = "";
  let quote: string | null = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < expr.length) {
        out += expr[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === `"` || ch === `'` || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }

    // Match word operators outside quotes
    const rest = expr.slice(i);
    const wordMatch = rest.match(/^(and|or|not)\b/);
    if (wordMatch && (i === 0 || !/[a-zA-Z0-9_$]/.test(expr[i - 1]))) {
      const kw = wordMatch[1];
      out += kw === "and" ? "&&" : kw === "or" ? "||" : "!";
      i += kw.length - 1;
      continue;
    }

    if (expr.startsWith("==", i) && expr[i + 2] !== "=" && (i === 0 || !/[=!<>]/.test(expr[i - 1]))) {
      out += "===";
      i += 1;
      continue;
    }

    if (expr.startsWith("!=", i) && expr[i + 2] !== "=" && (i === 0 || !/[=!<>]/.test(expr[i - 1]))) {
      out += "!==";
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Lexes raw DSL text into logical lines while respecting multi-line brackets/braces/parens
 * and multi-line strings (so multi-line objects/arrays don't trigger false indentation errors).
 */
function lexLogicalLines(source: string): TokenLine[] {
  const clean = source
    .replace(/^```[a-zA-Z]*\r?\n/, "")
    .replace(/\r?\n```$/, "");

  const physicalLines = clean.split(/\r?\n/);
  const logical: TokenLine[] = [];

  let buffer = "";
  let startLine = 1;
  let startIndent = 0;
  let depth = 0;
  let quote: string | null = null;

  for (let idx = 0; idx < physicalLines.length; idx++) {
    const rawLine = physicalLines[idx].replace(/\t/g, "  ");
    const trimmed = rawLine.trim();

    if (depth === 0 && !quote) {
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      startLine = idx + 1;
      startIndent = rawLine.search(/\S/);
      buffer = trimmed;
    } else {
      buffer += " " + trimmed;
    }

    for (let c = 0; c < rawLine.length; c++) {
      const ch = rawLine[c];
      if (quote) {
        if (ch === "\\" && c + 1 < rawLine.length) {
          c++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === `"` || ch === `'` || ch === "`") {
        quote = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }

    if (depth === 0 && !quote) {
      logical.push({ lineNo: startLine, indent: startIndent, text: buffer });
      buffer = "";
    }
  }

  if (depth > 0 || quote) {
    throw new Error(`Unclosed delimiter or string starting at line ${startLine}.`);
  }

  return logical;
}

/**
 * Translates Orkast Scratch-DSL statements into a valid JS block skeleton,
 * then parses the complete structure into a standard ESTree Program via Acorn.
 */
export function parseOrkastDsl(sig: DslSignature, dslSource: string): DslParseResult {
  let lines: TokenLine[];
  try {
    lines = lexLogicalLines(dslSource);
  } catch (err: unknown) {
    return { diagnostics: [`DSL lex error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // Scope stack tracks declared identifiers per function so `set` auto-declares `let` cleanly
  const scopeStack: Array<Set<string>> = [new Set(sig.params)];
  const currentScope = () => scopeStack[scopeStack.length - 1];

  let cursor = 0;

  function emitBlock(expectedIndent: number): string[] {
    const out: string[] = [];

    while (cursor < lines.length) {
      const tok = lines[cursor];
      if (tok.indent < expectedIndent) break;
      if (tok.indent > expectedIndent) {
        throw new Error(`Line ${tok.lineNo}: unexpected indentation (${tok.indent} > ${expectedIndent}) on "${tok.text}"`);
      }

      cursor++;
      const text = tok.text;

      // 1. Nested helper function: `fn helper(a, b):`
      const fnMatch = text.match(/^fn\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)\s*:$/);
      if (fnMatch) {
        const [, fnName, rawParams] = fnMatch;
        currentScope().add(fnName);
        const paramList = rawParams
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);

        const nextIndent = cursor < lines.length ? lines[cursor].indent : -1;
        if (nextIndent <= expectedIndent) {
          throw new Error(`Line ${tok.lineNo}: expected indented body after "${text}"`);
        }

        scopeStack.push(new Set(paramList));
        const inner = emitBlock(nextIndent);
        scopeStack.pop();

        out.push(`function ${fnName}(${paramList.join(", ")}) {\n${inner.join("\n")}\n}`);
        continue;
      }

      // 2. Variable binding / destructuring / reassignment: `set x = expr` or `set [a, b] = expr`
      // 2. Variable binding / destructuring / member assignment: `set x = expr`, `set [a, b] = expr`, `set obj.k = expr`
      const setMatch = text.match(/^set\s+(.+?)\s*=\s*(.+)$/);
      if (setMatch) {
        const [, lhsRaw, rhsRaw] = setMatch;
        const lhs = lhsRaw.trim();
        const rhs = normalizeOperators(rhsRaw);

        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(lhs)) {
          // Simple identifier
          if (!currentScope().has(lhs)) {
            currentScope().add(lhs);
            out.push(`let ${lhs} = ${rhs};`);
          } else {
            out.push(`${lhs} = ${rhs};`);
          }
        } else if (lhs.startsWith("[") || lhs.startsWith("{")) {
          // Array or object destructuring (`set [a, b] = ...` or `set { x, y } = ...`)
          out.push(`let ${lhs} = ${rhs};`);
        } else {
          // Property / index assignment (`set res[cat] = ...` or `set obj.count = ...`)
          out.push(`${lhs} = ${rhs};`);
        }
        continue;
      }

      // 3. Range loop: `for i from start to end:` (exclusive end)
      const rangeMatch = text.match(/^for\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+(.+?)\s+to\s+(.+):$/);
      if (rangeMatch) {
        const [, iterVar, startExpr, endExpr] = rangeMatch;
        const nextIndent = cursor < lines.length ? lines[cursor].indent : -1;
        if (nextIndent <= expectedIndent) {
          throw new Error(`Line ${tok.lineNo}: expected indented body after "${text}"`);
        }
        currentScope().add(iterVar);
        const inner = emitBlock(nextIndent);
        out.push(
          `for (let ${iterVar} = ${normalizeOperators(startExpr)}; ${iterVar} < ${normalizeOperators(endExpr)}; ${iterVar}++) {\n${inner.join("\n")}\n}`
        );
        continue;
      }

      // 4. Iterable loop: `for item of collection:` (or `for item in collection:`)
      const forOfMatch = text.match(/^for\s+(.+?)\s+(?:of|in)\s+(.+):$/);
      if (forOfMatch) {
        const [, binding, iterableExpr] = forOfMatch;
        const nextIndent = cursor < lines.length ? lines[cursor].indent : -1;
        if (nextIndent <= expectedIndent) {
          throw new Error(`Line ${tok.lineNo}: expected indented body after "${text}"`);
        }
        const inner = emitBlock(nextIndent);
        out.push(`for (const ${binding.trim()} of ${normalizeOperators(iterableExpr)}) {\n${inner.join("\n")}\n}`);
        continue;
      }

      // 5. While loop: `while cond:`
      const whileMatch = text.match(/^while\s+(.+):$/);
      if (whileMatch) {
        const nextIndent = cursor < lines.length ? lines[cursor].indent : -1;
        if (nextIndent <= expectedIndent) {
          throw new Error(`Line ${tok.lineNo}: expected indented body after "${text}"`);
        }
        const inner = emitBlock(nextIndent);
        out.push(`while (${normalizeOperators(whileMatch[1])}) {\n${inner.join("\n")}\n}`);
        continue;
      }

      // 6. Conditional chain: `if cond:` / `elif cond:` / `else:`
      const ifMatch = text.match(/^if\s+(.+):$/);
      if (ifMatch) {
        const nextIndent = cursor < lines.length ? lines[cursor].indent : -1;
        if (nextIndent <= expectedIndent) {
          throw new Error(`Line ${tok.lineNo}: expected indented body after "${text}"`);
        }
        let chain = `if (${normalizeOperators(ifMatch[1])}) {\n${emitBlock(nextIndent).join("\n")}\n}`;

        while (cursor < lines.length && lines[cursor].indent === expectedIndent) {
          const peek = lines[cursor].text;
          const elifMatch = peek.match(/^elif\s+(.+):$/);
          if (elifMatch) {
            cursor++;
            const elifIndent = cursor < lines.length ? lines[cursor].indent : -1;
            if (elifIndent <= expectedIndent) {
              throw new Error(`Line ${lines[cursor - 1].lineNo}: expected indented body after "${peek}"`);
            }
            chain += ` else if (${normalizeOperators(elifMatch[1])}) {\n${emitBlock(elifIndent).join("\n")}\n}`;
          } else if (peek === "else:") {
            cursor++;
            const elseIndent = cursor < lines.length ? lines[cursor].indent : -1;
            if (elseIndent <= expectedIndent) {
              throw new Error(`Line ${lines[cursor - 1].lineNo}: expected indented body after "else:"`);
            }
            chain += ` else {\n${emitBlock(elseIndent).join("\n")}\n}`;
            break;
          } else {
            break;
          }
        }

        out.push(chain);
        continue;
      }

      // 7. Return / break / continue
      if (text === "return") {
        out.push("return;");
        continue;
      }
      const retMatch = text.match(/^return\s+(.+)$/);
      if (retMatch) {
        out.push(`return ${normalizeOperators(retMatch[1])};`);
        continue;
      }
      if (text === "break" || text === "continue") {
        out.push(`${text};`);
        continue;
      }

      // 8. Standalone expression statement (e.g., `arr.push(x)`, `obj.count += 1`, `helper(a)`)
      out.push(`${normalizeOperators(text)};`);
    }

    return out;
  }

  let jsBodyLines: string[];
  try {
    const startIndent = lines.length > 0 ? lines[0].indent : 0;
    jsBodyLines = emitBlock(startIndent);
  } catch (err: unknown) {
    return { diagnostics: [`DSL structure error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const wrappedSource = `function ${sig.name}(${sig.params.join(", ")}) {\n${jsBodyLines.join("\n")}\n}`;

  try {
    const estree = acorn.parse(wrappedSource, {
      ecmaVersion: 2022,
      sourceType: "script",
    }) as unknown as ESTree.Program;

    // Hoist `let` declarations to the top of each enclosing function so variables
    // introduced inside `if`/`while`/`for` blocks are accessible function-wide.
    walk(estree as unknown as Parameters<typeof walk>[0], {
      enter(node) {
        if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
          if (node.body.type !== "BlockStatement") return;
          const hoistedNames = new Set<string>();

          walk(node.body as unknown as Parameters<typeof walk>[0], {
            enter(inner, parent) {
              // Do not hoist across nested function boundaries
              if (
                inner !== node.body &&
                (inner.type === "FunctionDeclaration" ||
                  inner.type === "FunctionExpression" ||
                  inner.type === "ArrowFunctionExpression")
              ) {
                this.skip();
                return;
              }

              if (
                inner.type === "VariableDeclaration" &&
                inner.kind === "let" &&
                parent &&
                parent.type !== "ForStatement"
              ) {
                const assignments: ESTree.ExpressionStatement[] = [];
                for (const decl of inner.declarations) {
                  if (decl.id.type === "Identifier") {
                    hoistedNames.add(decl.id.name);
                    if (decl.init) {
                      assignments.push({
                        type: "ExpressionStatement",
                        expression: {
                          type: "AssignmentExpression",
                          operator: "=",
                          left: { type: "Identifier", name: decl.id.name },
                          right: decl.init,
                        },
                      });
                    }
                  }
                }
                if (assignments.length === 1) {
                  this.replace(assignments[0] as unknown as Parameters<typeof this.replace>[0]);
                } else if (assignments.length > 1) {
                  this.replace({
                    type: "BlockStatement",
                    body: assignments,
                  } as unknown as Parameters<typeof this.replace>[0]);
                }
              }
            },
          });

          if (hoistedNames.size > 0) {
            const hoistDecl: ESTree.VariableDeclaration = {
              type: "VariableDeclaration",
              kind: "let",
              declarations: [...hoistedNames].map((name) => ({
                type: "VariableDeclarator",
                id: { type: "Identifier", name },
                init: null,
              })),
            };
            node.body.body.unshift(hoistDecl);
          }
        }
      },
    });

    return { estree, diagnostics: [] };
  } catch (err: unknown) {
    return {
      diagnostics: [
        `Acorn parse error: ${err instanceof Error ? err.message : String(err)}\nLowered JS:\n${wrappedSource}`,
      ],
    };
  }
}