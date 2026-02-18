import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import type { UploadRequest, UploadResponse } from '@hyperspace/shared';

const dynamo = new DynamoDBClient({});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function respond(statusCode: number, body: UploadResponse): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  let request: UploadRequest;
  try {
    request = JSON.parse(event.body ?? '{}') as UploadRequest;
  } catch {
    return respond(400, {
      uploadId: '',
      bucketName: '',
      key: '',
      status: 'error',
      message: 'Invalid JSON body',
    });
  }

  const { bucketName, key, fileName, contentType } = request;
  if (!bucketName || !key || !fileName || !contentType) {
    return respond(400, {
      uploadId: '',
      bucketName: bucketName ?? '',
      key: key ?? '',
      status: 'error',
      message: 'Missing required fields: bucketName, key, fileName, contentType',
    });
  }

  const uploadId = uuidv4();
  const tableName = process.env['UPLOADS_TABLE_NAME'];
  if (!tableName) {
    return respond(500, {
      uploadId: '',
      bucketName,
      key,
      status: 'error',
      message: 'Server misconfiguration: UPLOADS_TABLE_NAME not set',
    });
  }

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        pk: `UPLOAD#${uploadId}`,
        sk: 'METADATA',
        uploadId,
        bucketName,
        key,
        fileName,
        contentType,
        uploadedAt: new Date().toISOString(),
      }),
    }),
  );

  return respond(200, { uploadId, bucketName, key, status: 'success' });
};
