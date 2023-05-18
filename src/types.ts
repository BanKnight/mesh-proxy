// import { Socket } from "net";
import EventEmitter from "events";
import { randomUUID } from 'crypto';
import http from "http"
import https from "https"
import tls, { SecureContextOptions } from 'tls';
import ws from "ws"
import { Duplex, DuplexOptions, Readable, Writable } from "stream";
declare module "net"
{
    interface Socket {
        id: string;
    }
}

export type WSocket = ws.WebSocket & {
    write?: (event: string, ...args: any[]) => void
}
export interface ServerOption {
    name: string
    url: string
    token: string
}

export interface UserOption {
    user: string;
    token: string;
}

export interface ComponentOption extends Record<string, any> {
    name: string;
    type: string;
}


export interface Config extends Record<string, any> {
    name: string;
    token?: string;
    port?: number;
    host?: string;
    path?: string;
    auth: Record<string, UserOption>;
    servers: ServerOption[];
    components: ComponentOption[];
}

export class Node extends EventEmitter {

    name: string
    url?: URL
    socket: WSocket
    components: Record<string, Component> = {};  //[name] = compnent

    send(event: string, ...args: any[]) {
        if (this.socket) {
            this.socket.write(event, ...args)
        }
        else {
            this.emit(event, ...args)
        }
    }
}


export interface SiteOptions {
    host: string,
    port?: number,
    ssl?: SecureContextOptions,
}

export type ConnectListener = (error?: Error, tunnel?: Tunnel, ...args: any[]) => void

interface a {
    on(event: "connection", listener: (tunnel: Tunnel, source: any, dest: any, callback: ConnectListener) => void): this;
}

export class Component extends EventEmitter implements a {

    node: Node
    name: string;
    options: ComponentOption
    create_site: (options: SiteOptions) => SiteInfo;
    createConnection: (address: string, context: { source: any, dest?: any }, callback: ConnectListener) => Tunnel;

    constructor(options: ComponentOption) {
        super()
        this.name = options.name
        this.options = options
    }

    destroy(error?: Error) {
        this.emit('close', error)
    };

}

export type TunnelReadyState = 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed';
export class Tunnel extends Duplex {
    id: string;
    destination: string;

    connecting = true
    /**
     * This property represents the state of the connection as a string.
        If the stream is connecting socket.readyState is opening.
        If the stream is readable and writable, it is open.
        If the stream is readable and not writable, it is readOnly.
        If the stream is not readable and writable, it is writeOnly.
     */
    readyState: TunnelReadyState = "opening"

    io: (event: string, ...args: any[]) => void;

    constructor(id?: string, options?: DuplexOptions) {
        super({
            ...options,
            autoDestroy: false,
            emitClose: false,
            objectMode: false,
            writableObjectMode: false
        })
        this.id = id || randomUUID();
    }
    send(event: string, ...args: any[]) {
        this.io("message", this, event, ...args)
    }
}

export type CachedTunnel = Tunnel & { pendings?: Buffer, next?: Function }

export type Location = (req: http.IncomingMessage, res: http.ServerResponse) => void
export interface SiteInfo {
    host: string;
    // callback?: (...args: any[]) => void;
    context?: tls.SecureContext;
    locations: Map<string, Location>;
    auth: Map<string, string>
}

export type HttpServer = (http.Server | https.Server) & {
    port: number;
    ssl: boolean;
    sites: Map<string, SiteInfo>;
}

// export class Tunnel extends Duplex {

//     id: string

//     constructor(id?: string, opts?: DuplexOptions) {
//         super(opts)
//         this.id = id || randomUUID();
//     }

//     _read(size: number): void { }

//     _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error) => void): void {

//     }
// }


