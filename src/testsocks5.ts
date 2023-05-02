import { createServer } from "./protocols/socks5.js"
import * as net from 'net';

const socket = createServer({ auth: true })

// socket.on("connecting", async (socket: net.Socket, destination: any, origin: any) => {




// })

socket.on("auth", async (socket: net.Socket, username: string, password: string) => {

    if (username != "zhoutusheng" || password != "test") {
        return false
    }



})

// socket.on("connect", async (socket: net.Socket, dest: { address: string, port: number }))

socket.listen(1080)