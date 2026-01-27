# Interledger FastAPI Example

A FastAPI-based example demonstrating integration with Interledger Open Payments protocol.

## Overview

This application provides a REST API for interacting with Interledger payment pointers and creating payment quotes. It demonstrates how to:

- Authenticate with Interledger Open Payments using HTTP signatures
- Fetch wallet address information
- Retrieve wallet address public keys
- Create payment quotes

## Prerequisites

- Python 3.8 or higher
- An Interledger wallet address (e.g., from Rafiki)
- Private key and key ID for authentication

## Setup

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`:

```env
WALLET_ADDRESS=https://ilp.rafiki.money/your-wallet-address
KEY_ID=your-key-id
PRIVATE_KEY=your-base64-encoded-private-key
```

### Getting Your Credentials

To get your Interledger credentials:

1. Create a wallet on a Rafiki instance (e.g., https://rafiki.money)
2. Generate a key pair for your wallet
3. Encode your private key in base64:
   ```bash
   cat private-key.pem | base64 -w 0
   ```
4. Copy the key ID provided by your wallet provider

## Running the Application

Start the FastAPI server:

```bash
python main.py
```

Or using uvicorn directly:

```bash
uvicorn main:app --reload
```

The API will be available at `http://localhost:8000`

## API Endpoints

### Root
- **GET /** - API information and available endpoints

### Wallet Information
- **GET /wallet** - Get wallet address information
- **GET /wallet/keys** - Get wallet address public keys

### Payments
- **POST /quotes/create** - Create a payment quote

  Request body:
  ```json
  {
    "receiver": "https://ilp.rafiki.money/receiver-wallet",
    "amount": "1000",
    "asset_code": "USD",
    "asset_scale": 2
  }
  ```

### Health Check
- **GET /health** - Check API health status

## Interactive API Documentation

Once the server is running, you can access:

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Example Usage

### Using curl

Get wallet information:
```bash
curl http://localhost:8000/wallet
```

Create a payment quote:
```bash
curl -X POST http://localhost:8000/quotes/create \
  -H "Content-Type: application/json" \
  -d '{
    "receiver": "https://ilp.rafiki.money/receiver-wallet",
    "amount": "1000",
    "asset_code": "USD",
    "asset_scale": 2
  }'
```

### Using Python requests

```python
import requests

# Get wallet info
response = requests.get("http://localhost:8000/wallet")
print(response.json())

# Create a quote
quote_data = {
    "receiver": "https://ilp.rafiki.money/receiver-wallet",
    "amount": "1000",
    "asset_code": "USD",
    "asset_scale": 2
}
response = requests.post("http://localhost:8000/quotes/create", json=quote_data)
print(response.json())
```

## Architecture

The application uses:

- **FastAPI** - Modern web framework for building APIs
- **httpx** - Async HTTP client for Open Payments requests
- **cryptography** - RSA signing for HTTP signature authentication
- **pydantic** - Data validation and settings management

## Open Payments Authentication

The application implements HTTP Signature authentication as required by the Open Payments specification. This involves:

1. Creating a signature base from request details
2. Signing with RSA-SHA256 using the private key
3. Including signature headers in requests

## Error Handling

The API returns appropriate HTTP status codes:

- `200` - Success
- `500` - Server error (includes error details)

## Development

For development with auto-reload:

```bash
uvicorn main:app --reload --log-level debug
```

## Testing

Test the health endpoint:
```bash
curl http://localhost:8000/health
```

Expected response:
```json
{
  "status": "healthy",
  "wallet_address": "https://ilp.rafiki.money/your-wallet",
  "client_initialized": true
}
```

## Security Notes

- Never commit your `.env` file or expose your private key
- The private key should be stored securely and base64 encoded
- Use HTTPS in production environments
- Implement rate limiting for production deployments

## Resources

- [Interledger Protocol](https://interledger.org/)
- [Open Payments Specification](https://openpayments.guide/)
- [Rafiki Documentation](https://rafiki.dev/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)

## License

MIT
