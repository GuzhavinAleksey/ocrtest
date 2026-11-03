import { createHash } from "node:crypto";
import { INDICATOR_NAMES } from "./indicator-names";

export const PIPELINE_VERSION = "2.0.0";
export const CAPITAL_COMPONENTS = [
  "share_capital",
  "treasury_shares",
  "revaluation_surplus",
  "additional_paid_in_capital",
  "reserve_capital",
  "retained_earnings",
  "total",
] as const;
export type CellStatus = "reported" | "dash" | "not_applicable" | "unreadable";
export interface ReportConfig {
  organization: { id: string; name: string };
  report_period: { start: string; end: string };
  currency: string;
  unit: "units" | "thousands" | "millions";
  expected_forms: string[];
  profile: {
    id: string;
    version: string;
    indicator_names?: Record<string, string>;
    expected_codes?: Record<string, string[]>;
  };
  ruleset: "ras_2025";
  tolerance?: number;
  // Только явное решение владельца данных: трактовать прочерк как ноль при сверке.
  dash_is_zero?: boolean;
}
export interface ExtractedCell {
  column: string;
  status: CellStatus;
  raw: string;
  value: number | null;
}
export interface ExtractedRow {
  code: string;
  source_name?: string;
  cells: ExtractedCell[];
}
export interface Issue {
  code: string;
  severity: "error" | "warning";
  message: string;
  page?: number;
  form?: string;
  indicator?: string;
}
export interface PageEvidence {
  page: number;
  form: string;
  png: string;
  expected_codes: string[];
  inventory_reliable: boolean;
  indicators: ExtractedRow[];
}
export interface Observation {
  id: string;
  logical_key: string;
  organization_id: string;
  organization_name: string;
  form: string;
  code: string;
  name: string;
  report_period_start: string;
  report_period_end: string;
  period_start: string | null;
  period_end: string;
  indicator_date: string | null;
  currency: string;
  unit: string;
  multiplier: number;
  capital_component: string | null;
  value: number | null;
  status: CellStatus;
  provenance: {
    document_hash: string;
    page: number;
    png: string;
    source_name: string | null;
    raw_cell: string;
    source_column: string;
    model: string;
    pipeline_version: string;
    profile_id: string;
    profile_version: string;
    run_id: string;
  };
}
export interface CheckResult {
  rule: string;
  period: string;
  status: "passed" | "failed" | "uncheckable";
  actual?: number;
  expected?: number;
  reason?: string;
}
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function stableJson(value: unknown): string {
  const result = JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
  if (result === undefined)
    throw new Error("Значение нельзя сериализовать в JSON");
  return result;
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validateConfig(input: unknown): ReportConfig {
  const c = input as ReportConfig;
  if (!c?.organization?.id?.trim() || !c.organization.name?.trim())
    throw new Error("Нужны organization.id и organization.name");
  if (
    !validDate(c.report_period?.start) ||
    !validDate(c.report_period?.end) ||
    c.report_period.start > c.report_period.end
  )
    throw new Error("Неверный отчётный период");
  // Схема ниже соответствует годовым формам; промежуточные отчёты требуют отдельного профиля периодов.
  const year = c.report_period.end.slice(0, 4);
  if (
    c.report_period.start !== `${year}-01-01` ||
    c.report_period.end !== `${year}-12-31`
  )
    throw new Error("Поддерживаются годовые отчёты за календарный год");
  if (
    !/^[A-Z]{3}$/.test(c.currency) ||
    !["units", "thousands", "millions"].includes(c.unit)
  )
    throw new Error("Укажите currency ISO 4217 и unit");
  if (
    !Array.isArray(c.expected_forms) ||
    !c.expected_forms.length ||
    new Set(c.expected_forms).size !== c.expected_forms.length ||
    c.expected_forms.some(
      (f) => !["0710001", "0710002", "0710004", "0710005"].includes(f),
    )
  )
    throw new Error("Неверный expected_forms");
  if (!c.profile?.id?.trim() || !c.profile.version?.trim())
    throw new Error("Нужны profile.id и profile.version");
  if (c.ruleset !== "ras_2025")
    throw new Error("Нужен поддерживаемый ruleset: ras_2025");
  if (
    c.tolerance !== undefined &&
    (!Number.isFinite(c.tolerance) || c.tolerance < 0)
  )
    throw new Error("Неверный tolerance");
  if (c.dash_is_zero !== undefined && typeof c.dash_is_zero !== "boolean")
    throw new Error("dash_is_zero должен быть boolean");
  if (
    c.profile.indicator_names &&
    Object.entries(c.profile.indicator_names).some(
      ([k, v]) =>
        !/^071000[1245]:\d{4}$/.test(k) ||
        typeof v !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(v),
    )
  )
    throw new Error("Ключи indicator_names: форма:код, значения: snake_case");
  if (
    c.profile.expected_codes &&
    Object.entries(c.profile.expected_codes).some(
      ([form, codes]) =>
        !["0710001", "0710002", "0710004", "0710005"].includes(form) ||
        !Array.isArray(codes) ||
        !codes.length ||
        new Set(codes).size !== codes.length ||
        codes.some((code) => typeof code !== "string" || !/^\d{4}$/.test(code)),
    )
  )
    throw new Error("Неверный список ожидаемых кодов профиля");
  return c;
}
export function expectedColumns(form: string, config: ReportConfig): string[] {
  if (form === "0710004") return [...CAPITAL_COMPONENTS];
  const year = Number(config.report_period.end.slice(0, 4));
  return Array.from({ length: form === "0710001" ? 3 : 2 }, (_, i) =>
    String(year - i),
  );
}
export function numericValue(raw: string): number {
  const s = raw
    .trim()
    .replace(/\s/g, "")
    .replace(/−/g, "-")
    .replace(/^\((.+)\)$/, "-$1")
    .replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(s))
    throw new Error(`Неверная числовая ячейка: ${raw}`);
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    throw new Error("Число вне безопасного диапазона");
  return n;
}
export function parseExtraction(
  answer: string,
  allowedCodes: string[],
  columns: string[],
): ExtractedRow[] {
  const parsed = JSON.parse(
    answer
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, ""),
  );
  if (!parsed || !Array.isArray(parsed.indicators))
    throw new Error("Ожидается массив indicators");
  const seen = new Set<string>();
  return parsed.indicators.map((row: unknown) => {
    const r = row as ExtractedRow;
    if (
      !r ||
      typeof r.code !== "string" ||
      !/^\d{4}$/.test(r.code) ||
      !allowedCodes.includes(r.code) ||
      seen.has(r.code) ||
      !Array.isArray(r.cells)
    )
      throw new Error("Неизвестная/повторная строка или отсутствует cells");
    seen.add(r.code);
    const used = new Set<string>();
    const cells = r.cells.map((c) => {
      if (
        !c ||
        !columns.includes(c.column) ||
        used.has(c.column) ||
        !["reported", "dash", "not_applicable", "unreadable"].includes(
          c.status,
        ) ||
        typeof c.raw !== "string"
      )
        throw new Error(`Некорректная ячейка ${r.code}`);
      used.add(c.column);
      if (c.status === "reported") {
        const value = numericValue(c.raw);
        if (typeof c.value !== "number" || c.value !== value)
          throw new Error(`Число не соответствует исходной ячейке ${r.code}`);
      } else {
        if (c.value !== null)
          throw new Error("Для пропуска значение должно быть null");
        if (c.status === "dash" && !/^\s*[-—–]\s*$/.test(c.raw))
          throw new Error("Статус dash требует прочерк");
        if (
          c.status === "not_applicable" &&
          !/^(?:[xх×]|n\/a|не применимо)$/i.test(c.raw.trim())
        )
          throw new Error(
            "not_applicable требует явной отметки, а не пустой ячейки",
          );
      }
      return { column: c.column, status: c.status, raw: c.raw, value: c.value };
    });
    return {
      code: r.code,
      ...(typeof r.source_name === "string"
        ? { source_name: r.source_name }
        : {}),
      cells,
    };
  });
}

