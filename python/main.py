import os
import base64
import httpx
import json
from typing import Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend
import time
import uuid

class Settings(BaseSettings):
    wallet_address: str = Field(alias="WALLET_ADDRESS")
    key_id: str = Field(alias="KEY_ID")
    private_key: str = Field(alias="PRIVATE_KEY")

    class Config:
        env_file = ".env"
        populate_by_name = True

settings = Settings()

app = FastAPI(
    title="Interledger Open Payments API",
    description="FastAPI example for Interledger Open Payments integration",
    version="1.0.0"
)

class InterledgerClient:
    def __init__(self, wallet_address: str, private_key_pem: str, key_id: str):
        self.wallet_address = wallet_address
        self.key_id = key_id
        self.private_key = serialization.load_pem_private_key(
            private_key_pem.encode(),
            password=None,
            backend=default_backend()
        )
        self.client = httpx.AsyncClient()

    async def close(self):
        await self.client.aclose()

    def _create_signature(self, method: str, url: str, body: Optional[str] = None) -> dict:
        """Create HTTP signature for Open Payments authentication"""
        from urllib.parse import urlparse

        parsed_url = urlparse(url)
        path = parsed_url.path
        if parsed_url.query:
            path += f"?{parsed_url.query}"

        # Create signature base
        signature_base_parts = [
            f'"@method": {method.upper()}',
            f'"@target-uri": {url}',
            f'"content-type": application/json',
        ]

        if body:
            content_digest = base64.b64encode(
                hashes.Hash(hashes.SHA256(), backend=default_backend())
                .update(body.encode())
                .finalize()
            ).decode()
            signature_base_parts.append(f'"content-digest": sha-256=:{content_digest}:')

        signature_base = "\n".join(signature_base_parts)

        # Sign the signature base
        signature = self.private_key.sign(
            signature_base.encode(),
            padding.PKCS1v15(),
            hashes.SHA256()
        )

        signature_b64 = base64.b64encode(signature).decode()

        # Create signature input
        signature_params = f'keyid="{self.key_id}",created={int(time.time())},alg="rsa-v1_5-sha256"'

        headers = {
            "Signature": f"sig1=:{signature_b64}:",
            "Signature-Input": f'sig1=({" ".join([p.split(":")[0] for p in signature_base_parts])});{signature_params}',
            "Content-Type": "application/json"
        }

        if body:
            headers["Content-Digest"] = f"sha-256=:{content_digest}:"

        return headers

    async def get_wallet_address(self, url: str) -> dict:
        """Get wallet address information"""
        response = await self.client.get(
            url,
            headers={"Accept": "application/json"}
        )
        response.raise_for_status()
        return response.json()

    async def get_wallet_address_keys(self, url: str) -> dict:
        """Get wallet address public keys"""
        keys_url = f"{url}/jwks.json"
        response = await self.client.get(
            keys_url,
            headers={"Accept": "application/json"}
        )
        response.raise_for_status()
        return response.json()

    async def create_quote(self, wallet_address: str, receiver: str, amount: str, asset_code: str, asset_scale: int) -> dict:
        """Create a payment quote"""
        wallet_info = await self.get_wallet_address(wallet_address)
        quotes_url = wallet_info.get("quotes")

        if not quotes_url:
            raise ValueError("Quotes URL not found in wallet address")

        body = {
            "method": "ilp",
            "receiver": receiver,
            "sendAmount": {
                "value": amount,
                "assetCode": asset_code,
                "assetScale": asset_scale
            }
        }

        body_json = json.dumps(body)
        headers = self._create_signature("POST", quotes_url, body_json)

        response = await self.client.post(
            quotes_url,
            headers=headers,
            content=body_json
        )
        response.raise_for_status()
        return response.json()

client: Optional[InterledgerClient] = None

@app.on_event("startup")
async def startup_event():
    global client
    try:
        # Decode the base64 private key
        private_key_pem = base64.b64decode(settings.private_key).decode("utf-8")
        client = InterledgerClient(
            wallet_address=settings.wallet_address,
            private_key_pem=private_key_pem,
            key_id=settings.key_id
        )
    except Exception as e:
        print(f"Error initializing Interledger client: {e}")
        raise

@app.on_event("shutdown")
async def shutdown_event():
    if client:
        await client.close()

@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "message": "Interledger Open Payments FastAPI Example",
        "version": "1.0.0",
        "endpoints": {
            "wallet_address": "/wallet",
            "wallet_keys": "/wallet/keys",
            "create_quote": "/quotes/create"
        }
    }

@app.get("/wallet")
async def get_wallet():
    """Get wallet address information"""
    if not client:
        raise HTTPException(status_code=500, detail="Client not initialized")

    try:
        wallet_info = await client.get_wallet_address(settings.wallet_address)
        return wallet_info
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"Error fetching wallet: {str(e)}")

@app.get("/wallet/keys")
async def get_wallet_keys():
    """Get wallet address public keys"""
    if not client:
        raise HTTPException(status_code=500, detail="Client not initialized")

    try:
        keys = await client.get_wallet_address_keys(settings.wallet_address)
        return keys
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"Error fetching wallet keys: {str(e)}")

class QuoteRequest(BaseModel):
    receiver: str = Field(..., description="Receiver wallet address URL")
    amount: str = Field(..., description="Amount to send")
    asset_code: str = Field(default="USD", description="Asset code (e.g., USD, EUR)")
    asset_scale: int = Field(default=2, description="Asset scale (decimal places)")

@app.post("/quotes/create")
async def create_quote(quote_request: QuoteRequest):
    """Create a payment quote"""
    if not client:
        raise HTTPException(status_code=500, detail="Client not initialized")

    try:
        quote = await client.create_quote(
            wallet_address=settings.wallet_address,
            receiver=quote_request.receiver,
            amount=quote_request.amount,
            asset_code=quote_request.asset_code,
            asset_scale=quote_request.asset_scale
        )
        return quote
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating quote: {str(e)}")

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "wallet_address": settings.wallet_address,
        "client_initialized": client is not None
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
