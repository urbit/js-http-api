import { isBrowser } from 'browser-or-node';
import { UrbitHttpApiEvent, UrbitHttpApiEventType } from './events';
import { fetchEventSource, EventSourceMessage } from './fetch-event-source';

import {
  Scry,
  Thread,
  PokeInterface,
  SubscriptionRequestInterface,
  headers,
  PokeHandlers,
  FatalError,
  NounPath,
  ReapError,
  UrbitParams,
} from './types';
import EventEmitter, { hexString } from './utils';

import { Atom, Cell, dejs, jam, cue, Noun } from '@urbit/nockjs';
import { parseUw, formatUw, patp2dec } from '@urbit/aura';

/**
 * A class for interacting with an urbit ship, given its URL and code
 */
export class Urbit {
  /**
   * Event emitter for debugging, see events.ts for full list of events
   */
  private emitter = new EventEmitter();

  /**
   * UID will be used for the channel: The current unix time plus a random hex string
   */
  private uid: string = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;

  /**
   * lastEventId is an auto-updated index of which events have been *sent* over this channel.
   * lastHeardEventId is the latest event we have heard back about.
   * lastAcknowledgedEventId is the latest event we have sent an ack for.
   */
  private lastEventId: number = 0;
  private lastHeardEventId: number = -1;
  private lastAcknowledgedEventId: number = -1;

  /**
   * SSE Client is null for now; we don't want to start polling until it the channel exists
   */
  private sseClientInitialized: boolean = false;

  /**
   * Cookie gets set when we log in.
   */
  cookie?: string | undefined;

  /**
   * A registry of requestId to successFunc/failureFunc
   *
   * These functions are registered during a +poke and are executed
   * in the onServerEvent()/onServerError() callbacks. Only one of
   * the functions will be called, and the outstanding poke will be
   * removed after calling the success or failure function.
   */

  private outstandingPokes: Map<number, PokeHandlers> = new Map();

  /**
   * A registry of requestId to subscription functions.
   *
   * These functions are registered during a +subscribe and are
   * executed in the onServerEvent()/onServerError() callbacks. The
   * event function will be called whenever a new piece of data on this
   * subscription is available, which may be 0, 1, or many times. The
   * disconnect function may be called exactly once.
   */
  private outstandingSubscriptions: Map<number, SubscriptionRequestInterface> =
    new Map();

  /**
   * Our abort controller, used to close the connection
   */
  private abort = new AbortController();

  /**
   * The URL of the ship we're connected to
   */
  url: string;

  /**
   * Identity of the ship we're connected to
   */
  ship?: string | null;

  /**
   * Our access code
   */
  code?: string;

  /**
   * Our identity, with which we are authenticated into the ship
   */
  our?: string | null;

  /**
   * If verbose, logs output eagerly.
   */
  verbose?: boolean;

  /**
   * number of consecutive errors in connecting to the eventsource
   */
  private errorCount = 0;
  /**
   * Called when the connection is established. Probably don't use this
   * as a trigger for refetching data.
   *
   * @param reconnect - true if this is a reconnection
   */
  onOpen?: (reconnect: boolean) => void = null;
  /**
   * Called on every attempt to reconnect to the ship. Followed by onOpen
   * or onError depending on whether the connection succeeds.
   */
  onRetry?: () => void = null;
  /**
   * Called when the connection fails irrecoverably
   */
  onError?: (error: any) => void = null;

  /** This is basic interpolation to get the channel URL of an instantiated Urbit connection. */
  private get channelUrl(): string {
    return `${this.url}/~/channel/${this.uid}`;
  }

  private fetchOptions(
    method: 'PUT' | 'GET' = 'PUT',
    mode: 'jam' | 'json' = 'jam'
  ): any {
    const type = mode === 'jam' ? 'application/x-urb-jam' : 'application/json';
    let headers: headers = {};
    switch (method) {
      case 'PUT':
        headers['Content-Type'] = type;
        break;
      case 'GET':
        headers['X-Channel-Format'] = type;
        break;
    }
    if (!isBrowser) {
      headers.Cookie = this.cookie;
    }
    return {
      credentials: 'include',
      accept: '*',
      headers,
      signal: this.abort.signal,
    };
  }

