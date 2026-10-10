import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const declarationFiles = ts.sys.readDirectory(
  sourceDirectory,
  [".d.ts"],
  ["**/._*"],
);
const javascriptFiles = ts.sys.readDirectory(
  sourceDirectory,
  [".js"],
  ["**/._*"],
);
const options = {
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
};

const declarations = ts.createProgram(declarationFiles, options);
const declarationChecker = declarations.getTypeChecker();
const host = ts.createCompilerHost(options);
// Resolve local JavaScript directly: ordinary TypeScript resolution substitutes
// adjacent declarations, which would compare the declarations with themselves.
host.resolveModuleNames = (names, containingFile) =>
  names.map((name) => {
    const file = path.resolve(path.dirname(containingFile), name);
    if (
      name.startsWith(".") &&
      name.endsWith(".js") &&
      ts.sys.fileExists(file)
    ) {
      return { resolvedFileName: file, extension: ts.Extension.Js };
    }
    return ts.resolveModuleName(name, containingFile, options, host)
      .resolvedModule;
  });
const javascript = ts.createProgram(javascriptFiles, options, host);
const javascriptChecker = javascript.getTypeChecker();
let errors = 0;

function exportsOf(program, checker, file) {
  const module = checker.getSymbolAtLocation(program.getSourceFile(file));
  return module ? checker.getExportsOfModule(module) : [];
}

function valueNames(checker, symbols) {
  return new Set(
    symbols
      .filter((symbol) => {
        if (symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) {
          return false;
        }
        const target =
          symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        return (target.flags & ts.SymbolFlags.Value) !== 0;
      })
      .map((symbol) => symbol.name),
  );
}

function report(file, message) {
  console.error(`${path.relative(sourceDirectory, file)}: ${message}`);
  errors++;
}

for (const file of declarationFiles) {
  const source = declarations.getSourceFile(file);
  const symbols = exportsOf(declarations, declarationChecker, file);
  if (
    valueNames(declarationChecker, symbols).size > 0 &&
    !javascript.getSourceFile(file.replace(/\.d\.ts$/, ".js"))
  ) {
    report(file, "Value exports have no JavaScript implementation.");
  }
  const exported = new Set(symbols);
  for (const statement of source.statements) {
    if (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export)
      continue;
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(
          (declaration) => declaration.name,
        )
      : statement.name
        ? [statement.name]
        : [];
    for (const name of names) {
      if (!ts.isIdentifier(name)) continue;
      const symbol = declarationChecker.getSymbolAtLocation(name);
      if (exported.has(symbol)) {
        report(
          file,
          `${name.text} is implicitly exported; preserve the private declaration with export {}.`,
        );
      }
    }
  }
}

for (const file of javascriptFiles) {
  const declarationFile = file.replace(/\.js$/, ".d.ts");
  if (!declarations.getSourceFile(declarationFile)) {
    report(file, "Missing adjacent declaration file.");
    continue;
  }
  const runtime = valueNames(
    javascriptChecker,
    exportsOf(javascript, javascriptChecker, file),
  );
  const declared = valueNames(
    declarationChecker,
    exportsOf(declarations, declarationChecker, declarationFile),
  );
  for (const name of runtime) {
    if (!declared.has(name))
      report(declarationFile, `Missing runtime export ${name}.`);
  }
  for (const name of declared) {
    if (!runtime.has(name))
      report(
        declarationFile,
        `Declared value ${name} has no JavaScript export.`,
      );
  }
}

if (errors > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `Checked explicit declaration exports and runtime value exports in ${declarationFiles.length} declaration files.`,
  );
}
