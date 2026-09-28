/**
 * Live parcel tracking (17TRACK API v2.4). Shopify fulfillments carry the tracking number but no
 * carrier updates, so without this the bot can only ever say "shipped".
 *
 * The model only sees a normalized stage and a date: never event descriptions, locations or
 * carrier names (customers get the tracking link for details).
 */

export type ShipmentStage =
  | "no_update_yet"
  | "label_created"
  | "in_transit"
  | "final_leg"
  | "out_for_delivery"
  | "available_for_pickup"
  | "delivered"
  | "delivery_failed"
  | "delayed"
  | "returning"
  | "needs_attention"
  | "no_recent_updates";

export interface TrackingStatus {
  stage: ShipmentStage;
  /** Date (YYYY-MM-DD) of the latest carrier event, if any. */
  lastUpdate: string | null;
}

export interface TrackingService {
  /** Null when tracking is unavailable (quota, network, unknown number): callers fall back to the Shopify stage. */
  status(trackingNumber: string, carrier?: number): Promise<TrackingStatus | null>;
}

/** 17TRACK status + sub_status -> stage. Customs sub-states count as the final leg (never mentioned to customers). */
export function mapTrackingStatus(status: string | null | undefined, subStatus: string | null | undefined): ShipmentStage {
  switch (status) {
    case "InfoReceived":
      return "label_created";
    case "InTransit":
      if (subStatus === "InTransit_CustomsRequiringInformation") return "needs_attention";
      if (subStatus === "InTransit_Arrival" || subStatus === "InTransit_CustomsProcessing" || subStatus === "InTransit_CustomsReleased") return "final_leg";
      return "in_transit";
    case "OutForDelivery":
      return "out_for_delivery";
    case "AvailableForPickup":
      return "available_for_pickup";
    case "Delivered":
      return "delivered";
    case "DeliveryFailure":
      return "delivery_failed";
    case "Exception":
      if (subStatus === "Exception_Delayed") return "delayed";
      if (subStatus === "Exception_Returning" || subStatus === "Exception_Returned") return "returning";
      return "needs_attention";
    case "Expired":
      return "no_recent_updates";
    default:
      return "no_update_yet";
  }
}

/** 17TRACK carrier code from a 17track.net tracking link (`...&fc=190012`), if present. */
export function carrierFromTrackingUrl(url: string | null | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("17track.net")) return undefined;
    const fc = Number(u.searchParams.get("fc"));
    return Number.isInteger(fc) && fc > 0 ? fc : undefined;
  } catch {
    return undefined;
  }
}

const NOT_REGISTERED = -18019902;
const ALREADY_REGISTERED = -18019901;

export class SeventeenTrack implements TrackingService {
  private cache = new Map<string, { at: number; value: TrackingStatus }>();

  constructor(
    private readonly opts: { apiKey: string; fetchImpl?: typeof fetch; cacheTtlMs?: number; baseUrl?: string; timeoutMs?: number },
  ) {}

  private async call(path: "register" | "gettrackinfo", body: unknown): Promise<any> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseUrl ?? "https://api.17track.net/track/v2.4"}/${path}`, {
      method: "POST",
      headers: { "17token": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`17TRACK ${path} ${res.status}`);
    const json = await res.json();
    if (json?.code !== 0) throw new Error(`17TRACK ${path} code ${json?.code}`);
    return json.data;
  }

  async status(trackingNumber: string, carrier?: number): Promise<TrackingStatus | null> {
    const cached = this.cache.get(trackingNumber);
    if (cached && Date.now() - cached.at < (this.opts.cacheTtlMs ?? 3 * 3600_000)) return cached.value;
    const item = carrier ? { number: trackingNumber, carrier } : { number: trackingNumber };
    try {
      let data = await this.call("gettrackinfo", [item]);
      if (data?.rejected?.[0]?.error?.code === NOT_REGISTERED) {
        // First question about this parcel: register it (uses one quota unit). Tracking data arrives
        // a little later, so this answer is "no update yet" until 17TRACK has fetched it.
        const reg = await this.call("register", [item]);
        const rejected = reg?.rejected?.[0]?.error?.code;
        if (rejected && rejected !== ALREADY_REGISTERED) return null;
        data = await this.call("gettrackinfo", [item]);
      }
      const info = data?.accepted?.[0]?.track_info;
      if (!info) return null;
      const time: string | undefined = info.latest_event?.time_iso ?? info.latest_event?.time_utc;
      const value: TrackingStatus = {
        stage: mapTrackingStatus(info.latest_status?.status, info.latest_status?.sub_status),
        lastUpdate: time ? time.slice(0, 10) : null,
      };
      this.cache.set(trackingNumber, { at: Date.now(), value });
      return value;
    } catch {
      return null;
    }
  }
}
