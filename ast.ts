// ast.ts — Language-agnostic AST block types
export type PrimitiveType = "number" | "boolean" | "string";

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

export type StmtBlock =
  | { kind: "DECLARE"; name: string; varType: PrimitiveType; init: ExprBlock }
  | { kind: "ASSIGN"; name: string; value: ExprBlock }
  | { kind: "IF_ELSE"; condition: ExprBlock; thenBranch: StmtBlock[]; elseBranch?: StmtBlock[] }
  | { kind: "WHILE"; condition: ExprBlock; body: StmtBlock[] }
  | { kind: "RETURN"; value: ExprBlock };

export interface FunctionGraph {
  name: string;
  params: Array<{ name: string; paramType: PrimitiveType }>;
  returnType: PrimitiveType;
  body: StmtBlock[];
}