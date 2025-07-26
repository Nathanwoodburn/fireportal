require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const { resolveHandshake, clearCache, clearIpnsCache } = require('./lib/handshake');
const { fetchFromIpfs } = require('./lib/ipfs');
const { PORT } = require('./config');

const app = express();

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Add a request logger middleware at the very beginning
app.use((req, res, next) => {
  console.log('\n----- NEW REQUEST -----');
  console.log(`${req.method} ${req.url}`);
  console.log(`Headers: ${JSON.stringify({
    host: req.get('host'),
    referer: req.get('referer'),
    'user-agent': req.get('user-agent')
  }, null, 2)}`);
  next();
});

// Define the main dashboard host
// This should be configurable via environment variable
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '127.0.0.1:3000';

// Define reserved paths that should not be treated as Handshake domains
const RESERVED_PATHS = [
  'api',
  'hns',
  'public',
  'assets',
  'static',
  'images',
  'css',
  'js',
  'favicon.ico'
];

// Helper function to normalize host strings for comparison
function normalizeHost(host) {
  if (!host) return '';
  // Remove port if present and convert to lowercase
  const normalized = host.split(':')[0].toLowerCase();
  console.log(`Normalizing host: ${host} -> ${normalized}`);
  return normalized;
}

// IMPORTANT: Move direct domain access middleware before static file serving
// Middleware to check if request is for direct domain access
app.use(async (req, res, next) => {
  const host = req.get('host');
  const normalizedHost = normalizeHost(host);
  const normalizedDashboardHost = normalizeHost(DASHBOARD_HOST);
  
  console.log(`[HOST CHECK] Request host: ${host}, Normalized: ${normalizedHost}, Dashboard: ${normalizedDashboardHost}`);
  
  // Special handling for curl requests with Host header
  if (normalizedHost !== normalizedDashboardHost) {
    console.log(`[HOST CHECK] Host ${normalizedHost} doesn't match dashboard ${normalizedDashboardHost}, treating as direct access`);
    
    // Skip direct domain handling for API endpoints
    if (req.path.startsWith('/api/')) {
      console.log(`[HOST CHECK] Skipping direct domain handling for API endpoint: ${req.path}`);
      return next();
    }
    
    // Extract domain from the hostname
    const domain = normalizedHost;
    console.log(`[DIRECT ACCESS] Using domain: ${domain} from host: ${host}`);
    
    try {
      return await handleDirectDomainAccess(req, res, domain);
    } catch (error) {
      console.error(`[HOST CHECK] Error handling direct access, falling back to normal processing: ${error}`);
      // Fall back to normal processing if direct access fails
      return next();
    }
  }
  
  console.log(`[HOST CHECK] Host ${normalizedHost} matches dashboard ${normalizedDashboardHost}, continuing with normal processing`);
  // Continue with normal processing for dashboard host
  next();
});

// Serve static files AFTER checking for direct domain access
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to inject tracking script into HTML content
function injectTrackingScript(content, mimeType) {
  if (mimeType && mimeType.includes('text/html')) {
    const trackingScript = '<script async src="https://umami.woodburn.au/script.js" data-website-id="2ced0833-1c76-4684-880d-65afb58f16f2"></script>';
    
    let htmlContent = content.toString();
    
    // Try to inject before </body>
    if (htmlContent.includes('</body>')) {
      return htmlContent.replace('</body>', `${trackingScript}</body>`);
    }
    // Or try to inject before </html> if no </body> found
    else if (htmlContent.includes('</html>')) {
      return htmlContent.replace('</html>', `${trackingScript}</html>`);
    }
    // Otherwise append to the end
    else {
      return htmlContent + trackingScript;
    }
  }
  return content;
}

