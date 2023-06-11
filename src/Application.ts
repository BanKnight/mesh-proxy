import { WebSocket, WebSocketServer } from "ws"
import { serialize, deserialize } from "v8"
import http from "http"
import https from "https"
import tls from "tls"

import url, { fileURLToPath, pathToFileURL, UrlWithStringQuery } from "url"
import { join, resolve, basename, dirname } from "path";
import { parse } from "yaml";
import { readFileSync, readdirSync } from "fs";
import { Config, Component, Node, ComponentOption, Tunnel, HttpServer, SiteInfo, WSocket, SiteOptions, ConnectListener, Location, Route, ComponentAddress } from "./types.js";
import { basic_auth } from "./utils.js"
import { Duplex, finished } from "stream"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type Constructable<T> = new (...args: any[]) => T

export class Application {

    options: Config
    httpservers = new Map<number, HttpServer>()
    nodes: Record<string, Node> = {}                               //[name] = node,连上来的node
    templates: Record<string, Constructable<Component>> = {}       //
    components: Record<string, Component> = {};                    //[name] = Component
    /**
     * 路由表：[dest_node] = next_node，使用RIP协议维护
     * 参考：https://blog.csdn.net/TheCarol/article/details/112106308
     */
    routes: Record<string, Route> = {}

    constructor(file: string) {
        const content = readFileSync(resolve(file), "utf-8")
        this.options = Object.assign({ auth: {}, servers: [], components: [] },
            parse(content) as Config)
    }

    get name() {
        return this.options.name
    }

    async start() {

        await this.prepare_self()
        await this.connect_servers()

        this.prepare_components()

        if (this.options.listen) {
            this.as_server()
        }

        if (this.options.debug) {
            setInterval(() => {
                const table = []

                table.push({
                    name: "pid",
                    val: process.pid,
                })

                const mem = process.memoryUsage()

                for (let name in mem) {
                    const val = mem[name]
                    table.push({
                        name: `memoryUsage/${name}`,
                        val: val / 1024 / 1024,
                    })
                }

                const cpu = process.cpuUsage()

                for (let name in cpu) {
                    const val = cpu[name]
                    table.push({
                        name: `cpuUsage/${name}`,
                        val: val / 1024 / 1024,
                    })
                }
                console.table(table)

            }, 30000)
        }
    }
    as_server() {

        let key: string | null, cert: string | null

        if (this.options.ssl) {
            key = this.options.ssl.key
            cert = this.options.ssl.cert
        }

        if (key?.startsWith(".") || key?.startsWith("/")) {
            const file = resolve(key)
            key = readFileSync(file, "utf-8")
        }

        if (cert?.startsWith(".") || cert?.startsWith("/")) {
            const file = resolve(cert)
            cert = readFileSync(file, "utf-8")
        }

        this.options.listen = url.parse(this.options.listen)

        const site = this.create_site({
            port: this.options.listen.port,
            host: this.options.listen.hostname || "",
            ssl: this.options.ssl ? { ...this.options.ssl, key, cert } : null
        })

        const wsserver = new WebSocketServer({ noServer: true })
        const that = this
        const location: Location = {
            upgrade: "websocket",
            callback(req, socket: Duplex, head: Buffer) {
                wsserver.handleUpgrade(req, socket, head, (socket: WSocket, req) => {

                    socket.setMaxListeners(Infinity)
                    socket.on("message", (data: Buffer, isBinanry) => {
                        const { event, args } = deserialize(data)
                        socket.emit(event, ...args)
                    })

                    socket.write = (event: string, ...args: any[]) => {
                        socket.send(serialize({ event, args }))
                    }
                    socket.once("auth", (data: { user: string, token: string }) => {

                        const config_user = that.options.auth[data.user]
                        if (config_user == null || config_user.token != data.token) {
                            socket.write("auth_failed")
                            socket.close()
                            return
                        }

                        console.log(`node[${data.user}] logined`)

                        let node = that.nodes[data.user]
                        if (node) {
                            socket.close()
                            console.log(`conflict node[${data.user}] logined, closed`)
                            return
                        }

                        node = new Node()
                        node.name = data.user
                        node.socket = socket

                        that.on_node_connected(node)
                        that.prepare_node_socket(node)
                    })

                    socket.on("error", (error: Error) => {
                        console.error(error)
                    })
                })
            }
        }

        site.locations.set(this.options.listen.path, location)
    }
    async connect_servers() {
        if (this.options.servers == null) {
            return
        }

        const all = []

        for (const one of this.options.servers) {

            const node = new Node()

            node.url = new URL(one.url)
            node.name = one.name
            node.options = one

            if (one.ssl) {
                let { key, cert } = one.ssl

                if (key?.startsWith(".") || key?.startsWith("/")) {
                    const file = resolve(key)
                    one.ssl.key = readFileSync(file, "utf-8")
                }

                if (cert?.startsWith(".") || cert?.startsWith("/")) {
                    const file = resolve(cert)
                    one.ssl.cert = readFileSync(file, "utf-8")
                }
            }
            all.push(new Promise((resolve, reject) => {
                this.connect_node(node)
                node.once("connect", resolve)
            }))
        }

        await Promise.all(all)
    }

