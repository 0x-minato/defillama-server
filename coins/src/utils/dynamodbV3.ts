import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import sleep from "./shared/sleep";

const connect = new DynamoDBClient({
  ...(process.env.MOCK_DYNAMODB_ENDPOINT && {
    endpoint: process.env.MOCK_DYNAMODB_ENDPOINT,
    sslEnabled: false,
    region: "local",
  }),
});
const client = DynamoDBDocumentClient.from(connect);

export const TableName =
  process.env.tableName! || process.env.AWS_COINS_TABLE_NAME!;

const dynamodb = {
  get: (key: any, params?: any) =>
    client.send(new GetCommand({ TableName, ...params, Key: key })),
  put: (item: any, params?: any) =>
    client.send(new PutCommand({ TableName, ...params, Item: item })),
  query: (params: any) =>
    client.send(new QueryCommand({ TableName, ...params })),
  delete: (params: any) =>
    client.send(new DeleteCommand({ TableName, ...params })),
  batchGet: (keys: any) =>
    client.send(
      new BatchGetCommand({
        RequestItems: {
          [TableName]: {
            Keys: keys,
          },
        },
      }),
    ),
  batchWrite: (params: any) =>
    client.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableName]: params,
        },
      }),
    ),
  getEnvSecrets: (key: any = { PK: "lambda-secrets" }) =>
    client.send(new GetCommand({ TableName: "secrets", Key: key })),
};
export default dynamodb;

export async function getHistoricalValues(pk: string, lastKey = -1) {
  let items = [] as any[];
  do {
    const result = await dynamodb.query({
      ExpressionAttributeValues: {
        ":pk": pk,
        ":sk": lastKey,
      },
      KeyConditionExpression: "PK = :pk AND SK > :sk",
    });
    lastKey = result.LastEvaluatedKey?.SK;
    if (result.Items !== undefined) {
      items = items.concat(result.Items);
    }
  } while (lastKey !== undefined);
  return items;
}

const maxWriteRetries = 6; // Total wait time if all requests fail ~= 1.2s
async function underlyingBatchWrite(
  items: any[],
  retryCount: number,
  failOnError: boolean,
): Promise<void> {
  const output = await dynamodb.batchWrite(items);
  const unprocessed = output.UnprocessedItems?.[TableName] ?? [];
  if (unprocessed.length > 0) {
    // Retry algo
    if (retryCount < maxWriteRetries) {
      const wait = 2 ** retryCount * 10;
      const jitter = Math.random() * wait - wait / 2;
      await sleep(wait + jitter);
      return underlyingBatchWrite(unprocessed, retryCount + 1, failOnError);
    } else if (failOnError) {
      console.log("throttled", output?.UnprocessedItems);
      throw new Error("Write requests throttled");
    }
  }
}

function removeDuplicateKeys(items: any[]) {
  return items.filter((item, index) =>
    // Could be optimized to O(nlogn) but not worth it
    items
      .slice(0, index)
      .every(
        (checkedItem) =>
          !(checkedItem.PK === item.PK && checkedItem.SK === item.SK),
      ),
  );
}

const batchWriteStep = 25; // Max items written at once are 25
// IMPORTANT: Duplicated items will be pruned
export async function batchWrite(items: any[], failOnError: boolean) {
  const writeRequests = [];
  for (let i = 0; i < items.length; i += batchWriteStep) {
    const itemsToWrite = items.slice(i, i + batchWriteStep);
    const nonDuplicatedItems = removeDuplicateKeys(itemsToWrite);
    writeRequests.push(
      underlyingBatchWrite(
        nonDuplicatedItems.map((item) => ({ PutRequest: { Item: item } })),
        0,
        failOnError,
      ),
    );
  }
  await Promise.all(writeRequests);
}

const batchGetStep = 100; // Max 100 items per batchGet
export async function batchGet(
  keys: { PK: string; SK: number }[],
  retriesLeft = 3,
) {
  if (retriesLeft === 0) {
    console.log("Unprocessed batchGet reqs:", keys);
    throw new Error("Not all batchGet requests could be processed");
  }
  const requests = [];
  for (let i = 0; i < keys.length; i += batchGetStep) {
    requests.push(
      dynamodb.batchGet(removeDuplicateKeys(keys.slice(i, i + batchGetStep))),
    );
  }
  const responses = await Promise.all(requests);
  let processedResponses = ([] as any[]).concat(
    ...responses.map((r) => r.Responses![TableName]),
  );
  const unprocessed = responses
    .map((r) => r.UnprocessedKeys?.[TableName]?.Keys ?? [])
    .flat();
  if (unprocessed.length > 0) {
    const missingResponses = await batchGet(
      unprocessed as any[],
      retriesLeft - 1,
    );
    processedResponses = processedResponses.concat(missingResponses);
  }
  return processedResponses;
}

export async function DELETE(
  keys: { PK: string; SK: number }[],
): Promise<void> {
  const requests = [];
  for (const item of keys) {
    // console.log('deleting', item.PK, item.SK)
    if (item.PK && (item.SK == 0 || item.SK))
      requests.push(dynamodb.delete({ Key: { PK: item.PK, SK: item.SK } }));
  }
  const a = await Promise.all(requests);
  return;
}