// Независимый от модели инвентарь строк по геометрии текстового слоя.
export function inventoryCodes(
  items: { str: string; x: number; y: number; width: number }[],
): { codes: string[]; reliable: boolean } {
  const headers = items.filter(
    (i) => i.str.replace(/\s/g, "").toLowerCase() === "код",
  );
  if (headers.length !== 1) return { codes: [], reliable: false };
  const header = headers[0];
  const center = header.x + header.width / 2;
  const candidates = items.filter(
    (i) =>
      i.y > header.y + 3 &&
      Math.abs(i.x + i.width / 2 - center) <= Math.max(14, header.width),
  );
  const codes = candidates
    .map((i) => i.str.replace(/\s/g, ""))
    .filter((s) => /^\d{4}$/.test(s));
  // Любая другая непустая запись в колонке ниже заголовка делает инвентарь сомнительным.
  const suspicious = candidates.some((i) => {
    const s = i.str.replace(/\s/g, "").toLowerCase();
    return s && s !== "показателя" && !/^\d{4}$/.test(s);
  });
  return {
    codes: [...new Set(codes)],
    reliable:
      codes.length > 0 && !suspicious && new Set(codes).size === codes.length,
  };
}
function standardName(
  form: string,
  code: string,
  config: ReportConfig,
): string | undefined {
  const override = config.profile.indicator_names?.[`${form}:${code}`];
  if (override) return override;
  // Детализация баланса/результатов/потоков организационно-зависима.
  const detail = form !== "0710004" && !code.endsWith("0");
  return detail ? undefined : INDICATOR_NAMES[code];
}
function periods(
  form: string,
  code: string,
  column: string,
  config: ReportConfig,
) {
  const reportYear = Number(config.report_period.end.slice(0, 4));
  let year = Number(column);
  if (form === "0710004")
    year =
      reportYear -
      (["3100", "3101", "3110", "3120"].includes(code)
        ? 2
        : [
              "3200",
              "3201",
              "3210",
              "3220",
              "3250",
              "3211",
              "3212",
              "3227",
              "3230",
              "3231",
              "3232",
              "3233",
              "3234",
              "3235",
              "3239",
              "3216",
              "3240",
              "3245",
              "3249",
            ].includes(code)
          ? 1
          : 0);
  const date = `${year}-12-31`;
  const point =
    form === "0710001" ||
    (form === "0710004" &&
      ["3100", "3101", "3200", "3201", "3250", "3300"].includes(code));
  return {
    period_start: point ? null : `${year}-01-01`,
    period_end: date,
    indicator_date: point ? date : null,
  };
}
export function normalizePages(
  pages: PageEvidence[],
  config: ReportConfig,
  documentHash: string,
  model: string,
) {
  validateConfig(config);
  for (const page of pages)
    parseExtraction(
      JSON.stringify({ indicators: page.indicators }),
      [
        ...new Set([
          ...page.expected_codes,
          ...page.indicators.map((r) => r.code),
        ]),
      ],
      expectedColumns(page.form, config),
    );
  const runId = hash(
    stableJson({ documentHash, config, model, version: PIPELINE_VERSION }),
  );
  const issues: Issue[] = [];
  const observations: Observation[] = [];
  const seen = new Set<string>();
  for (const form of config.expected_forms)
    if (!pages.some((p) => p.form === form))
      issues.push({
        code: "missing_form",
        severity: "error",
        form,
        message: "Ожидаемая форма не найдена",
      });
  for (const form of config.expected_forms) {
    const expected = config.profile.expected_codes?.[form] || [];
    const inventory = new Set(
      pages.filter((p) => p.form === form).flatMap((p) => p.expected_codes),
    );
    for (const code of expected)
      if (!inventory.has(code))
        issues.push({
          code: "missing_template_row",
          severity: "error",
          form,
          indicator: code,
          message:
            "Ожидаемая строка профиля отсутствует в инвентаре документа; возможна потеря страницы",
        });
  }
  for (const page of pages) {
    const columns = expectedColumns(page.form, config);
    if (!page.inventory_reliable)
      issues.push({
        code: "unreliable_inventory",
        severity: "error",
        page: page.page,
        form: page.form,
        message: "Нельзя подтвердить полный список строк независимо от модели",
      });
    const returned = new Set(page.indicators.map((r) => r.code));
    for (const code of page.expected_codes)
      if (!returned.has(code))
        issues.push({
          code: "missing_row",
          severity: "error",
          page: page.page,
          indicator: code,
          message: "Модель пропустила строку из текстового слоя",
        });
    for (const row of page.indicators) {
      if (!page.expected_codes.includes(row.code))
        issues.push({
          code: "unexpected_row",
          severity: "error",
          page: page.page,
          indicator: row.code,
          message: "Строка не подтверждена инвентарём страницы",
        });
      const name = standardName(page.form, row.code, config);
      if (!name)
        issues.push({
          code: "unmapped_indicator",
          severity: "error",
          page: page.page,
          indicator: row.code,
          message: "Требуется профиль организации/версии формы для этого кода",
        });
      for (const column of columns)
        if (!row.cells.some((c) => c.column === column))
          issues.push({
            code: "missing_cell",
            severity: "error",
            page: page.page,
            indicator: row.code,
            message: `Отсутствует столбец ${column}`,
          });
      for (const cell of row.cells) {
        if (cell.status === "unreadable")
          issues.push({
            code: "unreadable_cell",
            severity: "error",
            page: page.page,
            indicator: row.code,
            message: `Нечитаемая ячейка ${cell.column}`,
          });
        const period = periods(page.form, row.code, cell.column, config);
        const perShare =
          page.form === "0710002" && ["2900", "2910"].includes(row.code);
        const unit = perShare ? "units" : config.unit;
        const component = page.form === "0710004" ? cell.column : null;
        const logicalKey = hash(
          stableJson({
            organization: config.organization.id,
            form: page.form,
            code: row.code,
            ...period,
            component,
            currency: config.currency,
            unit,
            report_period: config.report_period,
            profile: config.profile.id,
            profile_version: config.profile.version,
          }),
        );
        if (seen.has(logicalKey))
          issues.push({
            code: "duplicate_fact",
            severity: "error",
            page: page.page,
            indicator: row.code,
            message: "Повтор факта с теми же измерениями",
          });
        seen.add(logicalKey);
        observations.push({
          id: hash(runId + logicalKey),
          logical_key: logicalKey,
          organization_id: config.organization.id,
          organization_name: config.organization.name,
          form: page.form,
          code: row.code,
          name: name || `indicator_${row.code}`,
          report_period_start: config.report_period.start,
          report_period_end: config.report_period.end,
          ...period,
          currency: config.currency,
          unit,
          multiplier:
            unit === "millions" ? 1000000 : unit === "thousands" ? 1000 : 1,
          capital_component: component,
          value: cell.value,
          status: cell.status,
          provenance: {
            document_hash: documentHash,
            page: page.page,
            png: page.png,
            source_name: row.source_name || null,
            raw_cell: cell.raw,
            source_column: cell.column,
            model,
            pipeline_version: PIPELINE_VERSION,
            profile_id: config.profile.id,
            profile_version: config.profile.version,
            run_id: runId,
          },
        });
      }
    }
  }
  const checks = validateRelations(observations, config);
  for (const check of checks)
    if (check.status !== "passed")
      issues.push({
        code:
          check.status === "failed"
            ? "relation_failed"
            : "relation_uncheckable",
        severity: "error",
        message: `${check.rule} (${check.period}): ${check.reason || `${check.actual} != ${check.expected}`}`,
      });
  return {
    schema_version: PIPELINE_VERSION,
    run_id: runId,
    document_hash: documentHash,
    model,
    config,
    status: issues.some((i) => i.severity === "error")
      ? ("needs_review" as const)
      : ("ready" as const),
    observations,
    issues,
    checks,
  };
}

