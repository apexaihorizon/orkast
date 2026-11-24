// ir-bridge.ts — Flat-IR to Standard ESTree AST Bridge (for astring + TypeScript Compiler API)
import type * as ESTree from "estree";

export type PrimitiveType = "number" | "boolean" | "string";

export interface IRExprNode {
  id: string;
  kind: "NUM" | "STR" | "BOOL" | "VAR" | "BIN_OP";
  num?: number;
  str?: string;
  bool?: boolean;
  name?: string;
  op?: ESTree.BinaryOperator | ESTree.LogicalOperator;
  left?: string;
  right?: string;
}

export interface IRStmtNode {
  kind: "LET" | "SET" | "IF_RET" | "RET";
  name?: string;
  varType?: PrimitiveType;
  cond?: string;
  expr: string;
}

export interface FlatProgramIR {
  exprs: IRExprNode[];
  stmts: IRStmtNode[];
}

export interface ProgramMeta {
  name: string;
  params: Array<{ name: string; paramType: PrimitiveType }>;
  returnType: PrimitiveType;
}

const LOGICAL_OPS = new Set(["&&", "||", "??"]);

export function buildESTreeFromIR(
  meta: ProgramMeta,
  ir: FlatProgramIR
): { estree?: ESTree.Program; errors: string[] } {
  const errors: string[] = [];
  const exprPool = new Map<string, IRExprNode>();

  for (const e of ir.exprs ?? []) {
    if (!e.id) errors.push("Expression node missing 'id'.");
    else if (exprPool.has(e.id)) errors.push(`Duplicate expression id '${e.id}'.`);
    else exprPool.set(e.id, e);
  }

  const resolved = new Map<string, ESTree.Expression>();
  const visiting = new Set<string>();

  function resolveExpr(id?: string): ESTree.Expression | null {
    if (!id) {
      errors.push("Missing expression reference id.");
      return null;
    }
    if (resolved.has(id)) return resolved.get(id)!;
    if (visiting.has(id)) {
      errors.push(`Circular expression reference at '${id}'.`);
      return null;
    }

    const node = exprPool.get(id);
    if (!node) {
      errors.push(`Unknown expression id '${id}'.`);
      return null;
    }

    visiting.add(id);
    let expr: ESTree.Expression | null = null;

    switch (node.kind) {
      case "NUM":
        if (typeof node.num !== "number" || Number.isNaN(node.num)) {
          errors.push(`NUM node '${id}' requires valid 'num'.`);
        } else if (node.num < 0) {
          expr = {
            type: "UnaryExpression",
            operator: "-",
            prefix: true,
            argument: { type: "Literal", value: Math.abs(node.num) },
          };
        } else {
          expr = { type: "Literal", value: node.num };
        }
        break;
      case "STR":
        if (typeof node.str !== "string") errors.push(`STR node '${id}' requires 'str'.`);
        else expr = { type: "Literal", value: node.str };
        break;
      case "BOOL":
        if (typeof node.bool !== "boolean") errors.push(`BOOL node '${id}' requires 'bool'.`);
        else expr = { type: "Literal", value: node.bool };
        break;
      case "VAR":
        if (!node.name) errors.push(`VAR node '${id}' requires 'name'.`);
        else expr = { type: "Identifier", name: node.name };
        break;
      case "BIN_OP": {
        const left = resolveExpr(node.left);
        const right = resolveExpr(node.right);
        if (!node.op) {
          errors.push(`BIN_OP node '${id}' requires 'op'.`);
        } else if (left && right) {
          expr = LOGICAL_OPS.has(node.op)
            ? { type: "LogicalExpression", operator: node.op as ESTree.LogicalOperator, left, right }
            : { type: "BinaryExpression", operator: node.op as ESTree.BinaryOperator, left, right };
        }
        break;
      }
    }

    visiting.delete(id);
    if (expr) resolved.set(id, expr);
    return expr;
  }

  const body: ESTree.Statement[] = [];
  for (const s of ir.stmts ?? []) {
    const val = resolveExpr(s.expr);
    switch (s.kind) {
      case "LET":
        if (!s.name) errors.push("LET statement requires 'name'.");
        else if (val) {
          body.push({
            type: "VariableDeclaration",
            kind: "let",
            declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: s.name }, init: val }],
          });
        }
        break;
      case "SET":
        if (!s.name) errors.push("SET statement requires 'name'.");
        else if (val) {
          body.push({
            type: "ExpressionStatement",
            expression: {
              type: "AssignmentExpression",
              operator: "=",
              left: { type: "Identifier", name: s.name },
              right: val,
            },
          });
        }
        break;
      case "IF_RET": {
        const cond = resolveExpr(s.cond);
        if (cond && val) {
          body.push({
            type: "IfStatement",
            test: cond,
            consequent: { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: val }] },
            alternate: null,
          });
        }
        break;
      }
      case "RET":
        if (val) body.push({ type: "ReturnStatement", argument: val });
        break;
    }
  }

  if (errors.length > 0) return { errors };

  const fnDecl: ESTree.FunctionDeclaration = {
    type: "FunctionDeclaration",
    id: { type: "Identifier", name: meta.name },
    params: meta.params.map((p) => ({ type: "Identifier", name: p.name })),
    body: { type: "BlockStatement", body },
  };

  return {
    estree: { type: "Program", sourceType: "script", body: [fnDecl] },
    errors: [],
  };
}