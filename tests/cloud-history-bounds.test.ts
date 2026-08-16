import assert from "node:assert/strict";
import test from "node:test";
import * as cloudMarketData from "../server/lib/cloudMarketData.js";

test("bulk history limits reject values that could become an unbounded RPC", () => {
  const normalizeCloudHistoryLimit = (cloudMarketData as Record<string, unknown>).normalizeCloudHistoryLimit;
  assert.equal(typeof normalizeCloudHistoryLimit, "function");
  const normalize = normalizeCloudHistoryLimit as (value: number, maximum: number) => number;
  assert.equal(normalize(1, 512), 1);
  assert.equal(normalize(512, 512), 512);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 513, 1.5]) {
    assert.throws(
      () => normalize(value, 512),
      /history limit must be an integer between 1 and 512/,
    );
  }
});
