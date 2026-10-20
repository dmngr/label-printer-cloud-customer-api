/** Canonical push-v1 command/inbox write contract. Copy this exact file to every
 * command producer and verify parity. The existing command table is shared by
 * customer, systems and administrator entry points; a push installation cannot
 * depend on which producer happened to write the command.
 *
 * Both push and legacy writes fence the mode/ownership observed by the writer.
 * A rollout race fails the transaction and retries; it cannot silently create a
 * command without an inbox after the installation has switched away from polling.
 */
import { createHash } from "node:crypto";
export type DeliveryRow = Record<string, unknown>;
export interface DeliveryWriteTables { devices: string; inbox: string; }
export const deliveryPartition = (device: DeliveryRow): string => "INSTALL:" + createHash("sha256")
  .update(JSON.stringify([device.Group, device.StoreCode, device.InstallationId])).digest("hex");
export function commandDeliveryWrites(command: DeliveryRow, device: DeliveryRow | undefined, tables: DeliveryWriteTables): { command: DeliveryRow; extra: object[] } {
  // Historical privileged callers could queue before first device registration.
  // Preserve that case, but fence an enrollment racing this legacy write.
  if (!device) return { command, extra: [{ ConditionCheck: { TableName: tables.devices, Key: { DeviceCode: command.DeviceCode },
    ConditionExpression: "attribute_not_exists(DeviceCode)" } }] };
  const push = device.DeliveryMode === "push-v1";
  if (device.DeliveryMode && !["push-v1", "legacy-poll"].includes(String(device.DeliveryMode)))
    throw new Error("delivery_transition_in_progress");
  if (push && (device.DeviceCode !== command.DeviceCode || typeof device.Group !== "string" || !device.Group
    || typeof device.StoreCode !== "string" || !device.StoreCode || device.StoreCode !== command.StoreCode)) throw new Error("delivery_destination_not_found");
  const values: DeliveryRow = {};
  let condition = "attribute_exists(DeviceCode)";
  if (device.Group) { condition += " AND #group = :group"; values[":group"] = device.Group; }
  if (device.StoreCode) { condition += " AND StoreCode = :store"; values[":store"] = device.StoreCode; }
  if (device.InstallationId) { condition += " AND InstallationId = :installation"; values[":installation"] = device.InstallationId; }
  else condition += " AND attribute_not_exists(InstallationId)";
  if (device.DeliveryMode) { condition += " AND DeliveryMode = :mode"; values[":mode"] = device.DeliveryMode; }
  else condition += " AND attribute_not_exists(DeliveryMode)";
  if (push) {
    // Existing metadata writers persist this capability as DynamoDB S("1").
    // Accept both representations; never assume numeric fixtures match live rows.
    if (device.PrintRequestProtocolVersion !== 1 && device.PrintRequestProtocolVersion !== "1") throw new Error("delivery_protocol_required");
    condition += " AND (PrintRequestProtocolVersion = :protocol OR PrintRequestProtocolVersion = :protocolText)";
    values[":protocol"] = 1; values[":protocolText"] = "1";
  }
  const extra: object[] = [{ ConditionCheck: { TableName: tables.devices, Key: { DeviceCode: command.DeviceCode },
    ConditionExpression: condition, ...(device.Group ? { ExpressionAttributeNames: { "#group": "Group" } } : {}),
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) } }];
  if (!push) return { command, extra };
  if (!tables.inbox || typeof device.InstallationId !== "string" || !device.InstallationId
    || !Number.isSafeInteger(command.Id) || Number(command.Id) <= 0) throw new Error("delivery_configuration_required");
  const deliveryId = "cmd:" + command.Id;
  const partition = deliveryPartition(device);
  let expiresAtUtc = new Date(Date.parse(String(command.RequestedAtUtc)) + 600000).toISOString();
  if (command.CommandType === "print-request") {
    const request = JSON.parse(String(command.PayloadJson)) as { expiresAtUtc?: string };
    // Existing manual requests may omit a deadline. New systems/KDS requests
    // require it at admission. The delivery deadline does not alter the payload.
    if (request.expiresAtUtc) expiresAtUtc = request.expiresAtUtc;
  }
  if (!Number.isFinite(Date.parse(expiresAtUtc))) throw new Error("invalid_delivery_deadline");
  const enriched = { ...command, DeliveryId: deliveryId, DeliveryPartition: partition, InstallationId: device.InstallationId };
  extra.push({ Put: { TableName: tables.inbox, Item: { Pk: partition, Sk: "P:" + deliveryId,
    DeliveryId: deliveryId, CommandId: command.Id, DeviceCode: device.DeviceCode, Group: device.Group,
    StoreCode: device.StoreCode, InstallationId: device.InstallationId, ExpiresAtUtc: expiresAtUtc, State: "Pending", Kind: "delivery" },
    ConditionExpression: "attribute_not_exists(Pk)" } });
  return { command: enriched, extra };
}

// Existing Label Lambdas use the low-level SDK. Keep the conversion here so
// their command transaction and the systems DocumentClient transaction agree.
export type DeliveryAttribute = { S?: string; N?: string; BOOL?: boolean };
export type DeliveryItem = Record<string, DeliveryAttribute>;
export function decodeDeliveryItem(item: DeliveryItem): DeliveryRow {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key,
    value.S !== undefined ? value.S : value.N !== undefined ? Number(value.N) : value.BOOL]));
}
export function encodeDeliveryItem(item: DeliveryRow): DeliveryItem {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => {
    if (typeof value === "string") return [key, { S: value }];
    if (typeof value === "number" && Number.isFinite(value)) return [key, { N: String(value) }];
    if (typeof value === "boolean") return [key, { BOOL: value }];
    throw new Error("invalid_delivery_attribute");
  }));
}
export function attributeDeliveryWrites(command: DeliveryItem, device: DeliveryItem | undefined, tables: DeliveryWriteTables): { command: DeliveryItem; extra: object[] } {
  const prepared = commandDeliveryWrites(decodeDeliveryItem(command), device ? decodeDeliveryItem(device) : undefined, tables);
  return { command: encodeDeliveryItem(prepared.command), extra: prepared.extra.map(action => {
    const [operation, raw] = Object.entries(action)[0] as [string, Record<string, unknown>];
    return { [operation]: { ...raw,
      ...(raw.Key ? { Key: encodeDeliveryItem(raw.Key as DeliveryRow) } : {}),
      ...(raw.Item ? { Item: encodeDeliveryItem(raw.Item as DeliveryRow) } : {}),
      ...(raw.ExpressionAttributeValues ? { ExpressionAttributeValues: encodeDeliveryItem(raw.ExpressionAttributeValues as DeliveryRow) } : {}),
    } };
  }) };
}
