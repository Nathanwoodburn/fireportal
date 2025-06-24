require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const { resolveHandshake, clearCache } = require('./lib/handshake');
const { fetchFromIpfs } = require('./lib/ipfs');
const { PORT } = require('./config');

const app = express();

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

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

// Serve static files
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
  try {
    const subPath = req.path || '';
    
    console.log(`Direct access for domain: ${domain}, path: ${subPath}`);
    
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
    const path = subPath.startsWith('/') ? subPath.substring(1) : subPath;
    const content = await fetchFromIpfs(cid, path);
    
    if (!content) {
      return res.status(404).json({ 
        error: 'Content not found on IPFS network',
        cid: cid,
        path: path
      });
    }
    
    // Set appropriate content type
    if (content.mimeType) {
      res.setHeader('Content-Type', content.mimeType);
    }
    
    // Process HTML content: make links absolute and inject tracking script
    // Note: isDirectAccess=true so links won't be prefixed with domain
    let processedContent = content.data;
    if (content.mimeType && content.mimeType.includes('text/html')) {
      processedContent = makeLinksAbsolute(processedContent, content.mimeType, domain, path, true);
      processedContent = injectTrackingScript(processedContent, content.mimeType);
    }
    
    // Return the content
    return res.send(processedContent);
  } catch (error) {
    console.error('Error handling direct domain access:', error);
    return res.status(500).json({ 
      error: 'Server error processing request',
      message: error.message 
    });
  }
}

// Middleware to check if request is for direct domain access
app.use(async (req, res, next) => {
  const host = req.get('host');
  
  // If this is not the main dashboard host, treat it as direct domain access
  if (host && host !== DASHBOARD_HOST) {
    // Extract domain from the hostname
    // This assumes the domain is the full hostname or a subdomain of your gateway
    const domain = host.split(':')[0]; // Remove port if present
    
    return handleDirectDomainAccess(req, res, domain);
  }
  
  // Continue with normal processing for dashboard host
  next();
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', version: '1.0.0' });
});

// New route: Handle root domain requests with direct domain format
app.get('/:domain', async (req, res, next) => {
  const domain = req.params.domain;
  
  // Skip this handler for reserved paths
  if (RESERVED_PATHS.includes(domain)) {
    return next();
  }
  
  try {
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

// Catch-all route to handle SPA navigation
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Fire Portal server running on port ${PORT}`);
  console.log(`Dashboard host: ${DASHBOARD_HOST}`);
});
