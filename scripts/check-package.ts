import { mkdtemp, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractScenarios } from "../src/extract.ts";
import { fixtureRecords } from "../src/screenpipe.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (out) console.log(out.trim()); if (err) console.error(err.trim());
  if (code) throw new Error(`${command[0]} exited ${code}`);
}
await run(["bun", "pm", "pack"], root);
const directory = await mkdtemp(join(tmpdir(), "canary-package-consumer-"));
try {
  await copyFile(join(root, "canary-local-0.1.0.tgz"), join(directory, "canary-local-0.1.0.tgz"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "independent-canary-consumer", private: true, type: "module" }));
  await run(["bun", "add", "./canary-local-0.1.0.tgz"], directory);
  const fixture = await Bun.file(join(root, "fixtures/bob.json")).json();
  const alice = await Bun.file(join(root, "fixtures/alice.json")).json();
  const scenarios = [alice, ...extractScenarios(fixtureRecords(fixture), fixture.provenance).scenarios];
  const v1 = await Bun.file(join(root, "examples/v1.canary")).text();
  const v2 = await Bun.file(join(root, "examples/v2.canary")).text();
  const consumer = `import { compile, start, step, finish, testAll, MemoryAdapter } from '@canary/local';
import type { Scenario, ActionAdapter, RunState } from '@canary/local/contracts';
const scenarios: Scenario[] = ${JSON.stringify(scenarios)};
const adapter: ActionAdapter = new MemoryAdapter();
let state: RunState = await start(compile(${JSON.stringify(v2)}), scenarios[2], adapter);
state = await step(state, adapter);
const one = await finish(JSON.parse(JSON.stringify(state)), adapter);
if (!one.comparison.passed) throw new Error('Step/persistence consumer failed');
for (const [dsl, expected] of [[${JSON.stringify(v1)}, [0,0,4]], [${JSON.stringify(v2)}, [0,0,0]]] as const) {
  const results = await testAll(dsl, scenarios, new MemoryAdapter());
  const counts = results.map(r => r.comparison.differences.length);
  if (JSON.stringify(counts) !== JSON.stringify(expected)) throw new Error('Consumer regression');
  console.log('Independent installed package: ' + JSON.stringify(counts));
}
`;
  await writeFile(join(directory, "consumer.ts"), consumer);
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, allowImportingTsExtensions: true, types: [], lib: ["ES2022", "DOM"] }, include: ["consumer.ts"] }));
  await run([join(root, "node_modules/.bin/tsc"), "--noEmit"], directory);
  await run(["bun", "consumer.ts"], directory);
  console.log("Package installation, TypeScript contracts and execution verified in an independent project.");
} finally { await rm(directory, { recursive: true, force: true }); }
