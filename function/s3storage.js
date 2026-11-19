'use strict';
// Хранилище поверх Yandex Object Storage (S3-совместимый API).
const {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function createS3Storage({ bucket, accessKeyId, secretAccessKey, endpoint = 'https://storage.yandexcloud.net', region = 'ru-central1' }) {
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // новые версии SDK по умолчанию добавляют контрольные суммы CRC32,
    // которые ломают подписанные ссылки для браузера — отключаем
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    async getJSON(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse(await r.Body.transformToString('utf-8'));
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async putJSON(key, obj) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: JSON.stringify(obj),
        ContentType: 'application/json; charset=utf-8', CacheControl: 'no-cache',
      }));
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents || []) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async deleteMany(keys) {
      // по одному (параллельно пачками) — DeleteObjects требует контрольную сумму
      for (let i = 0; i < keys.length; i += 20) {
        await Promise.all(keys.slice(i, i + 20).map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
      }
    },
    presignPut(key, contentType) {
      return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 3600 });
    },
  };
}

module.exports = { createS3Storage };
