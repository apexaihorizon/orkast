// lower-ts.ts — Lowers a validated FunctionGraph into clean TypeScript code
import type { ExprBlock, FunctionGraph, StmtBlock } from "./ast.ts";

export function lowerToTypeScript(graph: FunctionGraph): string {
  const indent = (level: number) => "  ".repeat(level);

  function lowerExpr(expr: ExprBlock): string {
    switch (expr.kind) {
      case "LITERAL":
        return typeof expr.value === "string" ? JSON.stringify(expr.value) : String(expr.value);
      case "VAR_REF":
        return expr.name;
      case "UNARY_OP":
        return `(${expr.op}${lowerExpr(expr.operand)})`;
      case "BINARY_OP":
        return `(${lowerExpr(expr.left)} ${expr.op} ${lowerExpr(expr.right)})`;
    }
  }

  function lowerStmts(stmts: StmtBlock[], level: number): string {
    return stmts
      .map((stmt) => {
        const pad = indent(level);
        switch (stmt.kind) {
          case "DECLARE":
            return `${pad}let ${stmt.name}: ${stmt.varType} = ${lowerExpr(stmt.init)};`;
          case "ASSIGN":
            return `${pad}${stmt.name} = ${lowerExpr(stmt.value)};`;
          case "IF_ELSE": {
            const thenCode = lowerStmts(stmt.thenBranch, level + 1);
            const elseCode =
              stmt.elseBranch && stmt.elseBranch.length > 0
                ? ` else {\n${lowerStmts(stmt.elseBranch, level + 1)}\n${pad}}`
                : "";
            return `${pad}if (${lowerExpr(stmt.condition)}) {\n${thenCode}\n${pad}}${elseCode}`;
          }
          case "WHILE":
            return `${pad}while (${lowerExpr(stmt.condition)}) {\n${lowerStmts(stmt.body, level + 1)}\n${pad}}`;
          case "RETURN":
            return `${pad}return ${lowerExpr(stmt.value)};`;
        }
      })
      .join("\n");
  }

  const paramsSig = graph.params.map((p) => `${p.name}: ${p.paramType}`).join(", ");
  return `function ${graph.name}(${paramsSig}): ${graph.returnType} {\n${lowerStmts(graph.body, 1)}\n}`;
}