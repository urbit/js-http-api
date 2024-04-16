import { Noun } from '@urbit/nockjs';

/**
 * The configuration for connecting to an Urbit ship.
 */
export interface UrbitParams {
  /** The URL (with protocol and port) of the ship to be accessed. If
   * the airlock is running in a webpage served by the ship, this should just
   * be the empty string.
   */
  url: string;
  /**
   * The access code for the ship at that address
   */
  code?: string;
  /**
   * Enables verbose logging
   */
  verbose?: boolean;
  /**
   * The fetch function to use. Defaults to window.fetch. Typically used
   * to pass in locally supported fetch implementation.
   */
  fetch?: typeof fetch;
  /**
   * Called when the connection is established. Probably don't use this
   * as a trigger for refetching data.
   *
   * @param reconnect - true if this is a reconnection
   */
  onOpen?: (reconnect?: boolean) => void;
  /**
   * Called on every attempt to reconnect to the ship. Followed by onOpen
   * or onError depending on whether the connection succeeds.
   */
  onRetry?: () => void;
  /**
   * Called when the connection fails irrecoverably
   */
  onError?: (error: any) => void;
}

/**
 * A path in either string, string-array or Noun format
 * @example
 * `'/updates'`
 * `['updates', 0]`
 */
export type Path = string | string[] | Noun;

/**
 * @p including leading sig, rendered as a string
 *
 * @example
 * ```typescript
 * "~sampel-palnet"
 * ```
 */
export type Patp = string;

/**
 * The name of a clay mark, as a string
 *
 * @example
 * ```typescript
 * "graph-update"
 * ```
 */
export type Mark = string;

/**
 * The name of a gall agent, as a string
 *
 * @example
 *
 * ```typescript
 * "graph-store"
 * ```
 */
export type GallAgent = string;

/**
 * Description of an outgoing poke
 */
export interface Poke {
  /**
   * Ship to poke. If left empty, the api lib will populate it with the ship that it is connected to.
   *
   * @remarks
   *
   * This should always be the ship that you are connected to
   *
   */
  ship?: Patp;
  /**
   */
  app: GallAgent;
  /**
   * Mark of the noun to poke with
   */
  mark: Mark;
  /**
   * Noun to poke with
   */
  noun: Noun;
  /**
   * result handlers
   */
  onSuccess?: () => void;
  onError?: (e: Noun) => void; //  given a $tang
}

/**
 * Description of a scry request
 */
export interface Scry {
  /** {@inheritDoc GallAgent} */
  app: GallAgent;
  /** {@inheritDoc Path} */
  path: Path;
  mark?: Mark;
}

/**
 * Description of a thread request
 *
 * @typeParam Action - Typescript type of the data being poked
 */
export interface Thread {
  /**
   * The mark of the input vase
   */
  inputMark: Mark;
  /**
   * The mark of the output vase
   */
  outputMark: Mark;
  /**
   * Name of the thread
   *
   * @example
   * ```typescript
   * "graph-add-nodes"
   * ```
   */
  threadName: string;
  /**
   * Desk of thread
   */
  desk: string;
}
export interface NounThread extends Thread {
  /**
   * Data of the input vase
   */
  body: Noun;
}
export interface JsonThread extends Thread {
  /**
   * Data of the input vase
   */
  body: any;
}

/**
 * Subscription event handlers
 *
 */
export interface Subscription {
  /**
   * The app to subscribe to
   * @example
   * `"graph-store"`
   */
  app: GallAgent;
  /**
   * The path to which to subscribe
   * @example
   * `['keys']`
   */
  path: Path;
  /**
   * Handle negative %watch-ack
   */
  //NOTE  error is a $tang
  onNack?(error: Noun): void;
  /**
   * Handle %fact
   */
  onFact?(mark: Mark, data: Noun): void;
  /**
   * Handle %kick
   */
  onKick?(): void;
}

export type OnceSubscriptionErr = 'onKick' | 'onNack' | 'timeout';

export interface headers {
  Cookie?: string;
  [headerName: string]: string;
}

export class FatalError extends Error {}

export class ReapError extends Error {}