  /**
   * Constructs a new Urbit instance.
   * @param params The configuration for connecting to an Urbit ship.
   */
  constructor(params: UrbitParams) {
    this.url = params.url;
    this.code = params.code;
    this.verbose = params.verbose || false;
    this.onError = params.onError;
    this.onRetry = params.onRetry;
    this.onOpen = params.onOpen;

    if (isBrowser) {
      window.addEventListener('beforeunload', this.delete);
    }
    return this;
  }

  /**
   * All-in-one hook-me-up.
   *
   * Given a ship, url, and code, this returns an airlock connection
   * that is ready to go. It creates a channel and connects to it.
   */
  static async setupChannel({ url, code, ...params }: UrbitParams) {
    const airlock = new Urbit({
      url: url.startsWith('http') ? url : `http://${url}`,
      code,
      ...params,
    });

    // Learn where we are aka what ship we're connecting to
    airlock.getShipName();

    if (code) {
      await airlock.authenticate();
    }
    // Learn who we are aka what patp
    airlock.getOurName();

    await airlock.connect();
    return airlock;
  }

  private emit<T extends UrbitHttpApiEventType>(
    event: T,
    data: UrbitHttpApiEvent[T]
  ) {
    if (this.verbose) {
      this.emitter.emit(event, data);
    }
  }

  on<T extends UrbitHttpApiEventType>(
    event: T,
    callback: (data: UrbitHttpApiEvent[T]) => void
  ): void {
    this.emitter.on(event, callback);

    this.verbose && console.log(event, 'listening active');
    if (event === 'init') {
      this.emitter.emit(event, {
        uid: this.uid,
        subscriptions: [...this.outstandingSubscriptions.entries()].map(
          ([k, v]) => ({ id: k, app: v.app, path: v.path })
        ),
      });
    }
  }

  /**
   * Gets the name of the ship accessible at this.url and stores it to this.ship
   *
   */
  async getShipName(): Promise<void> {
    if (this.ship) {
      return Promise.resolve();
    }

    const nameResp = await fetch(`${this.url}/~/host`, {
      method: 'get',
      credentials: 'include',
    });
    const name = await nameResp.text();
    this.ship = name;
  }

  /**
   * Gets the name of the ship accessible at this.url and stores it to this.ship
   *
   */
  async getOurName(): Promise<void> {
    if (this.our) {
      return Promise.resolve();
    }

    const nameResp = await fetch(`${this.url}/~/name`, {
      method: 'get',
      credentials: 'include',
    });
    const name = await nameResp.text();
    this.our = name;
  }

  /**
   * Connects to the Urbit ship. Nothing can be done until this is called.
   * That's why we roll it into this.setupChannel.
   * TODO  as of urbit/urbit#6561, this is no longer true, and we are able
   *       to interact with the ship using a guest identity.
   */
  async authenticate(): Promise<void> {
    if (this.verbose) {
      console.log(
        `password=${this.code} `,
        isBrowser
          ? 'Connecting in browser context at ' + `${this.url}/~/login`
          : 'Connecting from node context'
      );
    }
    return fetch(`${this.url}/~/login`, {
      method: 'post',
      body: `password=${this.code}`,
      credentials: 'include',
    }).then(async (response) => {
      if (this.verbose) {
        console.log('Received authentication response', response);
      }
      if (response.status >= 200 && response.status < 300) {
        throw new Error('Login failed with status ' + response.status);
      }
      const cookie = response.headers.get('set-cookie');
      if (!this.ship && cookie) {
        this.ship = new RegExp(/urbauth-~([\w-]+)/).exec(cookie)[1];
      }
      if (!isBrowser) {
        this.cookie = cookie;
      }
    });
  }

