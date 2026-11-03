// Два синтетических отчёта: разные организации, годы, единицы и расположение страниц.
// Это эталоны поведения программы, а не измерение точности живого OCR.
const { FORM_CODES } = require("../../src/qwen");
const base = require("../../config/gazprom-2025.json");
const amounts = {
  4110: 100,
  4111: 100,
  4120: -30,
  4121: -30,
  4100: 70,
  4210: 10,
  4211: 10,
  4220: -20,
  4221: -20,
  4200: -10,
  4310: 50,
  4311: 50,
  4320: -10,
  4323: -10,
  4300: 40,
  4400: 100,
  4450: 200,
  4490: 5,
  4500: 305,
};
function fixture(year = 2025, id = "alpha", unit = "thousands", page = 3) {
  const config = structuredClone(base);
  Object.assign(config, {
    organization: { id, name: `Company ${id}` },
    report_period: { start: `${year}-01-01`, end: `${year}-12-31` },
    unit,
    expected_forms: ["0710005"],
    profile: { ...config.profile, id: `${id}-profile` },
  });
  const codes = [...FORM_CODES["0710005"]];
  const indicators = codes.map((code) => ({
    code,
    source_name: `Вариант названия ${code}`,
    cells: [year, year - 1].map((y, i) => ({
      column: String(y),
      status: "reported",
      raw: String((amounts[code] || 0) * (i + 1)),
      value: (amounts[code] || 0) * (i + 1),
    })),
  }));
  return {
    config,
    pages: [
      {
        page,
        form: "0710005",
        png: `page-${page}.png`,
        expected_codes: codes,
        inventory_reliable: true,
        indicators,
      },
    ],
  };
}
module.exports = { fixture };
