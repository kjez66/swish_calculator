import { DurableObject } from "cloudflare:workers";

/** Shared by every kassa: pair codes and rate limits. */
export class Directory extends DurableObject {}
