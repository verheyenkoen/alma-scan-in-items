# scan-in-items

Interactive CLI that performs Alma **scan-in** on a list of barcodes.

1. Pick a library (defaults to **Book Tower / CA20**)
2. Pick a circulation desk
3. Paste barcodes (one per line, or whitespace/comma separated)
4. Each barcode is sent to `POST /almaws/v1/items?op=scan`

## Setup

```bash
bun install
cp .env.example .env
# edit .env and set ALMA_API_KEY
```

The API key needs `Bibs (Read/Write)` and `Configuration (Read-only)` scopes.

## Run

```bash
bun start
# or: bun run index.ts
```

Finish the barcode list with an empty line (or Ctrl-D).
