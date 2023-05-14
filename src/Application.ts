import { WebSocket, WebSocketServer } from "ws"
import { serialize, deserialize } from "v8"
import http from "http"
import https from "https"
import tls from "tls"

import { fileURLToPath, pathToFileURL } from "url"
import { join, resolve, basename, dirname } from "path";
import { parse } from "yaml";
import { readFileSync, readdirSync } from "fs";
import { Config, Component, Node, ComponentOption, Tunnel, HttpServer, SiteInfo, WSocket, SiteOptions } from "./types.js";
import { basic_auth } from "./utils.js"
import { Duplex } from "stream"
import { buffer } from "stream/consumers"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type Constructable<T> = new (...args: any[]) => T

export class Application {

    options: Config
    httpservers = new Map<number, HttpServer>()
    nodes: Record<string, Node> = {}           //[name] = node,有一个特殊的node表明是自己 [$self] = node
    tunnels: Record<string, Tunnel> = {}
    pairs: Record<string, Tunnel> = {}

    components: Record<string, Constructable<Component>> = {}

    constructor(file: string) {
        const content = readFileSync(resolve(file), "utf-8")
        this.options = Object.assign({ auth: {}, servers: [], components: [] },
            parse(content) as Config)
    }

    get name() {
        return this.options.name
    }

    async start() {

        const folder = resolve(__dirname, 'components');
        const files = readdirSync(folder).filter(file => file.endsWith('.js'));

        for (const file of files) {
            const name = basename(file, ".js")
            const filePath = pathToFileURL(join(folder, file)).toString();
            const { default: component_class } = await import(filePath)

            this.components[name] = component_class
        }

        this.prepare_self()
        this.connect_servers()
        this.prepare_components()

        if (this.options.port) {
            this.as_server()
        }
    }

    as_server() {

        const site = this.create_site({
            port: this.options.port,
            host: this.options.host || "",
            ssl: this.options.ssl,
        })

        const wsserver = new WebSocketServer({ noServer: true })

        const callback = (req: http.IncomingMessage, rawsocket: Duplex, head: Buffer) => {
            wsserver.handleUpgrade(req, rawsocket, head, (socket: WSocket, req) => {

                socket.on("message", (data: Buffer, isBinanry) => {
                    const { event, args } = deserialize(data)
                    socket.emit(event, ...args)
                })

                socket.write = (event: string, ...args: any[]) => {
                    socket.send(serialize({ event, args }))
                }

                socket.once("auth", (data: { user: string, token: string }) => {

                    const config_user = this.options.auth[data.user]
                    if (config_user == null || config_user.token != data.token) {
                        socket.write("auth_failed")
                        socket.close()
                        return
                    }

                    console.log(`node[${data.user}] logined`)

                    let node = this.nodes[data.user]
                    if (node) {
                        return
                    }

                    node = this.nodes[data.user] = new Node()
                    node.name = data.user
                    node.socket = socket

                    this.prepare_node(node)
                    this.prepare_node_socket(node)
                })

                socket.on("error", (error: Error) => {
                    console.error(error)
                })
            })
        }

        callback.ws = true

        site.locations.set(this.options.path, callback)
    }
    connect_servers() {
        if (this.options.servers == null) {
            return
        }

        for (const one of this.options.servers) {

            const node = new Node()

            node.url = new URL(one.url)
            node.name = one.name

            this.connect_node(node)
            this.prepare_node(node)
        }
    }

    connect_node(node: Node, retry = 0) {

        const socket = node.socket = (new WebSocket(node.url)) as WSocket

        let connecting = true

        socket.on("message", (data: Buffer, isBinanry) => {
            const { event, args } = deserialize(data)
            socket.emit(event, ...args)
        })

        socket.write = (event: string, ...args: any[]) => {
            socket.send(serialize({ event, args }))
        }

        socket.on('open', () => {
            connecting = false
            retry = 0

            socket.write("auth", {
                user: node.url?.username,
                token: node.url?.password
            })
            this.prepare_node_socket(node)
            this.on_node_connected(node)
        });

        socket.on("error", (reason: Error) => {
            if (socket.CONNECTING) {
                console.error("connect", node.name, reason)
                setTimeout(this.connect_node.bind(this, node), 5000)
            }
        })

        socket.on('close', (code: number, reason: Buffer) => {
            node.socket = null

            const retry_timeout = Math.min(3000 * Math.pow(2, retry), 30000)

            if (connecting) {
                console.log(`connect node[${node.name}] error,retry after ${retry_timeout / 1000} seconds`);
            }
            else {
                console.log('Disconnected from server', node.name);
            }
            retry++
            setTimeout(this.connect_node.bind(this, node, retry), retry_timeout)
        });
    }

