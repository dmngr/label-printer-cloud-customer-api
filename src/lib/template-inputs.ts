/** Customer forms follow the Windows TemplateInputContract (DEV 1.0.99+).
 * Canonical web/API copy: customer-api. No-schema layouts infer editable fields;
 * an explicit empty inputs array declares none. Automatic print context cannot
 * be declared as user input. Validation returns values; it never queues a job.
 */
export interface TemplateInput {
  key: string;
  label: string;
  type: "text" | "number" | "date";
  required: boolean;
  defaultValue?: string | null;
}
const automatic = new Set([
  "quantity",
  "printername",
  "templatecode",
  "sourcename",
  "createdatutc",
  "printedatutc",
  "printedat",
  "now",
  "date",
  "time",
  "labelsize",
  "labelwidthmm",
  "labelheightmm",
]);
export const inputKey = (key: string): string => key.replace(/^fields\./i, "");
const isAutomatic = (key: string): boolean => automatic.has(inputKey(key).replace(/_/g, "").toLowerCase());
const names: Record<string, string> = {
  productname: "Τίτλος",
  ordernumber: "Αριθμός παραγγελίας",
  commentstext: "Σχόλια",
  barcodevalue: "Τιμή barcode",
  qrvalue: "Τιμή QR",
  customer: "Πελάτης",
  station: "Σταθμός",
  lot: "Παρτίδα",
  route: "Διαδρομή",
  address: "Διεύθυνση",
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Μη έγκυρη διάταξη προτύπου.");
  return value as Record<string, unknown>;
}
function validateValue(input: TemplateInput, value: string): void {
  if (
    input["type"] === "number" &&
    (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) ||
      !Number.isFinite(Number(value)) ||
      Math.abs(Number(value)) > 7.922816251426433e28)
  )
    throw new Error(`Το πεδίο «${input["label"] || input["key"]}» χρειάζεται αριθμό.`);
  if (input["type"] === "date") {
    const date = new Date(value + "T00:00:00Z");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith("0000") ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    )
      throw new Error(`Το πεδίο «${input["label"] || input["key"]}» χρειάζεται ημερομηνία YYYY-MM-DD.`);
  }
}
export function readTemplateInputs(json: string): TemplateInput[] {
  const layout = record(JSON.parse(json.trim() || "{}"));
  if (Object.hasOwn(layout, "inputs")) {
    if (!Array.isArray(layout["inputs"]) || layout["inputs"].length > 64) throw new Error("Επιτρέπονται έως 64 πεδία ανά πρότυπο.");
    const keys = new Set<string>();
    return layout["inputs"].map(raw => {
      const input = record(raw);
      const key = input["key"];
      if (
        typeof key !== "string" ||
        !key.trim() ||
        key !== key.trim() ||
        key.length > 100 ||
        !inputKey(key).trim() ||
        ["__proto__", "prototype", "constructor"].includes(inputKey(key).toLowerCase()) ||
        isAutomatic(key) ||
        keys.has(inputKey(key).toLowerCase())
      )
        throw new Error("Κάθε πεδίο χρειάζεται μοναδικό κλειδί.");
      keys.add(inputKey(key).toLowerCase());
      const type = input["type"] ?? "text";
      if (type !== "text" && type !== "number" && type !== "date") throw new Error("Μη έγκυρος τύπος πεδίου.");
      if (input["label"] !== undefined && typeof input["label"] !== "string") throw new Error("Μη έγκυρη ονομασία πεδίου.");
      if (input["required"] !== undefined && typeof input["required"] !== "boolean") throw new Error("Μη έγκυρο υποχρεωτικό πεδίο.");
      if (input["defaultValue"] !== undefined && input["defaultValue"] !== null && typeof input["defaultValue"] !== "string")
        throw new Error("Μη έγκυρη προεπιλογή.");
      const result: TemplateInput = {
        key: inputKey(key),
        label: String(input["label"] ?? ""),
        type,
        required: input["required"] === true,
        ...(input["defaultValue"] !== undefined ? { defaultValue: input["defaultValue"] as string | null } : {}),
      };
      if (result.defaultValue?.trim()) validateValue(result, result.defaultValue);
      return result;
    });
  }
  const elements = Array.isArray(layout["elements"]) ? layout["elements"].map(record) : [];
  const inferred = elements
    .filter(e => !(typeof e["text"] === "string" && e["text"].trim()) && typeof e["field"] === "string" && e["field"].trim())
    .map(e => inputKey(String(e["field"]).trim()))
    .filter(key => !isAutomatic(key));
  if (!elements.length) inferred.push("productName", "orderNumber", "commentsText");
  const distinct = new Map<string, string>();
  inferred.forEach(key => {
    if (!distinct.has(key.toLowerCase())) distinct.set(key.toLowerCase(), key);
  });
  if (
    distinct.size > 64 ||
    [...distinct.values()].some(key => key.length > 100 || ["__proto__", "prototype", "constructor"].includes(key.toLowerCase()))
  ) {
    throw new Error("Μη έγκυρα πεδία προτύπου.");
  }
  return [...distinct.values()].map(key => ({
    key,
    label: names[key.toLowerCase()] ?? key,
    type: "text",
    required:
      key.toLowerCase() === "productname" ||
      elements.some(
        e => (e["type"] === "barcode" || e["type"] === "qrcode") && inputKey(String(e["field"] ?? "")).toLowerCase() === key.toLowerCase(),
      ),
  }));
}
export function bindTemplateInputs(inputs: TemplateInput[], supplied: unknown): Record<string, string | null> {
  const values = supplied === undefined ? {} : record(supplied);
  if (Object.keys(values).length > 64) throw new Error("Πάρα πολλά πεδία.");
  const result: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [rawKey, value] of Object.entries(values)) {
    if (rawKey.length > 100 || (value !== null && typeof value !== "string") || (typeof value === "string" && value.length > 4000))
      throw new Error("Μη έγκυρη τιμή πεδίου.");
    const key = inputKey(rawKey);
    if (["__proto__", "prototype", "constructor"].includes(key.toLowerCase()) || isAutomatic(key))
      throw new Error("Το πεδίο συμπληρώνεται αυτόματα.");
    const definition = inputs.find(input => inputKey(input["key"]).toLowerCase() === key.toLowerCase());
    result[definition?.key ?? key] = value as string | null;
  }
  for (const input of inputs) {
    const value = result[input["key"]]?.trim() ? result[input["key"]] : input["defaultValue"];
    if (!value?.trim()) {
      if (input["required"]) throw new Error(`Συμπληρώστε το πεδίο «${input["label"] || input["key"]}».`);
    } else validateValue(input, value);
    result[input["key"]] = value ?? null;
  }
  return result;
}
