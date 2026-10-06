/** Test-only in-memory AWS transport. Real handlers/serializers run above this;
 * no SDK client or AWS credential is used. Every command names its own table.
 */
import Module from "node:module";
export interface Attribute {
  S?: string;
  N?: string;
  BOOL?: boolean;
  SS?: string[];
}
export type Item = Record<string, Attribute>;
interface Command {
  kind: string;
  input: Record<string, unknown>;
}
const keyOf = (item: Item): string =>
  item.GroupId ? item.GroupId.S + "/" + item.ItemKey.S : (item.DeviceCode?.S ?? item.TokenHash?.S ?? item.CounterName?.S ?? item.Id?.N ?? "");
export class FakeDynamo {
  readonly tables = new Map<string, Map<string, Item>>();
  readonly calls: Command[] = [];
  failTable = "";
  pageSize = 2;
  table(name: string): Map<string, Item> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }
  seed(name: string, item: Item): void {
    // Device/catalog/command tables differ: catalog/command rows are keyed by Id.
    const key = name.endsWith("CatalogTemplates") || name.endsWith("CatalogProducts") || name.endsWith("DeviceCommands") ? item.Id.N! : keyOf(item);
    this.table(name).set(key, structuredClone(item));
  }
  async send(command: Command): Promise<object> {
    this.calls.push(structuredClone(command));
    const input = command.input;
    const tableName = String(input.TableName ?? "");
    if (tableName === this.failTable && this.failTable) throw new Error("mock database unavailable");
    if (command.kind === "TransactWriteItemsCommand") {
      const entries = (input.TransactItems as { Put: Record<string, unknown> }[]).map(entry => entry.Put);
      for (const put of entries) {
        const current = this.table(String(put.TableName)).get(keyOf(put.Item as Item));
        const expected = (put.ExpressionAttributeValues as Item | undefined)?.[":expected"]?.N;
        if (expected === undefined ? !!current : current?.Version.N !== expected) {
          throw Object.assign(new Error("stale revision"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        }
      }
      entries.forEach(put => this.seed(String(put.TableName), put.Item as Item));
      return {};
    }
    const table = this.table(tableName);
    if (command.kind === "GetItemCommand") return { Item: table.get(keyOf(input.Key as Item)) };
    if (command.kind === "PutItemCommand") {
      this.seed(tableName, input.Item as Item);
      return {};
    }
    if (command.kind === "UpdateItemCommand") {
      const key = keyOf(input.Key as Item);
      const current = table.get(key) ?? { ...(input.Key as Item) };
      if (tableName.endsWith("Counters")) current.NextValue = { N: String(Number(current.NextValue?.N ?? 0) + 1) };
      else current.LastUsedAtUtc = (input.ExpressionAttributeValues as Item)[":now"];
      table.set(key, current);
      return { Attributes: current };
    }
    if (command.kind === "ScanCommand") {
      const groups = Object.values(input.ExpressionAttributeValues as Item).map(value => value.S);
      return { Items: [...table.values()].filter(item => groups.includes(item.Group?.S)) };
    }
    if (command.kind === "QueryCommand") {
      const values = input.ExpressionAttributeValues as Item;
      const rows = [...table.values()].filter(item =>
        item.GroupId
          ? item.GroupId.S === values[":group"].S && item.ItemKey.S!.startsWith(values[":prefix"].S!)
          : item.DeviceCode.S === values[":dc"].S && (!values[":sk"] || item.CodeSortKey.S!.startsWith(values[":sk"].S!)),
      );
      const start = input.ExclusiveStartKey ? rows.findIndex(item => keyOf(item) === keyOf(input.ExclusiveStartKey as Item)) + 1 : 0;
      const size = Math.min(Number(input.Limit ?? this.pageSize), this.pageSize);
      const page = rows.slice(start, start + size);
      return { Items: page, ...(start + size < rows.length ? { LastEvaluatedKey: page.at(-1) } : {}) };
    }
    throw new Error("Unimplemented fake command: " + command.kind);
  }
  install(): () => void {
    const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
    const original = loader._load;
    const send = (command: Command): Promise<object> => this.send(command);
    const sdk: Record<string, unknown> = {
      DynamoDBClient: class {
        send(command: Command): Promise<object> {
          return send(command);
        }
      },
    };
    for (const kind of ["GetItemCommand", "UpdateItemCommand", "PutItemCommand", "QueryCommand", "ScanCommand", "TransactWriteItemsCommand"]) {
      sdk[kind] = class {
        kind = kind;
        constructor(public input: Record<string, unknown>) {}
      };
    }
    loader._load = function (name, ...args) {
      return name === "@aws-sdk/client-dynamodb" ? sdk : original.call(this, name, ...args);
    };
    return () => {
      loader._load = original;
    };
  }
}