  /**
   * Initializes the SSE pipe for the appropriate channel.
   */
  //TODO  explicit success/failure return?
  async connect(): Promise<void> {
    if (this.sseClientInitialized) {
      return Promise.resolve();
    }
    this.emit('status-update', { status: 'opening' });
    // Can't receive events until the channel is open,
    // so send an empty list of commands to open it.
    await this.sendNounsToChannel();
    this.sseClientInitialized = true;
    return new Promise((resolve, reject) => {
      fetchEventSource(this.channelUrl, {
        //TODO  manually inject headers = { 'last-event-id': lastHeardEventId }
        //      if needed
        ...this.fetchOptions('GET'),
        openWhenHidden: true,
        responseTimeout: 25000,
        onopen: async (response, isReconnect) => {
          if (this.verbose) {
            console.log('Opened eventsource', response);
          }
          if (response.ok) {
            this.errorCount = 0;
            this.onOpen && this.onOpen(isReconnect);
            this.emit('status-update', {
              status: isReconnect ? 'reconnected' : 'active',
            });
            resolve();
            return; // everything's good
          } else {
            const err = new Error('failed to open eventsource');
            reject(err);
          }
        },
        onmessage: (event: EventSourceMessage) => {
          if (this.verbose) {
            console.log('Received SSE: ', event);
          }
          if (!event.id) return;
          const eventId = parseInt(event.id, 10);
          this.emit('fact', {
            id: eventId,
            data: event.data,
            time: Date.now(),
          });
          if (eventId <= this.lastHeardEventId) {
            if (this.verbose) {
              console.log('dropping old or out-of-order event', {
                eventId,
                lastHeard: this.lastHeardEventId,
              });
            }
            return;
          }
          this.lastHeardEventId = eventId;
          this.emit('id-update', { lastHeard: this.lastHeardEventId });
          if (eventId - this.lastAcknowledgedEventId > 20) {
            this.ack(eventId);
          }

          let data: any;
          if (event.data) {
            data = cue(Atom.fromString(parseUw(event.data).toString()));
          }

          // [request-id channel-event]
          if (
            data instanceof Cell &&
            data.head instanceof Atom &&
            data.tail instanceof Cell &&
            data.tail.head instanceof Atom
          ) {
            //NOTE  id could be string if id > 2^32, not expected in practice
            const id = data.head.valueOf() as number;
            const tag = Atom.cordToString(data.tail.head);
            const bod = data.tail.tail;
            // [%poke-ack p=(unit tang)]
            if (tag === 'poke-ack' && this.outstandingPokes.has(id)) {
              const funcs = this.outstandingPokes.get(id);
              if (bod instanceof Atom) {
                funcs.onSuccess();
              } else {
                //TODO  pre-render tang?
                console.error(bod.tail);
                funcs.onError(bod.tail);
              }
              this.outstandingPokes.delete(id);
              // [%watch-ack p=(unit tang)]
            } else if (
              tag === 'watch-ack' &&
              this.outstandingSubscriptions.has(id)
            ) {
              const funcs = this.outstandingSubscriptions.get(id);
              if (bod instanceof Cell) {
                //TODO  pre-render tang?
                console.error(bod.tail);
                funcs.err(id, bod.tail);
                this.outstandingSubscriptions.delete(id);
              }
              // [%fact =desk =mark =noun]
            } else if (
              tag === 'fact' &&
              this.outstandingSubscriptions.has(id)
            ) {
              const funcs = this.outstandingSubscriptions.get(id);
              try {
                //TODO  support binding conversion callback?
                const mark = Atom.cordToString(bod.tail.head);
                //NOTE  we don't pass the desk. it's a leak-y eyre impl detail
                funcs.event(id, mark, bod.tail.tail);
              } catch (e) {
                console.error('Failed to call subscription event callback', e);
              }
              // [%kick ~]
            } else if (
              tag === 'kick' &&
              this.outstandingSubscriptions.has(id)
            ) {
              const funcs = this.outstandingSubscriptions.get(id);
              funcs.quit();
              this.outstandingSubscriptions.delete(id);
              this.emit('subscription', {
                id: id,
                status: 'close',
              });
            } else if (this.verbose) {
              console.log([...this.outstandingSubscriptions.keys()]);
              console.log('Unrecognized response', data, data.toString());
            }
          } else {
            console.log('strange event noun', data.toString());
          }
        },
        onerror: (error) => {
          this.errorCount++;
          this.emit('error', { time: Date.now(), msg: JSON.stringify(error) });
          if (error instanceof ReapError) {
            this.seamlessReset();
            return;
          }
          if (!(error instanceof FatalError)) {
            this.emit('status-update', { status: 'reconnecting' });
            this.onRetry && this.onRetry();
            return Math.min(5000, Math.pow(2, this.errorCount - 1) * 750);
          }
          this.emit('status-update', { status: 'errored' });
          this.onError && this.onError(error);
          throw error;
        },
        onclose: () => {
          console.log('e');
          throw new Error('Ship unexpectedly closed the connection');
        },
      });
    });
  }

