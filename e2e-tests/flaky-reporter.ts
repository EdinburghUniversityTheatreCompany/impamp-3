import { appendFileSync } from "node:fs";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
} from "@playwright/test/reporter";

/**
 * Make retries visible.
 *
 * CI runs with `retries: 2`, so a test that fails and then passes is reported
 * as a pass and the run is green. That is the right default — a rerun is
 * cheaper than a red pipeline over a genuinely rare race — but it also means a
 * flake rate can climb from zero to routine without anything anywhere saying
 * so. It did: the conflict specs averaged roughly two attempts per run for
 * weeks, and the only trace was the wall-clock spacing between three lines of
 * log.
 *
 * So every flaky test is printed at the end of the run, and on GitHub it is
 * appended to the job summary, where it is visible without opening the HTML
 * report artifact.
 *
 * Reporting rather than failing, by default. A test that needed a retry is
 * information, not necessarily a regression, and a gate that turns the first
 * one red teaches people to raise `retries` instead. Set `E2E_FAIL_ON_FLAKE=1`
 * to make it a gate anyway — worth doing on a run whose whole purpose is to
 * establish that the suite is clean.
 */
export default class FlakyReporter implements Reporter {
  private root: Suite | undefined;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.root = suite;
  }

  async onEnd(
    result: FullResult,
  ): Promise<{ status: FullResult["status"] } | undefined> {
    const flaky = (this.root?.allTests() ?? []).filter(
      (test) => test.outcome() === "flaky",
    );

    if (flaky.length === 0) return undefined;

    const lines = flaky.map((test) => `${describe(test)} — ${attempts(test)}`);

    console.log(
      [
        "",
        `${flaky.length} test${flaky.length === 1 ? "" : "s"} passed only on a retry:`,
        ...lines.map((line) => `  ${line}`),
        "",
      ].join("\n"),
    );

    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        [
          `### ${flaky.length} flaky test${flaky.length === 1 ? "" : "s"}`,
          "",
          ...lines.map((line) => `- ${line}`),
          "",
        ].join("\n"),
      );
    }

    return process.env.E2E_FAIL_ON_FLAKE
      ? { status: "failed" }
      : { status: result.status };
  }
}

/** `file › describe › test`, which is how the HTML report names it too. */
function describe(test: TestCase): string {
  return test.titlePath().filter(Boolean).join(" › ");
}

function attempts(test: TestCase): string {
  const total = test.results.length;
  return `passed on attempt ${total} of ${total}`;
}
