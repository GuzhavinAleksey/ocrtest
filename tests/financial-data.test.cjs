require("ts-node/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  validateConfig,
  parseExtraction,
  normalizePages,
  inventoryCodes,
  hash,
  stableJson,
  expectedColumns,
} = require("../src/financial-data");
const { saveReport } = require("../src/financial-store");
const { evaluate } = require("../src/evaluate");
const { fixture } = require("./fixtures/reports.cjs");
const normalized = (f) =>
  normalizePages(f.pages, f.config, hash("fixture pdf"), "mock-model");

test("two independent report layouts normalize dates, organization, units, names and provenance", () => {
  for (const f of [fixture(), fixture(2024, "beta", "units", 17)]) {
    const r = normalized(f);
    assert.equal(r.status, "ready", JSON.stringify(r.issues));
    assert(r.checks.length > 0);
    assert(r.checks.every((c) => c.status === "passed"));
    const fact = r.observations.find(
      (o) => o.code === "4500" && o.period_end === f.config.report_period.end,
    );
    assert.equal(fact.value, 305);
    assert.equal(fact.organization_id, f.config.organization.id);
    assert.equal(fact.name, "closing_cash_and_cash_equivalents");
    assert.equal(fact.period_start, f.config.report_period.start);
    assert.equal(fact.indicator_date, null);
    assert.equal(fact.currency, "RUB");
    assert.equal(fact.unit, f.config.unit);
    assert.equal(fact.multiplier, f.config.unit === "units" ? 1 : 1000);
    assert.equal(fact.provenance.page, f.pages[0].page);
    assert.equal(fact.provenance.raw_cell, "305");
    assert.equal(fact.provenance.document_hash, hash("fixture pdf"));
    assert.deepEqual(normalized(f), r);
  }
});

test("missing forms, rows and columns, unreadable inventories and duplicate facts block import", () => {
  const cases = [
    [(f) => f.config.expected_forms.push("0710001"), "missing_form"],
    [(f) => f.pages[0].indicators.shift(), "missing_row"],
    [(f) => f.pages[0].indicators[0].cells.pop(), "missing_cell"],
    [(f) => (f.pages[0].inventory_reliable = false), "unreliable_inventory"],
    [(f) => f.pages.push(structuredClone(f.pages[0])), "duplicate_fact"],
    [(f) => f.pages[0].expected_codes.shift(), "unexpected_row"],
    [
      (f) => delete f.config.profile.indicator_names["0710005:4111"],
      "unmapped_indicator",
    ],
  ];
  for (const [mutate, code] of cases) {
    const f = fixture();
    mutate(f);
    const r = normalized(f);
    assert.equal(r.status, "needs_review");
    assert(
      r.issues.some((i) => i.code === code),
      code,
    );
  }
});

test("reported zero, dash, not applicable and unreadable are distinct and raw cells are validated", () => {
  const cells = [
    { column: "2025", status: "reported", raw: "0", value: 0 },
    { column: "2024", status: "dash", raw: "—", value: null },
  ];
  const parse = (c) =>
    parseExtraction(
      JSON.stringify({ indicators: [{ code: "4110", cells: c }] }),
      ["4110"],
      ["2025", "2024"],
    );
  assert.deepEqual(parse(cells)[0].cells, cells);
  for (const status of ["not_applicable", "unreadable"])
    assert.equal(
      parse([
        {
          column: "2025",
          status,
          raw: status === "not_applicable" ? "X" : "",
          value: null,
        },
      ])[0].cells[0].status,
      status,
    );
  for (const c of [
    { ...cells[0], value: 1 },
    { ...cells[1], value: 0 },
    { ...cells[1], raw: "" },
    { ...cells[1], status: "not_applicable" },
    { ...cells[0], column: "unknown" },
  ])
    assert.throws(() => parse([c]));
  const f = fixture();
  f.pages[0].indicators[0].cells[0] = {
    column: "2025",
    status: "unreadable",
    raw: "?",
    value: null,
  };
  assert(normalized(f).issues.some((i) => i.code === "unreadable_cell"));
});

test("cash checks detect wrong totals, and do not silently substitute null for zero", () => {
  const f = fixture();
  Object.assign(f.pages[0].indicators.find((r) => r.code === "4500").cells[0], {
    raw: "999",
    value: 999,
  });
  const bad = normalized(f);
  assert(
    bad.checks.some((c) => c.rule === "closing_cash" && c.status === "failed"),
  );
  const g = fixture();
  Object.assign(g.pages[0].indicators.find((r) => r.code === "4113").cells[0], {
    status: "dash",
    raw: "-",
    value: null,
  });
  assert(
    normalized(g).checks.some(
      (c) => c.rule === "41_cash_receipts" && c.status === "uncheckable",
    ),
  );
  g.config.dash_is_zero = true;
  assert.equal(normalized(g).status, "ready");
});

