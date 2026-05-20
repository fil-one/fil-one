import { describe, it, expect } from 'vitest';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
} from './service-orchestrator.js';

describe('service-orchestrator error classes', () => {
  describe('BucketAlreadyExistsError', () => {
    it('carries the bucket name in its message', () => {
      const err = new BucketAlreadyExistsError('my-bucket');
      expect(err.message).toBe('Bucket "my-bucket" already exists');
    });

    it('has a stable name for instanceof / catch routing', () => {
      const err = new BucketAlreadyExistsError('my-bucket');
      expect(err.name).toBe('BucketAlreadyExistsError');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BucketAlreadyExistsError);
    });
  });

  describe('AccessKeyAlreadyExistsError', () => {
    it('has a stable name and default message', () => {
      const err = new AccessKeyAlreadyExistsError();
      expect(err.name).toBe('AccessKeyAlreadyExistsError');
      expect(err.message).toBe('An access key with this name already exists');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('AccessKeyValidationError', () => {
    it('preserves the validation message', () => {
      const err = new AccessKeyValidationError('Key name contains invalid characters');
      expect(err.name).toBe('AccessKeyValidationError');
      expect(err.message).toBe('Key name contains invalid characters');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
