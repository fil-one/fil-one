import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});

export class FileStorageClient {
  constructor(private bucketName: string) {}

  async put(key: string, body: Buffer, contentType: string): Promise<{ etag: string }> {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { etag: result.ETag ?? '' };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
    const bytes = await result.Body!.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }

  async getPresignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: this.bucketName, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
