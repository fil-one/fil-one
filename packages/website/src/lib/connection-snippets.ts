// The copy-paste code on the API keys page's Connection details tab. Each client
// shows the same two steps, setting it up and uploading a file, so a reader can
// compare them side by side. Every one sets path-style addressing: Fil One's
// endpoints serve path-style requests only, so a client left on its
// virtual-hosted default fails on the first call. Each runs as pasted, the two
// steps in order into one file (or one shell).

/**
 * The AWS CLI profile the snippets configure. A named profile, so setting up
 * Fil One leaves the reader's default AWS credentials and settings alone.
 */
export const CLI_PROFILE = 'filone';

import type { S3Region } from '@filone/shared';
import { supportsBucketManagement } from '@filone/shared';

export type ConnectionClient = 'cli' | 'python' | 'nodejs' | 'go';

export type ConnectionSnippet = {
  /** Installs the client, or, for the CLI, configures it. */
  setup: string;
  /** Creates the client, where the client needs creating. */
  client?: string;
  /**
   * Creates a bucket, offered only on the CLI and only in a region that allows
   * creating one over S3. Everywhere else the console's Buckets page does it.
   */
  createBucket?: string;
  /** Uploads one file to a bucket. */
  upload: string;
  /** For syntax highlighting. */
  language: 'shell' | 'python' | 'javascript' | 'go';
};

/** Every client's snippet for one region, with its endpoint filled in. */
export function getConnectionSnippets(
  region: S3Region,
  endpoint: string,
): Record<ConnectionClient, ConnectionSnippet> {
  return {
    cli: {
      language: 'shell',
      setup: `aws configure set aws_access_key_id YOUR_ACCESS_KEY --profile ${CLI_PROFILE}
aws configure set aws_secret_access_key YOUR_SECRET_KEY --profile ${CLI_PROFILE}
aws configure set region ${region} --profile ${CLI_PROFILE}
aws configure set s3.addressing_style path --profile ${CLI_PROFILE}`,
      ...(supportsBucketManagement(region)
        ? {
            createBucket: `aws s3 mb s3://my-bucket --endpoint-url ${endpoint} --profile ${CLI_PROFILE}`,
          }
        : {}),
      upload: `aws s3 cp ./my-file.parquet s3://my-bucket/ --endpoint-url ${endpoint} --profile ${CLI_PROFILE}`,
    },
    python: {
      language: 'python',
      setup: 'pip install boto3',
      client: `import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="${endpoint}",
    aws_access_key_id="YOUR_ACCESS_KEY",
    aws_secret_access_key="YOUR_SECRET_KEY",
    region_name="${region}",
    config=Config(s3={"addressing_style": "path"}),
)`,
      upload: `s3.upload_file("my-file.parquet", "my-bucket", "my-file.parquet")`,
    },
    nodejs: {
      language: 'javascript',
      setup: 'npm install @aws-sdk/client-s3',
      // `import` and a top-level `await` need an ES module, which the .mjs
      // file name gives without touching package.json.
      client: `// upload.mjs
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";

const s3 = new S3Client({
  endpoint: "${endpoint}",
  region: "${region}",
  credentials: {
    accessKeyId: "YOUR_ACCESS_KEY",
    secretAccessKey: "YOUR_SECRET_KEY",
  },
  forcePathStyle: true,
});`,
      upload: `await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "my-file.parquet",
  Body: createReadStream("./my-file.parquet"),
}));`,
    },
    go: {
      language: 'go',
      setup: `go get github.com/aws/aws-sdk-go-v2/config github.com/aws/aws-sdk-go-v2/credentials github.com/aws/aws-sdk-go-v2/service/s3`,
      // Two top-level pieces of one main.go, so each step pastes after the last.
      client: `package main

import (
    "context"
    "log"
    "os"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func newClient(ctx context.Context) *s3.Client {
    cfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("${region}"),
        config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
            "YOUR_ACCESS_KEY", "YOUR_SECRET_KEY", "",
        )),
    )
    if err != nil {
        log.Fatal(err)
    }
    return s3.NewFromConfig(cfg, func(o *s3.Options) {
        o.BaseEndpoint = aws.String("${endpoint}")
        o.UsePathStyle = true
    })
}`,
      upload: `func main() {
    ctx := context.TODO()
    client := newClient(ctx)

    file, err := os.Open("./my-file.parquet")
    if err != nil {
        log.Fatal(err)
    }
    defer file.Close()

    _, err = client.PutObject(ctx, &s3.PutObjectInput{
        Bucket: aws.String("my-bucket"),
        Key:    aws.String("my-file.parquet"),
        Body:   file,
    })
    if err != nil {
        log.Fatal(err)
    }
}`,
    },
  };
}
