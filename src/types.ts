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
    ssl: any
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
    options: any
    socket: WSocket
    tunnels: Record<string, Tunnel> = {}  //需要本node中转的tunnel

    send(event: string, ...args: any[]) {
        if (this.socket) {
            this.socket.write(event, ...args)
        }
        else {
            this.emit(event, ...args)
        }
    }
}

export type SiteOptions = http.ServerOptions & {
    host: string,
    port?: number,
    ssl?: SecureContextOptions,
}

export type ConnectListener = (...args: any[]) => void

export interface ConnectionContext extends Record<string, any> {
    src?: {
        socket?: {
            remoteAddress: string
            remotePort: number
            family: string
            protocol?: "tcp" | "udp" | "http";
            [key: string]: any
        },
        host?: string;
        port?: number;
        protocol?: "tcp" | "udp" | "http";
        family?: "IPv4" | "IPv6";
        [key: string]: any
    };
    dest?: {
        host?: string;
        port?: number;
        protocol?: "tcp" | "udp" | "http";
        family?: "IPv4" | "IPv6";
        [key: string]: any
    }
}
export class Component extends EventEmitter {

    node: string
    name: string;
    tunnels: Record<string, Tunnel> = {}
    options: ComponentOption
    create_site: (options: SiteOptions) => SiteInfo;
    createConnection: (address: string, context: ConnectionContext, callback?: ConnectListener) => Tunnel;

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

export type ComponentAddress = [string, string]

let count = 0
export class Tunnel extends Duplex {
    id: string;
    order = ++count
    remote: ComponentAddress;
    /**
     * If `true`,`socket.connect(options[, connectListener])` was
     * called and has not yet finished. It will stay `true` until the socket becomes
     * connected, then it is set to `false` and the `'connect'` event is emitted. Note
     * that the `socket.connect(options[, connectListener])` callback is a listener for the `'connect'` event.
     * @since v6.1.0
     */
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
            allowHalfOpen: false,   //可读端end的时候，调用可写端.end()了
            autoDestroy: true,
            emitClose: true,
            objectMode: false,
            writableObjectMode: false
        })
        this.id = id || randomUUID();
    }
    send(event: string, ...args: any[]) {
        this.io("message", this, event, ...args)
    }
}

export type CachedTunnel = Tunnel & { pendings?: Buffer[], next?: Function }

export interface Location extends Record<string, any> {
    callback: (req: http.IncomingMessage, ...args: any[]) => void
    upgrade?: string
}

// export type Location = (req: http.IncomingMessage, res: http.ServerResponse) => void
export interface SiteInfo {
    host: string;
    context?: tls.SecureContext;
    locations: Map<string, Location>;
    auth: Map<string, string>
}

export type HttpServer = (http.Server | https.Server) & {
    port: number;
    ssl: boolean;
    sites: Map<string, SiteInfo>;
}

export interface Route {
    dest: string;     //目的路由
    distance: number;   //距离
    next: string;       //下一跳
}



