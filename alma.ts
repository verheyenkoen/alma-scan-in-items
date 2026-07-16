export type Library = { code: string; name: string };
export type CircDesk = { code: string; name: string };
export type ScanInResult = { mmsId: string; title?: string; barcode: string };

export type AlmaSet = {
  id: string;
  name: string;
  description?: string;
  type: { value: string; desc?: string };
  content: { value: string; desc?: string };
  created_date?: string;
  number_of_members?: { value?: number | string; link?: string };
};

export type SetMember = {
  id: string;
  description?: string;
  link?: string;
};

export type AlmaItem = {
  bib_data: { mms_id: string; title?: string };
  holding_data: { holding_id: string };
  item_data: { pid: string; barcode?: string };
};

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
    pathOrUrl: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(`${this.host}/almaws/v1${pathOrUrl}`);
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
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
        throw new Error(
          `Non-JSON response from Alma (HTTP ${res.status}): ${snippet}`,
        );
      }
    }
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

  /** All sets whose content is physical items (itemized and logical). */
  async listItemSets(): Promise<AlmaSet[]> {
    const limit = 100;
    const all: AlmaSet[] = [];
    for (let offset = 0; ; offset += limit) {
      const data = await this.request<{
        total_record_count?: number;
        set?: AlmaSet[];
      }>("/conf/sets", {
        query: {
          content_type: "ITEM",
          limit: String(limit),
          offset: String(offset),
        },
      });
      const page = data.set ?? [];
      all.push(...page);
      const total = data.total_record_count ?? all.length;
      if (page.length === 0 || all.length >= total) break;
    }
    return all;
  }

  /** Full set details; unlike the list response this includes number_of_members. */
  async getSet(setId: string): Promise<AlmaSet> {
    return this.request<AlmaSet>(`/conf/sets/${encodeURIComponent(setId)}`);
  }

  async listSetMembers(
    setId: string,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<SetMember[]> {
    const limit = 100;
    const all: SetMember[] = [];
    for (let offset = 0; ; offset += limit) {
      const data = await this.request<{
        total_record_count?: number;
        member?: SetMember[];
      }>(`/conf/sets/${encodeURIComponent(setId)}/members`, {
        query: { limit: String(limit), offset: String(offset) },
      });
      const page = data.member ?? [];
      all.push(...page);
      const total = data.total_record_count ?? all.length;
      onProgress?.(all.length, total);
      if (page.length === 0 || all.length >= total) break;
    }
    return all;
  }

  async getItem(link: string): Promise<AlmaItem> {
    return this.request<AlmaItem>(link);
  }

  async scanIn(
    barcode: string,
    library: string,
    circDesk: string,
  ): Promise<ScanInResult> {
    const item = await this.request<AlmaItem>(`/items`, {
      query: { item_barcode: barcode },
    });
    return this.scanInItem(item, library, circDesk);
  }

  async scanInItem(
    item: AlmaItem,
    library: string,
    circDesk: string,
  ): Promise<ScanInResult> {
    const { mms_id } = item.bib_data;
    const { holding_id } = item.holding_data;
    const { pid } = item.item_data;
    const res = await this.request<AlmaItem>(
      `/bibs/${encodeURIComponent(mms_id)}/holdings/${encodeURIComponent(holding_id)}/items/${encodeURIComponent(pid)}`,
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
      barcode: res.item_data.barcode ?? "",
    };
  }
}