    prepare_components() {

        if (this.options.components == null) {
            return
        }

        for (const options of this.options.components) {

            const names = options.name.split("/")
            if (names[0] != this.options.name) {
                continue
            }

            const node = this.nodes[names[0]]

            const component = this.create_component(options)

            component.node = node
            component.name = names[1]
            component.options = options
            component.create_site = this.create_site.bind(this)

            node.components[component.name] = component

            console.log(`component[${component.name}] created`)

            component.emit("ready")
            component.on("error", () => { })
        }
    }

    prepare_self() {
        const node = this.nodes[this.options.name] = new Node()
        node.name = this.options.name

        node.setMaxListeners(Infinity)

        this.prepare_node(node)
    }

    prepare_node(node: Node) {

        node.on("tunnel::connect", (tunnel: Tunnel, destination: string, ...args: any[]) => {
            const names = destination.split("/")
            const target = this.nodes[names[0]]

            console.log(this.name, "tunnel::connect", tunnel.id, destination)

            if (target == null) {
                tunnel.emit("error", new Error(`no such node: ${names[0]}`))
                return
            }
            if (target.socket) {
                this.tunnels[tunnel.id] = tunnel
                target.socket.write("tunnel::connect", tunnel.id, destination, ...args)
                return
            }

            const component = target.components[names[1]]

            if (component == null) {
                tunnel.emit("error", new Error(`no such component: ${destination}`))
                return
            }

            const revert = component.create_tunnel()

            console.log(this.name, "tunnel::revert", revert.id)

            this.tunnels[tunnel.id] = tunnel
            this.tunnels[revert.id] = revert

            this.pairs[tunnel.id] = revert
            this.pairs[revert.id] = tunnel

            component.emit("connection", revert, ...args)
            tunnel.emit("connect")
        })

        //本端发出事件
        node.on("tunnel::message", (tunnel: Tunnel, event: string, ...args: any[]) => {

            if (tunnel.destination == null) {
                let other = this.pairs[tunnel.id]
                other?.emit(event, ...args)
                return
            }

            const names = tunnel.destination.split("/")
            const target = this.nodes[names[0]]

            if (target == null) {
                tunnel.destroy(new Error(`no such node: ${names[0]}`))
                return
            }

            if (target.socket) {
                target.socket.write("tunnel::message", tunnel.id, event, ...args)
                return
            }

            const other = this.pairs[tunnel.id]

            if (other == null) {
                tunnel.destroy(new Error(`no pair: ${names[0]}`))
                return
            }

            other?.emit(event, ...args)
        })

        //本端发出write事件
        node.on("tunnel::write", (tunnel: Tunnel, chunk: any) => {

            if (tunnel.destination == null) {
                let revert = this.pairs[tunnel.id]
                revert?.push(chunk)
                return
            }

            const names = tunnel.destination.split("/")
            const target = this.nodes[names[0]]

            if (target == null) {
                tunnel.destroy(new Error(`no such node: ${names[0]}`))
                return
            }

            if (target.socket) {
                target.socket.write("tunnel::write", tunnel.id, chunk)
                return
            }

            const other = this.pairs[tunnel.id]

            if (other == null) {
                tunnel.destroy(new Error(`no pair: ${names[0]}`))
                return
            }
            other.push(chunk)
        })

        //本端发出write事件
        node.on("tunnel::end", (tunnel: Tunnel, chunk?: unknown) => {

            console.log(this.name, "tunnel::end", tunnel.id)

            const revert = this.pairs[tunnel.id]
            if (revert) {                           //通道干掉
                delete this.pairs[tunnel.id]
                revert.end(chunk)
            }

            if (tunnel.destination == null) {       //表明是本地的
                return
            }

            const names = tunnel.destination.split("/")
            const target = this.nodes[names[0]]

            if (target == null) {
                return
            }

            if (target.socket) {
                target.socket.write("tunnel::end", tunnel.id, chunk)
                return
            }
        })
        //本端发出destroy事件
        node.on("tunnel::destroy", (tunnel: Tunnel, error?: Error) => {

            console.log(this.name, "tunnel::destroy", tunnel.id)

            const existed = delete this.tunnels[tunnel.id]      //表明是从远端过来触发的
            if (existed == null) {
                return
            }

            const revert = this.pairs[tunnel.id]

            if (revert) {

                delete this.tunnels[revert.id]

                delete this.pairs[tunnel.id]
                delete this.pairs[revert.id]

                revert.destroy(error)
            }

            if (tunnel.destination == null) {       //表明是本地的
                return
            }

            const names = tunnel.destination.split("/")
            const target = this.nodes[names[0]]

            if (target == null) {
                return
            }

            if (target.socket) {
                target.socket.write("tunnel::destroy", tunnel.id, this.wrap_error(error))
                return
            }
        })
    }

