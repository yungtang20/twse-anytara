import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { isLegacyFrameworkId } from "../server/lib/legacyFrameworkAnalysis";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

test("legacy framework IDs require primitive strings", () => {
  assert.equal(isLegacyFrameworkId("bridgewater"), true);
  assert.equal(isLegacyFrameworkId(["bridgewater"] as unknown as string), false);
});

type ModuleEdge = {
  kind: "import" | "export";
  specifier: string;
  target: string | null;
};

type ParsedModule = {
  edges: ModuleEdge[];
  importedLocalBindings: Map<string, Set<string>>;
  localNamedExports: Set<string>;
};

type ModuleGraph = ReadonlyMap<string, readonly string[]>;

function normalizeWorkspacePath(absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
}

function resolveLocalModule(
  fromFile: string,
  specifier: string,
  isFile: (candidate: string) => boolean = (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(workspaceRoot, path.dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx"), base];
  const resolved = candidates.find(isFile) ?? `${base}.ts`;
  return normalizeWorkspacePath(resolved);
}

test("local module resolver finds index.tsx modules", () => {
  const onlyFile = path.resolve(workspaceRoot, "synthetic/helper/index.tsx");
  assert.equal(
    resolveLocalModule("synthetic/consumer.ts", "./helper", (candidate) => candidate === onlyFile),
    "synthetic/helper/index.tsx",
  );
});

function parseModuleSource(
  file: string,
  sourceText: string,
  resolveModule: (specifier: string) => string | null = (specifier) => resolveLocalModule(file, specifier),
): ParsedModule {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ModuleEdge[] = [];
  const importedLocalBindings = new Map<string, Set<string>>();
  const localNamedExports = new Set<string>();

  const recordImportedBinding = (target: string | null, localName: string) => {
    if (!target) return;
    const bindings = importedLocalBindings.get(target) ?? new Set<string>();
    bindings.add(localName);
    importedLocalBindings.set(target, bindings);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const target = resolveModule(specifier);
      edges.push({ kind: "import", specifier, target });
      const imports = statement.importClause;
      if (imports?.name) recordImportedBinding(target, imports.name.text);
      if (imports?.namedBindings && ts.isNamedImports(imports.namedBindings)) {
        for (const element of imports.namedBindings.elements) recordImportedBinding(target, element.name.text);
      } else if (imports?.namedBindings && ts.isNamespaceImport(imports.namedBindings)) {
        recordImportedBinding(target, imports.namedBindings.name.text);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        edges.push({ kind: "export", specifier, target: resolveModule(specifier) });
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          localNamedExports.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }
  return { edges, importedLocalBindings, localNamedExports };
}

async function readWorkspaceModule(file: string): Promise<ParsedModule> {
  const sourceText = await readFile(path.join(workspaceRoot, file), "utf8");
  return parseModuleSource(file, sourceText);
}

function locallyReexportedBindings(parsed: ParsedModule, importedFrom: string): string[] {
  const imported = parsed.importedLocalBindings.get(importedFrom) ?? new Set<string>();
  return [...imported].filter((binding) => parsed.localNamedExports.has(binding)).sort();
}

function moduleEdgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function findModulePath(
  graph: ModuleGraph,
  start: string,
  target: string,
  ignoredEdges: ReadonlySet<string> = new Set(),
): string[] | null {
  const pending: string[][] = [[start]];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentPath = pending.shift()!;
    const current = currentPath.at(-1)!;
    if (current === target) return currentPath;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of graph.get(current) ?? []) {
      if (!ignoredEdges.has(moduleEdgeKey(current, next))) pending.push([...currentPath, next]);
    }
  }
  return null;
}

async function buildLocalModuleGraph(roots: string[]): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  const pending = [...roots];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (graph.has(current) || !existsSync(path.join(workspaceRoot, current))) continue;
    const parsed = await readWorkspaceModule(current);
    const targets = [...new Set(parsed.edges
      .map((edge) => edge.target)
      .filter((target): target is string => Boolean(target) && existsSync(path.join(workspaceRoot, target!))))];
    graph.set(current, targets);
    pending.push(...targets);
  }
  return graph;
}

