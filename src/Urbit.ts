import { isBrowser, isNode } from 'browser-or-node';
import { UrbitHttpApiEvent, UrbitHttpApiEventType } from './events';
import { fetchEventSource, EventSourceMessage } from './fetch-event-source';

import {
  Scry,
  Thread,
  AuthenticationInterface,
  PokeInterface,
  SubscriptionRequestInterface,
  headers,
  SSEOptions,
  PokeHandlers,
  Message,
  FatalError,
  NounPath,
  ReapError,
} from './types';
import EventEmitter, { hexString } from './utils';

import { Noun, Atom, Cell, dwim, jam, cue } from '@urbit/nockjs';
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
   * Identity of the ship we're connected to
   */
  ship?: string | null;

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

  onError?: (error: any) => void = null;

  onRetry?: () => void = null;

  onOpen?: () => void = null;

  onReconnect?: () => void = null;

  /** This is basic interpolation to get the channel URL of an instantiated Urbit connection. */
  private get channelUrl(): string {
    return `${this.url}/~/channel/${this.uid}`;
  }

  private fetchOptions(
    method: ('PUT' | 'GET') = 'PUT',
    mode: ('jam' | 'json') = 'jam')
  : any {
    const type = (mode === 'jam') ? 'application/x-urb-jam' : 'application/json';
    let headers: headers = {};
    switch (method) {
      case 'PUT': headers['Content-Type']     = type; break;
      case 'GET': headers['X-Channel-Format'] = type; break;
    };
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
   * Constructs a new Urbit connection.
   *
   * @param url  The URL (with protocol and port) of the ship to be accessed. If
   * the airlock is running in a webpage served by the ship, this should just
   * be the empty string.
   * @param code The access code for the ship at that address
   */
  constructor(public url: string, public code?: string, public desk?: string) {
    if (isBrowser) {
      window.addEventListener('beforeunload', this.delete);
    }
    return this;
  }

  /**
   * All-in-one hook-me-up.
   *
   * Given a ship, url, and code, this returns an airlock connection
   * that is ready to go. It `|hi`s itself to create the channel,
   * then opens the channel via EventSource.
   *
   */
  //TODO  rename this to connect() and only do constructor & event source setup.
  //      that way it can be used with the assumption that you're already
  //      authenticated.
  static async authenticate({
    ship,
    url,
    code,
    verbose = false,
  }: AuthenticationInterface) {
    const airlock = new Urbit(
      url.startsWith('http') ? url : `http://${url}`,
      code
    );
    airlock.verbose = verbose;
    airlock.ship = ship;
    await airlock.connect();
    //TODO  can we just send an empty array?
    await airlock.poke({
      app: 'hood',
      mark: 'helm-hi',
      noun: dwim('opening airlock'),
    });
    await airlock.eventSource();
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
    this.ship = name.substring(1);
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
    this.our = name.substring(1);
  }

  /**
   * Connects to the Urbit ship. Nothing can be done until this is called.
   * That's why we roll it into this.authenticate
   * TODO  as of urbit/urbit#6561, this is no longer true, and we are able
   *       to interact with the ship using a guest identity.
   */
  //TODO  rename to authenticate() and call connect() at the end
  async connect(): Promise<void> {
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
    }).then(async response => {
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
      this.getShipName();
      this.getOurName();
    });
  }

  /**
   * Initializes the SSE pipe for the appropriate channel.
   */
  async eventSource(): Promise<void> {
    if (this.sseClientInitialized) {
      return Promise.resolve();
    }
    if (this.lastEventId === 0) {
      this.emit('status-update', { status: 'opening' });
      // Can't receive events until the channel is open,
      // so poke and open then
      //TODO  can we just send an empty array?
      await this.poke({
        app: 'hood',
        mark: 'helm-hi',
        noun: dwim('Opening API channel'),
      });
      return;
    }
    this.sseClientInitialized = true;
    return new Promise((resolve, reject) => {
      const sseOptions: SSEOptions = {
        headers: {},
      };
      if (isBrowser) {
        sseOptions.withCredentials = true;
      } else if (isNode) {
        sseOptions.headers.Cookie = this.cookie;
      }
      fetchEventSource(this.channelUrl, {
        ...this.fetchOptions('GET'),
        openWhenHidden: true,
        responseTimeout: 25000,
        onopen: async (response, isReconnect) => {
          if (this.verbose) {
            console.log('Opened eventsource', response);
          }
          if (isReconnect) {
            this.onReconnect && this.onReconnect();
          }
          if (response.ok) {
            this.errorCount = 0;
            this.onOpen && this.onOpen();
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
            console.log('got real data', data.toString());
          }

          // [request-id channel-event]
          if ( data instanceof Cell &&
               data.head instanceof Atom &&
               data.tail instanceof Cell &&
               data.tail.head instanceof Atom)
          {
            //NOTE  id could be string if id > 2^32, not expected in practice
            const id = data.head.valueOf() as number;
            const tag = Atom.cordToString(data.tail.head);
            const bod = data.tail.tail;
            // [%poke-ack p=(unit tang)]
            if (
              tag === 'poke-ack' &&
              this.outstandingPokes.has(id)
            ) {
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
            // [%fact =mark =noun]
            } else if (
              tag === 'fact' &&
              this.outstandingSubscriptions.has(id)
            ) {
              const funcs = this.outstandingSubscriptions.get(id);
              try {
                //TODO  support binding conversion callback?
                funcs.event(id, Atom.cordToString(bod.head), bod.tail);
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
    const non = dwim(['ack', eventId], 0);
    await this.sendNounToChannel(non);
    return eventId;
  }

  private async sendNounToChannel(noun: any): Promise<void> {
    const response = await fetch(this.channelUrl, {
      ...this.fetchOptions('PUT'),
      method: 'PUT',
      body: formatUw(Atom.fromString(jam(noun).toString().slice(2), 16).number.toString()),
    });
    if (!response.ok) {
      throw new Error('Failed to PUT channel');
    }
    if (!this.sseClientInitialized) {
      if (this.verbose) {
        console.log('initializing event source');
      }
      await this.eventSource();
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
          resolve(n);  //TODO  revisit
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
    const non = dwim(['poke', eventId, ship, app, mark, noun], 0);
    this.outstandingPokes.set(eventId, {
      onSuccess: () => { onSuccess(); },
      onError: (err) => { onError(err); },
    });
    await this.sendNounToChannel(non);
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
    const non = dwim([
      'subscribe',
      eventId,
      Atom.fromString(patp2dec('~' + ship), 10),
      app,
      path,
    ], 0);
    await this.sendNounToChannel(non);

    return eventId;
  }

  /**
   * Unsubscribes to a given subscription.
   *
   * @param subscription
   */
  async unsubscribe(subscription: number) {
    // [%unsubscribe request-id=@ud subscription-id=@ud]
    return this.sendNounToChannel(dwim(
      ['unsubscribe', this.getEventId(), subscription], 0
    )).then(() => {
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
    console.log('scry', params)
    const response = await fetch(
      `${this.url}/~/scry/${app}${path}.${ mark || 'json' }`, //TODO jam by default
      this.fetchOptions('GET')  //NOTE  mode doesn't matter, not opening channel
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
   * @returns  The return value of the thread
   */
  //TODO  noun-ify once spider is compatible
  async thread<R, T = any>(params: Thread<T>): Promise<R> {
    const {
      inputMark,
      outputMark,
      threadName,
      body,
      desk = this.desk,
    } = params;
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

  /**
   * Utility function to connect to a ship that has its *.arvo.network domain configured.
   *
   * @param name Name of the ship e.g. zod
   * @param code Code to log in
   */
  static async onArvoNetwork(ship: string, code: string): Promise<Urbit> {
    const url = `https://${ship}.arvo.network`;
    return await Urbit.authenticate({ ship, url, code });
  }
}

export default Urbit;
