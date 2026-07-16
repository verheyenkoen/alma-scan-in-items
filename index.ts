#!/usr/bin/env bun
import * as p from "@clack/prompts";
import {
  AlmaClient,
  type AlmaItem,
  type AlmaSet,
  type CircDesk,
  type Library,
} from "./alma.ts";

const DEFAULT_LIBRARY = "CA20";
const DEFAULT_CIRC_DESK = "DEFAULT_CIRC_DESK";
const ITEM_FETCH_CONCURRENCY = 8;

await loadEnvFromScriptDir();

let alma: AlmaClient;
try {
  alma = AlmaClient.fromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

async function loadEnvFromScriptDir() {
  const file = Bun.file(`${import.meta.dir}/.env`);
  if (!(await file.exists())) return;
  const text = await file.text();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!value) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  p.intro("Alma scan-in");

  const library = await determineLibrary();
  const circDesk = await determineCirculationDesk(library);
  const source = await determineSource();

  let ok: number;
  let failed: number;
  let skipped = 0;
  if (source === "barcodes") {
    const barcodes = await promptBarcodes();
    ({ ok, failed } = await scanInBarcodes(barcodes, library, circDesk));
  } else {
    const set = await selectSet();
    let items: AlmaItem[];
    ({ items, skipped } = await fetchItems(set));
    ({ ok, failed } = await scanInItems(items, library, circDesk));
  }

  p.outro(
    `Done. ${ok} succeeded, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped (no barcode)` : "") +
      ".",
  );
}

async function determineSource(): Promise<"barcodes" | "set"> {
  const source = await p.select<"barcodes" | "set">({
    message: "How do you want to provide the items?",
    options: [
      { value: "barcodes", label: "Paste a list of barcodes" },
      { value: "set", label: "Pick an Alma set of physical items" },
    ],
  });
  if (p.isCancel(source)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return source;
}

async function determineLibrary(): Promise<string> {
  const libraries = await loadWithSpinner("libraries", () =>
    alma.listLibraries(),
  );

  return promptSelect({
    message: "Select a library",
    items: libraries,
    defaultCode: DEFAULT_LIBRARY,
    search: true,
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

async function selectSet(): Promise<AlmaSet> {
  const sp = p.spinner();
  sp.start("Fetching sets of physical items…");
  let sets: AlmaSet[];
  try {
    sets = await alma.listItemSets();
    // The list response omits member counts; fetch full details to show them.
    sets = await enrichWithDetails(sets, (done) =>
      sp.message(`Fetching set details… ${done}/${sets.length}`),
    );
    sp.stop(`Loaded ${sets.length} set(s) of physical items`);
  } catch (e) {
    sp.stop("Failed to fetch sets");
    p.cancel((e as Error).message);
    process.exit(1);
  }

  if (sets.length === 0) {
    p.cancel("No sets of physical items found.");
    process.exit(1);
  }

  sets.sort(byNewestFirst);

  const selected = await p.select({
    message: "Select a set",
    maxItems: 12,
    options: sets.map((s) => ({
      value: s.id,
      label: `${s.name} (${setKindLabel(s)}${memberCountLabel(s)})`,
      hint: s.description || undefined,
    })),
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return sets.find((s) => s.id === selected)!;
}

async function enrichWithDetails(
  sets: AlmaSet[],
  onProgress: (done: number) => void,
): Promise<AlmaSet[]> {
  const detailed: AlmaSet[] = [];
  for (let i = 0; i < sets.length; i += ITEM_FETCH_CONCURRENCY) {
    const batch = sets.slice(i, i + ITEM_FETCH_CONCURRENCY);
    const results = await Promise.all(
      // Fall back to the brief version if details cannot be fetched.
      batch.map((s) => alma.getSet(s.id).catch(() => s)),
    );
    detailed.push(...results);
    onProgress(detailed.length);
  }
  return detailed;
}

function byNewestFirst(a: AlmaSet, b: AlmaSet): number {
  const dateA = a.created_date ? Date.parse(a.created_date) : NaN;
  const dateB = b.created_date ? Date.parse(b.created_date) : NaN;
  if (!Number.isNaN(dateA) && !Number.isNaN(dateB) && dateA !== dateB) {
    return dateB - dateA;
  }
  // Fall back to numeric id (Alma ids are increasing)
  return Number(b.id) - Number(a.id);
}

function setKindLabel(s: AlmaSet): string {
  const type = s.type?.value ?? "";
  if (type === "ITEMIZED") return "itemized";
  if (type === "LOGICAL") return "query";
  return type.toLowerCase() || "unknown";
}

function memberCountLabel(s: AlmaSet): string {
  const count = s.number_of_members?.value;
  if (count === undefined || count === null || count === "") return "";
  return `, ${count} items`;
}

async function fetchItems(
  set: AlmaSet,
): Promise<{ items: AlmaItem[]; skipped: number }> {
  const sp = p.spinner();
  sp.start("Fetching set members…");
  try {
    const members = await alma.listSetMembers(set.id, (fetched, total) =>
      sp.message(`Fetching set members… ${fetched}/${total}`),
    );
    const links = members
      .map((m) => m.link)
      .filter((l): l is string => Boolean(l));

    const items: AlmaItem[] = [];
    let fetchErrors = 0;
    for (let i = 0; i < links.length; i += ITEM_FETCH_CONCURRENCY) {
      const batch = links.slice(i, i + ITEM_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (link) => {
          try {
            return await alma.getItem(link);
          } catch {
            fetchErrors++;
            return null;
          }
        }),
      );
      items.push(...results.filter((r): r is AlmaItem => r !== null));
      sp.message(
        `Fetching items… ${Math.min(i + batch.length, links.length)}/${links.length}`,
      );
    }

    // Scan-in requires a barcode; skip items without one.
    const scannable = items.filter((i) => (i.item_data.barcode ?? "").trim());
    const skipped = items.length - scannable.length;

    sp.stop(
      `Loaded ${scannable.length} item(s)` +
        (skipped > 0 ? ` (${skipped} without barcode skipped)` : "") +
        (fetchErrors > 0 ? ` (${fetchErrors} failed to fetch)` : ""),
    );
    if (scannable.length === 0) {
      p.cancel("The set contains no items with a barcode.");
      process.exit(1);
    }
    return { items: scannable, skipped };
  } catch (e) {
    sp.stop("Failed to fetch items");
    p.cancel((e as Error).message);
    process.exit(1);
  }
}

async function scanInItems(
  items: AlmaItem[],
  library: string,
  circDesk: string,
): Promise<{ ok: number; failed: number }> {
  const confirmed = await p.confirm({
    message: `Scan in ${items.length} item(s)?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  for (const item of items) {
    const label = item.item_data.barcode || `pid ${item.item_data.pid}`;
    try {
      const result = await alma.scanInItem(item, library, circDesk);
      const title = result.title ?? "(no title)";
      p.log.success(`${label} - ${title}`);
      ok++;
    } catch (e) {
      p.log.error(`${label} - ${(e as Error).message}`);
      failed++;
    }
  }
  return { ok, failed };
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
  search?: boolean;
}): Promise<string> {
  const { items, defaultCode, message, search } = opts;
  const fallback = items[0];
  if (!fallback) {
    p.cancel("Nothing to select.");
    process.exit(1);
  }
  const initial = items.find((i) => i.code === defaultCode) ?? fallback;

  const promptOptions = {
    message,
    initialValue: initial.code,
    options: items.map((i) => ({
      value: i.code,
      label: `${i.name} (${i.code})`,
    })),
  };
  const selected = search
    ? await p.autocomplete(promptOptions)
    : await p.select(promptOptions);
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
