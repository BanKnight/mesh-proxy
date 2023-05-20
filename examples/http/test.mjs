import * as http from 'http';
import * as ws from 'ws';

const server = http.createServer()
const wsserver = new ws.WebSocketServer({
    server
})

server.on("request", (req, res) =>
{
    res.end("hello world\n")
})
wsserver.on("connection", (socket, req) =>
{
    socket.on("message", (data) =>
    {
        const content = data.toString("utf-8")
        console.log(content)

        if (content == "quit")
        {
            socket.send(Buffer.from("begin quit", "utf-8"))
            setTimeout(() =>
            {
                socket.close()
            }, 1000)
            return
        }
        socket.send(data)
    })

    socket.on("close", () =>
    {
        console.log("connection closed")
    })
})

server.listen(8899)

//curl --resolve www.example.com:80:127.0.0.1  http://www.example.com/



