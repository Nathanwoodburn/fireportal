const dns = require('dns').promises;
const NodeCache = require('node-cache');
const config = require('../config');
const { 
  RESOLUTION_METHOD, 
  HNS_DOH_URL, 
  HNS_DOT_HOST, 
  HNS_DOT_PORT, 
  LOCAL_RESOLVER_HOST, 
  LOCAL_RESOLVER_PORT, 
  CACHE_ENABLED, 
  CACHE_TTL_SECONDS 
} = config;

// Setup cache
const cache = new NodeCache({ 
  stdTTL: CACHE_TTL_SECONDS,
  checkperiod: CACHE_TTL_SECONDS * 0.2,
});

/**
 * Resolve a Handshake domain to an IPFS CID
 * @param {string} domain - The Handshake domain to resolve
 * @returns {Promise<string|null>} - IPFS CID or null if not found
 */
async function resolveHandshake(domain) {
  // Check cache first
  if (CACHE_ENABLED) {
    const cachedCid = cache.get(`hns:${domain}`);
    if (cachedCid) {
      console.log(`Cache hit for ${domain}`);
      return cachedCid;
    }
  }

  try {
    let cid = null;
    
    // Choose resolution method based on configuration
    switch (RESOLUTION_METHOD) {
      case 'doh':
        console.log(`Resolving ${domain} using DNS-over-HTTPS via HNSDoH.com`);
        cid = await resolveViaDoH(domain);
        break;
      case 'dot':
        console.log(`Resolving ${domain} using DNS-over-TLS via HNSDoH.com`);
        cid = await resolveViaDot(domain);
        break;
      case 'local':
        console.log(`Resolving ${domain} using local resolver`);
        cid = await resolveLocal(domain);
        break;
      default:
        // Default to DoH if method is not recognized
        console.log(`Unknown resolution method, defaulting to DoH for ${domain}`);
        cid = await resolveViaDoH(domain);
        break;
    }
    
    // Cache the result if we got a valid CID
    if (cid && CACHE_ENABLED) {
      cache.set(`hns:${domain}`, cid);
    }
    
    return cid;
  } catch (error) {
    console.error(`Error resolving ${domain}:`, error);
    return null;
  }
}

/**
 * Resolve domain using DNS-over-HTTPS via HNSDoH.com
 * @param {string} domain - The domain to resolve
 * @returns {Promise<string|null>} - IPFS CID or null
 */
async function resolveViaDoH(domain) {
  try {
    console.log(`Using wire format DoH for ${domain}`);
    
    // Create the DNS wire format query
    const queryId = Math.floor(Math.random() * 65535);
    const wireQuery = createDnsWireQuery(domain, queryId, 16); // 16 is TXT record type
    
    // Send the DNS-over-HTTPS query using wire format
    const response = await fetch(HNS_DOH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message'
      },
      body: wireQuery
    });
    
    if (!response.ok) {
      throw new Error(`DoH query failed with status ${response.status}`);
    }
    
    // Parse the wire format response
    const responseBuffer = await response.arrayBuffer();
    const txtRecords = parseDnsWireResponse(new Uint8Array(responseBuffer));
    
    if (txtRecords && txtRecords.length > 0) {
      // Extract IPFS CID from TXT records
      return extractCidFromRecords(txtRecords.map(txt => [txt]));
    }
    
    return null;
  } catch (error) {
    console.error('DoH resolution error:', error);
    return null;
  }
}

/**
 * Create a DNS wire format query
 * @param {string} domain - Domain name to query
 * @param {number} id - Query ID
 * @param {number} type - Record type (e.g. 16 for TXT)
 * @returns {Uint8Array} - Wire format DNS query
 */
function createDnsWireQuery(domain, id, type) {
  // DNS header: 12 bytes
  // ID (2 bytes) + Flags (2 bytes) + QDCOUNT (2 bytes) + ANCOUNT (2 bytes) + NSCOUNT (2 bytes) + ARCOUNT (2 bytes)
  const header = new Uint8Array(12);
  
  // Set ID (2 bytes)
  header[0] = (id >> 8) & 0xff;
  header[1] = id & 0xff;
  
  // Set flags (RD = 1)
  header[2] = 0x01; // QR=0, OPCODE=0, AA=0, TC=0, RD=1
  header[3] = 0x00; // RA=0, Z=0, RCODE=0
  
  // Set QDCOUNT = 1 (we're making 1 query)
  header[4] = 0x00;
  header[5] = 0x01;
  
  // ANCOUNT, NSCOUNT, ARCOUNT all 0
  
  // Prepare the domain name in DNS format (length-prefixed labels)
  const labels = domain.split('.');
  let domainBuffer = [];
  
  for (const label of labels) {
    if (label.length > 0) {
      domainBuffer.push(label.length);
      for (let i = 0; i < label.length; i++) {
        domainBuffer.push(label.charCodeAt(i));
      }
    }
  }
  
  // Add terminating zero
  domainBuffer.push(0);
  
  // Add QTYPE (16 = TXT) and QCLASS (1 = IN)
  domainBuffer = domainBuffer.concat([0x00, type, 0x00, 0x01]);
  
  // Combine header and query
  const query = new Uint8Array(header.length + domainBuffer.length);
  query.set(header);
  query.set(domainBuffer, header.length);
  
  return query;
}

