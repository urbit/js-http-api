import Urbit, { NounPath } from '../src';
import { Noun, Atom, Cell, jam, dwim } from '@urbit/nockjs';
import { formatUw } from '@urbit/aura';
import 'jest';

function areNounsEqual(a: unknown, b: unknown): boolean | undefined {
  const isANoun = a instanceof Atom || a instanceof Cell;
  const isBNoun = b instanceof Atom || b instanceof Cell;

  if (isANoun && isBNoun) {
    return a.equals(b);
  } else if (isANoun === isBNoun) {
    return undefined;
  } else {
    return false;
  }
}

//NOTE  for some reason, this function isn't in the ts defs yet
(expect as any).addEqualityTesters([areNounsEqual]);

function fakeSSE(messages: any[] = [], timeout = 0) {
  const ourMessages = [...messages];
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const interval = setInterval(() => {
        let message = ':\n';
        if (ourMessages.length > 0) {
          message = ourMessages.shift();
        }

        controller.enqueue(enc.encode(message));
      }, 50);

      if (timeout > 0) {
        setTimeout(() => {
          controller.close();
          clearInterval(interval);
          interval;
        }, timeout);
      }
    },
  });
}

const ship = '~sampel-palnet';
function newUrbit(): Urbit {
  let airlock = new Urbit({ url: '' });
  //NOTE  in a real environment, these get populated at the end of connect()
  airlock.ship = airlock.our = ship;
  return airlock;
}

let eventId = 0;
function event(data: Noun) {
  //TODO  bigint and BigInteger not compatible ):
  return `id:${eventId++}\ndata:${formatUw(jam(data).number.toString())}\n\n`;
}

function fact(id: number, desk: string, mark: string, noun: Noun) {
  return event(dwim(id, 'fact', desk, mark, noun));
}

function ack(id: number, err = false) {
  const res: Noun = err ? dwim(0, 'my-cool-tang', 0) : dwim(0);
  return event(dwim(id, 'poke-ack', res));
}
const fakeFetch = (body: Function) => () =>
  Promise.resolve({
    ok: true,
    body: body(),
  });

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

process.on('unhandledRejection', (error) => {
  console.error(error);
});

describe('Initialisation', () => {
  let airlock: Urbit;
  let fetchSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    airlock = newUrbit();
  });
  afterEach(() => {
    fetchSpy.mockReset();
  });
  it('should poke & connect upon a 200', async () => {
    airlock.onOpen = jest.fn();
    fetchSpy = jest.spyOn(window, 'fetch');
    fetchSpy
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, body: null } as Response)
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, body: fakeSSE() } as Response)
      );
    await airlock.connect();

    expect(airlock.onOpen).toHaveBeenCalled();
  }, 500);
  it('should handle failures', async () => {
    fetchSpy = jest.spyOn(window, 'fetch');
    airlock.onRetry = jest.fn();
    airlock.onOpen = jest.fn();
    fetchSpy
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, body: fakeSSE() } as Response)
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, body: fakeSSE([], 100) } as Response)
      );

    airlock.onError = jest.fn();
    try {
      airlock.connect();
      await wait(200);
    } catch (e) {
      expect(airlock.onRetry).toHaveBeenCalled();
    }
  }, 300);
});

describe('subscription', () => {
  let airlock: Urbit;
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    eventId = 1;
  });
  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('should subscribe', async () => {
    fetchSpy = jest.spyOn(window, 'fetch');
    airlock = newUrbit();
    airlock.onOpen = jest.fn();
    const params = {
      app: 'app',
      path: ['path', 0] as NounPath,
      err: jest.fn(),
      event: jest.fn(),
      quit: jest.fn(),
    };
    const firstEv = dwim('one');
    const secondEv = dwim('two');
    const events = (id: number) => [
      fact(id, 'desk', 'mark', firstEv),
      fact(id, 'desk', 'mark', secondEv),
    ];
    fetchSpy.mockImplementation(fakeFetch(() => fakeSSE(events(1))));

    await airlock.connect();
    await airlock.subscribe(params);
    await wait(600);

    expect(airlock.onOpen).toBeCalled();
    expect(params.event).toHaveBeenNthCalledWith(1, 1, 'mark', firstEv);
    expect(params.event).toHaveBeenNthCalledWith(2, 1, 'mark', secondEv);
  }, 800);
  it('should handle poke acks', async () => {
    fetchSpy = jest.spyOn(window, 'fetch');
    airlock = newUrbit();
    airlock.onOpen = jest.fn();
    fetchSpy.mockImplementation(fakeFetch(() => fakeSSE([ack(1)])));
    const params = {
      app: 'app',
      mark: 'mark',
      noun: dwim(1),
      onSuccess: jest.fn(),
      onError: jest.fn(),
    };
    await airlock.connect();
    await airlock.poke(params);
    await wait(300);
    expect(params.onSuccess).toHaveBeenCalled();
  }, 800);

  it('should handle poke nacks', async () => {
    fetchSpy = jest.spyOn(window, 'fetch');
    airlock = newUrbit();
    airlock.onOpen = jest.fn();
    //TODO  response mocking should be more accurate/narrow
    fetchSpy
      .mockImplementationOnce(fakeFetch(() => fakeSSE()))
      .mockImplementationOnce(fakeFetch(() => fakeSSE([ack(1, true)])))
      .mockImplementationOnce(fakeFetch(() => fakeSSE([ack(1, true)])));

    const params = {
      app: 'app',
      mark: 'mark',
      noun: dwim(1),
      onSuccess: jest.fn(),
      onError: jest.fn(),
    };
    await airlock.connect();
    await airlock.poke(params);
    await wait(300);
    expect(params.onError).toHaveBeenCalled();
  }, 800);
});
