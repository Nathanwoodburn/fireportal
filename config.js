require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  
  // IPFS settings
  IPFS_GATEWAY: process.env.IPFS_GATEWAY || 'https://ipfs.io',
  IPFS_API_URL: process.env.IPFS_API_URL,
  IPFS_API_PORT: process.env.IPFS_API_PORT || 5001,
  
  // Handshake settings
  RESOLUTION_METHOD: process.env.RESOLUTION_METHOD || 'doh', // Options: 'doh', 'dot', 'local'
  
  // HNSDoH.com settings
  HNS_DOH_URL: process.env.HNS_DOH_URL || 'https://hnsdoh.com/dns-query',
  HNS_DOT_HOST: process.env.HNS_DOT_HOST || 'hnsdoh.com',
  HNS_DOT_PORT: parseInt(process.env.HNS_DOT_PORT || '853', 10),
  
  // Local resolver settings
  LOCAL_RESOLVER_HOST: process.env.LOCAL_RESOLVER_HOST || '127.0.0.1',
  LOCAL_RESOLVER_PORT: process.env.LOCAL_RESOLVER_PORT || 53,
  
  // Cache settings
  CACHE_ENABLED: process.env.CACHE_ENABLED !== 'false',
  CACHE_TTL_SECONDS: parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10),
  
  // Log settings
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};