/**
 * Parse a DNS wire format response for TXT records
 * @param {Uint8Array} response - Wire format DNS response
 * @returns {string[]} - Array of TXT record values
 */
function parseDnsWireResponse(response) {
  try {
    // Extract basic header information
    const id = (response[0] << 8) | response[1];
    const flags = (response[2] << 8) | response[3];
    const qdCount = (response[4] << 8) | response[5];
    const anCount = (response[6] << 8) | response[7];
    const nsCount = (response[8] << 8) | response[9];
    const arCount = (response[10] << 8) | response[11];
    
    // Check if response code indicates an error
    const rcode = flags & 0x0f;
    if (rcode !== 0) {
      console.error(`DNS response code error: ${rcode}`);
      return [];
    }
    
    // Skip over the question section
    let offset = 12;
    for (let i = 0; i < qdCount; i++) {
      // Skip domain name until we reach a terminator or a pointer
      while (offset < response.length) {
        const len = response[offset++];
        if (len === 0) break;
        if ((len & 0xc0) === 0xc0) {
          // This is a pointer (2 bytes)
          offset++;
          break;
        }
        offset += len;
      }
      
      // Skip QTYPE and QCLASS (4 bytes)
      offset += 4;
    }
    
    // Process answer section for TXT records
    const txtRecords = [];
    for (let i = 0; i < anCount; i++) {
      // Skip the name field until we reach a terminator or a pointer
      while (offset < response.length) {
        const len = response[offset++];
        if (len === 0) break;
        if ((len & 0xc0) === 0xc0) {
          // This is a pointer (2 bytes)
          offset++;
          break;
        }
        offset += len;
      }
      
      // Read TYPE, CLASS, TTL, RDLENGTH (10 bytes total)
      const type = (response[offset] << 8) | response[offset + 1];
      offset += 8; // Skip TYPE, CLASS, TTL
      const rdLength = (response[offset] << 8) | response[offset + 1];
      offset += 2;
      
      // If this is a TXT record (type 16), extract it
      if (type === 16) {
        let txt = '';
        const endOffset = offset + rdLength;
        
        // TXT record format: each string prefixed by a length byte
        while (offset < endOffset) {
          const strLen = response[offset++];
          for (let j = 0; j < strLen; j++) {
            txt += String.fromCharCode(response[offset + j]);
          }
          offset += strLen;
        }
        
        txtRecords.push(txt);
      } else {
        // Skip this record
        offset += rdLength;
      }
    }
    
    return txtRecords;
  } catch (error) {
    console.error('Error parsing DNS wire response:', error);
    return [];
  }
}

/**
 * Resolve domain using DNS-over-TLS via HNSDoH.com
 * Note: This requires a DoT client implementation.
 * Since Node.js doesn't have a built-in DoT client, this is a placeholder.
 * In a production environment, use a proper DoT client library.
 * @param {string} domain - The domain to resolve
 * @returns {Promise<string|null>} - IPFS CID or null
 */
async function resolveViaDot(domain) {
  console.warn('DNS-over-TLS resolution is not fully implemented. Using DoH as fallback.');
  // In a real implementation, you would:
  // 1. Establish a TLS connection to HNS_DOT_HOST:HNS_DOT_PORT
  // 2. Send a DNS query for TXT records
  // 3. Parse the response and extract the IPFS CID
  
  // For now, fallback to DoH
  return resolveViaDoH(domain);
}

/**
 * Resolve domain using local DNS resolver
 * @param {string} domain - The domain to resolve
 * @returns {Promise<string|null>} - IPFS CID or null
 */
async function resolveLocal(domain) {
  try {
    // Configure DNS resolver to use local nameserver
    const resolver = new dns.Resolver();
    resolver.setServers([`${LOCAL_RESOLVER_HOST}:${LOCAL_RESOLVER_PORT}`]);
    
    // Try to get TXT records
    const records = await resolver.resolveTxt(`${domain}.`);
    
    // Look for IPFS CID in TXT records
    return extractCidFromRecords(records);
  } catch (error) {
    console.error('Local resolver error:', error);
    return null;
  }
}

/**
 * Extract IPFS CID from DNS TXT records
 * @param {string[][]} records - Array of TXT record arrays
 * @returns {string|null} - IPFS CID or null
 */
function extractCidFromRecords(records) {
  if (!records || !records.length) {
    return null;
  }
  
  // Flatten and look for ipfs= or ip6= prefixes
  for (const recordSet of records) {
    for (const record of recordSet) {
      // Support multiple formats
      if (record.startsWith('ipfs=')) {
        return record.substring(5);
      }
      if (record.startsWith('ipfs:')) {
        return record.substring(5);
      }
      if (record.startsWith('ip6=')) {
        return record.substring(4);
      }
      
      // Log the record for debugging
      console.log(`Found TXT record: ${record}`);
    }
  }
  
  return null;
}


/**
 * Clear the cache for a specific domain
 * @param {string} domain - The Handshake domain to clear from cache
 */
function clearCache(domain) {
  if (CACHE_ENABLED) {
    cache.del(`hns:${domain}`);
    console.log(`Cache cleared for ${domain}`);
  }
}

module.exports = {
  resolveHandshake,
  clearCache
};
