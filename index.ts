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

function parseBarcodes(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

async function main() {
  p.intro("Alma scan-in");

  const libSpinner = p.spinner();
  libSpinner.start("Fetching libraries…");
  let libraries: Library[];
  try {
    libraries = await alma.listLibraries();
  } catch (e) {
    libSpinner.stop("Failed to fetch libraries");
    p.cancel((e as Error).message);
    process.exit(1);
  }
  libSpinner.stop(`Loaded ${libraries.length} libraries`);

  const defaultLib = libraries.find((l) => l.code === DEFAULT_LIBRARY);
  const library = await p.select({
    message: "Select a library",
    initialValue: defaultLib?.code ?? libraries[0]?.code,
    options: libraries.map((l) => ({
      value: l.code,
      label: `${l.name} (${l.code})`,
    })),
  });
  if (p.isCancel(library)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const deskSpinner = p.spinner();
  deskSpinner.start("Fetching circulation desks…");
  let desks: CircDesk[];
  try {
    desks = await alma.listCircDesks(library as string);
  } catch (e) {
    deskSpinner.stop("Failed to fetch circulation desks");
    p.cancel((e as Error).message);
    process.exit(1);
  }
  deskSpinner.stop(`Loaded ${desks.length} circulation desks`);

  if (desks.length === 0) {
    p.cancel("No circulation desks available for this library.");
    process.exit(1);
  }

  const defaultDesk = desks.find((d) => d.code === DEFAULT_CIRC_DESK);
  const circDesk = await p.select({
    message: "Select a circulation desk",
    initialValue: defaultDesk?.code ?? desks[0]?.code,
    options: desks.map((d) => ({
      value: d.code,
      label: `${d.name} (${d.code})`,
    })),
  });
  if (p.isCancel(circDesk)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const barcodeInput = await p.multiline({
    message:
      "Paste barcodes (one per line, or whitespace/comma-separated). Submit with Esc + Enter.",
  });
  if (p.isCancel(barcodeInput)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  const barcodes = parseBarcodes(barcodeInput as string);
  if (barcodes.length === 0) {
    p.cancel("No barcodes provided.");
    process.exit(0);
  }

  p.log.info(`Scanning in ${barcodes.length} item(s)…`);

  let ok = 0;
  let failed = 0;
  for (const barcode of barcodes) {
    try {
      const result = await alma.scanIn(
        barcode,
        library as string,
        circDesk as string,
      );
      const title = result.title ?? "(no title)";
      p.log.success(`${barcode} — ${title}`);
      ok++;
    } catch (e) {
      p.log.error(`${barcode} — ${(e as Error).message}`);
      failed++;
    }
  }

  p.outro(`Done. ${ok} succeeded, ${failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
