# Dummy Echo

This Testnet-only service demonstrates the smallest complete Daski provider:
one fixed-price skill, one synchronous adapter call, and one terminal result.

Replace this folder with your product integration. The provider core owns
gateway authentication, payment/evidence verification, replay protection, and
result signing. Your adapter should validate product input, call your existing
API or MCP server, and return either a completed result or a stable failure.
