/**
 * Lightweight, robust test harness for LAN Print Suite
 * Provides clean describe/test syntax, async support, assertion helpers,
 * microsecond timing, and detailed failure diagnostics.
 */

const assert = require("assert");
const { performance } = require("perf_hooks");

class TestSuite {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.errors = [];
  }

  test(description, fn) {
    this.tests.push({ description, fn, isSkip: false });
  }

  skip(description, fn) {
    this.tests.push({ description, fn, isSkip: true });
  }

  async run() {
    console.log(`\n\x1b[1m\x1b[36m=== SUITE: ${this.name} ===\x1b[0m`);
    const suiteStart = performance.now();

    for (let i = 0; i < this.tests.length; i++) {
      const { description, fn, isSkip } = this.tests[i];
      if (isSkip) {
        console.log(`  \x1b[33m- [SKIP]\x1b[0m ${description}`);
        this.skipped++;
        continue;
      }

      const t0 = performance.now();
      try {
        await fn();
        const durationMs = (performance.now() - t0).toFixed(2);
        console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${description} \x1b[90m(${durationMs}ms)\x1b[0m`);
        this.passed++;
      } catch (err) {
        const durationMs = (performance.now() - t0).toFixed(2);
        console.log(`  \x1b[31m✖ [FAIL]\x1b[0m ${description} \x1b[90m(${durationMs}ms)\x1b[0m`);
        console.log(`    \x1b[31mError: ${err.message}\x1b[0m`);
        if (err.stack) {
          const stackLine = err.stack.split("\n")[1] || "";
          console.log(`    \x1b[90m${stackLine.trim()}\x1b[0m`);
        }
        this.failed++;
        this.errors.push({ description, error: err });
      }
    }

    const suiteDuration = (performance.now() - suiteStart).toFixed(2);
    console.log(
      `\x1b[1mSuite Summary:\x1b[0m Passed: \x1b[32m${this.passed}\x1b[0m | Failed: \x1b[31m${this.failed}\x1b[0m | Skipped: \x1b[33m${this.skipped}\x1b[0m \x1b[90m(${suiteDuration}ms)\x1b[0m`
    );

    return {
      name: this.name,
      total: this.tests.length,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      durationMs: parseFloat(suiteDuration),
      errors: this.errors
    };
  }
}

function createSuite(name) {
  return new TestSuite(name);
}

module.exports = {
  createSuite,
  assert
};
