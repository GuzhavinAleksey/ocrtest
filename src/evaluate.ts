import * as fs from "node:fs";
import { stableJson } from "./financial-data";

export interface BenchmarkCell {
  organization_id: string;
  form: string;
  code: string;
  period_end: string;
  period_start: string | null;
  capital_component: string | null;
  currency: string;
  unit: string;
  status: string;
  value: number | null;
}
const key = (cell: BenchmarkCell) =>
  stableJson([
    cell.organization_id,
    cell.form,
    cell.code,
    cell.period_start,
    cell.period_end,
    cell.capital_component,
    cell.currency,
    cell.unit,
  ]);
function index(cells: BenchmarkCell[]) {
  if (!Array.isArray(cells)) throw new Error("Ожидается массив ячеек");
  const result = new Map<string, BenchmarkCell>();
  for (const cell of cells) {
    if (
      !cell ||
      typeof cell.organization_id !== "string" ||
      !/^071000[1245]$/.test(cell.form) ||
      !/^\d{4}$/.test(cell.code) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(cell.period_end) ||
      !(cell.period_start === null || typeof cell.period_start === "string") ||
      !(
        cell.capital_component === null ||
        typeof cell.capital_component === "string"
      ) ||
      typeof cell.currency !== "string" ||
      typeof cell.unit !== "string" ||
      !["reported", "dash", "unreadable", "not_applicable"].includes(
        cell.status,
      ) ||
      (cell.status === "reported"
        ? typeof cell.value !== "number" || !Number.isFinite(cell.value)
        : cell.value !== null)
    )
      throw new Error("Неверная эталонная/распознанная ячейка");
    const id = key(cell);
    if (result.has(id)) throw new Error("Повтор измерений в наборе оценки");
    result.set(id, cell);
  }
  return result;
}
export function evaluate(
  predictions: BenchmarkCell[],
  reference: BenchmarkCell[],
) {
  const truth = index(reference),
    actual = index(predictions);
  if (!truth.size) throw new Error("Пустой эталон не измеряет точность");
  let correct = 0,
    numericTotal = 0,
    numericCorrect = 0;
  const differences: {
    key: string;
    type: string;
    expected?: BenchmarkCell;
    actual?: BenchmarkCell;
  }[] = [];
  for (const [id, expected] of truth) {
    const found = actual.get(id);
    if (expected.status === "reported") numericTotal++;
    if (!found) {
      differences.push({ key: id, type: "missing", expected });
      continue;
    }
    if (found.status === expected.status && found.value === expected.value) {
      correct++;
      if (expected.status === "reported") numericCorrect++;
    } else
      differences.push({ key: id, type: "mismatch", expected, actual: found });
  }
  let extra = 0;
  for (const [id, found] of actual)
    if (!truth.has(id)) {
      extra++;
      differences.push({ key: id, type: "extra", actual: found });
    }
  return {
    reference_cells: truth.size,
    predicted_cells: actual.size,
    correct_cells: correct,
    missing_cells: differences.filter((d) => d.type === "missing").length,
    extra_cells: extra,
    cell_accuracy: correct / truth.size,
    numeric_accuracy: numericTotal ? numericCorrect / numericTotal : null,
    precision: actual.size ? correct / actual.size : 0,
    differences,
  };
}
if (require.main === module) {
  try {
    const [predicted, truth] = process.argv.slice(2);
    if (!predicted || !truth)
      throw new Error(
        "Использование: ts-node src/evaluate.ts predictions.json reference.json",
      );
    const load = (file: string) => {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(json)
        ? json
        : (json.report?.observations ?? json.observations);
    };
    const result = evaluate(load(predicted), load(truth));
    console.log(JSON.stringify(result, null, 2));
    if (result.differences.length) process.exitCode = 2;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
