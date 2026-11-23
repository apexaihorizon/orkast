// orkast.ts — v0.1 Deterministic AST-Block Orchestrator & Lowering Engine
// Run directly with: node orkast.ts (Node 22.18+ / 24 native TypeScript)

export type PrimitiveType = "number" | "boolean" | "string";

// 1. EXPRESSION BLOCKS (Pure value-producing nodes)
export type ExprBlock =
  | { kind: "LITERAL"; valueType: PrimitiveType; value: number | boolean | string }
  | { kind: "VAR_REF"; name: string }
  | {
      kind: "BINARY_OP";
      op: "+" | "-" | "*" | "/" | "%" | "===" | "!==" | "<" | "<=" | ">" | ">=" | "&&" | "||";
      left: ExprBlock;
      right: ExprBlock;
    }
  | { kind: "UNARY_OP"; op: "!" | "-"; operand: ExprBlock };

// 2. STATEMENT BLOCKS (State-mutating & control-flow nodes)
export type StmtBlock =
  | { kind: "DECLARE"; name: string; varType: PrimitiveType; init: ExprBlock }
  | { kind: "ASSIGN"; name: string; value: ExprBlock }
  | { kind: "IF_ELSE"; condition: ExprBlock; thenBranch: StmtBlock[]; elseBranch?: StmtBlock[] }
  | { kind: "WHILE"; condition: ExprBlock; body: StmtBlock[] }
  | { kind: "RETURN"; value: ExprBlock };

// 3. FUNCTION GRAPH (Top-level unit)
export interface FunctionGraph {
  name: string;
  params: Array<{ name: string; paramType: PrimitiveType }>;
  returnType: PrimitiveType;
  body: StmtBlock[];
}

// 4. DETERMINISTIC TYPE & SCOPE VALIDATOR (Catches structural bugs before lowering)
export function validateGraph(graph: FunctionGraph): string[] {
  const errors: string[] = [];
  const scope = new Map<string, PrimitiveType>();

  for (const p of graph.params) {
    if (scope.has(p.name)) errors.push(`Duplicate parameter: ${p.name}`);
    scope.set(p.name, p.paramType);
  }

  function inferExprType(expr: ExprBlock): PrimitiveType | "invalid" {
    switch (expr.kind) {
      case "LITERAL":
        return expr.valueType;
      case "VAR_REF": {
        const t = scope.get(expr.name);
        if (!t) {
          errors.push(`Undeclared variable referenced: '${expr.name}'`);
          return "invalid";
        }
        return t;
      }
      case "UNARY_OP": {
        const t = inferExprType(expr.operand);
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
        const lt = inferExprType(expr.left);
        const rt = inferExprType(expr.right);
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
        return "boolean"; // Comparison operators (===, <, >=, etc.)
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
          const initType = inferExprType(stmt.init);
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
          const valType = inferExprType(stmt.value);
          if (valType !== "invalid" && valType !== targetType) {
            errors.push(`Cannot assign ${valType} to '${stmt.name}' (${targetType})`);
          }
          break;
        }
        case "IF_ELSE": {
          const condType = inferExprType(stmt.condition);
          if (condType !== "invalid" && condType !== "boolean") {
            errors.push(`IF_ELSE condition must be boolean, got ${condType}`);
          }
          validateStmts(stmt.thenBranch, new Map(localScope));
          if (stmt.elseBranch) validateStmts(stmt.elseBranch, new Map(localScope));
          break;
        }
        case "WHILE": {
          const condType = inferExprType(stmt.condition);
          if (condType !== "invalid" && condType !== "boolean") {
            errors.push(`WHILE condition must be boolean, got ${condType}`);
          }
          validateStmts(stmt.body, new Map(localScope));
          break;
        }
        case "RETURN": {
          const retType = inferExprType(stmt.value);
          if (retType !== "invalid" && retType !== graph.returnType) {
            errors.push(`Return type mismatch: expected ${graph.returnType}, got ${retType}`);
          }
          break;
        }
      }
    }
  }

  validateStmts(graph.body, scope);
  return errors;
}

// 5. DETERMINISTIC LOWERING PASS (AST Blocks -> Clean TypeScript Code)
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

// 6. SANDBOX EDGE-CASE VERIFIER (Tests lowered logic against human-defined invariants)
export interface TestCase {
  label: string;
  args: Array<number | boolean | string>;
  expected: number | boolean | string;
}

export function verifyGraph(graph: FunctionGraph, tests: TestCase[]) {
  const validationErrors = validateGraph(graph);
  if (validationErrors.length > 0) {
    console.log("❌ AST Validation Failed:", validationErrors);
    return;
  }

  const tsCode = lowerToTypeScript(graph);
  console.log("--- Lowered TypeScript ---\n" + tsCode + "\n--------------------------");

  // Strip types cleanly for runtime execution check
  const jsBody = tsCode
    .replace(/:\s*(number|boolean|string)/g, "")
    .replace(/^function\s+\w+\([^)]*\)\s*\{/, "")
    .replace(/\}$/, "");

  const fn = new Function(...graph.params.map((p) => p.name), jsBody);

  for (const t of tests) {
    const actual = fn(...t.args);
    const pass = actual === t.expected;
    console.log(
      pass
        ? `✅ PASS [${t.label}] -> ${JSON.stringify(actual)}`
        : `❌ FAIL [${t.label}] -> input=${JSON.stringify(t.args)} expected=${JSON.stringify(t.expected)}, got=${JSON.stringify(actual)}`
    );
  }
}

// --- DEMO: Clamp a number between [min, max] ---
const clampGraph: FunctionGraph = {
  name: "clampValue",
  params: [
    { name: "val", paramType: "number" },
    { name: "min", paramType: "number" },
    { name: "max", paramType: "number" },
  ],
  returnType: "number",
  body: [
    {
      kind: "IF_ELSE",
      condition: {
        kind: "BINARY_OP",
        op: "<",
        left: { kind: "VAR_REF", name: "val" },
        right: { kind: "VAR_REF", name: "min" },
      },
      thenBranch: [{ kind: "RETURN", value: { kind: "VAR_REF", name: "min" } }],
    },
    {
      kind: "IF_ELSE",
      condition: {
        kind: "BINARY_OP",
        op: ">",
        left: { kind: "VAR_REF", name: "val" },
        right: { kind: "VAR_REF", name: "max" },
      },
      thenBranch: [{ kind: "RETURN", value: { kind: "VAR_REF", name: "max" } }],
    },
    { kind: "RETURN", value: { kind: "VAR_REF", name: "val" } },
  ],
};

verifyGraph(clampGraph, [
  { label: "Inside range", args: [50, 0, 100], expected: 50 },
  { label: "Below min", args: [-10, 0, 100], expected: 0 },
  { label: "Above max", args: [150, 0, 100], expected: 100 },
  { label: "Exact min boundary", args: [0, 0, 100], expected: 0 },
  { label: "Exact max boundary", args: [100, 0, 100], expected: 100 },
]);