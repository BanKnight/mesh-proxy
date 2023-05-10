import { Server, Socket as ServerSocket } from "socket.io"
import io from 'socket.io-client';
import { fileURLToPath, pathToFileURL } from "url"
import { join, resolve, basename, dirname } from "path";
import { parse } from "yaml";
import { readFileSync, readdirSync } from "fs";
import { Config, Component, Node, ComponentOption, Tunnel } from "./types.js";

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type Constructable<T> = new (...args: any[]) => T

export class Application {

    config: Config
    server?: Server;
    nodes: Record<string, Node> = {}                                   //[name] = node,有一个特殊的node表明是自己 [$self] = node
    tunnels: Record<string, Tunnel> = {}
    pairs: Record<string, Tunnel> = {}

    components: Record<string, Constructable<Component>> = {}

    constructor(file: string) {
        const content = readFileSync(resolve(file), "utf-8")
        this.config = Object.assign({ users: [], servers: [], components: [] },
            parse(content) as Config)
    }

    get name() {
        return this.config.basic.name
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

        if (this.config.basic.port) {
            this.as_server()
        }
    }

    as_server() {
        this.server = new Server()
        this.server.on("connection", (socket: ServerSocket) => {

            socket.once("auth", (data: { user: string, token: string }) => {

                const config_user = this.config.users[data.user]
                if (config_user == null || config_user.token != data.token) {
                    socket.emit("auth_failed")
                    socket.disconnect(true)
                    return
                }

                console.log("recv node", data.user)

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

        this.server.on("error", (e) => {
            console.error(e)
        })

        this.server.listen(this.config.basic.port)
    }

    connect_servers() {
        if (this.config.servers == null) {
            return
        }

        for (const one of this.config.servers) {

            const node = new Node()

            node.url = new URL(one.url)
            node.name = one.name

            const socket = node.socket = io(one.url, {
                reconnection: true,
            });

            socket.on('connect', () => {

                socket.emit("auth", {
                    user: node.url?.username,
                    token: node.url?.password
                })

                this.on_node_connected(node)
            });

            socket.on('disconnect', () => {
                console.log('Disconnected from server');
            });
            //重试失败后会调用reconnect_failed事件
            socket.on('reconnect_failed', function () {
                console.log('reconnect_failed');
            });

            this.prepare_node(node)
            this.prepare_node_socket(node)
        }
    }

    prepare_components() {

        if (this.config.components == null) {
            return
        }

        for (const options of this.config.components) {

            const names = options.name.split("/")
            if (names[0] != this.config.basic.name) {
                continue
            }

            const node = this.nodes[names[0]]

            const component = this.create_component(options)

            component.node = node
            component.name = names[1]
            component.options = options

            node.components[component.name] = component

            console.log("create component", component.name)

            component.emit("ready")
            component.on("error", () => { })
        }
    }

    prepare_self() {
        const node = this.nodes[this.config.basic.name] = new Node()
        node.name = this.config.basic.name

        node.setMaxListeners(Infinity)

        this.prepare_node(node)
    }

    prepare_node(node: Node) {

        node.on("tunnel::connect", (tunnel: Tunnel, destination: string, ...args: any[]) => {
            const names = destination.split("/")
            const target = this.nodes[names[0]]

            console.log(this.name, "tunnel::connect", tunnel.id, destination)

            if (target == null) {
                tunnel.emit("error", new Error(`no such node:${names[0]}`))
                return
            }
            if (target.socket) {
                this.tunnels[tunnel.id] = tunnel
                target.socket.emit("tunnel::connect", tunnel.id, destination, ...args)
                return
            }

            const component = target.components[names[1]]

            if (component == null) {
                tunnel.emit("error", new Error(`no such component:${destination}`))
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
                tunnel.destroy(new Error(`no such node:${names[0]}`))
                return
            }

            if (target.socket) {
                target.socket.emit("tunnel::message", tunnel.id, event, ...args)
                return
            }

            const other = this.pairs[tunnel.id]

            if (other == null) {
                tunnel.destroy(new Error(`no pair:${names[0]}`))
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
                tunnel.destroy(new Error(`no such node:${names[0]}`))
                return
            }

            if (target.socket) {
                target.socket.emit("tunnel::write", tunnel.id, chunk)
                return
            }

            const other = this.pairs[tunnel.id]

            if (other == null) {
                tunnel.destroy(new Error(`no pair:${names[0]}`))
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
                target.socket.emit("tunnel::end", tunnel.id, chunk)
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
                target.socket.emit("tunnel::destroy", tunnel.id, this.wrap_error(error))
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

        node.socket.on("disconnect", (reason) => {
            console.log(`node[${node.name}] disconnected due to ${reason}`);
            delete this.nodes[node.name]
        })

        node.socket.on("regist", (options: ComponentOption) => {

            const names = options.name.split("/")
            const that = this.nodes[names[0]]

            const component = this.create_component(options)

            component.name = names[1]
            component.node = that
            component.options = options

            that.components[component.name] = component

            console.log(`create component ${options.name} from:${node.name}`)

            component.emit("ready")

            const on_disconnect = () => {

                node.socket.off("disconnect", on_disconnect)

                const exists = delete that.components[component.name]

                if (exists) {
                    console.log(`node[${node.name}] disconnect`, "destroy component", options.name)
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
                const error = new Error(`no such component:${destination}`)
                node.socket.emit("tunnel::error", id, { message: error.message, stack: error.stack })
                return
            }

            const tunnel = component.create_tunnel(id)

            tunnel.destination = `${node.name}/?`

            this.tunnels[tunnel.id] = tunnel

            component.emit("connection", tunnel, ...args)
            node.socket.emit("tunnel::connection", id)

            //对端断开了，那么tunnel也要销毁
            node.socket.once("disconnect", () => {
                tunnel.destroy(new Error(`remote node[${node.name}] disconnect`))
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

        console.log(`${node.name} connected`)

        this.nodes[node.name] = node

        for (const component of this.config.components) {
            const names = component.name.split("/")
            if (names[0] != node.name) {
                continue
            }
            node.socket.emit("regist", component)
        }
    }

    create_component(options: ComponentOption) {
        const class_ = this.components[options.type]
        if (class_ == null) {
            throw new Error(`unsupported component type:${options.type} in ${options.name}`)
        }
        return new class_(options)
    }
}

process.on("uncaughtException", (error: Error, origin: any) => {
    console.error("uncaughtException", error)
})

process.on("unhandledRejection", (error: Error, origin: any) => {
    console.error("unhandledRejection", error)
})