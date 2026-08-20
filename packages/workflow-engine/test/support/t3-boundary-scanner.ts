import type * as TypeScript from 'typescript';

type TypeScriptApi = Omit<typeof TypeScript, 'default'>;

export type T3BoundaryFinding = {
  path: string;
  start: number;
  length: number;
  normalizedValue: string;
  syntaxForm:
    | 'exact-string'
    | 'embedded-string'
    | 'template-static'
    | 'folded'
    | 'path-join'
    | 'path-resolve'
    | 'fs-readdir'
    | 'fs-readdir-sync'
    | 'namespace-fragment';
};

export type T3BoundarySourceFindings = {
  workflowPaths: T3BoundaryFinding[];
  splitWorkflowPaths: T3BoundaryFinding[];
  dynamicWorkflowDirectories: T3BoundaryFinding[];
  namespace: T3BoundaryFinding[];
};

type SupportedModule = 'node:path' | 'node:fs' | 'node:fs/promises';

type Binding =
  | { kind: 'module-object'; module: SupportedModule }
  | { kind: 'module-member'; module: SupportedModule; exported: string }
  | { kind: 'const'; initializer: TypeScript.Expression }
  | { kind: 'repository-root' }
  | { kind: 'opaque' };

type BindingIndex = {
  resolve(identifier: TypeScript.Identifier): Binding | null;
};

type ScanContext = {
  ts: TypeScriptApi;
  file: string;
  sourceFile: TypeScript.SourceFile;
  bindings: BindingIndex;
};

type PathFact =
  | { kind: 'repository-root' }
  | { kind: 'workflow-root' }
  | {
      kind: 'workflow-json';
      normalizedValue: string;
      operation: 'join' | 'resolve';
    };

const ROOT_WORKFLOW_JSON =
  /(^|[^A-Za-z0-9_./-])(workflow\/([A-Za-z0-9][A-Za-z0-9._-]*\.json))(?=$|[^A-Za-z0-9_./-]|\.(?=$|[\s,;:!?)}\]]))/gu;

