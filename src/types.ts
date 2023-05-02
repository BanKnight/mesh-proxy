// import { Socket } from "net";
import EventEmitter from "events";
import { randomUUID } from 'crypto';

import { Socket as ServerSocket } from "socket.io"
import { Socket as ClientSocket } from 'socket.io-client';
import { Duplex, Readable, Writable } from "stream";

export interface ServerOption {
    name: string
    url: string
}

export interface UserOption {
    user: string;
    token: string;
}

export interface ComponentOption extends Record<string, any> {
    name: string;
    component: string;
}

export interface Config {
    basic: {
        name: string;
        protocol: string;
        token?: string;
        port?: number;
    }
    users: Record<string, UserOption>;
    servers: ServerOption[];
    components: ComponentOption[];
}

export class Node extends EventEmitter {

    name: string
    url?: URL
    socket: ServerSocket | ClientSocket
    components: Record<string, Component> = {};  //[name] = compnent

    create_tunnel(id?: string) {

        const tunnel = new Tunnel(id)

        tunnel.io = (event: string, ...args: any[]) => {
            this.emit(`tunnel::${event}`, ...args)
        }

        this.once("close", () => {
            tunnel.destroy(new Error("node closed"))
        })

        if (this.socket) {
            this.socket.once("disconnect", () => {
                tunnel.destroy(new Error("node closed"))
            })
        }
        return tunnel
    }

    send(event: string, ...args: any[]) {
        if (this.socket) {
            this.socket.emit(event, ...args)
        }
        else {
            this.emit(event, ...args)
        }
    }
}

export class Component extends EventEmitter {

    node: Node
    name: string;
    options: ComponentOption

    constructor(options: ComponentOption) {
        super()
        this.name = options.name
        this.options = options
    }

    destroy(error?: Error) {
        this.emit('close', error)
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
    _read() {
    }
    _write(chunk: any, encoding: any, callback: any) {
        this.io("write", this, chunk)
        callback();
    }

    send(event: string, ...args: any[]) {
        this.io("event", this, event, ...args)
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

    close() {
        this.destroy()
    }
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

declare module "net"
{
    interface Socket {
        id: string;
    }
}