test("analysis consumer reachability detects non-allowlisted helper paths to the route", () => {
  const graph = new Map<string, string[]>([
    ["consumer.ts", ["api-router.ts", "helper.ts"]],
    ["api-router.ts", ["server/mvpMcpRoutes.ts"]],
    ["helper.ts", ["server/mvpMcpRoutes.ts"]],
  ]);
  const allowedApiProbeEdge = new Set([moduleEdgeKey("consumer.ts", "api-router.ts")]);
  assert.deepEqual(
    findModulePath(graph, "consumer.ts", "server/mvpMcpRoutes.ts", allowedApiProbeEdge),
    ["consumer.ts", "helper.ts", "server/mvpMcpRoutes.ts"],
  );
});

test("module parsing detects locally re-exported legacy imports", () => {
  const legacyModule = "server/lib/legacyFrameworkAnalysis.ts";
  const parsed = parseModuleSource(
    "server/mvpMcpRoutes.ts",
    `import { runFrameworkAnalysis as analyze } from "./lib/legacyFrameworkAnalysis";\nexport { analyze };`,
    (specifier) => specifier === "./lib/legacyFrameworkAnalysis" ? legacyModule : null,
  );
  assert.deepEqual(locallyReexportedBindings(parsed, legacyModule), ["analyze"]);
});

test("legacy framework analysis keeps a one-way dependency seam", async () => {
  const violations = new Set<string>();
  const legacyModule = "server/lib/legacyFrameworkAnalysis.ts";
  const routeModule = "server/mvpMcpRoutes.ts";
  const consumers = [
    { file: "server/lib/jobQueue.ts", label: "jobQueue" },
    { file: "server/routes/fundamentals.ts", label: "fundamentals" },
    { file: "scripts/verifyCloudData.ts", label: "verifyCloudData" },
  ];
  const graph = await buildLocalModuleGraph(consumers.map(({ file }) => file));
  const ignoredEdges = new Set([
    // This is the API-probe path, not an analysis-capability import; analysisTdcc legitimately owns HTTP handlers.
    // All other local edges remain traversable, so a helper that reaches the route is still a seam violation.
    moduleEdgeKey("scripts/verifyCloudData.ts", "server/routes.ts"),
  ]);
  for (const consumer of consumers) {
    const routePath = findModulePath(graph, consumer.file, routeModule, ignoredEdges);
    if (routePath) violations.add(`${consumer.label} reaches the HTTP route module: ${routePath.join(" -> ")}`);
  }

  if (!existsSync(path.join(workspaceRoot, legacyModule))) {
    violations.add("legacy analysis module is missing");
  } else {
    for (const edge of (await readWorkspaceModule(legacyModule)).edges) {
      if (
        edge.specifier === "express"
        || edge.specifier === "better-sqlite3"
        || edge.target === routeModule
        || edge.target === "server/lib/jobQueue.ts"
        || edge.target === "server/db.ts"
        || edge.target?.startsWith("server/routes/")
      ) {
        violations.add(`legacy analysis has forbidden dependency: ${edge.specifier}`);
      }
    }
  }

  const parsedRoute = await readWorkspaceModule(routeModule);
  for (const edge of parsedRoute.edges) {
    if (edge.kind === "export" && edge.target === legacyModule) {
      violations.add("HTTP route module re-exports the analysis interface");
    }
  }
  const localReexports = locallyReexportedBindings(parsedRoute, legacyModule);
  if (localReexports.length > 0) {
    violations.add(`HTTP route module locally re-exports analysis bindings: ${localReexports.join(", ")}`);
  }

  assert.deepEqual([...violations].sort(), []);
});
