// Shared push command/inbox transaction, frozen before producer fan-out.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const SELF_PIN = "68164277aff7ded6ef9acdcc15ba5947a07706b7bebd84e82e5676d03fed0f73";
const PINS = {"src/push-delivery.ts": "c28f3f9e073b818b1d24b4f7d73cafff4bf1cca71d7314dc359ec9a4a4417593"};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
if (!["label-printer-cloud-integration-api", "label-printer-cloud-customer-api", "label-printer-cloud-device-command-write"].includes(name)) throw new Error("Unknown delivery contract consumer");
const normalized = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha = value => createHash("sha256").update(value).digest("hex");
const source = normalized(fileURLToPath(import.meta.url));
const mask = /^const SELF_PIN = "[a-f0-9]{64}";$/gm;
if ([...source.matchAll(mask)].length !== 1 || sha(source.replace(mask, 'const SELF_PIN = "MASKED";')) !== SELF_PIN) throw new Error("Parity gate drift");
for (const [file, expected] of Object.entries(PINS)) if (sha(normalized(path.join(root, file))) !== expected) throw new Error(file + " drift");
if (name === "label-printer-cloud-integration-api" && sha(normalized(path.join(root, "src/device-credential.ts"))) !== "3730c9a7b3e7951127f8833a08a1cf775b2d9a35bb9bf6c6f4a61ae801526c2f") throw new Error("Device credential contract drift");
console.log("Shared delivery contract verified: " + name);
