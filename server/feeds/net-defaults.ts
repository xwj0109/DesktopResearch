import { defaultPaperDeps } from "../../desktop/papers.ts";

/** Real network for the feed service (DNS checked per request, public addresses only). */
export const dnsLookupDefault = () => defaultPaperDeps();
