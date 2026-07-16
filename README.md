# scan-in-items

Interactive CLI that performs Alma **scan-in** on a list of barcodes or on the
members of an Alma set of physical items.

1. Pick a library (defaults to **Book Tower / CA20**)
2. Pick a circulation desk
3. Choose the source of the items:
   - **Paste barcodes** (one per line, or whitespace/comma separated), or
   - **Pick an Alma set** of physical items (itemized or logical); its members
     are fetched and confirmed before scanning
4. Each item is sent to `POST /almaws/v1/bibs/.../items/{pid}?op=scan`

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