test("independent text inventory is position independent and fails closed without a unique code header", () => {
  for (const dx of [0, 200]) {
    const items = [
      { str: "Код", x: 100 + dx, y: 20, width: 20 },
      { str: "показателя", x: 95 + dx, y: 27, width: 30 },
      { str: "4 1 1 0", x: 99 + dx, y: 40, width: 22 },
      { str: "4120", x: 100 + dx, y: 60, width: 20 },
      { str: "9999", x: 200 + dx, y: 60, width: 20 },
    ];
    assert.deepEqual(inventoryCodes(items), {
      codes: ["4110", "4120"],
      reliable: true,
    });
    assert.equal(inventoryCodes(items.slice(1)).reliable, false);
    assert.equal(
      inventoryCodes([...items, { str: "Код", x: 10, y: 5, width: 20 }])
        .reliable,
      false,
    );
  }
});

test("SQLite imports are transactional and idempotent; review data never becomes facts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "financial-store-"));
  const file = path.join(dir, "facts.sqlite");
  try {
    const r = normalized(fixture());
    assert.equal(saveReport(file, r).inserted, true);
    assert.deepEqual(saveReport(file, r), { inserted: false, facts: 0 });
    const changed = structuredClone(r);
    changed.observations[0].value = 999;
    assert.throws(() => saveReport(file, changed), /другой результат/);
    const f = fixture(2024, "beta", "units", 17);
    f.pages[0].indicators.shift();
    const review = normalized(f);
    saveReport(file, review);
    const db = new DatabaseSync(file);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM facts").get().n,
      r.observations.length,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("benchmark penalizes missing, wrong, extra and duplicate cells across two reports", () => {
  const truth = [
    ...normalized(fixture()).observations,
    ...normalized(fixture(2024, "beta", "units", 17)).observations,
  ];
  assert.equal(evaluate(truth, truth).cell_accuracy, 1);
  const prediction = structuredClone(truth);
  prediction.pop();
  prediction[0].value = 999;
  prediction.push({ ...truth[0], organization_id: "unexpected-company" });
  const result = evaluate(prediction, truth);
  assert.equal(result.missing_cells, 1);
  assert.equal(result.extra_cells, 1);
  assert.equal(result.correct_cells, truth.length - 2);
  assert(result.numeric_accuracy < 1);
  assert.throws(() => evaluate([], []));
  assert.throws(() => evaluate([...truth, truth[0]], truth));
});

test("configuration and identity validation prevent mixed profiles and unsupported periods", () => {
  const f = fixture();
  assert.deepEqual(validateConfig(f.config), f.config);
  for (const mutate of [
    (c) => (c.currency = "руб"),
    (c) => (c.organization.id = ""),
    (c) => (c.report_period.end = "2025-02-30"),
    (c) => (c.report_period.start = "2025-07-01"),
    (c) => (c.tolerance = -1),
    (c) => (c.ruleset = "unknown"),
  ]) {
    const c = structuredClone(f.config);
    mutate(c);
    assert.throws(() => validateConfig(c));
  }
  const a = normalized(f);
  f.config.profile.version = "2";
  assert.notEqual(normalized(f).run_id, a.run_id);
  assert.equal(stableJson({ a: 1, b: 2 }), stableJson({ b: 2, a: 1 }));
});

test("balance section sums and asset/liability equality catch inconsistent financial statements", () => {
  const { FORM_CODES } = require("../src/qwen");
  const f = fixture();
  f.config.expected_forms = ["0710001"];
  const amounts = {
    1110: 1,
    1130: 2,
    1140: 3,
    1150: 4,
    1160: 5,
    1170: 6,
    1180: 7,
    1190: 8,
    1100: 36,
    1210: 1,
    1215: 2,
    1220: 3,
    1230: 4,
    1240: 5,
    1250: 6,
    1260: 7,
    1200: 28,
    1600: 64,
    1310: 1,
    1320: -1,
    1350: 2,
    1360: 3,
    1370: 4,
    1300: 9,
    1410: 1,
    1420: 2,
    1430: 3,
    1450: 4,
    1400: 10,
    1510: 5,
    1520: 10,
    1540: 15,
    1550: 15,
    1500: 45,
    1700: 64,
  };
  f.pages = [
    {
      page: 8,
      form: "0710001",
      png: "balance.png",
      inventory_reliable: true,
      expected_codes: [...FORM_CODES["0710001"]],
      indicators: FORM_CODES["0710001"].map((code) => ({
        code,
        cells: ["2025", "2024", "2023"].map((column) => ({
          column,
          status: "reported",
          raw: String(amounts[code] || 0),
          value: amounts[code] || 0,
        })),
      })),
    },
  ];
  const result = normalized(f);
  assert.equal(result.status, "ready", JSON.stringify(result.issues));
  assert(result.checks.every((c) => c.status === "passed"));
  const assets = result.observations.find(
    (o) => o.code === "1600" && o.period_end === "2025-12-31",
  );
  assert.equal(assets.indicator_date, "2025-12-31");
  assert.equal(assets.period_start, null);
  Object.assign(f.pages[0].indicators.find((r) => r.code === "1700").cells[0], {
    raw: "1",
    value: 1,
  });
  assert(
    normalized(f).checks.some(
      (c) => c.rule === "balance_equality" && c.status === "failed",
    ),
  );
});

test("capital components, movement, relative dates and earnings-per-share units are normalized", () => {
  const { FORM_CODES } = require("../src/qwen");
  const f = fixture();
  f.config.expected_forms = ["0710004"];
  const components = expectedColumns("0710004", f.config);
  f.pages = [
    {
      page: 6,
      form: "0710004",
      png: "capital.png",
      inventory_reliable: true,
      expected_codes: [...FORM_CODES["0710004"]],
      indicators: FORM_CODES["0710004"].map((code) => ({
        code,
        cells: components.map((column) => ({
          column,
          status: "reported",
          raw: "0",
          value: 0,
        })),
      })),
    },
  ];
  const r = normalized(f);
  assert.equal(r.status, "ready", JSON.stringify(r.issues));
  assert.equal(
    r.observations.find((o) => o.code === "3100").indicator_date,
    "2023-12-31",
  );
  assert.equal(
    r.observations.find((o) => o.code === "3311").period_start,
    "2025-01-01",
  );
  assert.equal(
    r.observations.find((o) => o.code === "3211").period_start,
    "2024-01-01",
  );
  Object.assign(
    f.pages[0].indicators
      .find((r) => r.code === "3300")
      .cells.find((c) => c.column === "total"),
    { raw: "1", value: 1 },
  );
  assert(
    normalized(f).checks.some(
      (c) => c.rule === "capital_components_3300" && c.status === "failed",
    ),
  );
  assert(
    normalized(f).checks.some(
      (c) => c.rule === "capital_movement_3300_total" && c.status === "failed",
    ),
  );
  const eps = fixture();
  eps.config.expected_forms = ["0710002"];
  eps.pages = [
    {
      page: 7,
      form: "0710002",
      png: "eps.png",
      expected_codes: ["2900"],
      inventory_reliable: true,
      indicators: [
        {
          code: "2900",
          cells: [
            { column: "2025", status: "reported", raw: "0,48", value: 0.48 },
            {
              column: "2024",
              status: "reported",
              raw: "(45,47)",
              value: -45.47,
            },
          ],
        },
      ],
    },
  ];
  assert.equal(normalized(eps).observations[0].unit, "units");
  assert.equal(normalized(eps).observations[0].multiplier, 1);
});

test("profile expectations detect a missing continuation page even when the form header was found", () => {
  const f = fixture();
  f.pages[0].expected_codes = f.pages[0].expected_codes.filter(
    (c) => c !== "4500",
  );
  f.pages[0].indicators = f.pages[0].indicators.filter(
    (r) => r.code !== "4500",
  );
  assert(
    normalized(f).issues.some(
      (i) => i.code === "missing_template_row" && i.indicator === "4500",
    ),
  );
});

test("the same detailed code uses organization-specific names while source wording cannot rename a fact", () => {
  const a = fixture(),
    b = fixture(2024, "beta", "units", 17);
  a.config.profile.indicator_names["0710005:4111"] = "product_sales_receipts";
  b.config.profile.indicator_names["0710005:4111"] = "service_sales_receipts";
  a.pages[0].indicators.find((r) => r.code === "4111").source_name =
    "Совершенно другая формулировка";
  assert.equal(
    normalized(a).observations.find((o) => o.code === "4111").name,
    "product_sales_receipts",
  );
  assert.equal(
    normalized(b).observations.find((o) => o.code === "4111").name,
    "service_sales_receipts",
  );
});

test("cross-form controls detect cash/balance mismatches and incompatible units", () => {
  const { validateRelations } = require("../src/financial-data");
  const f = fixture();
  f.config.expected_forms = ["0710001", "0710005"];
  const cash = normalized(f).observations.find(
    (o) => o.code === "4500" && o.period_end === "2025-12-31",
  );
  const balance = {
    ...cash,
    id: "balance",
    form: "0710001",
    code: "1250",
    period_start: null,
    indicator_date: "2025-12-31",
  };
  let checks = validateRelations([cash, balance], f.config);
  assert.equal(
    checks.find((c) => c.rule === "cash_matches_balance").status,
    "passed",
  );
  balance.value = 99;
  assert.equal(
    validateRelations([cash, balance], f.config).find(
      (c) => c.rule === "cash_matches_balance",
    ).status,
    "failed",
  );
  balance.unit = "millions";
  assert.equal(
    validateRelations([cash, balance], f.config).find(
      (c) => c.rule === "cash_matches_balance",
    ).status,
    "uncheckable",
  );
});
