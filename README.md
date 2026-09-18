# tg-mint

This directory contains a small Telegram bot that forwards minting commands to the Express API in the parent project.

## Commands

- `/start`
- `/help`
- `/status`
- `/import <privateKey>`
- `/mint`
- `/list`
- `/clear`

## Environment

Copy `.env.example` to `.env` and fill in the Telegram token plus the Express API base URL.

Contract Mint also requires `ETHERSCAN_API_KEY`. It fetches verified contract ABIs from Etherscan, then sends the selected state-changing function through the configured chain RPC.
