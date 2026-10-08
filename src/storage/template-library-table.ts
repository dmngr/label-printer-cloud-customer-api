/** DynamoDB adapter for the versioned library; canonical copy: customer-api.
 * Reads are strongly consistent and paginated. Atomic head/version transactions
 * and expected revisions reject concurrent edits rather than losing changes.
 * The managed Node runtime supplies the AWS SDK; no SDK dependency is bundled.
 */
import { LibraryError, type LibraryRow, type LibraryTable, type LibraryGuard } from "../lib/template-library";
type Item = Record<string, { S?: string; N?: string }>;
interface Output {
  Item?: Item;
  Items?: Item[];
  LastEvaluatedKey?: Item;
}
interface Sdk {
  DynamoDBClient: new (config: object) => { send(command: unknown): Promise<Output> };
  GetItemCommand: new (input: object) => unknown;
  QueryCommand: new (input: object) => unknown;
  TransactWriteItemsCommand: new (input: object) => unknown;
}
let cached: { sdk: Sdk; client: InstanceType<Sdk["DynamoDBClient"]> } | undefined;
function runtime(): NonNullable<typeof cached> {
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require("@aws-sdk/client-dynamodb") as Sdk;
    cached = { sdk, client: new sdk.DynamoDBClient({}) };
  }
  return cached;
}
function row(item: Item): LibraryRow {
  return { key: item.ItemKey.S!, version: Number(item.Version.N), payload: JSON.parse(item.Payload.S!) as unknown };
}
export class DynamoTemplateLibraryTable implements LibraryTable {
  constructor(private readonly tableName: string) {}
  async get(group: string, key: string): Promise<LibraryRow | null> {
    const { sdk, client } = runtime();
    const response = await client.send(
      new sdk.GetItemCommand({ TableName: this.tableName, Key: { GroupId: { S: group }, ItemKey: { S: key } }, ConsistentRead: true }),
    );
    return response.Item ? row(response.Item) : null;
  }
  async list(group: string, prefix: string): Promise<LibraryRow[]> {
    const { sdk, client } = runtime();
    const rows: LibraryRow[] = [];
    let cursor: Item | undefined;
    do {
      const response = await client.send(
        new sdk.QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "GroupId = :group AND begins_with(ItemKey, :prefix)",
          ExpressionAttributeValues: { ":group": { S: group }, ":prefix": { S: prefix } },
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      rows.push(...(response.Items ?? []).map(row));
      cursor = response.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length);
    return rows;
  }
  async write(group: string, value: LibraryRow, expectedVersion: number, immutable?: LibraryRow, guards: LibraryGuard[] = []): Promise<void> {
    const { sdk, client } = runtime();
    const put = (record: LibraryRow, expected: number): object => ({
      Put: {
        TableName: this.tableName,
        Item: {
          GroupId: { S: group },
          ItemKey: { S: record.key },
          Version: { N: String(record.version) },
          Payload: { S: JSON.stringify(record.payload) },
        },
        ConditionExpression: expected === 0 ? "attribute_not_exists(ItemKey)" : "#version = :expected",
        ...(expected === 0
          ? {}
          : { ExpressionAttributeNames: { "#version": "Version" }, ExpressionAttributeValues: { ":expected": { N: String(expected) } } }),
      },
    });
    try {
      await client.send(
        new sdk.TransactWriteItemsCommand({
          TransactItems: [
            put(value, expectedVersion),
            ...(immutable ? [put(immutable, 0)] : []),
            ...guards.map(guard => ({
              ConditionCheck: {
                TableName: this.tableName,
                Key: { GroupId: { S: group }, ItemKey: { S: guard.key } },
                ConditionExpression: guard.version === 0 ? "attribute_not_exists(ItemKey)" : "#version = :expected",
                ...(guard.version === 0
                  ? {}
                  : {
                      ExpressionAttributeNames: { "#version": "Version" },
                      ExpressionAttributeValues: { ":expected": { N: String(guard.version) } },
                    }),
              },
            })),
          ],
        }),
      );
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
      if (failure.name === "TransactionCanceledException" && failure.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed"))
        throw new LibraryError(409, "library_revision_conflict");
      // Some SDK/runtime combinations omit per-item cancellation reasons.
      // Strongly read every conditioned revision to distinguish a stale edit or
      // archive race from a real outage; matching revisions do not prove success.
      if (failure.name === "TransactionCanceledException" && !failure.CancellationReasons) {
        const current = await this.get(group, value.key);
        if ((current?.version ?? 0) !== expectedVersion) throw new LibraryError(409, "library_revision_conflict");
        for (const guard of guards) {
          if (((await this.get(group, guard.key))?.version ?? 0) !== guard.version) throw new LibraryError(409, "library_revision_conflict");
        }
      }
      throw error;
    }
  }
}
