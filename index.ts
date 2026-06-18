import * as p from "@clack/prompts";
import { AlmaClient, type CircDesk, type Library } from "./alma.ts";

const DEFAULT_LIBRARY = "CA20";
const DEFAULT_CIRC_DESK = "DEFAULT_CIRC_DESK";

let alma: AlmaClient;
try {
  alma = AlmaClient.fromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

async function main() {
  p.intro("Alma scan-in");

  const library = await determineLibrary();
  const circDesk = await determineCirculationDesk(library);
  const barcodes = await promptBarcodes();

  const { ok, failed } = await scanInBarcodes(barcodes, library, circDesk);

  p.outro(`Done. ${ok} succeeded, ${failed} failed.`);
}

async function determineLibrary(): Promise<string> {
  const libraries = await loadWithSpinner(
    "libraries",
    () => alma.listLibraries(),
  );
  return promptSelect({
    message: "Select a library",
    items: libraries,
    defaultCode: DEFAULT_LIBRARY,
  });
}

async function determineCirculationDesk(library: string): Promise<string> {
  const desks = await loadWithSpinner("circulation desks", () =>
    alma.listCircDesks(library),
  );
  if (desks.length === 0) {
    p.cancel("No circulation desks available for this library.");
    process.exit(1);
  }
  return promptSelect({
    message: "Select a circulation desk",
    items: desks,
    defaultCode: DEFAULT_CIRC_DESK,
  });
}

async function promptBarcodes(): Promise<string[]> {
  const input = await p.multiline({
    message:
      "Paste barcodes (one per line, or whitespace/comma-separated). Submit with Esc + Enter.",
  });
  if (p.isCancel(input)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const barcodes = parseBarcodes(input);
  if (barcodes.length === 0) {
    p.cancel("No barcodes provided.");
    process.exit(0);
  }
  return barcodes;
}

async function scanInBarcodes(
  barcodes: string[],
  library: string,
  circDesk: string,
): Promise<{ ok: number; failed: number }> {
  p.log.info(`Scanning in ${barcodes.length} item(s)…`);

  let ok = 0;
  let failed = 0;
  for (const barcode of barcodes) {
    try {
      const result = await alma.scanIn(barcode, library, circDesk);
      const title = result.title ?? "(no title)";
      p.log.success(`${barcode} - ${title}`);
      ok++;
    } catch (e) {
      p.log.error(`${barcode} - ${(e as Error).message}`);
      failed++;
    }
  }
  return { ok, failed };
}

async function promptSelect(opts: {
  message: string;
  items: Array<Library | CircDesk>;
  defaultCode: string;
}): Promise<string> {
  const { items, defaultCode, message } = opts;
  const fallback = items[0];
  if (!fallback) {
    p.cancel("Nothing to select.");
    process.exit(1);
  }
  const initial = items.find((i) => i.code === defaultCode) ?? fallback;

  const selected = await p.select({
    message,
    initialValue: initial.code,
    options: items.map((i) => ({
      value: i.code,
      label: `${i.name} (${i.code})`,
    })),
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return selected;
}

async function loadWithSpinner<T>(
  label: string,
  work: () => Promise<T[]>,
): Promise<T[]> {
  const sp = p.spinner();
  sp.start(`Fetching ${label}…`);
  try {
    const result = await work();
    sp.stop(`Loaded ${result.length} ${label}`);
    return result;
  } catch (e) {
    sp.stop(`Failed to fetch ${label}`);
    p.cancel((e as Error).message);
    process.exit(1);
  }
}

function parseBarcodes(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
