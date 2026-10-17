import { MemoryAdapter, testAll, type Scenario, type RecordingFixture } from "../src/index.ts";
import { fixtureRecords } from "../src/screenpipe.ts";
import { extractScenarios } from "../src/extract.ts";
const root = new URL("../", import.meta.url);
const fixture: RecordingFixture = await Bun.file(new URL("fixtures/bob.json", root)).json();
const alice: Scenario = await Bun.file(new URL("fixtures/alice.json", root)).json();
const scenarios = [alice, ...extractScenarios(fixtureRecords(fixture), fixture.provenance).scenarios];
console.log("DÉMO FICTIVE · adaptateur en mémoire · aucune capture Screenpipe, aucun envoi réseau");
for (const version of ["v1", "v2"]) {
  const source = await Bun.file(new URL(`examples/${version}.canary`, root)).text();
  const results = await testAll(source, scenarios, new MemoryAdapter());
  for (const { state, comparison } of results) console.log(`${version} · ${state.scenario.title} : ${comparison.differences.length} écart(s) · ${state.status}`);
  console.log(`${version} : ${results.filter(r => r.comparison.passed).length}/${results.length} passent`);
}
