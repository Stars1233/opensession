import { describe, expect, it } from "bun:test";
import {
  CHECKS_REGISTER_WINDOW_MS,
  checksNeedRefresh,
  summarizeRollupCounts,
} from "./pr-check-summary";

describe("summarizeRollupCounts", () => {
  it("counts running check runs and statuses as pending", () => {
    expect(
      summarizeRollupCounts({
        totalCount: 7,
        checkRunCountsByState: [
          { state: "SUCCESS", count: 2 },
          { state: "IN_PROGRESS", count: 1 },
          { state: "QUEUED", count: 1 },
          { state: "SKIPPED", count: 1 },
        ],
        statusContextCountsByState: [
          { state: "PENDING", count: 1 },
          { state: "SUCCESS", count: 1 },
        ],
      }),
    ).toEqual({ total: 7, passed: 3, failed: 0, pending: 3 });
  });

  it("buckets failures like the detail pane and leaves cancelled neutral", () => {
    expect(
      summarizeRollupCounts({
        totalCount: 5,
        checkRunCountsByState: [
          { state: "FAILURE", count: 1 },
          { state: "TIMED_OUT", count: 1 },
          { state: "CANCELLED", count: 2 },
        ],
        statusContextCountsByState: [{ state: "ERROR", count: 1 }],
      }),
    ).toEqual({ total: 5, passed: 0, failed: 3, pending: 0 });
  });

  it("reads a commit without a rollup as no checks", () => {
    expect(summarizeRollupCounts(null)).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
    });
  });
});

describe("checksNeedRefresh", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const settled = {
    state: "OPEN",
    headRefOid: "abc",
    checksHead: "abc",
    checks: { total: 3, passed: 3, failed: 0, pending: 0 },
    updatedAt: "2026-09-29T11:59:00Z",
  };

  it("leaves settled counts for the current head alone", () => {
    expect(checksNeedRefresh(settled, { stale: false, now })).toBe(false);
  });

  it("re-asks when checks are running, the head moved, or a webhook poked it", () => {
    expect(
      checksNeedRefresh(
        { ...settled, checks: { ...settled.checks, pending: 1 } },
        { stale: false, now },
      ),
    ).toBe(true);
    expect(
      checksNeedRefresh(
        { ...settled, headRefOid: "def" },
        { stale: false, now },
      ),
    ).toBe(true);
    expect(
      checksNeedRefresh(
        { ...settled, checksHead: undefined },
        { stale: false, now },
      ),
    ).toBe(true);
    expect(checksNeedRefresh(settled, { stale: true, now })).toBe(true);
  });

  it("waits for CI to register on a new PR, then stops asking", () => {
    const empty = {
      ...settled,
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    };
    expect(checksNeedRefresh(empty, { stale: false, now })).toBe(true);
    expect(
      checksNeedRefresh(
        {
          ...empty,
          updatedAt: new Date(
            now - CHECKS_REGISTER_WINDOW_MS - 1,
          ).toISOString(),
        },
        { stale: false, now },
      ),
    ).toBe(false);
  });

  it("never asks about closed or merged PRs", () => {
    expect(
      checksNeedRefresh(
        { ...settled, state: "MERGED", checksHead: undefined },
        { stale: true, now },
      ),
    ).toBe(false);
  });
});