// Helper function to make links absolute in HTML content
function makeLinksAbsolute(content, mimeType, domain, subPath = '', isDirectAccess = false) {
  if (!mimeType || !mimeType.includes('text/html')) {
    return content;
  }

  let htmlContent = content.toString();
  // If direct access (via subdomain), don't prefix links with domain
  const baseUrl = isDirectAccess ? '' : `/${domain}`;
  
  // Create base directory for proper path resolution
  let basePath = '/';
  if (subPath) {
    // Improve directory path calculation
    const lastSegmentHasExtension = subPath.split('/').pop().includes('.');
    
    if (lastSegmentHasExtension) {
      // If the current path is a file, use its directory
      const pathParts = subPath.split('/');
      pathParts.pop(); // Remove the file part
      basePath = pathParts.length ? `/${pathParts.join('/')}/` : '/';
    } else if (!subPath.endsWith('/')) {
      // Ensure directory paths end with /
      basePath = `/${subPath}/`;
    } else {
      basePath = `/${subPath}`;
    }
  }
  
  // Function to resolve paths
  const resolvePath = (href, isStylesheet = false) => {
    // Don't modify stylesheet URLs - keep them relative to preserve internal references
    if (isStylesheet) {
      return href;
    }
    
    if (href.startsWith('/')) {
      // Absolute path within the site - make it absolute to our gateway
      return `${baseUrl}${href}`;
    } else if (!href.match(/^(https?:|mailto:|tel:|#|javascript:|data:)/)) {
      // Relative path - resolve it against current directory
      return `${baseUrl}${basePath}${href}`;
    }
    return href; // Already absolute or special protocol
  };

  // Handle stylesheet links specially
  htmlContent = htmlContent.replace(/<link\s+([^>]*rel=['"]stylesheet['"][^>]*)>/gi, (match, attrs) => {
    // Don't modify the href in stylesheet links
    return match;
  });

  // Replace href attributes in non-stylesheet elements
  htmlContent = htmlContent.replace(/<a\s+([^>]*href=['"]([^'"]+)['"][^>]*)>/gi, (match, attrs, href) => {
    return match.replace(`href="${href}"`, `href="${resolvePath(href)}"`) 
               .replace(`href='${href}'`, `href='${resolvePath(href)}'`);
  });

  // Replace src attributes carefully - don't touch CSS related ones
  htmlContent = htmlContent.replace(/src=["'](.*?)["']/g, (match, src) => {
    if (src.endsWith('.css')) {
      return match; // Don't modify CSS srcs
    }
    return `src="${resolvePath(src)}"`;
  });

  return htmlContent;
}

// Helper function to handle direct domain access
async function handleDirectDomainAccess(req, res, domain) {
  console.log(`[DIRECT ACCESS] Starting direct domain access handler for: ${domain}`);
  try {
    // Remove trailing slash from path for consistency
    let subPath = req.path || '';
    if (subPath === '/' || subPath === '') {
      subPath = '';
    }
    
    console.log(`[DIRECT ACCESS] Domain: ${domain}, Path: '${subPath}'`);
    
    // Resolve Handshake domain to get IPFS CID
    console.log(`[DIRECT ACCESS] Resolving Handshake domain: ${domain}`);
    const cid = await resolveHandshake(domain);
    
    if (!cid) {
      console.warn(`[DIRECT ACCESS] No IPFS CID found for domain: ${domain}`);
      return res.status(404).json({ 
        error: 'Domain not found or has no IPFS record',
        domain: domain
      });
    }
    
    console.log(`[DIRECT ACCESS] Resolved ${domain} to IPFS CID: ${cid}`);
    
    // Fetch content from IPFS - handle root path specially
    const path = subPath === '' ? '' : (subPath.startsWith('/') ? subPath.substring(1) : subPath);
    console.log(`[DIRECT ACCESS] Fetching IPFS content for CID: ${cid}, path: '${path}'`);
    let content = await fetchFromIpfs(cid, path);
    
    if (!content) {
      console.log(`[DIRECT ACCESS] No content found for path: '${path}'`);
      // Try index.html for empty paths
      if (path === '') {
        console.log('[DIRECT ACCESS] Trying index.html for root path');
        const indexContent = await fetchFromIpfs(cid, 'index.html');
        if (indexContent) {
          console.log('[DIRECT ACCESS] Found index.html content, using that instead');
          content = indexContent;
        } else {
          console.log('[DIRECT ACCESS] No index.html found either');
        }
      }
      
      // If still no content, return 404
      if (!content) {
        console.log(`[DIRECT ACCESS] Returning 404 for CID: ${cid}, path: '${path}'`);
        return res.status(404).json({ 
          error: 'Content not found on IPFS network',
          cid: cid,
          path: path
        });
      }
    }
    
    // Set appropriate content type
    if (content.mimeType) {
      console.log(`[DIRECT ACCESS] Setting content type: ${content.mimeType}`);
      res.setHeader('Content-Type', content.mimeType);
    }
    
    // Process HTML content: make links absolute and inject tracking script
    console.log('[DIRECT ACCESS] Processing content');
    let processedContent = content.data;
    if (content.mimeType && content.mimeType.includes('text/html')) {
      console.log('[DIRECT ACCESS] HTML content detected, making links absolute');
      processedContent = makeLinksAbsolute(processedContent, content.mimeType, domain, path, true);
      console.log('[DIRECT ACCESS] Injecting tracking script');
      processedContent = injectTrackingScript(processedContent, content.mimeType);
    }
    
    // Return the content
    console.log('[DIRECT ACCESS] Sending processed content');
    return res.send(processedContent);
  } catch (error) {
    console.error('[DIRECT ACCESS] Error handling direct domain access:', error);
    throw error; // Rethrow so middleware can fall back to normal processing
  }
}

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', version: '1.0.0' });
});

// New route: Handle root domain requests with direct domain format
app.get('/:domain', async (req, res, next) => {
  const domain = req.params.domain;
  
  console.log(`[DASHBOARD ROUTE] Processing /:domain request for: ${domain}`);
  
  // Skip this handler for reserved paths
  if (RESERVED_PATHS.includes(domain)) {
    console.log(`[DASHBOARD ROUTE] Domain '${domain}' is in reserved paths, skipping`);
    return next();
  }
  
  try {
    console.log(`[DASHBOARD ROUTE] Processing request for domain root: ${domain}`);
    
    // Resolve Handshake domain to get IPFS CID
    const cid = await resolveHandshake(domain);
    
    if (!cid) {
      console.warn(`No IPFS CID found for domain: ${domain}`);
      return res.status(404).json({ 
        error: 'Domain not found or has no IPFS record',
        domain: domain
      });
    }
    
    console.log(`Resolved ${domain} to IPFS CID: ${cid}`);
    
    // Fetch content from IPFS (root path)
    const content = await fetchFromIpfs(cid, '');
    
    if (!content) {
      return res.status(404).json({ 
        error: 'Content not found on IPFS network',
        cid: cid
      });
    }
    
    // Set appropriate content type
    if (content.mimeType) {
      res.setHeader('Content-Type', content.mimeType);
    }
    
    // Process HTML content: make links absolute and inject tracking script
    let processedContent = content.data;
    if (content.mimeType && content.mimeType.includes('text/html')) {
      processedContent = makeLinksAbsolute(processedContent, content.mimeType, domain, '');
      processedContent = injectTrackingScript(processedContent, content.mimeType);
    }
    
    // Return the content
    res.send(processedContent);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ 
      error: 'Server error processing request',
      message: error.message 
    });
  }
});

