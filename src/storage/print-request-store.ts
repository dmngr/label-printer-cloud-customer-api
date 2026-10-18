/** Durable cloud acceptance receipt + command in ONE transaction. Receipts live
 * under a disjoint CounterName prefix in the existing counters table, without
 * TTL: command/history cleanup must not re-enable execution. Unused monotonic
 * IDs after a race are harmless. A lost transaction response is reconciled with
 * a strongly consistent receipt read; errors without evidence stay errors.
 */
import { createHash } from "node:crypto";
import type { CustomerApiOptions } from "../config";
import type { DeviceRecord } from "../types";
import { PrintRequestError, printIntentFingerprint, type SharedPrintRequest } from "../lib/shared-print-request";
type Item = Record<string, { S?: string; N?: string }>;
interface Sdk {
  DynamoDBClient: new (options: object) => { send(command: unknown): Promise<{ Item?: Item }> };
  GetItemCommand: new (input: object) => unknown;
  TransactWriteItemsCommand: new (input: object) => unknown;
}
let runtime: { sdk: Sdk; client: InstanceType<Sdk["DynamoDBClient"]> } | undefined;
function aws(): NonNullable<typeof runtime> {
  if (!runtime) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require("@aws-sdk/client-dynamodb") as Sdk;
    runtime = { sdk, client: new sdk.DynamoDBClient({}) };
  }
  return runtime;
}
export interface PrintRequestReceipt {
  id: number;
  printRequestId: string;
  deviceCode: string;
  status: "Pending";
  requestedAtUtc: string;
  commandType: "print-request";
  replayed: boolean;
}
export class PrintRequestStore {
  constructor(private readonly options: CustomerApiOptions) {}
  async submit(
    device: DeviceRecord,
    request: SharedPrintRequest,
    allocate: () => Promise<number>,
    requestedBy: string,
  ): Promise<PrintRequestReceipt> {
    if (request.deviceCode !== device.deviceCode) throw new PrintRequestError(409, "print_request_destination_conflict");
    const name =
      "PrintRequestV1:" +
      createHash("sha256")
        .update(device.storeId + "\n" + request.printRequestId)
        .digest("hex");
    const fingerprint = printIntentFingerprint(request);
    const { sdk, client } = aws();
    const read = async (): Promise<PrintRequestReceipt | undefined> => {
      const found = await client.send(
        new sdk.GetItemCommand({ TableName: this.options.countersTableName, Key: { CounterName: { S: name } }, ConsistentRead: true }),
      );
      if (!found.Item) return undefined;
      if (found.Item.Fingerprint?.S !== fingerprint) throw new PrintRequestError(409, "print_request_conflict");
      return { ...(JSON.parse(found.Item.ResponseJson.S!) as PrintRequestReceipt), replayed: true };
    };
    const replay = await read();
    if (replay) return replay;
    if (device.printRequestProtocolVersion !== 1) throw new PrintRequestError(409, "print_request_agent_update_required");
    if (request.expiresAtUtc && Date.parse(request.expiresAtUtc) <= Date.now()) throw new PrintRequestError(409, "print_request_expired");
    const id = await allocate();
    const now = new Date().toISOString();
    const receipt: PrintRequestReceipt = {
      id,
      printRequestId: request.printRequestId,
      deviceCode: device.deviceCode,
      status: "Pending",
      requestedAtUtc: now,
      commandType: "print-request",
      replayed: false,
    };
    const command: Item = {
      Id: { N: String(id) },
      DeviceCode: { S: device.deviceCode },
      StoreCode: { S: device.storeCode },
      CommandType: { S: "print-request" },
      PayloadJson: { S: JSON.stringify(request) },
      Status: { S: "Pending" },
      RequestedBy: { S: requestedBy },
      RequestedAtUtc: { S: now },
      RequestedAtEpochSeconds: { N: String(Math.floor(Date.parse(now) / 1000)) },
      PrintRequestProtocolVersion: { N: "1" },
      DeviceStatusRequestedKey: { S: `Pending#${now}#${String(id).padStart(20, "0")}` },
    };
    try {
      await client.send(
        new sdk.TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.options.countersTableName,
                Item: { CounterName: { S: name }, Fingerprint: { S: fingerprint }, ResponseJson: { S: JSON.stringify(receipt) } },
                ConditionExpression: "attribute_not_exists(CounterName)",
              },
            },
            { Put: { TableName: this.options.deviceCommandsTableName, Item: command, ConditionExpression: "attribute_not_exists(Id)" } },
          ],
        }),
      );
    } catch (error) {
      const committed = await read();
      if (committed) return committed;
      throw error;
    }
    return receipt;
  }
}
