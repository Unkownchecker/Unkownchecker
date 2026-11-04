/**
 * Master Test Runner for LAN Print Suite (Milestone M1)
 * Executes Tiers 1 through 4 test suites sequentially, collects statistics,
 * and prints an authoritative pass/fail summary report.
 */

const { performance } = require("perf_hooks");
const tier1Suite = require("./tier1-features.test");
const tier2Suite = require("./tier2-boundary.test");
const tier3Suite = require("./tier3-cross-feature.test");
const tier4Suite = require("./tier4-scenarios.test");
const telemetrySuite = require("./telemetry.test");

async function runAllTiers() {
  console.log("==================================================================================");
  console.log("             LAN PRINT SUITE — MILESTONE M1 VERIFICATION TEST RUNNER             ");
  console.log("==================================================================================");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log("Running Tiers 1-4 & Milestone M7 Verification Suites...\n");

  const startTime = performance.now();
  const suites = [tier1Suite, tier2Suite, tier3Suite, tier4Suite, telemetrySuite];
  const summary = [];

  let grandTotal = 0;
  let grandPassed = 0;
  let grandFailed = 0;
  let grandSkipped = 0;
  const allErrors = [];

  for (const s of suites) {
    const res = await s.run();
    summary.push(res);
    grandTotal += res.total;
    grandPassed += res.passed;
    grandFailed += res.failed;
    grandSkipped += res.skipped;
    if (res.errors && res.errors.length > 0) {
      allErrors.push(...res.errors);
    }
  }

  const totalDuration = (performance.now() - startTime).toFixed(2);

  console.log("\n==================================================================================");
  console.log("                             FINAL EXECUTION SUMMARY                              ");
  console.log("==================================================================================");
  console.log(" Suite Name                                      Total   Pass   Fail   Skip   Duration ");
  console.log("----------------------------------------------------------------------------------");

  summary.forEach((s) => {
    const name = s.name.padEnd(46);
    const tot = String(s.total).padStart(6);
    const pass = `\x1b[32m${String(s.passed).padStart(6)}\x1b[0m`;
    const fail = s.failed > 0 ? `\x1b[31m${String(s.failed).padStart(6)}\x1b[0m` : String(s.failed).padStart(6);
    const skip = String(s.skipped).padStart(6);
    const dur = `${s.durationMs.toFixed(1)}ms`.padStart(9);
    console.log(` ${name} ${tot} ${pass} ${fail} ${skip}  ${dur}`);
  });

  console.log("----------------------------------------------------------------------------------");
  const passStr = grandPassed === grandTotal ? `\x1b[32m${grandPassed} / ${grandTotal} (100%)\x1b[0m` : `${grandPassed} / ${grandTotal}`;
  console.log(` TOTAL TESTS: ${grandTotal} | PASSED: ${passStr} | FAILED: ${grandFailed} | TIME: ${totalDuration}ms`);
  console.log("==================================================================================");

  if (grandFailed > 0) {
    console.error(`\x1b[31m✖ TEST RUN FAILED with ${grandFailed} failing test(s).\x1b[0m`);
    process.exit(1);
  } else {
    console.log("\x1b[32m✔ ALL TIERS PASSED 100% — TEST SUITE VERIFIED GREEN\x1b[0m\n");
    process.exit(0);
  }
}

if (require.main === module) {
  runAllTiers().catch((err) => {
    console.error("Fatal error running test suite:", err);
    process.exit(1);
  });
}

module.exports = { runAllTiers };