// New route: Handle domain requests with subpaths using direct domain format
app.get('/:domain/*', async (req, res, next) => {
  const domain = req.params.domain;
  
  // Skip this handler for reserved paths
  if (RESERVED_PATHS.includes(domain)) {
    return next();
  }
  
  try {
    const subPath = req.params[0] || '';
    
    console.log(`Processing request for domain: ${domain}, path: ${subPath}`);
    
    // Resolve Handshake domain to get IPFS CID
    const cid = await resolveHandshake(domain);
    
    if (!cid) {
      console.warn(`No IPFS CID found for domain: ${domain}`);
      return res.status(404).json({ 
        error: 'Domain not found or has no IPFS record',
        domain: domain
      });
    }
    
    console.log(`Resolved ${domain} to IPFS CID: ${cid}`);
    
    // Fetch content from IPFS
    const content = await fetchFromIpfs(cid, subPath);
    
    if (!content) {
      return res.status(404).json({ 
        error: 'Content not found on IPFS network',
        cid: cid,
        path: subPath
      });
    }
    
    // Set appropriate content type
    if (content.mimeType) {
      res.setHeader('Content-Type', content.mimeType);
    }
    
    // Process HTML content: make links absolute and inject tracking script
    let processedContent = content.data;
    if (content.mimeType && content.mimeType.includes('text/html')) {
      processedContent = makeLinksAbsolute(processedContent, content.mimeType, domain, subPath);
      processedContent = injectTrackingScript(processedContent, content.mimeType);
    }
    
    // Return the content
    res.send(processedContent);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ 
      error: 'Server error processing request',
      message: error.message 
    });
  }
});

