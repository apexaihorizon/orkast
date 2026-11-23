// validate.ts — Checks variable scope and operator types before lowering
import type { ExprBlock, FunctionGraph, PrimitiveType, StmtBlock } from "./ast.ts";

export function validateGraph(graph: FunctionGraph): string[] {
  const errors: string[] = [];
  const scope = new Map<string, PrimitiveType>();

  for (const p of graph.params) {
    if (scope.has(p.name)) errors.push(`Duplicate parameter: ${p.name}`);
    scope.set(p.name, p.paramType);
  }

  function inferExprType(expr: ExprBlock, currentScope: Map<string, PrimitiveType>): PrimitiveType | "invalid" {
    switch (expr.kind) {
      case "LITERAL":
        return expr.valueType;
      case "VAR_REF": {
        const t = currentScope.get(expr.name);
        if (!t) {
          errors.push(`Undeclared variable referenced: '${expr.name}'`);
          return "invalid";
        }
        return t;
      }
      case "UNARY_OP": {
        const t = inferExprType(expr.operand, currentScope);
        if (t === "invalid") return "invalid";
        if (expr.op === "!" && t !== "boolean") {
          errors.push(`Operator '!' requires boolean, got ${t}`);
          return "invalid";
        }
        if (expr.op === "-" && t !== "number") {
          errors.push(`Unary '-' requires number, got ${t}`);
          return "invalid";
        }
        return t;
      }
      case "BINARY_OP": {
        const lt = inferExprType(expr.left, currentScope);
        const rt = inferExprType(expr.right, currentScope);
        if (lt === "invalid" || rt === "invalid") return "invalid";
        if (lt !== rt) {
          errors.push(`Type mismatch in '${expr.op}': left is ${lt}, right is ${rt}`);
          return "invalid";
        }
        if (["+", "-", "*", "/", "%"].includes(expr.op)) {
          if (lt !== "number") {
            errors.push(`Arithmetic '${expr.op}' requires number, got ${lt}`);
            return "invalid";
          }
          return "number";
        }
        if (["&&", "||"].includes(expr.op)) {
          if (lt !== "boolean") {
            errors.push(`Logical '${expr.op}' requires boolean, got ${lt}`);
            return "invalid";
          }
          return "boolean";
        }
        return "boolean";
      }
    }
  }

  function validateStmts(stmts: StmtBlock[], localScope: Map<string, PrimitiveType>) {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "DECLARE": {
          if (localScope.has(stmt.name)) {
            errors.push(`Variable '${stmt.name}' already declared in scope`);
          }
          const initType = inferExprType(stmt.init, localScope);
          if (initType !== "invalid" && initType !== stmt.varType) {
            errors.push(`Cannot initialize '${stmt.name}' (${stmt.varType}) with ${initType}`);
          }
          localScope.set(stmt.name, stmt.varType);
          break;
        }
        case "ASSIGN": {
          const targetType = localScope.get(stmt.name);
          if (!targetType) {
            errors.push(`Cannot assign to undeclared variable '${stmt.name}'`);
            break;
          }
          const valType = inferExprType(stmt.value, localScope);
          if (valType !== "invalid" && valType !== targetType) {
            errors.push(`Cannot assign ${valType} to '${stmt.name}' (${targetType})`);
          }
          break;
        }
        case "IF_ELSE": {
          const condType = inferExprType(stmt.condition, localScope);
          if (condType !== "invalid" && condType !== "boolean") {
            errors.push(`IF_ELSE condition must be boolean, got ${condType}`);
          }
          validateStmts(stmt.thenBranch, new Map(localScope));
          if (stmt.elseBranch) validateStmts(stmt.elseBranch, new Map(localScope));
          break;
        }
        case "WHILE": {
          const condType = inferExprType(stmt.condition, localScope);
          if (condType !== "invalid" && condType !== "boolean") {
            errors.push(`WHILE condition must be boolean, got ${condType}`);
          }
          validateStmts(stmt.body, new Map(localScope));
          break;
        }
        case "RETURN": {
          const retType = inferExprType(stmt.value, localScope);
          if (retType !== "invalid" && retType !== graph.returnType) {
            errors.push(`Return type mismatch: expected ${graph.returnType}, got ${retType}`);
          }
          break;
        }
      }
    }
  }

  validateStmts(graph.body, scope);
  function guaranteesReturn(stmts: StmtBlock[]): boolean {
    return stmts.some(
      (s) =>
        s.kind === "RETURN" ||
        (s.kind === "IF_ELSE" &&
          s.elseBranch !== undefined &&
          guaranteesReturn(s.thenBranch) &&
          guaranteesReturn(s.elseBranch))
    );
  }

  if (!guaranteesReturn(graph.body)) {
    errors.push(`Control flow error: '${graph.name}' must guarantee a RETURN on all paths.`);
  }
  return errors;
}