    wrap_error(error?: Error) {
        if (error == null) {
            return
        }

        return { message: error.message, stack: error.stack }
    }

    prepare_node_socket(node: Node) {

        node.socket.on("auth_failed", () => {
            console.error("auth_failed")
        })

        node.socket.on("close", (code, reason) => {
            console.log(`node[${node.name}]disconnected due to ${code} ${reason}`);
            delete this.nodes[node.name]
        })

        node.socket.on("regist", (options: ComponentOption) => {

            const names = options.name.split("/")
            const that = this.nodes[names[0]]

            const component = this.create_component(options)

            component.name = names[1]
            component.node = that
            component.options = options
            component.create_site = this.create_site.bind(this)

            that.components[component.name] = component

            console.log(`component[${options.name}] created from: ${node.name}`)

            component.emit("ready")

            const on_disconnect = () => {

                node.socket.off("disconnect", on_disconnect)

                const exists = delete that.components[component.name]

                if (exists) {
                    console.log(`node[${node.name}]disconnect`, "destroy component", options.name)
                    component.destroy()
                }
            }

            node.socket.on("disconnect", on_disconnect)
        })

        node.socket.on("tunnel::connect", (id: string, destination: string, ...args: any[]) => {

            console.log(this.name, "tunnel::connect,from:", node.name, id, destination)

            const names = destination.split("/")
            const that = this.nodes[names[0]]
            const component = that.components[names[1]]

            if (component == null) {
                const error = new Error(`no such component: ${destination}`)
                node.socket.write("tunnel::error", id, { message: error.message, stack: error.stack })
                return
            }

            const tunnel = component.create_tunnel(id)

            tunnel.destination = `${node.name}/?`

            this.tunnels[tunnel.id] = tunnel

            component.emit("connection", tunnel, ...args)
            node.socket.write("tunnel::connection", id)

            //对端断开了，那么tunnel也要销毁
            node.socket.once("disconnect", () => {
                tunnel.destroy(new Error(`remote node[${node.name}]disconnect`))
            })
        })

        node.socket.on("tunnel::connection", (id: string) => {

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }

            tunnel.emit("connect")
        })
        node.socket.on("tunnel::message", (id: string, event: string, ...args: any[]) => {
            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }
            tunnel.emit(`message.${event}`, ...args)
        })
        node.socket.on("tunnel::write", (id: string, chunk: any) => {
            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }
            tunnel.push(chunk)
        })

        node.socket.on("tunnel::error", (id: string, error: any) => {
            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }
            const e = new Error(error.message)

            e.name = error.name;
            e.stack = e.stack + '\n' + error.stack;

            tunnel.emit("error", e)
            console.error(e.message)
        })

        node.socket.on("tunnel::end", (id: string, chunk?: unknown) => {

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }

            console.log(this.name, "tunnel::end,from", node.name, tunnel.id)

            tunnel.end(chunk)
        })

        node.socket.on("tunnel::destroy", (id: string, error?: any) => {

            console.log(this.name, "tunnel::destroy,from:", node.name, id)

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }

            console.log("destroy", id, error)

            delete this.tunnels[id]

            const revert = this.pairs[tunnel.id]
            if (revert) {

                delete this.tunnels[revert.id]

                delete this.pairs[tunnel.id]
                delete this.pairs[revert.id]
            }

            if (error) {

                const e = new Error(error.message)

                e.name = error.name;
                e.stack = e.stack + '\n' + error.stack;

                tunnel.destroy(e)
            }
            else {
                tunnel.close()
            }
        })
    }

    on_node_connected(node: Node) {

        console.log(`node[${node.name}] connected`)

        this.nodes[node.name] = node
        for (const component of this.options.components) {
            const names = component.name.split("/")
            if (names[0] != node.name) {
                continue
            }
            node.socket.write("regist", component)
        }
    }
    create_component(options: ComponentOption) {

        const class_ = this.components[options.type]
        if (class_ == null) {
            throw new Error(`unsupported component type: ${options.type} in ${options.name}`)
        }
        return new class_(options)
    }

    create_site(options: SiteOptions) {

        let port_server = this.httpservers.get(options.port)
        if (port_server == null) {
            port_server = this.create_http_server(options)
        }
        else if ((port_server.ssl == null) != (options.ssl == null)) {
            throw new Error(`confict ssl options at ${options.port}`)
        }

        let site = port_server.sites.get(options.host)
        if (site) {
            return site
        }

        site = {
            host: options.host,
            locations: new Map(),
            auth: new Map(),
        }

        if (options.ssl) {
            site.context = tls.createSecureContext(options.ssl);
        }

        port_server.sites.set(site.host, site)

        return site
    }

    create_http_server(options: SiteOptions) {

        let server: HttpServer

        if (options.ssl) {
            server = https.createServer({
                SNICallback: (servername, cb) => {
                    const site = server.sites.get(servername)
                    if (site) {
                        cb(null, site.context);
                    } else {
                        cb(new Error('No such server'));
                    }
                }
            }) as HttpServer

            server.port = options.port || 443
            server.ssl = true
        }
        else {
            server = (http.createServer()) as HttpServer
            server.port = options.port || 80
            server.ssl = false
        }

        server.sites = new Map()

        function get_site(req) {
            const url = new URL(req.headers.host)
            let site = server.sites.get(url.host)
            if (site == null) {
                site = server.sites.get("")
            }
            return site
        }

        server.on("request", (req, res) => {

            let site = get_site(req)

            if (site == null) {
                res.writeHead(404);
                res.end();
                return;
            }

            if (site.auth.size > 0) {
                const credentials = basic_auth(req)
                if (credentials == null) {
                    res.writeHead(404);
                    res.end("Unauthorized");
                    return;
                }
            }

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(0)

            const location = site.locations.get(req.url)    //location
            if (location == null) {
                return;
            }

            location(req, res)
        })
        server.on("upgrade", (req, socket, head) => {

            let site = get_site(req)
            if (site == null) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            if (site.auth.size > 0) {
                const credentials = basic_auth(req)
                if (credentials == null) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }

                const pass = site.auth.get(credentials.username)

                if (pass != credentials.password) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return
                }
            }
            const location = site.locations.get(req.url)    //location
            if (location == null || !location.ws) {
                socket.write('HTTP/1.1 401 unsupport this location\r\n\r\n');
                socket.destroy();
                return;
            }

            req.socket.setTimeout(0);
            req.socket.setNoDelay(true);
            req.socket.setKeepAlive(true, 0);

            location(req, socket, head)
        })

        server.listen(server.port, () => {
            console.log("http listening:", server.port)
        })

        server.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE') {
                console.log('Address in use, retrying...');
                setTimeout(() => {
                    server.close();
                    server.listen(server.port);
                }, 1000);
            }
        });

        this.httpservers.set(server.port, server)

        return server
    }
}

process.on("uncaughtException", (error: Error, origin: any) => {
    console.error("uncaughtException", error)
})

process.on("unhandledRejection", (error: Error, origin: any) => {
    console.error("unhandledRejection", error)
})