export function scanT3BoundarySource(
  ts: TypeScriptApi,
  file: string,
  source: string,
  extension: string,
): T3BoundarySourceFindings {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.js' ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const context: ScanContext = {
    ts,
    file,
    sourceFile,
    bindings: createBindingIndex(ts, sourceFile),
  };
  const findings: T3BoundarySourceFindings = {
    workflowPaths: [],
    splitWorkflowPaths: [],
    dynamicWorkflowDirectories: [],
    namespace: [],
  };

  const visit = (node: TypeScript.Node): void => {
    collectDirectFindings(node, context, findings.workflowPaths);
    collectNamespaceFindings(node, context, findings.namespace);

    if (ts.isCallExpression(node)) {
      const pathFact = provePath(node, context, new Set());
      if (pathFact?.kind === 'workflow-json') {
        findings.splitWorkflowPaths.push({
          path: file,
          start: node.getStart(sourceFile),
          length: node.getWidth(sourceFile),
          normalizedValue: pathFact.normalizedValue,
          syntaxForm:
            pathFact.operation === 'join' ? 'path-join' : 'path-resolve',
        });
      }

      const fsOperation = resolveFsOperation(
        node.expression,
        context,
        new Set(),
      );
      const target = node.arguments[0];
      if (
        fsOperation !== null &&
        target !== undefined &&
        provePath(target, context, new Set())?.kind === 'workflow-root'
      ) {
        findings.dynamicWorkflowDirectories.push({
          path: file,
          start: node.getStart(sourceFile),
          length: node.getWidth(sourceFile),
          normalizedValue: 'workflow/',
          syntaxForm:
            fsOperation === 'readdirSync' ? 'fs-readdir-sync' : 'fs-readdir',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const values of Object.values(findings)) {
    values.sort(compareFindings);
  }
  return findings;
}

function collectNamespaceFindings(
  node: TypeScript.Node,
  context: ScanContext,
  findings: T3BoundaryFinding[],
): void {
  const { ts, sourceFile, file } = context;
  if (
    (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) &&
    isOutermostStaticComposition(node, context)
  ) {
    const folded = foldStaticString(node, context, new Set());
    if (folded !== null) {
      recordNamespaceMatches(
        findings,
        file,
        node.getStart(sourceFile),
        node.getWidth(sourceFile),
        folded,
        'folded',
      );
    }
    return;
  }
  if (ts.isStringLiteral(node)) {
    if (hasFoldableNamespaceAncestor(node, context)) return;
    recordNamespaceMatches(
      findings,
      file,
      node.getStart(sourceFile),
      node.getWidth(sourceFile),
      node.text,
      'string',
    );
    return;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    if (hasFoldableNamespaceAncestor(node, context)) return;
    recordNamespaceMatches(
      findings,
      file,
      node.getStart(sourceFile),
      node.getWidth(sourceFile),
      node.text,
      'template',
    );
    return;
  }
  if (ts.isTemplateExpression(node)) {
    for (const fragment of [
      node.head,
      ...node.templateSpans.map((span) => span.literal),
    ]) {
      recordNamespaceMatches(
        findings,
        file,
        fragment.getStart(sourceFile),
        fragment.getWidth(sourceFile),
        fragment.text,
        'template',
      );
    }
  }
}

function recordNamespaceMatches(
  findings: T3BoundaryFinding[],
  file: string,
  start: number,
  length: number,
  text: string,
  sourceKind: 'string' | 'template' | 'folded',
): void {
  let matched = false;
  for (const match of text.matchAll(
    /expense-app\.workflow\.[A-Za-z0-9._-]+/gu,
  )) {
    matched = true;
    findings.push({
      path: file,
      start: start + (match.index ?? 0),
      length: match[0].length,
      normalizedValue: match[0],
      syntaxForm:
        sourceKind === 'folded'
          ? 'folded'
          : sourceKind === 'template'
            ? 'template-static'
            : text === match[0]
              ? 'exact-string'
              : 'embedded-string',
    });
  }
  if (!matched && text.includes('expense-app.workflow.')) {
    findings.push({
      path: file,
      start: start + text.indexOf('expense-app.workflow.'),
      length: 'expense-app.workflow.'.length,
      normalizedValue: 'expense-app.workflow.',
      syntaxForm: 'namespace-fragment',
    });
  }
}

function hasFoldableNamespaceAncestor(
  node: TypeScript.Node,
  context: ScanContext,
): boolean {
  const { ts } = context;
  let current: TypeScript.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isTemplateSpan(current)) {
      current = current.parent;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.parent;
      continue;
    }
    if (
      !ts.isBinaryExpression(current) &&
      !ts.isTemplateExpression(current) &&
      !ts.isParenthesizedExpression(current)
    ) {
      return false;
    }
    const folded = foldStaticString(current, context, new Set());
    if (folded?.includes('expense-app.workflow.')) return true;
    current = current.parent;
  }
  return false;
}

function collectDirectFindings(
  node: TypeScript.Node,
  context: ScanContext,
  findings: T3BoundaryFinding[],
): void {
  const { ts, sourceFile, file } = context;
  if (ts.isStringLiteral(node)) {
    recordDirectMatches(
      findings,
      file,
      node.getStart(sourceFile),
      node.getWidth(sourceFile),
      node.text,
      'string',
    );
    return;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    recordDirectMatches(
      findings,
      file,
      node.getStart(sourceFile),
      node.getWidth(sourceFile),
      node.text,
      'template',
    );
    return;
  }
  if (ts.isTemplateExpression(node)) {
    for (const fragment of [
      node.head,
      ...node.templateSpans.map((span) => span.literal),
    ]) {
      recordDirectMatches(
        findings,
        file,
        fragment.getStart(sourceFile),
        fragment.getWidth(sourceFile),
        fragment.text,
        'template',
      );
    }
  }
  if (
    (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) &&
    isOutermostStaticComposition(node, context) &&
    !hasDirectLiteralDescendant(node, context)
  ) {
    const folded = foldStaticString(node, context, new Set());
    if (folded !== null) {
      recordDirectMatches(
        findings,
        file,
        node.getStart(sourceFile),
        node.getWidth(sourceFile),
        folded,
        'folded',
      );
    }
  }
}

function recordDirectMatches(
  findings: T3BoundaryFinding[],
  file: string,
  start: number,
  length: number,
  text: string,
  sourceKind: 'string' | 'template' | 'folded',
): void {
  for (const match of text.matchAll(ROOT_WORKFLOW_JSON)) {
    const prefix = match[1] ?? '';
    const normalizedValue = match[2]!;
    findings.push({
      path: file,
      start: start + (match.index ?? 0) + prefix.length,
      length: normalizedValue.length,
      normalizedValue,
      syntaxForm:
        sourceKind === 'folded'
          ? 'folded'
          : sourceKind === 'template'
            ? 'template-static'
            : text === normalizedValue
              ? 'exact-string'
              : 'embedded-string',
    });
  }
}

function hasDirectLiteralDescendant(
  node: TypeScript.Node,
  context: ScanContext,
): boolean {
  const { ts } = context;
  let found = false;
  const visit = (candidate: TypeScript.Node): void => {
    if (candidate !== node) {
      if (
        (ts.isStringLiteral(candidate) ||
          ts.isNoSubstitutionTemplateLiteral(candidate)) &&
        directValues(candidate.text).length > 0
      ) {
        found = true;
        return;
      }
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function directValues(text: string): string[] {
  return [...text.matchAll(ROOT_WORKFLOW_JSON)].map((match) => match[2]!);
}

function isOutermostStaticComposition(
  node: TypeScript.Expression,
  context: ScanContext,
): boolean {
  if (foldStaticString(node, context, new Set()) === null) return false;
  const parent = node.parent;
  return !(
    (context.ts.isBinaryExpression(parent) ||
      context.ts.isTemplateExpression(parent) ||
      context.ts.isParenthesizedExpression(parent)) &&
    foldStaticString(parent, context, new Set()) !== null
  );
}

function provePath(
  expression: TypeScript.Expression,
  context: ScanContext,
  seen: Set<TypeScript.Node>,
): PathFact | null {
  const { ts } = context;
  const current = unwrapExpression(expression, ts);
  if (seen.has(current)) return null;
  seen.add(current);

  if (ts.isIdentifier(current)) {
    const binding = context.bindings.resolve(current);
    if (binding?.kind === 'const') {
      const resolved = provePath(binding.initializer, context, new Set(seen));
      if (resolved !== null) return resolved;
    }
    if (
      binding?.kind === 'repository-root' ||
      (binding === null && current.text === 'repositoryRoot')
    ) {
      return { kind: 'repository-root' };
    }
    return null;
  }
  if (
    ts.isPropertyAccessExpression(current) &&
    current.name.text === 'repositoryRoot'
  ) {
    return { kind: 'repository-root' };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression !== undefined &&
    ts.isStringLiteral(current.argumentExpression) &&
    current.argumentExpression.text === 'repositoryRoot'
  ) {
    return { kind: 'repository-root' };
  }
  if (!ts.isCallExpression(current) || current.arguments.length < 2) {
    return null;
  }

  const operation = resolvePathOperation(
    current.expression,
    context,
    new Set(seen),
  );
  if (operation === null) return null;
  const base = provePath(current.arguments[0]!, context, new Set(seen));
  const segments = current.arguments
    .slice(1)
    .map((argument) => foldStaticString(argument, context, new Set()));
  if (segments.some((segment) => segment === null)) return null;
  const exactSegments = segments as string[];

  if (
    base?.kind === 'repository-root' &&
    exactSegments.length === 1 &&
    exactSegments[0] === 'workflow'
  ) {
    return { kind: 'workflow-root' };
  }
  if (
    base?.kind === 'repository-root' &&
    exactSegments.length === 2 &&
    exactSegments[0] === 'workflow' &&
    isRootJsonFileName(exactSegments[1]!)
  ) {
    return {
      kind: 'workflow-json',
      normalizedValue: `workflow/${exactSegments[1]}`,
      operation,
    };
  }
  if (
    base?.kind === 'workflow-root' &&
    exactSegments.length === 1 &&
    isRootJsonFileName(exactSegments[0]!)
  ) {
    return {
      kind: 'workflow-json',
      normalizedValue: `workflow/${exactSegments[0]}`,
      operation,
    };
  }
  return null;
}

function isRootJsonFileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(value);
}

function resolvePathOperation(
  expression: TypeScript.Expression,
  context: ScanContext,
  seen: Set<TypeScript.Node>,
): 'join' | 'resolve' | null {
  const { ts } = context;
  const current = unwrapExpression(expression, ts);
  if (seen.has(current)) return null;
  seen.add(current);

  if (ts.isIdentifier(current)) {
    const binding = context.bindings.resolve(current);
    if (
      binding?.kind === 'module-member' &&
      binding.module === 'node:path' &&
      (binding.exported === 'join' || binding.exported === 'resolve')
    ) {
      return binding.exported;
    }
    if (binding?.kind === 'const') {
      return resolvePathOperation(binding.initializer, context, seen);
    }
    return null;
  }
  if (
    ts.isPropertyAccessExpression(current) &&
    (current.name.text === 'join' || current.name.text === 'resolve') &&
    isModuleObject(current.expression, 'node:path', context, seen)
  ) {
    return current.name.text;
  }
  return null;
}

function resolveFsOperation(
  expression: TypeScript.Expression,
  context: ScanContext,
  seen: Set<TypeScript.Node>,
): 'readdir' | 'readdirSync' | null {
  const { ts } = context;
  const current = unwrapExpression(expression, ts);
  if (seen.has(current)) return null;
  seen.add(current);

  if (ts.isIdentifier(current)) {
    const binding = context.bindings.resolve(current);
    if (
      binding?.kind === 'module-member' &&
      ((binding.module === 'node:fs' &&
        (binding.exported === 'readdir' ||
          binding.exported === 'readdirSync')) ||
        (binding.module === 'node:fs/promises' &&
          binding.exported === 'readdir'))
    ) {
      return binding.exported;
    }
    if (binding?.kind === 'const') {
      return resolveFsOperation(binding.initializer, context, seen);
    }
    return null;
  }
  if (
    ts.isPropertyAccessExpression(current) &&
    (current.name.text === 'readdir' || current.name.text === 'readdirSync')
  ) {
    if (isModuleObject(current.expression, 'node:fs', context, new Set(seen))) {
      return current.name.text;
    }
    if (
      current.name.text === 'readdir' &&
      isModuleObject(
        current.expression,
        'node:fs/promises',
        context,
        new Set(seen),
      )
    ) {
      return 'readdir';
    }
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'promises' &&
      isModuleObject(current.expression.expression, 'node:fs', context, seen)
    ) {
      return current.name.text === 'readdir' ? 'readdir' : null;
    }
  }
  return null;
}

function isModuleObject(
  expression: TypeScript.Expression,
  module: SupportedModule,
  context: ScanContext,
  seen: Set<TypeScript.Node>,
): boolean {
  const { ts } = context;
  const current = unwrapExpression(expression, ts);
  if (seen.has(current)) return false;
  seen.add(current);
  if (ts.isPropertyAccessExpression(current)) {
    if (
      module === 'node:fs/promises' &&
      current.name.text === 'promises' &&
      isModuleObject(current.expression, 'node:fs', context, new Set(seen))
    ) {
      return true;
    }
    if (
      module === 'node:path' &&
      (current.name.text === 'posix' || current.name.text === 'win32') &&
      isModuleObject(current.expression, 'node:path', context, new Set(seen))
    ) {
      return true;
    }
    return false;
  }
  if (!ts.isIdentifier(current)) return false;
  const binding = context.bindings.resolve(current);
  if (binding?.kind === 'module-object') return binding.module === module;
  return (
    binding?.kind === 'const' &&
    isModuleObject(binding.initializer, module, context, seen)
  );
}

function foldStaticString(
  expression: TypeScript.Expression,
  context: ScanContext,
  seen: Set<TypeScript.Node>,
): string | null {
  const { ts } = context;
  const current = unwrapExpression(expression, ts);
  if (seen.has(current)) return null;
  seen.add(current);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldStaticString(current.left, context, new Set(seen));
    const right = foldStaticString(current.right, context, new Set(seen));
    return left === null || right === null ? null : `${left}${right}`;
  }
  if (ts.isTemplateExpression(current)) {
    let result = current.head.text;
    for (const span of current.templateSpans) {
      const value = foldStaticString(span.expression, context, new Set(seen));
      if (value === null) return null;
      result += value + span.literal.text;
    }
    return result;
  }
  if (ts.isIdentifier(current)) {
    const binding = context.bindings.resolve(current);
    return binding?.kind === 'const'
      ? foldStaticString(binding.initializer, context, seen)
      : null;
  }
  return null;
}

function unwrapExpression(
  expression: TypeScript.Expression,
  ts: TypeScriptApi,
): TypeScript.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function createBindingIndex(
  ts: TypeScriptApi,
  sourceFile: TypeScript.SourceFile,
): BindingIndex {
  const scopes = new Map<TypeScript.Node, Map<string, Binding>>();
  const ensureScope = (owner: TypeScript.Node): Map<string, Binding> => {
    const existing = scopes.get(owner);
    if (existing) return existing;
    const created = new Map<string, Binding>();
    scopes.set(owner, created);
    return created;
  };
  const scopeFor = (node: TypeScript.Node): Map<string, Binding> => {
    let current: TypeScript.Node | undefined = node;
    while (current !== undefined && !isScopeNode(current, ts)) {
      current = current.parent;
    }
    const owner = current ?? sourceFile;
    return ensureScope(owner);
  };
  const functionScopeFor = (node: TypeScript.Node): Map<string, Binding> => {
    let current: TypeScript.Node | undefined = node;
    while (
      current !== undefined &&
      !ts.isSourceFile(current) &&
      !ts.isFunctionLike(current)
    ) {
      current = current.parent;
    }
    return ensureScope(current ?? sourceFile);
  };
  const register = (
    scope: Map<string, Binding>,
    name: string,
    binding: Binding,
  ): void => {
    scope.set(name, scope.has(name) ? { kind: 'opaque' } : binding);
  };

  const visit = (node: TypeScript.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause !== undefined
    ) {
      const module = normalizeModule(node.moduleSpecifier.text);
      if (module !== null) {
        const scope = scopeFor(node);
        if (node.importClause.name) {
          register(scope, node.importClause.name.text, {
            kind: 'module-object',
            module,
          });
        }
        const named = node.importClause.namedBindings;
        if (named && ts.isNamespaceImport(named)) {
          register(scope, named.name.text, { kind: 'module-object', module });
        } else if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const exported = (element.propertyName ?? element.name).text;
            register(
              scope,
              element.name.text,
              module === 'node:fs' && exported === 'promises'
                ? { kind: 'module-object', module: 'node:fs/promises' }
                : module === 'node:path' &&
                    (exported === 'posix' || exported === 'win32')
                  ? { kind: 'module-object', module: 'node:path' }
                  : { kind: 'module-member', module, exported },
            );
          }
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const immutable =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        node.initializer !== undefined;
      const blockScoped =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      const scope = blockScoped ? scopeFor(node) : functionScopeFor(node);
      const repositoryRoots = repositoryRootBindingNames(node.name, ts);
      for (const name of bindingNames(node.name, ts)) {
        register(
          scope,
          name,
          repositoryRoots.has(name)
            ? { kind: 'repository-root' }
            : immutable && ts.isIdentifier(node.name)
              ? { kind: 'const', initializer: node.initializer! }
              : { kind: 'opaque' },
        );
      }
    } else if (ts.isParameter(node)) {
      const repositoryRoots = repositoryRootBindingNames(node.name, ts);
      for (const name of bindingNames(node.name, ts)) {
        register(
          scopeFor(node),
          name,
          repositoryRoots.has(name) ||
            (ts.isIdentifier(node.name) && name === 'repositoryRoot')
            ? { kind: 'repository-root' }
            : { kind: 'opaque' },
        );
      }
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      register(scopeFor(node.parent), node.name.text, { kind: 'opaque' });
    }
    ts.forEachChild(node, visit);
  };
  scopes.set(sourceFile, new Map());
  visit(sourceFile);

  return {
    resolve(identifier): Binding | null {
      let current: TypeScript.Node | undefined = identifier.parent;
      while (current !== undefined) {
        const binding = scopes.get(current)?.get(identifier.text);
        if (binding !== undefined) return binding;
        current = current.parent;
      }
      return null;
    },
  };
}

function bindingNames(
  name: TypeScript.BindingName,
  ts: TypeScriptApi,
): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name, ts),
  );
}

function repositoryRootBindingNames(
  name: TypeScript.BindingName,
  ts: TypeScriptApi,
): Set<string> {
  const result = new Set<string>();
  if (!ts.isObjectBindingPattern(name)) return result;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const property = element.propertyName ?? element.name;
    if (
      (ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
      property.text === 'repositoryRoot'
    ) {
      result.add(element.name.text);
    }
  }
  return result;
}

function isScopeNode(node: TypeScript.Node, ts: TypeScriptApi): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isFunctionLike(node)
  );
}

function normalizeModule(value: string): SupportedModule | null {
  if (value === 'path' || value === 'node:path') return 'node:path';
  if (value === 'fs' || value === 'node:fs') return 'node:fs';
  if (value === 'fs/promises' || value === 'node:fs/promises') {
    return 'node:fs/promises';
  }
  return null;
}

function compareFindings(
  left: T3BoundaryFinding,
  right: T3BoundaryFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    left.start - right.start ||
    compareText(left.normalizedValue, right.normalizedValue) ||
    compareText(left.syntaxForm, right.syntaxForm)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
