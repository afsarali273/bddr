import ts from 'typescript';
import { normalizeText, sha, type Literal } from './hash.js';

export interface CheckCall {
  id: string;
  /** Character range of the whole `check(...)` call. */
  start: number;
  end: number;
  /** Hash of the check body, independent of formatting. */
  hash: string;
  body: string;
}

export interface CompiledFile {
  /** True when the file starts with the `// @bddr-compiled` marker. */
  isCompiled: boolean;
  /** `// key: value` lines in the header comment. */
  header: Record<string, string>;
  checkCalls: CheckCall[];
  /** check id -> body hash. */
  checkCode: Record<string, string>;
  /** String and number literals OUTSIDE check calls: the action code's data. */
  actionLiterals: Literal[];
  /** Hash of the code with every string literal and member name masked: what a pure re-targeting heal keeps. */
  shape: string;
  errors: string[];
}

const printer = ts.createPrinter({ removeComments: true });

export function parseCompiled(code: string, fileName = 'compiled.ts'): CompiledFile {
  const header: Record<string, string> = {};
  let isCompiled = false;
  for (const line of code.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('//')) break;
    const body = t.slice(2).trim();
    if (body.startsWith('@bddr-compiled')) isCompiled = true;
    const m = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(body);
    if (m) header[m[1]!] = m[2]!.trim();
  }

  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const errors: string[] = [];
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of diags) errors.push(`syntax: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);

  const checkCalls: CheckCall[] = [];
  const actionLiterals: Literal[] = [];
  const visit = (node: ts.Node, insideCheck: boolean): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'check' &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      const id = (node.arguments[0] as ts.StringLiteral).text;
      const fn = node.arguments[1];
      const printed = fn ? printer.printNode(ts.EmitHint.Unspecified, fn, sf) : '';
      checkCalls.push({ id, start: node.getStart(sf), end: node.getEnd(), hash: sha(normalizeText(printed)), body: printed });
      node.forEachChild((c) => visit(c, true));
      return;
    }
    if (!insideCheck) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) actionLiterals.push({ kind: 'string', value: node.text });
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (node.text) actionLiterals.push({ kind: 'string', value: node.text });
      } else if (ts.isNumericLiteral(node)) actionLiterals.push({ kind: 'number', value: Number(node.text) });
      else if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
      ) {
        actionLiterals.push({ kind: 'number', value: -Number(node.operand.text) });
        return;
      }
    }
    node.forEachChild((c) => visit(c, insideCheck));
  };
  visit(sf, false);

  const checkCode: Record<string, string> = {};
  for (const c of checkCalls) {
    if (checkCode[c.id]) errors.push(`check ${c.id} is called more than once`);
    checkCode[c.id] = c.hash;
  }
  return { isCompiled, header, checkCalls, checkCode, actionLiterals, shape: shapeOf(sf), errors };
}

/** Write (or replace) the header comment of a compiled file. */
export function stampHeader(code: string, fields: Record<string, string>): string {
  const lines = code.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim().startsWith('//')) i++;
  const old = parseCompiled(code).header;
  const merged = { ...old, ...fields };
  const head = ['// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.'];
  for (const k of ['id', 'prompt', 'checks', 'built']) if (merged[k]) head.push(`// ${k}: ${merged[k]}`);
  for (const [k, v] of Object.entries(merged)) if (!['id', 'prompt', 'checks', 'built'].includes(k)) head.push(`// ${k}: ${v}`);
  return [...head, ...lines.slice(i)].join('\n');
}

/**
 * The code's structure with every string literal and every `x.member` name masked. Two files with
 * the same shape differ only in which element, route or API method they target: the kind of
 * change a locator heal makes. Anything else (a step added, removed or moved, a number changed,
 * control flow changed) changes the shape.
 */
function shapeOf(sf: ts.SourceFile): string {
  const mask = (ctx: ts.TransformationContext) => (root: ts.Node) => {
    const visit = (n: ts.Node): ts.Node => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return ts.factory.createStringLiteral('S');
      if (ts.isPropertyAccessExpression(n)) {
        return ts.factory.updatePropertyAccessExpression(n, ts.visitNode(n.expression, visit) as ts.Expression, ts.factory.createIdentifier('m'));
      }
      return ts.visitEachChild(n, visit, ctx);
    };
    return ts.visitNode(root, visit);
  };
  const out = ts.transform(sf, [mask]);
  const printed = printer.printFile(out.transformed[0] as ts.SourceFile);
  out.dispose();
  return sha(normalizeText(printed));
}
