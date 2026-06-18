export type Library = { code: string; name: string };
export type CircDesk = { code: string; name: string };
export type ScanInResult = { mmsId: string; title?: string; barcode: string };

const DEFAULT_HOST = "https://api-eu.hosted.exlibrisgroup.com";

export class AlmaClient {
  private readonly apiKey: string;
  private readonly host: string;

  constructor(apiKey: string, host: string = DEFAULT_HOST) {
    this.apiKey = apiKey;
    this.host = host;
  }

  static fromEnv(): AlmaClient {
    const apiKey = process.env.ALMA_API_KEY;
    if (!apiKey) {
      throw new Error("Missing ALMA_API_KEY in environment.");
    }
    return new AlmaClient(apiKey, process.env.ALMA_API_HOST ?? DEFAULT_HOST);
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${this.host}/almaws/v1${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `apikey ${this.apiKey}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : ({} as unknown);
    if (!res.ok) {
      const err = body as {
        errorList?: {
          error?: Array<{ errorMessage?: string; errorCode?: string }>;
        };
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

  async listLibraries(): Promise<Library[]> {
    const data = await this.request<{ library?: Library[] }>("/conf/libraries");
    return (data.library ?? []).map((l) => ({ code: l.code, name: l.name }));
  }

  async listCircDesks(libraryCode: string): Promise<CircDesk[]> {
    const data = await this.request<{ circ_desk?: CircDesk[] }>(
      `/conf/libraries/${encodeURIComponent(libraryCode)}/circ-desks`,
    );
    return (data.circ_desk ?? []).map((d) => ({ code: d.code, name: d.name }));
  }

  async scanIn(
    barcode: string,
    library: string,
    circDesk: string,
  ): Promise<ScanInResult> {
    const item_data = await this.request<ItemData>(`/items`, {
      query: { item_barcode: barcode },
    });

    const { mms_id } = item_data.bib_data;
    const { holding_id } = item_data.holding_data;
    const { pid } = item_data.item_data;
    const res = await this.request<ItemData>(
      `/bibs/${mms_id}/holdings/${holding_id}/items/${pid}`,
      {
        method: "POST",
        query: {
          op: "scan",
          library,
          circ_desk: circDesk,
          auto_print_slip: "false",
          register_in_house_use: "false",
        },
      },
    );

    return {
      mmsId: res.bib_data.mms_id,
      title: res.bib_data.title,
      barcode: res.item_data.barcode,
    };
  }
}

type ItemData = {
  bib_data: {
    mms_id: string;
    title: string;
  };
  holding_data: {
    holding_id: string;
  };
  item_data: {
    pid: string;
    barcode: string;
  };
};
