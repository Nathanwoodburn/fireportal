require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const { resolveHandshake } = require('./lib/handshake');
const { fetchFromIpfs } = require('./lib/ipfs');
const { PORT } = require('./config');

const app = express();

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
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
    
    // Return the content
    res.send(content.data);
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
    
    // Return the content
    res.send(content.data);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ 
      error: 'Server error processing request',
      message: error.message 
    });
  }
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', version: '0.1.0' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Fire Portal server running on port ${PORT}`);
});
