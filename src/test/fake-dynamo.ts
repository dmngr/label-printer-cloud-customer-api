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
  item.Pk ? item.Pk.S + "/" + item.Sk.S : item.GroupId ? item.GroupId.S + "/" + item.ItemKey.S : (item.Id?.N ?? item.DeviceCode?.S ?? item.TokenHash?.S ?? item.CounterName?.S ?? "");
function conditionMatches(input: Record<string, unknown>, current: Item | undefined): boolean {
  const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
  const values = input.ExpressionAttributeValues as Item | undefined;
  return String(input.ConditionExpression).split(" AND ").every(raw => {
    const clause = raw.replace(/#[a-zA-Z0-9_]+/gu, name => names?.[name] ?? name);
    const exists = clause.match(/^attribute_(not_)?exists\((\w+)\)$/u);
    if (exists) return exists[1] ? current?.[exists[2]] === undefined : current?.[exists[2]] !== undefined;
    const alternatives = clause.match(/^\((\w+) = (:\w+) OR (\w+) = (:\w+)\)$/u);
    if (alternatives) return JSON.stringify(current?.[alternatives[1]]) === JSON.stringify(values?.[alternatives[2]])
      || JSON.stringify(current?.[alternatives[3]]) === JSON.stringify(values?.[alternatives[4]]);
    const equality = clause.match(/^(\w+) = (:\w+)$/u);
    if (!equality) throw new Error("Unsupported fixture condition: " + clause);
    return JSON.stringify(current?.[equality[1]]) === JSON.stringify(values?.[equality[2]]);
  });
}
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
      const entries = input.TransactItems as { Put?: Record<string, unknown>; ConditionCheck?: Record<string, unknown> }[];
      for (const entry of entries) {
        const put = (entry.Put ?? entry.ConditionCheck)!;
        if (put.TableName === this.failTable) throw new Error("mock database unavailable");
        const current = this.table(String(put.TableName)).get(keyOf((put.Item ?? put.Key) as Item));
        if (!conditionMatches(put, current)) {
          throw Object.assign(new Error("stale revision"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        }
      }
      entries.forEach(({ Put: put }) => {
        if (put) this.seed(String(put.TableName), put.Item as Item);
      });
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
