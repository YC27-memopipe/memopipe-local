import type { Expr, Instruction, Program, Value } from "./types.ts";
import { isDate, validateAction, validateCall } from "./validation.ts";
import { LEVELS } from "./types.ts";

type Token = { kind: "string" | "word" | "symbol"; text: string };
const blocked = new Set(["__proto__", "prototype", "constructor"]);
function safeName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || blocked.has(name)) throw new Error(`Forbidden name: ${name}`);
}
function assignment(tokens: Token[]) {
  const token = tokens.shift();
  if (token?.kind !== "symbol" || token.text !== "=") throw new Error("Expected = assignment");
}
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < input.length;) {
    const rest = input.slice(i);
    if (/^\s/.test(rest)) { i++; continue; }
    if (rest[0] === '"') {
      const match = rest.match(/^"(?:[^"\\]|\\.)*"/);
      if (!match) throw new Error("Unterminated string");
      const value = JSON.parse(match[0]);
      for (const m of value.matchAll(/\{\{([^{}]+)\}\}/g)) parsePath(m[1].trim());
      if (value.replace(/\{\{[^{}]+\}\}/g, "").match(/[{}]/)) throw new Error("Invalid interpolation");
      out.push({ kind: "string", text: value }); i += match[0].length; continue;
    }
    const match = rest.match(/^(==|!=|[=()]|[A-Za-z_][A-Za-z0-9_.-]*)/);
    if (!match) throw new Error(`Unexpected token: ${rest.slice(0, 20)}`);
    out.push({ kind: /^[A-Za-z_]/.test(match[0]) ? "word" : "symbol", text: match[0] }); i += match[0].length;
  }
  return out;
}
function parsePath(text: string): string[] {
  const parts = text.split("."); parts.forEach(safeName); return parts;
}
class ExpressionParser {
  index = 0;
  constructor(readonly tokens: Token[]) {}
  peek(value: string) { return this.tokens[this.index]?.kind !== "string" && this.tokens[this.index]?.text === value; }
  take(value: string) { if (this.peek(value)) { this.index++; return true; } return false; }
  expression(): Expr { return this.or(); }
  or(): Expr { let left = this.and(); while (this.take("or")) left = { kind: "binary", op: "or", left, right: this.and() }; return left; }
  and(): Expr { let left = this.not(); while (this.take("and")) left = { kind: "binary", op: "and", left, right: this.not() }; return left; }
  not(): Expr { return this.take("not") ? { kind: "not", value: this.not() } : this.equality(); }
  equality(): Expr {
    const left = this.atom();
    if (this.peek("==") || this.peek("!=")) {
      const op = this.tokens[this.index++].text as "==" | "!=";
      return { kind: "binary", op, left, right: this.atom() };
    }
    return left;
  }
  atom(): Expr {
    if (this.take("(")) { const e = this.expression(); if (!this.take(")")) throw new Error("Missing )"); return e; }
    const t = this.tokens[this.index++];
    if (t?.kind === "string") return { kind: "literal", value: t.text };
    if (t?.kind === "word" && !["and", "or", "not"].includes(t.text)) return { kind: "path", path: parsePath(t.text) };
    throw new Error("Expected string or variable path");
  }
}
function wholeExpression(tokens: Token[]): Expr {
  const p = new ExpressionParser(tokens); const e = p.expression();
  if (p.index !== tokens.length) throw new Error("Unexpected expression suffix"); return e;
}
export function compile(source: string): Program {
  const program: Program = { format: "canary-dsl/v1", instructions: [] };
  const stack: { branch: number; jump?: number }[] = [];
  const instructions = program.instructions;
  if (source.length > 100_000) throw new Error("DSL too large");
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = index + 1; const text = raw.trim(); if (!text || text.startsWith("#")) continue;
    try {
      const t = tokenize(text); const commandToken = t.shift();
      if (commandToken?.kind !== "word") throw new Error("Expected instruction keyword");
      const command = commandToken.text;
      const base = { line, source: text };
      if (command === "AUTOMATION" || command === "USAGE") {
        if (instructions.length || t.length !== 1 || t[0].kind !== "string") throw new Error("Metadata must be a single string before instructions");
        const key = command === "AUTOMATION" ? "title" : "usage";
        if (program[key] !== undefined) throw new Error("Duplicate metadata"); program[key] = t[0].text;
      } else if (command === "SET") {
        const nameToken = t.shift();
        if (nameToken?.kind !== "word") throw new Error("Expected variable name");
        const name = nameToken.text; safeName(name);
        if (["ticket", "and", "or", "not"].includes(name)) throw new Error("Invalid SET");
        assignment(t);
        instructions.push({ ...base, op: "set", name, value: wholeExpression(t) });
      } else if (command === "DO") {
        const actionToken = t.shift();
        if (actionToken?.kind !== "word") throw new Error("Expected action name");
        const action = actionToken.text; const args: Record<string, Expr> = Object.create(null);
        while (t.length) {
          const keyToken = t.shift();
          if (keyToken?.kind !== "word") throw new Error("Expected argument name");
          const key = keyToken.text; safeName(key);
          if (Object.hasOwn(args, key)) throw new Error("Duplicate action argument");
          assignment(t);
          const parser = new ExpressionParser(t); args[key] = parser.expression(); t.splice(0, parser.index);
        }
        validateAction(action, args);
        // Validate all static arguments at compile time; dynamic values are checked before dispatch.
        if (Object.values(args).every(e => e.kind === "literal" && !e.value.includes("{{"))) {
          validateCall(action, Object.fromEntries(Object.entries(args).map(([k, e]) => [k, (e as { value: string }).value])));
        } else if (action === "iam.grant") {
          const system = args.system; const level = args.level;
          if (system?.kind === "literal" && !system.value.includes("{{") && !Object.hasOwn(LEVELS, system.value)) throw new Error("Invalid system");
          const expires = args.expires;
          if (expires?.kind === "literal" && !expires.value.includes("{{") && !isDate(expires.value)) throw new Error("Invalid expiration date");
          if (system?.kind === "literal" && level?.kind === "literal" && !system.value.includes("{{") && !level.value.includes("{{")) {
            validateCall(action, { user: "compile@example.test", system: system.value, level: level.value });
          }
        }
        instructions.push({ ...base, op: "do", action, args });
      } else if (command === "IF") {
        stack.push({ branch: instructions.length }); instructions.push({ ...base, op: "branch", condition: wholeExpression(t), target: -1 });
      } else if (command === "ELSE") {
        const block = stack.at(-1); if (t.length || !block || block.jump !== undefined) throw new Error("Unexpected ELSE");
        block.jump = instructions.length; instructions.push({ ...base, op: "jump", target: -1 });
        (instructions[block.branch] as Extract<Instruction, { op: "branch" }>).target = instructions.length;
      } else if (command === "END") {
        const block = stack.pop(); if (t.length || !block) throw new Error("Unexpected END");
        const jump = instructions[block.jump ?? block.branch] as Extract<Instruction, { op: "branch" | "jump" }>;
        jump.target = instructions.length;
      } else throw new Error(`Unknown instruction: ${command}`);
    } catch (e) { throw new Error(`Line ${line}: ${(e as Error).message}`); }
  }
  if (stack.length) throw new Error("IF without END");
  if (!instructions.length) throw new Error("Empty automation");
  return program;
}
function lookup(path: string[], vars: Record<string, Value>): Value {
  let value: Value = vars;
  for (const key of path) {
    safeName(key);
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`Unknown variable: ${path.join(".")}`);
    value = value[key];
  }
  return value;
}
export function evaluate(expr: Expr, vars: Record<string, Value>): Value {
  switch (expr.kind) {
    case "literal": return expr.value.replace(/\{\{([^{}]+)\}\}/g, (_, p: string) => {
      const value = lookup(parsePath(p.trim()), vars);
      if (typeof value === "object") throw new Error("Interpolation requires scalar value"); return String(value);
    });
    case "path": return lookup(expr.path, vars);
    case "not": return !evaluate(expr.value, vars);
    case "binary": {
      const left = evaluate(expr.left, vars);
      if (expr.op === "and") return !!left && !!evaluate(expr.right, vars);
      if (expr.op === "or") return !!left || !!evaluate(expr.right, vars);
      const right = evaluate(expr.right, vars);
      return expr.op === "==" ? left === right : left !== right;
    }
  }
}
