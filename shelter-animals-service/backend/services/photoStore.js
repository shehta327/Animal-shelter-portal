// Photos live in a PRIVATE S3 bucket (PHOTOS_BUCKET). The browser never gets
// bucket credentials: it receives short-lived presigned URLs instead.
//   upload: presigned PUT, 5 minutes, content type fixed in the signature
//   view:   presigned GET, 15 minutes
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.PHOTOS_BUCKET || 'shelter-animal-photos';
// Floci (and other emulators) need path-style URLs: http://host:4566/bucket/key
const s3 = new S3Client({ forcePathStyle: true });

const uploadUrl = (key, contentType) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: 300 });

const viewUrl = (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 900 });

async function head(key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: r.ContentLength, contentType: r.ContentType };
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

const remove = (key) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

module.exports = { uploadUrl, viewUrl, head, remove };
