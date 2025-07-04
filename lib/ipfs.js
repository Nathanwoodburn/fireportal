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
 * Fetch content from IPFS by CID and path
 * @param {string} cid - IPFS Content Identifier
 * @param {string} path - Optional path within the CID
 * @returns {Promise<{data: Buffer, mimeType: string}|null>} - Content and MIME type or null
 */
async function fetchFromIpfs(cid, path = '') {
  const contentPath = path ? `${cid}/${path}` : cid;
  
  // Check cache first
  if (CACHE_ENABLED) {
    const cachedContent = cache.get(`ipfs:${contentPath}`);
    if (cachedContent) {
      console.log(`Cache hit for IPFS content: ${contentPath}`);
      return cachedContent;
    }
  }
  
  try {
    // Use the HTTP gateway directly instead of the IPFS client
    const result = await fetchViaGateway(cid, path);
    
    if (!result) {
      return null;
    }
    
    // Determine MIME type if not set
    if (!result.mimeType) {
      result.mimeType = getMimeType(path);
    }
    
    // Cache the result
    if (CACHE_ENABLED) {
      cache.set(`ipfs:${contentPath}`, result);
    }
    
    return result;
  } catch (error) {
    console.error(`Error fetching ${contentPath} from IPFS:`, error);
    return null;
  }
}

/**
 * Fetch content via IPFS HTTP gateway
 * @param {string} cid - IPFS Content Identifier
 * @param {string} path - Path within the CID
 * @returns {Promise<{data: Buffer, mimeType: string}|null>} - Content and MIME type or null
 */
async function fetchViaGateway(cid, path) {
  try {
    const url = new URL(`${IPFS_GATEWAY}/ipfs/${cid}${path ? '/' + path : ''}`);
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
