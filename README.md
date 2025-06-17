# Fire Portal
Fire Portal is an experimental IPFS gateway for Handshake domains

## Overview
This gateway allows you to access IPFS content through Handshake domain names. It resolves Handshake domains and maps them to their corresponding IPFS content identifiers (CIDs).

## Features
- Resolves Handshake domains to IPFS content
- Uses HNSDoH.com for secure DNS resolution (DoH and DoT supported)
- Supports TXT records with `ipfs=` and `ip6=` prefixes for IPFS CIDs
- Caches IPFS content for faster access
- Simple web interface for manual lookups

## Installation
```bash
# Clone the repository
git clone https://github.com/yourusername/fireportal.git
cd fireportal

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with your settings
```

## Configuration
Edit the `.env` file to configure:
- IPFS gateway settings
- Handshake resolution method (DoH, DoT, or local)
- HNSDoH.com settings
- Cache settings
- Server port

### Resolution Methods
Fire Portal supports multiple methods for resolving Handshake domains:

- `doh`: Uses DNS-over-HTTPS via HNSDoH.com (default, recommended)
- `dot`: Uses DNS-over-TLS via HNSDoH.com
- `local`: Uses a local Handshake resolver

### Supported TXT Record Formats

Fire Portal supports several TXT record formats for Handshake domains:

| Format | Example | Description |
|--------|---------|-------------|
| `ipfs=Hash...` | `ipfs=QmdbRRQ2CYSFRUEQcUC7TtbsmsWU9411KaHiVJXZFscBNn` | Standard format with equals sign |
| `ipfs:Hash...` | `ipfs:QmdbRRQ2CYSFRUEQcUC7TtbsmsWU9411KaHiVJXZFscBNn` | Alternative format with colon |
| `ip6=Hash...` | `ip6=QmdbRRQ2CYSFRUEQcUC7TtbsmsWU9411KaHiVJXZFscBNn` | Legacy format (equivalent to ipfs=) |

## Usage
```bash
# Start the server
npm start
```

Then access Handshake+IPFS content via:
- `http://localhost:3000/ipfs.act` (replace "ipfs.act" with a Handshake domain)
- Direct web interface at `http://localhost:3000`

## Testing
### 1. Basic Server Testing
```bash
# Start the server
npm start

# Verify the server is running
curl http://localhost:3000/api/status
# Should return: {"status":"online","version":"0.1.0"}
```

### 2. Testing with Sample Handshake Domains
You can test with known Handshake domains that have IPFS content:

- `http://localhost:3000/ipfs.act` - Example