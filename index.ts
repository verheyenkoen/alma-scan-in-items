import * as p from "@clack/prompts";

const API_KEY = process.env.ALMA_API_KEY;
const API_HOST =
  process.env.ALMA_API_HOST ?? "https://api-eu.hosted.exlibrisgroup.com";
const DEFAULT_LIBRARY = "CA20";
const DEFAULT_CIRC_DESK = "DEFAULT_CIRC_DESK";

if (!API_KEY) {
  console.error("Missing ALMA_API_KEY in environment.");
  process.exit(1);
}

type Library = { code: string; name: string };
type CircDesk = { code: string; name: string };

async function alma<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${API_HOST}/almaws/v1${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `apikey ${API_KEY}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : ({} as unknown);
  if (!res.ok) {
    const err = body as {
      errorList?: { error?: Array<{ errorMessage?: string; errorCode?: string }> };
      errorMessage?: string;
    };
    const first = err?.errorList?.error?.[0];
    const message =
      first?.errorMessage ||
      err?.errorMessage ||
      `HTTP ${res.status} ${res.statusText}`;
    const code = first?.errorCode ? ` [${first.errorCode}]` : "";
    throw new Error(`${message}${code}`);
  }
  return body as T;
}

async function fetchLibraries(): Promise<Library[]> {
  const data = await alma<{ library?: Library[] }>("/conf/libraries");
  return (data.library ?? []).map((l) => ({ code: l.code, name: l.name }));
}

async function fetchCircDesks(libraryCode: string): Promise<CircDesk[]> {
  const data = await alma<{ circ_desk?: CircDesk[] }>(
    `/conf/libraries/${encodeURIComponent(libraryCode)}/circ-desks`,
  );
  return (data.circ_desk ?? []).map((d) => ({ code: d.code, name: d.name }));
}

async function scanIn(
  barcode: string,
  library: string,
  circDesk: string,
): Promise<{ title?: string; barcode?: string }> {
  return alma<{ bib_data?: { title?: string }; item_data?: { barcode?: string } }>(
    `/items`,
    {
      method: "POST",
      query: {
        item_barcode: barcode,
        op: "scan",
        library,
        circ_desk: circDesk,
        auto_print_slip: "false",
      },
    },
  ).then((res) => ({
    title: res.bib_data?.title,
    barcode: res.item_data?.barcode,
  }));
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
    libraries = await fetchLibraries();
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
    desks = await fetchCircDesks(library as string);
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
      const result = await scanIn(barcode, library as string, circDesk as string);
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
