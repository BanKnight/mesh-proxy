// import { Socket } from "net";
import EventEmitter from "events";
import { randomUUID } from 'crypto';
import http from "http"
import https from "https"
import tls, { SecureContextOptions } from 'tls';
import ws from "ws"
import { Duplex, Readable, Writable } from "stream";
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
export class Component extends EventEmitter {

    node: Node
    name: string;
    options: ComponentOption
    create_site: (options: SiteOptions) => SiteInfo;

    constructor(options: ComponentOption) {
        super()
        this.name = options.name
        this.options = options
    }

    destroy(error?: Error) {
        this.emit('close', error)
    }
    create_tunnel(id?: string) {

        const tunnel = new Tunnel(id)

        tunnel.io = (event: string, ...args: any[]) => {
            this.node.emit(`tunnel::${event}`, ...args)
        }

        this.once("close", () => {
            tunnel.destroy(new Error(`component[${this.name}] close`))
        })

        this.on("error", (error) => {
            console.error("tunnel:error", error)
        })

        return tunnel
    }

}

export class Tunnel extends Duplex {
    id: string;
    destination: string;
    io: (event: string, ...args: any[]) => void;

    constructor(id?: string) {
        super({})
        this.id = id || randomUUID();
    }
    _read() { }
    _write(chunk: any, encoding: any, callback: any) {
        this.io("write", this, chunk)
        callback();
    }

    send(event: string, ...args: any[]) {
        this.io("message", this, event, ...args)
    }

    connect(destination: string, ...args: any[]) {
        this.destination = destination

        const cb = args[args.length - 1]
        if (cb && typeof (cb) == "function") {
            args.pop()
            this.once("connect", cb)
        }

        this.io("connect", this, destination, ...args)
    }
    destroy(error?: Error): this {
        if (this.destroyed) {
            return this
        }

        super.destroy(error)

        this.io("destroy", this, error)

        return this
    }

    end(chunk?: unknown): this {

        if (this.writableEnded) {
            return this
        }

        if (this.destroyed) {
            return this
        }

        this.io("end", this, chunk)
        return super.end(chunk)
    }

    on_message(event: string, listener: any) {
        this.on(`message.${event}`, listener)
    }

    off_message(event: string, listener: any) {
        this.off(`message.${event}`, listener)
    }

    close() {
        this.destroy()
    }
}

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


