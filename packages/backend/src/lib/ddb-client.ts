import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// Module-level cache — reused across Lambda warm starts
let cachedClient: DynamoDBClient | null = null;

export function getDynamoClient(): DynamoDBClient {
  if (cachedClient) return cachedClient;
  cachedClient = new DynamoDBClient({});
  return cachedClient;
}
