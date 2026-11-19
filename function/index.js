'use strict';
// Точка входа Yandex Cloud Function: index.handler
const { createHandler } = require('./handler');
const { createS3Storage } = require('./s3storage');

let handler;
module.exports.handler = async (event) => {
  if (!handler) {
    handler = createHandler({
      storage: createS3Storage({
        bucket: process.env.SITES_BUCKET,
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
      }),
      password: process.env.UPLOAD_PASSWORD,
      uiOrigin: process.env.UI_ORIGIN || '*',
      maxTotalMb: Number(process.env.MAX_SITE_MB) || 200,
    });
  }
  return handler(event);
};