  /**
   * Reset airlock, abandoning current subscriptions and wiping state
   *
   */
  reset() {
    if (this.verbose) {
      console.log('resetting');
    }
    this.delete();
    this.abort.abort();
    this.abort = new AbortController();
    this.uid = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;
    this.emit('reset', { uid: this.uid });
    this.lastEventId = 0;
    this.lastHeardEventId = -1;
    this.lastAcknowledgedEventId = -1;
    this.outstandingSubscriptions = new Map();
    this.outstandingPokes = new Map();
    this.sseClientInitialized = false;
  }

  private seamlessReset() {
    // called if a channel was reaped by %eyre before we reconnected
    // so we have to make a new channel.
    this.uid = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;
    this.emit('seamless-reset', { uid: this.uid });
    this.sseClientInitialized = false;
    this.lastEventId = 0;
    this.lastHeardEventId = -1;
    this.lastAcknowledgedEventId = -1;
    this.outstandingSubscriptions.forEach((sub, id) => {
      sub.quit();
      this.emit('subscription', {
        id,
        status: 'close',
      });
    });
    this.outstandingSubscriptions = new Map();

    this.outstandingPokes.forEach((poke, id) => {
      poke.onError('Channel was reaped');
    });
    this.outstandingPokes = new Map();
  }

  /**
   * Autoincrements the next event ID for the appropriate channel.
   */
  private getEventId(): number {
    this.lastEventId += 1;
    this.emit('id-update', { current: this.lastEventId });
    return this.lastEventId;
  }

  /**
   * Acknowledges an event.
   *
   * @param eventId The event to acknowledge.
   */
  private async ack(eventId: number): Promise<number | void> {
    this.lastAcknowledgedEventId = eventId;
    // [%ack event-id=@ud]
    await this.sendNounsToChannel(['ack', eventId]);
    return eventId;
  }

  //NOTE  every arg is interpreted (through nockjs.dwim) as a noun, which
  //      should result in a noun nesting inside of the xx $eyre-command type
  private async sendNounsToChannel(...args: (Noun | any)[]): Promise<void> {
    const response = await fetch(this.channelUrl, {
      ...this.fetchOptions('PUT'),
      method: 'PUT',
      body: formatUw(jam(dejs.list(args)).number.toString()),
    });
    if (!response.ok) {
      throw new Error('Failed to PUT channel');
    }
  }

  /**
   * Creates a subscription, waits for a fact and then unsubscribes
   *
   * @param app Name of gall agent to subscribe to
   * @param path Path to subscribe to
   * @param timeout Optional timeout before ending subscription
   *
   * @returns The first fact on the subcription
   */
  //TODO  T is always Noun now, so don't strictly need to parameterize
  async subscribeOnce<T = any>(app: string, path: NounPath, timeout?: number) {
    return new Promise<T>(async (resolve, reject) => {
      let done = false;
      let id: number | null = null;
      const quit = () => {
        if (!done) {
          reject('quit');
        }
      };
      const event = (id: number, m: string, n: T) => {
        if (!done) {
          resolve(n); //TODO  revisit
          this.unsubscribe(id);
        }
      };
      const request = { app, path, event, err: reject, quit };

      id = await this.subscribe(request);

      if (timeout) {
        setTimeout(() => {
          if (!done) {
            done = true;
            reject('timeout');
            this.unsubscribe(id);
          }
        }, timeout);
      }
    });
  }

  /**
   * Pokes a ship with data.
   *
   * @param app The app to poke
   * @param mark The mark of the data being sent
   * @param noun The data to send
   */
  async poke<T>(params: PokeInterface<T>): Promise<number> {
    const { app, mark, noun, shipName, onSuccess, onError } = {
      onSuccess: () => {},
      onError: () => {},
      shipName: this.ship,
      ...params,
    };

    if (this.lastEventId === 0) {
      this.emit('status-update', { status: 'opening' });
    }

    const eventId = this.getEventId();
    const ship = Atom.fromString(patp2dec('~' + shipName), 10);
    // [%poke request-id=@ud ship=@p app=term mark=@tas =noun]
    const non = ['poke', eventId, ship, app, mark, noun];
    this.outstandingPokes.set(eventId, {
      onSuccess: () => {
        onSuccess();
      },
      onError: (err) => {
        onError(err);
      },
    });
    await this.sendNounsToChannel(non);
    return eventId;
  }