type Term = [string, string, number?];
export function validateRelations(
  rows: Observation[],
  config: ReportConfig,
): CheckResult[] {
  const results: CheckResult[] = [];
  const dates = new Set(rows.map((r) => r.period_end));
  const check = (rule: string, date: string, left: Term, right: Term[]) => {
    const terms = [left, ...right];
    const found = terms.map(([form, code]) =>
      rows.filter(
        (r) =>
          r.form === form &&
          r.code === code &&
          r.period_end === date &&
          r.capital_component === null,
      ),
    );
    if (found.some((r) => r.length !== 1)) {
      results.push({
        rule,
        period: date,
        status: "uncheckable",
        reason: "Нет однозначного полного набора строк",
      });
      return;
    }
    const cells = found.map((r) => r[0]);
    if (
      cells.some(
        (r) =>
          r.currency !== cells[0].currency ||
          r.unit !== cells[0].unit ||
          r.period_start !== cells[0].period_start,
      )
    ) {
      results.push({
        rule,
        period: date,
        status: "uncheckable",
        reason: "Несовместимые измерения/единицы",
      });
      return;
    }
    const values = cells.map((r) =>
      r.status === "reported"
        ? r.value
        : r.status === "dash" && config.dash_is_zero
          ? 0
          : null,
    );
    if (values.some((v) => v === null)) {
      results.push({
        rule,
        period: date,
        status: "uncheckable",
        reason: "Есть пропуски или нечитаемые ячейки; ноль не подставлен",
      });
      return;
    }
    const actual = values[0]!;
    const expected = values
      .slice(1)
      .reduce<number>((sum, v, i) => sum + v! * (right[i][2] ?? 1), 0);
    results.push({
      rule,
      period: date,
      status:
        Math.abs(actual - expected) <= (config.tolerance ?? 0)
          ? "passed"
          : "failed",
      actual,
      expected,
    });
  };
  const balance: [string, string, string[]][] = [
    [
      "non_current_assets",
      "1100",
      ["1110", "1130", "1140", "1150", "1160", "1170", "1180", "1190"],
    ],
    [
      "current_assets",
      "1200",
      ["1210", "1215", "1220", "1230", "1240", "1250", "1260"],
    ],
    ["total_assets", "1600", ["1100", "1200"]],
    ["equity", "1300", ["1310", "1320", "1340", "1350", "1360", "1370"]],
    ["non_current_liabilities", "1400", ["1410", "1420", "1430", "1450"]],
    ["current_liabilities", "1500", ["1510", "1520", "1530", "1540", "1550"]],
    ["total_liabilities_and_equity", "1700", ["1300", "1400", "1500"]],
    ["balance_equality", "1600", ["1700"]],
  ];
  for (const date of dates) {
    if (config.expected_forms.includes("0710001"))
      for (const [name, total, parts] of balance)
        check(
          name,
          date,
          ["0710001", total],
          parts.map((c) => ["0710001", c]),
        );
    if (
      config.expected_forms.includes("0710005") &&
      rows.some((r) => r.form === "0710005" && r.period_end === date)
    ) {
      for (const prefix of ["41", "42", "43"]) {
        check(
          `${prefix}_cash_receipts`,
          date,
          ["0710005", prefix + "10"],
          (prefix === "43"
            ? ["11", "12", "13", "14", "15", "19"]
            : ["11", "12", "13", "14", "19"]
          ).map((s) => ["0710005", prefix + s]),
        );
        check(
          `${prefix}_cash_payments`,
          date,
          ["0710005", prefix + "20"],
          (prefix === "43"
            ? ["21", "22", "23", "24", "29"]
            : ["21", "22", "23", "24", "29"]
          ).map((s) => ["0710005", prefix + s]),
        );
        check(
          `${prefix}_net_cash`,
          date,
          ["0710005", prefix + "00"],
          [
            ["0710005", prefix + "10"],
            ["0710005", prefix + "20"],
          ],
        );
      }
      check(
        "net_change_in_cash",
        date,
        ["0710005", "4400"],
        ["4100", "4200", "4300"].map((c) => ["0710005", c]),
      );
      check(
        "closing_cash",
        date,
        ["0710005", "4500"],
        ["4450", "4400", "4490"].map((c) => ["0710005", c]),
      );
    }
  }
  for (const date of dates) {
    if (
      config.expected_forms.includes("0710002") &&
      rows.some((r) => r.form === "0710002" && r.period_end === date)
    ) {
      for (const [name, total, parts] of [
        ["gross_profit", "2100", ["2110", "2120"]],
        ["operating_profit", "2200", ["2100", "2210", "2220"]],
        [
          "profit_before_tax",
          "2300",
          ["2200", "2310", "2320", "2330", "2340", "2350"],
        ],
        ["income_tax", "2410", ["2411", "2412", "2413"]],
        ["net_profit", "2400", ["2300", "2410", "2420", "2460"]],
        ["comprehensive_income", "2500", ["2400", "2510", "2520", "2530"]],
      ] as [string, string, string[]][])
        check(
          name,
          date,
          ["0710002", total],
          parts.map((c) => ["0710002", c]),
        );
    }
  }
  if (config.expected_forms.includes("0710004")) {
    const keys = new Set(
      rows
        .filter((r) => r.form === "0710004")
        .map((r) => r.code + "|" + r.period_end),
    );
    for (const key of keys) {
      const [code, date] = key.split("|");
      const cells = CAPITAL_COMPONENTS.map((component) =>
        rows.filter(
          (r) =>
            r.form === "0710004" &&
            r.code === code &&
            r.period_end === date &&
            r.capital_component === component,
        ),
      );
      const values = cells.map((list) =>
        list.length === 1
          ? list[0].status === "reported"
            ? list[0].value
            : list[0].status === "dash" && config.dash_is_zero
              ? 0
              : null
          : null,
      );
      if (values.some((v) => v === null))
        results.push({
          rule: `capital_components_${code}`,
          period: date,
          status: "uncheckable",
          reason: "Нет семи однозначных читаемых компонентов капитала",
        });
      else {
        const actual = values[6]!;
        const expected = values
          .slice(0, 6)
          .reduce<number>((sum, v) => sum + v!, 0);
        results.push({
          rule: `capital_components_${code}`,
          period: date,
          status:
            Math.abs(actual - expected) <= (config.tolerance ?? 0)
              ? "passed"
              : "failed",
          actual,
          expected,
        });
      }
    }
  }
  if (config.expected_forms.includes("0710004")) {
    for (const component of CAPITAL_COMPONENTS) {
      for (const [total, parts] of [
        ["3101", ["3100", "3110", "3120"]],
        ["3201", ["3200", "3210", "3220"]],
        ["3250", ["3101", "3211", "3212", "3227", "3230", "3216", "3240"]],
        ["3300", ["3201", "3311", "3312", "3327", "3330", "3316", "3340"]],
      ] as [string, string[]][]) {
        const cells = [total, ...parts].map((code) =>
          rows.filter(
            (r) =>
              r.form === "0710004" &&
              r.code === code &&
              r.capital_component === component,
          ),
        );
        const values = cells.map((list) =>
          list.length === 1
            ? list[0].status === "reported"
              ? list[0].value
              : list[0].status === "dash" && config.dash_is_zero
                ? 0
                : null
            : null,
        );
        const rule = `capital_movement_${total}_${component}`;
        if (values.some((v) => v === null))
          results.push({
            rule,
            period: config.report_period.end,
            status: "uncheckable",
            reason: "Нет полного набора компонентов движения капитала",
          });
        else {
          const actual = values[0]!;
          const expected = values
            .slice(1)
            .reduce<number>((sum, v) => sum + v!, 0);
          results.push({
            rule,
            period: config.report_period.end,
            status:
              Math.abs(actual - expected) <= (config.tolerance ?? 0)
                ? "passed"
                : "failed",
            actual,
            expected,
          });
        }
      }
    }
  }
  const cross = (
    rule: string,
    leftForm: string,
    leftCode: string,
    leftDate: string,
    rightForm: string,
    rightCode: string,
    rightDate: string,
    leftComponent: string | null = null,
  ) => {
    const left = rows.filter(
      (r) =>
        r.form === leftForm &&
        r.code === leftCode &&
        r.period_end === leftDate &&
        r.capital_component === leftComponent,
    );
    const right = rows.filter(
      (r) =>
        r.form === rightForm &&
        r.code === rightCode &&
        r.period_end === rightDate &&
        r.capital_component === null,
    );
    if (left.length !== 1 || right.length !== 1) {
      results.push({
        rule,
        period: leftDate,
        status: "uncheckable",
        reason: "Нет обеих форм для межформенной сверки",
      });
      return;
    }
    const a = left[0],
      b = right[0];
    if (
      a.unit !== b.unit ||
      a.currency !== b.currency ||
      a.status !== "reported" ||
      b.status !== "reported"
    ) {
      results.push({
        rule,
        period: leftDate,
        status: "uncheckable",
        reason: "Несовместимые единицы или отсутствуют значения",
      });
      return;
    }
    results.push({
      rule,
      period: leftDate,
      status:
        Math.abs(a.value! - b.value!) <= (config.tolerance ?? 0)
          ? "passed"
          : "failed",
      actual: a.value!,
      expected: b.value!,
    });
  };
  if (
    config.expected_forms.includes("0710001") &&
    config.expected_forms.includes("0710005")
  ) {
    for (const date of new Set(
      rows.filter((r) => r.form === "0710005").map((r) => r.period_end),
    )) {
      cross(
        "cash_matches_balance",
        "0710005",
        "4500",
        date,
        "0710001",
        "1250",
        date,
      );
      cross(
        "opening_cash_matches_balance",
        "0710005",
        "4450",
        date,
        "0710001",
        "1250",
        `${Number(date.slice(0, 4)) - 1}-12-31`,
      );
    }
  }
  if (
    config.expected_forms.includes("0710001") &&
    config.expected_forms.includes("0710004")
  ) {
    cross(
      "equity_matches_balance",
      "0710004",
      "3300",
      config.report_period.end,
      "0710001",
      "1300",
      config.report_period.end,
      "total",
    );
  }
  return results;
}
