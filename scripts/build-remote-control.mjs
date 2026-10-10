// Build only the desktop bridge's workspace dependency graph using the already
// installed toolchain. Workspace aliases must resolve here, not through a
// shared node_modules symlink into another checkout's stale dist outputs.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "apps/desktop/package.json"));
const ts = require("typescript");
const names = ["shared", "i18n", "plugin-sdk", "agent-runtime", "agent-host", "host-runtime", "voice-runtime", "racp"];
const paths = {};
for (const name of names) {
  const pkg = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), "utf8"));
  for (const [key, value] of Object.entries(pkg.exports ?? { ".": { types: pkg.types } })) {
    const target = typeof value === "string" ? value : value.types;
    if (target) paths[`@pi-desktop/${name}${key === "." ? "" : key.slice(1)}`] = [resolve(root, `packages/${name}`, target)];
  }
}
for (const name of names) {
  const configPath = resolve(root, `packages/${name}/tsconfig.json`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, paths });
  const result = program.emit();
  const errors = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  if (errors.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
    process.exit(1);
  }
  console.log(`built packages/${name}/dist`);
}
if (process.argv.includes("--check")) {
  const configPath = resolve(root, "apps/desktop/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, paths: { ...parsed.options.paths, ...paths }, noEmit: true });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
    process.exit(1);
  }
  console.log("desktop typecheck passed");
}
if (process.argv.includes("--desktop")) {
  const { build } = await import(pathToFileURL(require.resolve("electron-vite")).href);
  const alias = names.flatMap(name => {
    const pkg = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), "utf8"));
    return Object.entries(pkg.exports ?? {}).map(([key, entry]) => ({
      find: `@pi-desktop/${name}${key === "." ? "" : key.slice(1)}`,
      replacement: resolve(root, `packages/${name}`, typeof entry === "string" ? entry : entry.import ?? entry.default),
    }));
  }).sort((a, b) => b.find.length - a.find.length);
  for (const locale of readdirSync(resolve(root, "packages/i18n/dist/locales"))) {
    alias.unshift({ find: `@pi-desktop/i18n/locales/${locale}`, replacement: resolve(root, `packages/i18n/dist/locales/${locale}/index.js`) });
  }
  process.chdir(resolve(root, "apps/desktop"));
  await build({ resolve: { alias } });
}