  /**
   * Subscribes to a path on an app on a ship.
   *
   *
   * @param app The app to subsribe to
   * @param path The path to which to subscribe
   * @param handlers Handlers to deal with various events of the subscription
   */
  async subscribe(params: SubscriptionRequestInterface): Promise<number> {
    const { app, path, ship, err, event, quit } = {
      err: () => {},
      event: () => {},
      quit: () => {},
      ship: this.ship,
      ...params,
    };

    if (this.lastEventId === 0) {
      this.emit('status-update', { status: 'opening' });
    }

    const eventId = this.getEventId();
    this.outstandingSubscriptions.set(eventId, {
      app,
      path,
      err,
      event,
      quit,
    });

    this.emit('subscription', {
      id: eventId,
      app,
      path: path.join('/'),
      status: 'open',
    });

    // [%subscribe request-id=@ud ship=@p app=term =path]
    const non = [
      'subscribe',
      eventId,
      Atom.fromString(patp2dec('~' + ship), 10),
      app,
      path,
    ];
    await this.sendNounsToChannel(non);

    return eventId;
  }

  /**
   * Unsubscribes to a given subscription.
   *
   * @param subscription
   */
  async unsubscribe(subscription: number) {
    // [%unsubscribe request-id=@ud subscription-id=@ud]
    return this.sendNounsToChannel([
      'unsubscribe',
      this.getEventId(),
      subscription,
    ]).then(() => {
      this.emit('subscription', {
        id: subscription,
        status: 'close',
      });
      this.outstandingSubscriptions.delete(subscription);
    });
  }

  /**
   * Deletes the connection to a channel.
   */
  //TODO  noun-ify
  async delete() {
    const body = JSON.stringify([
      {
        id: this.getEventId(),
        action: 'delete',
      },
    ]);
    if (isBrowser) {
      navigator.sendBeacon(this.channelUrl, body);
    } else {
      const response = await fetch(this.channelUrl, {
        ...this.fetchOptions('PUT', 'json'),
        method: 'POST',
        body: body,
      });
      if (!response.ok) {
        throw new Error('Failed to DELETE channel in node context');
      }
    }
  }

  /**
   * Scry into an gall agent at a path
   *
   * @typeParam T - Type of the scry result
   *
   * @remarks
   *
   * Equivalent to
   * ```hoon
   * .^(T %gx /(scot %p our)/[app]/(scot %da now)/[path]/json)
   * ```
   * The returned cage must have a conversion to JSON for the scry to succeed
   *
   * @param params The scry request
   * @returns The scry result
   */
  async scry<T = any>(params: Scry): Promise<T> {
    const { app, path, mark } = params;
    console.log('scry', params);
    const response = await fetch(
      `${this.url}/~/scry/${app}${path}.${mark || 'json'}`, //TODO jam by default
      this.fetchOptions('GET') //NOTE  mode doesn't matter, not opening channel
    );

    if (!response.ok) {
      return Promise.reject(response);
    }

    return await response.json();
  }

  /**
   * Run a thread
   *
   * @param inputMark   The mark of the data being sent
   * @param outputMark  The mark of the data being returned
   * @param threadName  The thread to run
   * @param body        The data to send to the thread
   * @param desk        The desk to run the thread from
   * @returns  The return value of the thread
   */
  //TODO  noun-ify once spider is compatible
  async thread<R, T = any>(params: Thread<T>): Promise<R> {
    const { inputMark, outputMark, threadName, body, desk } = params;
    if (!desk) {
      throw new Error('Must supply desk to run thread from');
    }
    const res = await fetch(
      `${this.url}/spider/${desk}/${inputMark}/${threadName}/${outputMark}.json`,
      {
        ...this.fetchOptions('PUT', 'json'),
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    return res.json();
  }
}

export default Urbit;
