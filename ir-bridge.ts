// ir-bridge.ts — Immutable Flat-IR to AST Bridge (Zero AI dependencies)
import type { ExprBlock, FunctionGraph, PrimitiveType, StmtBlock } from "./ast.ts";

export interface IRExprNode {
  id: string;
  kind: "NUM" | "STR" | "BOOL" | "VAR" | "BIN_OP";
  num?: number;
  str?: string;
  bool?: boolean;
  name?: string;
  op?: Extract<ExprBlock, { kind: "BINARY_OP" }>["op"];
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

export function buildASTFromIR(
  meta: { name: string; params: Array<{ name: string; paramType: PrimitiveType }>; returnType: PrimitiveType },
  ir: FlatProgramIR
): { graph?: FunctionGraph; errors: string[] } {
  const errors: string[] = [];
  const exprPool = new Map<string, IRExprNode>();

  for (const e of ir.exprs ?? []) {
    if (!e.id) errors.push("Expression node missing 'id'.");
    else if (exprPool.has(e.id)) errors.push(`Duplicate expression id '${e.id}'.`);
    else exprPool.set(e.id, e);
  }

  const resolved = new Map<string, ExprBlock>();
  const visiting = new Set<string>();

  function resolveExpr(id?: string): ExprBlock | null {
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
    let block: ExprBlock | null = null;

    switch (node.kind) {
      case "NUM":
        if (typeof node.num !== "number" || Number.isNaN(node.num)) {
          errors.push(`NUM node '${id}' requires valid 'num'.`);
        } else {
          block = { kind: "LITERAL", valueType: "number", value: node.num };
        }
        break;
      case "STR":
        if (typeof node.str !== "string") errors.push(`STR node '${id}' requires 'str'.`);
        else block = { kind: "LITERAL", valueType: "string", value: node.str };
        break;
      case "BOOL":
        if (typeof node.bool !== "boolean") errors.push(`BOOL node '${id}' requires 'bool'.`);
        else block = { kind: "LITERAL", valueType: "boolean", value: node.bool };
        break;
      case "VAR":
        if (!node.name) errors.push(`VAR node '${id}' requires 'name'.`);
        else block = { kind: "VAR_REF", name: node.name };
        break;
      case "BIN_OP": {
        const l = resolveExpr(node.left);
        const r = resolveExpr(node.right);
        if (!node.op) errors.push(`BIN_OP node '${id}' requires 'op'.`);
        else if (l && r) block = { kind: "BINARY_OP", op: node.op, left: l, right: r };
        break;
      }
    }

    visiting.delete(id);
    if (block) resolved.set(id, block);
    return block;
  }

  const body: StmtBlock[] = [];
  for (const s of ir.stmts ?? []) {
    const val = resolveExpr(s.expr);
    switch (s.kind) {
      case "LET":
        if (!s.name || !s.varType) errors.push("LET statement requires 'name' and 'varType'.");
        else if (val) body.push({ kind: "DECLARE", name: s.name, varType: s.varType, init: val });
        break;
      case "SET":
        if (!s.name) errors.push("SET statement requires 'name'.");
        else if (val) body.push({ kind: "ASSIGN", name: s.name, value: val });
        break;
      case "IF_RET": {
        const cond = resolveExpr(s.cond);
        if (cond && val) {
          body.push({ kind: "IF_ELSE", condition: cond, thenBranch: [{ kind: "RETURN", value: val }] });
        }
        break;
      }
      case "RET":
        if (val) body.push({ kind: "RETURN", value: val });
        break;
    }
  }

  if (errors.length > 0) return { errors };
  return {
    graph: { name: meta.name, params: meta.params, returnType: meta.returnType, body },
    errors: [],
  };
}