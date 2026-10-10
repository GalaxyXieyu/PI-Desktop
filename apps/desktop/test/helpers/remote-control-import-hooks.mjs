// Force workspace imports to this candidate, while reusing installed externals.
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve as resolveTs } from "./ts-import-hooks.mjs";
const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../..");
export async function resolve(specifier, context, next) {
  const match = /^@pi-desktop\/([^/]+)(.*)$/.exec(specifier);
  if (match) {
    const dir = resolvePath(root, "packages", match[1]);
    const pkg = JSON.parse(readFileSync(resolvePath(dir, "package.json"), "utf8"));
    const entry = pkg.exports?.[match[2] ? `.${match[2]}` : "."];
    const target = typeof entry === "string" ? entry : entry?.import ?? pkg.main;
    if (target) return { url: pathToFileURL(resolvePath(dir, target)).href, shortCircuit: true };
  }
  return resolveTs(specifier, context, next);
}
