const NodeCache = require('node-cache');
const config = require('../config');
const { IPFS_GATEWAY, CACHE_ENABLED, CACHE_TTL_SECONDS } = config;

// Setup cache
const cache = new NodeCache({ 
  stdTTL: CACHE_TTL_SECONDS,
  checkperiod: CACHE_TTL_SECONDS * 0.2,
});

// MIME type mapping helper
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
};

/**
 * Fetch content from IPFS by CID and path, or from IPNS
 * @param {string} cidOrIpns - IPFS Content Identifier or IPNS hash (prefixed with 'ipns:')
 * @param {string} path - Optional path within the CID/IPNS
 * @returns {Promise<{data: Buffer, mimeType: string}|null>} - Content and MIME type or null
 */
async function fetchFromIpfs(cidOrIpns, path = '') {
  const isIpns = cidOrIpns.startsWith('ipns:');
  const hash = isIpns ? cidOrIpns.substring(5) : cidOrIpns;
  const contentType = isIpns ? 'ipns' : 'ipfs';
  const contentPath = path ? `${hash}/${path}` : hash;
  
  // Check cache first
  if (CACHE_ENABLED) {
    const cacheKey = `${contentType}:${contentPath}`;
    const cachedContent = cache.get(cacheKey);
    if (cachedContent) {
      console.log(`Cache hit for ${contentType.toUpperCase()} content: ${contentPath}`);
      return cachedContent;
    }
  }
  
  try {
    // Use the HTTP gateway directly
    const result = await fetchViaGateway(hash, path, contentType);
    
    if (!result) {
      return null;
    }
    
    // Determine MIME type if not set
    if (!result.mimeType) {
      result.mimeType = getMimeType(path);
    }
    
    // Cache the result
    if (CACHE_ENABLED) {
      const cacheKey = `${contentType}:${contentPath}`;
      // Use shorter TTL for IPNS content since it can change
      const ttl = isIpns ? Math.min(CACHE_TTL_SECONDS, 300) : CACHE_TTL_SECONDS;
      cache.set(cacheKey, result, ttl);
    }
    
    return result;
  } catch (error) {
    console.error(`Error fetching ${contentPath} from ${contentType.toUpperCase()}:`, error);
    return null;
  }
}

/**
 * Fetch content via IPFS HTTP gateway
 * @param {string} hash - IPFS CID or IPNS hash
 * @param {string} path - Path within the content
 * @param {string} contentType - Either 'ipfs' or 'ipns'
 * @returns {Promise<{data: Buffer, mimeType: string}|null>} - Content and MIME type or null
 */
async function fetchViaGateway(hash, path, contentType = 'ipfs') {
  try {
    const url = new URL(`${IPFS_GATEWAY}/${contentType}/${hash}${path ? '/' + path : ''}`);
    console.log(`Fetching from IPFS gateway: ${url}`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`Gateway returned ${response.status} for ${url}`);
      return null;
    }
    
    const data = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type');
    
    return { data, mimeType };
  } catch (error) {
    console.error('Gateway fetch error:', error);
    return null;
  }
}

/**
 * Determine MIME type from file path
 * @param {string} path - File path
 * @returns {string} - MIME type or default
 */
function getMimeType(path) {
  if (!path) return 'application/octet-stream';
  
  const extension = path.split('.').pop();
  if (!extension) return 'application/octet-stream';
  
  return mimeTypes['.' + extension] || 'application/octet-stream';
}

module.exports = {
  fetchFromIpfs
};