// Routes (keeping original routes for backward compatibility)
app.get('/hns/:domain/*', async (req, res) => {
  try {
    const domain = req.params.domain;
    const subPath = req.params[0] || '';
    
    console.log(`Processing request for domain: ${domain}, path: ${subPath}`);
    
    // Resolve Handshake domain to get IPFS CID
    const cid = await resolveHandshake(domain);
    
    if (!cid) {
      console.warn(`No IPFS CID found for domain: ${domain}`);
      return res.status(404).json({ 
        error: 'Domain not found or has no IPFS record',
        domain: domain
      });
    }
    
    console.log(`Resolved ${domain} to IPFS CID: ${cid}`);
    
    // Fetch content from IPFS
    const content = await fetchFromIpfs(cid, subPath);
    
    if (!content) {
      return res.status(404).json({ 
        error: 'Content not found on IPFS network',
        cid: cid,
        path: subPath
      });
    }
    
    // Set appropriate content type
    if (content.mimeType) {
      res.setHeader('Content-Type', content.mimeType);
    }
    
    // Process HTML content: make links absolute and inject tracking script
    let processedContent = content.data;
    if (content.mimeType && content.mimeType.includes('text/html')) {
      processedContent = makeLinksAbsolute(processedContent, content.mimeType, domain, subPath);
      processedContent = injectTrackingScript(processedContent, content.mimeType);
    }
    
    // Return the content
    res.send(processedContent);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ 
      error: 'Server error processing request',
      message: error.message 
    });
  }
});

// Also add a route without the trailing wildcard to handle root domain requests
app.get('/hns/:domain', async (req, res) => {
  try {
    const domain = req.params.domain;
    
    console.log(`Processing request for domain root: ${domain}`);
    
    // Resolve Handshake domain to get IPFS CID
    const cid = await resolveHandshake(domain);
    
    if (!cid) {
      console.warn(`No IPFS CID found for domain: ${domain}`);
      return res.status(404).json({ 
        error: 'Domain not found or has no IPFS record',
        domain: domain
      });
    }
    
    console.log(`Resolved ${domain} to IPFS CID: ${cid}`);
    
    // Fetch content from IPFS (root path)
    const content = await fetchFromIpfs(cid, '');
    
    if (!content) {
      return res.status(404).json({ 
        error: 'Content not found on IPFS network',
        cid: cid
      });
    }
    
    // Set appropriate content type
    if (content.mimeType) {
      res.setHeader('Content-Type', content.mimeType);
    }
    
    // Process HTML content: make links absolute and inject tracking script
    let processedContent = content.data;
    if (content.mimeType && content.mimeType.includes('text/html')) {
      processedContent = makeLinksAbsolute(processedContent, content.mimeType, domain, '');
      processedContent = injectTrackingScript(processedContent, content.mimeType);
    }
    
    // Return the content
    res.send(processedContent);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ 
      error: 'Server error processing request',
      message: error.message 
    });
  }
});

// API route to force refresh IPFS content
app.get('/api/refresh/:domain', async (req, res) => {
    try {
        const domain = req.params.domain;
        
        // Validate domain name format
        if (!domain.match(/^[a-z0-9-_]+(\.[a-z0-9-_]+)*\/?$/i)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid domain format' 
            });
        }
        
        console.log(`Refreshing content for domain: ${domain}`);
        // Clear cache for the domain
        clearCache(domain);

        
        // Return success response
        res.json({
            success: true,
            message: `Refresh initiated for ${domain}`,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during refresh operation'
        });
    }
});

// New API route to refresh IPNS cache specifically
app.get('/api/refresh-ipns/:ipnsName', async (req, res) => {
    try {
        const ipnsName = req.params.ipnsName;
        
        // Validate IPNS name format (basic validation)
        if (!ipnsName.match(/^[a-zA-Z0-9]+$/)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid IPNS name format' 
            });
        }
        
        console.log(`Refreshing IPNS cache for: ${ipnsName}`);
        // Clear IPNS cache
        clearIpnsCache(ipnsName);
        
        // Return success response
        res.json({
            success: true,
            message: `IPNS cache refresh initiated for ${ipnsName}`,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('IPNS refresh error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during IPNS refresh operation'
        });
    }
});

// Catch-all route to handle SPA navigation
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`\n==================================`);
  console.log(`Fire Portal server running on port ${PORT}`);
  console.log(`Dashboard host: ${DASHBOARD_HOST}`);
  console.log(`==================================\n`);
});