    connect_node(node: Node, retry = 0) {

        const socket = node.socket = (new WebSocket(node.url, {
            ...node.options.ssl,
            rejectUnauthorized: false,
        })) as WSocket

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

            const timer = setInterval(() => {
                if (socket.readyState == socket.CLOSED) {
                    clearInterval(timer)
                    return
                }
                else {
                    socket.ping()
                }
            }, 5000)

            node.emit("connect")
        });

        socket.on("error", (reason: Error) => {
            if (socket.CONNECTING) {
                console.error("connect", node.name, reason)
                setTimeout(this.connect_node.bind(this, node), 5000)
            }
        })

        socket.on('close', (code: number, reason: Buffer) => {
            node.socket = null
            const retry_timeout = Math.min(3000 * Math.pow(2, retry), 20000)

            if (connecting) {
                console.log(`connect node[${node.name}] error,retry after ${retry_timeout / 1000} seconds`);
            }
            else {
                console.log(`node[${node.name}] closed`);
            }
            retry++
            setTimeout(this.connect_node.bind(this, node, retry), retry_timeout)
        });

        socket.setMaxListeners(Infinity)
    }

    prepare_components() {

        if (this.options.components == null) {
            return
        }

        for (const options of this.options.components) {

            const [node_name, component_name] = options.name.split("/")
            if (node_name != this.name) {
                continue
            }

            const component = this.components[component_name] = this.create_component(options)

            component.node = node_name
            component.name = component_name
            component.emit("ready")

            console.log(`component[${component.name}] created`)
        }
    }

    async prepare_self() {

        const folder = resolve(__dirname, 'components');
        const files = readdirSync(folder).filter(file => file.endsWith('.js'));

        for (const file of files) {
            const name = basename(file, ".js")
            const filePath = pathToFileURL(join(folder, file)).toString();
            const { default: component_class } = await import(filePath)

            this.templates[name] = component_class
        }
        this.routes[this.name] = {
            dest: this.name,
            distance: 0,
            next: this.name,
        }
    }

    wrap_error(error?: Error) {
        if (error == null) {
            return
        }

        return { message: error.message, stack: error.stack }
    }

    on_node_connected(node: Node) {

        console.log(`node[${node.name}] connected`)

        this.nodes[node.name] = node

        this.routes[node.name] = {
            dest: node.name,
            distance: 1,
            next: node.name,
        }
        for (const component of this.options.components) {
            const names = component.name.split("/")
            if (names[0] != node.name) {        //这里和route不同，仅发送和自己相邻的regist指令
                continue
            }
            node.socket.write("regist", component)
        }
        this.send_my_routes(node)
    }

    on_node_disconnected(node: Node) {

        delete this.nodes[node.name]

        for (let dest in this.routes) {
            const route = this.routes[dest]

            //不要用直接删除的方案，因为还需要同步给到别人
            if (route.next != node.name) {
                continue
            }
            route.distance = Infinity        //表示不可达
        }

        for (const node_name in this.nodes) {
            const curr = this.nodes[node_name]
            if (node_name == this.name || curr.socket == null) {
                continue
            }
            this.send_my_routes(curr)
        }

        const error = new Error(`tunnel destroy when node[${node.name}] disconnected`)
        for (let id in node.tunnels) {
            const tunnel = node.tunnels[id]
            tunnel.destroy(error)
        }

        // node.tunnels = {}

        this.update_sites()
    }

    send_my_routes(node: Node) {

        const routes = {}

        for (let dest in this.routes) {
            const route = this.routes[dest]
            if (dest == this.name || dest == node.name) {
                continue
            }
            routes[dest] = route
        }

        node.socket.write("route", routes)
    }

    find_route_next(dest: string) {
        let route = this.routes[dest]
        if (route == null || route.distance == Infinity) {
            return null
        }
        return route.next
    }

    prepare_node_socket(node: Node) {

        this.update_sites()

        node.socket.on("auth_failed", () => {
            console.error("auth_failed")
        })

        node.socket.on("route", (routes: Record<string, Route>) => {

            let changed = false

            for (let dest in routes) {

                const route = routes[dest]
                const exists = this.routes[dest]

                if (this.nodes[dest]) {
                    continue
                }

                route.distance++

                if (exists == null) {
                    this.routes[dest] = route
                    changed = true
                }
                else if (route.next == exists.next) {
                    this.routes[dest] = route
                    changed = true
                }
                else if (route.distance < exists.distance) {
                    this.routes[dest] = route
                    changed = true
                }
            }

            if (!changed) {
                return
            }

            for (const node_name in this.nodes) {
                const curr = this.nodes[node_name]
                if (curr == node || curr.socket == null) {
                    continue
                }
                this.send_my_routes(curr)
            }
        })

        node.socket.on("close", (code, reason) => {
            console.log(`node[${node.name}] disconnected due to ${code} ${reason.toString("utf8")}`);
            this.on_node_disconnected(node)
        })

        node.socket.on("regist", (options: ComponentOption) => {

            const [node_name, component_name] = options.name.split("/")

            if (node_name != this.name) {
                console.error("unsupported remote regist", options.name)
                return
            }

            const component = this.components[component_name] = this.create_component(options)

            component.name = component_name
            component.node = node_name
            component.once("close", () => {
                node.socket?.off("close", on_disconnect)
                delete this.components[component.name]
            })

            const on_disconnect = () => {
                component.destroy()
                console.log(`component[${component.name}] destroy when node[${node.name}] close`)
            }

            node.socket.once("close", on_disconnect)

            component.emit("ready")
            console.log(`component[${options.name}] created from: ${node.name}`)
        })

        node.socket.on("tunnel::connect", async (id: string, address: ComponentAddress, ...args: any[]) => {

            const [node_name, component_name] = address

            if (node_name == this.name)      //local
            {
                return this.remote_to_local(node, id, address, ...args)
            }

            const next_node = this.find_route_next(node_name)

            if (next_node == null) {
                const error = new Error(`no such node: ${address}`)
                node.socket.write("tunnel::error", id, { message: error.message, stack: error.stack })
                return
            }

            const that = this.nodes[next_node]

            if (that == null) {
                const error = new Error(`no such component: ${address}`)
                node.socket.write("tunnel::error", id, { message: error.message, stack: error.stack })
                return
            }

            return this.remote_to_remote(node, that, id, address, ...args)
        })

        node.socket.on("tunnel::connection", (id: string, ...args: any[]) => {

            const tunnel = node.tunnels[id]
            if (tunnel == null) {
                node.socket.write("tunnel::close", id)
                return
            }

            tunnel.connecting = false
            tunnel.readyState = "open"

            tunnel.emit("connect", ...args)
        })

        node.socket.on("tunnel::message", (id: string, event: string, ...args: any[]) => {
            const tunnel = node.tunnels[id]
            if (tunnel == null) {
                return
            }
            tunnel.emit(`message.${event}`, ...args)
        })

        node.socket.on("tunnel::data", (id: string, chunk: any) => {
            const tunnel = node.tunnels[id]
            if (tunnel == null) {
                return
            }
            tunnel.push(chunk)
        })

        node.socket.on("tunnel::final", (id: string) => {

            const tunnel = node.tunnels[id]
            if (tunnel == null) {
                return
            }

            //对端停止发送数据过来，那么这条通路就可以关了
            // delete node.tunnels[id]

            // console.log(this.name, "tunnel::final from", node.name, tunnel.id)

            tunnel.readyState = "writeOnly"
            tunnel.push(null)
        })

        node.socket.on("tunnel::error", (id: string, error: any) => {

            const tunnel = node.tunnels[id]
            if (tunnel == null) {
                return
            }

            const e = new Error(error.message)

            e.name = error.name;
            e.stack = e.stack + '\n' + error.stack;

            tunnel.emit("error", e)
        })

        node.socket.on("tunnel::close", (id: string, error?: any) => {

            const tunnel = node.tunnels[id]
            if (tunnel == null) {
                return
            }

            // console.log(this.name, "tunnel::destroy,from:", node.name, id)

            delete node.tunnels[id]

            if (error) {

                const e = new Error(error.message)

                e.name = error.name;
                e.stack = error.stack;

                tunnel.emit("error", e)
            }
            tunnel.emit("close")
        })
    }

    remote_to_local(node: Node, id: string, address: ComponentAddress, ...args: any[]) {

        const component = this.components[address[1]]

        if (component == null) {
            const error = new Error(`no such component: ${address}`)
            node.socket.write("tunnel::error", id, { message: error.message, stack: error.stack })
            return
        }

        const tunnel = new Tunnel(id)

        tunnel.setMaxListeners(Infinity)
        tunnel.remote = [node.name, "?"]
        tunnel.readyState = "open"

        node.tunnels[id] = tunnel       //注意：这里是node的tunnels
        component.tunnels[id] = tunnel

        finished(tunnel, (error) => {
            delete node.tunnels[id]
            delete component.tunnels[id]

            if (!tunnel.destroyed) {
                tunnel.destroy(error)
            }
        })

        tunnel._write = (chunk, encoding, callback) => {
            node.socket?.write("tunnel::data", id, chunk)
            callback()
        }

        tunnel._read = () => { };
        tunnel._final = (callback: (error?: Error | null) => void) => {
            node.socket?.write("tunnel::final", id)
            callback()
        }

        tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
            node.socket?.write("tunnel::close", id)
            callback(error)
        }

        tunnel.cork()
        component.emit("connection", tunnel, ...args, (...args: any[]) => {
            node.socket?.write("tunnel::connection", id, ...args)
            tunnel.uncork()
        })
    }

    remote_to_remote(node: Node, that: Node, id: string, address: ComponentAddress, ...args: any[]) {

        const tunnel = new Tunnel(id)       //send node
        const revert = new Tunnel(id)        //send that

        tunnel.remote = address
        tunnel.readyState = "open"
        tunnel.setMaxListeners(Infinity)

        revert.remote = [node.name, "?"]
        revert.readyState = "open"
        revert.setMaxListeners(Infinity)

        const tunnels = [
            [tunnel, node],
            [revert, that]
        ]

        for (const one of tunnels) {

            const tunnel = one[0] as Tunnel
            const node = one[1] as Node

            tunnel._write = (chunk, encoding, callback) => {
                node.socket?.write("tunnel::data", id, chunk)
                callback()
            }

            tunnel._read = () => { };
            tunnel._final = (callback: (error?: Error | null) => void) => {
                node.socket?.write("tunnel::final", id)
                callback()
            }

            tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
                node.socket?.write("tunnel::close", id)
                callback(error)
            }

            node.tunnels[id] = tunnel

            finished(tunnel, (error) => {
                delete node.tunnels[id]
                if (!tunnel.destroyed) {
                    tunnel.destroy(error)
                }
            })
        }

        tunnel.pipe(revert).pipe(tunnel)

        finished(tunnel, () => {
            if (!revert.destroyed) {
                revert.destroy()
            }
        })

        finished(revert, () => {
            if (!tunnel.destroyed) {
                tunnel.destroy()
            }
        })

        revert.once("connect", (...args: any[]) => {
            node.socket?.write("tunnel::connection", ...args)
        })

        that.socket.write("tunnel::connect", id, address, ...args)
    }

    create_component(options: ComponentOption) {

        const class_ = this.templates[options.type]
        if (class_ == null) {
            throw new Error(`unsupported component type: ${options.type} in ${options.name}`)
        }

        const component = new class_(options)

        component.options = options
        component.create_site = this.create_site.bind(this)
        component.createConnection = this.connect_component.bind(this, component)
        component.setMaxListeners(Infinity)

        component.on("close", () => {
            const error = new Error(`tunnel destroy by component[${component.name}] closed`)
            for (let id in component.tunnels) {
                const tunnel = component.tunnels[id]
                tunnel.destroy(error)
            }
            component.tunnels = {}
        })

        return component
    }

    connect_component(from_component: Component, address: string, context: { source: any, dest: any }, callback?: ConnectListener) {

        const [dest_node, dest_component] = address.split("/")
        const next_node = this.find_route_next(dest_node)

        if (next_node == null) {
            console.error("connect_component error:no route to next", address)
            return
        }

        if (this.name != next_node) {
            const route = this.nodes[next_node]
            return this.local_to_remote(from_component, route, [dest_node, dest_component], context, callback)
        }

        const component = this.components[dest_component]
        if (component == null) {
            return
        }

        return this.local_to_local(from_component, component, context, callback)
    }

    local_to_local(from_component: Component, to_component: Component, context: any, callback?: ConnectListener) {

        const src_tunnel = new Tunnel()
        const dst_tunnel = new Tunnel(src_tunnel.id)

        src_tunnel.remote = [this.name, to_component.name]
        src_tunnel.setMaxListeners(Infinity)

        dst_tunnel.remote = [this.name, from_component.name]
        dst_tunnel.setMaxListeners(Infinity)

        if (callback) {
            src_tunnel.once("connect", callback)
        }

        from_component.tunnels[src_tunnel.id] = src_tunnel
        to_component.tunnels[dst_tunnel.id] = dst_tunnel

        finished(src_tunnel, (error) => {
            delete from_component.tunnels[src_tunnel.id]       //在 component的close事件那里，统一做destroy

            if (!src_tunnel.destroyed) {
                src_tunnel.destroy(error)
            }
        })

        finished(dst_tunnel, (error) => {
            delete to_component.tunnels[dst_tunnel.id]       //在 component的close事件那里，统一做destroy
            if (!dst_tunnel.destroyed) {
                dst_tunnel.destroy(error)
            }
        })

        src_tunnel._write = (chunk, encoding, callback) => {
            if (!dst_tunnel.push(chunk, encoding)) {
                src_tunnel.cork();
            }
            callback()
        }
        src_tunnel._writev = (chunks, callback) => {
            for (const chunk of chunks) {
                dst_tunnel.push(chunk.chunk, chunk.encoding)
            }
            callback()
        }
        dst_tunnel._write = (chunk, encoding, callback) => {
            if (!src_tunnel.push(chunk, encoding)) {
                dst_tunnel.cork();
            }
            callback()
        }
        dst_tunnel._writev = (chunks, callback) => {
            for (const chunk of chunks) {
                src_tunnel.push(chunk.chunk, chunk.encoding)
            }
            callback()
        }
        src_tunnel._read = () => {
            for (let i = 0; i < dst_tunnel.writableCorked; ++i) {
                dst_tunnel.uncork()
            }
        };
        dst_tunnel._read = () => {
            for (let i = 0; i < src_tunnel.writableCorked; ++i) {
                src_tunnel.uncork()
            }
        };

        src_tunnel._final = (callback: (error?: Error | null) => void) => {
            callback()
            src_tunnel.readyState = "readOnly"
            dst_tunnel.push(null)
        }

        dst_tunnel._final = (callback: (error?: Error | null) => void) => {
            callback()
            dst_tunnel.readyState = "readOnly"
            src_tunnel.push(null)
        }
        src_tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
            src_tunnel.readyState = "closed"
            callback(error)
            dst_tunnel.emit("close")
        }

        dst_tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
            dst_tunnel.readyState = "closed"
            callback(error)
            src_tunnel.emit("close")
        }

        dst_tunnel.connecting = false
        dst_tunnel.readyState = "open"

        dst_tunnel.cork()
        to_component.emit("connection", dst_tunnel, context, (...args: any[]) => {

            src_tunnel.connecting = false
            src_tunnel.readyState = "open"

            process.nextTick(() => {
                src_tunnel.emit("connect", ...args)
                dst_tunnel.uncork()
            })
        })

        return src_tunnel
    }

    local_to_remote(from_component: Component, to_node: Node, address: ComponentAddress, context: any, callback: (error: Error | null, component: any) => void) {  //from_component is the local component, to

        const tunnel = new Tunnel()

        tunnel.remote = address
        tunnel.setMaxListeners(Infinity)

        if (callback) {
            tunnel.once("connect", callback)
        }

        from_component.tunnels[tunnel.id] = tunnel
        to_node.tunnels[tunnel.id] = tunnel

        finished(tunnel, { writable: true, readable: true }, (error) => {
            delete from_component.tunnels[tunnel.id]
            delete to_node.tunnels[tunnel.id]

            if (!tunnel.destroyed) {
                tunnel.destroy(error)
            }
        })

        tunnel._read = () => { }
        tunnel._write = (chunk, encoding, callback) => {
            to_node.socket?.write("tunnel::data", tunnel.id, chunk)
            callback()
        }
        //本方不再发送数据数据
        tunnel._final = (callback: (error?: Error | null) => void) => {
            to_node.socket?.write("tunnel::final", tunnel.id)
            tunnel.readyState = "readOnly"
            callback()
        }
        tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
            to_node.socket?.write("tunnel::close", tunnel.id, this.wrap_error(error))
            tunnel.readyState = "closed"
            callback(error)
        }

        to_node.socket.write("tunnel::connect", tunnel.id, address, context)

        return tunnel
    }

    create_site(options: SiteOptions) {

        let port_server = this.httpservers.get(options.port)
        if (port_server == null) {
            port_server = this.create_http_server(options)
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

    update_sites() {

        for (const [port, server] of this.httpservers) {
            for (let [domain, site] of server.sites) {
                if (site.locations.size == 0) {
                    server.sites.delete(domain)
                }
            }

            if (server.sites.size == 0) {
                this.httpservers.delete(port)
                server.close()
                console.log("unlisten", port)
            }
        }
    }



    create_http_server(options: SiteOptions) {

        let server: HttpServer

        if (options.ssl) {

            server = https.createServer({
                ...options,
                SNICallback: (servername, cb) => {
                    const site = get_site(servername)
                    if (site) {
                        cb(null, site.context);
                    } else {
                        cb(new Error('No such server'));
                    }
                },
            }) as HttpServer

            server.port = options.port || 443
            server.ssl = true
        }
        else {
            server = http.createServer({ ...options }) as HttpServer
            server.port = options.port || 80
            server.ssl = false
        }

        server.sites = new Map()

        function get_site(host: string) {
            let site = server.sites.get(host)
            if (site == null) {
                site = server.sites.get("")
            }
            return site
        }

        const extract_locations = {}
        const prefix_locations: { path: string, location: Location }[] = []
        const reg_locations: { path: string, location: Location }[] = []
        const default_locations: { path: string, location: Location }[] = []

        let prepare_locations = false

        function prepare(site: SiteInfo) {

            if (prepare_locations) {
                return
            }
            for (let [path, location] of site.locations) {
                if (path.startsWith("=")) {
                    extract_locations[path.substring(2)] = location
                }
                else if (path.startsWith("^~")) {
                    prefix_locations.push({ path: path.substring(2), location })
                }
                else if (path.startsWith("/")) {
                    default_locations.push({ path, location })
                }
                else {
                    reg_locations.push({ path, location })
                }
            }

            function compare(first: { path: string }, second: { path: string }) {
                return first.path.length - second.path.length
            }

            prefix_locations.sort(compare)
            reg_locations.sort(compare)
            default_locations.sort(compare)
        }

        function find(site: SiteInfo, uri: string): Location | null {

            prepare(site)

            let location = extract_locations[uri]
            if (location) {
                return location
            }

            for (const { path, location } of prefix_locations) {
                if (uri.startsWith(path)) {
                    return location
                }
            }

            for (const { path, location } of reg_locations) {
                const reg = new RegExp(path)
                if (reg.test(uri)) {
                    return location
                }
            }

            for (const { path, location } of default_locations) {
                if (uri.startsWith(path)) {
                    return location
                }
            }
        }

        server.on("request", (req, res) => {
            const array = req.headers.host.split(":")
            let site = get_site(array[0])
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

                const pass = site.auth.get(credentials.username)

                if (pass != credentials.password) {
                    res.writeHead(401, "Unauthorized")
                    res.end()
                    return
                }
            }

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(0)

            const index = req.url.indexOf('?');
            const uri = index !== -1 ? req.url.slice(0, index) : req.url;

            const location = find(site, uri)   //location
            if (location == null) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }

            location.callback(req, res)
        })

        // server.on("secureConnection", (tlsSocket) => {
        //     const site = get_site(tlsSocket.servername)
        //     if (site) {
        //         tlsSocket.context = site.context
        //     }
        // })

        server.on("tlsClientError", (err: Error, tlsSocket: tls.TLSSocket) => {
            console.error(err)
        })

        server.on("upgrade", (req, socket, head) => {
            const array = req.headers.host.split(":")
            let site = get_site(array[0])
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

            const index = req.url.indexOf('?');
            const uri = index !== -1 ? req.url.slice(0, index) : req.url;

            const location = find(site, uri)   //location
            if (location == null) {
                socket.write('HTTP/1.1 401 unsupport this location\r\n\r\n');
                socket.destroy();
                return;
            }
            req.socket.setTimeout(0);
            req.socket.setNoDelay(true);
            req.socket.setKeepAlive(true, 0);

            location.callback(req, socket, head)
        })
        server.listen(server.port, () => {
            console.log("http listening:", server.port)
        })

        server.on('error', (e: any) => {

            console.error(e)

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