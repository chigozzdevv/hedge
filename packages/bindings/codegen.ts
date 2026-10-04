import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import { generateBindings } from "./src/generate-bindings";
const root = fileURLToPath(new URL("../..", import.meta.url));
const registry: unknown = JSON.parse(
  await readFile(new URL("./contracts.json", import.meta.url), "utf8"),
);
const files = await generateBindings(registry, async (path, source) => {
  const artifactRoot = resolve(
    root,
    source === "v2" ? "packages/bindings/artifacts/v2" : "packages/foundry/out",
  );
  const target = resolve(artifactRoot, path),
    rel = relative(artifactRoot, target);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Artifact outside contracts output");
  return JSON.parse(await readFile(target, "utf8")) as unknown;
});
const output = fileURLToPath(new URL("./src/generated/", import.meta.url));
const current = await readdir(output).catch(() => [] as string[]);
if (process.argv.includes("--check")) {
  const names = [...files.keys()];
  if (current.length !== names.length || current.some((name) => !files.has(name)))
    throw new Error("Stale generated bindings; run npm run codegen");
  for (const [name, content] of files)
    if ((await readFile(resolve(output, name), "utf8")) !== content)
      throw new Error(`Stale binding: ${name}`);
} else {
  await mkdir(output, { recursive: true });
  for (const name of current)
    if (!files.has(name)) await rm(resolve(output, name), { recursive: true });
  for (const [name, content] of files) await writeFile(resolve(output, name), content);
}
