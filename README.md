# Interledger Test Examples

This repository contains example implementations for working with Interledger Open Payments in different languages and frameworks.

## Examples

### 1. TypeScript/Bun Example (`/ts`)

A minimal Bun-based TypeScript example using the official `@interledger/open-payments` client library.

**Features:**
- Official Interledger Open Payments client
- Fetch wallet address information
- Retrieve wallet address keys
- Built with Bun for fast performance

[Read more](./ts/README.md)

### 2. Python/FastAPI Example (`/python`)

A comprehensive FastAPI REST API demonstrating Interledger Open Payments integration.

**Features:**
- REST API endpoints for wallet operations
- HTTP signature authentication implementation
- Payment quote creation
- Interactive API documentation (Swagger/ReDoc)
- Production-ready structure

[Read more](./python/README.md)

## Quick Start

### TypeScript/Bun
```bash
cd ts
bun install
cp .env.example .env
# Configure .env with your credentials
bun run index.ts
```

### Python/FastAPI
```bash
cd python
pip install -r requirements.txt
cp .env.example .env
# Configure .env with your credentials
python main.py
```

## Environment Variables

Both examples require the following environment variables:

- `WALLET_ADDRESS` - Your Interledger wallet address URL
- `KEY_ID` - Your authentication key ID
- `PRIVATE_KEY` - Your base64-encoded private key

## Resources

- [Interledger Protocol](https://interledger.org/)
- [Open Payments Specification](https://openpayments.guide/)
- [Rafiki Documentation](https://rafiki.dev/)

## License

MIT
