require("ts-node/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const reportConfig = require("../config/gazprom-2025.json");
const {
  detectForm,
  extractStructuredPage,
  processPdf,
} = require("../src/qwen");

test("form detection includes continuations but excludes mentions in notes", () => {
  assert.equal(
    detectForm("Форма по ОКУД 0710001 Наименование показателя Код показателя"),
    "0710001",
  );
  assert.equal(
    detectForm(
      "Форма 0710005 с.3 Н а и м е н о в а н и е Код п о к а з а т е л я",
    ),
    "0710005",
  );
  assert.equal(detectForm("Пояснения к форме 0710001"), undefined);
  assert.equal(
    detectForm("Форма 0710003 Наименование Код показателя"),
    undefined,
  );
});

test("structured request sends image and independently inventoried codes; truncated responses fail", async () => {
  let request;
  const client = {
    chat: {
      completions: {
        create: async (input) => {
          request = input;
          return {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    indicators: [
                      {
                        code: "3300",
                        source_name: "На 31 декабря 2025",
                        cells: [
                          {
                            column: "total",
                            status: "reported",
                            raw: "123",
                            value: 123,
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };
  const rows = await extractStructuredPage(
    client,
    Buffer.from("image"),
    16,
    "0710004",
    ["3300"],
    reportConfig,
    "local-model",
  );
  assert.equal(request.model, "local-model");
  assert.match(
    request.messages[1].content[0].image_url.url,
    /^data:image\/png;base64,/,
  );
  assert.match(request.messages[1].content[1].text, /3300/);
  assert.equal(rows[0].cells[0].value, 123);
  client.chat.completions.create = async () => ({
    choices: [{ finish_reason: "length", message: { content: "{}" } }],
  });
  await assert.rejects(
    extractStructuredPage(
      client,
      Buffer.from("image"),
      16,
      "0710004",
      ["3300"],
      reportConfig,
      "model",
    ),
    /Незавершённый/,
  );
});

test("report.pdf converts only nine target form pages and writes a JSON manifest without API access", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocrtest-"));
  try {
    const result = await processPdf(
      path.resolve(__dirname, "../report.pdf"),
      dir,
      { convertOnly: true },
    );
    assert.deepEqual(
      result.pages.map((p) => [p.page, p.form]),
      [
        [11, "0710001"],
        [12, "0710001"],
        [13, "0710002"],
        [14, "0710002"],
        [15, "0710004"],
        [16, "0710004"],
        [17, "0710005"],
        [18, "0710005"],
        [19, "0710005"],
      ],
    );
    assert.equal(
      fs
        .readdirSync(path.dirname(path.join(dir, result.pages[0].png)))
        .filter((f) => f.endsWith(".png")).length,
      9,
    );
    assert(result.pages.every((p) => p.inventory_reliable));
    assert.equal(
      result.pages.reduce((n, p) => n + p.expected_codes.length, 0),
      198,
    );
    for (const page of result.pages) {
      const png = fs.readFileSync(path.join(dir, page.png));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert(png.length > 1000);
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
      result,
    );
    assert(!fs.existsSync(path.join(dir, "financials.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("complete pipeline writes extracted JSON using a mock API, with one request per selected page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocrtest-api-"));
  const calls = [];
  const { FORM_CODES } = require("../src/qwen");
  const client = {
    chat: {
      completions: {
        create: async (input) => {
          const prompt = input.messages[1].content[1].text;
          const [, page, form] = prompt.match(
            /Страница PDF (\d+), форма по ОКУД (\d+)/,
          );
          calls.push(Number(page));
          return {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    indicators: [
                      {
                        code: prompt.match(
                          /Извлеки ВСЕ строки с кодами (\d{4})/,
                        )[1],
                        source_name: "Тестовая строка API (не данные отчёта)",
                        cells: [
                          {
                            column: form === "0710004" ? "total" : "2025",
                            status: "reported",
                            raw: "(123 456)",
                            value: -123456,
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };
  try {
    const result = await processPdf(
      path.resolve(__dirname, "../report.pdf"),
      dir,
      {
        client,
        model: "mock-vision",
        config: reportConfig,
        databasePath: path.join(dir, "facts.sqlite"),
      },
    );
    assert.deepEqual(calls, [11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(result.status, "needs_review");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "facts.sqlite"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts").get().n, 0);
    assert.equal(
      db.prepare("SELECT status FROM runs").get().status,
      "needs_review",
    );
    db.close();
    assert(result.report.issues.some((i) => i.code === "missing_row"));
    assert(result.report.issues.some((i) => i.code === "missing_cell"));
    assert.equal(result.pages.length, 9);
    for (const row of result.report.observations)
      assert.equal(row.value, -123456);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, "financials.json"), "utf8")),
      result,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
