// import { Socket } from "net";
import EventEmitter from "events";
import { randomUUID } from 'crypto';

import { Socket as ServerSocket } from "socket.io"
import { Socket as ClientSocket } from 'socket.io-client';
import { Duplex, Readable, Writable } from "stream";

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


    create_tunnel(id?: string) {

        const tunnel = new Tunnel(id)

        tunnel.io = (event: string, ...args: any[]) => {
            this.node.emit(`tunnel::${event}`, ...args)
        }

        this.once("close", () => {
            tunnel.destroy(new Error(`component[${this.name}] close`))
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
