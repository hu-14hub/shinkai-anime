/**
 * Minimal ambient type declarations for `webtorrent` v3 (browser surface only).
 * WebTorrent 3.x ships no types; these cover the subset used by
 * `@/lib/webtorrent-client`. Source of truth: WebTorrent/webtorrent.js.
 */

declare module "webtorrent" {
  export interface WebTorrentError extends Error {
    code?: string;
  }

  export interface TorrentFile {
    readonly path: string;
    readonly name: string;
    readonly length: number;
    readonly size: number;
    readonly type: string;
    readonly offset: number;
    readonly done: boolean;
    readonly downloaded: number;
    readonly progress: number;
    select(priority?: number): void;
    deselect(): void;
    stream(opts?: { start?: number; end?: number }): ReadableStream<Uint8Array>;
    arrayBuffer(opts?: { start?: number; end?: number }): Promise<ArrayBuffer>;
    blob(opts?: { start?: number; end?: number }): Promise<Blob>;
    streamTo(elem: HTMLMediaElement): HTMLMediaElement;
    includes(pieceIndex: number): boolean;
    on(event: "done", cb: () => void): this;
    once(event: "done", cb: () => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    removeAllListeners(event?: string): this;
    [Symbol.asyncIterator](opts?: {
      start?: number;
      end?: number;
    }): AsyncIterator<Uint8Array>;
  }

  export interface Torrent {
    readonly infoHash: string;
    name: string;
    readonly magnetURI: string;
    readonly length: number;
    readonly downloaded: number;
    readonly progress: number;
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    readonly numPeers: number;
    readonly done: boolean;
    readonly timeRemaining: number;
    files: TorrentFile[];
    on(event: "ready", cb: () => void): this;
    on(event: "error", cb: (err: WebTorrentError | Error) => void): this;
    on(event: "warning", cb: (err: WebTorrentError | Error) => void): this;
    on(event: "metadata", cb: () => void): this;
    on(event: "noPeers", cb: () => void): this;
    on(event: "done", cb: () => void): this;
    on(event: "wire", cb: (wire: unknown) => void): this;
    on(event: string, cb: (...args: never[]) => void): this;
    once(event: string, cb: (...args: never[]) => void): this;
    off(event: string, cb: (...args: never[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    removeAllListeners(event?: string): this;
    destroy(cb?: (err?: Error | null) => void): void;
    select(opts?: {
      start?: number;
      end?: number;
      priority?: number;
      files?: TorrentFile[];
    }): void;
    deselect(opts?: {
      start?: number;
      end?: number;
      files?: TorrentFile[];
    }): void;
  }

  export type WebTorrentAddSource =
    | string
    | Uint8Array
    | ArrayBuffer
    | Promise<string | Uint8Array | ArrayBuffer>;

  export interface DHTOptions {
    nodeId?: Uint8Array | string | number[];
    maxPeers?: number;
    public?: boolean;
    [key: string]: unknown;
  }

  export interface WebTorrentAddOpts {
    announce?: string | string[];
    skipHashCheck?: boolean;
    skipVerification?: boolean;
    priority?: number;
    dht?: false | DHTOptions;
    store?: unknown;
  }

  export interface WebTorrentClientOptions {
    dht?: false | DHTOptions;
    dhtPort?: number;
    webSeeds?: boolean;
    userAgent?: string;
    port?: number;
    maxPeers?: number;
    blocklist?: unknown;
  }

  export interface ClientServerOptions {
    controller?: ServiceWorkerRegistration;
  }

  export interface WebTorrentServer {
    readonly pathname: string;
    destroy(cb?: (err?: Error | null) => void): void;
  }

  export interface TorrentClient {
    torrents: Torrent[];
    readonly ready: boolean;
    readonly destroyed: boolean;
    readonly torrentPort: number | null;
    readonly dhtPort: number | null;
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    readonly progress: number;
    readonly ratio: number;
    add(source: WebTorrentAddSource): Promise<Torrent>;
    add(
      source: WebTorrentAddSource,
      opts: WebTorrentAddOpts
    ): Promise<Torrent>;
    add(
      source: WebTorrentAddSource,
      opts: WebTorrentAddOpts,
      cb: (err: Error | null, torrent: Torrent) => void
    ): Torrent;
    add(source: WebTorrentAddSource, cb: (err: Error | null, torrent: Torrent) => void): Torrent;
    get(
      infoHash: string,
      cb?: (err: Error | null, torrent: Torrent | null) => void
    ): void | Promise<Torrent | null>;
    remove(infoHash: string, cb?: (err?: Error | null) => void): void;
    destroy(cb?: (err?: Error | null) => void): void;
    createServer(
      options: ClientServerOptions,
      force?: "browser" | "node"
    ): WebTorrentServer;
    on(event: "listening", cb: () => void): this;
    on(event: "ready", cb: () => void): this;
    on(event: "error", cb: (err: WebTorrentError | Error) => void): this;
    on(event: "torrent", cb: (torrent: Torrent) => void): this;
    on(event: string, cb: (...args: never[]) => void): this;
    once(event: string, cb: (...args: never[]) => void): this;
    off(event: string, cb: (...args: never[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    removeAllListeners(event?: string): this;
  }

  export type Client = TorrentClient;

  export interface WebTorrentConstructor {
    new (opts?: WebTorrentClientOptions): TorrentClient;
    readonly WEBRTC_SUPPORT: boolean;
    readonly UTP_SUPPORT: boolean;
    readonly VERSION: string;
  }

  const WebTorrent: WebTorrentConstructor;
  export default WebTorrent;
  export { WebTorrent };
}