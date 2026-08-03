import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { enrichRealtimeMarketStats } from "../server/lib/marketStatsEnrichment";

const realtime = {
  index: 43_386.41,
  change: 266.66,
  changePercent: 0.62,
  date: "2026-08-03",
};

test("MIS success path enriches both dashboard market cards", async () => {
  const services = await readFile(new URL("../server/services.ts", import.meta.url), "utf8");
  assert.match(services, /enrichRealtimeMarketStats\("TWSE",/);
  assert.match(services, /enrichRealtimeMarketStats\("TPEX",/);
});

test("TWSE realtime index is enriched with official amount and breadth", async () => {
  const result = await enrichRealtimeMarketStats("TWSE", realtime, {
    fetchJson: async (url) => {
      if (url.includes("MI_INDEX")) {
        return {
          tables: [{
            title: "每日收盤行情(全部)",
            data: [
              ["2330", "台積電", "", "", "", "", "", "", "1000", "+", "10"],
              ["2317", "鴻海", "", "", "", "", "", "", "95", "-", "5"],
              ["0050", "元大台灣50", "", "", "", "", "", "", "200", "+", "5"],
            ],
          }],
        };
      }
      return { data: [["115/08/03", "", "885,506,043,091"]] };
    },
  });

  assert.equal(result.amount, 8_855.06);
  assert.deepEqual(
    { limitUp: result.limitUp, up: result.up, flat: result.flat, down: result.down, limitDown: result.limitDown },
    { limitUp: 0, up: 1, flat: 0, down: 1, limitDown: 0 },
  );
});

test("TPEX realtime index is enriched and excludes non-ordinary securities", async () => {
  const result = await enrichRealtimeMarketStats("TPEX", { ...realtime, index: 362.89 }, {
    fetchJson: async (url) => {
      if (url.includes("daily_trading_index")) {
        return { tables: [{ data: [["115/08/03", "", "132,226,012", "", 362.89, 15.04]] }] };
      }
      return {
        tables: [{ data: [
          ["6488", "環球晶", "495", "45"],
          ["3293", "鈊象", "900", "0"],
          ["8069", "元太", "180", "-20"],
          ["00679B", "元大美債", "30", "1"],
        ] }],
      };
    },
  });

  assert.equal(result.amount, 1_322.26);
  assert.deepEqual(
    { limitUp: result.limitUp, up: result.up, flat: result.flat, down: result.down, limitDown: result.limitDown },
    { limitUp: 1, up: 0, flat: 1, down: 0, limitDown: 1 },
  );
});

test("database fallback only fills an unavailable official supplement", async () => {
  const result = await enrichRealtimeMarketStats("TWSE", realtime, {
    fetchJson: async () => { throw new Error("official unavailable"); },
    loadFallback: () => ({
      amount: 123.45,
      limitUp: 2,
      up: 3,
      flat: 4,
      down: 5,
      limitDown: 6,
    }),
  });

  assert.equal(result.amount, 123.45);
  assert.equal(result.up, 3);
  assert.equal(result.down, 5);
});
