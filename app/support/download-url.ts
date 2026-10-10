import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { URL } from 'url';
import { pipeline, finished } from 'stream/promises';

import meter from 'stream-meter';
import { MediaType } from 'media-type';
import config from 'config';

import {
  SAFE_OUTBOUND_MAX_REDIRECTS,
  safeOutboundRequest,
  type SafeOutboundResponse,
} from './safe-outbound-request';

const sizeLimits = config.attachments.fileSizeLimitByType;

// Total time budget for DNS, redirects and the streamed body.
const downloadTimeoutMs = 15_000;

const firstValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

// Creates the temp file exclusively: the open fails if the path already
// exists, so the file cannot be swapped for another process's file.
async function createTempFile(ext: string) {
  for (let attempt = 0; ; attempt++) {
    const bytes = crypto.randomBytes(4).readUInt32LE(0);
    const filePath = `/tmp/pepyatka${bytes}tmp${ext}`;

    try {
      // eslint-disable-next-line no-await-in-loop
      const handle = await fs.open(filePath, 'wx');
      return { filePath, outStream: handle.createWriteStream() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST' || attempt >= 4) {
        throw e;
      }
    }
  }
}

export async function downloadURL(
  url: string,
  sizeLimit = sizeLimits['image'] ?? sizeLimits['default'],
) {
  const parsedURL = new URL(url);

  if (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') {
    throw new Error('Unsupported URL protocol');
  }

  const parsedPath = path.parse(parsedURL.pathname);
  const originalFileName = parsedPath.base !== '' ? decodeURIComponent(parsedPath.base) : 'file';

  // The download target is arranged before the request starts: the response
  // body starts flowing on return, so its pipeline (the error owner) must
  // attach synchronously, with no await in between.
  const { filePath, outStream } = await createTempFile(parsedPath.ext);

  let response: SafeOutboundResponse | null = null;

  try {
    response = await safeOutboundRequest(parsedURL, {
      timeoutMs: downloadTimeoutMs,
      maxRedirects: SAFE_OUTBOUND_MAX_REDIRECTS,
      maxBytes: sizeLimit,
      // No consumer restriction beyond public http(s) destinations.
      allowURL: () => true,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP error: ${response.status} ${response.statusMessage}`);
    }

    const mType = MediaType.parse(firstValue(response.headers['content-type']) || '');

    // if (mType.type !== 'image') {
    //   throw new Error(`Unsupported content type: '${mType.asString() || '-'}'`);
    // }

    const contentLengthValue = firstValue(response.headers['content-length']);

    if (contentLengthValue !== undefined) {
      const contentLength = parseInt(contentLengthValue);

      if (!isNaN(contentLength) && contentLength > sizeLimit) {
        throw new Error(`File is too large (${contentLength} bytes, max. ${sizeLimit})`);
      }
    }

    const inStream = response.body;
    await pipeline(inStream, meter(sizeLimit), outStream);
    await finished(outStream); // wait for the file to be written and closed

    const stats = await fs.stat(filePath);

    return {
      name: originalFileName,
      size: stats.size,
      type: mType?.toString() || 'application/octet-stream',
      path: filePath,
      unlink() {
        return fs.unlink(this.path);
      },
    };
  } catch (e) {
    response?.cancel();
    // The output stream was created before the request; close it when the
    // pipeline never ran (a no-op when pipeline already tore it down).
    outStream.destroy();
    // Removes only the file created by this request; cleanup failures never
    // mask the original error.
    await fs.unlink(filePath).catch(() => undefined);
    throw e;
  }
}
